// outpost — SQLite store. No contact caps, no groups: one unified
// conversation per contact, every channel condensed into a single thread.

import { Database } from "bun:sqlite";

const DATA_DIR = process.env.OUTPOST_DATA || new URL("../data/", import.meta.url).pathname;

let db: Database;

export interface Contact {
  id: string; name: string; email: string; phone: string; matrix_id: string;
  notes: string; starred: number; archived: number; created_at: string;
}
export interface Conversation {
  id: string; contact_id: string; archived: number; created_at: string; last_at: string;
}
export type Channel = "email" | "sms" | "matrix";
export interface Message {
  id: string; conversation_id: string; channel: Channel; direction: "in" | "out";
  body: string; subject: string; external_id: string; created_at: string; read: number;
}
export interface UnknownSender {
  id: string; channel: Channel; handle: string; name: string;
  last_body: string; last_at: string; count: number;
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
export const nowIso = () => new Date().toISOString();

export function openDb(path?: string): Database {
  const p = path || `${DATA_DIR}/outpost.db`;
  const { mkdirSync } = require("node:fs");
  const { dirname } = require("node:path");
  try { mkdirSync(dirname(p), { recursive: true }); } catch {}
  db = new Database(p, { create: true });
  db.exec(`PRAGMA journal_mode = WAL;`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '', matrix_id TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '', starred INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, contact_id TEXT NOT NULL UNIQUE,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, last_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
      channel TEXT NOT NULL, direction TEXT NOT NULL,
      body TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '',
      external_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
      read INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_external ON messages(external_id)
      WHERE external_id != '';
    CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);
    CREATE TABLE IF NOT EXISTS unknown_senders (
      id TEXT PRIMARY KEY, channel TEXT NOT NULL, handle TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '', last_body TEXT NOT NULL DEFAULT '',
      last_at TEXT NOT NULL DEFAULT '', count INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      UNIQUE(channel, handle)
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT ''
    );
  `);
  return db;
}

export function getDb(): Database {
  if (!db) openDb();
  return db;
}

// ---------- settings (channel credentials live here; never leave the server) ----------
export function getSetting(key: string): string {
  const r = getDb().query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
  return r?.value || "";
}
export function setSetting(key: string, value: string): void {
  getDb().query("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
export function publicSettings(): Record<string, boolean> {
  // booleans only — secrets never leave the server
  return {
    email_configured: !!(getSetting("imap_host") && getSetting("imap_user")),
    sms_configured: !!(getSetting("smtp_host") && getSetting("imap_host")),
    matrix_configured: !!(getSetting("matrix_homeserver") && getSetting("matrix_token")),
  };
}

// ---------- contacts ----------
const normEmail = (e: string) => e.trim().toLowerCase();
const normPhone = (p: string) => p.replace(/\D/g, "").replace(/^1(\d{10})$/, "$1");

export function listContacts(includeArchived = false): Contact[] {
  return getDb().query(
    `SELECT * FROM contacts ${includeArchived ? "" : "WHERE archived = 0"} ORDER BY starred DESC, name COLLATE NOCASE`
  ).all() as Contact[];
}
export function getContact(id: string): Contact | null {
  return (getDb().query("SELECT * FROM contacts WHERE id = ?").get(id) as Contact) || null;
}
export function findContactByEmail(email: string): Contact | null {
  const e = normEmail(email);
  if (!e) return null;
  return (getDb().query("SELECT * FROM contacts WHERE lower(email) = ? AND archived = 0").get(e) as Contact) || null;
}
export function findContactByPhone(phone: string): Contact | null {
  const p = normPhone(phone);
  if (!p) return null;
  return (getDb().query("SELECT * FROM contacts WHERE phone = ? AND archived = 0").get(p) as Contact) || null;
}
export function findContactByMatrixId(mid: string): Contact | null {
  const m = mid.trim().toLowerCase();
  if (!m) return null;
  return (getDb().query("SELECT * FROM contacts WHERE lower(matrix_id) = ? AND archived = 0").get(m) as Contact) || null;
}
export function createContact(c: { name: string; email?: string; phone?: string; matrix_id?: string; notes?: string }): Contact {
  const id = uid();
  const row: Contact = {
    id, name: c.name.trim() || "Unnamed", email: normEmail(c.email || ""),
    phone: normPhone(c.phone || ""), matrix_id: (c.matrix_id || "").trim(),
    notes: c.notes || "", starred: 0, archived: 0, created_at: nowIso(),
  };
  getDb().query(
    "INSERT INTO contacts(id, name, email, phone, matrix_id, notes, starred, archived, created_at) VALUES(?,?,?,?,?,?,?,?,?)"
  ).run(row.id, row.name, row.email, row.phone, row.matrix_id, row.notes, 0, 0, row.created_at);
  return row;
}
export function updateContact(id: string, patch: Partial<Pick<Contact, "name" | "email" | "phone" | "matrix_id" | "notes" | "starred" | "archived">>): Contact | null {
  const cur = getContact(id);
  if (!cur) return null;
  const next = {
    name: patch.name?.trim() || cur.name,
    email: patch.email != null ? normEmail(patch.email) : cur.email,
    phone: patch.phone != null ? normPhone(patch.phone) : cur.phone,
    matrix_id: patch.matrix_id != null ? patch.matrix_id.trim() : cur.matrix_id,
    notes: patch.notes ?? cur.notes,
    starred: patch.starred ?? cur.starred,
    archived: patch.archived ?? cur.archived,
  };
  getDb().query("UPDATE contacts SET name=?, email=?, phone=?, matrix_id=?, notes=?, starred=?, archived=? WHERE id=?")
    .run(next.name, next.email, next.phone, next.matrix_id, next.notes, next.starred, next.archived, id);
  return getContact(id);
}

// ---------- conversations (one per contact — the unified thread) ----------
export function conversationFor(contactId: string): Conversation {
  const d = getDb();
  let c = d.query("SELECT * FROM conversations WHERE contact_id = ?").get(contactId) as Conversation | null;
  if (!c) {
    c = { id: uid(), contact_id: contactId, archived: 0, created_at: nowIso(), last_at: "" };
    d.query("INSERT INTO conversations(id, contact_id, archived, created_at, last_at) VALUES(?,?,?,?,?)")
      .run(c.id, c.contact_id, 0, c.created_at, c.last_at);
  }
  return c;
}
export interface ConversationRow extends Conversation {
  contact_name: string; contact_starred: number;
  last_body: string; last_channel: string; last_direction: string; unread: number;
}
export function listConversations(): ConversationRow[] {
  return getDb().query(`
    SELECT c.*, ct.name AS contact_name, ct.starred AS contact_starred,
      (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_body,
      (SELECT channel FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_channel,
      (SELECT direction FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_direction,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'in' AND m.read = 0) AS unread
    FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
    WHERE c.archived = 0 AND ct.archived = 0
    ORDER BY ct.starred DESC, COALESCE(NULLIF(c.last_at, ''), c.created_at) DESC
  `).all() as ConversationRow[];
}
export function markRead(conversationId: string): void {
  getDb().query("UPDATE messages SET read = 1 WHERE conversation_id = ? AND direction = 'in'").run(conversationId);
}

// ---------- messages ----------
export function addMessage(m: {
  conversation_id: string; channel: Channel; direction: "in" | "out";
  body: string; subject?: string; external_id?: string; created_at?: string;
}): Message | null {
  const ext = m.external_id || "";
  if (ext) {
    const dup = getDb().query("SELECT id FROM messages WHERE external_id = ?").get(ext);
    if (dup) return null; // dedupe — already have it
  }
  const row: Message = {
    id: uid(), conversation_id: m.conversation_id, channel: m.channel, direction: m.direction,
    body: m.body, subject: m.subject || "", external_id: ext,
    created_at: m.created_at || nowIso(), read: m.direction === "out" ? 1 : 0,
  };
  getDb().query(
    "INSERT INTO messages(id, conversation_id, channel, direction, body, subject, external_id, created_at, read) VALUES(?,?,?,?,?,?,?,?,?)"
  ).run(row.id, row.conversation_id, row.channel, row.direction, row.body, row.subject, row.external_id, row.created_at, row.read);
  getDb().query("UPDATE conversations SET last_at = ? WHERE id = ?").run(row.created_at, row.conversation_id);
  return row;
}
export function listMessages(conversationId: string, limit = 200): Message[] {
  return getDb().query(
    "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?"
  ).all(conversationId, limit) as Message[];
}
export function totalUnread(): number {
  const r = getDb().query(
    "SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contacts ct ON ct.id = c.contact_id WHERE m.direction = 'in' AND m.read = 0 AND c.archived = 0 AND ct.archived = 0"
  ).get() as { n: number };
  return r.n;
}

// ---------- unknown senders (the "new" bucket) ----------
export function upsertUnknown(channel: Channel, handle: string, name: string, body: string, at: string): UnknownSender {
  const d = getDb();
  const h = handle.trim().toLowerCase();
  let u = d.query("SELECT * FROM unknown_senders WHERE channel = ? AND handle = ?").get(channel, h) as UnknownSender | null;
  if (u) {
    d.query("UPDATE unknown_senders SET last_body = ?, last_at = ?, count = count + 1, name = CASE WHEN name = '' THEN ? ELSE name END WHERE id = ?")
      .run(body.slice(0, 280), at, name, u.id);
    u = d.query("SELECT * FROM unknown_senders WHERE id = ?").get(u.id) as UnknownSender;
  } else {
    u = { id: uid(), channel, handle: h, name, last_body: body.slice(0, 280), last_at: at, count: 1, created_at: nowIso() };
    d.query("INSERT INTO unknown_senders(id, channel, handle, name, last_body, last_at, count, created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(u.id, u.channel, u.handle, u.name, u.last_body, u.last_at, u.count, u.created_at);
  }
  return u!;
}
export function listUnknown(): UnknownSender[] {
  return getDb().query("SELECT * FROM unknown_senders ORDER BY last_at DESC").all() as UnknownSender[];
}
export function promoteUnknown(id: string, name: string): Contact | null {
  const u = getDb().query("SELECT * FROM unknown_senders WHERE id = ?").get(id) as UnknownSender | null;
  if (!u) return null;
  const c = createContact({
    name: name.trim() || u.name || u.handle,
    email: u.channel === "email" ? u.handle : "",
    phone: u.channel === "sms" ? u.handle : "",
    matrix_id: u.channel === "matrix" ? u.handle : "",
  });
  getDb().query("DELETE FROM unknown_senders WHERE id = ?").run(id);
  return c;
}
export function dismissUnknown(id: string): void {
  getDb().query("DELETE FROM unknown_senders WHERE id = ?").run(id);
}

/** Destructive: wipe every contact, conversation, message, and unknown sender.
 *  Channel settings (credentials etc.) are kept; per-contact matrix room
 *  mappings are dropped as orphans. */
export function clearAllContacts(): { contacts: number; conversations: number; messages: number; unknown: number } {
  const d = getDb();
  const count = (t: string) => (d.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  const cleared = {
    contacts: count("contacts"), conversations: count("conversations"),
    messages: count("messages"), unknown: count("unknown_senders"),
  };
  d.exec("DELETE FROM messages; DELETE FROM conversations; DELETE FROM contacts; DELETE FROM unknown_senders;");
  d.exec("DELETE FROM settings WHERE key LIKE 'matrix_room:%'");
  return cleared;
}
