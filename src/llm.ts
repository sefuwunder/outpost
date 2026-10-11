// outpost llm bridge — lets a local LLM (e.g. Ollama) see what the decision
// model sees and give context back. The deterministic pipeline stays in charge:
// the LLM is an advisor. Its judgments land as triage with source "llm",
// locked like user corrections, below only the user in precedence.

import {
  getSetting, setSetting, getDb, mirrorTriage,
  type TriageCategory, type InboxRow,
} from "./db";
import { learn } from "./jev";

export interface LlmSettings {
  url: string;      // e.g. http://localhost:11434
  model: string;    // e.g. llama3.1
  enabled: boolean;
  threshold: number; // consult when the local model's confidence is below this
}

export function llmSettings(): LlmSettings {
  return {
    url: (getSetting("llm_url") || "http://localhost:11434").replace(/\/$/, ""),
    model: getSetting("llm_model") || "llama3.1",
    enabled: getSetting("llm_enabled") === "1",
    threshold: Number(getSetting("llm_threshold") || 0.65) || 0.65,
  };
}

const CATS: TriageCategory[] = ["personal", "newsletter", "receipt", "automated"];

/** Rows where the LLM's context would help most: untriaged, rules-fallback, or low-confidence model calls. */
export function pendingForLLM(limit = 20): Array<InboxRow & { triage: { category: string; source: string; confidence: number; reason: string } | null }> {
  const { threshold } = llmSettings();
  const d = getDb();
  const rows = d.query(`
    SELECT i.*, t.category AS tcat, t.source AS tsrc, t.confidence AS tconf, t.reason AS treason
    FROM inbox i LEFT JOIN triage t ON t.message_id = i.id
    ORDER BY i.at DESC LIMIT 200
  `).all() as Array<InboxRow & { tcat: string | null; tsrc: string | null; tconf: number | null; treason: string | null }>;
  const out: Array<InboxRow & { triage: any }> = [];
  for (const r of rows) {
    const triage = r.tcat ? { category: r.tcat, source: r.tsrc || "", confidence: r.tconf ?? 0, reason: r.treason || "" } : null;
    const needs =
      !triage ||
      triage.source === "rules" ||
      (triage.source === "model" && triage.confidence < threshold);
    if (!needs) continue; // user, userrule, llm — already decided
    const { tcat, tsrc, tconf, treason, ...row } = r;
    out.push({ ...row, triage });
    if (out.length >= limit) break;
  }
  return out;
}

/** Everything the decision model knows about one message — the LLM's briefing. */
export function messageContext(messageId: string): Record<string, unknown> | null {
  const d = getDb();
  const row = d.query("SELECT * FROM inbox WHERE id = ?").get(messageId) as InboxRow | null;
  if (!row) return null;
  const triage = d.query("SELECT category, source, confidence, reason, evidence FROM triage WHERE message_id = ?").get(messageId) as any;
  const sender = (row.from_email || "").toLowerCase().trim();
  const history = d.query(`
    SELECT i.subject, t.category, t.source, i.at FROM inbox i
    JOIN triage t ON t.message_id = i.id
    WHERE lower(i.from_email) = ? AND i.id != ?
    ORDER BY i.at DESC LIMIT 10
  `).all(sender, messageId) as any[];
  const rules = d.query("SELECT scope, pattern, category FROM triage_rules").all() as any[];
  const matchedRules = rules.filter((r) =>
    r.scope === "sender" ? sender === r.pattern || sender.endsWith("@" + r.pattern) :
    r.scope === "domain" ? sender.endsWith("@" + r.pattern) : false);
  return {
    message: {
      id: row.id, from: row.from_email, from_name: row.from_name,
      subject: row.subject,
      body: (row.body || "").slice(0, 3000) + ((row.body || "").length > 3000 ? " …[truncated]" : ""),
      at: row.at,
    },
    current_triage: triage ? {
      category: triage.category, source: triage.source,
      confidence: triage.confidence, reason: triage.reason,
      evidence: triage.evidence ? JSON.parse(triage.evidence) : [],
    } : null,
    sender_history: history,
    matched_user_rules: matchedRules,
    note: "Categories: personal (a human wrote to you), newsletter (bulk editorial), receipt (transactional), automated (machine notification).",
  };
}

/** Nudge decision context: what the agent has learned about attention. */
export function nudgeContext(): Record<string, unknown> {
  const d = getDb();
  const kinds = d.query(`
    SELECT kind,
      SUM(CASE WHEN dismissed = 1 THEN 1 ELSE 0 END) AS dismissed,
      COUNT(*) AS total
    FROM nudges GROUP BY kind
  `).all() as Array<{ kind: string; dismissed: number; total: number }>;
  const active = d.query(`
    SELECT n.kind, n.title, n.detail, n.created_at, COALESCE(ct.name, '') AS contact,
      COALESCE(ct.starred, 0) AS starred
    FROM nudges n LEFT JOIN contacts ct ON ct.id = n.contact_id
    WHERE n.dismissed = 0 ORDER BY n.created_at DESC LIMIT 20
  `).all() as any[];
  return {
    kind_stats: kinds.map((k) => ({ kind: k.kind, total: k.total, dismissed: k.dismissed })),
    active_nudges: active,
    note: "kind_stats.dismissed counts nudges the user dismissed — high dismissal means the kind fires too eagerly.",
  };
}

