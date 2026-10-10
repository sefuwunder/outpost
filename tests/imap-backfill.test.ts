// imap backfill test — fake server speaking just enough IMAP for fetchRecent
import { test, expect, beforeEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OUTPOST_DATA = join(tmpdir(), `outpost-test-${process.pid}-${Math.random().toString(36).slice(2)}`);

const db = await import("../src/db.ts");

beforeEach(() => {
  db.openDb(join(process.env.OUTPOST_DATA!, "t.db"));
  db.getDb().exec("DELETE FROM messages; DELETE FROM conversations; DELETE FROM contacts; DELETE FROM unknown_senders; DELETE FROM settings; DELETE FROM triage; DELETE FROM nudges; DELETE FROM inbox;");
});

const ENVELOPE_1 = `("Fri, 09 Oct 2026 10:00:00 +0000" "Hello there" (("Ada Lovelace" NIL "ada" "x.com")) NIL NIL (("Me" NIL "me" "y.com")) NIL NIL "<m1@x>")`;
const ENVELOPE_2 = `("Fri, 09 Oct 2026 11:00:00 +0000" "Big sale" (("Shop" NIL "deals" "shop.com")) NIL NIL (("Me" NIL "me" "y.com")) NIL NIL "<m2@s>")`;

function startFakeImap() {
  const seen: string[] = [];
  const server = Bun.listen({
    hostname: "127.0.0.1", port: 0,
    socket: {
      open(sock) { sock.write("* OK fake IMAP ready\r\n"); },
      data(sock, data) {
        const lines = data.toString().split("\r\n").filter(Boolean);
        for (const line of lines) {
          seen.push(line);
          const m = line.match(/^(\S+)\s+(.*)$/);
          if (!m) continue;
          const [tag, rest] = [m[1], m[2].toUpperCase()];
          const reply = (s: string) => sock.write(s + "\r\n");
          if (rest.startsWith("LOGIN")) reply(`${tag} OK logged in`);
          else if (rest.startsWith("SELECT")) { reply("* 2 EXISTS\r\n* 1 RECENT"); reply(`${tag} OK selected`); }
          else if (rest.startsWith("UID SEARCH")) { reply("* SEARCH 101 102"); reply(`${tag} OK searched`); }
          else if (rest.includes("ENVELOPE")) {
            reply(`* 1 FETCH (UID 101 INTERNALDATE "09-Oct-2026 10:00:00 +0000" ENVELOPE ${ENVELOPE_1})`);
            reply(`* 2 FETCH (UID 102 INTERNALDATE "09-Oct-2026 11:00:00 +0000" ENVELOPE ${ENVELOPE_2})`);
            reply(`${tag} OK fetched`);
          } else if (rest.includes("BODY.PEEK[TEXT]")) {
            const b1 = "Hello there friend, how are you doing today?";
            const b2 = "Huge discounts! Unsubscribe anytime.";
            reply(`* 1 FETCH (UID 101 BODY[TEXT] {${b1.length}}\r\n${b1})`);
            reply(`* 2 FETCH (UID 102 BODY[TEXT] {${b2.length}}\r\n${b2})`);
            reply(`${tag} OK fetched`);
          } else if (rest.includes("RETURN-PATH")) {
            const h = "Return-Path: <bounces@x.com>\r\n";
            reply(`* 1 FETCH (UID 101 BODY[HEADER.FIELDS (RETURN-PATH)] {${h.length}}\r\n${h})`);
            reply(`* 2 FETCH (UID 102 BODY[HEADER.FIELDS (RETURN-PATH)] {${h.length}}\r\n${h})`);
            reply(`${tag} OK fetched`);
          } else if (rest.startsWith("LOGOUT")) { reply("* BYE"); reply(`${tag} OK bye`); sock.end(); }
          else reply(`${tag} BAD unknown`);
        }
      },
    },
  });
  return { port: server.port, seen, stop: () => server.stop() };
}

test("backfill pulls recent mail into the inbox, contact or not", async () => {
  const ch = await import("../src/channels.ts");
  const agent = await import("../src/agent.ts");
  const fake = startFakeImap();
  try {
    db.setSetting("imap_host", "127.0.0.1");
    db.setSetting("imap_port", String(fake.port));
    db.setSetting("imap_user", "me@y.com");
    db.setSetting("imap_pass", "secret");
    db.createContact({ name: "Ada Lovelace", email: "ada@x.com" });

    const r = await ch.backfillInbox(30, 200, false);
    expect(r.email).toBe(1);   // ada → contact thread
    expect(r.unknown).toBe(1); // deals@shop.com → unknown

    const inbox = db.listInbox();
    expect(inbox.length).toBe(2);
    expect(inbox[0].from_email).toBe("deals@shop.com"); // newest first
    expect(inbox[1].from_name).toBe("Ada Lovelace");

    agent.runAgent();
    const cats = new Map(inbox.map((i) => [i.from_email, db.getTriage(i.id)]));
    expect(cats.get("deals@shop.com")).toBe("newsletter"); // unsubscribe marker
    expect(cats.get("ada@x.com")).toBe("personal");

    // unknown senders got the non-contact mail
    expect(db.listUnknown().length).toBe(1);

    // server saw a SINCE search, never a flag STORE
    expect(fake.seen.some((c) => /UID SEARCH SINCE/i.test(c))).toBe(true);
    expect(fake.seen.some((c) => /STORE/i.test(c))).toBe(false);
  } finally {
    fake.stop();
  }
});
