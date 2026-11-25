import { applySecurityHeaders, etagMatches, mergeVary, SITE_ORIGIN } from "./headers.js";
import { documentHeaders, MARKDOWN, markdownTokens } from "./negotiate.js";
import { INCIDENT_ROUTE, isCoreDocumentRoute, PRERENDERED_ASSETS } from "./routes.js";

const MANIFEST_KEY = "pages-manifest.json";
const BUNDLES = 3; // Bundle downloads in flight while their objects upload.
const TTL_MS = 60_000;
const HTML = "text/html; charset=utf-8";
const DOCUMENT_CACHE = "public, max-age=0, must-revalidate";
// Keep only parsed data in these caches, not R2 objects, streams, or in-flight promises.
const manifestCache = new WeakMap();
const incidentCache = new WeakMap();

function pageObjects(manifest) {
  const objects = new Map();
  function add(key, sha, contentType) {
    if (typeof key !== "string" || !key || typeof sha !== "string" || !sha || !contentType) {
      throw new Error("invalid pages manifest object");
    }
    const existing = objects.get(key);
    if (existing && (existing.sha !== sha || existing.contentType !== contentType)) {
      throw new Error(`conflicting pages manifest object: ${key}`);
    }
    objects.set(key, { sha, contentType });
  }
  for (const entry of Object.values(manifest?.routes || {})) {
    add(entry.html, entry.html_sha, HTML);
    add(entry.md, entry.md_sha, MARKDOWN);
  }
  for (const [path, entry] of Object.entries(manifest?.assets || {})) {
    add(entry.key, entry.sha, PRERENDERED_ASSETS[path] || entry.type);
  }
  const searchRefs = manifest?.internal?.search_refs;
  if (searchRefs) add(searchRefs.key, searchRefs.sha, "application/json; charset=utf-8");
  return objects;
}

async function readManifest(env) {
  try {
    const object = await env.STATE.get(MANIFEST_KEY);
    return object ? await object.json() : null;
  } catch (e) {
    // A transient R2 error must not become a 500; without a manifest core routes use static assets.
    console.error("pages manifest read failed", String(e));
    return null;
  }
}

// Each uploaded object records its manifest sha, and R2 lists them cheaply. A sync that is
// cut off part-way (a full one takes minutes) therefore resumes instead of re-uploading
// thousands of objects for a manifest that has not been published yet.
async function storedObjects(env) {
  const stored = new Map();
  let cursor;
  try {
    do {
      const page = await env.STATE.list({ prefix: "pages/", cursor, include: ["customMetadata"] });
      for (const object of page.objects) {
        // An object without a recorded sha (uploaded before this bookkeeping) must be
        // uploaded again, and is still tracked so a dropped route can be deleted.
        const sha = object.customMetadata?.sha;
        stored.set(object.key.slice("pages/".length), sha ? { sha } : {});
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  } catch (e) {
    console.error("pages listing failed", String(e));
    return new Map();
  }
  return stored;
}

export async function syncPages(env, c) {
  const result = await c.fetch(new Request("http://builder/out/pages/manifest.json"));
  if (!result.ok) return { skipped: "no pages manifest" };
  const manifest = await result.json();
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("invalid pages manifest");
  }
  const desired = pageObjects(manifest);
  const published = pageObjects(await readManifest(env));
  const listed = await storedObjects(env);
  // Objects a previous, interrupted run already stored count as done. Published entries win.
  const stored = new Map([...listed, ...published]);
  const changed = [...desired.keys()].filter((key) => stored.get(key)?.sha !== desired.get(key).sha);
  const stale = [...new Set([...published.keys(), ...listed.keys()])].filter((key) => !desired.has(key));

  // Batch order follows the manifest, so an interrupted run resumes where it stopped.
  const batches = [];
  for (let i = 0; i < changed.length; i += 100) batches.push(changed.slice(i, i + 100));
  let next = 0;
  let failure;

  async function drain() {
    while (!failure && next < batches.length) {
      try {
        await uploadBatch(batches[next++]);
      } catch (error) {
        // Stop starting new batches; the lanes already in flight finish what they hold.
        failure ??= error;
      }
    }
  }

  async function uploadBatch(keys) {
    const bundle = await c.fetch(new Request("http://builder/out/pages/bundle", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(keys),
    }));
    if (!bundle.ok) throw new Error(`could not read pages bundle: ${bundle.status}`);
    const files = await bundle.json();
    // The builder omits missing keys. Never publish a manifest with an incomplete bundle.
    for (const key of keys) {
      if (!files || !Object.hasOwn(files, key) || typeof files[key] !== "string") {
        throw new Error(`missing pages bundle object: ${key}`);
      }
    }
    for (let j = 0; j < keys.length; j += 16) {
      const uploads = await Promise.allSettled(keys.slice(j, j + 16).map(async (key) => {
        await env.STATE.put(`pages/${key}`, files[key], {
          httpMetadata: { contentType: desired.get(key).contentType },
          customMetadata: { sha: desired.get(key).sha },
        });
      }));
      const rejected = uploads.find((upload) => upload.status === "rejected");
      if (rejected) throw rejected.reason;
    }
  }

  // A full sync has thousands of objects to move and a build only gets a few minutes for
  // it, so overlap bundle downloads with uploads instead of paying each round trip in turn.
  await Promise.all(Array.from({ length: Math.min(BUNDLES, batches.length) }, drain));
  if (failure) throw failure;

  // Leave the current manifest untouched until every referenced upload has succeeded.
  await env.STATE.put(MANIFEST_KEY, JSON.stringify(manifest), { httpMetadata: { contentType: "application/json" } });
  manifestCache.set(env, { manifest, expires: Date.now() + TTL_MS });
  for (let i = 0; i < stale.length; i += 1000) {
    try { await env.STATE.delete(stale.slice(i, i + 1000).map((key) => `pages/${key}`)); }
    catch (e) { console.log("stale pages cleanup failed", String(e)); }
  }
  return { routes: Object.keys(manifest.routes || {}).length, uploaded: changed.length, deleted: stale.length };
}

