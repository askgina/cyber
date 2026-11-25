import { applySecurityHeaders, SITE_ORIGIN } from "./headers.js";
import { loadPagesManifest } from "./pages.js";
import { INCIDENT_ROUTE } from "./routes.js";

const DIRECT_REF = /^(?:r|n|x|c|k|b)-/;
const maps = new WeakMap();

async function loadSearchRefs(env, entry) {
  if (!entry?.key || !entry.sha) return {};
  const cached = maps.get(env);
  if (cached?.sha === entry.sha && cached.key === entry.key) return cached.refs;
  const object = await env.STATE.get(`pages/${entry.key}`);
  if (!object) return {};
  const refs = await object.json();
  maps.set(env, { key: entry.key, sha: entry.sha, refs });
  return refs;
}

async function attachRoutes(env, results) {
  const manifest = await loadPagesManifest(env);
  const refs = results.some(({ ref }) => ref?.startsWith("a:")) ? await loadSearchRefs(env, manifest?.internal?.search_refs) : {};
  return results.map((result) => {
    const { ref } = result;
    const id = ref?.startsWith("a:") ? refs[ref] : DIRECT_REF.test(ref || "") ? ref : null;
    const path = `/incidents/${id}`;
    const route = typeof id === "string" && INCIDENT_ROUTE.test(path) && !manifest?.retired?.[path] && manifest?.routes?.[path];
    return { ...result, url: route ? SITE_ORIGIN + path : null, scope: route?.scope === "live" || route?.scope === "archive" ? route.scope : null };
  });
}

async function search(env, q) {
  const r = await env.AI_SEARCH.search({
    query: q,
    ai_search_options: { retrieval: { retrieval_type: "hybrid", max_num_results: 12, keyword_match_mode: "or" }, reranking: { enabled: true } },
  });
  const seen = new Set(), out = [];
  for (const ch of r.chunks || []) {
    const [kind, day] = (ch.item?.key || "").replace(/\.md$/, "").split("/");
    const heading = ((ch.text || "").match(/^#\s+(.+)$/m) || [])[1];
    if (!heading || seen.has(heading)) continue;
    seen.add(heading);
    const body = (ch.text || "").split(/^#\s+.+$/m)[1] || "";
    const ref = ((body.match(/^Record:[ \t]*(.+)$/m) || [])[1] || "").trim() || null;
    out.push({ title: heading.trim(), ref, kind, date: day, score: Math.round((ch.score || 0) * 100) / 100, snippet: body.replace(/^Record:.*$/m, "").replace(/\s+/g, " ").trim().slice(0, 160) });
    if (out.length >= 8) break;
  }
  return out;
}

// Per-IP per-minute policy from wrangler.jsonc: 60 requests, of which at most 10 may miss the cache.
// The binding reports only success, so the response advertises the policy rather than a made-up remainder.
const RATE_LIMIT_HEADERS = {
  "RateLimit-Limit": "60",
  "RateLimit-Reset": "60",
  "RateLimit-Policy": '"search";q=60;w=60, "search-miss";q=10;w=60',
};

function reply(results, { status = 200, error, headers } = {}) {
  const response = Response.json(error ? { results, error } : { results }, { status, headers });
  return applySecurityHeaders(response, { noindex: true, extraHeaders: { ...RATE_LIMIT_HEADERS, "Cache-Control": "no-store", ...headers } });
}

const rateLimited = () => reply([], { status: 429, error: "rate limited", headers: { "Retry-After": "60" } });

export function apiNotFound() {
  return applySecurityHeaders(Response.json({ error: "not found" }, { status: 404, headers: RATE_LIMIT_HEADERS }), { noindex: true });
}

export async function handleSearch(req, env, ctx, url) {
  if (req.method !== "GET") return reply([], { status: 405, error: "method not allowed", headers: { Allow: "GET" } });
  const q = (url.searchParams.get("q") || "").trim().replace(/\s+/g, " ").slice(0, 300);
  const ip = req.headers.get("cf-connecting-ip") || "unknown";
  try {
    if (!(await env.SEARCH_REQ_LIMIT.limit({ key: ip })).success) return rateLimited();
    if (q.length < 3) return reply([]);
    const cacheKey = new Request(`${url.origin}/api/search?q=${encodeURIComponent(q.toLowerCase())}&v=2`);
    const cached = await caches.default.match(cacheKey);
    if (cached) return reply(await attachRoutes(env, (await cached.json()).results));
    if (!(await env.SEARCH_LIMIT.limit({ key: ip })).success) return rateLimited();
    const results = await search(env, q);
    const response = reply(await attachRoutes(env, results));
    // Cache the raw search result, not the manifest's current active links.
    const stored = Response.json({ results }, { headers: { "Cache-Control": "public, max-age=300" } });
    ctx.waitUntil(caches.default.put(cacheKey, stored).catch((error) => console.log("search cache write failed", String(error))));
    return response;
  } catch (e) {
    console.log("search failed", String(e));
    return reply([], { status: 502, error: "search unavailable" });
  }
}
