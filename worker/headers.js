export const SITE_ORIGIN = "https://cyber.askgina.ai";

export const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://api.llama.fi https://haveibeenpwned.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests";

export const DISCOVERY_LINKS = [
  '</llms.txt>; rel="describedby"; type="text/markdown"',
  '</.well-known/ard.json>; rel="describedby"; type="application/json"',
  '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"',
  '</feed.xml>; rel="alternate"; type="application/rss+xml"',
  '</sitemap.xml>; rel="sitemap"; type="application/xml"',
];

export function mergeVary(existing, ...tokens) {
  const fields = new Map();
  for (const value of [existing, ...tokens].join(",").split(",")) {
    const token = value.trim();
    if (token === "*") return "*";
    const key = token.toLowerCase();
    if (token && !fields.has(key)) fields.set(key, token);
  }
  return [...fields.values()].join(", ");
}

export function applySecurityHeaders(res, { isHtml = false, isRoot = false, noindex = false, extraHeaders = {} } = {}) {
  const headers = new Headers(res.headers);
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  headers.set("Content-Security-Policy", CSP);
  if (isHtml || isRoot) headers.append("Link", DISCOVERY_LINKS.join(", "));
  if (isRoot) headers.append("Link", `<${SITE_ORIGIN}/index.md>; rel="alternate"; type="text/markdown"`);
  if (noindex) headers.set("X-Robots-Tag", "noindex, nofollow");
  for (const [name, value] of new Headers(extraHeaders)) headers.set(name, value);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export function etagMatches(ifNoneMatch, etag) {
  if (!ifNoneMatch || !etag) return false;
  const field = ifNoneMatch.trim();
  if (field === "*") return true;
  const opaque = etag.replace(/^W\//, "");
  // A comma can be part of an opaque tag. Read each quoted member before its list delimiter.
  const member = /[ \t]*(?:(?:W\/)?("[\x21\x23-\x7e\x80-\xff]*")[ \t]*)?(?:,|$)/y;
  let matched = false;
  while (member.lastIndex < field.length) {
    const m = member.exec(field);
    if (!m) return false;
    if (m[1] === opaque) matched = true;
  }
  return matched;
}