export async function loadPagesManifest(env) {
  const cached = manifestCache.get(env);
  if (cached && Date.now() < cached.expires) return cached.manifest;
  const manifest = await readManifest(env);
  const latest = manifestCache.get(env);
  if (latest && latest !== cached && Date.now() < latest.expires) return latest.manifest;
  manifestCache.set(env, { manifest, expires: Date.now() + TTL_MS });
  return manifest;
}

async function readPage(req, env, key, contentType, cacheControl, withTokens = false) {
  if (!key) return null;
  const objectKey = `pages/${key}`;
  const isHead = req.method === "HEAD";
  const condition = req.headers.get("If-None-Match");
  const headers = { "Content-Type": contentType, "Cache-Control": cacheControl };
  try {
    return await readPageObject(env, objectKey, headers, condition, isHead, withTokens);
  } catch (e) {
    // Null means "not served from R2": callers retry a stale manifest or answer a retryable 503.
    console.error("page read failed", String(e));
    return null;
  }
}

async function readPageObject(env, objectKey, headers, condition, isHead, withTokens) {
  if (!withTokens && (isHead || condition)) {
    const head = await env.STATE.head(objectKey);
    if (!head) return null;
    headers.ETag = head.httpEtag;
    if (etagMatches(condition, head.httpEtag)) return new Response(null, { status: 304, headers });
    if (isHead) {
      headers["Content-Length"] = String(head.size);
      return new Response(null, { headers });
    }
  }
  const object = await env.STATE.get(objectKey);
  if (!object) return null;
  headers.ETag = object.httpEtag;
  if (withTokens) {
    // HEAD and conditional GET expose the same token estimate as full Markdown.
    const bytes = await object.arrayBuffer();
    headers["x-markdown-tokens"] = String(markdownTokens(new TextDecoder().decode(bytes)));
    if (etagMatches(condition, object.httpEtag)) return new Response(null, { status: 304, headers });
    if (isHead) headers["Content-Length"] = String(bytes.byteLength);
    return new Response(isHead ? null : bytes, { headers });
  }
  // On GET the object may have been replaced since the conditional HEAD above.
  if (etagMatches(condition, object.httpEtag)) {
    await object.body?.cancel();
    return new Response(null, { status: 304, headers });
  }
  return new Response(object.body, { headers });
}

function isRepresentation(res) {
  return res.ok || res.status === 304;
}

function withoutHeadBody(req, response) {
  return req.method === "HEAD" && response.body ? new Response(null, response) : response;
}

export async function servePrerenderedAsset(req, env, pathname) {
  const manifest = await loadPagesManifest(env);
  const asset = manifest?.assets?.[pathname];
  const contentType = PRERENDERED_ASSETS[pathname];
  const response = await readPage(req, env, asset?.key, contentType, "public, max-age=300") ||
    await env.ASSETS.fetch(req);
  if (response.status === 404) {
    await response.body?.cancel();
    return applySecurityHeaders(new Response(req.method === "HEAD" ? null : "Resource not built yet", {
      status: 503, headers: { "Retry-After": "3600", "Cache-Control": "no-store" },
    }));
  }
  return applySecurityHeaders(withoutHeadBody(req, response), {
    extraHeaders: isRepresentation(response) ? { "Content-Type": contentType } : {},
  });
}

