// outpost agent — deterministic email triage + nudges. No AI, no network:
// explicit rules over message metadata, safe to run on every poll.

import {
  getDb, setTriage, untriagedEmail, upsertNudge, pruneNudges, listActiveNudges,
  listUnknown, type TriageCategory,
} from "./db";

export interface Classification { category: TriageCategory; reason: string }

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

export interface AgentReport { triaged: number; nudges: number; pruned: number }

/**
 * One agent pass: triage untriaged inbound email, then (re)compute nudges.
 * Idempotent — rerunning changes nothing unless the underlying state changed.
 */
export function runAgent(nowMs = Date.now()): AgentReport {
  let triaged = 0;
  for (const m of untriagedEmail()) {
    const c = classifyEmail({ from: m.from_email, subject: m.subject, body: m.body });
    setTriage(m.id, c.category, c.reason);
    triaged++;
  }

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
  return { triaged, nudges, pruned };
}
