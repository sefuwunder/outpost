// outpost — channel orchestration: outbound routing + inbound polling.
// Transports are injected so tests can stub them; server.ts wires the real ones.

import {
  getContact, conversationFor, addMessage, findContactByEmail, findContactByPhone,
  findContactByMatrixId, findContactByE2EE, upsertUnknown, upsertInbox, getSetting, setSetting,
  getE2EEState, setE2EEState, delE2EEState, getDb,
  type Channel, type Contact,
} from "./db";
import { extractEmail, gvNumberFrom, stripGvFooter, type UnseenMail, type ImapConfig, type SentMailItem } from "./imap";
import type { SmtpConfig } from "./smtp";
import type { RunFn } from "./goa";

export interface Transports {
  /** Sends an email; resolves with the wire Message-ID (for Sent dedupe).
   *  fromAccountId selects the GOA account (multi-account); defaults to send-from. */
  sendEmail(to: string, subject: string, text: string, fromAccountId?: string): Promise<{ messageId: string }>;
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
      // Multi-account: reply from the account that received the latest inbound
      // email in this thread, so the From matches what the contact wrote to.
      const fromAccountId = emailProvider() === "goa" ? replyFromAccount(c.id) : undefined;
      const { messageId } = await t.sendEmail(c.email, "", text, fromAccountId);
      const conv = conversationFor(c.id);
      // File under the wire Message-ID so the Sent-folder import dedupes
      // against this record instead of showing the message twice.
      const m = addMessage({
        conversation_id: conv.id, channel, direction: "out", body: text,
        external_id: `email:${messageId}`, subject: "", via: fromAccountId || "",
      });
      return { ok: true, messageId: m!.id };
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

/**
 * Which GOA account to reply from for a contact: the account that received
 * the latest inbound email in their thread. Falls back to the configured
 * send-from default (first account).
 */
export function replyFromAccount(contactId: string): string | undefined {
  try {
    const conv = conversationFor(contactId);
    const row = getDb().query(
      `SELECT via FROM messages WHERE conversation_id = ? AND channel = 'email'
       AND direction = 'in' AND via != '' ORDER BY created_at DESC LIMIT 1`
    ).get(conv.id) as { via: string } | null;
    if (row?.via && goaAccountIds().includes(row.via)) return row.via;
  } catch { /* fall through to default */ }
  return goaSendFromId() || undefined;
}

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
      created_at: at, via: m.viaAccount || "",
    });
    if (added) {
      upsertInbox({
        from_email: addr, from_name: extractName(m.from || ""), subject: m.subject || "",
        body: m.body || m.snippet, html_body: m.html || "", at, external_id: extId,
        contact_id: c.id, message_id: added.id,
      });
      report.email++;
    }
  } else {
    upsertInbox({
      from_email: addr, from_name: extractName(m.from || ""), subject: m.subject || "",
      body: m.body || m.snippet, html_body: m.html || "", at, external_id: extId,
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

/**
 * Ingest one Sent-folder item: the server-side copy of mail we (or another
 * client) sent. Dedupes against the local outbox record via Message-ID, so
 * a message sent from outpost appears once, not twice.
 */
export function ingestSentEmail(m: SentMailItem, report: PollReport, viaAccount = ""): void {
  const extId = m.messageId ? `email:${m.messageId}` : `email:sent-uid-${m.uid}`;
  const toAddr = (m.to || []).map((a) => a.toLowerCase().trim()).find((a) => a.includes("@")) || "";
  if (!toAddr) return;
  const c = findContactByEmail(toAddr);
  if (!c) return; // recipient isn't a contact — nothing to thread into
  const conv = conversationFor(c.id);
  const added = addMessage({
    conversation_id: conv.id, channel: "email", direction: "out",
    body: m.body || "", subject: m.subject || "",
    external_id: extId, created_at: m.dateTime || m.date || new Date().toISOString(),
    via: viaAccount,
  });
  if (added) report.email++;
}

/** One-time backfill: recent mail regardless of \Seen, into the inbox.
 *  Read-only on the server (no flags touched). Bounded by limit. */
export async function backfillInbox(days = 30, limit = 500, secure = true): Promise<PollReport> {
  const imap = require("./imap") as typeof import("./imap");
  if (!emailReady())
    throw new Error("email not configured — add it in ⚙️ Channels first");
  const report: PollReport = { email: 0, sms: 0, matrix: 0, encrypted: 0, unknown: 0 };
  if (emailProvider() === "goa") {
    // Multi-account: backfill each configured account, tagged for reply routing.
    const resolved = await goaAccountsOrThrow().catch(() => [] as GoaResolved[]);
    for (const r of resolved) {
      try {
        const cfg = { ...goaResolvedImapConfig(r), secure };
        for (const m of await imap.fetchRecent(cfg, days, limit, "INBOX")) {
          ingestEmail({ ...m, viaAccount: r.acct.id }, report);
        }
      } catch { /* account down — next time */ }
    }
    return report;
  }
  const cfg = { ...(await emailImapConfig()), secure };
  for (const m of await imap.fetchRecent(cfg, days, limit, "INBOX")) ingestEmail(m, report);
  return report;
}

/** Email provider: "manual" IMAP/SMTP settings, or "goa" for GNOME Online Accounts. */
export function emailProvider(): "manual" | "goa" {
  return getSetting("email_provider") === "goa" ? "goa" : "manual";
}

/**
 * True when the provider saves SMTP-sent mail to Sent itself (Geary sets
 * save_sent=false for these): Gmail and Outlook/Office365 both do. For every
 * other provider outpost APPENDs the sent message to Sent itself.
 * Pass the GOA account id being sent from; defaults to the cached/first type.
 */
export function providerAutoSavesSent(accountId?: string | null): boolean {
  if (emailProvider() === "goa") {
    let pt = "";
    if (accountId) {
      // Best-effort: resolve the account's provider type without credentials.
      try {
        const ids = goaAccountIds();
        if (ids.includes(accountId)) {
          // The type was cached at resolve time per send; fall back to settings.
          pt = getSetting(`goa_provider_type:${accountId}`) || getSetting("goa_provider_type") || "";
        }
      } catch { /* fall through */ }
    } else {
      pt = getSetting("goa_provider_type") || "";
    }
    pt = pt.toLowerCase();
    return pt === "google" || pt === "windows_live" || pt.includes("outlook") || pt.includes("microsoft");
  }
  const hosts = `${getSetting("imap_host") || ""} ${getSetting("smtp_host") || ""}`.toLowerCase();
  return /gmail|googlemail|outlook|office365|hotmail|live\.com/.test(hosts);
}

/** True when the email channel can be used. */
export function emailReady(): boolean {
  if (emailProvider() === "goa") return goaAccountIds().length > 0;
  return !!(getSetting("imap_host") && getSetting("imap_user"));
}

/**
 * Configured GOA account ids. Canonical store is `goa_accounts` (JSON array);
 * a legacy single `goa_account` is migrated on first read.
 */
export function goaAccountIds(): string[] {
  const raw = getSetting("goa_accounts");
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.filter((x) => typeof x === "string" && x);
    } catch { /* fall through to migration */ }
  }
  const legacy = getSetting("goa_account");
  if (legacy) {
    try { setSetting("goa_accounts", JSON.stringify([legacy])); } catch { /* non-fatal */ }
    try { setSetting("goa_account", ""); } catch { /* non-fatal */ }
    return [legacy];
  }
  return [];
}

/** Default account for sending (explicit choice, else the first configured). */
export function goaSendFromId(): string | null {
  const ids = goaAccountIds();
  if (!ids.length) return null;
  const explicit = getSetting("goa_send_from");
  if (explicit && ids.includes(explicit)) return explicit;
  return ids[0];
}

export interface GoaResolved { acct: import("./goa").GoaMailAccount; creds: import("./goa").GoaCredentials; goa: typeof import("./goa"); }

/** Resolve every configured GOA account to live credentials. Throws when none are usable. */
export async function goaAccountsOrThrow(run?: RunFn): Promise<GoaResolved[]> {
  const goa = await import("./goa");
  const ids = goaAccountIds();
  if (!ids.length) throw new Error("GNOME Online Accounts selected but no accounts chosen — pick them in ⚙️ Channels");
  const available = await goa.listGoaMailAccounts(run);
  const out: GoaResolved[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const acct = available.find((a) => a.id === id);
    if (!acct) { missing.push(id); continue; }
    out.push({ acct, creds: await goa.getGoaCredentials(acct, run), goa });
  }
  if (!out.length) {
    throw new Error(`None of the configured GNOME accounts are available (${missing.join(", ") || "none configured"}) — are they still enabled for Mail?`);
  }
  // Cache provider types for providerAutoSavesSent() (Gmail/Outlook auto-save sent mail).
  for (const r of out) {
    try { setSetting(`goa_provider_type:${r.acct.id}`, r.acct.providerType || ""); } catch { /* non-fatal */ }
  }
  try { setSetting("goa_provider_type", out[0].acct.providerType || ""); } catch { /* non-fatal */ }
  return out;
}

/** Resolve one GOA account by id (defaults to the send-from account). */
export async function goaAccountOrThrow(accountId?: string | null, run?: RunFn): Promise<GoaResolved> {
  const all = await goaAccountsOrThrow(run);
  const want = accountId || goaSendFromId();
  const hit = all.find((r) => r.acct.id === want);
  if (hit) return hit;
  // Requested id vanished mid-flight — fall back to the first working one.
  return all[0];
}

/** IMAP config for an already-resolved GOA account (no re-resolution). */
export function goaResolvedImapConfig(r: GoaResolved): ImapConfig {
  const c = r.goa.goaImapCfg(r.acct);
  return {
    host: c.host, port: c.port, user: r.creds.user,
    pass: r.creds.imapPassword || "",
    xoauth2Token: r.creds.oauth2 ? r.creds.token : undefined,
    secure: c.secure,
  };
}

/** SMTP config for an already-resolved GOA account (no re-resolution). */
export function goaResolvedSmtpConfig(r: GoaResolved): SmtpConfig {
  const c = r.goa.goaSmtpCfg(r.acct);
  return {
    host: c.host, port: c.port, user: r.creds.user,
    pass: r.creds.smtpPassword || "",
    xoauth2Token: r.creds.oauth2 ? r.creds.token : undefined,
    from: r.acct.email, secure: c.secure,
  };
}

/** IMAP config from the active email provider (manual settings or GOA).
 *  First arg is a GOA account id, or a RunFn for tests (legacy position). */
export async function emailImapConfig(accountId?: string | null | RunFn, run?: RunFn): Promise<ImapConfig> {
  if (typeof accountId === "function") { run = accountId; accountId = null; }
  if (emailProvider() === "goa") {
    const { acct, creds, goa } = await goaAccountOrThrow(accountId, run);
    const c = goa.goaImapCfg(acct);
    return {
      host: c.host, port: c.port, user: creds.user,
      pass: creds.imapPassword || "",
      xoauth2Token: creds.oauth2 ? creds.token : undefined,
      secure: c.secure,
    };
  }
  return {
    host: getSetting("imap_host"), port: Number(getSetting("imap_port") || 993),
    user: getSetting("imap_user"), pass: getSetting("imap_pass"),
  };
}

/** SMTP config from the active email provider (manual settings or GOA).
 *  First arg is a GOA account id, or a RunFn for tests (legacy position). */
export async function emailSmtpConfig(accountId?: string | null | RunFn, run?: RunFn): Promise<SmtpConfig> {
  const smtp = require("./smtp") as typeof import("./smtp");
  if (typeof accountId === "function") { run = accountId; accountId = null; }
  if (emailProvider() === "goa") {
    const { acct, creds, goa } = await goaAccountOrThrow(accountId, run);
    const c = goa.goaSmtpCfg(acct);
    return {
      host: c.host, port: c.port, user: creds.user,
      pass: creds.smtpPassword || "",
      xoauth2Token: creds.oauth2 ? creds.token : undefined,
      from: acct.email, secure: c.secure,
    };
  }
  const port = Number(getSetting("smtp_port") || 587);
  return {
    host: getSetting("smtp_host"), port,
    user: getSetting("smtp_user"), pass: getSetting("smtp_pass"),
    from: getSetting("smtp_from") || getSetting("imap_user"),
    secure: smtp.smtpSecureMode(getSetting("smtp_secure"), port),
  };
}

/** One inbound sweep across every configured channel. Best-effort per channel. */
export async function pollInbox(t: Transports): Promise<PollReport> {
  const report: PollReport = { email: 0, sms: 0, matrix: 0, encrypted: 0, unknown: 0 };

  // --- email: UNSEEN only; the backfill covers already-read mail ---
  try {
    for (const m of await t.fetchEmail()) ingestEmail(m, report);
  } catch { /* channel down — next sweep */ }

  // --- sent mail: new items in the Sent folder (per-account UID watermark).
  // This is the other half of outbox sync: mail sent from outpost is APPENDed
  // to Sent at send time, and mail sent from other clients (phone/webmail)
  // shows up here. Dedupes against local outbox records by Message-ID. ---
  try {
    if (emailReady()) {
      const imap = require("./imap") as typeof import("./imap");
      // One config per account: manual → single; GOA → every configured account.
      const cfgs: Array<{ cfg: ImapConfig; wmKey: string; accountId: string }> = [];
      if (emailProvider() === "goa") {
        const resolved = await goaAccountsOrThrow().catch(() => [] as GoaResolved[]);
        for (const r of resolved) {
          cfgs.push({ cfg: goaResolvedImapConfig(r), wmKey: `sent_last_uid:${r.acct.id}`, accountId: r.acct.id });
        }
      } else {
        cfgs.push({ cfg: await emailImapConfig(), wmKey: "sent_last_uid", accountId: "" });
      }
      for (const { cfg, wmKey, accountId } of cfgs) {
        try {
          // Legacy single-account watermark migrates forward automatically:
          // the first per-account run picks up where the old global one left off.
          const legacy = wmKey !== "sent_last_uid" ? Number(getSetting("sent_last_uid") || 0) : 0;
          const lastUid = Number(getSetting(wmKey) || legacy || 0) || null;
          const { items, maxUid } = await imap.fetchSentMail(cfg, lastUid, { backfillDays: 90, max: 200 });
          for (const it of items) ingestSentEmail(it, report, accountId);
          if (maxUid !== null && Number.isFinite(maxUid)) setSetting(wmKey, String(maxUid));
        } catch { /* account down — next sweep */ }
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

  const matrixCfg = () => ({
    homeserver: getSetting("matrix_homeserver"),
    token: getSetting("matrix_token"),
    userId: getSetting("matrix_user_id"),
  });

  return {
    sendEmail: async (to, subject, text, fromAccountId?: string) => {
      const smtpCfg = await emailSmtpConfig(fromAccountId);
      const messageId = smtp.newMessageId();
      // Build once: the byte-identical message goes over SMTP and (below)
      // into the Sent folder, like Geary's save_sent_mail.
      const raw = smtp.buildMessage(smtpCfg, { to: [to], subject: subject || "outpost", text, messageId });
      await smtp.sendRawMail(smtpCfg, [to], raw);
      // Keep the server's Sent folder in sync — providers that don't
      // auto-save SMTP mail would otherwise never show it. Best-effort:
      // the local outbox record already exists, so a failed APPEND only
      // delays the server-side copy until the next successful send.
      if (!providerAutoSavesSent(fromAccountId)) {
        try {
          await imap.appendToSent(await emailImapConfig(fromAccountId), raw);
        } catch (e: any) {
          console.warn(`[outpost] Sent APPEND failed (best-effort): ${e?.message || e}`);
        }
      }
      return { messageId };
    },
    sendSms: async (digits, text) => {
      await smtp.sendMail(await emailSmtpConfig(), { to: [smtp.gvGatewayAddress(digits)], subject: "outpost", text });
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
      if (!emailReady()) return [];
      if (emailProvider() !== "goa") {
        return imap.fetchUnseen(await emailImapConfig(), 50, "INBOX", 4000);
      }
      // Multi-account: UNSEEN from every configured GOA account, each tagged
      // with the account it arrived on (for reply routing).
      const resolved = await goaAccountsOrThrow().catch(() => [] as GoaResolved[]);
      const out: UnseenMail[] = [];
      for (const r of resolved) {
        try {
          const msgs = await imap.fetchUnseen(goaResolvedImapConfig(r), 50, "INBOX", 4000);
          for (const m of msgs) out.push({ ...m, viaAccount: r.acct.id });
        } catch { /* account down — next sweep */ }
      }
      return out;
    },
    fetchSms: async () => {
      if (!emailReady()) return [];
      const icfg = await emailImapConfig();
      const harvest = await imap.harvestRecentSms(icfg, 2);
      const out: Array<{ number: string; name: string; body: string; at: string; messageId: string }> = [];
      // One connection for all conversations (was: one per conversation).
      const ctxs = await imap.latestEmailWithMany(
        icfg, harvest.conversations.map((h) => `${h.number}@txt.voice.google.com`), 1500
      ).catch(() => new Map());
      for (const h of harvest.conversations) {
        const ctx = ctxs.get(`${h.number}@txt.voice.google.com`);
        // Dedupe-safe: the real message-id lets addMessage skip forwards that
        // ingestEmail already filed as SMS.
        if (ctx?.body) out.push({ number: h.number, name: h.name, body: stripGvFooter(ctx.body).trim() || "(empty SMS)", at: ctx.dateTime || ctx.date || new Date().toISOString(), messageId: ctx.messageId || "" });
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
