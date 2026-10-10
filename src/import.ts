// outpost — vCard import: parse, dedupe against existing contacts, create.

import { parseVcf, pickEmail, pickPhone, type VCard } from "./vcf";
import {
  createContact, conversationFor, findContactByEmail, findContactByPhone,
  type Contact,
} from "./db";

export interface ImportResult {
  total: number;
  imported: Contact[];
  skipped: Array<{ name: string; reason: "duplicate" | "empty" }>;
}

export function importContactsFromVcf(vcfText: string): ImportResult {
  const cards = parseVcf(vcfText);
  const result: ImportResult = { total: cards.length, imported: [], skipped: [] };
  for (const card of cards) {
    const email = pickEmail(card);
    const phone = pickPhone(card);
    const name = card.name || email || phone;
    if (!name) { result.skipped.push({ name: "", reason: "empty" }); continue; }
    if ((email && findContactByEmail(email)) || (phone && findContactByPhone(phone))) {
      result.skipped.push({ name, reason: "duplicate" });
      continue;
    }
    const c = createContact({ name, email, phone, notes: card.note });
    conversationFor(c.id);
    result.imported.push(c);
  }
  return result;
}
