// outpost jev — a local Jev-style decision engine: typed probabilistic
// classify/score with calibrated confidence, learning online from feedback.
// Multinomial naive bayes over lightweight evidence features, zero deps.
// The deterministic rule set remains the day-one fallback and the seed.

import { getDb } from "./db";

export const CLASSES = ["personal", "newsletter", "receipt", "automated"] as const;
export type JevClass = (typeof CLASSES)[number];

export interface Evidence { feature: string; weight: number } // log-odds contribution
export interface JevClassification {
  label: JevClass;
  confidence: number;            // tempered posterior of the top class, 0..1
  scores: Record<string, number>; // posterior per class
  evidence: Evidence[];          // top features by |log-odds| vs runner-up
  knownFeatures: number;         // features seen during training (calibration gate)
}

const STOP = new Set(("the,a,an,and,or,to,of,in,on,for,with,is,are,was,were,be,been,at,by,from,as,it,its,this,that,these,those,you,your,we,our,they,their,he,she,his,her,will,would,can,just,have,has,had,not,no,yes,do,does,did,but,if,then,than,so,such,into,out,up,down,over,under,again,once,here,there,when,where,why,how,all,any,each,few,more,most,other,some,only,own,same,me,my,i,me").split(","));

export interface JevInput { from: string; subject: string; body: string }

/** Evidence features: sender signals + subject markers + word tokens. */
export function featuresOf(t: JevInput): string[] {
  const feats: string[] = [];
  const from = (t.from || "").toLowerCase();
  const [local, domain] = from.split("@");
  if (domain) feats.push("from_domain:" + domain);
  if (/^(newsletter|news|digest|updates|marketing|promo|deals|offers)/.test(local || "")) feats.push("from_bulk:1");
  if (/^(no-?reply|donotreply|notification)/.test(local || "")) feats.push("from_auto:1");
  const subj = (t.subject || "").toLowerCase();
  const full = (subj + "\n" + (t.body || "").slice(0, 3000)).toLowerCase();
  if (/unsubscribe|list-unsubscribe|opt out|manage subscription|email preferences/.test(full)) feats.push("has_unsub:1");
  if (/\b(receipt|order confirmation|your invoice|tracking number|has shipped|payment received)\b/.test(subj)) feats.push("subject_receipt:1");
  const words = full.replace(/[^a-z0-9\s]/g, " ").split(/\s+/);
  const seen = new Set<string>();
  for (const w of words) {
    if (w.length < 3 || w.length > 20 || STOP.has(w) || seen.has(w)) continue;
    seen.add(w);
    feats.push("w:" + w);
  }
  return feats;
}

// ---------- model storage ----------
const ALPHA = 1;      // laplace smoothing
const TEMP = 2.0;     // tempering for honest (less spiky) posteriors
const MIN_KNOWN = 3;  // below this many trained features, don't trust the model

function featCount(feature: string, cls: string): number {
  const r = getDb().query("SELECT n FROM jev_feat WHERE feature = ? AND class = ?").get(feature, cls) as { n: number } | null;
  return r?.n || 0;
}
function classStats(cls: string): { docs: number; feats: number } {
  const r = getDb().query("SELECT docs, feats FROM jev_cls WHERE class = ?").get(cls) as { docs: number; feats: number } | null;
  return r || { docs: 0, feats: 0 };
}
function vocabSize(): number {
  const r = getDb().query("SELECT COUNT(DISTINCT feature) AS n FROM jev_feat").get() as { n: number };
  return Math.max(r.n, 1);
}
function totalDocs(): number {
  const r = getDb().query("SELECT SUM(docs) AS n FROM jev_cls").get() as { n: number };
  return r.n || 0;
}

/** Online learning: one labeled example updates the counts. */
export function learn(cls: JevClass, input: JevInput): void {
  const d = getDb();
  const feats = featuresOf(input);
  d.query("INSERT INTO jev_cls(class, docs, feats) VALUES(?, 0, 0) ON CONFLICT(class) DO NOTHING").run(cls);
  d.query("UPDATE jev_cls SET docs = docs + 1, feats = feats + ? WHERE class = ?").run(feats.length, cls);
  const ins = d.prepare("INSERT INTO jev_feat(feature, class, n) VALUES(?,?,1) ON CONFLICT(feature, class) DO UPDATE SET n = n + 1");
  for (const f of feats) ins.run(f, cls);
}

function logScores(feats: string[]): { scores: Record<string, number>; known: number } {
  const V = vocabSize();
  const total = totalDocs();
  const scores: Record<string, number> = {};
  for (const cls of CLASSES) {
    const st = classStats(cls);
    let lp = Math.log((st.docs + ALPHA) / (total + ALPHA * CLASSES.length));
    for (const f of feats) {
      const c = featCount(f, cls);
      lp += Math.log((c + ALPHA) / (st.feats + ALPHA * V));
    }
    scores[cls] = lp / TEMP;
  }
  let known = 0;
  for (const f of feats) {
    for (const cls of CLASSES) if (featCount(f, cls) > 0) { known++; break; }
  }
  return { scores, known };
}

