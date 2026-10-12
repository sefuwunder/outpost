// IMAP connection pressure tests: the process-wide gate caps simultaneous
// connections, and batched lookups reuse one connection.
import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OUTPOST_DATA = join(tmpdir(), `outpost-test-${process.pid}-${Math.random().toString(36).slice(2)}`);

const imap = await import("../src/imap.ts");

const ENVELOPE = `("Mon, 12 Oct 2026 10:00:00 +0000" "hi" (("A" NIL "a" "x.com")) NIL NIL (("B" NIL "b" "y.com")) NIL NIL "<m1>")`;

/** Fake IMAP server that tracks peak concurrent connections. */
function startCountingServer() {
  let live = 0, peak = 0;
  let logins = 0;
  const server = Bun.listen({
    hostname: "127.0.0.1", port: 0,
    socket: {
      open(sock) { live++; peak = Math.max(peak, live); sock.write("* OK fake\r\n"); },
      close() { /* counted at LOGOUT, not on async socket teardown */ },
      data(sock, data) {
        const lines = data.toString().split("\r\n").filter(Boolean);
        for (const line of lines) {
          const cm = line.match(/^(\S+)\s+(.*)$/);
          if (!cm) continue;
          const [tag, rest] = [cm[1], cm[2].toUpperCase()];
          const reply = (s: string) => sock.write(s + "\r\n");
          if (rest.startsWith("LOGIN")) { logins++; reply(`${tag} OK ok`); }
          else if (rest.startsWith("SELECT") || rest.startsWith("EXAMINE")) reply(`${tag} OK ok`);
          else if (rest.startsWith("UID SEARCH")) { reply("* SEARCH 7"); reply(`${tag} OK ok`); }
          else if (rest.includes("ENVELOPE")) { reply(`* 1 FETCH (UID 7 ENVELOPE ${ENVELOPE})`); reply(`${tag} OK ok`); }
          else if (rest.includes("BODY.PEEK[TEXT]")) { const b = "hello"; reply(`* 1 FETCH (UID 7 BODY[TEXT] {${b.length}}\r\n${b})`); reply(`${tag} OK ok`); }
          else if (rest.includes("HEADER.FIELDS")) { const h = "Return-Path: <r@x>\r\n"; reply(`* 1 FETCH (UID 7 BODY[HEADER.FIELDS (RETURN-PATH)] {${h.length}}\r\n${h})`); reply(`${tag} OK ok`); }
          else if (rest.startsWith("UID STORE")) reply(`${tag} OK ok`);
          else if (rest.startsWith("LIST")) { reply(`* LIST (\\HasNoChildren) "/" "INBOX"`); reply(`${tag} OK ok`); }
          else if (rest.startsWith("LOGOUT")) { live--; reply("* BYE"); reply(`${tag} OK bye`); sock.end(); }
          else reply(`${tag} BAD unknown`);
        }
      },
    },
  });
  return { port: server.port, peak: () => peak, logins: () => logins, stop: () => server.stop() };
}

const cfg = (port: number) => ({ host: "127.0.0.1", port, user: "u", pass: "p", secure: false });

test("concurrent IMAP work never exceeds the connection cap", async () => {
  const fake = startCountingServer();
  try {
    // 6 overlapping fetches — the gate must serialize them to <= 2 at once.
    await Promise.all(Array.from({ length: 6 }, () => imap.fetchUnseen(cfg(fake.port), 5)));
    expect(fake.peak()).toBeLessThanOrEqual(2);
    expect(fake.logins()).toBe(6); // every operation still ran
  } finally {
    fake.stop();
  }
});

test("latestEmailWithMany serves N addresses over a single connection", async () => {
  const fake = startCountingServer();
  try {
    const got = await imap.latestEmailWithMany(
      cfg(fake.port), ["a@x.com", "b@y.com", "c@z.com"], 500
    );
    expect(got.size).toBe(3);
    expect(fake.logins()).toBe(1);
    expect(fake.peak()).toBe(1);
  } finally {
    fake.stop();
  }
});

test("isConnectionLimitError matches provider limit refusals", () => {
  expect(imap.isConnectionLimitError(new Error("mail server refused: [LIMIT] Too many simultaneous connections"))).toBe(true);
  expect(imap.isConnectionLimitError(new Error("too many simultaneous connections"))).toBe(true);
  expect(imap.isConnectionLimitError(new Error("mail server refused: AUTHENTICATIONFAILED"))).toBe(false);
  expect(imap.isConnectionLimitError(null)).toBe(false);
});

test("connect retries once on a limit refusal then succeeds", async () => {
  let attempts = 0;
  const server = Bun.listen({
    hostname: "127.0.0.1", port: 0,
    socket: {
      open(sock) { sock.write("* OK fake\r\n"); },
      data(sock, data) {
        const lines = data.toString().split("\r\n").filter(Boolean);
        for (const line of lines) {
          const cm = line.match(/^(\S+)\s+(.*)$/);
          if (!cm) continue;
          const [tag, rest] = [cm[1], cm[2].toUpperCase()];
          const reply = (s: string) => sock.write(s + "\r\n");
          if (rest.startsWith("LOGIN")) {
            attempts++;
            if (attempts === 1) { reply(`${tag} NO [LIMIT] Too many simultaneous connections`); sock.end(); }
            else reply(`${tag} OK ok`);
          }
          else if (rest.startsWith("SELECT")) reply(`${tag} OK ok`);
          else if (rest.startsWith("UID SEARCH")) { reply("* SEARCH"); reply(`${tag} OK ok`); }
          else if (rest.startsWith("LOGOUT")) { reply("* BYE"); reply(`${tag} OK bye`); sock.end(); }
          else reply(`${tag} BAD unknown`);
        }
      },
    },
  });
  try {
    const mails = await imap.fetchUnseen({ host: "127.0.0.1", port: server.port, user: "u", pass: "p", secure: false }, 5);
    expect(mails).toEqual([]);
    expect(attempts).toBe(2);
  } finally {
    server.stop();
  }
});
