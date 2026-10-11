// outpost — conversation-view comms for the outer ring. Bun + zero deps + SQLite.
import { openDb, getDb, listContacts, getContact, createContact, updateContact,
  listConversations, conversationFor, listMessages, markRead, totalUnread,
  listUnknown, promoteUnknown, dismissUnknown, clearAllContacts,
  listActiveNudges, dismissNudge, snoozeNudge, getTriageFull,
  listInbox, getInbox, setInboxRead, deleteInbox, inboxUnread, mirrorTriage,
  getSetting, setSetting, publicSettings } from "./db";
import { availableChannels, sendToContact, pollInbox, realTransports, type Channel } from "./channels";

const PORT = Number(process.env.PORT || 3029);
const root = new URL("../public/", import.meta.url).pathname;

openDb();

const SETTING_KEYS = new Set([
  "imap_host", "imap_port", "imap_user", "imap_pass",
  "smtp_host", "smtp_port", "smtp_user", "smtp_pass", "smtp_from", "smtp_secure",
  "matrix_homeserver", "matrix_token", "matrix_user_id",
  "e2ee_url", "e2ee_token", "e2ee_handle",
  "llm_url", "llm_model", "llm_enabled", "llm_threshold",
]);
const NON_SECRET = ["imap_host", "imap_port", "imap_user", "smtp_host", "smtp_port", "smtp_user", "smtp_from", "smtp_secure", "matrix_homeserver", "matrix_user_id", "e2ee_url", "e2ee_handle", "llm_url", "llm_model", "llm_enabled", "llm_threshold"];

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const bad = (error: string, status = 400) => json({ ok: false, error }, status);

// ---------- inbound poll loop (best-effort, never overlapping) ----------
let polling = false;
let lastPoll: { at: string; report: unknown } | null = null;
async function sweep() {
  if (polling) return;
  polling = true;
  try {
    const report = await pollInbox(realTransports());
    const { runAgent } = await import("./agent");
    const agent = runAgent(Date.now(), { llm: true });
    // First-run bootstrap: the inbox promises 30 days, but the poller only
    // sees UNSEEN mail — backfill recent mail once while the inbox is empty.
    let backfilled: unknown = null;
    if (!getSetting("inbox_backfilled") && getSetting("imap_host") && getSetting("imap_user")) {
      const n = (getDb().query("SELECT COUNT(*) AS n FROM inbox").get() as { n: number }).n;
      if (n === 0) {
        try {
          const { backfillInbox } = await import("./channels");
          backfilled = await backfillInbox(30, 200);
          runAgent();
        } catch (e: any) {
          backfilled = { error: String(e?.message || e).slice(0, 200) };
        }
      }
      setSetting("inbox_backfilled", "1");
    }
    lastPoll = { at: new Date().toISOString(), report: { ...report, ...agent, backfilled } };
  } catch (e: any) {
    lastPoll = { at: new Date().toISOString(), report: { error: String(e?.message || e).slice(0, 200) } };
  } finally {
    polling = false;
  }
}
setInterval(sweep, 60_000);
setTimeout(sweep, 5_000); // first sweep shortly after boot

