# outpost 📡

The outer ring — a communication app for everyone **outside
Relay's inner 8**. No contact caps, no groups: one unified thread per person,
with every channel condensed into a single conversation.

It opens on a 30-day **Inbox**: every inbound email of the last month,
organized by the agent into Personal / Newsletters / Receipts / Automated —
senders don't need to be saved contacts to appear. Above the sections sits a
**Read now** strip: the 8 unread messages the agent ranks most important
(category, recency, starred senders, open nudges), as contact bubbles.
An Inbox/Chats segmented control switches to the unified per-contact threads.

Built on Relay's codebase: the IMAP/SMTP/Matrix transports are shared verbatim.

## Run

```bash
bun src/server.ts
# → http://127.0.0.1:3029
```

Open **⚙️ Channels** first and add your IMAP/SMTP (email + SMS) and/or Matrix
credentials. Secrets live server-side in SQLite and are never sent to the
browser — the settings API only returns booleans and non-secret fields.
SMTP security auto-detects from the port (465 → implicit SSL, anything else →
STARTTLS); override it with the SMTP security selector if your provider needs
something specific.

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
- **Inbox home** — every inbound email is captured into an `inbox` table
  (dedupe by external id), whether or not the sender is a contact; existing
  messages and unknown senders are backfilled on first run. The home view
  shows the last 30 days grouped by the agent's triage sections (collapsible,
  unread counts), with a reader view per email: Open chat / Add to Contacts
  for unknown senders, read/unread, delete. The category label in the reader
  is tappable — the same correction sheet that teaches the model.
  The 60s poller only sees *unread* mail; a first-run auto-backfill plus an
  "Import recent mail" button pull the last 30 days read-or-not (read-only,
  no flags touched). Tapping ⟳ reports what happened via toast — including
  poll errors, which used to be swallowed silently.
- **Agent** — deterministic, rule-based (no AI): every inbound email is
  classified (personal / newsletter / receipt / automated — unsubscribe markers,
  bulk senders, receipt patterns, noreply addresses), and nudges are generated
  on fixed day-rules: reply needed (3+ days, inbound unanswered), follow-up
  (7+ days since your unanswered message), new sender waiting (2+ days).
  Newsletters never trigger reply nudges. Runs after every poll; idempotent.
  🔔 bell with badge, nudge cards with Open / Snooze / Dismiss, and filter
  chips (All · Needs reply · Personal · Newsletters · Receipts · Automated).
- **Jev-style decision model** (`src/jev.ts`) — local, zero-dep, in the spirit
  of TypeSafe's Jev: typed `classify`/`score` with calibrated confidence and
  evidence. An online Naive Bayes over sender/subject/word features grades
  every email (label + confidence + top evidence); once it has seen enough
  evidence it takes over from the rules, which stay the day-one fallback.
  It learns from you: tap a category pill → correct the label ("why" shows the
  evidence weights) and the model updates immediately. Nudges are fuzzy-scored
  too — per-kind acted/dismissed rates plus an urgency ramp rank the 🔔 list,
  so nudge types you always dismiss sink over time. All counts live in SQLite;
  nothing leaves the machine.
- **Training the agent** — tap a category pill on any email to re-label it,
  then choose "Just this email" or "All mail from sender@x.com" to create a
  persistent sender rule (domain rules are supported too). Corrections feed
  the model *and* create rules; refreshing the inbox re-runs the agent over
  everything — previously-labeled mail moves under the new rules, while your
  explicit corrections stay locked as ground truth. Rules are listed (and
  deletable) in ⚙️ Channels → Triage rules.
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
  jev.ts       — local Jev-style model: NB classify/score, online learning
  imap.ts      — IMAP client (shared with relay)
  smtp.ts      — SMTP send + Google Voice gateways (shared with relay)
  matrix.ts    — Matrix send/sync (shared with relay)
  e2ee/        — end-to-end encryption (copied from outpost-e2ee: X3DH + Double Ratchet, pure WebCrypto)
public/        — conversation-view UI (zero-dep vanilla JS)
tests/         — bun tests
```

Data lives in `./data/` (gitignored).

## 🔒 Encrypted channel (outpost-e2ee)

Outpost speaks to a self-hosted [outpost-e2ee](https://github.com/sefuwunder/outpost-e2ee)
relay (X3DH + Double Ratchet, pure WebCrypto). The relay holds only public
keys and ciphertext — it can never read messages.

1. Start the relay: `bun src/server.ts` in outpost-e2ee (port 3030), with
   `E2EE_PROVISION_TOKEN` set.
2. In outpost Settings → 🔒 Encrypted: set the relay server URL, your handle,
   and the provision token; hit **Test** (registers your keys).
3. Give a contact their 🔒 E2EE handle in the contact editor — **🔒 Encrypted**
   appears as a fourth channel in the composer.
4. Their replies arrive through the normal 60s poll, decrypted on your machine
   into the unified thread. **Verify** in the contact editor shows the safety
   number — read it to each other once to rule out a meddler in the middle.

## 🧠 Local LLM bridge

A local LLM (Ollama) can advise the decision model. The deterministic pipeline
stays in charge — the LLM is an advisor whose judgments land as triage with
source `llm`: locked like your corrections, training the local Jev model, and
outranked only by your explicit corrections.

- Settings → 🧠 Local LLM: server URL, model, confidence threshold, Test.
- When enabled, each poll asks the model about ambiguous mail (rules-fallback
  or low-confidence; max 5 per poll, ≥10 min apart).
- Endpoints for your own harness or the model itself:
  - `GET /api/llm/pending` — messages where input would help, with current triage
  - `GET /api/llm/context?message_id=` — the full decision briefing: message,
    current triage + evidence, sender history, matched user rules
  - `GET /api/llm/nudges` — nudge decision context (per-kind dismiss rates, active nudges)
  - `POST /api/llm/judgment` — `{message_id(s), category, confidence, reason}` → applies + trains
  - `POST /api/llm/consult` — run one consult pass now (synchronous report)
  - `GET /api/llm/status` — reachability probe + pending count
- **Idle learning** — when the queue is clear and 6h have passed, the agent
  does a background pass over stored mail: the LLM *reviews* weak past
  decisions (agreements reinforce the local model; confident disagreements
  refine the label), and *mines* consistent sender patterns into triage rules
  (LLM-confirmed, marked 🤖, deletable like any rule, never touching
  senders you've corrected). `POST /api/llm/idle-learn` runs it on demand.

## Tests

```bash
bun test   # 52 tests — imap backfill, inbox, jev model, agent rules + training rules + reorganize, smtp, vcf parser, import dedupe, clear-all, db CRUD/dedupe/unread, channel routing, poll matching
```
