import { applySecurityHeaders, etagMatches } from "./headers.js";

export const DATA_ROUTES = {
  "/data.json": "data.json",
  "/data-hot.json": "data-hot.json",
  "/data-details.json": "data-details.json",
  "/data-history.json": "data-history.json",
  "/archive.json": "archive.json",
};

const JSON_TYPE = "application/json; charset=utf-8";
// Every data-route error is JSON so a client can parse one shape.
function failure(status, error, headers = {}) {
  return applySecurityHeaders(Response.json({ error }, { status, headers: { "cache-control": "no-store", ...headers } }), { noindex: true });
}

// An R2 internal error is transient, so answer 503: a 500 tells clients not to retry.
function storageUnavailable() {
  return failure(503, "storage temporarily unavailable", { "retry-after": "60" });
}

export async function handleDataRoute(req, env, pathname) {
  const isHead = req.method === "HEAD";
  if (req.method !== "GET" && !isHead) return failure(405, "method not allowed", { Allow: "GET, HEAD" });

  let key = DATA_ROUTES[pathname];
  let head;
  try {
    head = await env.STATE.head(key);
    if (!head && key === "data-hot.json") {
      key = "data.json";
      head = await env.STATE.head(key);
    }
  } catch (e) {
    console.error("data head failed", String(e));
    return storageUnavailable();
  }

  if (head) {
    const etag = head.httpEtag;
    // last-modified is the build generation that wrote the object: it is how a stale build is detected
    // externally (see .github/workflows/build-freshness.yml) and how a client ages the ledger.
    const headers = { etag, "cache-control": "no-cache", "last-modified": head.uploaded.toUTCString() };
    if (etagMatches(req.headers.get("if-none-match"), etag)) {
      return applySecurityHeaders(new Response(null, { status: 304, headers }));
    }
    headers["content-type"] = JSON_TYPE;
    if (isHead) {
      headers["content-length"] = String(head.size);
      return applySecurityHeaders(new Response(null, { headers }));
    }
    let o;
    try {
      o = await env.STATE.get(key);
    } catch (e) {
      console.error("data get failed", String(e));
      return storageUnavailable();
    }
    if (o) {
      // A build may have updated the object between head() and get(). Use the body's ETag.
      headers.etag = o.httpEtag;
      headers["last-modified"] = o.uploaded.toUTCString();
      return applySecurityHeaders(new Response(o.body, { headers }));
    }
  }

  if (key === "data-details.json" || key === "data-history.json") {
    return applySecurityHeaders(new Response(isHead ? null : JSON.stringify({ error: "split not built yet" }), {
      status: 404, headers: { "content-type": JSON_TYPE, "cache-control": "no-cache" },
    }));
  }
  return failure(503, "not built yet", { "retry-after": "60" });
}