export interface Judgment {
  message_id: string;
  category: TriageCategory;
  confidence?: number;
  reason?: string;
}

/**
 * Apply the LLM's judgment: trains the local Jev model AND locks the triage
 * with source "llm" (only the user's explicit correction outranks it).
 */
export function applyJudgment(j: Judgment): { ok: boolean; id: string } {
  if (!CATS.includes(j.category)) throw new Error("bad category");
  const d = getDb();
  const row = d.query("SELECT * FROM inbox WHERE id = ?").get(j.message_id) as InboxRow | null;
  if (!row) throw new Error("message not found");
  const sender = (row.from_email || "").toLowerCase().trim();
  const conf = Math.min(1, Math.max(0, Number(j.confidence ?? 0.8) || 0.8));
  learn(j.category, { from: sender, subject: row.subject || "", body: row.body || "" });
  const reason = `LLM ${(conf * 100).toFixed(0)}% — ${j.reason || "local model judgment"}`.slice(0, 500);
  mirrorTriage(row.id, j.category, reason, conf, "llm", "");
  return { ok: true, id: row.id };
}

// ---------- automatic consultation ----------

const CONSULT_CAP = 5;
const CONSULT_MIN_GAP_MS = 10 * 60 * 1000;

function buildPrompt(ctx: Record<string, unknown>): string {
  return `You are the triage advisor for a personal email client. Read the message and the decision context, then reply with ONLY a JSON object — no other text.

{"category": "personal|newsletter|receipt|automated", "confidence": 0.0-1.0, "reason": "one short sentence"}

Categories: personal = a human wrote to the user directly; newsletter = bulk editorial content; receipt = transactional (orders, payments, bookings); automated = machine notifications (alerts, digests, system mail).

Context:
${JSON.stringify(ctx, null, 1)}`;
}

/** Extract the first JSON object from a model reply, defensively. */
export function parseJudgment(text: string): { category: string; confidence: number; reason: string } | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (!CATS.includes(o.category)) return null;
    return {
      category: o.category,
      confidence: Math.min(1, Math.max(0, Number(o.confidence ?? 0.5) || 0.5)),
      reason: String(o.reason || "").slice(0, 300),
    };
  } catch { return null; }
}

export interface ConsultReport { consulted: number; applied: number; errors: string[]; skipped: string }

export async function consultLLM(force = false): Promise<ConsultReport> {
  const s = llmSettings();
  const errors: string[] = [];
  if (!s.enabled) return { consulted: 0, applied: 0, errors, skipped: "llm disabled" };
  const last = Number(getSetting("llm_last_consult") || 0);
  if (!force && Date.now() - last < CONSULT_MIN_GAP_MS) {
    return { consulted: 0, applied: 0, errors, skipped: "rate-limited" };
  }
  const pending = pendingForLLM(CONSULT_CAP);
  if (!pending.length) {
    setSetting("llm_last_consult", String(Date.now()));
    return { consulted: 0, applied: 0, errors, skipped: "nothing pending" };
  }
  let applied = 0;
  for (const p of pending) {
    const ctx = messageContext(p.id);
    if (!ctx) continue;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 90_000);
      const r = await fetch(`${s.url}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: ctl.signal,
        body: JSON.stringify({ model: s.model, prompt: buildPrompt(ctx), stream: false, format: "json" }),
      });
      clearTimeout(timer);
      if (!r.ok) throw new Error(`LLM ${r.status}`);
      const j = (await r.json()) as { response?: string };
      const parsed = parseJudgment(j.response || "");
      if (!parsed) throw new Error("unparseable judgment");
      applyJudgment({ message_id: p.id, category: parsed.category as TriageCategory, confidence: parsed.confidence, reason: parsed.reason });
      applied++;
    } catch (e: any) {
      errors.push(`${p.id}: ${String(e?.message || e).slice(0, 120)}`);
      break; // LLM down — don't burn the rest of the batch
    }
  }
  setSetting("llm_last_consult", String(Date.now()));
  return { consulted: pending.length, applied, errors, skipped: "" };
}

/** Reachability probe for the Settings test button (no generation cost). */
export async function llmStatus(): Promise<{ reachable: boolean; models?: string[]; error?: string }> {
  const s = llmSettings();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(`${s.url}/api/tags`, { signal: ctl.signal });
    clearTimeout(timer);
    if (!r.ok) return { reachable: false, error: `HTTP ${r.status}` };
    const j = (await r.json()) as { models?: Array<{ name: string }> };
    return { reachable: true, models: (j.models || []).map((m) => m.name) };
  } catch (e: any) {
    return { reachable: false, error: String(e?.message || e).slice(0, 120) };
  }
}
