// outpost channel tests — transports stubbed
import { test, expect, beforeEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OUTPOST_DATA = join(tmpdir(), `outpost-test-${process.pid}-${Math.random().toString(36).slice(2)}`);

const db = await import("../src/db.ts");
const ch = await import("../src/channels.ts");

const sent: Array<{ kind: string; to: string; text: string }> = [];
const inbox = {
  email: [] as any[],
  sms: [] as any[],
  matrix: [] as any[],
  encrypted: [] as any[],
};
const stub: ch.Transports = {
  sendEmail: async (to, _s, text) => { sent.push({ kind: "email", to, text }); },
  sendSms: async (digits, text) => { sent.push({ kind: "sms", to: digits, text }); },
  sendMatrix: async (contact, text) => { sent.push({ kind: "matrix", to: contact.matrix_id, text }); },
  sendEncrypted: async (handle, text) => { sent.push({ kind: "encrypted", to: handle, text }); },
  fetchEmail: async () => inbox.email,
  fetchSms: async () => inbox.sms,
  fetchMatrix: async () => inbox.matrix,
  fetchEncrypted: async () => inbox.encrypted,
};

beforeEach(() => {
  db.openDb(join(process.env.OUTPOST_DATA!, "t.db"));
  const d = db.getDb();
  d.exec("DELETE FROM messages; DELETE FROM conversations; DELETE FROM contacts; DELETE FROM unknown_senders; DELETE FROM settings;");
  sent.length = 0;
  inbox.email = []; inbox.sms = []; inbox.matrix = []; inbox.encrypted = [];
});

test("availableChannels reflects what the contact has", () => {
  const c = db.createContact({ name: "A", email: "a@x.com", phone: "5550001111" });
  expect(ch.availableChannels(c)).toEqual(["email", "sms"]);
});

test("send routes per channel and logs the outbound message", async () => {
  const c = db.createContact({ name: "B", email: "b@x.com", phone: "5550002222", matrix_id: "@b:matrix.org" });
  let r = await ch.sendToContact(stub, c.id, "email", "hello email");
  expect(r.ok).toBe(true);
  r = await ch.sendToContact(stub, c.id, "sms", "hello sms");
  expect(r.ok).toBe(true);
  r = await ch.sendToContact(stub, c.id, "matrix", "hello mx");
  expect(r.ok).toBe(true);
  expect(sent.map((s) => s.kind)).toEqual(["email", "sms", "matrix"]);
  expect(sent[1].to).toBe("5550002222");
  const conv = db.conversationFor(c.id);
  expect(db.listMessages(conv.id).length).toBe(3);
  expect(db.totalUnread()).toBe(0); // outbound never unread
});

test("send fails cleanly without the channel", async () => {
  const c = db.createContact({ name: "C" });
  const r = await ch.sendToContact(stub, c.id, "email", "hi");
  expect(r.ok).toBe(false);
  const r2 = await ch.sendToContact(stub, "missing", "email", "hi");
  expect(r2.ok).toBe(false);
});

test("poll: inbound email matched by address, unknown → bucket", async () => {
  const c = db.createContact({ name: "D", email: "d@x.com" });
  inbox.email = [
    { from: "D <d@x.com>", to: [], subject: "re", date: "2026-10-10", dateTime: new Date().toISOString(), snippet: "hey you", body: "hey you there", returnPath: "", uid: "1", messageId: "m1" },
    { from: "Stranger <s@y.com>", to: [], subject: "yo", date: "2026-10-10", dateTime: new Date().toISOString(), snippet: "new here", body: "new here", returnPath: "", uid: "2", messageId: "m2" },
  ];
  const rep = await ch.pollInbox(stub);
  expect(rep.email).toBe(1);
  expect(rep.unknown).toBe(1);
  const conv = db.conversationFor(c.id);
  const msgs = db.listMessages(conv.id);
  expect(msgs.length).toBe(1);
  expect(msgs[0].body).toBe("hey you there");
  expect(db.totalUnread()).toBe(1);
  expect(db.listUnknown()[0].handle).toBe("s@y.com");
  // second poll dedupes on message-id
  const rep2 = await ch.pollInbox(stub);
  expect(rep2.email).toBe(0);
});

test("poll: sms matched by digits, matrix by sender", async () => {
  const c = db.createContact({ name: "E", phone: "(555) 000-3333", matrix_id: "@e:matrix.org" });
  inbox.sms = [{ number: "5550003333", name: "", body: "text me", at: new Date().toISOString(), messageId: "s1" }];
  inbox.matrix = [{ sender: "@e:matrix.org", roomId: "!r:x", body: "mx hi", at: new Date().toISOString(), eventId: "e1" }];
  const rep = await ch.pollInbox(stub);
  expect(rep.sms).toBe(1);
  expect(rep.matrix).toBe(1);
  const bodies = db.listMessages(db.conversationFor(c.id).conversation_id || db.conversationFor(c.id).id).map((m) => m.body);
  expect(bodies).toContain("text me");
  expect(bodies).toContain("mx hi");
});

test("poll: dead channel doesn't sink the sweep", async () => {
  const bad: ch.Transports = { ...stub, fetchEmail: async () => { throw new Error("down"); } };
  const c = db.createContact({ name: "F", phone: "5550004444" });
  inbox.sms = [{ number: "5550004444", name: "", body: "still works", at: new Date().toISOString(), messageId: "s9" }];
  const rep = await ch.pollInbox(bad);
  expect(rep.sms).toBe(1);
});
