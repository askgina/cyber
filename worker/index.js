// Cyber on Cloudflare: serves the static site and JSON from R2,
// and runs the hourly build in a Container (cron), storing its outputs and caches in R2.
import { Container, getContainer } from "@cloudflare/containers";
import { applySecurityHeaders, mergeVary, SITE_ORIGIN } from "./headers.js";
import { DATA_ROUTES, handleDataRoute } from "./data.js";

export class Builder extends Container {
  defaultPort = 8080;
  // A build is one long request (2-5 min) and does not renew the idle timer, so this must exceed the longest build
  // (a 3m timeout SIGTERMed the 23:07 cron run). buildOnce() stops the container as soon as outputs are saved.
  sleepAfter = "15m";
}

const OUTPUTS = [
  ["state.tar.gz", "application/gzip"],
  ["data.json", "application/json"],
  ["archive.json", "application/json"],
  // Optional until both the container and the pipeline produce the split. Upload hot last.
  ["data-details.json", "application/json", true],
  ["data-history.json", "application/json", true],
  ["data-hot.json", "application/json", true],
];

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
  const bufs = {};
  const split = [];
  let splitComplete = true;
  for (const [name, type, optional] of OUTPUTS) {
    const o = await c.fetch(new Request("http://builder/out/" + name));
    if (optional && o.status === 404) {
      splitComplete = false;
      continue;
    }
    if (!o.ok) throw new Error(`could not read ${name} from the builder: ${o.status}`);
    const bytes = await o.arrayBuffer();
    if (optional) split.push([name, type, bytes]);
    else {
      await env.STATE.put(name, bytes, { httpMetadata: { contentType: type } });
      if (name === "data.json" || name === "archive.json") bufs[name] = bytes;
    }
  }
  if (splitComplete) {
    for (const [name, type, bytes] of split) {
      await env.STATE.put(name, bytes, { httpMetadata: { contentType: type } });
    }
  }
  try { res.search = await syncSearch(env, c); }
  catch (e) { res.search = { error: String(e) }; console.log("search sync failed", String(e)); }  // the data build still counts as done
  try { res.stats = await emitStats(env, bufs["data.json"], bufs["archive.json"], res); }
  catch (e) { console.log("stats failed", String(e)); }
  console.log("build ok", res.generated, `${res.seconds}s`, `restored ${res.restored_files} cache files`, JSON.stringify(res.search));
  try { await c.stop(); } catch (e) { console.log("container stop failed (it idles out after 15m)", String(e)); }  // don't pay for idle time
  return res;
}

// Headline numbers of the ledger, sent to PostHog after every build (event "ledger_stats") for the Impact dashboard.
async function emitStats(env, dataBuf, archiveBuf, res) {
  if (!env.POSTHOG_KEY || !dataBuf) return null;
  const td = new TextDecoder(), D = JSON.parse(td.decode(dataBuf)), W = (D.windows || {}).rows || {};
  const ytd = (k) => ((W[k] || {}).ytd || {});
  const A = archiveBuf ? (JSON.parse(td.decode(archiveBuf)).items || []) : [];
  const countries = new Set();
  for (const a of A) { const cc = (a.x || "").split(" · ").pop(); if (/^[A-Z]{2}$/.test(cc)) countries.add(cc); }
  (D.registry || []).forEach((r) => { if (/^[A-Z]{2}$/.test(r.country || "")) countries.add(r.country); });
  const s = {
    records_ytd: (W.archive && W.archive.ytd && W.archive.ytd.n) || 0,
    crypto_hacks_ytd: ytd("crypto").n || 0, crypto_usd_ytd: Math.round(ytd("crypto").usd || 0),
    ransomware_claims_ytd: ytd("ransomware").n || 0, exploited_vulns_ytd: ytd("kev").n || 0,
    breaches_ytd: ytd("breach").n || 0, breached_accounts_ytd: ytd("breach").acc || 0,
    curated_incidents_ytd: ytd("incidents").n || 0, official_notices_ytd: ytd("notices").n || 0,
    countries_affected: countries.size,
    news_outlets_indexed: new Set((D.news || []).map((n) => n.source)).size, news_stories_indexed: (D.news || []).length,
    x_signals: (D.x || []).length, x_posts_analysed: (D.x || []).reduce((t, x) => t + ((x.posts || []).length), 0),
    searchable_documents: (res.search && res.search.files) || 0, build_seconds: res.seconds || 0,
  };
  await fetch("https://eu.i.posthog.com/i/v0/e/", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: env.POSTHOG_KEY, event: "ledger_stats", properties: { distinct_id: "cyber-ledger", app: "cyber", $process_person_profile: false, ...s } }) });
  return s;
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

