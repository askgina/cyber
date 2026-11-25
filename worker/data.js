import { applySecurityHeaders, etagMatches } from "./headers.js";

export const DATA_ROUTES = {
  "/data.json": "data.json",
  "/data-hot.json": "data-hot.json",
  "/data-details.json": "data-details.json",
  "/data-history.json": "data-history.json",
  "/archive.json": "archive.json",
};

const JSON_TYPE = "application/json; charset=utf-8";

export async function handleDataRoute(req, env, pathname) {
  const isHead = req.method === "HEAD";
  if (req.method !== "GET" && !isHead) {
    return applySecurityHeaders(new Response("Method Not Allowed", {
      status: 405, headers: { Allow: "GET, HEAD" },
    }));
  }

  let key = DATA_ROUTES[pathname];
  let head = await env.STATE.head(key);
  if (!head && key === "data-hot.json") {
    key = "data.json";
    head = await env.STATE.head(key);
  }

  if (head) {
    const etag = head.httpEtag;
    const headers = { etag, "cache-control": "no-cache" };
    if (etagMatches(req.headers.get("if-none-match"), etag)) {
      return applySecurityHeaders(new Response(null, { status: 304, headers }));
    }
    headers["content-type"] = JSON_TYPE;
    if (isHead) {
      headers["content-length"] = String(head.size);
      return applySecurityHeaders(new Response(null, { headers }));
    }
    const o = await env.STATE.get(key);
    if (o) {
      // A build may have updated the object between head() and get(). Use the body's ETag.
      headers.etag = o.httpEtag;
      return applySecurityHeaders(new Response(o.body, { headers }));
    }
  }

  if (key === "data-details.json" || key === "data-history.json") {
    return applySecurityHeaders(new Response(isHead ? null : JSON.stringify({ error: "split not built yet" }), {
      status: 404, headers: { "content-type": JSON_TYPE, "cache-control": "no-cache" },
    }));
  }
  return applySecurityHeaders(new Response(isHead ? null : "Not built yet", {
    status: 503, headers: { "content-type": "text/plain; charset=utf-8" },
  }));
}
