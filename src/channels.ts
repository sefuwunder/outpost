// outpost — channel orchestration: outbound routing + inbound polling.
// Transports are injected so tests can stub them; server.ts wires the real ones.

import {
  getContact, conversationFor, addMessage, findContactByEmail, findContactByPhone,
  findContactByMatrixId, findContactByE2EE, upsertUnknown, upsertInbox, getSetting, setSetting,
  getE2EEState, setE2EEState, delE2EEState,
  type Channel, type Contact,
} from "./db";
import { extractEmail, gvNumberFrom, stripGvFooter, type UnseenMail } from "./imap";

export interface Transports {
  sendEmail(to: string, subject: string, text: string): Promise<void>;
  sendSms(digits: string, text: string): Promise<void>;
  sendMatrix(contact: Contact, text: string): Promise<void>;
  sendEncrypted(handle: string, text: string): Promise<void>;
  fetchEmail(): Promise<UnseenMail[]>;
  fetchSms(): Promise<Array<{ number: string; name: string; body: string; at: string; messageId: string }>>;
  fetchMatrix(): Promise<Array<{ sender: string; roomId: string; body: string; at: string; eventId: string }>>;
  fetchEncrypted(): Promise<Array<{ handle: string; body: string; at: string; id: string }>>;
}

export type SendResult = { ok: true; messageId: string } | { ok: false; error: string };

/** Which channels can reach this contact? */
export function availableChannels(c: Contact): Channel[] {
  const out: Channel[] = [];
  if (c.email) out.push("email");
  if (c.phone) out.push("sms");
  if (c.matrix_id) out.push("matrix");
  if (c.e2ee_handle) out.push("encrypted");
  return out;
}

// ---------- E2EE (outpost-e2ee relay) ----------

type E2EEClientT = import("./e2ee/client").E2EEClient;

let e2eeClient: E2EEClientT | null = null;
let e2eeClientKey = "";

function e2eeSettings(): { url: string; token: string; handle: string } {
  return {
    url: (getSetting("e2ee_url") || "http://127.0.0.1:3030").replace(/\/$/, ""),
    token: getSetting("e2ee_token") || "",
    handle: (getSetting("e2ee_handle") || "").toLowerCase().trim(),
  };
}

/** The user's E2EE client, or null when not configured. Keys live in e2ee_state (never API-exposed). */
export async function getE2EEClient(): Promise<E2EEClientT | null> {
  const { url, token, handle } = e2eeSettings();
  if (!handle) return null;
  const key = `${url}|${handle}`;
  if (!e2eeClient || e2eeClientKey !== key) {
    const { E2EEClient } = require("./e2ee/client") as typeof import("./e2ee/client");
    const store = {
      get: (k: string) => getE2EEState(`e2ee:${handle}:${k}`),
      set: (k: string, v: string) => setE2EEState(`e2ee:${handle}:${k}`, v),
      del: (k: string) => delE2EEState(`e2ee:${handle}:${k}`),
    };
    e2eeClient = await E2EEClient.create(handle, token, url, store);
    e2eeClientKey = key;
  }
  return e2eeClient;
}

/** Register (or re-register) our public keys. Idempotent. */
export async function ensureE2EERegistered(): Promise<void> {
  const c = await getE2EEClient();
  if (!c) throw new Error("E2EE not configured — set handle, server URL and token in Settings");
  await c.register();
}

/** Safety number for a peer's handle — read it to each other to verify. */
export async function e2eeSafetyNumber(peerHandle: string): Promise<string> {
  const c = await getE2EEClient();
  if (!c) throw new Error("E2EE not configured");
  return c.safetyNumber(peerHandle.toLowerCase().trim());
}

