// outpost — channel orchestration: outbound routing + inbound polling.
// Transports are injected so tests can stub them; server.ts wires the real ones.

import {
  getContact, conversationFor, addMessage, findContactByEmail, findContactByPhone,
  findContactByMatrixId, upsertUnknown, upsertInbox, getSetting, setSetting,
  type Channel, type Contact,
} from "./db";
import { extractEmail, type UnseenMail } from "./imap";

export interface Transports {
  sendEmail(to: string, subject: string, text: string): Promise<void>;
  sendSms(digits: string, text: string): Promise<void>;
  sendMatrix(contact: Contact, text: string): Promise<void>;
  fetchEmail(): Promise<UnseenMail[]>;
  fetchSms(): Promise<Array<{ number: string; name: string; body: string; at: string; messageId: string }>>;
  fetchMatrix(): Promise<Array<{ sender: string; roomId: string; body: string; at: string; eventId: string }>>;
}

export type SendResult = { ok: true; messageId: string } | { ok: false; error: string };

/** Which channels can reach this contact? */
export function availableChannels(c: Contact): Channel[] {
  const out: Channel[] = [];
  if (c.email) out.push("email");
  if (c.phone) out.push("sms");
  if (c.matrix_id) out.push("matrix");
  return out;
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

export interface PollReport { email: number; sms: number; matrix: number; unknown: number }

/** One inbound sweep across every configured channel. Best-effort per channel. */
export async function pollInbox(t: Transports): Promise<PollReport> {
  const report: PollReport = { email: 0, sms: 0, matrix: 0, unknown: 0 };

  // --- email: match by sender address; every mail lands in the inbox too ---
  try {
    for (const m of await t.fetchEmail()) {
      const addr = extractEmail(m.from || "");
      const c = findContactByEmail(addr);
      const at = m.dateTime || new Date().toISOString();
      const extId = m.messageId ? `email:${m.messageId}` : (m.uid ? `email:${m.uid}@${addr}` : null);
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
      } else if (addr.includes("@")) {
        upsertInbox({
          from_email: addr, from_name: extractName(m.from || ""), subject: m.subject || "",
          body: m.body || m.snippet, at, external_id: extId,
        });
        upsertUnknown("email", addr, "", m.body || m.snippet, at);
        report.unknown++;
      }
    }
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
        if (ctx?.snippet) out.push({ number: h.number, name: h.name, body: ctx.snippet, at: new Date().toISOString(), messageId: "" });
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
  };
}
