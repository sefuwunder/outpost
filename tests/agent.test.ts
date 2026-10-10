// agent tests — deterministic classification + nudge rules
import { test, expect, beforeEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OUTPOST_DATA = join(tmpdir(), `outpost-test-${process.pid}-${Math.random().toString(36).slice(2)}`);

const db = await import("../src/db.ts");
const agent = await import("../src/agent.ts");

beforeEach(() => {
  db.openDb(join(process.env.OUTPOST_DATA!, "t.db"));
  db.getDb().exec("DELETE FROM messages; DELETE FROM conversations; DELETE FROM contacts; DELETE FROM unknown_senders; DELETE FROM settings; DELETE FROM triage; DELETE FROM nudges; DELETE FROM triage_rules; DELETE FROM inbox;");
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

test("triage rules: sender beats domain, case-insensitive, deletable", () => {
  db.upsertTriageRule("domain", "Shop.COM", "newsletter");
  db.upsertTriageRule("sender", "boss@shop.com", "personal");
  expect(db.matchTriageRule("deals@shop.com")?.category).toBe("newsletter");
  expect(db.matchTriageRule("BOSS@SHOP.COM")?.category).toBe("personal"); // sender beats domain
  expect(db.matchTriageRule("other@x.com")).toBeNull();
  const rules = db.listTriageRules();
  expect(rules.length).toBe(2);
  db.deleteTriageRule(rules[0].id);
  expect(db.listTriageRules().length).toBe(1);
  // re-upsert replaces the category
  db.upsertTriageRule("domain", "shop.com", "receipt");
  expect(db.matchTriageRule("deals@shop.com")?.category).toBe("receipt");
});

test("user rule overrides deterministic rules for new mail", () => {
  db.upsertTriageRule("sender", "deals@shop.com", "personal");
  const c = db.createContact({ name: "Shop", email: "deals@shop.com" });
  const conv = db.conversationFor(c.id);
  db.addMessage({ conversation_id: conv.id, channel: "email", direction: "in", body: "unsubscribe anytime", subject: "Big sale" });
  const r = agent.runAgent();
  expect(r.triaged).toBe(1);
  const m = db.listMessages(conv.id)[0];
  expect(db.getTriage(m.id)).toBe("personal");
  expect(db.getTriageFull(m.id)?.source).toBe("userrule");
});

test("reorganizePass moves rule-matched mail, keeps user corrections, is idempotent", () => {
  const c = db.createContact({ name: "Shop", email: "deals@shop.com" });
  const conv = db.conversationFor(c.id);
  const m1 = db.addMessage({ conversation_id: conv.id, channel: "email", direction: "in", body: "unsubscribe", subject: "Sale 1" })!;
  const m2 = db.addMessage({ conversation_id: conv.id, channel: "email", direction: "in", body: "unsubscribe", subject: "Sale 2" })!;
  agent.runAgent();
  expect(db.getTriage(m1.id)).toBe("newsletter");
  // user explicitly corrects m2 → personal (locked)
  db.mirrorTriage(m2.id, "personal", "corrected by you", 1, "user", "");
  // training: always personal from this sender
  db.upsertTriageRule("sender", "deals@shop.com", "personal");
  const r = agent.reorganizePass();
  expect(r.reorganized).toBe(1); // m1 moved; m2 untouched (user-locked)
  expect(db.getTriage(m1.id)).toBe("personal");
  expect(db.getTriage(m2.id)).toBe("personal");
  expect(agent.reorganizePass().reorganized).toBe(0); // idempotent
});

test("reorganizePass re-labels inbox rows not mirrored to messages", () => {
  const id = db.upsertInbox({ from_email: "deals@shop.com", from_name: "Shop", subject: "Sale", body: "unsubscribe here", at: new Date().toISOString() });
  agent.runAgent();
  expect(db.getTriage(id)).toBe("newsletter");
  db.upsertTriageRule("domain", "shop.com", "automated");
  const r = agent.reorganizePass();
  expect(r.reorganized).toBe(1);
  expect(db.getTriage(id)).toBe("automated");
});