export async function sendToContact(t: Transports, contactId: string, channel: Channel, body: string): Promise<SendResult> {
  const c = getContact(contactId);
  if (!c || c.archived) return { ok: false, error: "contact not found" };
  const text = body.trim();
  if (!text) return { ok: false, error: "empty message" };
  try {
    if (channel === "email") {
      if (!c.email) return { ok: false, error: "no email address" };
      await t.sendEmail(c.email, "", text);
    } else if (channel === "sms") {
      if (!c.phone) return { ok: false, error: "no phone number" };
      await t.sendSms(c.phone, text);
    } else if (channel === "encrypted") {
      if (!c.e2ee_handle) return { ok: false, error: "no E2EE handle" };
      await t.sendEncrypted(c.e2ee_handle, text);
    } else {
      if (!c.matrix_id) return { ok: false, error: "no matrix id" };
      await t.sendMatrix(c, text);
    }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
  const conv = conversationFor(c.id);
  const m = addMessage({ conversation_id: conv.id, channel, direction: "out", body: text });
  return { ok: true, messageId: m!.id };
}

export interface PollReport { email: number; sms: number; matrix: number; encrypted: number; unknown: number }

/** Ingest one inbound email: inbox row always, contact thread when known. */
export function ingestEmail(m: UnseenMail, report: PollReport): void {
  const addr = extractEmail(m.from || "");
  if (!addr.includes("@")) return;
  const at = m.dateTime || new Date().toISOString();
  // Google Voice SMS forwards arrive as mail from {digits}@txt|mms.voice.google.com —
  // recognize them as SMS (contacts matched by phone digits), not regular email.
  const gvDigits = gvNumberFrom(m.from || "", m.subject || "", m.returnPath || "");
  if (gvDigits) {
    ingestGvSms(m, gvDigits, at, report);
    return;
  }
  const extId = m.messageId ? `email:${m.messageId}` : (m.uid ? `email:uid-${m.uid}@${addr}` : null);
  const c = findContactByEmail(addr);
  if (c) {
    const conv = conversationFor(c.id);
    const added = addMessage({
      conversation_id: conv.id, channel: "email", direction: "in",
      body: m.body || m.snippet, subject: m.subject || "",
      external_id: extId || `email:${m.uid || Date.now()}@${addr}`,
      created_at: at,
    });
    if (added) {
      upsertInbox({
        from_email: addr, from_name: extractName(m.from || ""), subject: m.subject || "",
        body: m.body || m.snippet, at, external_id: extId,
        contact_id: c.id, message_id: added.id,
      });
      report.email++;
    }
  } else {
    upsertInbox({
      from_email: addr, from_name: extractName(m.from || ""), subject: m.subject || "",
      body: m.body || m.snippet, at, external_id: extId,
    });
    upsertUnknown("email", addr, "", m.body || m.snippet, at);
    report.unknown++;
  }
}

/** A GV forward is an SMS wearing an email envelope: strip the gateway
 *  footer, match the contact by phone digits, file it as an SMS message. */
function ingestGvSms(m: UnseenMail, digits: string, at: string, report: PollReport): void {
  const body = stripGvFooter(m.body || m.snippet || "").trim() || "(empty SMS)";
  const extId = m.messageId ? `sms:${m.messageId}` : (m.uid ? `sms:gv-${m.uid}@${digits}` : `sms:gv-${Date.now()}@${digits}`);
  const c = findContactByPhone(digits);
  if (c) {
    const conv = conversationFor(c.id);
    const added = addMessage({
      conversation_id: conv.id, channel: "sms", direction: "in", body,
      external_id: extId, created_at: at,
    });
    if (added) report.sms++;
  } else {
    upsertUnknown("sms", digits, extractName(m.from || ""), body, at);
    report.unknown++;
  }
}

/** One-time backfill: recent mail regardless of \Seen, into the inbox.
 *  Read-only on the server (no flags touched). Bounded by limit. */
export async function backfillInbox(days = 30, limit = 200, secure = true): Promise<PollReport> {
  const imap = require("./imap") as typeof import("./imap");
  if (!getSetting("imap_host") || !getSetting("imap_user"))
    throw new Error("email not configured — add it in ⚙️ Channels first");
  const report: PollReport = { email: 0, sms: 0, matrix: 0, encrypted: 0, unknown: 0 };
  const cfg = {
    host: getSetting("imap_host"), port: Number(getSetting("imap_port") || 993),
    user: getSetting("imap_user"), pass: getSetting("imap_pass"), secure,
  };
  for (const m of await imap.fetchRecent(cfg, days, limit, "INBOX")) ingestEmail(m, report);
  return report;
}

/** One inbound sweep across every configured channel. Best-effort per channel. */
export async function pollInbox(t: Transports): Promise<PollReport> {
  const report: PollReport = { email: 0, sms: 0, matrix: 0, encrypted: 0, unknown: 0 };

  // --- email: UNSEEN only; the backfill covers already-read mail ---
  try {
    for (const m of await t.fetchEmail()) ingestEmail(m, report);
  } catch { /* channel down — next sweep */ }

  // --- sms via google voice forwards: match by digits ---
  try {
    for (const s of await t.fetchSms()) {
      const c = findContactByPhone(s.number);
      if (c) {
        const conv = conversationFor(c.id);
        const added = addMessage({
          conversation_id: conv.id, channel: "sms", direction: "in", body: s.body,
          external_id: s.messageId ? `sms:${s.messageId}` : "",
          created_at: s.at,
        });
        if (added) report.sms++;
      } else if (s.number) {
        upsertUnknown("sms", s.number, s.name || "", s.body, s.at);
        report.unknown++;
      }
    }
  } catch { /* channel down */ }

  // --- matrix: match by sender id, else by room ---
  try {
    for (const m of await t.fetchMatrix()) {
      const c = findContactByMatrixId(m.sender) || findContactByMatrixRoom(m.roomId);
      const at = m.at;
      if (c) {
        const conv = conversationFor(c.id);
        const added = addMessage({
          conversation_id: conv.id, channel: "matrix", direction: "in", body: m.body,
          external_id: m.eventId ? `matrix:${m.eventId}` : "",
          created_at: at,
        });
        if (added) report.matrix++;
      } else if (m.sender) {
        upsertUnknown("matrix", m.sender, "", m.body, at);
        report.unknown++;
      }
    }
  } catch { /* channel down */ }

  // --- encrypted: E2EE via the outpost-e2ee relay; bodies already decrypted ---
  try {
    for (const m of await t.fetchEncrypted()) {
      const c = findContactByE2EE(m.handle);
      const at = m.at;
      if (c) {
        const conv = conversationFor(c.id);
        const added = addMessage({
          conversation_id: conv.id, channel: "encrypted", direction: "in", body: m.body,
          external_id: m.id ? `e2ee:${m.id}` : "",
          created_at: at,
        });
        if (added) report.encrypted++;
      } else if (m.handle) {
        upsertUnknown("encrypted", m.handle, "", m.body, at);
        report.unknown++;
      }
    }
  } catch { /* channel down */ }

  return report;
}

/** "Jane Appleseed <jane@x.com>" → "Jane Appleseed"; bare address → "". */
function extractName(from: string): string {
  const m = from.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>/);
  if (m) return m[1].trim();
  return "";
}

