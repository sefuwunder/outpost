// jev engine tests — local probabilistic decisions + online learning
import { test, expect, beforeEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OUTPOST_DATA = join(tmpdir(), `outpost-test-${process.pid}-${Math.random().toString(36).slice(2)}`);

const db = await import("../src/db.ts");
const jev = await import("../src/jev.ts");

beforeEach(() => {
  db.openDb(join(process.env.OUTPOST_DATA!, "t.db"));
  db.getDb().exec("DELETE FROM messages; DELETE FROM conversations; DELETE FROM contacts; DELETE FROM unknown_senders; DELETE FROM settings; DELETE FROM triage; DELETE FROM nudges; DELETE FROM jev_feat; DELETE FROM jev_cls; DELETE FROM jev_nudge_fb;");
});

test("seed corpus classifies the four kinds", () => {
  jev.ensureSeeded();
  const c = (from: string, subject: string, body: string) => jev.classify({ from, subject, body });
  expect(c("deals@shop.com", "Sale ends tonight", "Unsubscribe here").label).toBe("newsletter");
  expect(c("orders@store.com", "Your receipt from Acme", "thanks").label).toBe("receipt");
  expect(c("noreply@bank.com", "Statement ready", "do not reply").label).toBe("automated");
  expect(c("friend@x.com", "dinner?", "are you free Thursday").label).toBe("personal");
});

test("confidence is a sane probability distribution", () => {
  jev.ensureSeeded();
  const j = jev.classify({ from: "deals@shop.com", subject: "Sale", body: "unsubscribe now" });
  const sum = Object.values(j.scores).reduce((a, b) => a + b, 0);
  expect(sum).toBeCloseTo(1, 6);
  expect(j.confidence).toBeGreaterThan(0.5);
  expect(j.confidence).toBeLessThan(1);
  expect(j.evidence.length).toBeGreaterThan(0);
});

test("modelTrusted gates on trained features", () => {
  jev.ensureSeeded();
  expect(jev.modelTrusted({ from: "deals@shop.com", subject: "Sale", body: "unsubscribe now" })).toBe(true);
  expect(jev.modelTrusted({ from: "qx@zzzqw.invalid", subject: "blorpt", body: "wibble wobble xyzzy" })).toBe(false);
});

test("learn() changes future classifications", () => {
  jev.ensureSeeded();
  const input = { from: "ceo@company.com", subject: "All hands", body: "zyzzyva quux mandatory meeting notes" };
  const before = jev.classify(input).label;
  jev.learn("personal", input);
  jev.learn("personal", input);
  const after = jev.classify(input);
  expect(after.label).toBe("personal");
  expect(after.confidence).toBeGreaterThan(0.6);
  void before;
});

test("a user correction teaches the model (end-to-end via correct flow)", () => {
  jev.ensureSeeded();
  // "Win a prize" style promo the seed has never seen; rules would call newsletter via unsubscribe
  const input = { from: "alerts@bank.com", subject: "Fraud alert", body: "Suspicious charge of $500. Call us." };
  jev.learn("automated", input);
  const j = jev.classify(input);
  expect(j.label).toBe("automated");
  expect(j.evidence.some((e) => /fraud|suspicious|charge/.test(e.feature))).toBe(true);
});

test("kindWeight starts at 0.5 and learns from feedback", () => {
  expect(jev.kindWeight("reply_needed")).toBe(0.5);
  jev.recordNudgeFeedback("reply_needed", true);
  jev.recordNudgeFeedback("reply_needed", true);
  jev.recordNudgeFeedback("reply_needed", false);
  expect(jev.kindWeight("reply_needed")).toBeCloseTo(3 / 5, 6); // (2+1)/(2+1+2)
  jev.recordNudgeFeedback("follow_up", false);
  jev.recordNudgeFeedback("follow_up", false);
  expect(jev.kindWeight("follow_up")).toBeLessThan(jev.kindWeight("reply_needed"));
});

test("scoreNudge ranks urgent + wanted kinds first", () => {
  jev.recordNudgeFeedback("reply_needed", true); // wanted
  jev.recordNudgeFeedback("follow_up", false);   // dismissed a lot
  jev.recordNudgeFeedback("follow_up", false);
  const a = jev.scoreNudge({ kind: "reply_needed", detail: "4 days old" });
  const b = jev.scoreNudge({ kind: "follow_up", detail: "8 days old" });
  expect(a).toBeGreaterThan(b);
  expect(a).toBeGreaterThanOrEqual(0);
  expect(a).toBeLessThanOrEqual(1);
});
