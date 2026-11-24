// Breach Ledger on Cloudflare: serves the static site, serves data.json/archive.json from R2,
// and runs the hourly build in a Container (cron), storing its outputs and caches in R2.
import { Container, getContainer } from "@cloudflare/containers";

export class Builder extends Container {
  defaultPort = 8080;
  // Stops the container 3 minutes after the last request finishes (in-flight requests keep it alive).
  sleepAfter = "3m";
}

const DATA = { "/data.json": "data.json", "/archive.json": "archive.json" };
const OUTPUTS = [["state.tar.gz", "application/gzip"], ["data.json", "application/json"], ["archive.json", "application/json"]];

// After a deploy, Cloudflare swaps the Builder's new code in lazily and resets any request in flight at that moment.
// Retry once in that case; any other failure is reported.
async function runBuild(env) {
  try { return await buildOnce(env); }
  catch (e) {
    if (!/reset because its code was updated/i.test(String(e))) throw e;
    console.log("builder was reset by a code update; retrying once");
    return await buildOnce(env);
  }
}

async function buildOnce(env) {
  const c = getContainer(env.BUILDER, "hourly-v2");  // v2: fresh instance on the search-docs image
  const state = await env.STATE.get("state.tar.gz");
  const r = await c.fetch(new Request("http://builder/run", { method: "POST", body: state ? await state.arrayBuffer() : null }));
  const res = await r.json().catch(() => ({ ok: false, error: "bad response" }));
  if (!r.ok || !res.ok) throw new Error(`build failed (${r.status}): ${JSON.stringify(res).slice(0, 2000)}`);
  for (const [name, type] of OUTPUTS) {
    const o = await c.fetch(new Request("http://builder/out/" + name));
    if (!o.ok) throw new Error(`could not read ${name} from the builder: ${o.status}`);
    await env.STATE.put(name, await o.arrayBuffer(), { httpMetadata: { contentType: type } });
  }
  try { res.search = await syncSearch(env, c); }
  catch (e) { res.search = { error: String(e) }; console.log("search sync failed", String(e)); }  // the data build still counts as done
  console.log("build ok", res.generated, `${res.seconds}s`, `restored ${res.restored_files} cache files`, JSON.stringify(res.search));
  return res;
}

// AI Search: upload only search documents whose content changed, delete ones that no longer exist,
// then start an indexing job so changes are searchable within the hour (the default R2 sync is daily).
async function syncSearch(env, c) {
  const m = await c.fetch(new Request("http://builder/out/search/manifest.json"));
  if (!m.ok) return { skipped: "no search documents" };
  const manifest = await m.json();
  const prevObj = await env.STATE.get("search-manifest.json");
  const prev = prevObj ? await prevObj.json() : {};
  const changed = Object.keys(manifest).filter((k) => prev[k] !== manifest[k]);
  const stale = [];
  let cursor;
  do {  // list the bucket, so files from older layouts are removed too
    const page = await env.SEARCH_DOCS.list({ cursor, limit: 1000 });
    page.objects.forEach((o) => { if (!(o.key in manifest)) stale.push(o.key); });
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  for (let i = 0; i < changed.length; i += 200) {
    const keys = changed.slice(i, i + 200);
    const b = await c.fetch(new Request("http://builder/out/search/bundle", { method: "POST", body: JSON.stringify(keys) }));
    const files = await b.json();
    const entries = Object.entries(files);
    for (let j = 0; j < entries.length; j += 8)  // at most 8 uploads at a time
      await Promise.all(entries.slice(j, j + 8).map(([k, text]) => env.SEARCH_DOCS.put(k, text, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } })));
  }
  for (let i = 0; i < stale.length; i += 1000) await env.SEARCH_DOCS.delete(stale.slice(i, i + 1000));
  let job = null;
  if (changed.length || stale.length) job = (await env.AI_SEARCH.jobs.create({ description: `hourly: ${changed.length} changed, ${stale.length} removed` }))?.id ?? "started";
  await env.STATE.put("search-manifest.json", JSON.stringify(manifest), { httpMetadata: { contentType: "application/json" } });
  return { files: Object.keys(manifest).length, changed: changed.length, removed: stale.length, job };
}

