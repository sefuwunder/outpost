// outpost db tests — isolated temp database
import { test, expect, beforeEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OUTPOST_DATA = join(tmpdir(), `outpost-test-${process.pid}-${Math.random().toString(36).slice(2)}`);

const db = await import("../src/db.ts");

beforeEach(() => {
  db.openDb(join(process.env.OUTPOST_DATA!, "t.db"));
  // fresh tables per test
  const d = db.getDb();
  d.exec("DELETE FROM messages; DELETE FROM conversations; DELETE FROM contacts; DELETE FROM unknown_senders; DELETE FROM settings;");
});

test("contacts: create/find/update with normalization", () => {
  const c = db.createContact({ name: "Ada", email: "ADA@Example.COM", phone: "+1 (555) 123-4567" });
  expect(c.email).toBe("ada@example.com");
  expect(c.phone).toBe("5551234567");
  expect(db.findContactByEmail("ada@example.com")!.id).toBe(c.id);
  expect(db.findContactByPhone("15551234567")!.id).toBe(c.id);
  expect(db.findContactByEmail("nobody@x.com")).toBeNull();
  const u = db.updateContact(c.id, { name: "Ada L." });
  expect(u!.name).toBe("Ada L.");
});

test("deleteConversations removes threads + messages, keeps contacts", () => {
  const a = db.createContact({ name: "A", email: "a@x.com" });
  const b = db.createContact({ name: "B", email: "b@x.com" });
  const ca = db.conversationFor(a.id), cb = db.conversationFor(b.id);
  db.addMessage({ conversation_id: ca.id, channel: "email", direction: "in", body: "hi a", external_id: "email:da" });
  db.addMessage({ conversation_id: cb.id, channel: "email", direction: "in", body: "hi b", external_id: "email:db" });
  expect(db.deleteConversations([ca.id, "nope", cb.id])).toBe(2);
  expect(db.listConversations().length).toBe(0);
  expect(db.getDb().query("SELECT COUNT(*) AS n FROM messages").get().n).toBe(0);
  expect(db.getContact(a.id)!.name).toBe("A"); // contacts kept
  expect(db.getContact(b.id)!.name).toBe("B");
});

test("conversationFor is idempotent — one thread per contact", () => {
  const c = db.createContact({ name: "Bo" });
  const a = db.conversationFor(c.id);
  const b = db.conversationFor(c.id);
  expect(a.id).toBe(b.id);
});

test("messages: dedupe by external_id, unread counts", () => {
  const c = db.createContact({ name: "Cy" });
  const conv = db.conversationFor(c.id);
  const m1 = db.addMessage({ conversation_id: conv.id, channel: "email", direction: "in", body: "hi", external_id: "email:abc" });
  expect(m1).not.toBeNull();
  expect(db.addMessage({ conversation_id: conv.id, channel: "email", direction: "in", body: "hi again", external_id: "email:abc" })).toBeNull();
  expect(db.totalUnread()).toBe(1);
  const rows = db.listConversations();
  expect(rows.length).toBe(1);
  expect(rows[0].unread).toBe(1);
  expect(rows[0].last_body).toBe("hi");
  db.markRead(conv.id);
  expect(db.totalUnread()).toBe(0);
});

test("outbound messages don't count as unread", () => {
  const c = db.createContact({ name: "De" });
  const conv = db.conversationFor(c.id);
  db.addMessage({ conversation_id: conv.id, channel: "sms", direction: "out", body: "hey" });
  expect(db.totalUnread()).toBe(0);
});

test("unknown senders: upsert aggregates, promote creates contact", () => {
  const u1 = db.upsertUnknown("email", "New@x.com", "", "hello there", new Date().toISOString());
  expect(u1.handle).toBe("new@x.com");
  const u2 = db.upsertUnknown("email", "new@x.com", "New Guy", "second msg", new Date().toISOString());
  expect(u2.id).toBe(u1.id);
  expect(u2.count).toBe(2);
  expect(db.listUnknown().length).toBe(1);
  const c = db.promoteUnknown(u1.id, "New Guy")!;
  expect(c.email).toBe("new@x.com");
  expect(c.name).toBe("New Guy");
  expect(db.listUnknown().length).toBe(0);
  db.dismissUnknown("nope");
});

test("settings round-trip, secrets never enumerated publicly", () => {
  db.setSetting("imap_pass", "s3cret");
  expect(db.getSetting("imap_pass")).toBe("s3cret");
  expect(db.publicSettings().email_configured).toBe(false);
  db.setSetting("imap_host", "mail.x.com");
  db.setSetting("imap_user", "u");
  expect(db.publicSettings().email_configured).toBe(true);
  expect(JSON.stringify(db.publicSettings())).not.toContain("s3cret");
});

test("clearAllContacts wipes people and threads but keeps channel settings", () => {
  const c = db.createContact({ name: "Zed", email: "z@x.com" });
  const conv = db.conversationFor(c.id);
  db.addMessage({ conversation_id: conv.id, channel: "email", direction: "in", body: "hi" });
  db.upsertUnknown("email", "u@x.com", "", "yo", new Date().toISOString());
  db.setSetting("imap_host", "mail.x.com");
  db.setSetting("matrix_room:" + c.id, "!room:x");
  const r = db.clearAllContacts();
  expect(r.contacts).toBe(1);
  expect(r.messages).toBe(1);
  expect(r.unknown).toBe(1);
  expect(db.listContacts()).toEqual([]);
  expect(db.listConversations()).toEqual([]);
  expect(db.totalUnread()).toBe(0);
  expect(db.listUnknown()).toEqual([]);
  expect(db.getSetting("imap_host")).toBe("mail.x.com"); // channel config kept
  expect(db.getSetting("matrix_room:" + c.id)).toBe(""); // orphan mapping dropped
});
