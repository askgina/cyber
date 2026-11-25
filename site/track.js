// Cookieless usage events, sent to /e on our own domain (the Worker forwards them to Analytics Engine and PostHog).
// Nothing is stored on the device: the id below lives only for this page load. Search text is never sent.
(() => {
  "use strict";
  const sid = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2);
  function track(e, p) {
    try {
      const body = JSON.stringify({ e, p: p || {}, s: sid });
      // Beacon cannot suppress a same-origin Referer containing the original query.
      if (location.search || !navigator.sendBeacon?.("/e", new Blob([body], { type: "application/json" }))) {
        fetch("/e", { method: "POST", body, keepalive: true, referrerPolicy: "no-referrer", headers: { "content-type": "application/json" } }).catch(() => {});
      }
    } catch (err) { /* analytics must never break the page */ }
  }
  window.cyberTrack = track;

  // Track only route labels and record ids, not full URLs, section fragments or searches.
  const R = window.BLRoutes;
  const VIEWS = { "/": "terminal", "/leaderboard": "leaderboard", "/report": "report", "/method": "method" };
  const KINDS = { r: "inc", c: "crypto", k: "kev", x: "x", n: "news", b: "breach" };
  const fromView = () => ["term", "board", "report"].find((v) => document.body.classList.contains("view-" + v)) || "term";
  let last = null;
  function route() {
    const legacy = R.legacyPath(location.pathname, location.hash);
    const loc = legacy ? new URL(legacy, R.SITE_ORIGIN) : location;
    const r = R.parseLocation(loc.pathname, loc.hash);
    if (!r) { last = null; return; }
    const { incidentId: id, pattern, date, path } = r;
    const key = id ? R.incidentPath(id) : pattern ? R.patternPath(pattern) : path;
    if (key === last) return; // duplicate History/hash events and canonical legacy migrations
    last = key;
    track("view", { view: id ? "incident" : pattern ? "pattern" : date ? "daily" : VIEWS[path] });
    if (id) {
      const e = window.BL?.index?.()[id];
      const prefix = id.match(/^([rckxnb])-/)?.[1];
      const kind = e?.it?._arc?.k || e?.kind || KINDS[prefix] || window.BL?.boardRecordKind?.(id) || "unknown";
      track("open_record", { kind, id: id.split(/[?#]/, 1)[0].slice(0, 60), from: fromView() });
    }
  }
  window.addEventListener("popstate", route);
  window.addEventListener("hashchange", route);
  // History writes alone emit neither popstate nor hashchange. Wait for the app to sync the view.
  for (const m of ["replaceState", "pushState"]) {
    const orig = history[m].bind(history);
    history[m] = function (...args) {
      const result = orig(...args);
      queueMicrotask(() => { try { route(); } catch { /* analytics must never break the page */ } });
      return result;
    };
  }
  route();

  // Ask links (any assistant) and the theme toggle
  document.addEventListener("click", (ev) => {
    const a = ev.target.closest && ev.target.closest('a[href*="perplexity.ai"], a[href*="chatgpt.com"], a[href*="claude.ai"], .ask-pop a[data-ask]');
    if (a) {
      const via = a.dataset.ask || (a.href.includes("chatgpt.com") ? "chatgpt" : a.href.includes("claude.ai") ? "claude" : "perplexity");
      track("ask_click", { from: fromView(), via });
    }
    if (ev.target.closest && ev.target.closest(".t-theme")) setTimeout(() => track("theme", { mode: document.documentElement.dataset.theme === "dark" ? "dark" : "light" }), 0);
  }, true);
})();
