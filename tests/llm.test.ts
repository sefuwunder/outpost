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
      if (url.pathname === "/api/show") {
        const b = await req.json().catch(() => ({})) as any;
        const caps = String(b.name || "").includes("embed") ? ["embedding"] : ["completion"];
        return Response.json({ capabilities: caps });
      }
      if (url.pathname === "/api/generate") {
        const b = await req.json().catch(() => ({})) as any;
        const prompt = String(b.prompt || "");
        if (prompt.startsWith("RULE-PATTERN")) {
          return Response.json({ response: '{"confirm": true, "reason": "consistent newsletter sender"}' });
        }
        if (prompt.startsWith("REVIEW")) {
          // disagree when the subject carries the WRONG marker
          if (prompt.includes("WRONG")) {
            return Response.json({ response: '{"agree": false, "category": "personal", "confidence": 0.92, "reason": "a human wrote directly"}' });
          }
          return Response.json({ response: '{"agree": true, "category": "automated", "confidence": 0.9, "reason": "label looks right"}' });
        }
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
  expect(st.model_found).toBe(true);
  expect(st.supports_generate).toBe(true);
  db.setSetting("llm_url", "http://127.0.0.1:19999");
  const st2 = await llm.llmStatus();
  expect(st2.reachable).toBe(false);
});

test("llmSettings trims stray whitespace; llmStatus flags missing/embedding-only models", async () => {
  db.setSetting("llm_url", `http://127.0.0.1:${OLLAMA_PORT} `);
  db.setSetting("llm_model", "  fake-llm  ");
  expect(llm.llmSettings().url).toBe(`http://127.0.0.1:${OLLAMA_PORT}`);
  expect(llm.llmSettings().model).toBe("fake-llm");
  db.setSetting("llm_model", "not-pulled");
  const st = await llm.llmStatus();
  expect(st.reachable).toBe(true);
  expect(st.model_found).toBe(false);
  expect(st.supports_generate).toBeUndefined();
});

test("llmSettings timeout defaults to 600s and clamps", () => {
  db.setSetting("llm_timeout", "");
  expect(llm.llmSettings().timeout).toBe(600);
  db.setSetting("llm_timeout", "120");
  expect(llm.llmSettings().timeout).toBe(120);
  db.setSetting("llm_timeout", "5"); // below floor
  expect(llm.llmSettings().timeout).toBe(15);
  db.setSetting("llm_timeout", "99999"); // above ceiling
  expect(llm.llmSettings().timeout).toBe(3600);
  db.setSetting("llm_timeout", "");
});

afterAll(() => { ollama?.stop(); });

// ---------- idle learning ----------

function llmOn() {
  db.setSetting("llm_enabled", "1");
  db.setSetting("llm_url", `http://127.0.0.1:${OLLAMA_PORT}`);
  db.setSetting("llm_model", "fake-llm");
}

test("parseReview / parseRuleConfirm are defensive", () => {
  expect(llm.parseReview('{"agree": true, "category": "personal", "confidence": 0.8, "reason": "ok"}')?.agree).toBe(true);
  expect(llm.parseReview('{"agree": "yes", "category": "personal"}')).toBeNull();
  expect(llm.parseReview('{"agree": false, "category": "spam"}')).toBeNull();
  expect(llm.parseReview('nothing')).toBeNull();
  expect(llm.parseRuleConfirm('{"confirm": true, "reason": "ok"}')?.confirm).toBe(true);
  expect(llm.parseRuleConfirm('{"confirm": "maybe"}')).toBeNull();
});

test("idleLearn reviews weak past decisions: refines disagreements, reinforces agreements", async () => {
  llmOn();
  const wrong = seedInbox("bill@x.com", "WRONG invoice attached", "rules", "automated");
  const fine = seedInbox("alerts@x.com", "server alert", "rules", "automated");
  const locked = seedInbox("boss@x.com", "user corrected", "user", "personal");
  const rep = await llm.idleLearn(true);
  expect(rep.reviewed).toBe(2); // user-locked never reviewed
  expect(rep.refined).toBe(1);
  expect(rep.reinforced).toBe(1);
  const t = db.getDb().query("SELECT category, source, reason FROM triage WHERE message_id = ?").get(wrong) as any;
  expect(t.category).toBe("personal");
  expect(t.source).toBe("llm");
  expect(t.reason).toContain("refined on review");
  const t2 = db.getDb().query("SELECT category, source FROM triage WHERE message_id = ?").get(fine) as any;
  expect(t2.category).toBe("automated"); // agreement changes nothing stored
  expect(t2.source).toBe("rules");
  const t3 = db.getDb().query("SELECT category FROM triage WHERE message_id = ?").get(locked) as any;
  expect(t3.category).toBe("personal");
  // rate-limited without force
  const rep2 = await llm.idleLearn(false);
  expect(rep2.skipped).toBe("rate-limited");
});

test("idleLearn mines consistent sender patterns into llm rules", async () => {
  llmOn();
  for (let i = 0; i < 9; i++) {
    seedInbox("news@digest.com", `Digest #${i}`, "rules", "newsletter");
  }
  // one dissenting message keeps it under 100% but at 90%
  const d = seedInbox("news@digest.com", "a personal note", "rules", "personal");
  void d;
  const rep = await llm.idleLearn(true);
  expect(rep.rules_proposed).toBe(1);
  expect(rep.rules_applied).toBe(1);
  const rules = db.listTriageRules();
  const r = rules.find((x) => x.pattern === "news@digest.com");
  expect(r?.category).toBe("newsletter");
  expect(r?.source).toBe("llm");
  // second pass: rule exists → not proposed again
  const rep2 = await llm.idleLearn(true);
  expect(rep2.rules_proposed).toBe(0);
});

test("idleLearn skips senders the user has corrected", async () => {
  llmOn();
  for (let i = 0; i < 8; i++) seedInbox("mixed@x.com", `M #${i}`, "rules", "newsletter");
  const c = seedInbox("mixed@x.com", "actually personal", "rules", "newsletter");
  db.setTriage(c, "personal", "corrected by you", 1, "user", "");
  const rep = await llm.idleLearn(true);
  expect(rep.rules_applied).toBe(0);
  expect(db.listTriageRules().find((x) => x.pattern === "mixed@x.com")).toBeUndefined();
});

test("maybeIdleLearn waits for true idleness", async () => {
  db.setSetting("llm_enabled", "0");
  expect(await llm.maybeIdleLearn()).toBeNull();
  llmOn();
  db.setSetting("llm_last_idle", "0");
  seedInbox("u@x.com", "untriaged", null); // pending consult work exists
  expect(await llm.maybeIdleLearn()).toBeNull(); // urgent first
});
