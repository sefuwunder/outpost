// vcf import tests — dedupe against existing contacts
import { test, expect, beforeEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OUTPOST_DATA = join(tmpdir(), `outpost-test-${process.pid}-${Math.random().toString(36).slice(2)}`);

const db = await import("../src/db.ts");
const imp = await import("../src/import.ts");

beforeEach(() => {
  db.openDb(join(process.env.OUTPOST_DATA!, "t.db"));
  db.getDb().exec("DELETE FROM messages; DELETE FROM conversations; DELETE FROM contacts; DELETE FROM unknown_senders; DELETE FROM settings;");
});

test("imports new contacts, skips duplicates by email or phone", () => {
  db.createContact({ name: "Existing", email: "ada@example.com" });
  const r = imp.importContactsFromVcf(`BEGIN:VCARD
VERSION:3.0
FN:Ada Clone
EMAIL:ada@example.com
END:VCARD
BEGIN:VCARD
VERSION:3.0
FN:Bo Keller
EMAIL:bo@x.com
TEL;TYPE=CELL:+1 555 000 4444
NOTE:met at conf
END:VCARD`);
  expect(r.total).toBe(2);
  expect(r.imported.length).toBe(1);
  expect(r.imported[0].name).toBe("Bo Keller");
  expect(r.imported[0].phone).toBe("5550004444");
  expect(r.imported[0].notes).toBe("met at conf");
  expect(r.skipped.length).toBe(1);
  expect(r.skipped[0].reason).toBe("duplicate");
  // imported contact got a conversation thread
  expect(db.listConversations().length).toBe(1);
});

test("duplicate by phone with different formatting still caught", () => {
  db.createContact({ name: "P", phone: "(555) 000-7777" });
  const r = imp.importContactsFromVcf("BEGIN:VCARD\nFN:Q\nTEL:+1 555 000 7777\nEND:VCARD");
  expect(r.imported.length).toBe(0);
  expect(r.skipped[0].reason).toBe("duplicate");
});