function findContactByMatrixRoom(roomId: string): Contact | null {  if (!roomId) return null;
  const { listContacts } = require("./db") as typeof import("./db");
  for (const c of listContacts(true)) {
    if (getSetting(`matrix_room:${c.id}`) === roomId) return c;
  }
  return null;
}

/** Build real transports from settings. Mirrors relay's wiring. */
export function realTransports(): Transports {
  const imap = require("./imap") as typeof import("./imap");
  const smtp = require("./smtp") as typeof import("./smtp");
  const matrix = require("./matrix") as typeof import("./matrix");

  const imapCfg = () => ({
    host: getSetting("imap_host"), port: Number(getSetting("imap_port") || 993),
    user: getSetting("imap_user"), pass: getSetting("imap_pass"),
  });
  const smtpCfg = () => ({
    host: getSetting("smtp_host"), port: Number(getSetting("smtp_port") || 587),
    user: getSetting("smtp_user"), pass: getSetting("smtp_pass"),
    from: getSetting("smtp_from") || getSetting("imap_user"),
    secure: smtp.smtpSecureMode(getSetting("smtp_secure"), Number(getSetting("smtp_port") || 587)),
  });
  const matrixCfg = () => ({
    homeserver: getSetting("matrix_homeserver"),
    token: getSetting("matrix_token"),
    userId: getSetting("matrix_user_id"),
  });

  return {
    sendEmail: async (to, subject, text) => {
      await smtp.sendMail(smtpCfg(), { to, subject: subject || "outpost", text });
    },
    sendSms: async (digits, text) => {
      await smtp.sendMail(smtpCfg(), { to: smtp.gvGatewayAddress(digits), subject: "outpost", text });
    },
    sendMatrix: async (contact, text) => {
      const roomId = getSetting(`matrix_room:${contact.id}`);
      if (!roomId) throw new Error("no matrix room set for this contact — add it in the contact editor");
      await matrix.matrixSend(matrixCfg(), roomId, text);
    },
    sendEncrypted: async (handle, text) => {
      await ensureE2EERegistered();
      const c = await getE2EEClient();
      await c!.send(handle, text);
    },
    fetchEmail: async () => {
      if (!getSetting("imap_host") || !getSetting("imap_user")) return [];
      return imap.fetchUnseen(imapCfg(), 50, "INBOX", 4000);
    },
    fetchSms: async () => {
      if (!getSetting("imap_host") || !getSetting("imap_user")) return [];
      const harvest = await imap.harvestRecentSms(imapCfg(), 2);
      const out: Array<{ number: string; name: string; body: string; at: string; messageId: string }> = [];
      for (const h of harvest.conversations) {
        const ctx = await imap.latestEmailWith(imapCfg(), `${h.number}@txt.voice.google.com`, 1500).catch(() => null);
        // Dedupe-safe: the real message-id lets addMessage skip forwards that
        // ingestEmail already filed as SMS.
        if (ctx?.snippet) out.push({ number: h.number, name: h.name, body: stripGvFooter(ctx.snippet).trim() || "(empty SMS)", at: ctx.dateTime || ctx.date || new Date().toISOString(), messageId: ctx.messageId || "" });
      }
      return out;
    },
    fetchMatrix: async () => {
      if (!getSetting("matrix_homeserver") || !getSetting("matrix_token")) return [];
      const since = getSetting("matrix_since") || null;
      const { nextBatch, messages } = await matrix.matrixSync(matrixCfg(), since, 15000);
      if (nextBatch) setSetting("matrix_since", nextBatch);
      return messages.map((m) => ({
        sender: m.sender, roomId: m.roomId, body: m.body,
        at: new Date(m.ts).toISOString(), eventId: m.eventId,
      }));
    },
    fetchEncrypted: async () => {
      const c = await getE2EEClient();
      if (!c) return [];
      await ensureE2EERegistered();
      const msgs = await c.poll();
      // Undecryptable envelopes are acked but never stored as messages.
      return msgs
        .filter((m) => !m.text.startsWith("⚠"))
        .map((m) => ({ handle: m.from, body: m.text, at: m.at || new Date().toISOString(), id: m.id }));
    },
  };
}
