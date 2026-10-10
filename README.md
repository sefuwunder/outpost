# outpost 📡

The outer ring — a conversation-view communication app for everyone **outside
Relay's inner 8**. No contact caps, no groups: one unified thread per person,
with every channel condensed into a single conversation.

Built on Relay's codebase: the IMAP/SMTP/Matrix transports are shared verbatim.

## Run

```bash
bun src/server.ts
# → http://127.0.0.1:3029
```

Open **⚙️ Channels** first and add your IMAP/SMTP (email + SMS) and/or Matrix
credentials. Secrets live server-side in SQLite and are never sent to the
browser — the settings API only returns booleans and non-secret fields.

## How it works

- **Conversation list** — every contact's unified thread, sorted by recency,
  with channel pills on the last message, unread badges, and search.
- **Thread view** — email, SMS, and Matrix messages interleaved chronologically
  with per-message channel pills. The composer has a channel picker scoped to
  what the contact actually has (email / phone / Matrix ID).
- **Unknown senders** — inbound mail/SMS/Matrix from addresses with no contact
  land in a "NEW" bucket at the top instead of being lost. Save as contact or
  dismiss.
- **Contacts** — unlimited. Add email, phone (SMS rides Google Voice gateway
  forwards, like Relay), Matrix ID + DM room.
- **Inbound poll** — IMAP UNSEEN sweep + Google Voice SMS harvest + Matrix
  `/sync` every 60s (best-effort per channel; a dead channel never sinks the
  sweep), plus a manual ⟳ button. Dedupe by external message id.

## Layout

```
src/
  server.ts    — HTTP API + static + poll loop (Bun, zero deps)
  db.ts        — SQLite: contacts, conversations, messages, unknown_senders, settings
  channels.ts  — send routing + inbound matching (transports injectable for tests)
  imap.ts      — IMAP client (shared with relay)
  smtp.ts      — SMTP send + Google Voice gateways (shared with relay)
  matrix.ts    — Matrix send/sync (shared with relay)
public/        — conversation-view UI (zero-dep vanilla JS)
tests/         — bun tests
```

Data lives in `./data/` (gitignored).

## Tests

```bash
bun test   # 12 tests — db CRUD/dedupe/unread, channel routing, poll matching
```
