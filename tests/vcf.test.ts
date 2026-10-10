// vcf parser tests — pure, no db
import { test, expect } from "bun:test";
import { parseVcf, pickEmail, pickPhone } from "../src/vcf.ts";

test("basic card: FN, EMAIL, TEL, NOTE", () => {
  const cards = parseVcf(`BEGIN:VCARD
VERSION:3.0
FN:Ada Lovelace
EMAIL;TYPE=INTERNET:ada@example.com
TEL;TYPE=CELL:+1 555 010 2030
NOTE:First programmer
END:VCARD`);
  expect(cards.length).toBe(1);
  const c = cards[0];
  expect(c.name).toBe("Ada Lovelace");
  expect(pickEmail(c)).toBe("ada@example.com");
  expect(pickPhone(c)).toBe("+1 555 010 2030");
  expect(c.note).toBe("First programmer");
});

test("N fallback when no FN; PREF email/phone win", () => {
  const cards = parseVcf(`BEGIN:VCARD
VERSION:3.0
N:Keller;Bo;;;
EMAIL;TYPE=WORK:bo@work.com
EMAIL;TYPE=PREF:bo@home.com
TEL;TYPE=HOME:5550001111
TEL;TYPE=CELL,PREF:5550002222
END:VCARD`);
  const c = cards[0];
  expect(c.name).toBe("Bo Keller");
  expect(pickEmail(c)).toBe("bo@home.com");
  expect(pickPhone(c)).toBe("5550002222");
});

test("folded lines rejoin; multiple cards parse", () => {
  const cards = parseVcf(
    "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Al\r\nEMAIL:al@x.com\r\nEND:VCARD\r\n" +
    "BEGIN:VCARD\nVERSION:3.0\nFN:Beth Longname With A Very Long\n Note That Folds\nEMAIL:beth@x.com\nEND:VCARD"
  );
  expect(cards.length).toBe(2);
  expect(cards[1].name).toBe("Beth Longname With A Very LongNote That Folds");
});

test("vCard 2.1 bare types + quoted-printable", () => {
  const cards = parseVcf(`BEGIN:VCARD
VERSION:2.1
FN;ENCODING=QUOTED-PRINTABLE:Zo=C3=A9 Dupont
TEL;CELL:5550003333
END:VCARD`);
  expect(cards[0].name).toBe("Zoé Dupont");
  expect(pickPhone(cards[0])).toBe("5550003333");
});

test("empty card dropped; junk ignored", () => {
  const cards = parseVcf("hello\nBEGIN:VCARD\nVERSION:3.0\nEND:VCARD\nBEGIN:VCARD\nFN:Solo\nEND:VCARD");
  expect(cards.length).toBe(1);
  expect(cards[0].name).toBe("Solo");
});

test("escapes unescaped", () => {
  const cards = parseVcf("BEGIN:VCARD\nFN:A\\, B\\; C\nNOTE:line1\\nline2\nEND:VCARD");
  expect(cards[0].name).toBe("A, B; C");
  expect(cards[0].note).toBe("line1\nline2");
});

test("apple contacts itemN. grouped properties", () => {
  const cards = parseVcf(`BEGIN:VCARD
VERSION:3.0
N:Appleseed;Jane;;;
FN:Jane Appleseed
item1.EMAIL;type=INTERNET;type=HOME;type=pref:jane@home.com
item1.X-ABLabel:_$!<Home>!$_
item2.EMAIL;type=INTERNET;type=WORK:jane@work.com
item2.X-ABLabel:_$!<Work>!$_
item3.TEL;type=IPHONE;type=CELL;type=VOICE;type=pref:+1 555 010 9999
item3.X-ABLabel:_$!<Mobile>!$_
item4.ADR;type=HOME:;;123 Main St;Springfield;IL;62701;
item4.X-ABLabel:_$!<Home>!$_
END:VCARD`);
  expect(cards.length).toBe(1);
  const c = cards[0];
  expect(c.name).toBe("Jane Appleseed");
  expect(c.emails.length).toBe(2);
  expect(pickEmail(c)).toBe("jane@home.com"); // PREF wins
  expect(pickPhone(c)).toBe("+1 555 010 9999");
});
