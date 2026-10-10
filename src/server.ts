// outpost — conversation-view comms for the outer ring. Bun + zero deps + SQLite.
import { openDb, getDb, listContacts, getContact, createContact, updateContact,
  listConversations, conversationFor, listMessages, markRead, totalUnread,
  listUnknown, promoteUnknown, dismissUnknown, getSetting, setSetting,
  publicSettings } from "./db";
import { availableChannels, sendToContact, pollInbox, realTransports, type Channel } from "./channels";

const PORT = Number(process.env.PORT || 3029);
const root = new URL("../public/", import.meta.url).pathname;

openDb();

const SETTING_KEYS = new Set([
  "imap_host", "imap_port", "imap_user", "imap_pass",
  "smtp_host", "smtp_port", "smtp_user", "smtp_pass", "smtp_from", "smtp_secure",
  "matrix_homeserver", "matrix_token", "matrix_user_id",
]);
const NON_SECRET = ["imap_host", "imap_port", "imap_user", "smtp_host", "smtp_port", "smtp_user", "smtp_from", "matrix_homeserver", "matrix_user_id"];

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
    lastPoll = { at: new Date().toISOString(), report };
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
      m = p.match(/^\/api\/contacts\/([\w-]+)$/);
      if (m && req.method === "PUT") {
        const b = await req.json().catch(() => ({})) as any;
        const patch: any = {};
        for (const k of ["name", "email", "phone", "matrix_id", "notes", "starred", "archived"]) if (b[k] !== undefined) patch[k] = b[k];
        if (b.matrix_room !== undefined) {
          if (typeof b.matrix_room !== "string" || b.matrix_room.length > 200) return bad("bad room");
          setSetting(`matrix_room:${m[1]}`, b.matrix_room.trim());
        }
        const c = updateContact(m[1], patch);
        if (!c) return bad("not found", 404);
        return json({ contact: { ...c, matrix_room: getSetting(`matrix_room:${c.id}`) } });
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
      m = p.match(/^\/api\/settings\/test\/(email|sms|matrix)$/);
      if (m && req.method === "POST") {
        const which = m[1];
        try {
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
          const smtpCfg = { host: getSetting("smtp_host"), port: Number(getSetting("smtp_port") || 587), user: getSetting("smtp_user"), pass: getSetting("smtp_pass"), from: getSetting("smtp_from") || getSetting("imap_user"), secure: getSetting("smtp_secure") !== "off" };
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
