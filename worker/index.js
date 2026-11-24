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

async function runBuild(env) {
  const c = getContainer(env.BUILDER, "hourly");
  const state = await env.STATE.get("state.tar.gz");
  const r = await c.fetch(new Request("http://builder/run", { method: "POST", body: state ? await state.arrayBuffer() : null }));
  const res = await r.json().catch(() => ({ ok: false, error: "bad response" }));
  if (!r.ok || !res.ok) throw new Error(`build failed (${r.status}): ${JSON.stringify(res).slice(0, 2000)}`);
  for (const [name, type] of OUTPUTS) {
    const o = await c.fetch(new Request("http://builder/out/" + name));
    if (!o.ok) throw new Error(`could not read ${name} from the builder: ${o.status}`);
    await env.STATE.put(name, await o.arrayBuffer(), { httpMetadata: { contentType: type } });
  }
  console.log("build ok", res.generated, `${res.seconds}s`, `restored ${res.restored_files} cache files`);
  return res;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const key = DATA[url.pathname];
    if (key) {
      const o = await env.STATE.get(key);
      if (!o) return new Response("Not built yet", { status: 503 });
      return new Response(o.body, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache", etag: o.httpEtag } });
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
