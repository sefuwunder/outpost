// Channel-pick regression tests: the 15s thread auto-refresh used to reset
// state.channel to the first available channel, silently flipping a user's
// "encrypted" pick back to "matrix" before they hit send.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "../public/app.js"), "utf8");

// Extract the real shipped function and eval it (pure — no DOM needed).
const m = src.match(/function resolveChannel\(channels, current, switching\) \{[\s\S]*?\n\}/);
if (!m) throw new Error("resolveChannel not found in app.js");
const resolveChannel = eval(`(${m[0].replace(/^function resolveChannel/, "function")})`);

test("refresh keeps the user's encrypted pick", () => {
  expect(resolveChannel(["matrix", "encrypted"], "encrypted", false)).toBe("encrypted");
});

test("opening a new thread defaults to the first channel", () => {
  expect(resolveChannel(["matrix", "encrypted"], "encrypted", true)).toBe("matrix");
  expect(resolveChannel(["email", "encrypted"], null, true)).toBe("email");
});

test("a pick that is no longer available falls back", () => {
  expect(resolveChannel(["matrix"], "encrypted", false)).toBe("matrix");
  expect(resolveChannel([], "encrypted", false)).toBeNull();
});

test("the /send endpoint accepts the encrypted channel", () => {
  const srv = readFileSync(join(import.meta.dir, "../src/server.ts"), "utf8");
  const mm = srv.match(/\["email", "sms", "matrix", "encrypted"\]\.includes\(channel\)/);
  expect(mm, "send endpoint allowlist includes encrypted").toBeTruthy();
});
