// ⌘K / Ctrl+K command palette: jump to views and report sections, switch theme, refresh,
// search every incident the terminal knows about, or ask Perplexity about the query.
(() => {
  "use strict";
  const B = window.BL || (window.BL = {});
  const dlg = document.getElementById("pal");
  const input = document.getElementById("pal-q");
  const list = document.getElementById("pal-list");
  if (!dlg || !input || !list) return;

  const KIND = { news: "News", crypto: "Crypto", kev: "Exploited CVE", x: "X signal", inc: "Incident", breach: "Breach" };
  const SECTIONS = [["glance", "Today"], ["live", "Live"], ["patterns", "Attack patterns"], ["crypto", "Crypto exploits"],
    ["ransomware", "Ransomware claims"], ["breaches", "Data breaches"], ["exploited", "Exploited vulnerabilities"], ["method", "Method"]];
  const go = (hash) => () => { location.hash = hash; };
  const COMMANDS = [
    { label: "Leaderboard", hint: "View", run: go("#leaderboard") },
    { label: "Terminal", hint: "View", run: go("#terminal") },
    { label: "Report", hint: "View", run: go("#report") },
    ...SECTIONS.map(([id, label]) => ({ label: `Report: ${label}`, hint: "Section", run: go("#" + id) })),
    { label: "Switch to dark mode", alt: "Switch to light mode", hint: "Theme", run: () => document.querySelector(".t-theme")?.click() },
    { label: "Refresh data now", hint: "Data", run: () => B.pollAll && B.pollAll() },
  ];

  let rows = [], sel = 0;
  // Each query word must start a word in the text ("gina" matches "Ask Gina", not "original").
  const words = (q) => q.toLowerCase().split(/\s+/).filter(Boolean)
    .map((w) => new RegExp("(?:^|[^\\p{L}\\p{N}])" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
  const hit = (text, ws) => { const t = text.toLowerCase(); return ws.every((w) => w.test(t)); };

  function results(q) {
    const ws = words(q);
    const dark = document.documentElement.dataset.theme === "dark";
    const cmds = COMMANDS.map((c) => ({ ...c, label: dark && c.alt ? c.alt : c.label }))
      .filter((c) => !ws.length || hit(c.label + " " + c.hint, ws));
    if (!ws.length) return cmds;
    const ix = B.index ? B.index() : {};
    const found = [];
    for (const [id, e] of Object.entries(ix)) {
      if (!e || !e.title) continue;
      if (hit([e.title, e.text || "", e.search || ""].join(" "), ws)) found.push({ id, e });
    }
    // incident title matches first, then newest
    found.sort((a, b) => (hit(b.e.title, ws) - hit(a.e.title, ws)) || String(b.e.date || "").localeCompare(String(a.e.date || "")));
    const recs = found.slice(0, 12).map(({ id, e }) => ({
      id, label: e.title, hint: KIND[e.kind] || e.kind, sub: String(e.date || "").slice(0, 10), run: go("#e-" + id),
    }));
    // results by meaning (AI Search), loaded after the instant word matches; skip records already listed
    const listed = new Set(recs.map((r) => r.id));
    const sem = SEM.q === q.trim() ? SEM.rows.filter((r) => !listed.has(r.id)) : [];
    const ask = { label: `Ask Perplexity: “${q.trim()}”`, hint: "Ask", run: () => window.open(B.askURL ? B.askURL(q.trim(), "Cyber") : "https://www.perplexity.ai/search?q=" + encodeURIComponent(q.trim()), "_blank", "noopener") };
    return [...cmds.slice(0, 4), ...recs, ...sem, ask];
  }

  // ---- search by meaning: /api/search (Cloudflare AI Search) returns record headings; map them back to records
  const SEM = { q: "", rows: [] };
  const SEMKIND = { incident: "Incident", crypto: "Crypto", kev: "Exploited CVE", breach: "Breach", notice: "Notice", sec: "SEC 8-K", "x-signal": "X signal", news: "News" };
  // Open a search hit: ids are page record ids (#e-<id>); "a:<type>|<date>|<name>" refs and incidents older than the
  // live data are resolved after the archive loads.
  async function openRecord(ref) {
    if (!ref) return;
    const ix = () => (B.index ? B.index() : {});
    if (!ref.startsWith("a:") && ix()[ref]) { location.hash = "#e-" + ref; return; }
    if (B.loadArchive) await B.loadArchive();
    const id = ref.startsWith("a:") ? (B.arcId && B.arcId(ref)) : (ix()[ref] ? ref : null);
    if (id) location.hash = "#e-" + id;
  }
  let semTimer, semCtl;
  function semSearch(q) {
    clearTimeout(semTimer); if (semCtl) semCtl.abort();
    q = q.trim();
    if (q.length < 4) { SEM.q = ""; SEM.rows = []; return; }
    semTimer = setTimeout(async () => {
      semCtl = new AbortController();
      try {
        const r = await fetch("/api/search?q=" + encodeURIComponent(q), { signal: semCtl.signal });
        const j = await r.json();
        if (input.value.trim() !== q) return;
        SEM.q = q;
        SEM.rows = (j.results || []).filter((x) => x.ref).map((x) => ({ id: x.ref, label: x.title, hint: "By meaning · " + (SEMKIND[x.kind] || x.kind), sub: x.date, run: () => openRecord(x.ref) }));
        draw();
      } catch (e) { /* aborted or offline: keep the word matches */ }
    }, 300);
  }

  function draw() {
    rows = results(input.value);
    sel = Math.min(sel, Math.max(rows.length - 1, 0));
    list.replaceChildren(...rows.map((r, i) => {
      const li = document.createElement("li");
      li.id = "pal-o" + i; li.setAttribute("role", "option"); li.setAttribute("aria-selected", String(i === sel));
      const main = document.createElement("span"); main.className = "pal-l"; main.textContent = r.label;
      const meta = document.createElement("span"); meta.className = "pal-h"; meta.textContent = r.sub ? `${r.hint} · ${r.sub}` : r.hint;
      li.append(main, meta);
      li.addEventListener("mousemove", () => { if (sel !== i) { sel = i; mark(); } });
      li.addEventListener("click", () => choose(i));
      return li;
    }));
    if (!rows.length) { const li = document.createElement("li"); li.className = "pal-none"; li.textContent = "No matches"; list.append(li); }
    mark();
  }
  function mark() {
    [...list.children].forEach((li, i) => li.setAttribute("aria-selected", String(i === sel)));
    input.setAttribute("aria-activedescendant", rows.length ? "pal-o" + sel : "");
    list.children[sel]?.scrollIntoView({ block: "nearest" });
  }
  function choose(i) {
    const r = rows[i]; if (!r) return;
    // what kind of result was picked; the query text itself is never sent
    const via = r.hint === "Ask" ? "ask" : /^By meaning/.test(r.hint || "") ? "meaning" : r.id ? "word" : "command";
    if (window.cyberTrack) window.cyberTrack("palette_pick", { via, qlen: input.value.trim().length, kind: (r.hint || "").replace("By meaning · ", "").slice(0, 24) });
    close(); r.run();
  }

  function open() { if (dlg.open) return; input.value = ""; sel = 0; draw(); dlg.showModal(); input.focus(); if (window.cyberTrack) window.cyberTrack("palette_open", {}); }
  function close() { if (dlg.open) dlg.close(); }

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
      e.preventDefault(); e.stopPropagation();
      dlg.open ? close() : open();
    }
  }, true);
  document.querySelectorAll("[data-pal-open]").forEach((b) => b.addEventListener("click", open));
  input.addEventListener("input", () => { sel = 0; draw(); semSearch(input.value); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); sel = (sel + 1) % Math.max(rows.length, 1); mark(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = (sel - 1 + rows.length) % Math.max(rows.length, 1); mark(); }
    else if (e.key === "Enter") { e.preventDefault(); choose(sel); }
  });
  dlg.addEventListener("click", (e) => { if (e.target === dlg) close(); });  // click on the backdrop
  // Hints say ⌘K; other platforms use Ctrl+K.
  if (!/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) document.querySelectorAll("kbd").forEach((k) => { if (k.textContent === "⌘K") k.textContent = "Ctrl K"; });
})();
