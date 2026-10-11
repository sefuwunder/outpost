// outpost — SQLite store. No contact caps, no groups: one unified
// conversation per contact, every channel condensed into a single thread.

import { Database } from "bun:sqlite";

const DATA_DIR = process.env.OUTPOST_DATA || new URL("../data/", import.meta.url).pathname;

let db: Database;

export interface Contact {
  id: string; name: string; email: string; phone: string; matrix_id: string;
  e2ee_handle: string;
  notes: string; starred: number; archived: number; created_at: string;
}
export interface Conversation {
  id: string; contact_id: string; archived: number; created_at: string; last_at: string;
}
export type Channel = "email" | "sms" | "matrix" | "encrypted";
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
      e2ee_handle TEXT NOT NULL DEFAULT '',
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
    CREATE TABLE IF NOT EXISTS triage (
      message_id TEXT PRIMARY KEY, category TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS nudges (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, dedupe TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL DEFAULT '', contact_id TEXT NOT NULL DEFAULT '',
      message_id TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, snoozed_until INTEGER NOT NULL DEFAULT 0,
      dismissed INTEGER NOT NULL DEFAULT 0
    );
    -- jev-style local decision model: online naive bayes counts
    CREATE TABLE IF NOT EXISTS jev_feat (
      feature TEXT NOT NULL, class TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (feature, class)
    );
    CREATE TABLE IF NOT EXISTS jev_cls (
      class TEXT PRIMARY KEY, docs INTEGER NOT NULL DEFAULT 0, feats INTEGER NOT NULL DEFAULT 0
    );
    -- per nudge-kind outcomes: what the user acted on vs dismissed
    CREATE TABLE IF NOT EXISTS jev_nudge_fb (
      kind TEXT PRIMARY KEY, acted INTEGER NOT NULL DEFAULT 0, dismissed INTEGER NOT NULL DEFAULT 0
    );
    -- inbox: every inbound email, contact or not (the 30-day home view)
    CREATE TABLE IF NOT EXISTS inbox (
      id TEXT PRIMARY KEY, from_email TEXT NOT NULL DEFAULT '', from_name TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', at TEXT NOT NULL,
      external_id TEXT UNIQUE, contact_id TEXT NOT NULL DEFAULT '', message_id TEXT NOT NULL DEFAULT '',
      read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    -- user training rules: explicit sender/domain → category overrides
    CREATE TABLE IF NOT EXISTS triage_rules (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, pattern TEXT NOT NULL,
      category TEXT NOT NULL, created_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'user',
      UNIQUE(scope, pattern)
    );
    -- E2EE client state: private keys + sessions. Never exposed via the API.
    CREATE TABLE IF NOT EXISTS e2ee_state (
      key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT ''
    );
  `);
  // Migration: contacts.e2ee_handle (older DBs lack the column).
  const contactCols = db.query("PRAGMA table_info(contacts)").all() as { name: string }[];
  if (!contactCols.some((c) => c.name === "e2ee_handle")) {
    db.exec("ALTER TABLE contacts ADD COLUMN e2ee_handle TEXT NOT NULL DEFAULT ''");
  }
  // Migration: triage_rules.source (older DBs lack the column).
  const ruleCols = db.query("PRAGMA table_info(triage_rules)").all() as { name: string }[];
  if (!ruleCols.some((c) => c.name === "source")) {
    db.exec("ALTER TABLE triage_rules ADD COLUMN source TEXT NOT NULL DEFAULT 'user'");
  }
  // Migration: triage confidence/source/evidence (older DBs lack the columns).
  const triCols = db.query("PRAGMA table_info(triage)").all() as { name: string }[];
  for (const [col, def] of [["confidence", "REAL NOT NULL DEFAULT 0"], ["source", "TEXT NOT NULL DEFAULT 'rules'"], ["evidence", "TEXT NOT NULL DEFAULT ''"]] as Array<[string, string]>) {
    if (!triCols.some((c) => c.name === col)) db.exec(`ALTER TABLE triage ADD COLUMN ${col} ${def}`);
  }
  // Backfill inbox from existing email messages + unknown senders (once).
  const inbCount = (db.query("SELECT COUNT(*) AS n FROM inbox").get() as { n: number }).n;
  if (inbCount === 0) {
    db.exec(`
      INSERT OR IGNORE INTO inbox(id, from_email, from_name, subject, body, at, external_id, contact_id, message_id, read, created_at)
      SELECT 'inb_' || m.id, COALESCE(ct.email, ''), COALESCE(ct.name, ''), COALESCE(m.subject, ''), COALESCE(m.body, ''),
        m.created_at, CASE WHEN COALESCE(m.external_id, '') = '' THEN NULL ELSE m.external_id END,
        c.contact_id, m.id, COALESCE(m.read, 0), m.created_at
      FROM messages m JOIN conversations c ON c.id = m.conversation_id
      LEFT JOIN contacts ct ON ct.id = c.contact_id
      WHERE m.channel = 'email';
    `);
    db.exec(`
      INSERT OR IGNORE INTO inbox(id, from_email, from_name, subject, body, at, external_id, contact_id, message_id, read, created_at)
      SELECT 'inb_unk_' || u.id, u.handle, COALESCE(u.name, ''), '', COALESCE(u.last_body, ''),
        u.last_at, NULL, '', '', 0, u.last_at
      FROM unknown_senders u WHERE u.channel = 'email';
    `);
  }
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
    e2ee_configured: !!((getSetting("e2ee_url") || getSetting("e2ee_token")) && getSetting("e2ee_handle")),
    llm_configured: getSetting("llm_enabled") === "1",
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
export function createContact(c: { name: string; email?: string; phone?: string; matrix_id?: string; e2ee_handle?: string; notes?: string }): Contact {
  const id = uid();
  const row: Contact = {
    id, name: c.name.trim() || "Unnamed", email: normEmail(c.email || ""),
    phone: normPhone(c.phone || ""), matrix_id: (c.matrix_id || "").trim(),
    e2ee_handle: (c.e2ee_handle || "").toLowerCase().trim(),
    notes: c.notes || "", starred: 0, archived: 0, created_at: nowIso(),
  };
  getDb().query(
    "INSERT INTO contacts(id, name, email, phone, matrix_id, e2ee_handle, notes, starred, archived, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)"
  ).run(row.id, row.name, row.email, row.phone, row.matrix_id, row.e2ee_handle, row.notes, 0, 0, row.created_at);
  return row;
}
export function updateContact(id: string, patch: Partial<Pick<Contact, "name" | "email" | "phone" | "matrix_id" | "e2ee_handle" | "notes" | "starred" | "archived">>): Contact | null {
  const cur = getContact(id);
  if (!cur) return null;
  const next = {
    name: patch.name?.trim() || cur.name,
    email: patch.email != null ? normEmail(patch.email) : cur.email,
    phone: patch.phone != null ? normPhone(patch.phone) : cur.phone,
    matrix_id: patch.matrix_id != null ? patch.matrix_id.trim() : cur.matrix_id,
    e2ee_handle: patch.e2ee_handle != null ? patch.e2ee_handle.toLowerCase().trim() : cur.e2ee_handle,
    notes: patch.notes ?? cur.notes,
    starred: patch.starred ?? cur.starred,
    archived: patch.archived ?? cur.archived,
  };
  getDb().query("UPDATE contacts SET name=?, email=?, phone=?, matrix_id=?, e2ee_handle=?, notes=?, starred=?, archived=? WHERE id=?")
    .run(next.name, next.email, next.phone, next.matrix_id, next.e2ee_handle, next.notes, next.starred, next.archived, id);
  return getContact(id);
}

/** Find a contact by their E2EE handle (case-insensitive). */
export function findContactByE2EE(handle: string): Contact | null {
  const h = (handle || "").toLowerCase().trim();
  if (!h) return null;
  return (getDb().query("SELECT * FROM contacts WHERE lower(e2ee_handle) = ? AND archived = 0").get(h) as Contact) || null;
}

/** Private KV store for the E2EE client's keys/sessions. Never API-exposed. */
export function getE2EEState(key: string): string | null {
  const r = getDb().query("SELECT value FROM e2ee_state WHERE key = ?").get(key) as { value: string } | null;
  return r ? r.value : null;
}
export function setE2EEState(key: string, value: string): void {
  getDb().query("INSERT INTO e2ee_state(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
export function delE2EEState(key: string): void {
  getDb().query("DELETE FROM e2ee_state WHERE key = ?").run(key);
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
  category: TriageCategory; last_email_msg: string | null;
}
export function listConversations(): ConversationRow[] {
  return getDb().query(`
    SELECT c.*, ct.name AS contact_name, ct.starred AS contact_starred,
      (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_body,
      (SELECT channel FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_channel,
      (SELECT direction FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_direction,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'in' AND m.read = 0) AS unread,
      COALESCE((SELECT t.category FROM messages m LEFT JOIN triage t ON t.message_id = m.id
        WHERE m.conversation_id = c.id AND m.channel = 'email' ORDER BY m.created_at DESC LIMIT 1), 'personal') AS category,
      (SELECT m.id FROM messages m WHERE m.conversation_id = c.id AND m.channel = 'email' ORDER BY m.created_at DESC LIMIT 1) AS last_email_msg
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

// ---------- inbox: 30-day agent-organized email home ----------
export interface InboxRow {
  id: string; from_email: string; from_name: string; subject: string; body: string;
  at: string; external_id: string | null; contact_id: string; message_id: string;
  read: number; category: TriageCategory;
}

/** Insert an inbound email; dedupe by external_id. Returns the row id. */
export function upsertInbox(e: {
  from_email: string; from_name?: string; subject?: string; body?: string; at: string;
  external_id?: string | null; contact_id?: string; message_id?: string;
}): string {
  const d = getDb();
  const ext = e.external_id || null;
  if (ext) {
    const existing = d.query("SELECT id FROM inbox WHERE external_id = ?").get(ext) as { id: string } | null;
    if (existing) {
      // link late-arriving contact/message info
      if (e.contact_id || e.message_id) {
        d.query("UPDATE inbox SET contact_id = CASE WHEN ? != '' THEN ? ELSE contact_id END, message_id = CASE WHEN ? != '' THEN ? ELSE message_id END WHERE id = ?")
          .run(e.contact_id || "", e.contact_id || "", e.message_id || "", e.message_id || "", existing.id);
      }
      return existing.id;
    }
  }
  const id = "inb_" + uid();
  d.query("INSERT INTO inbox(id, from_email, from_name, subject, body, at, external_id, contact_id, message_id, read, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, e.from_email, e.from_name || "", e.subject || "", e.body || "", e.at, ext,
      e.contact_id || "", e.message_id || "", 0, nowIso());
  return id;
}

export function untriagedInbox(limit = 500): Array<{ id: string; from_email: string; subject: string; body: string; message_id: string }> {
  return getDb().query(`
    SELECT i.id, i.from_email, i.subject, i.body, i.message_id FROM inbox i
    LEFT JOIN triage t ON t.message_id = i.id
    WHERE t.message_id IS NULL ORDER BY i.at ASC LIMIT ?
  `).all(limit) as Array<{ id: string; from_email: string; subject: string; body: string; message_id: string }>;
}

const INBOX_WINDOW_DAYS = 30;

export function listInbox(): InboxRow[] {
  const since = new Date(Date.now() - INBOX_WINDOW_DAYS * 86400_000).toISOString();
  return getDb().query(`
    SELECT i.*, COALESCE(t.category, 'personal') AS category FROM inbox i
    LEFT JOIN triage t ON t.message_id = i.id
    WHERE i.at >= ? ORDER BY i.at DESC
  `).all(since) as InboxRow[];
}

export function getInbox(id: string): (InboxRow & { contact_name?: string }) | null {
  const r = getDb().query(`
    SELECT i.*, COALESCE(t.category, 'personal') AS category, ct.name AS contact_name FROM inbox i
    LEFT JOIN triage t ON t.message_id = i.id
    LEFT JOIN contacts ct ON ct.id = i.contact_id
    WHERE i.id = ?
  `).get(id) as any;
  return r || null;
}

export function setInboxRead(id: string, read: boolean): void {
  getDb().query("UPDATE inbox SET read = ? WHERE id = ?").run(read ? 1 : 0, id);
}

export function deleteInbox(id: string): void {
  const d = getDb();
  d.query("DELETE FROM triage WHERE message_id = ?").run(id);
  d.query("DELETE FROM inbox WHERE id = ?").run(id);
}

export function inboxUnread(): number {
  const since = new Date(Date.now() - INBOX_WINDOW_DAYS * 86400_000).toISOString();
  const r = getDb().query("SELECT COUNT(*) AS n FROM inbox WHERE at >= ? AND read = 0").get(since) as { n: number };
  return r.n;
}

/** Set triage on an id and mirror across a linked inbox/message pair. */
export function mirrorTriage(id: string, category: TriageCategory, reason: string, confidence: number, source: string, evidence: string): void {
  setTriage(id, category, reason, confidence, source, evidence);
  const d = getDb();
  const inb = d.query("SELECT message_id FROM inbox WHERE id = ?").get(id) as { message_id: string } | null;
  if (inb?.message_id) setTriage(inb.message_id, category, reason, confidence, source, evidence);
  const msg = d.query("SELECT id FROM inbox WHERE message_id = ?").get(id) as { id: string } | null;
  if (msg) setTriage(msg.id, category, reason, confidence, source, evidence);
}
// ---------- triage: deterministic email classification ----------
export type TriageCategory = "personal" | "newsletter" | "receipt" | "automated";

export function setTriage(messageId: string, category: TriageCategory, reason: string, confidence = 0, source = "rules", evidence = ""): void {
  getDb().query(
    "INSERT INTO triage(message_id, category, reason, created_at, confidence, source, evidence) VALUES(?,?,?,?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET category = excluded.category, reason = excluded.reason, confidence = excluded.confidence, source = excluded.source, evidence = excluded.evidence"
  ).run(messageId, category, reason, nowIso(), confidence, source, evidence);
}
export function getTriage(messageId: string): TriageCategory | null {
  const r = getDb().query("SELECT category FROM triage WHERE message_id = ?").get(messageId) as { category: string } | null;
  return (r?.category as TriageCategory) || null;
}
export function getTriageFull(messageId: string): { category: string; reason: string; confidence: number; source: string; evidence: string } | null {
  return (getDb().query("SELECT category, reason, confidence, source, evidence FROM triage WHERE message_id = ?").get(messageId) as any) || null;
}

// ---------- triage rules: user-trained sender/domain overrides ----------

export interface TriageRule {
  id: string; scope: "sender" | "domain"; pattern: string;
  category: TriageCategory; created_at: string; source: string;
}

/** Create or replace a rule. Patterns are lowercased; domains must be bare (no @). */
export function upsertTriageRule(scope: "sender" | "domain", pattern: string, category: TriageCategory, source = "user"): TriageRule {
  const p = (pattern || "").toLowerCase().trim().replace(/^@/, "");
  if (!p) throw new Error("rule pattern is required");
  const id = `trl_${scope}_${p.replace(/[^a-z0-9.]/g, "_")}`;
  getDb().query(
    "INSERT INTO triage_rules(id, scope, pattern, category, created_at, source) VALUES(?,?,?,?,?,?) ON CONFLICT(scope, pattern) DO UPDATE SET category = excluded.category, source = excluded.source"
  ).run(id, scope, p, category, nowIso(), source);
  return { id, scope, pattern: p, category, created_at: nowIso(), source };
}

/** Sender-exact match first, then domain. Null when no rule applies. */
export function matchTriageRule(email: string): TriageRule | null {
  const e = (email || "").toLowerCase().trim();
  if (!e) return null;
  const d = getDb();
  const sender = d.query("SELECT * FROM triage_rules WHERE scope = 'sender' AND pattern = ?").get(e) as TriageRule | null;
  if (sender) return sender;
  const domain = e.split("@")[1];
  if (domain) {
    const hit = d.query("SELECT * FROM triage_rules WHERE scope = 'domain' AND pattern = ?").get(domain) as TriageRule | null;
    if (hit) return hit;
  }
  return null;
}

export function listTriageRules(): TriageRule[] {
  return getDb().query("SELECT * FROM triage_rules ORDER BY created_at DESC").all() as TriageRule[];
}

export function deleteTriageRule(id: string): void {
  getDb().query("DELETE FROM triage_rules WHERE id = ?").run(id);
}
export function untriagedEmail(limit = 200): Array<{ id: string; from_email: string; subject: string; body: string }> {  return getDb().query(`
    SELECT m.id, ct.email AS from_email, m.subject, m.body
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    JOIN contacts ct ON ct.id = c.contact_id
    LEFT JOIN triage t ON t.message_id = m.id
    WHERE m.channel = 'email' AND m.direction = 'in' AND t.message_id IS NULL
    ORDER BY m.created_at ASC LIMIT ?
  `).all(limit) as Array<{ id: string; from_email: string; subject: string; body: string }>;
}

// ---------- nudges ----------
export interface Nudge {
  id: string; kind: string; dedupe: string; conversation_id: string; contact_id: string;
  message_id: string; title: string; detail: string; created_at: string;
  snoozed_until: number; dismissed: number;
  contact_name?: string; contact_starred?: number;
}
export function upsertNudge(n: {
  kind: string; dedupe: string; conversation_id?: string; contact_id?: string;
  message_id?: string; title: string; detail?: string;
}): Nudge {
  const d = getDb();
  let row = d.query("SELECT * FROM nudges WHERE dedupe = ?").get(n.dedupe) as Nudge | null;
  if (row) {
    // re-arm a dismissed/snoozed nudge only if it was fully resolved before — otherwise leave it
    return row;
  }
  row = {
    id: uid(), kind: n.kind, dedupe: n.dedupe,
    conversation_id: n.conversation_id || "", contact_id: n.contact_id || "",
    message_id: n.message_id || "", title: n.title, detail: n.detail || "",
    created_at: nowIso(), snoozed_until: 0, dismissed: 0,
  };
  d.query("INSERT INTO nudges(id, kind, dedupe, conversation_id, contact_id, message_id, title, detail, created_at, snoozed_until, dismissed) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(row.id, row.kind, row.dedupe, row.conversation_id, row.contact_id, row.message_id, row.title, row.detail, row.created_at, 0, 0);
  return row;
}
export function listActiveNudges(nowMs = Date.now()): Nudge[] {
  return getDb().query(`
    SELECT n.*, ct.name AS contact_name, COALESCE(ct.starred, 0) AS contact_starred FROM nudges n
    LEFT JOIN contacts ct ON ct.id = n.contact_id
    WHERE n.dismissed = 0 AND n.snoozed_until < ?
    ORDER BY n.created_at DESC
  `).all(nowMs) as Nudge[];
}
export function dismissNudge(id: string): void {
  getDb().query("UPDATE nudges SET dismissed = 1 WHERE id = ?").run(id);
}
export function snoozeNudge(id: string, untilMs: number): void {
  getDb().query("UPDATE nudges SET snoozed_until = ? WHERE id = ?").run(untilMs, id);
}
/** Drop nudges whose conversation/contact no longer needs them (replied, archived…). */
export function pruneNudges(validDedupes: Set<string>): number {
  const d = getDb();
  const rows = d.query("SELECT id, dedupe FROM nudges WHERE dismissed = 0").all() as Array<{ id: string; dedupe: string }>;
  let n = 0;
  for (const r of rows) if (!validDedupes.has(r.dedupe)) { d.query("DELETE FROM nudges WHERE id = ?").run(r.id); n++; }
  return n;
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
