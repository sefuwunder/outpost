// outpost agent — deterministic email triage + nudges. No AI, no network:
// explicit rules over message metadata, safe to run on every poll.

import {
  getDb, setTriage, untriagedEmail, untriagedInbox, upsertNudge, pruneNudges, listActiveNudges,
  listUnknown, matchTriageRule, listInbox, findContactByEmail, getContact,
  type TriageCategory, type InboxRow,
} from "./db";
import { ensureSeeded, classify, modelTrusted, type JevClass } from "./jev";

export interface Classification { category: TriageCategory; reason: string }

export interface PriorityItem extends InboxRow { score: number; why: string[] }

/**
 * "Read now": the unread inbox messages the agent thinks matter most.
 * Deterministic and explainable — category weight, recency, starred senders,
 * and open nudges (reply-needed, unknown-waiting) all feed the score.
 */
export function rankInbox(limit = 8, nowMs = Date.now()): PriorityItem[] {
  const nudges = listActiveNudges(nowMs);
  const replyNeededFor = new Set(nudges.filter((n) => n.kind === "reply_needed").map((n) => n.contact_id));
  const unknownSenders = new Set(nudges.filter((n) => n.kind === "unknown_waiting").map((n) => n.contact_id));
  const base: Record<string, number> = { personal: 100, receipt: 60, automated: 40, newsletter: 15 };
  const scored: PriorityItem[] = [];
  for (const r of listInbox()) {
    if (r.read) continue;
    const why: string[] = [];
    let score = base[r.category] ?? 40;
    why.push(r.category);
    const ageH = Math.max(0, (nowMs - Date.parse(r.at)) / 36e5);
    const fresh = Math.max(0, 50 - ageH * 1.5);
    score += fresh;
    if (ageH < 6) why.push("recent");
    const contact = (r.contact_id && getContact(r.contact_id)) || findContactByEmail(r.from_email);
    if (contact?.starred) { score += 30; why.push("starred"); }
    if (contact && replyNeededFor.has(contact.id)) { score += 80; why.push("needs your reply"); }
    if (contact && unknownSenders.has(contact.id)) { score += 40; why.push("waiting on you"); }
    scored.push({ ...r, score: Math.round(score), why });
  }
  scored.sort((a, b) => b.score - a.score || (a.at < b.at ? 1 : -1));
  return scored.slice(0, limit);
}

export interface Classified extends Classification {
  confidence: number;
  source: "userrule" | "model" | "rules";
  evidence: string;
}

const RECEIPT_RE = /\b(receipt|order confirmation|your invoice|payment (received|confirmed)|has shipped|tracking number|your order|booking confirmation)\b/i;
const UNSUB_RE = /unsubscribe|list-unsubscribe|opt out|email preferences|manage subscription/i;
const BULK_FROM_RE = /^(newsletter|news|digest|updates|marketing|promo|deals|offers|noreply-news)@/i;
const AUTO_FROM_RE = /^(no-?reply|donotreply|notification|notifications|alert|alerts|support|billing)@/i;

/** Classify one inbound email. Pure — every decision is explainable. */
export function classifyEmail(m: { from: string; subject: string; body: string }): Classification {
  const from = (m.from || "").toLowerCase();
  const subj = m.subject || "";
  const text = (subj + "\n" + (m.body || "").slice(0, 2000)).toLowerCase();
  if (RECEIPT_RE.test(subj)) return { category: "receipt", reason: "subject matches receipt/order pattern" };
  if (UNSUB_RE.test(text) || BULK_FROM_RE.test(from))
    return { category: "newsletter", reason: UNSUB_RE.test(text) ? "unsubscribe marker in message" : "bulk sender address" };
  if (AUTO_FROM_RE.test(from)) return { category: "automated", reason: "automated sender address" };
  return { category: "personal", reason: "direct message" };
}

const DAY = 86400_000;
const startOfDay = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
/** Whole calendar days between two timestamps (local day arithmetic). */
export const daysBetween = (aMs: number, bMs: number) =>
  Math.round((startOfDay(bMs) - startOfDay(aMs)) / DAY);

export interface AgentReport { triaged: number; reorganized: number; nudges: number; pruned: number }

/**
 * One classification with precedence: user rule > learned model > deterministic
 * rules. Pure — every decision is explainable.
 */
export function classifyWithRules(m: { from: string; subject: string; body: string }): Classified {
  const rule = matchTriageRule(m.from || "");
  if (rule) return {
    category: rule.category,
    reason: rule.scope === "sender"
      ? `your rule: always ${rule.category} from ${rule.pattern}`
      : `your rule: always ${rule.category} from @${rule.pattern}`,
    confidence: 1, source: "userrule", evidence: "",
  };
  const input = { from: m.from, subject: m.subject, body: m.body };
  if (modelTrusted(input)) {
    const j = classify(input);
    return {
      category: j.label as TriageCategory,
      reason: `model ${(j.confidence * 100).toFixed(0)}% — ${j.evidence.slice(0, 3).map((e) => `${e.feature} (${e.weight >= 0 ? "+" : ""}${e.weight.toFixed(1)})`).join(", ")}`,
      confidence: j.confidence, source: "model", evidence: JSON.stringify(j.evidence.slice(0, 6)),
    };
  }
  const c = classifyEmail(m);
  return { category: c.category, reason: c.reason, confidence: 0, source: "rules", evidence: "" };
}

/**
 * Re-apply the current rules/model to every already-triaged mail whose label
 * is not user-locked (source 'user' = an explicit correction, ground truth).
 * Idempotent — only rows whose category actually changes are rewritten.
 */
