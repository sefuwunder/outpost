// outpost — vCard (.vcf) parser. Handles vCard 2.1/3.0/4.0 well enough for
// real-world exports (Apple Contacts, Google Contacts): line folding,
// TYPE params, FN/N fallback, multiple EMAIL/TEL, quoted-printable.

export interface VCardField { value: string; types: string[] }
export interface VCard {
  name: string;
  emails: VCardField[];
  phones: VCardField[];
  note: string;
}

const unescape = (s: string) =>
  s.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");

function decodeQP(s: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "=" && i + 2 < s.length) {
      const h = parseInt(s.slice(i + 1, i + 3), 16);
      if (!Number.isNaN(h)) { bytes.push(h); i += 2; continue; }
    }
    bytes.push(s.charCodeAt(i) & 0xff);
  }
  try { return new TextDecoder("utf-8").decode(new Uint8Array(bytes)); }
  catch { return s; }
}

interface Prop { name: string; params: string[]; value: string }

function parseProp(line: string): Prop | null {
  const ci = line.indexOf(":");
  if (ci < 0) return null;
  const head = line.slice(0, ci);
  let value = line.slice(ci + 1);
  const parts = head.split(";");
  const name = parts[0].toUpperCase();
  const params = parts.slice(1).map((p) => p.toUpperCase());
  const isQP = params.some((p) => p === "ENCODING=QUOTED-PRINTABLE" || p === "ENCODING=Q");
  if (isQP) value = decodeQP(value.replace(/=$/, ""));
  return { name, params, value: unescape(value.trim()) };
}

const typesOf = (p: Prop): string[] => {
  const out: string[] = [];
  for (const pr of p.params) {
    const m = pr.match(/^TYPE=(.+)$/);
    if (m) out.push(...m[1].split(","));
    else if (!pr.includes("=")) out.push(pr); // vCard 2.1 bare types: TEL;CELL:
  }
  return out;
};

function nameFromN(value: string): string {
  const [family, given, middle, prefix, suffix] = value.split(";");
  return [prefix, given, middle, family, suffix].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function parseCard(lines: string[]): VCard | null {
  const card: VCard = { name: "", emails: [], phones: [], note: "" };
  const notes: string[] = [];
  for (const line of lines) {
    const prop = parseProp(line);
    if (!prop) continue;
    const types = typesOf(prop);
    if (prop.name === "FN" && !card.name) card.name = prop.value;
    else if (prop.name === "N" && !card.name) card.name = nameFromN(prop.value);
    else if (prop.name === "NICKNAME" && !card.name) card.name = prop.value.split(",")[0].trim();
    else if (prop.name === "EMAIL" && prop.value.includes("@")) card.emails.push({ value: prop.value, types });
    else if (prop.name === "TEL" && /\d/.test(prop.value)) card.phones.push({ value: prop.value, types });
    else if (prop.name === "NOTE" && prop.value) notes.push(prop.value);
  }
  card.note = notes.join("\n");
  if (!card.name && !card.emails.length && !card.phones.length) return null;
  return card;
}

/** Parse a .vcf file into vCards (one per BEGIN:VCARD…END:VCARD block). */
export function parseVcf(text: string): VCard[] {
  const unfolded = text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "");
  const cards: VCard[] = [];
  let current: string[] | null = null;
  for (const raw of unfolded.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^BEGIN:VCARD$/i.test(line)) { current = []; continue; }
    if (/^END:VCARD$/i.test(line)) {
      if (current) { const c = parseCard(current); if (c) cards.push(c); }
      current = null; continue;
    }
    if (current) current.push(line);
  }
  return cards;
}

/** Preferred email: TYPE=PREF first, else first. */
export function pickEmail(card: VCard): string {
  const pref = card.emails.find((e) => e.types.includes("PREF"));
  return (pref || card.emails[0])?.value.trim().toLowerCase() || "";
}

/** Preferred phone: TYPE=PREF, else CELL, else first. Digits kept, leading + noted. */
export function pickPhone(card: VCard): string {
  const pref = card.phones.find((p) => p.types.includes("PREF"))
    || card.phones.find((p) => p.types.includes("CELL"))
    || card.phones[0];
  return pref?.value.trim() || "";
}
