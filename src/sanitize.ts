// sanitize.ts — minimal HTML sanitizer for rendering email bodies.
// Zero-dep, regex-based. Defense in depth: output is also rendered inside
// a sandboxed iframe (no scripts, no same-origin), so this layer focuses on
// stripping active content and neutralizing tracking vectors.

const DANGEROUS_TAGS = /<\/?(script|iframe|object|embed|applet|form|base|link|meta|title|head|noscript|noframes|frame|frameset|input|button|select|textarea|video|audio|source|track)\b[^>]*>/gi;

/** Strip event-handler attributes (onclick, onload, ...) and javascript: URLs. */
function stripActiveAttributes(html: string): string {
  // on* attributes (quoted or unquoted)
  let out = html.replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  // javascript: / vbscript: / data:text/html in href/src/action attributes
  out = out.replace(/\s+(href|src|action|xlink:href)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (m, attr, _q, d1, d2, d3) => {
      const v = (d1 ?? d2 ?? d3 ?? "").trim().toLowerCase();
      if (/^(javascript|vbscript|data:text\/html)/.test(v)) return "";
      return m;
    });
  return out;
}

/** Remove HTML comments (can hide conditional Outlook markup, harmless to drop). */
function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * Sanitize an email HTML body for rendering.
 * Returns safe HTML (body content only, no <html>/<head> wrapper).
 */
export function sanitizeEmailHtml(html: string): string {
  if (!html) return "";
  let out = stripComments(html);
  out = out.replace(DANGEROUS_TAGS, "");
  out = stripActiveAttributes(out);
  // Unwrap <html>/<body> to just their content.
  out = out.replace(/<\/?(html|body)\b[^>]*>/gi, "");
  return out.trim();
}

/**
 * Replace remote image sources with a placeholder so tracking pixels and
 * remote loads are blocked by default. data: and cid: images are kept.
 * Returns { html, blocked } where blocked is the count of neutralized images.
 */
export function blockRemoteImages(html: string): { html: string; blocked: number } {
  let blocked = 0;
  const out = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const srcM = tag.match(/\ssrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i);
    if (!srcM) return tag;
    const raw = srcM[1].replace(/^["']|["']$/g, "");
    const v = raw.trim().toLowerCase();
    // Keep embedded (data:) and attached (cid:) images; block everything remote.
    if (/^(data:image\/|cid:)/.test(v)) return tag;
    blocked++;
    const altM = tag.match(/\salt\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i);
    const alt = altM ? altM[1].replace(/^["']|["']$/g, "") : "image";
    return `<span class="blocked-img">🖼 ${alt.replace(/</g, "&lt;")}</span>`;
  });
  return { html: out, blocked };
}
