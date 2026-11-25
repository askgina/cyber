const CORE_ROUTES = new Set(["/", "/leaderboard", "/report", "/method", "/api"]);
export const INCIDENT_ROUTE = /^\/incidents\/[a-z0-9][a-z0-9._-]{0,120}$/i;
const PATTERN_ROUTE = /^\/patterns\/[a-z0-9][a-z0-9-]{0,80}$/i;
const DAILY_ROUTE = /^\/daily\/\d{4}-\d{2}-\d{2}$/;

export function normalizePath(pathname) {
  const path = pathname.replace(/\/+$/, "") || "/";
  return path === "/index.html" || path === "/index" ? "/" : path;
}

export function isCoreDocumentRoute(pathname) {
  return CORE_ROUTES.has(pathname);
}

export function isRegisteredDocumentRoute(pathname) {
  return isCoreDocumentRoute(pathname) || INCIDENT_ROUTE.test(pathname) ||
    PATTERN_ROUTE.test(pathname) || DAILY_ROUTE.test(pathname);
}

export function markdownDocumentPath(pathname) {
  if (pathname === "/index.md") return "/";
  if (!pathname.endsWith(".md")) return null;
  const path = pathname.slice(0, -3);
  return isRegisteredDocumentRoute(path) ? path : null;
}

export const LLMS_ROUTES = new Set(["/llms.txt", "/llms-full.txt", "/incidents/llms.txt", "/patterns/llms.txt", "/method/llms.txt"]);

export const PRERENDERED_ASSETS = {
  "/sitemap.xml": "application/xml; charset=utf-8",
  "/feed.xml": "application/rss+xml; charset=utf-8",
  "/feed.json": "application/feed+json; charset=utf-8",
  "/schemamap.xml": "application/xml; charset=utf-8",
  ...Object.fromEntries([...LLMS_ROUTES].map((path) => [path, "text/markdown; charset=utf-8"])),
};

const AGENT_NAMES = [
  "ChatGPT-User", "Claude-User", "Perplexity-User", "ClaudeBot", "Claude-SearchBot",
  "OAI-SearchBot", "PerplexityBot", "Applebot-Extended", "Google-Extended", "Meta-ExternalAgent",
];
export const AI_AGENT_UA = new RegExp(AGENT_NAMES.join("|"), "i");

export function detectAgentName(ua) {
  const match = AI_AGENT_UA.exec(ua || "");
  return match ? AGENT_NAMES.find((name) => name.toLowerCase() === match[0].toLowerCase()) : null;
}