// ---------- routes ----------
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p === "/api/conversations" && req.method === "GET") {
        return json({ conversations: listConversations(), unread: totalUnread(), lastPoll });
      }
      let m = p.match(/^\/api\/conversations\/([\w-]+)$/);
      if (m && req.method === "GET") {
        const conv = getDb().query("SELECT * FROM conversations WHERE id = ?").get(m[1]) as any;
        if (!conv) return bad("not found", 404);
        const contact = getContact(conv.contact_id);
        markRead(conv.id);
        return json({ conversation: conv, contact, messages: listMessages(conv.id), channels: contact ? availableChannels(contact) : [] });
      }
      m = p.match(/^\/api\/conversations\/([\w-]+)\/send$/);
      if (m && req.method === "POST") {
        const body = await req.json().catch(() => ({})) as { channel?: string; body?: string };
        const channel = body.channel as Channel;
        if (!["email", "sms", "matrix"].includes(channel)) return bad("bad channel");
        const r = await sendToContact(realTransports(), convIdToContact(m[1]), channel, body.body || "");
        return json(r, r.ok ? 200 : 422);
      }
      if (p === "/api/contacts" && req.method === "GET") {
        const contacts = listContacts().map((c) => ({ ...c, matrix_room: getSetting(`matrix_room:${c.id}`) }));
        return json({ contacts });
      }
      if (p === "/api/contacts" && req.method === "POST") {
        const b = await req.json().catch(() => ({})) as any;
        if (!b.name?.trim()) return bad("name required");
        const c = createContact(b);
        conversationFor(c.id);
        return json({ contact: c });
      }
      if (p === "/api/contacts/import" && req.method === "POST") {
        const b = await req.json().catch(() => ({})) as { vcf?: string };
        if (!b.vcf || typeof b.vcf !== "string" || b.vcf.length > 5_000_000) return bad("no vcf data");
        const { importContactsFromVcf } = await import("./import");
        return json(importContactsFromVcf(b.vcf));
      }
      if (p === "/api/contacts/clear" && req.method === "POST") {
        return json({ ok: true, cleared: clearAllContacts() });
      }
      m = p.match(/^\/api\/contacts\/([\w-]+)$/);
      if (m && req.method === "PUT") {
        const b = await req.json().catch(() => ({})) as any;
        const patch: any = {};
        for (const k of ["name", "email", "phone", "matrix_id", "e2ee_handle", "notes", "starred", "archived"]) if (b[k] !== undefined) patch[k] = b[k];
        if (b.matrix_room !== undefined) {
          if (typeof b.matrix_room !== "string" || b.matrix_room.length > 200) return bad("bad room");
          setSetting(`matrix_room:${m[1]}`, b.matrix_room.trim());
        }
        const c = updateContact(m[1], patch);
        if (!c) return bad("not found", 404);
        return json({ contact: { ...c, matrix_room: getSetting(`matrix_room:${c.id}`) } });
      }
      m = p.match(/^\/api\/contacts\/([\w-]+)\/safety$/);
      if (m && req.method === "GET") {
        // Safety number for this contact's E2EE handle — read it to each other.
        const c = getContact(m[1]);
        if (!c?.e2ee_handle) return bad("contact has no E2EE handle", 404);
        try {
          const { e2eeSafetyNumber } = await import("./channels");
          return json({ ok: true, handle: c.e2ee_handle, safetyNumber: await e2eeSafetyNumber(c.e2ee_handle) });
        } catch (e: any) {
          return json({ ok: false, error: String(e?.message || e).slice(0, 200) });
        }
      }
      if (p === "/api/unknown" && req.method === "GET") {
        return json({ unknown: listUnknown() });
      }
      m = p.match(/^\/api\/unknown\/([\w-]+)\/promote$/);
      if (m && req.method === "POST") {
        const b = await req.json().catch(() => ({})) as { name?: string };
        const c = promoteUnknown(m[1], b.name || "");
        if (!c) return bad("not found", 404);
        conversationFor(c.id);
        return json({ contact: c });
      }
      m = p.match(/^\/api\/unknown\/([\w-]+)\/dismiss$/);
      if (m && req.method === "POST") {
        dismissUnknown(m[1]);
        return json({ ok: true });
      }
      if (p === "/api/settings" && req.method === "GET") {
        const values: Record<string, string> = {};
        for (const k of NON_SECRET) values[k] = getSetting(k);
        return json({ ...publicSettings(), values });
      }
      if (p === "/api/settings" && req.method === "PUT") {
        const b = await req.json().catch(() => ({})) as Record<string, string>;
        for (const [k, v] of Object.entries(b)) {
          if (!SETTING_KEYS.has(k) || typeof v !== "string" || v.length > 2000) return bad(`bad key: ${k}`);
          setSetting(k, v);
        }
        return json({ ok: true, ...publicSettings() });
      }
      m = p.match(/^\/api\/settings\/test\/(email|sms|matrix|e2ee)$/);
      if (m && req.method === "POST") {
        const which = m[1];
        try {
          if (which === "e2ee") {
            const { ensureE2EERegistered, getE2EEClient } = await import("./channels");
            await ensureE2EERegistered();
            const c = await getE2EEClient();
            return json({ ok: true, handle: c!.handle, fingerprint: await c!.fingerprint() });
          }
          if (which === "matrix") {
            const mx = await import("./matrix");
            const r = await mx.validateMatrix({
              homeserver: getSetting("matrix_homeserver"),
              token: getSetting("matrix_token"),
            });
            if (r.userId && !getSetting("matrix_user_id")) setSetting("matrix_user_id", r.userId);
            return json({ ok: true, userId: r.userId });
          }
          const im = await import("./imap");
          const sm = await import("./smtp");
          const imapCfg = { host: getSetting("imap_host"), port: Number(getSetting("imap_port") || 993), user: getSetting("imap_user"), pass: getSetting("imap_pass") };
          const smtpPort = Number(getSetting("smtp_port") || 587);
          const smtpCfg = { host: getSetting("smtp_host"), port: smtpPort, user: getSetting("smtp_user"), pass: getSetting("smtp_pass"), from: getSetting("smtp_from") || getSetting("imap_user"), secure: sm.smtpSecureMode(getSetting("smtp_secure"), smtpPort) };
          if (which === "email") { await im.validateImap(imapCfg); await sm.validateSmtp(smtpCfg); }
          else { await sm.validateSmtp(smtpCfg); await im.validateImap(imapCfg); } // sms rides both
          return json({ ok: true });
        } catch (e: any) {
          return json({ ok: false, error: String(e?.message || e).slice(0, 300) });
        }
      }
      if (p === "/api/poll" && req.method === "POST") {
        await sweep();
        return json({ ok: true, lastPoll });
      }
      if (p === "/api/inbox/backfill" && req.method === "POST") {
        const { backfillInbox } = await import("./channels");
        try {
          const r = await backfillInbox(30, 200);
          const { runAgent } = await import("./agent");
          const agent = runAgent();
          setSetting("inbox_backfilled", "1");
          return json({ ok: true, ...r, ...agent });
        } catch (e: any) {
          return json({ ok: false, error: String(e?.message || e).slice(0, 200) });
        }
      }
      if (p === "/api/agent/run" && req.method === "POST") {
        const { runAgent } = await import("./agent");
        return json({ ok: true, ...runAgent() });
      }
      if (p === "/api/nudges" && req.method === "GET") {
        const { scoreNudge } = await import("./jev");
        const nudges = listActiveNudges()
          .map((n) => ({ ...n, score: scoreNudge(n) }))
          .sort((a, b) => b.score - a.score);
        return json({ nudges });
      }
      if (p === "/api/inbox" && req.method === "GET") {
        const { runAgent, rankInbox } = await import("./agent");
        runAgent(); // ensure fresh triage before grouping
        const rows = listInbox();
        const sections: Record<string, typeof rows> = { personal: [], newsletter: [], receipt: [], automated: [] };
        for (const r of rows) (sections[r.category] || sections.personal).push(r);
        return json({ sections, unread: inboxUnread(), priority: rankInbox(8) });
      }
      m = p.match(/^\/api\/inbox\/([\w-]+)$/);
      if (m && req.method === "DELETE") { deleteInbox(m[1]); return json({ ok: true }); }
      m = p.match(/^\/api\/inbox\/([\w-]+)\/read$/);
      if (m && req.method === "POST") {
        const b = await req.json().catch(() => ({})) as { read?: boolean };
        setInboxRead(m[1], b.read !== false);
        return json({ ok: true });
      }
      m = p.match(/^\/api\/nudges\/([\w-]+)\/dismiss$/);
      if (m && req.method === "POST") {
        const { recordNudgeFeedback } = await import("./jev");
        const n = getDb().query("SELECT kind FROM nudges WHERE id = ?").get(m[1]) as { kind: string } | null;
        if (n) recordNudgeFeedback(n.kind, false); // dismissed → learn it wasn't wanted
        dismissNudge(m[1]);
        return json({ ok: true });
      }
      m = p.match(/^\/api\/nudges\/([\w-]+)\/acted$/);
      if (m && req.method === "POST") {
        const { recordNudgeFeedback } = await import("./jev");
        const n = getDb().query("SELECT kind FROM nudges WHERE id = ?").get(m[1]) as { kind: string } | null;
        if (n) recordNudgeFeedback(n.kind, true); // opened the thread → useful
        return json({ ok: true });
      }
      if (p === "/api/triage/explain" && req.method === "GET") {
        const messageId = url.searchParams.get("messageId") || "";
        const t = getTriageFull(messageId);
        if (!t) return bad("not found", 404);
        const fromEmail =
          (getDb().query("SELECT from_email FROM inbox WHERE id = ?").get(messageId) as any)?.from_email ||
          (getDb().query("SELECT ct.email FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contacts ct ON ct.id = c.contact_id WHERE m.id = ?").get(messageId) as any)?.email || "";
        return json({ ...t, from_email: fromEmail, evidence: t.evidence ? JSON.parse(t.evidence) : [] });
      }
      m = p.match(/^\/api\/triage\/([\w-]+)\/correct$/);
      if (m && req.method === "POST") {
        const b = await req.json().catch(() => ({})) as { category?: string; scope?: string };
        if (!["personal", "newsletter", "receipt", "automated"].includes(b.category || "")) return bad("bad category");
        const { learn } = await import("./jev");
        const { reorganizePass } = await import("./agent");
        const { upsertTriageRule } = await import("./db");
        const msg = getDb().query(`
          SELECT m.subject, m.body, ct.email FROM messages m
          JOIN conversations c ON c.id = m.conversation_id
          JOIN contacts ct ON ct.id = c.contact_id WHERE m.id = ?`).get(m[1]) as any
          || getDb().query("SELECT subject, body, from_email AS email FROM inbox WHERE id = ?").get(m[1]) as any;
        if (!msg) return bad("not found", 404);
        const scope = b.scope === "sender" ? "sender" : "one";
        const sender = (msg.email || "").toLowerCase().trim();
        if (scope === "sender" && sender.includes("@")) upsertTriageRule("sender", sender, b.category as any);
        learn(b.category as any, { from: sender, subject: msg.subject || "", body: msg.body || "" });
        mirrorTriage(m[1], b.category as any, "corrected by you — model updated", 1, "user", "");
        const { reorganized } = reorganizePass();
        return json({ ok: true, rule: scope === "sender" ? sender : null, reorganized });
      }
      if (p === "/api/triage/rules" && req.method === "GET") {
        const { listTriageRules } = await import("./db");
        return json({ rules: listTriageRules() });
      }
      m = p.match(/^\/api\/triage\/rules\/([\w-]+)$/);
      if (m && req.method === "DELETE") {
        const { deleteTriageRule, listTriageRules } = await import("./db");
        deleteTriageRule(m[1]);
        return json({ ok: true, rules: listTriageRules() });
      }
      // ---------- local LLM bridge: context out, judgments in ----------
      if (p === "/api/llm/pending" && req.method === "GET") {
        const { pendingForLLM } = await import("./llm");
        return json({ pending: pendingForLLM(20) });
      }
      if (p === "/api/llm/context" && req.method === "GET") {
        const { messageContext } = await import("./llm");
        const ctx = messageContext(String(url.searchParams.get("message_id") || ""));
        if (!ctx) return bad("not found", 404);
        return json(ctx);
      }
      if (p === "/api/llm/nudges" && req.method === "GET") {
        const { nudgeContext } = await import("./llm");
        return json(nudgeContext());
      }
      if (p === "/api/llm/judgment" && req.method === "POST") {
        const b = await req.json().catch(() => ({})) as any;
        const ids = Array.isArray(b.message_ids) ? b.message_ids : b.message_id ? [b.message_id] : [];
        if (!ids.length) return bad("message_id required");
        const { applyJudgment } = await import("./llm");
        const applied: string[] = [];
        try {
          for (const id of ids.slice(0, 50)) {
            applyJudgment({ message_id: String(id), category: b.category, confidence: b.confidence, reason: b.reason });
            applied.push(String(id));
          }
        } catch (e: any) {
          return json({ ok: false, error: String(e?.message || e).slice(0, 200), applied });
        }
        return json({ ok: true, applied });
      }
      if (p === "/api/llm/consult" && req.method === "POST") {
        const { consultLLM } = await import("./llm");
        return json({ ok: true, ...(await consultLLM(true)) });
      }
      if (p === "/api/llm/status" && req.method === "GET") {
        const { llmSettings, llmStatus, pendingForLLM } = await import("./llm");
        const s = llmSettings();
        return json({ ...(await llmStatus()), enabled: s.enabled, url: s.url, model: s.model, pending: pendingForLLM(5).length });
      }
      if (p === "/api/inbox/reorganize" && req.method === "POST") {
        const { reorganizePass } = await import("./agent");
        const { reorganized } = reorganizePass();
        return json({ ok: true, reorganized });
      }
      m = p.match(/^\/api\/nudges\/([\w-]+)\/snooze$/);
      if (m && req.method === "POST") {
        const b = await req.json().catch(() => ({})) as { days?: number };
        const days = Math.min(30, Math.max(1, Number(b.days) || 3));
        snoozeNudge(m[1], Date.now() + days * 86400_000);
        return json({ ok: true });
      }

      // static
      let fp = p === "/" ? "/index.html" : decodeURIComponent(p);
      const file = Bun.file(root + fp.replace(/^\/+/, ""));
      if (await file.exists()) {
        const ext = fp.slice(fp.lastIndexOf("."));
        return new Response(file, { headers: { "Content-Type": TYPES[ext] || "application/octet-stream" } });
      }
      return new Response("not found", { status: 404 });
    } catch (e: any) {
      return bad(String(e?.message || e).slice(0, 300), 500);
    }
  },
});

function convIdToContact(convId: string): string {
  const r = getDb().query("SELECT contact_id FROM conversations WHERE id = ?").get(convId) as { contact_id: string } | null;
  return r?.contact_id || "";
}

console.log(`outpost on http://127.0.0.1:${PORT}`);
