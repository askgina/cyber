// Cookieless usage events, sent to /e on our own domain (the Worker forwards them to Analytics Engine and PostHog).
// Nothing is stored on the device: the id below lives only for this page load. Search text is never sent.
(() => {
  "use strict";
  const sid = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2);
  function track(e, p) {
    try {
      const body = JSON.stringify({ e, p: p || {}, s: sid });
      if (!(navigator.sendBeacon && navigator.sendBeacon("/e", new Blob([body], { type: "application/json" }))))
        fetch("/e", { method: "POST", body, keepalive: true, headers: { "content-type": "application/json" } });
    } catch (err) { /* analytics must never break the page */ }
  }
  window.cyberTrack = track;

  // views and record opens, from the URL hash
  const VIEWS = { "": "terminal", "#": "terminal", "#terminal": "terminal", "#leaderboard": "leaderboard", "#top": "leaderboard", "#report": "report" };
  let last = null, lastOpen = null;
  function route() {
    const h = location.hash;
    if (h.startsWith("#e-")) {
      const id = h.slice(3);
      if (id === lastOpen) return;  // same record again (deep link + inspector, palette + hash): count once
      lastOpen = id;
      const e = window.BL && window.BL.index ? window.BL.index()[id] : null;
      // incident, crypto, kev, x, news, breach, or the archive record type (notice, sec, ransom, …)
      const kind = (e && ((e.it && e.it._arc && e.it._arc.k) || e.kind)) || "unknown";
      track("open_record", { kind, id: id.slice(0, 60), from: document.body.className.replace("view-", "") });
      return;
    }
    lastOpen = null;
    const view = VIEWS[h] || "report:" + h.slice(1);
    if (view === last) return;
    last = view;
    track("view", { view });
  }
  window.addEventListener("hashchange", route);
  // the app opens and closes records with history.replaceState/pushState, which fire no hashchange
  for (const m of ["replaceState", "pushState"]) {
    const orig = history[m].bind(history);
    history[m] = function (...args) { const r = orig(...args); try { route(); } catch (e) {} return r; };
  }
  route();

  // Ask links (any assistant) and the theme toggle
  document.addEventListener("click", (ev) => {
    const a = ev.target.closest && ev.target.closest('a[href*="perplexity.ai"], a[href*="chatgpt.com"], a[href*="claude.ai"], .ask-pop a[data-ask]');
    if (a) {
      const via = a.dataset.ask || (a.href.includes("chatgpt.com") ? "chatgpt" : a.href.includes("claude.ai") ? "claude" : "perplexity");
      track("ask_click", { from: document.body.className.replace("view-", ""), via });
    }
    if (ev.target.closest && ev.target.closest(".t-theme")) setTimeout(() => track("theme", { mode: document.documentElement.dataset.theme === "dark" ? "dark" : "light" }), 0);
  }, true);
})();