async function liveIncidentExists(env, id) {
  const cached = incidentCache.get(env);
  if (cached && Date.now() < cached.expires) return cached.ids.has(id);
  try {
    const object = await env.STATE.get("data.json");
    const data = object ? await object.json() : null;
    const ids = new Set(Object.keys(data?.details || {}));
    for (const record of data?.registry || []) ids.add(`r-${record.id}`);
    incidentCache.set(env, { ids, expires: Date.now() + TTL_MS });
    return ids.has(id);
  } catch (e) {
    // Unreadable index: let the request fall through to the shell instead of 404ing a live record.
    console.error("live incident index read failed", String(e));
    return true;
  }
}

export async function serveDocumentRoute(req, env, url, { wantMarkdown = false } = {}) {
  const { pathname } = url;
  const contentType = wantMarkdown ? MARKDOWN : HTML;
  const isHead = req.method === "HEAD";
  function matched(response, { robots, isDocument = true, tokens } = {}) {
    const extraHeaders = isDocument ? documentHeaders(response.headers, pathname, wantMarkdown, tokens) :
      new Headers({ Vary: mergeVary(response.headers.get("Vary"), "Accept", "User-Agent") });
    if (robots) extraHeaders.set("X-Robots-Tag", robots);
    if (isDocument && isRepresentation(response)) extraHeaders.set("Cache-Control", DOCUMENT_CACHE);
    return {
      response: applySecurityHeaders(withoutHeadBody(req, response), {
        isHtml: isDocument && !wantMarkdown, extraHeaders,
      }),
      matched: true, status: response.status,
    };
  }

  let manifest = await loadPagesManifest(env);
  for (let attempt = 0; manifest; attempt++) {
    const retired = manifest.retired?.[pathname];
    if (retired?.status === 301 && retired.location) {
      return matched(Response.redirect(SITE_ORIGIN + retired.location, 301), { isDocument: false });
    }
    if (retired?.status === 410) {
      const body = wantMarkdown ? "# Gone\n\nThis page has been retired.\n\n[Return to Cyber](/)\n" :
        '<!doctype html><html lang="en"><meta charset="utf-8"><title>Gone | Cyber</title><h1>Gone</h1><p>This page has been retired.</p><p><a href="/">Return to Cyber</a></p></html>';
      return matched(new Response(isHead ? null : body, {
        status: 410, headers: { "Content-Type": contentType, "Cache-Control": DOCUMENT_CACHE },
      }), { robots: "noindex, nofollow", tokens: wantMarkdown ? markdownTokens(body) : undefined });
    }
    const entry = manifest.routes?.[pathname];
    // A core page added by a deploy answers from its static baseline until a build publishes it;
    // a record newer than the published page set falls through to the live-incident check below.
    if (!entry) {
      if (!isCoreDocumentRoute(pathname) && !INCIDENT_ROUTE.test(pathname)) return { matched: false };
      break;
    }
    const response = await readPage(req, env, wantMarkdown ? entry.md : entry.html, contentType, DOCUMENT_CACHE, wantMarkdown);
    if (response) return matched(response, { robots: entry.index === false ? "noindex, follow" : undefined });
    if (attempt) {
      return matched(new Response(isHead ? null : "Page temporarily unavailable", {
        status: 503, headers: { "Retry-After": "60", "Cache-Control": "no-store" },
      }), { isDocument: false });
    }
    // A cached old manifest may reference a key just cleaned up after a flip. Refresh once.
    if (manifestCache.get(env)?.manifest === manifest) manifestCache.delete(env);
    manifest = await loadPagesManifest(env);
  }

  const core = isCoreDocumentRoute(pathname);
  const live = !wantMarkdown && INCIDENT_ROUTE.test(pathname) && await liveIncidentExists(env, pathname.slice("/incidents/".length));
  if (!core && !live) return { matched: false };
  if (!wantMarkdown) {
    // Assets resolve a path to its `.html` file, so a standalone core page answers directly and
    // everything else degrades to the shell.
    let response = await env.ASSETS.fetch(new Request(url, req));
    if (response.status === 404 && pathname !== "/") {
      await response.body?.cancel();
      response = await env.ASSETS.fetch(new Request(new URL("/", url), req));
    }
    return response.status === 404 ? { matched: false } : matched(response);
  }
  const path = pathname === "/" ? "/index.md" : `${pathname}.md`;
  const response = await env.ASSETS.fetch(new Request(new URL(path, url)));
  if (response.status === 404) return { matched: false };
  if (!response.ok) return matched(response, { isDocument: false });
  const bytes = await response.arrayBuffer();
  const tokens = markdownTokens(new TextDecoder().decode(bytes));
  const headers = new Headers(response.headers);
  if (etagMatches(req.headers.get("If-None-Match"), headers.get("ETag"))) {
    headers.delete("Content-Length");
    return matched(new Response(null, { status: 304, headers }), { tokens });
  }
  return matched(new Response(isHead ? null : bytes, { headers }), { tokens });
}
