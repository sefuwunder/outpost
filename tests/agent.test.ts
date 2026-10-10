// agent tests — deterministic classification + nudge rules
import { test, expect, beforeEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OUTPOST_DATA = join(tmpdir(), `outpost-test-${process.pid}-${Math.random().toString(36).slice(2)}`);

const db = await import("../src/db.ts");
const agent = await import("../src/agent.ts");

beforeEach(() => {
  db.openDb(join(process.env.OUTPOST_DATA!, "t.db"));
  db.getDb().exec("DELETE FROM messages; DELETE FROM conversations; DELETE FROM contacts; DELETE FROM unknown_senders; DELETE FROM settings; DELETE FROM triage; DELETE FROM nudges;");
});

const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();

test("classifyEmail: receipt, newsletter, automated, personal", () => {
  expect(agent.classifyEmail({ from: "store@x.com", subject: "Your receipt from Acme", body: "" }).category).toBe("receipt");
  expect(agent.classifyEmail({ from: "news@blog.com", subject: "Weekly digest", body: "unsubscribe here" }).category).toBe("newsletter");
  expect(agent.classifyEmail({ from: "newsletter@co.com", subject: "Updates", body: "hi" }).category).toBe("newsletter");
  expect(agent.classifyEmail({ from: "noreply@bank.com", subject: "Statement ready", body: "" }).category).toBe("automated");
  expect(agent.classifyEmail({ from: "friend@x.com", subject: "dinner?", body: "are you free" }).category).toBe("personal");
});

test("runAgent triages inbound email and never re-triages", () => {
  const c = db.createContact({ name: "A", email: "a@x.com" });
  const conv = db.conversationFor(c.id);
  db.addMessage({ conversation_id: conv.id, channel: "email", direction: "in", body: "click to unsubscribe", subject: "Deals!" });
  const r1 = agent.runAgent();
  expect(r1.triaged).toBe(1);
  expect(db.getTriage(db.listMessages(conv.id)[0].id)).toBe("newsletter");
  const r2 = agent.runAgent();
  expect(r2.triaged).toBe(0); // idempotent
});

test("reply_needed nudge fires at 3+ days, not before", () => {
  const c = db.createContact({ name: "Bo", email: "bo@x.com" });
  const conv = db.conversationFor(c.id);
  db.addMessage({ conversation_id: conv.id, channel: "email", direction: "in", body: "hey", created_at: daysAgo(2) });
  expect(agent.runAgent().nudges).toBe(0);
  db.getDb().query("UPDATE messages SET created_at = ? WHERE conversation_id = ?").run(daysAgo(4), conv.id);
  const r = agent.runAgent();
  expect(r.nudges).toBe(1);
  const n = db.listActiveNudges()[0];
  expect(n.kind).toBe("reply_needed");
  expect(n.title).toContain("Bo");
  // rerun doesn't duplicate; replying prunes it
  expect(agent.runAgent().nudges).toBe(1);
  db.addMessage({ conversation_id: conv.id, channel: "email", direction: "out", body: "sorry!" });
  expect(agent.runAgent().nudges).toBe(0);
});

test("no reply nudge for newsletters", () => {
  const c = db.createContact({ name: "News", email: "news@x.com" });
  const conv = db.conversationFor(c.id);
  const m = db.addMessage({ conversation_id: conv.id, channel: "email", direction: "in", body: "unsubscribe", subject: "Deals", created_at: daysAgo(9) })!;
  db.setTriage(m.id, "newsletter", "test");
  expect(agent.runAgent().nudges).toBe(0);
});

test("follow_up nudge at 7+ days after our unanswered message", () => {
  const c = db.createContact({ name: "Cy", email: "cy@x.com" });
  const conv = db.conversationFor(c.id);
  db.addMessage({ conversation_id: conv.id, channel: "email", direction: "in", body: "hi", created_at: daysAgo(10) });
  db.addMessage({ conversation_id: conv.id, channel: "email", direction: "out", body: "hello", created_at: daysAgo(8) });
  const r = agent.runAgent();
  expect(r.nudges).toBe(1);
  expect(db.listActiveNudges()[0].kind).toBe("follow_up");
});

test("unknown_waiting nudge at 2+ days; dismiss + snooze work", () => {
  db.upsertUnknown("email", "s@y.com", "", "hello", daysAgo(3));
  expect(agent.runAgent().nudges).toBe(1);
  const n = db.listActiveNudges()[0];
  expect(n.kind).toBe("unknown_waiting");
  db.snoozeNudge(n.id, Date.now() + 86400_000);
  expect(db.listActiveNudges().length).toBe(0);
  db.snoozeNudge(n.id, Date.now() - 1000);
  expect(db.listActiveNudges().length).toBe(1);
  db.dismissNudge(n.id);
  expect(db.listActiveNudges().length).toBe(0);
});

test("daysBetween uses calendar days", () => {
  const a = new Date(2026, 9, 9, 23, 59).getTime();
  const b = new Date(2026, 9, 10, 0, 1).getTime();
  expect(agent.daysBetween(a, b)).toBe(1); // 2 minutes, next day
});
