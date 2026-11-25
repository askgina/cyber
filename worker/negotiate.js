import { mergeVary, SITE_ORIGIN } from "./headers.js";

export const MARKDOWN = "text/markdown; charset=utf-8";
const READER_UA = /ChatGPT-User|Claude-User|Perplexity-User|ClaudeBot|OAI-SearchBot|PerplexityBot/i;

export function prefersMarkdown(req) {
  const accept = req.headers.get("Accept");
  const weights = new Map();
  for (const range of (accept || "*/*").match(/(?:"(?:[^"\\]|\\.)*"|[^,"])+/g) || []) {
    const [type, ...params] = (range.match(/(?:"(?:[^"\\]|\\.)*"|[^;"])+/g) || []).map((part) => part.trim().toLowerCase());
    const q = params.map((param) => /^q\s*=\s*(.*)$/.exec(param)).find(Boolean);
    // Also accept the commonly used shorthand .8.
    if (q && !/^(?:0?(?:\.\d{1,3})|0\.?|1(?:\.0{0,3})?)$/.test(q[1])) continue;
    weights.set(type, Math.max(weights.get(type) ?? 0, q ? Number(q[1]) : 1));
  }
  const wildcard = weights.get("text/*") ?? weights.get("*/*") ?? 0;
  const html = weights.get("text/html") ?? wildcard;
  const markdown = weights.get("text/markdown") ?? wildcard;
  if (markdown > html) return true;
  // A range for another type is not an explicit Markdown veto. A matching
  // q=0 is, even if a less specific wildcard has a positive weight.
  const veto = (weights.get("text/markdown") ?? weights.get("text/*") ?? weights.get("*/*")) === 0;
  return html <= markdown && !veto && READER_UA.test(req.headers.get("User-Agent") || "");
}

export function documentHeaders(existing, pathname, markdown, tokens) {
  const extra = new Headers({ Vary: mergeVary(existing.get("Vary"), "Accept", "User-Agent") });
  if (markdown) {
    extra.set("Content-Type", MARKDOWN);
    if (tokens !== undefined) extra.set("x-markdown-tokens", String(tokens));
  }
  const path = markdown ? pathname : pathname === "/" ? "/index.md" : `${pathname}.md`;
  const link = markdown ? `<${SITE_ORIGIN}${path}>; rel="canonical"` : `<${SITE_ORIGIN}${path}>; rel="alternate"; type="text/markdown"`;
  extra.set("Link", [existing.get("Link"), link].filter(Boolean).join(", "));
  return extra;
}

export function markdownTokens(text) {
  return Math.ceil(text.length / 4);
}
