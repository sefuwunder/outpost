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
  forwards, like Relay), Matrix ID + DM room. Import a whole address book from
  a `.vcf` file (👥 → Import from vCard): vCard 2.1/3.0/4.0, folded lines,
  quoted-printable, FN/N fallback, PREF email/phone preference, dedupe by
  email/phone with an imported/skipped report. A red **Clear All Contacts** button
  at the bottom of the roster wipes every contact, conversation, message, and
  unknown sender (double-confirmed; channel settings are kept).
- **Agent** — deterministic, rule-based (no AI): every inbound email is
  classified (personal / newsletter / receipt / automated — unsubscribe markers,
  bulk senders, receipt patterns, noreply addresses), and nudges are generated
  on fixed day-rules: reply needed (3+ days, inbound unanswered), follow-up
  (7+ days since your unanswered message), new sender waiting (2+ days).
  Newsletters never trigger reply nudges. Runs after every poll; idempotent.
  🔔 bell with badge, nudge cards with Open / Snooze / Dismiss, and filter
  chips (All · Needs reply · Personal · Newsletters · Receipts · Automated).
- **Inbound poll** — IMAP UNSEEN sweep + Google Voice SMS harvest + Matrix
  `/sync` every 60s (best-effort per channel; a dead channel never sinks the
  sweep), plus a manual ⟳ button. Dedupe by external message id. The agent
  runs automatically after every sweep.

## Layout

```
src/
  server.ts    — HTTP API + static + poll loop (Bun, zero deps)
  db.ts        — SQLite: contacts, conversations, messages, unknown_senders, settings
  channels.ts  — send routing + inbound matching (transports injectable for tests)
  vcf.ts       — vCard 2.1/3.0/4.0 parser (pure)
  import.ts    — vcf → contacts import with dedupe
  agent.ts     — deterministic triage + nudge rules (pure)
  imap.ts      — IMAP client (shared with relay)
  smtp.ts      — SMTP send + Google Voice gateways (shared with relay)
  matrix.ts    — Matrix send/sync (shared with relay)
public/        — conversation-view UI (zero-dep vanilla JS)
tests/         — bun tests
```

Data lives in `./data/` (gitignored).

## Tests

```bash
bun test   # 29 tests — agent rules, vcf parser, import dedupe, clear-all, db CRUD/dedupe/unread, channel routing, poll matching
```
