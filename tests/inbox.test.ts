// inbox tests — 30-day agent-organized email home
import { test, expect, beforeEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OUTPOST_DATA = join(tmpdir(), `outpost-test-${process.pid}-${Math.random().toString(36).slice(2)}`);

const db = await import("../src/db.ts");
const agent = await import("../src/agent.ts");

beforeEach(() => {
  db.openDb(join(process.env.OUTPOST_DATA!, "t.db"));
  db.getDb().exec("DELETE FROM messages; DELETE FROM conversations; DELETE FROM contacts; DELETE FROM unknown_senders; DELETE FROM settings; DELETE FROM triage; DELETE FROM nudges; DELETE FROM inbox;");
});

const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();

test("upsertInbox dedupes by external_id and links late contact info", () => {
  const id1 = db.upsertInbox({ from_email: "a@x.com", subject: "hi", body: "yo", at: daysAgo(1), external_id: "email:123" });
  const id2 = db.upsertInbox({ from_email: "a@x.com", subject: "hi", body: "yo", at: daysAgo(1), external_id: "email:123", contact_id: "c1", message_id: "m1" });
  expect(id1).toBe(id2);
  const row = db.getInbox(id1)!;
  expect(row.contact_id).toBe("c1");
  expect(row.message_id).toBe("m1");
});

test("backfill populates inbox from existing messages and unknown senders", () => {
  const c = db.createContact({ name: "Ada", email: "ada@x.com" });
  const conv = db.conversationFor(c.id);
  db.addMessage({ conversation_id: conv.id, channel: "email", direction: "in", subject: "Hello", body: "hi there", created_at: daysAgo(2) });
  db.upsertUnknown("email", "stranger@x.com", "", "saw your talk", daysAgo(1));
  // reopen triggers backfill (inbox was empty)
  db.openDb(join(process.env.OUTPOST_DATA!, "t.db"));
  const rows = db.listInbox();
  expect(rows.length).toBe(2);
  expect(rows.some((r) => r.from_email === "ada@x.com" && r.message_id !== "")).toBe(true);
  expect(rows.some((r) => r.from_email === "stranger@x.com")).toBe(true);
  // reopening again does not duplicate
  db.openDb(join(process.env.OUTPOST_DATA!, "t.db"));
  expect(db.listInbox().length).toBe(2);
});

test("agent triages inbox rows and mirrors to linked messages", () => {
  const c = db.createContact({ name: "Shop", email: "deals@shop.com" });
  const conv = db.conversationFor(c.id);
  const m = db.addMessage({ conversation_id: conv.id, channel: "email", direction: "in", subject: "Sale", body: "unsubscribe here", created_at: daysAgo(1) })!;
  const inboxId = db.upsertInbox({ from_email: "deals@shop.com", subject: "Sale", body: "unsubscribe here", at: daysAgo(1), external_id: "email:xyz", contact_id: c.id, message_id: m.id });
  const r = agent.runAgent();
  expect(r.triaged).toBeGreaterThanOrEqual(2); // message + inbox row
  const t = db.getTriageFull(inboxId)!;
  expect(t.category).toBe("newsletter");
  expect(db.getTriage(m.id)).toBe("newsletter"); // mirrored
});

test("listInbox respects the 30-day window", () => {
  db.upsertInbox({ from_email: "new@x.com", subject: "fresh", body: "b", at: daysAgo(5) });
  db.upsertInbox({ from_email: "old@x.com", subject: "stale", body: "b", at: daysAgo(45) });
  const rows = db.listInbox();
  expect(rows.map((r) => r.from_email)).toEqual(["new@x.com"]);
});

test("inbox read/delete", () => {
  const id = db.upsertInbox({ from_email: "a@x.com", subject: "s", body: "b", at: daysAgo(1) });
  expect(db.inboxUnread()).toBe(1);
  db.setInboxRead(id, true);
  expect(db.inboxUnread()).toBe(0);
  db.deleteInbox(id);
  expect(db.getInbox(id)).toBeNull();
});

test("mirrorTriage keeps inbox and message labels in sync on correction", () => {
  const c = db.createContact({ name: "P", email: "p@x.com" });
  const conv = db.conversationFor(c.id);
  const m = db.addMessage({ conversation_id: conv.id, channel: "email", direction: "in", subject: "s", body: "b" })!;
  const inboxId = db.upsertInbox({ from_email: "p@x.com", subject: "s", body: "b", at: daysAgo(1), contact_id: c.id, message_id: m.id });
  db.mirrorTriage(inboxId, "receipt", "user", 1, "user", "");
  expect(db.getTriage(inboxId)).toBe("receipt");
  expect(db.getTriage(m.id)).toBe("receipt");
});
