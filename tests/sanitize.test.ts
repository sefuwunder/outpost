// sanitizeEmailHtml: strips active content, keeps formatting.
import { test, expect } from "bun:test";
import { sanitizeEmailHtml, blockRemoteImages } from "../src/sanitize.ts";
import { decodeMimeHtml } from "../src/imap.ts";

test("strips scripts and event handlers", () => {
  const out = sanitizeEmailHtml(`<div onclick="evil()"><script>alert(1)</script><p>Hello</p></div>`);
  expect(out).not.toContain("<script");
  expect(out).not.toContain("onclick");
  expect(out).toContain("<p>Hello</p>");
});

test("strips javascript: URLs", () => {
  const out = sanitizeEmailHtml(`<a href="javascript:alert(1)">click</a>`);
  expect(out).not.toContain("javascript:");
  expect(out).toContain("click");
});

test("keeps safe formatting", () => {
  const out = sanitizeEmailHtml(`<p style="color:red"><b>Hi</b> <a href="https://example.com">link</a></p>`);
  expect(out).toContain("<b>Hi</b>");
  expect(out).toContain('href="https://example.com"');
});

test("blockRemoteImages neutralizes tracking pixels, keeps data: embeds", () => {
  const html = `<img src="https://tracker.example/pixel.gif" alt="t"><img src="data:image/png;base64,AAA" alt="e">`;
  const { html: out, blocked } = blockRemoteImages(html);
  expect(blocked).toBe(1);
  expect(out).not.toContain("tracker.example");
  expect(out).toContain("data:image/png;base64,AAA");
});

test("decodeMimeHtml extracts and decodes the html part", () => {
  const raw = [
    "Content-Type: multipart/alternative; boundary=\"b1\"",
    "",
    "--b1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "plain version",
    "--b1",
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "<p>Hello=20world</p>",
    "--b1--",
  ].join("\r\n");
  const html = decodeMimeHtml(raw);
  expect(html).toContain("<p>Hello world</p>");
});

test("decodeMimeHtml returns null when no html part", () => {
  const raw = "Content-Type: text/plain\r\n\r\njust text";
  expect(decodeMimeHtml(raw)).toBeNull();
});
