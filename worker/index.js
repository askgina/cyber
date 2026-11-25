// Cyber on Cloudflare: serves the static site and JSON from R2,
// and runs the hourly build in a Container (cron), storing its outputs and caches in R2.
import { Container, getContainer } from "@cloudflare/containers";
import { applySecurityHeaders, SITE_ORIGIN } from "./headers.js";
import { DATA_ROUTES, handleDataRoute } from "./data.js";
import { AI_AGENT_UA, isRegisteredDocumentRoute, LLMS_ROUTES, markdownDocumentPath, normalizePath, PRERENDERED_ASSETS } from "./routes.js";
import { serveDocumentRoute, servePrerenderedAsset, syncPages } from "./pages.js";
import { documentHeaders, MARKDOWN, markdownTokens, prefersMarkdown } from "./negotiate.js";
import { handleSearch } from "./search.js";
import { EVENTS, track, trackAgentFetch, trackHumanPageview } from "./analytics.js";

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
];
// Optional as a set. Upload hot last so clients don't start using the new split early.
const SPLIT_OUTPUTS = ["data-details.json", "data-history.json", "data-hot.json"];

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
  for (const [name, type] of OUTPUTS) {
    const o = await c.fetch(new Request("http://builder/out/" + name));
    if (!o.ok) throw new Error(`could not read ${name} from the builder: ${o.status}`);
    const bytes = await o.arrayBuffer();
    await env.STATE.put(name, bytes, { httpMetadata: { contentType: type } });
    if (name === "data.json" || name === "archive.json") bufs[name] = bytes;
  }
  await syncSplitData(env, c);
  try { res.search = await syncSearch(env, c); }
  catch (e) { res.search = { error: String(e) }; console.log("search sync failed", String(e)); }  // the data build still counts as done
  try { res.pages = await syncPages(env, c); }
  catch (e) { res.pages = { error: String(e) }; console.log("pages sync failed", String(e)); }
  try { res.stats = await emitStats(env, bufs["data.json"], bufs["archive.json"], res); }
  catch (e) { console.log("stats failed", String(e)); }
  console.log("build ok", res.generated, `${res.seconds}s`, `restored ${res.restored_files} cache files`, JSON.stringify({ search: res.search, pages: res.pages }));
  try { await c.stop(); } catch (e) { console.log("container stop failed (it idles out after 15m)", String(e)); }  // don't pay for idle time
  return res;
}

async function syncSplitData(env, c) {
  try {
    // Read every part before writing any, including checking that each body can be read.
    const split = [];
    for (const name of SPLIT_OUTPUTS) {
      const response = await c.fetch(new Request("http://builder/out/" + name));
      if (!response.ok) throw new Error(`could not read ${name} from the builder: ${response.status}`);
      split.push([name, await response.arrayBuffer()]);
    }
    for (const [name, bytes] of split) {
      await env.STATE.put(name, bytes, { httpMetadata: { contentType: "application/json" } });
    }
  } catch (e) {
    // Remove stale or partially written split data. data.json is already fresh.
    console.log("split data unavailable; falling back to data.json", String(e));
    await env.STATE.delete(SPLIT_OUTPUTS);
  }
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

async function notFound(req, env, url, isMd = url.pathname === "/404.md" || (canRead(req) && prefersMarkdown(req))) {
  const isHead = req.method === "HEAD";
  const asset = (path) => env.ASSETS.fetch(new Request(new URL(path, url), { method: isHead && !isMd ? "HEAD" : "GET" }));
  let page = await asset(isMd ? "/404.md" : "/404.html");
  // ASSETS redirects /404.html to /404 when stripping HTML extensions.
  if (!isMd && page.status === 307) page = await asset("/404");
  const fallback = isMd ? "# Not found\n\n[Return to Cyber](/)\n" :
    '<!doctype html><html lang="en"><meta charset="utf-8"><title>Not found | Cyber</title><h1>Not found</h1><p><a href="/">Return to Cyber</a></p></html>';
  const body = isMd ? (page.ok ? await page.text() : fallback) : (page.ok ? page.body : fallback);
  const extraHeaders = documentHeaders(page.headers, "/404", isMd, isMd ? markdownTokens(body) : undefined);
  return applySecurityHeaders(new Response(isHead ? null : body, {
    status: 404, headers: { "Content-Type": isMd ? MARKDOWN : "text/html; charset=utf-8" },
  }), { isHtml: !isMd, noindex: true, extraHeaders });
}

function canRead(req) {
  return req.method === "GET" || req.method === "HEAD";
}

function methodNotAllowed() {
  return applySecurityHeaders(new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } }));
}

async function handleDocument(req, env, ctx, url, companion) {
  const target = new URL(url);
  if (companion) target.pathname = companion;
  const pathname = target.pathname;
  const wantMarkdown = Boolean(companion) || prefersMarkdown(req);
  const result = await serveDocumentRoute(req, env, target, { wantMarkdown });
  if (!result.matched) return notFound(req, env, url, wantMarkdown);
  const { response, status } = result;
  if (status < 500 && (wantMarkdown || AI_AGENT_UA.test(req.headers.get("User-Agent") || ""))) {
    trackAgentFetch(env, ctx, req, pathname, wantMarkdown ? "markdown" : "html");
  } else if (status === 200 && /^text\/html(?:\s*;|$)/i.test(response.headers.get("Content-Type") || "")) {
    trackHumanPageview(env, ctx, req, pathname);
  }
  return response;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const { pathname } = url;
    if (Object.hasOwn(PRERENDERED_ASSETS, pathname)) {
      if (!canRead(req)) return methodNotAllowed();
      const response = await servePrerenderedAsset(req, env, pathname);
      if ((response.status === 200 || response.status === 304) && LLMS_ROUTES.has(pathname)) {
        trackAgentFetch(env, ctx, req, pathname, "llms");
      }
      return response;
    }
    const normalized = normalizePath(pathname);
    const registered = isRegisteredDocumentRoute(normalized);
    const companion = markdownDocumentPath(normalized);
    if (registered || companion) {
      if (!canRead(req)) return methodNotAllowed();
      if (normalized !== pathname) {
        return applySecurityHeaders(Response.redirect(`${SITE_ORIGIN}${normalized}${url.search}`, 301));
      }
      return handleDocument(req, env, ctx, url, companion);
    }
    if (Object.hasOwn(DATA_ROUTES, pathname)) return handleDataRoute(req, env, pathname);
    if (pathname === "/api/search") {
      return handleSearch(req, env, ctx, url);
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
          ctx.waitUntil(track(env, req, b.e, p, typeof b.s === "string" ? b.s.slice(0, 40) : null));
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