/** Jev-style classify: label + calibrated confidence + evidence. Pure read. */
export function classify(input: JevInput): JevClassification {
  const feats = featuresOf(input);
  const { scores, known } = logScores(feats);
  const max = Math.max(...Object.values(scores));
  const exps: Record<string, number> = {};
  let sum = 0;
  for (const [k, v] of Object.entries(scores)) { exps[k] = Math.exp(v - max); sum += exps[k]; }
  const post: Record<string, number> = {};
  for (const k of Object.keys(exps)) post[k] = exps[k] / sum;
  const ranked = (Object.keys(post) as JevClass[]).sort((a, b) => post[b] - post[a]);
  const [top, runner] = ranked;
  // evidence: features with the largest log-odds swing top-vs-runner
  const V = vocabSize();
  const ev: Evidence[] = [];
  for (const f of feats) {
    const stT = classStats(top), stR = classStats(runner);
    const pT = (featCount(f, top) + ALPHA) / (stT.feats + ALPHA * V);
    const pR = (featCount(f, runner) + ALPHA) / (stR.feats + ALPHA * V);
    ev.push({ feature: prettyFeature(f), weight: Math.log(pT / pR) });
  }
  ev.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  return { label: top, confidence: post[top], scores: post, evidence: ev.slice(0, 6), knownFeatures: known };
}

function prettyFeature(f: string): string {
  if (f.startsWith("w:")) return `"${f.slice(2)}"`;
  if (f === "has_unsub:1") return "unsubscribe marker";
  if (f === "subject_receipt:1") return "receipt subject";
  if (f === "from_bulk:1") return "bulk sender";
  if (f === "from_auto:1") return "automated sender";
  if (f.startsWith("from_domain:")) return "from " + f.slice(12);
  return f;
}

export function modelTrusted(input: JevInput): boolean {
  return classify(input).knownFeatures >= MIN_KNOWN;
}

/** Seed corpus: a small hand-labeled set so the model is sane on day one. */
const SEED: Array<{ cls: JevClass; from: string; subject: string; body: string }> = [
  { cls: "newsletter", from: "news@blog.com", subject: "Weekly digest", body: "Top stories this week. Unsubscribe here." },
  { cls: "newsletter", from: "deals@shop.com", subject: "50% off ends tonight", body: "Sale ends soon. Manage your email preferences." },
  { cls: "newsletter", from: "newsletter@co.com", subject: "Monthly updates", body: "What we shipped. Opt out anytime." },
  { cls: "receipt", from: "orders@store.com", subject: "Your receipt from Acme", body: "Thanks for your order. Order total $42." },
  { cls: "receipt", from: "shipping@shop.com", subject: "Your order has shipped", body: "Tracking number 1Z999. Expected Friday." },
  { cls: "receipt", from: "billing@saas.com", subject: "Your invoice for October", body: "Payment received. Invoice attached." },
  { cls: "automated", from: "noreply@bank.com", subject: "Statement ready", body: "Your monthly statement is available. Do not reply." },
  { cls: "automated", from: "notifications@app.com", subject: "Security alert", body: "New sign-in detected on your account." },
  { cls: "personal", from: "ada@example.com", subject: "dinner Thursday?", body: "Are you free Thursday evening? Would love to catch up." },
  { cls: "personal", from: "bo@keller.co", subject: "intro", body: "Great meeting you yesterday. Lets talk next week." },
  { cls: "personal", from: "mae@home.org", subject: "photos", body: "Sending the photos from the weekend trip!" },
];

/** Train the seed corpus once (idempotent via a marker row). */
export function ensureSeeded(): void {
  const d = getDb();
  if (d.query("SELECT n FROM jev_feat WHERE feature = '__seed__' AND class = '__seed__'").get()) return;
  for (const s of SEED) learn(s.cls, { from: s.from, subject: s.subject, body: s.body });
  d.query("INSERT INTO jev_feat(feature, class, n) VALUES('__seed__', '__seed__', 1)").run();
}

// ---------- nudge scoring: fuzzy priority that learns per kind ----------
export interface NudgeWeights { acted: number; dismissed: number }

export function recordNudgeFeedback(kind: string, acted: boolean): void {
  getDb().query(
    "INSERT INTO jev_nudge_fb(kind, acted, dismissed) VALUES(?, ?, ?) ON CONFLICT(kind) DO UPDATE SET acted = acted + excluded.acted, dismissed = dismissed + excluded.dismissed"
  ).run(kind, acted ? 1 : 0, acted ? 0 : 1);
}

/** Laplace-smoothed P(user acts | nudge kind). Starts at 0.5, learns over time. */
export function kindWeight(kind: string): number {
  const r = getDb().query("SELECT acted, dismissed FROM jev_nudge_fb WHERE kind = ?").get(kind) as NudgeWeights | null;
  const a = r?.acted || 0, d = r?.dismissed || 0;
  return (a + 1) / (a + d + 2);
}

/** Fuzzy priority 0..1: learned kind weight × urgency ramp × starred boost. */
export function scoreNudge(n: { kind: string; detail: string; contact_starred?: number }): number {
  const ageM = n.detail.match(/(\d+) days?/);
  const age = ageM ? Number(ageM[1]) : 3;
  const rampDays = n.kind === "follow_up" ? 14 : n.kind === "unknown_waiting" ? 5 : 6;
  const urgency = Math.min(1, age / rampDays);
  const starred = n.contact_starred ? 1.25 : 1;
  return Math.min(1, kindWeight(n.kind) * (0.35 + 0.65 * urgency) * starred);
}
