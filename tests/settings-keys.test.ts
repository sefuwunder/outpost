// Settings round-trip guard: every user-facing key must be both saveable
// (SETTING_KEYS) and readable (NON_SECRET); secrets must never be readable.
// (Regression: llm_* and e2ee_* keys silently failed to round-trip.)
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "../src/server.ts"), "utf8");
const keysOf = (name: string) => {
  const m = src.match(new RegExp(`const ${name} = (?:new Set\\()?\\[([\\s\\S]*?)\\]\\)?;`));
  if (!m) throw new Error(name + " not found");
  return [...m[1].matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1]);
};
const settingKeys = keysOf("SETTING_KEYS");
const nonSecret = keysOf("NON_SECRET");

const VISIBLE = [
  "imap_host", "imap_port", "imap_user",
  "smtp_host", "smtp_port", "smtp_user", "smtp_from", "smtp_secure",
  "matrix_homeserver", "matrix_user_id",
  "e2ee_url", "e2ee_handle",
  "llm_url", "llm_model", "llm_enabled", "llm_threshold", "llm_timeout",
];
const SECRET = ["imap_pass", "smtp_pass", "matrix_token", "e2ee_token"];

test("every user-facing setting is saveable and readable", () => {
  for (const k of VISIBLE) {
    expect(settingKeys, k).toContain(k);
    expect(nonSecret, k).toContain(k);
  }
});

test("secrets are saveable but never readable", () => {
  for (const k of SECRET) {
    expect(settingKeys, k).toContain(k);
    expect(nonSecret, k).not.toContain(k);
  }
});

test("server keeps long LLM passes alive (no idle-timeout drop)", () => {
  // Regression: Bun's default ~10s idle timeout closed consult/idle-learn
  // connections mid-generation (curl 52 "Empty reply from server").
  // 0 disables it (verified: a 15s idle request survives); Bun rejects >255.
  const mm = src.match(/Bun\.serve\(\{[\s\S]*?idleTimeout:\s*(\d+)/);
  expect(mm, "idleTimeout set on Bun.serve").toBeTruthy();
  expect(Number(mm![1])).toBe(0);
});
