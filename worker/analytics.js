import { AI_AGENT_UA, detectAgentName, normalizePath } from "./routes.js";

// ---- Analytics: no cookies, no stored IPs. Page loads are counted here (works with VPNs and ad blockers);
// the page sends a few named events to /e on our own domain. Both go to Analytics Engine and, if POSTHOG_KEY is set,
// to PostHog EU (project "cyber").
const BOT = /bot|crawl|spider|slurp|preview|monitor|headless|lighthouse|curl|wget|python|httpclient|go-http|java\//i;
export const EVENTS = new Set(["view", "open_record", "palette_open", "palette_pick", "ask_click", "theme"]);
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

export async function track(env, req, event, props = {}, distinctId = null) {
  const ua = req.headers.get("user-agent") || "";
  if (BOT.test(ua) || AI_AGENT_UA.test(ua)) return;
  const country = (req.cf && req.cf.country) || "XX";
  let ref = "";
  try { const r = req.headers.get("referer"); if (r) { const h = new URL(r).hostname; if (h !== new URL(req.url).hostname) ref = h; } } catch {}
  const dev = device(ua);
  const vid = await visitorIds(env, req, ua);
  const isLoad = event === "pageload";
  const label = isLoad ? props.pathname : props.view || props.kind || props.via || "";
  env.EVENTS?.writeDataPoint({ indexes: [event], blobs: [event, country, ref, dev, String(label), vid.visitor_day || "", vid.visitor_week || "", vid.visitor_month || ""], doubles: [1, Number(props.qlen) || 0] });
  if (env.POSTHOG_KEY) {
    const did = distinctId || crypto.randomUUID();
    const host = new URL(req.url).hostname;
    const browser = /edg\//i.test(ua) ? "Edge" : /firefox\//i.test(ua) ? "Firefox" : /chrome\//i.test(ua) ? "Chrome" : /safari\//i.test(ua) ? "Safari" : "Other";
    const os = /iphone|ipad|ios/i.test(ua) ? "iOS" : /android/i.test(ua) ? "Android" : /mac os/i.test(ua) ? "Mac OS X" : /windows/i.test(ua) ? "Windows" : /linux/i.test(ua) ? "Linux" : "Other";
    // Real page loads (counted on the server) become PostHog pageviews, so its built-in Web analytics charts work.
    // View changes inside the app stay as the separate "view" event, so they don't inflate pageviews.
    const web = isLoad ? { $current_url: `https://${host}${props.pathname}`, $pathname: props.pathname, $host: host,
      $referring_domain: ref || "$direct", $referrer: ref ? "https://" + ref + "/" : "$direct" } : {};
    await capturePostHog(env, isLoad ? "$pageview" : event, {
      distinct_id: did, ...props, ...web, ...vid, $geoip_country_code: country,
      $device_type: dev[0].toUpperCase() + dev.slice(1), $browser: browser, $os: os, country, referrer_host: ref || null,
    });
  }
}

function capturePostHog(env, event, properties) {
  if (!env.POSTHOG_KEY) return;
  return fetch("https://eu.i.posthog.com/i/v0/e/", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: env.POSTHOG_KEY, event,
      properties: { ...properties, app: "cyber", $process_person_profile: false, $geoip_disable: true } }),
  }).catch(() => {});
}

export function trackHumanPageview(env, ctx, req, pathname) {
  if (req.method !== "GET" || (req.headers.get("sec-fetch-dest") || "document") !== "document") return;
  return ctx.waitUntil(track(env, req, "pageload", { pathname: normalizePath(pathname) }));
}

export function trackAgentFetch(env, ctx, req, pathname, representation) {
  const agentName = detectAgentName(req.headers.get("user-agent"));
  pathname = normalizePath(pathname);
  ctx.waitUntil((async () => {
    // Preserve the shared blob layout; agent events carry no human visitor identifiers.
    const country = req.cf?.country || "XX";
    env.EVENTS?.writeDataPoint({
      indexes: ["agent_fetch"],
      blobs: ["agent_fetch", country, "", "", pathname, "", "", "", agentName || "unknown", representation],
      doubles: [1, 0],
    });
    await capturePostHog(env, "agent_fetch", {
      distinct_id: `agent:${agentName || "unknown"}`, agent_name: agentName || "unknown", representation, pathname,
    });
  })());
}
