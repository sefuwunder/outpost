// ninep-outpost.test.ts — Outpost 9P tree (read-only) against a temp database.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { startOutpostNinep } from "../src/ninep-server.ts";
import { NinePClient } from "../src/ninep.ts";

let tmp = "";
let server: any;
let port = 0;
let db: Database;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "outpost-9p-"));
  db = new Database(join(tmp, "outpost.db"));
  db.run(`CREATE TABLE contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
    matrix_id TEXT NOT NULL DEFAULT '', e2ee_handle TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '', starred INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`);
  db.run(`CREATE TABLE conversations (id TEXT PRIMARY KEY, contact_id TEXT NOT NULL UNIQUE,
    archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_at TEXT NOT NULL DEFAULT '')`);
  db.run(`CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
    channel TEXT NOT NULL, direction TEXT NOT NULL, body TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '', external_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0, reply_later INTEGER NOT NULL DEFAULT 0)`);
  db.run(`CREATE TABLE inbox (id TEXT PRIMARY KEY, from_email TEXT NOT NULL DEFAULT '',
    from_name TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '', html_body TEXT NOT NULL DEFAULT '',
    at TEXT NOT NULL, external_id TEXT UNIQUE, contact_id TEXT NOT NULL DEFAULT '',
    message_id TEXT NOT NULL DEFAULT '', read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`);
  db.run("INSERT INTO contacts (id, name, email, phone, starred, created_at) VALUES ('c1', 'Jane Acme', 'jane@acme.example', '+1', 1, '2026-10-28')");
  db.run("INSERT INTO conversations (id, contact_id, created_at) VALUES ('conv-1', 'c1', '2026-10-28')");
  db.run(`INSERT INTO messages (id, conversation_id, channel, direction, body, created_at, read)
    VALUES ('m1', 'conv-1', 'email', 'in', 'Outpost hello', '2026-10-28T11:00:00Z', 0)`);
  db.run(`INSERT INTO inbox (id, from_email, from_name, subject, body, at, contact_id, created_at)
    VALUES ('ib-1', 'jane@acme.example', 'Jane Acme', 'Intro', 'Body text', '2026-10-28T09:00:00Z', 'c1', '2026-10-28')`);
  server = startOutpostNinep({ dbPath: join(tmp, "outpost.db"), port: 0 });
  port = server.port;
});

afterAll(() => {
  server.stop();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function client() {
  const c = new NinePClient();
  await c.connect("127.0.0.1", port);
  return c;
}

describe("outpost 9P tree", () => {
  test("threads, messages, contacts, inbox read", async () => {
    const c = await client();
    try {
      expect((await c.listDir("/")).map((e) => e.name).sort()).toEqual(["contacts", "inbox", "threads"]);
      expect(await c.readFile("/threads/conv-1/contact")).toBe("c1");
      expect(await c.readFile("/threads/conv-1/contact_name")).toBe("Jane Acme");
      expect(await c.readFile("/threads/conv-1/messages/m1/body")).toBe("Outpost hello");
      expect(await c.readFile("/threads/conv-1/messages/m1/read")).toBe("0");
      expect(await c.readFile("/contacts/c1/starred")).toBe("1");
      expect(await c.readFile("/inbox/ib-1/subject")).toBe("Intro");
      expect(await c.readFile("/inbox/ib-1/from")).toBe("Jane Acme <jane@acme.example>");
    } finally {
      c.close();
    }
  });

  test("tree is read-only", async () => {
    const c = await client();
    try {
      await expect(c.writeFile("/threads/conv-1/contact_name", "Nope")).rejects.toThrow();
    } finally {
      c.close();
    }
  });

  test("missing database fails with a plain message, not a sqlite stack", () => {
    expect(() => startOutpostNinep({ dbPath: join(tmp, "nope.db"), port: 0 }))
      .toThrow(/outpost database not found: .*nope\.db/);
  });
});
