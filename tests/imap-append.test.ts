// imap APPEND test — fake server speaking just enough IMAP for appendToSent
import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OUTPOST_DATA = join(tmpdir(), `outpost-test-${process.pid}-${Math.random().toString(36).slice(2)}`);

const imap = await import("../src/imap.ts");

function startFakeImap(listLines: string[]) {
  const seen: string[] = [];
  let appended: { mailbox: string; flags: string; bytes: number; body: string } | null = null;
  let pendingAppend: { tag: string; mailbox: string; flags: string; n: number } | null = null;
  const server = Bun.listen({
    hostname: "127.0.0.1", port: 0,
    socket: {
      open(sock) { sock.write("* OK fake IMAP ready\r\n"); },
      data(sock, data) {
        const text = data.toString("latin1");
        seen.push(text);
        // literal bytes following our "+ send literal" continuation
        if (pendingAppend) {
          const pa = pendingAppend; pendingAppend = null;
          appended = { mailbox: pa.mailbox, flags: pa.flags, bytes: text.length, body: text };
          sock.write(`${pa.tag} OK APPEND completed\r\n`);
          return;
        }
        const lines = text.split("\r\n").filter(Boolean);
        for (const line of lines) {
          const cm = line.match(/^(\S+)\s+(.*)$/);
          if (!cm) continue;
          const [tag, rest] = [cm[1], cm[2]];
          const reply = (s: string) => sock.write(s + "\r\n");
          const up = rest.toUpperCase();
          if (up.startsWith("LOGIN")) reply(`${tag} OK logged in`);
          else if (up.startsWith("LIST")) { for (const l of listLines) reply(l); reply(`${tag} OK listed`); }
          else if (up.startsWith("APPEND")) {
            const lm = rest.match(/APPEND\s+"([^"]+)"\s+(\([^)]*\))\s+\{(\d+)\}/i);
            if (!lm) { reply(`${tag} BAD malformed APPEND`); continue; }
            pendingAppend = { tag, mailbox: lm[1], flags: lm[2], n: Number(lm[3]) };
            sock.write("+ send literal\r\n");
          }
          else if (up.startsWith("LOGOUT")) { reply("* BYE"); reply(`${tag} OK bye`); sock.end(); }
          else reply(`${tag} BAD unknown`);
        }
      },
    },
  });
  return { port: server.port, seen, appended: () => appended, stop: () => server.stop() };
}

const LIST_WITH_SENT = [
  `* LIST (\\HasNoChildren \\Sent) "/" "Sent"`,
  `* LIST (\\HasNoChildren) "/" "INBOX"`,
];

test("appendToSent APPENDs with (\\Seen) to the \\Sent-flagged mailbox", async () => {
  const fake = startFakeImap(LIST_WITH_SENT);
  try {
    await imap.appendToSent(
      { host: "127.0.0.1", port: fake.port, user: "u", pass: "p", secure: false },
      "From: me@x.com\r\nTo: you@y.com\r\nSubject: hi\r\n\r\nhello world"
    );
    const got = fake.appended();
    expect(got).not.toBeNull();
    expect(got!.mailbox).toBe("Sent"); // preferred via \Sent special-use flag
    expect(got!.flags).toBe("(\\Seen)");
    expect(got!.body).toContain("hello world");
    expect(got!.body).toContain("Subject: hi");
    expect(fake.seen.some((s) => /APPEND "Sent" \(\\Seen\) \{\d+\}/i.test(s))).toBe(true);
  } finally {
    fake.stop();
  }
});

test("appendToSent falls back to name matching without special-use flags", async () => {
  const fake = startFakeImap([`* LIST (\\HasNoChildren) "/" "INBOX"`, `* LIST (\\HasNoChildren) "/" "[Gmail]/Sent Mail"`]);
  try {
    await imap.appendToSent(
      { host: "127.0.0.1", port: fake.port, user: "u", pass: "p", secure: false },
      "From: me@x.com\r\n\r\nbody"
    );
    expect(fake.appended()!.mailbox).toBe("[Gmail]/Sent Mail");
  } finally {
    fake.stop();
  }
});

test("appendToSent throws when no Sent folder exists", async () => {
  const fake = startFakeImap([`* LIST (\\HasNoChildren) "/" "INBOX"`]);
  try {
    await expect(imap.appendToSent(
      { host: "127.0.0.1", port: fake.port, user: "u", pass: "p", secure: false },
      "From: me@x.com\r\n\r\nbody"
    )).rejects.toThrow(/Sent folder/);
  } finally {
    fake.stop();
  }
});
