(() => {
  "use strict";
  const SITE_ORIGIN = "https://cyber.askgina.ai";
  const HOME_TITLE = "Cyber — A daily record of cyber incidents";
  const REPORT_TITLE = "Daily Cyber Incident Report — Cyber";
  const METHOD_SECTIONS = new Set(["#method", "#stages", "#sources", "#elsewhere", "#limits"]);
  const REPORT_SECTIONS = new Set(["#glance", "#live", "#fig1", "#today", "#news", "#x-signals", "#patterns", "#clusters", "#crypto", "#ransomware", "#groups", "#sectors", "#breaches", "#exploited", "#cite"]);

  function canonicalPath(pathname) {
    return pathname.split(/[?#]/, 1)[0].replace(/\/+$/, "").replace(/\/index\.html$/, "").replace(/\/+$/, "") || "/";
  }
  function decode(segment) {
    try { return decodeURIComponent(segment); } catch { return segment; }
  }
  const isArchiveId = (id) => /^a-\d+$/.test(id);
  const hashRecordId = (hash) => hash.startsWith("#e-") && hash.length > 3 ? decode(hash.slice(3)) : null;
  const patternPath = (slug) => "/patterns/" + encodeURIComponent(slug);

  function parsePath(pathname, hash) {
    const path = canonicalPath(pathname);
    switch (path) {
      case "/": return { view: "term", path, title: HOME_TITLE };
      case "/leaderboard": return { view: "board", path, title: "Crypto Hacks Leaderboard — Cyber" };
      case "/report": return { view: "report", path, section: hash ? decode(hash.slice(1)) : null, title: REPORT_TITLE };
      case "/method": return { view: "report", path, section: hash ? decode(hash.slice(1)) : "method", title: "Method & Sources — Cyber" };
    }
    const m = path.match(/^\/(incidents|patterns|daily)\/([^/]+)$/);
    if (!m) return null;
    if (m[1] === "incidents") {
      const incidentId = decode(m[2]);
      return isArchiveId(incidentId) ? null : { view: "term", path, incidentId };
    }
    if (m[1] === "patterns") return { view: "report", path, pattern: decode(m[2]) };
    if (/^\d{4}-\d{2}-\d{2}$/.test(m[2])) return { view: "report", path, date: m[2] };
    return null;
  }

  function parseLocation(pathname, hash = "") {
    const id = hashRecordId(hash);
    const route = parsePath(pathname, isArchiveId(id) ? "" : hash);
    if (route && !route.incidentId && isArchiveId(id)) return { ...route, incidentId: id };
    return route;
  }

  function recordBackground(route = parseLocation(location.pathname, location.hash)) {
    if (route?.incidentId) {
      return history.state?.blFrom || (isArchiveId(route.incidentId) ? route.path + location.search : "/");
    }
    return (route?.path || "/") + location.search + location.hash;
  }

  function incidentPath(id, { includeSearch = true } = {}) {
    if (!isArchiveId(id)) return "/incidents/" + encodeURIComponent(id);
    // The array index can change between builds. Use a fragment on the view, never a standalone page.
    const base = new URL(recordBackground(), location.href);
    return base.pathname + (includeSearch ? base.search : "") + "#e-" + encodeURIComponent(id);
  }

  function legacyPath(pathname, h) {
    const route = parseLocation(pathname);
    const id = hashRecordId(h);
    if (id) return isArchiveId(id) ? null : incidentPath(id);
    if (route?.path === "/" && (h === "#terminal" || h === "#")) return "/";
    if (h === "#leaderboard" || (h === "#top" && route?.view !== "report")) return "/leaderboard";
    if (h === "#report") return "/report";
    // A fragment on a report surface is already a section, not a legacy view selector.
    if (route?.view === "report") return null;
    if (METHOD_SECTIONS.has(h)) return "/method" + (h === "#method" ? "" : h);
    if (REPORT_SECTIONS.has(h) || /^#cl-[0-9a-f]{6}$/.test(h)) return "/report" + h;
    return null;
  }

  function migrateLegacyHash() {
    // Location.hash is empty for both no fragment and a bare '#'.
    const h = location.hash || (location.href.endsWith("#") ? "#" : "");
    const path = legacyPath(location.pathname, h);
    if (path) history.replaceState(null, "", path);
    return path;
  }

  function syncMetadata(route, label) {
    if (!route) return;
    document.title = label ? `${label} — Cyber` : route.title || (route.incidentId ? "Incident — Cyber"
      : route.pattern ? `${route.pattern.replace(/-/g, " ")} — Attack Patterns — Cyber` : `Daily Cyber Incident Report: ${route.date} — Cyber`);
    const canonical = document.querySelector('link[rel="canonical"]');
    if (canonical) canonical.href = SITE_ORIGIN + route.path;
  }

  function navigate(path, { replace = false } = {}) {
    const url = new URL(path, location.href);
    const route = parseLocation(url.pathname, url.hash);
    if (url.origin !== location.origin || !route) return;
    const dest = route.path + url.search + url.hash;
    if (dest !== location.pathname + location.search + location.hash || location.href.endsWith("#")) {
      // A record overlays the view it was opened from. Store that view on the entry so
      // Forward restores it even after visiting a different view or reloading.
      let blFrom = route.incidentId ? recordBackground() : null;
      if (isArchiveId(route.incidentId)) {
        const base = new URL(blFrom, location.href);
        if (base.pathname !== route.path || base.search !== url.search) blFrom = route.path + url.search;
      }
      history[replace ? "replaceState" : "pushState"](blFrom ? { blFrom } : null, "", dest);
    }
    syncMetadata(route);
    window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  }

  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest?.("a[href]");
    if (!a || a.hasAttribute("download") || (a.target && a.target.toLowerCase() !== "_self")) return;
    const href = a.getAttribute("href");
    if (!href || href.startsWith("#")) return; // native anchors (e.g. Skip to content)
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || !parseLocation(url.pathname, url.hash)) return;
    e.preventDefault();
    navigate(url.href);
  });

  window.BLRoutes = { SITE_ORIGIN, parseLocation, migrateLegacyHash, legacyPath, navigate, incidentPath, patternPath, canonicalPath, syncMetadata, recordBackground, isArchiveId };
})();
