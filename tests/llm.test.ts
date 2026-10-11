// outpost LLM bridge tests — context endpoints + judgment application.
// The automatic consult is tested against a fake Ollama server.
import { test, expect, beforeEach, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OUTPOST_DATA = join(tmpdir(), `outpost-llm-test-${process.pid}-${Math.random().toString(36).slice(2)}`);

const db = await import("../src/db.ts");
const llm = await import("../src/llm.ts");
const agent = await import("../src/agent.ts");

beforeEach(() => {
  db.openDb(join(process.env.OUTPOST_DATA!, "t.db"));
  const d = db.getDb();
  d.exec("DELETE FROM messages; DELETE FROM conversations; DELETE FROM contacts; DELETE FROM unknown_senders; DELETE FROM settings; DELETE FROM inbox; DELETE FROM triage; DELETE FROM nudges;");
  agent.runAgent(); // seeds jev
});

function seedInbox(from: string, subject: string, source: string | null, category = "personal", conf = 0) {
  const id = db.upsertInbox({ from_email: from, from_name: from, subject, body: "body text", at: new Date().toISOString(), external_id: "e" + Math.random().toString(36).slice(2) });
  if (source) db.setTriage(id, category as any, "test", conf, source, "");
  return id;
}

test("pendingForLLM picks ambiguous rows, skips decided ones", () => {
  const a = seedInbox("a@x.com", "untriaged mail", null);
  const b = seedInbox("b@x.com", "rules fallback", "rules", "automated");
  const c = seedInbox("c@x.com", "low conf model", "model", "personal", 0.3);
  const d = seedInbox("d@x.com", "high conf model", "model", "personal", 0.95);
  seedInbox("e@x.com", "user locked", "user", "newsletter");
  seedInbox("f@x.com", "rule locked", "userrule", "receipt");
  seedInbox("g@x.com", "llm judged", "llm", "personal", 0.8);
  const p = llm.pendingForLLM(20).map((x) => x.id);
  expect(p).toContain(a);
  expect(p).toContain(b);
  expect(p).toContain(c);
  expect(p).not.toContain(d);
  expect(p.length).toBe(3);
});

test("messageContext bundles message, triage, sender history, matched rules", () => {
  db.upsertTriageRule("sender", "hist@x.com", "newsletter");
  const h1 = seedInbox("hist@x.com", "older", "rules", "newsletter");
  const id = seedInbox("hist@x.com", "current one", "rules", "automated");
  const ctx: any = llm.messageContext(id);
  expect(ctx.message.subject).toBe("current one");
  expect(ctx.current_triage.category).toBe("automated");
  expect(ctx.sender_history.length).toBe(1);
  expect(ctx.sender_history[0].category).toBe("newsletter");
  expect(ctx.matched_user_rules.length).toBe(1);
  expect(ctx.matched_user_rules[0].category).toBe("newsletter");
  expect(llm.messageContext("nope")).toBeNull();
  void h1;
});

test("applyJudgment locks triage as llm, trains the model, survives reorganize", () => {
  const id = seedInbox("judge@x.com", "please advise", "rules", "automated");
  const r = llm.applyJudgment({ message_id: id, category: "personal", confidence: 0.9, reason: "a human wrote directly" });
  expect(r.ok).toBe(true);
  const t = db.getDb().query("SELECT * FROM triage WHERE message_id = ?").get(id) as any;
  expect(t.source).toBe("llm");
  expect(t.category).toBe("personal");
  expect(t.reason).toContain("LLM");
  // reorganizePass must not overwrite an explicit judgment
  const { reorganized } = agent.reorganizePass();
  const t2 = db.getDb().query("SELECT * FROM triage WHERE message_id = ?").get(id) as any;
  expect(t2.category).toBe("personal");
  expect(t2.source).toBe("llm");
  void reorganized;
  // but the user's explicit correction still wins
  db.setTriage(id, "newsletter", "corrected by you", 1, "user", "");
  expect((db.getDb().query("SELECT source FROM triage WHERE message_id = ?").get(id) as any).source).toBe("user");
});

test("applyJudgment rejects bad category and unknown messages", () => {
  const id = seedInbox("x@x.com", "s", null);
  expect(() => llm.applyJudgment({ message_id: id, category: "spam" as any })).toThrow("bad category");
  expect(() => llm.applyJudgment({ message_id: "missing", category: "personal" })).toThrow("not found");
});

test("parseJudgment is defensive", () => {
  expect(llm.parseJudgment('{"category":"personal","confidence":0.8,"reason":"human"}')?.category).toBe("personal");
  expect(llm.parseJudgment('Sure! {"category":"receipt","confidence":0.6,"reason":"r"} done')?.category).toBe("receipt");
  expect(llm.parseJudgment('{"category":"spam","confidence":0.9}')).toBeNull();
  expect(llm.parseJudgment('no json here')).toBeNull();
  const p = llm.parseJudgment('{"category":"personal","confidence":9,"reason":"r"}')!;
  expect(p.confidence).toBe(1); // clamped
});

test("nudgeContext reports kind stats", () => {
  db.upsertNudge({ kind: "reply_needed", dedupe: "d1", title: "t", detail: "x" });
  const n = db.getDb().query("SELECT id FROM nudges WHERE dedupe = 'd1'").get() as any;
  db.dismissNudge(n.id);
  db.upsertNudge({ kind: "reply_needed", dedupe: "d2", title: "t", detail: "x" });
  const ctx: any = llm.nudgeContext();
  const rn = ctx.kind_stats.find((k: any) => k.kind === "reply_needed");
  expect(rn.total).toBe(2);
  expect(rn.dismissed).toBe(1);
  expect(ctx.active_nudges.length).toBe(1);
});

// ---------- automatic consult against a fake Ollama ----------

let ollama: any;
const OLLAMA_PORT = 18611;

test("consultLLM applies the fake model's judgments", async () => {
  ollama = Bun.serve({
    port: OLLAMA_PORT, hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/tags") return Response.json({ models: [{ name: "fake-llm" }] });
      if (url.pathname === "/api/generate") {
        return Response.json({ response: '{"category":"personal","confidence":0.92,"reason":"direct human request"}' });
      }
      return new Response("nf", { status: 404 });
    },
  });
  db.setSetting("llm_enabled", "1");
  db.setSetting("llm_url", `http://127.0.0.1:${OLLAMA_PORT}`);
  db.setSetting("llm_model", "fake-llm");
  const id = seedInbox("amb@x.com", "ambiguous mail", "rules", "automated");
  const rep = await llm.consultLLM(true);
  expect(rep.applied).toBe(1);
  expect(rep.errors).toEqual([]);
  const t = db.getDb().query("SELECT * FROM triage WHERE message_id = ?").get(id) as any;
  expect(t.category).toBe("personal");
  expect(t.source).toBe("llm");
  // second run is rate-limited (not forced)
  const rep2 = await llm.consultLLM(false);
  expect(rep2.skipped).toBe("rate-limited");
});

test("consultLLM stays silent when disabled; llmStatus probes reachability", async () => {
  db.setSetting("llm_enabled", "0");
  const rep = await llm.consultLLM(true);
  expect(rep.skipped).toBe("llm disabled");
  db.setSetting("llm_enabled", "1");
  db.setSetting("llm_url", `http://127.0.0.1:${OLLAMA_PORT}`);
  db.setSetting("llm_model", "fake-llm");
  const st = await llm.llmStatus();
  expect(st.reachable).toBe(true);
  expect(st.models).toContain("fake-llm");
  db.setSetting("llm_url", "http://127.0.0.1:19999");
  const st2 = await llm.llmStatus();
  expect(st2.reachable).toBe(false);
});

afterAll(() => { ollama?.stop(); });