// Search by meaning over the ledger (⌘K). Returns record headings, so the page can link back to the record.
async function search(env, q) {
  const r = await env.AI_SEARCH.search({
    query: q,
    ai_search_options: { retrieval: { retrieval_type: "hybrid", max_num_results: 12, keyword_match_mode: "or" }, reranking: { enabled: true } },
  });
  const seen = new Set(), out = [];
  for (const ch of r.chunks || []) {
    const key = ch.item && ch.item.key || "";
    const [kind, day] = key.replace(/\.md$/, "").split("/");
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

// ---- Analytics: no cookies, no stored IPs. Page loads are counted here (works with VPNs and ad blockers);
// the page sends a few named events to /e on our own domain. Both go to Analytics Engine and, if POSTHOG_KEY is set,
// to PostHog EU (project "cyber").
const BOT = /bot|crawl|spider|slurp|preview|monitor|headless|lighthouse|curl|wget|python|httpclient|go-http|java\//i;
const EVENTS = new Set(["view", "open_record", "palette_open", "palette_pick", "ask_click", "theme"]);
function device(ua) { return /mobile|iphone|android/i.test(ua) ? "mobile" : /ipad|tablet/i.test(ua) ? "tablet" : "desktop"; }
function track(env, ctx, req, event, props = {}, distinctId = null) {
  const ua = req.headers.get("user-agent") || "";
  if (BOT.test(ua)) return;
  const country = (req.cf && req.cf.country) || "XX";
  let ref = "";
  try { const r = req.headers.get("referer"); if (r) { const h = new URL(r).hostname; if (h !== new URL(req.url).hostname) ref = h; } } catch {}
  const dev = device(ua);
  env.EVENTS.writeDataPoint({ indexes: [event], blobs: [event, country, ref, dev, String(props.view || props.kind || props.via || "")], doubles: [1, Number(props.qlen) || 0] });
  if (env.POSTHOG_KEY) {
    const did = distinctId || crypto.randomUUID();
    const host = new URL(req.url).hostname;
    const browser = /edg\//i.test(ua) ? "Edge" : /firefox\//i.test(ua) ? "Firefox" : /chrome\//i.test(ua) ? "Chrome" : /safari\//i.test(ua) ? "Safari" : "Other";
    const os = /iphone|ipad|ios/i.test(ua) ? "iOS" : /android/i.test(ua) ? "Android" : /mac os/i.test(ua) ? "Mac OS X" : /windows/i.test(ua) ? "Windows" : /linux/i.test(ua) ? "Linux" : "Other";
    // Real page loads (counted on the server) become PostHog pageviews, so its built-in Web analytics charts work.
    // View changes inside the app stay as the separate "view" event, so they don't inflate pageviews.
    const isLoad = event === "pageload";
    const web = isLoad ? { $current_url: `https://${host}/`, $pathname: "/", $host: host,
      $referring_domain: ref || "$direct", $referrer: ref ? "https://" + ref + "/" : "$direct" } : {};
    ctx.waitUntil(fetch("https://eu.i.posthog.com/i/v0/e/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: env.POSTHOG_KEY, event: isLoad ? "$pageview" : event,
        properties: { distinct_id: did, ...props, ...web, app: "cyber", $process_person_profile: false, $geoip_disable: true,
          $geoip_country_code: country, $device_type: dev[0].toUpperCase() + dev.slice(1), $browser: browser, $os: os, country, referrer_host: ref || null } }),
    }).catch(() => {}));
  }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/e" && req.method === "POST") {
      const ip = req.headers.get("cf-connecting-ip") || "unknown";
      const { success } = await env.EVENT_LIMIT.limit({ key: ip });
      if (!success) return new Response(null, { status: 204 });
      try {
        const b = JSON.parse((await req.text()).slice(0, 2000));
        if (EVENTS.has(b.e)) {
          const p = {};
          for (const [k, v] of Object.entries(b.p || {}).slice(0, 8)) if (/^[a-z_]{1,24}$/.test(k) && ["string", "number", "boolean"].includes(typeof v)) p[k] = typeof v === "string" ? v.slice(0, 80) : v;
          track(env, ctx, req, b.e, p, typeof b.s === "string" ? b.s.slice(0, 40) : null);
        }
      } catch {}
      return new Response(null, { status: 204 });
    }
    // count page loads server-side (the HTML document, not assets)
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html") && (req.headers.get("sec-fetch-dest") || "document") === "document") {
      track(env, ctx, req, "pageload");
    }
    const key = DATA[url.pathname];
    if (key) {
      const o = await env.STATE.get(key);
      if (!o) return new Response("Not built yet", { status: 503 });
      return new Response(o.body, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache", etag: o.httpEtag } });
    }
    if (url.pathname === "/api/search") {
      const q = (url.searchParams.get("q") || "").trim().replace(/\s+/g, " ").slice(0, 300);
      if (q.length < 3) return Response.json({ results: [] });
      // identical queries are served from the edge cache for 5 minutes; new ones are limited per IP (AI Search is metered)
      const cacheKey = new Request(`${url.origin}/api/search?q=${encodeURIComponent(q.toLowerCase())}`);
      const cached = await caches.default.match(cacheKey);
      if (cached) return cached;
      const ip = req.headers.get("cf-connecting-ip") || "unknown";
      const { success } = await env.SEARCH_LIMIT.limit({ key: ip });
      if (!success) return Response.json({ results: [], error: "too many searches, try again in a minute" }, { status: 429 });
      try {
        const res = Response.json({ results: await search(env, q) }, { headers: { "cache-control": "public, max-age=300" } });
        ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
        return res;
      } catch (e) { console.log("search failed", String(e)); return Response.json({ results: [], error: "search unavailable" }, { status: 502 }); }
    }
    // Manual run (first deploy, or to refresh now). Waits for the build, so the caller sees the result.
    if (url.pathname === "/__build") {
      if (req.method !== "POST" || !env.BUILD_TOKEN || req.headers.get("authorization") !== `Bearer ${env.BUILD_TOKEN}`) return new Response("Forbidden", { status: 403 });
      try { return Response.json(await runBuild(env)); }
      catch (e) { return Response.json({ ok: false, error: String(e) }, { status: 500 }); }
    }
    return env.ASSETS.fetch(req);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBuild(env));
  },
};
