# Outpost as a 9P tree

Outpost served over 9P2000, read-only, for the executive desk:
per-contact threads, messages, and the agent inbox as files.

## Run

```
bun src/ninep-server.ts
```

Environment: `OUTPOST_DATA` (default `<repo>/data`, where
`outpost.db` lives), `NINEP_PORT` (default 9029). Loopback only.
The database is opened read-only, so this server cannot change
outpost state; start outpost itself first if the database does not
exist yet.

## Tree

```
contacts/<id>/{name, email, phone, matrix_id, notes, starred}
threads/<conv>/{contact, contact_name, archived,
                messages/<msg>/{channel, direction, subject, body, created, read}}
inbox/<item>/{from, subject, body, at, contact}
```

Outpost threads are one per contact by construction, so each thread
dir names its contact directly. Writes, creates, and removes all
answer "permission denied".

## v1 limits

No authentication: run on loopback only. No `Twstat`. The 9P
library lives in `src/ninep.ts` and is vendored verbatim into
cadence, relay, and translator — do not fork it per app.