async function handleSearch(req, env, ctx, url) {
  const q = (url.searchParams.get("q") || "").trim().replace(/\s+/g, " ").slice(0, 300);
  if (q.length < 3) return Response.json({ results: [] });
  // Identical queries are cached for 5 minutes; new ones are limited per IP (AI Search is metered).
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
  } catch (e) {
    console.log("search failed", String(e));
    return Response.json({ results: [], error: "search unavailable" }, { status: 502 });
  }
}

function prefersMarkdown(accept) {
  const weights = new Map();
  for (const range of (accept || "").toLowerCase().split(",")) {
    const [type, ...params] = range.split(";").map((part) => part.trim());
    const q = params.map((param) => /^q\s*=\s*(.*)$/.exec(param)).find(Boolean);
    const weight = q ? Number(q[1]) : 1;
    if (weight >= 0 && weight <= 1) weights.set(type, Math.max(weights.get(type) ?? 0, weight));
  }
  const wildcard = weights.get("text/*") ?? weights.get("*/*") ?? 0;
  const html = weights.get("text/html") ?? wildcard;
  const markdown = weights.get("text/markdown") ?? wildcard;
  return markdown > 0 && (markdown > html || (markdown === html && weights.has("text/markdown") && !weights.has("text/html")));
}

async function notFound(req, env, url) {
  const isMd = url.pathname === "/404.md" || prefersMarkdown(req.headers.get("accept"));
  const isHead = req.method === "HEAD";
  const asset = (path) => env.ASSETS.fetch(new Request(new URL(path, url), { method: isHead ? "HEAD" : "GET" }));
  let page = await asset(isMd ? "/404.md" : "/404.html");
  // With automatic trailing slashes, ASSETS redirects /404.html to /404.
  if (!isMd && page.status === 307) page = await asset("/404");
  // The templates may not exist yet during rollout. Return a useful 404 either way.
  const fallback = isMd ? "# Not found\n\n[Return to Cyber](/)\n" :
    '<!doctype html><html lang="en"><meta charset="utf-8"><title>Not found | Cyber</title><h1>Not found</h1><p><a href="/">Return to Cyber</a></p></html>';
  return applySecurityHeaders(new Response(isHead ? null : (page.ok ? page.body : fallback), {
    status: 404,
    headers: {
      "Content-Type": isMd ? "text/markdown; charset=utf-8" : "text/html; charset=utf-8",
      Vary: mergeVary(page.ok ? page.headers.get("Vary") : null, "Accept"),
    },
  }), { isHtml: !isMd, noindex: true });
}

