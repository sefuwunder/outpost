// ninep-server.ts — Outpost as a read-only 9P2000 tree.
//
// Run: bun src/ninep-server.ts
//   OUTPOST_DATA (default: <repo>/data) — outpost.db lives here.
//   NINEP_PORT (default 9029), loopback only.
//
// Tree (read-only; writes answer "permission denied"):
//   /contacts/<id>/{name, email, phone, matrix_id, notes, starred}
//   /threads/<conv>/{contact, contact_name, archived,
//                    messages/<msg>/{channel, direction, subject, body, created, read}}
//   /inbox/<item>/{from, subject, body, at, contact}
//
// Outpost threads are one per contact by construction, so each thread
// dir names its contact directly.

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serveNineP, type DirNode, type FileNode, type Node } from "./ninep.ts";

function textFile(name: string, path: string, get: () => string): FileNode {
  return {
    kind: "file", name, path,
    len: () => new TextEncoder().encode(get()).length,
    read: (off: number, count: number) => new TextEncoder().encode(get()).slice(off, off + count),
    mtime: () => Date.now(),
  };
}

function dir(name: string, path: string, list: () => { name: string; isDir: boolean }[],
  get: (n: string) => Node | null): DirNode {
  return { kind: "dir", name, path, list, get, mtime: () => Date.now() };
}

export function buildOutpostTree(db: Database): DirNode {
  const all = (sql: string, ...args: any[]): any[] => db.query(sql).all(...args) as any[];
  const one = (sql: string, ...args: any[]): any => db.query(sql).get(...args) as any;

  const msgNode = (convId: string, m: any): DirNode =>
    dir(m.id, `/threads/${convId}/messages/${m.id}`,
      () => [
        { name: "channel", isDir: false }, { name: "direction", isDir: false },
        { name: "subject", isDir: false }, { name: "body", isDir: false },
        { name: "created", isDir: false }, { name: "read", isDir: false },
      ],
      (n: string) => {
        const p = `/threads/${convId}/messages/${m.id}/${n}`;
        if (n === "channel") return textFile(n, p, () => m.channel);
        if (n === "direction") return textFile(n, p, () => m.direction);
        if (n === "subject") return textFile(n, p, () => m.subject);
        if (n === "body") return textFile(n, p, () => m.body);
        if (n === "created") return textFile(n, p, () => m.created_at);
        if (n === "read") return textFile(n, p, () => (m.read ? "1" : "0"));
        return null;
      });

  const threadNode = (c: any): DirNode =>
    dir(c.id, `/threads/${c.id}`,
      () => [
        { name: "contact", isDir: false }, { name: "contact_name", isDir: false },
        { name: "archived", isDir: false }, { name: "messages", isDir: true },
      ],
      (n: string) => {
        const p = `/threads/${c.id}/${n}`;
        if (n === "contact") return textFile(n, p, () => c.contact_id);
        if (n === "contact_name") {
          return textFile(n, p, () => {
            const ct = one("SELECT name FROM contacts WHERE id = ?", c.contact_id);
            return ct ? ct.name : "";
          });
        }
        if (n === "archived") return textFile(n, p, () => (c.archived ? "1" : "0"));
        if (n === "messages") {
          return dir("messages", `/threads/${c.id}/messages`,
            () => all("SELECT id FROM messages WHERE conversation_id = ? ORDER BY created_at", c.id)
              .map((m) => ({ name: m.id, isDir: true })),
            (mid: string) => {
              const m = one("SELECT * FROM messages WHERE id = ? AND conversation_id = ?", mid, c.id);
              return m ? msgNode(c.id, m) : null;
            });
        }
        return null;
      });

  const threads = dir("threads", "/threads",
    () => all("SELECT id FROM conversations ORDER BY created_at").map((c) => ({ name: c.id, isDir: true })),
    (id: string) => {
      const c = one("SELECT * FROM conversations WHERE id = ?", id);
      return c ? threadNode(c) : null;
    });

  const contacts = dir("contacts", "/contacts",
    () => all("SELECT id FROM contacts ORDER BY name").map((c) => ({ name: c.id, isDir: true })),
    (id: string) => {
      const c = one("SELECT * FROM contacts WHERE id = ?", id);
      if (!c) return null;
      return dir(id, `/contacts/${id}`,
        () => [
          { name: "name", isDir: false }, { name: "email", isDir: false },
          { name: "phone", isDir: false }, { name: "matrix_id", isDir: false },
          { name: "notes", isDir: false }, { name: "starred", isDir: false },
        ],
        (n: string) => {
          const p = `/contacts/${id}/${n}`;
          if (n === "name") return textFile(n, p, () => c.name);
          if (n === "email") return textFile(n, p, () => c.email);
          if (n === "phone") return textFile(n, p, () => c.phone);
          if (n === "matrix_id") return textFile(n, p, () => c.matrix_id);
          if (n === "notes") return textFile(n, p, () => c.notes);
          if (n === "starred") return textFile(n, p, () => (c.starred ? "1" : "0"));
          return null;
        });
    });

  const inbox = dir("inbox", "/inbox",
    () => all("SELECT id FROM inbox ORDER BY created_at DESC").map((i) => ({ name: i.id, isDir: true })),
    (id: string) => {
      const i = one("SELECT * FROM inbox WHERE id = ?", id);
      if (!i) return null;
      return dir(id, `/inbox/${id}`,
        () => [
          { name: "from", isDir: false }, { name: "subject", isDir: false },
          { name: "body", isDir: false }, { name: "at", isDir: false },
          { name: "contact", isDir: false },
        ],
        (n: string) => {
          const p = `/inbox/${id}/${n}`;
          if (n === "from") return textFile(n, p, () => `${i.from_name} <${i.from_email}>`);
          if (n === "subject") return textFile(n, p, () => i.subject);
          if (n === "body") return textFile(n, p, () => i.body);
          if (n === "at") return textFile(n, p, () => i.at);
          if (n === "contact") return textFile(n, p, () => i.contact_id);
          return null;
        });
    });

  const rootChildren: Record<string, Node> = { contacts, threads, inbox };
  return dir("", "/",
    () => Object.keys(rootChildren).map((n) => ({ name: n, isDir: true })),
    (n: string) => rootChildren[n] || null);
}

export function startOutpostNinep(opts: { dbPath: string; port: number; hostname?: string }) {
  if (!existsSync(opts.dbPath)) {
    throw new Error(
      `outpost database not found: ${opts.dbPath}\n` +
      `Run the outpost app once to create it, or set OUTPOST_DATA to the directory holding outpost.db.`
    );
  }
  const db = new Database(opts.dbPath, { readonly: true });
  return serveNineP(buildOutpostTree(db), { port: opts.port, hostname: opts.hostname });
}

if (import.meta.main) {
  const here = dirname(fileURLToPath(import.meta.url));
  const dataDir = process.env.OUTPOST_DATA || join(here, "..", "data");
  const port = Number(process.env.NINEP_PORT || 9029);
  try {
    startOutpostNinep({ dbPath: join(dataDir, "outpost.db"), port });
  } catch (e: any) {
    console.error(`outpost 9P: ${e.message}`);
    process.exit(1);
  }
  console.log(`outpost 9P (read-only) on 127.0.0.1:${port} db ${join(dataDir, "outpost.db")}`);
}