export function reorganizePass(): { reorganized: number } {
  ensureSeeded();
  let reorganized = 0;
  const d = getDb();
  const apply = (id: string, mirrorTo: string | undefined, from: string, subject: string, body: string, cur: string | null, src: string | null) => {
    if (src === "user" || src === "llm") return; // explicit judgments are never overwritten
    const c = classifyWithRules({ from, subject, body });
    if (cur && cur === c.category) return;
    setTriage(id, c.category, c.reason, c.confidence, c.source, c.evidence);
    if (mirrorTo) setTriage(mirrorTo, c.category, c.reason, c.confidence, c.source, c.evidence);
    reorganized++;
  };
  type Row = { id: string; from_email: string; subject: string; body: string; message_id: string; cur: string | null; src: string | null };
  const inboxRows = d.query(`
    SELECT i.id, i.from_email, i.subject, i.body, i.message_id, t.category AS cur, t.source AS src
    FROM inbox i LEFT JOIN triage t ON t.message_id = i.id
  `).all() as Row[];
  for (const r of inboxRows) apply(r.id, r.message_id || undefined, r.from_email, r.subject, r.body, r.cur, r.src);
  const msgRows = d.query(`
    SELECT m.id, ct.email AS from_email, m.subject, m.body, t.category AS cur, t.source AS src
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    JOIN contacts ct ON ct.id = c.contact_id
    LEFT JOIN triage t ON t.message_id = m.id
    WHERE m.channel = 'email' AND m.direction = 'in'
      AND NOT EXISTS (SELECT 1 FROM inbox i WHERE i.message_id = m.id)
  `).all() as Row[];
  for (const r of msgRows) apply(r.id, undefined, r.from_email, r.subject, r.body, r.cur, r.src);
  return { reorganized };
}

/**
 * One agent pass: triage new inbound email, reorganize existing labels under
 * the current rules, then (re)compute nudges. Idempotent.
 */
export function runAgent(nowMs = Date.now(), opts?: { llm?: boolean }): AgentReport {
  ensureSeeded();
  let triaged = 0;
  const triageNew = (id: string, from: string, subject: string, body: string, mirrorTo?: string) => {
    const c = classifyWithRules({ from, subject, body });
    setTriage(id, c.category, c.reason, c.confidence, c.source, c.evidence);
    if (mirrorTo) setTriage(mirrorTo, c.category, c.reason, c.confidence, c.source, c.evidence);
    triaged++;
  };
  for (const m of untriagedEmail()) triageNew(m.id, m.from_email, m.subject, m.body);
  for (const i of untriagedInbox()) triageNew(i.id, i.from_email, i.subject, i.body, i.message_id || undefined);
  const { reorganized } = reorganizePass();

  const d = getDb();
  const valid = new Set<string>();

  // per-conversation state for nudge rules
  const convs = d.query(`
    SELECT c.id AS conv_id, c.contact_id, ct.name,
      (SELECT direction FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_dir,
      (SELECT id FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_msg,
      (SELECT created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_at,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'out') AS out_count
    FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
    WHERE c.archived = 0 AND ct.archived = 0
  `).all() as Array<{ conv_id: string; contact_id: string; name: string; last_dir: string; last_msg: string; last_at: string; out_count: number }>;

  for (const cv of convs) {
    if (!cv.last_at) continue;
    const ageDays = daysBetween(new Date(cv.last_at).getTime(), nowMs);
    const triageCat = cv.last_msg
      ? (d.query("SELECT category FROM triage WHERE message_id = ?").get(cv.last_msg) as { category: string } | null)?.category
      : null;
    const needsReply = triageCat !== "newsletter" && triageCat !== "receipt" && triageCat !== "automated";
    if (cv.last_dir === "in" && ageDays >= 3 && needsReply) {
      const dedupe = `reply_needed:${cv.conv_id}`;
      valid.add(dedupe);
      upsertNudge({
        kind: "reply_needed", dedupe, conversation_id: cv.conv_id, contact_id: cv.contact_id,
        message_id: cv.last_msg, title: `Reply to ${cv.name}`,
        detail: `Their last message is ${ageDays} days old with no reply from you.`,
      });
    } else if (cv.last_dir === "out" && cv.out_count > 0 && ageDays >= 7) {
      const dedupe = `follow_up:${cv.conv_id}`;
      valid.add(dedupe);
      upsertNudge({
        kind: "follow_up", dedupe, conversation_id: cv.conv_id, contact_id: cv.contact_id,
        message_id: cv.last_msg, title: `Follow up with ${cv.name}`,
        detail: `No reply in ${ageDays} days since your last message.`,
      });
    }
  }

  for (const u of listUnknown()) {
    if (!u.last_at) continue;
    const ageDays = daysBetween(new Date(u.last_at).getTime(), nowMs);
    if (ageDays >= 2) {
      const dedupe = `unknown_waiting:${u.id}`;
      valid.add(dedupe);
      upsertNudge({
        kind: "unknown_waiting", dedupe,
        title: `New sender waiting: ${u.name || u.handle}`,
        detail: `First reached out ${ageDays} days ago via ${u.channel} — save or dismiss.`,
      });
    }
  }

  const pruned = pruneNudges(valid);
  const nudges = listActiveNudges(nowMs).length;
  if (opts?.llm) {
    // Best-effort: ask the local LLM about ambiguous triage in the background.
    // Rate-limited inside consultLLM; results land as source="llm" triage.
    import("./llm").then((m) => m.consultLLM().catch(() => {})).catch(() => {});
  }
  return { triaged, reorganized, nudges, pruned };
}