// ---- Analytics: no cookies, no stored IPs. Page loads are counted here (works with VPNs and ad blockers);
// the page sends a few named events to /e on our own domain. Both go to Analytics Engine and, if POSTHOG_KEY is set,
// to PostHog EU (project "cyber").
const BOT = /bot|crawl|spider|slurp|preview|monitor|headless|lighthouse|curl|wget|python|httpclient|go-http|java\//i;
const EVENTS = new Set(["view", "open_record", "palette_open", "palette_pick", "ask_click", "theme"]);
function device(ua) { return /mobile|iphone|android/i.test(ua) ? "mobile" : /ipad|tablet/i.test(ua) ? "tablet" : "desktop"; }
// Anonymous visitor ids, one per period: HMAC(secret, period key | IP | user agent). Nothing is stored on the device and
// no IP is kept; ids reset every day/week/month, so uniques can be counted per period but a person cannot be followed
// across periods. Approximate: visitors sharing an IP and browser (office NAT, VPN exit) count once.
async function visitorIds(env, req, ua) {
  if (!env.VISITOR_SECRET) return {};
  const ip = req.headers.get("cf-connecting-ip") || "";
  const d = new Date(), day = d.toISOString().slice(0, 10), month = day.slice(0, 7);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const week = `${t.getUTCFullYear()}-W${String(Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7)).padStart(2, "0")}`;  // ISO week
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.VISITOR_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const h = async (p) => [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${p}|${ip}|${ua}`)))].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
  return { visitor_day: await h("d" + day), visitor_week: await h("w" + week), visitor_month: await h("m" + month) };
}

async function track(env, ctx, req, event, props = {}, distinctId = null) {
  const ua = req.headers.get("user-agent") || "";
  if (BOT.test(ua)) return;
  const country = (req.cf && req.cf.country) || "XX";
  let ref = "";
  try { const r = req.headers.get("referer"); if (r) { const h = new URL(r).hostname; if (h !== new URL(req.url).hostname) ref = h; } } catch {}
  const dev = device(ua);
  const vid = await visitorIds(env, req, ua);
  env.EVENTS.writeDataPoint({ indexes: [event], blobs: [event, country, ref, dev, String(props.view || props.kind || props.via || ""), vid.visitor_day || "", vid.visitor_week || "", vid.visitor_month || ""], doubles: [1, Number(props.qlen) || 0] });
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
        properties: { distinct_id: did, ...props, ...web, ...vid, app: "cyber", $process_person_profile: false, $geoip_disable: true,
          $geoip_country_code: country, $device_type: dev[0].toUpperCase() + dev.slice(1), $browser: browser, $os: os, country, referrer_host: ref || null } }),
    }).catch(() => {}));
  }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const { pathname } = url;
    if (pathname === "/index.html" || pathname === "/index" || pathname === "/index/") {
      return applySecurityHeaders(Response.redirect(`${SITE_ORIGIN}/`, 301));
    }
    if (pathname === "/") {
      // Count page loads server-side (the HTML document, not assets).
      if (req.method === "GET" && (req.headers.get("sec-fetch-dest") || "document") === "document") {
        ctx.waitUntil(track(env, ctx, req, "pageload"));
      }
      return applySecurityHeaders(await env.ASSETS.fetch(req), { isHtml: true, isRoot: true });
    }
    if (Object.hasOwn(DATA_ROUTES, pathname)) return handleDataRoute(req, env, pathname);
    if (pathname === "/api/search") {
      return applySecurityHeaders(await handleSearch(req, env, ctx, url), { noindex: true });
    }
    if (pathname === "/e" && req.method === "POST") {
      const ip = req.headers.get("cf-connecting-ip") || "unknown";
      const { success } = await env.EVENT_LIMIT.limit({ key: ip });
      if (!success) return new Response(null, { status: 204 });
      try {
        const b = JSON.parse((await req.text()).slice(0, 2000));
        if (EVENTS.has(b.e)) {
          const p = {};
          for (const [k, v] of Object.entries(b.p || {}).slice(0, 8)) if (/^[a-z_]{1,24}$/.test(k) && ["string", "number", "boolean"].includes(typeof v)) p[k] = typeof v === "string" ? v.slice(0, 80) : v;
          ctx.waitUntil(track(env, ctx, req, b.e, p, typeof b.s === "string" ? b.s.slice(0, 40) : null));
        }
      } catch {}
      return new Response(null, { status: 204 });
    }
    // Manual run (first deploy, or to refresh now). Waits for the build, so the caller sees the result.
    if (pathname === "/__build") {
      if (req.method !== "POST" || !env.BUILD_TOKEN || req.headers.get("authorization") !== `Bearer ${env.BUILD_TOKEN}`) return new Response("Forbidden", { status: 403 });
      try { return Response.json(await runBuild(env)); }
      catch (e) { return Response.json({ ok: false, error: String(e) }, { status: 500 }); }
    }
    if (["/404", "/404/", "/404.html", "/404.md"].includes(pathname)) return notFound(req, env, url);
    const asset = await env.ASSETS.fetch(req);
    return asset.status === 404 ? notFound(req, env, url) : asset;
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBuild(env));
  },
};
