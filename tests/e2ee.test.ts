// outpost E2EE channel tests — transports stubbed, plus a real outpost-e2ee
// relay for the client/registration path.
import { test, expect, beforeEach, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OUTPOST_DATA = join(tmpdir(), `outpost-e2ee-test-${process.pid}-${Math.random().toString(36).slice(2)}`);

const db = await import("../src/db.ts");
const ch = await import("../src/channels.ts");
const agent = await import("../src/agent.ts");

const sent: Array<{ kind: string; to: string; text: string }> = [];
const inbox = { email: [] as any[], sms: [] as any[], matrix: [] as any[], encrypted: [] as any[] };
const stub: ch.Transports = {
  sendEmail: async () => {}, sendSms: async () => {},
  sendMatrix: async () => {},
  sendEncrypted: async (handle, text) => { sent.push({ kind: "encrypted", to: handle, text }); },
  fetchEmail: async () => inbox.email, fetchSms: async () => inbox.sms,
  fetchMatrix: async () => inbox.matrix, fetchEncrypted: async () => inbox.encrypted,
};

beforeEach(() => {
  db.openDb(join(process.env.OUTPOST_DATA!, "t.db"));
  const d = db.getDb();
  d.exec("DELETE FROM messages; DELETE FROM conversations; DELETE FROM contacts; DELETE FROM unknown_senders; DELETE FROM settings; DELETE FROM e2ee_state; DELETE FROM inbox;");
  sent.length = 0;
  inbox.email = []; inbox.sms = []; inbox.matrix = []; inbox.encrypted = [];
});

test("availableChannels gains encrypted when the contact has an e2ee handle", () => {
  const c = db.createContact({ name: "Jane", email: "j@x.com" });
  expect(ch.availableChannels(c)).toEqual(["email"]);
  const c2 = db.updateContact(c.id, { e2ee_handle: "jane" })!;
  expect(ch.availableChannels(c2)).toContain("encrypted");
  expect(db.findContactByE2EE("JANE")?.id).toBe(c.id); // case-insensitive
});

test("sendToContact routes encrypted to the peer handle", async () => {
  const c = db.createContact({ name: "Jane", e2ee_handle: "jane" });
  const r = await ch.sendToContact(stub, c.id, "encrypted", "secret hi");
  expect(r.ok).toBe(true);
  expect(sent).toEqual([{ kind: "encrypted", to: "jane", text: "secret hi" }]);
});

test("pollInbox ingests decrypted envelopes into conversations", async () => {
  const c = db.createContact({ name: "Jane", e2ee_handle: "jane" });
  inbox.encrypted = [
    { handle: "jane", body: "hello there", at: new Date().toISOString(), id: "env_1" },
    { handle: "stranger", body: "who dis", at: new Date().toISOString(), id: "env_2" },
  ];
  const rep = await ch.pollInbox(stub);
  expect(rep.encrypted).toBe(1);
  expect(rep.unknown).toBe(1);
  const conv = db.conversationFor(c.id);
  const msgs = db.getDb().query("SELECT * FROM messages WHERE conversation_id = ?").all(conv.id) as any[];
  expect(msgs.length).toBe(1);
  expect(msgs[0].channel).toBe("encrypted");
  expect(msgs[0].body).toBe("hello there");
  expect(msgs[0].external_id).toBe("e2ee:env_1");
  // dedupe: second poll of the same envelope adds nothing
  const rep2 = await ch.pollInbox(stub);
  expect(rep2.encrypted).toBe(0);
});

test("rankInbox: unread personal beats newsletter, cap 8, starred boost", () => {
  const now = Date.now();
  const cats = ["newsletter", "personal", "receipt", "automated", "personal", "newsletter", "personal", "receipt", "personal", "automated"];
  cats.forEach((cat, i) => {
    const id = db.upsertInbox({ from_email: `s${i}@x.com`, from_name: `Sender ${i}`, subject: `s${i}`, body: "b", at: new Date(now - i * 36e5).toISOString(), external_id: `p${i}` });
    db.setTriage(id, cat as any, 0.9, "rules", "test");
  });
  const vip = db.createContact({ name: "VIP", email: "vip@x.com" });
  db.updateContact(vip.id, { starred: 1 });
  const vid = db.upsertInbox({ from_email: "vip@x.com", from_name: "VIP", subject: "urgent", body: "b", at: new Date(now - 3e5).toISOString(), external_id: "pvip", contact_id: vip.id });
  db.setTriage(vid, "personal", 0.9, "rules", "test");
  // one read message must not appear
  const rid = db.upsertInbox({ from_email: "read@x.com", from_name: "Read", subject: "old", body: "b", at: new Date().toISOString(), external_id: "pread" });
  db.setTriage(rid, "personal", 0.9, "rules", "test");
  db.getDb().query("UPDATE inbox SET read = 1 WHERE id = ?").run(rid);

  const top = agent.rankInbox(8, now);
  expect(top.length).toBe(8);
  expect(top.every((t) => !t.read)).toBe(true);
  expect(top[0].from_email).toBe("vip@x.com"); // starred + personal + fresh
  expect(top[0].why).toContain("starred");
  // a newsletter never outranks a same-age personal
  const news = top.find((t) => t.category === "newsletter");
  const pers = top.find((t) => t.category === "personal" && t.from_email !== "vip@x.com");
  if (news && pers) expect(pers.score).toBeGreaterThan(news.score);
});

test("rankInbox: reply_needed nudge boosts the sender", () => {
  const now = Date.now();
  const c = db.createContact({ name: "Owes", email: "owes@x.com" });
  const id = db.upsertInbox({ from_email: "owes@x.com", from_name: "Owes", subject: "q", body: "b", at: new Date(now - 20 * 36e5).toISOString(), external_id: "pr1", contact_id: c.id });
  db.setTriage(id, "receipt", 0.9, "rules", "test");
  const id2 = db.upsertInbox({ from_email: "fresh@x.com", from_name: "Fresh", subject: "hi", body: "b", at: new Date(now - 1e5).toISOString(), external_id: "pr2" });
  db.setTriage(id2, "personal", 0.9, "rules", "test");
  db.upsertNudge({ kind: "reply_needed", dedupe: "rn1", contact_id: c.id, conversation_id: db.conversationFor(c.id).id, title: "t" });
  const top = agent.rankInbox(8, now);
  expect(top[0].from_email).toBe("owes@x.com"); // old receipt + nudge beats fresh personal
  expect(top[0].why).toContain("needs your reply");
});

// ---------- live relay: registration + client ----------

const RELAY_PORT = 18511;
const RELAY_TOKEN = "outpost-test-token";
const RELAY_DATA = join(tmpdir(), `outpost-relay-${process.pid}`);
let relayProc: any;

test("E2EE client registers against a live relay and fetches its fingerprint", async () => {
  relayProc = Bun.spawn(["bun", join(process.env.HOME!, "workspace/your_files/outpost-e2ee/src/server.ts")], {
    env: { ...process.env, PORT: String(RELAY_PORT), E2EE_DATA: RELAY_DATA, E2EE_PROVISION_TOKEN: RELAY_TOKEN },
    stdout: "ignore", stderr: "ignore",
  });
  const base = `http://127.0.0.1:${RELAY_PORT}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${base}/api/health`); if (r.ok) break; } catch {}
    await Bun.sleep(100);
  }
  db.setSetting("e2ee_url", base);
  db.setSetting("e2ee_token", RELAY_TOKEN);
  db.setSetting("e2ee_handle", "outpost-user");
  await ch.ensureE2EERegistered();
  const c = (await ch.getE2EEClient())!;
  expect(c.handle).toBe("outpost-user");
  expect((await c.fingerprint()).length).toBe(16);
  // private keys landed in e2ee_state, not in settings
  expect(db.getE2EEState("e2ee:outpost-user:state")).toContain("ikPriv");
});

afterAll(() => { relayProc?.kill(); });
