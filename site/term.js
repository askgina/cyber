// Terminal view: a dense, live, multi-panel layout over the same data as the report.
(() => {
  "use strict";
  const B = window.BL;
  const { el } = B;
  const $ = (s, r = document) => r.querySelector(s);
  const T = { tab: "crypto", prevKpi: {}, seenFeed: null, panel: 0, q: "" };
  const KIND_S = { news: "NEWS", crypto: "CRYPTO", kev: "CVE", x: "X", breach: "BREACH", ransom: "RANSOM" };
  const hm = (s) => new Date(s.length === 10 ? s + "T12:00:00Z" : s).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  const when = (s) => s.length === 10 ? B.fmtDate(s) : (B.hoursAgo(s) < 24 ? hm(s) : B.fmtDate(s));

  // ---- routing between terminal and report
  function setView(v) {
    document.body.classList.toggle("view-term", v === "term");
    if (v === "term") closeInsp(true);
  }
  function route() {
    const h = location.hash;
    if (!h || h === "#terminal" || h === "#top") return setView("term");
    if (/^#e-/.test(h)) {
      if (document.body.classList.contains("view-term")) { setView("term"); T.D && inspect(h.slice(3)); }
      return;
    }
    setView("report");
    const n = document.getElementById(h.slice(1));
    if (n) setTimeout(() => n.scrollIntoView(), 0); else if (h === "#report") window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", route);

  // ---- index of every entry by id
  function index(D) {
    const ix = {};
    D.news.forEach((it) => ix[it.eid] = { it, kind: "news", title: it.title, text: it.summary, date: it.date, url: it.url });
    D.crypto.items.forEach((it) => ix[it.eid] = { it, kind: "crypto", title: it.name, text: it.desc, date: it.date });
    D.kev.items.forEach((it) => ix[it.eid] = { it, kind: "kev", title: `${it.id}: ${it.name}`, text: it.desc, date: it.date });
    (D.x || []).forEach((it) => ix[it.eid] = { it, kind: "x", title: it.subject, text: it.claim, date: it.date });
    ((D.breaches || {}).items || []).forEach((it) => ix[it.eid] = { it, kind: "breach", title: it.title, text: it.desc, date: it.added });
    return ix;
  }

  // ---- rows
  function row(cells, { id, url, cls, key } = {}) {
    const r = el("div", { class: "t-r" + (cls ? " " + cls : ""), tabindex: "-1", role: "button", "data-id": id || null, "data-key": key || null });
    cells.forEach((c) => r.append(c));
    r.addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      if (id) inspect(id); else if (url) window.open(url, "_blank", "noopener");
    });
    r.addEventListener("keydown", (e) => { if (e.key === "Enter") r.click(); });
    return r;
  }
  const c = (cls, ...kids) => el("span", { class: cls }, ...kids);

  // Counts by window. Last hour and 24h are recomputed in the browser so they stay current between hourly rebuilds;
  // 7d, month and year to date come from the build (full DefiLlama, CISA and HIBP history; ransomware.live monthly stats).
  const WINS = [["1h", "Last hour"], ["24h", "Last 24h"], ["7d", "Last 7 days"], ["mtd", "This month"], ["ytd", "Year to date"]];
  function windows(D) {
    const W = (D.windows && D.windows.rows) || {};
    const now = Date.now();
    const y0 = new Date(); y0.setUTCHours(0, 0, 0, 0); const yday = y0.getTime() - 864e5;
    const tms = (s) => new Date(s.length === 10 ? s + "T00:00:00Z" : s).getTime();
    const extra = (B.LIVE.extra || []);
    const out = {};
    WINS.forEach(([w]) => {
      const g = (k) => (W[k] || {})[w] || null;
      const r = { crypto: g("crypto"), ransomware: g("ransomware"), kev: g("kev"), breach: g("breach") };
      if (w === "1h" || w === "24h") {
        const cut = now - (w === "1h" ? 36e5 : 864e5);
        const seen = (o) => o.listed_at ? tms(o.listed_at) >= cut : (w === "24h" && tms(o.date) >= yday);
        const cr = D.crypto.items.filter(seen);
        r.crypto = { n: cr.length, usd: cr.reduce((a, c) => a + (c.amount || 0), 0) };
        r.ransomware = { n: ((D.ransomware || {}).items_24h || []).filter((v) => tms(v.date) >= cut).length };
        r.kev = { n: D.kev.items.filter(seen).length };
        const br = ((D.breaches || {}).items || []).filter((b) => tms(b.added) >= cut);
        r.breach = { n: br.length, acc: br.reduce((a, b) => a + (b.count || 0), 0) };
        r.cut = cut;
      }
      // anything picked up live since the last build
      extra.forEach((e) => {
        if (r.cut && tms(e.t) < r.cut) return;
        if (e.kind === "crypto" && r.crypto) { r.crypto = { ...r.crypto, n: r.crypto.n + 1, usd: (r.crypto.usd || 0) + (e.amount || 0) }; }
        if (e.kind === "breach" && r.breach) { r.breach = { ...r.breach, n: r.breach.n + 1, acc: (r.breach.acc || 0) + (e.count || 0) }; }
      });
      r.total = ["crypto", "ransomware", "kev", "breach"].reduce((a, k) => a + (r[k] ? r[k].n : 0), 0);
      out[w] = r;
    });
    return out;
  }
  function drawKpi(D) {
    const X = windows(D);
    T.win = X;
    const line = (l, v) => el("span", { class: "wl" }, el("em", {}, l), el("span", {}, v));
    $("#t-kpi").replaceChildren(...WINS.map(([w, label]) => {
      const r = X[w];
      const n = r.total.toLocaleString("en-US");
      const changed = T.prevKpi[w] != null && T.prevKpi[w] !== n;
      T.prevKpi[w] = n;
      const cr = r.crypto ? `${r.crypto.n}${r.crypto.usd ? " · " + B.fmtUSD(r.crypto.usd) : ""}` : "n/a";
      const br = r.breach ? `${r.breach.n}${r.breach.acc ? " · " + B.compact(r.breach.acc) : ""}` : "n/a";
      return el("div", { class: "t-k t-w" + (changed ? " chg" : ""), title: "Crypto exploits, ransomware leak-site claims, newly exploited CVEs (CISA KEV) and breaches added to HIBP" },
        el("div", { class: "wh" }, el("span", {}, label), el("b", {}, n), el("i", {}, "incidents")),
        el("div", { class: "wb" },
          line("Crypto", cr),
          line("Ransomware", r.ransomware ? r.ransomware.n.toLocaleString("en-US") : "n/a"),
          line("Exploited CVEs", r.kev ? String(r.kev.n) : "n/a"),
          line("Breaches", br)));
    }));
  }

  function drawTape(ev) {
    const items = ev.slice(0, 18).map((e) => el("span", { class: "t-ti" }, c("tk", KIND_S[e.kind] || e.kind), " ", e.title, e.sub ? c("ts", " " + e.sub) : null));
    const tape = $("#t-tape");
    tape.replaceChildren(el("div", { class: "t-run" }, items), el("div", { class: "t-run", "aria-hidden": "true" }, items.map((n) => n.cloneNode(true))));
    tape.style.setProperty("--dur", Math.max(40, items.length * 5) + "s");
  }

  function drawHit() {
    const t = B.LIVE.today || { rows: [], rv: [] };
    const box = $("#t-hit"); box.replaceChildren();
    box.append(el("div", { class: "t-r t-hd" }, c("c-org", "Organisation"), c("c-sc", "Scale"), c("c-pt", "Pattern")));
    t.rows.forEach((r) => box.append(row([
      c("c-org", el("b", {}, r.org), el("small", {}, r.what)),
      c("c-sc", r.scale || ""),
      c("c-pt", (r.patterns || [])[0] ? (B.LABEL[r.patterns[0]] || r.patterns[0]) : ""),
    ], { id: r.eid })));
    if ((t.ups || []).length) {
      box.append(el("div", { class: "t-r t-hd t-sep" }, c("c-org", "Developments on older incidents"), c("c-sc", "Began"), c("c-pt", "")));
      t.ups.forEach((r) => box.append(row([
        c("c-org", el("b", {}, r.org), el("small", {}, r.what)),
        c("c-sc", r.since ? B.fmtDate(r.since) : ""),
        c("c-pt", (r.patterns || [])[0] ? (B.LABEL[r.patterns[0]] || r.patterns[0]) : ""),
      ], { id: r.eid, cls: "dim" })));
    }
    if ((t.named || []).length) box.append(el("div", { class: "t-r t-hd t-sep" }, c("c-org", "Named on ransomware leak sites"), c("c-sc", ""), c("c-pt", "")));
    (t.named || []).forEach((v) => box.append(row([
      c("c-org", el("b", {}, v.victim), el("small", {}, `Named on ${v.group}'s leak site${v.sector && !/not found/i.test(v.sector) ? ", " + v.sector : ""}${v.country && v.country !== "??" ? ", " + v.country : ""}`)),
      c("c-sc", "Claim"), c("c-pt", B.LABEL.ransomware || "Ransomware"),
    ], { url: v.url || "https://www.ransomware.live", cls: "dim" })));
    $("#t-hit-m").textContent = `${t.rows.length} reported · ${t.rv.length} leak-site`;
  }

  function drawFeed() {
    const ev = B.events().sort((a, b) => new Date(b.t.length === 10 ? b.t + "T00:00:00Z" : b.t) - new Date(a.t.length === 10 ? a.t + "T00:00:00Z" : a.t));
    const box = $("#t-feed"); box.replaceChildren();
    const firstDraw = T.seenFeed == null;
    const seen = T.seenFeed || new Set();
    ev.slice(0, 60).forEach((e) => {
      const k = e.id || e.key;
      const fresh = !firstDraw && !seen.has(k);
      box.append(row([c("c-t", el("span", { "data-ago": e.t.length > 10 ? e.t : null }, e.t.length > 10 ? B.ago(e.t) : B.fmtDate(e.t))), c("c-k k-" + e.kind, KIND_S[e.kind] || e.kind), c("c-ti", el("b", {}, e.title), e.sub ? el("small", {}, e.sub) : null)],
        { id: e.id, url: e.url, cls: fresh || e.live ? "fresh" : null, key: k }));
    });
    T.seenFeed = new Set(ev.map((e) => e.id || e.key));
    $("#t-feed-m").textContent = `${ev.length} items`;
    drawTape(ev);
  }

  function drawX(D) {
    const box = $("#t-x"); box.replaceChildren();
    const xs = (D.x || []);
    if (!xs.length) box.append(el("p", { class: "t-empty" }, "No X signals in the last 7 days."));
    xs.forEach((x) => box.append(row([
      c("c-org", el("b", {}, x.subject), el("small", {}, `${x.accounts} accounts, ${x.credible} credible · first ${when(x.date)}${x.amount_usd_claimed ? " · " + B.fmtUSD(x.amount_usd_claimed) : ""}`)),
      c("c-tr", B.track(x.stage)), c("c-sc", String(x.score)),
    ], { id: x.eid })));
    $("#t-x-m").textContent = `${xs.length} tracked · 7d`;
  }

  function drawAct(D) {
    const H = D.hourly || [];
    const box = $("#t-act"); box.replaceChildren();
    const series = [["Ransomware", "ransomware"], ["Reports", "news"], ["X", "x"]];
    const g = el("div", { class: "t-hours" });
    series.forEach(([name, key]) => {
      const max = Math.max(1, ...H.map((h) => h[key]));
      const tot = H.reduce((a, h) => a + h[key], 0);
      g.append(c("hl", name), el("span", { class: "hc" }, H.map((h) => el("i", { style: `--v:${h[key] ? Math.max(.18, h[key] / max) : 0}`, title: `${hm(h.t)} UTC: ${h[key]}` }))), c("hn", String(tot)));
    });
    g.append(c("hl", ""), el("span", { class: "hx" }, c("", "-24h"), c("", "-12h"), c("", "now")), c("hn", ""));
    box.append(g);
    const pats = (B.LIVE.today || {}).pats || [];
    const max = Math.max(1, ...pats.map((p) => p[1]));
    box.append(el("div", { class: "t-sub" }, "How they got in, today"));
    pats.forEach(([p, n]) => {
      const r = row([c("c-pl", B.LABEL[p] || p), el("span", { class: "c-bar" }, el("i", { style: `--w:${(n / max) * 100}%` })), c("c-sc", String(n))], {});
      r.addEventListener("click", () => { $("#t-q").value = B.LABEL[p] || p; applyFilter(); });
      box.append(r);
    });
  }

  const TABS = { crypto: "Crypto", ransom: "Ransom", kev: "KEV", breach: "Breach" };
  function drawMkt(D) {
    $("#t-tabs").replaceChildren(...Object.entries(TABS).map(([k, l]) => {
      const b = el("button", { type: "button", role: "tab", "aria-selected": String(T.tab === k), class: T.tab === k ? "on" : null }, l);
      b.addEventListener("click", () => { T.tab = k; drawMkt(T.D); applyFilter(); });
      return b;
    }));
    const box = $("#t-mkt"); box.replaceChildren();
    if (T.tab === "crypto") {
      const items = [...D.crypto.items].sort((a, b) => (b.amount || 0) - (a.amount || 0));
      items.forEach((i) => box.append(row([c("c-t", B.fmtDate(i.date)), c("c-org", el("b", {}, i.name), el("small", {}, [i.technique, i.chains.slice(0, 2).join(", ")].filter((x) => x && x !== "Unknown").join(" · "))), c("c-sc", B.fmtUSD(i.amount))], { id: i.eid })));
      $("#t-mkt-m").textContent = `${D.crypto.count_30d} · ${B.fmtUSD(D.crypto.usd_30d)}`;
    } else if (T.tab === "ransom") {
      const r = D.ransomware;
      const max = Math.max(1, ...(r.groups_7d || []).map((g) => g[1]));
      (r.groups_7d || []).forEach(([g, n]) => box.append(row([c("c-pl", g), el("span", { class: "c-bar" }, el("i", { style: `--w:${(n / max) * 100}%` })), c("c-sc", String(n))], { url: `https://www.ransomware.live/group/${encodeURIComponent(g.toLowerCase())}` })));
      box.append(el("div", { class: "t-sub" }, "Sectors, 7d"));
      (r.sectors_7d || []).forEach(([s, n]) => box.append(row([c("c-pl", s), el("span", { class: "c-bar" }, el("i", { style: `--w:${(n / Math.max(1, r.sectors_7d[0][1])) * 100}%` })), c("c-sc", String(n))], {})));
      $("#t-mkt-m").textContent = `${r.count_7d} claims · 7d`;
    } else if (T.tab === "kev") {
      D.kev.items.forEach((v) => box.append(row([c("c-t", B.fmtDate(v.date)), c("c-org", el("b", {}, `${v.vendor} ${v.product}`), el("small", {}, `${v.id}${v.ransomware ? " · ransomware use" : ""}`)), c("c-sc", v.due ? "due " + B.fmtDate(v.due) : "")], { id: v.eid })));
      $("#t-mkt-m").textContent = `${D.kev.count_30d} · 30d`;
    } else {
      const items = (D.breaches || {}).items || [];
      items.forEach((b) => box.append(row([c("c-t", B.fmtDate(b.added)), c("c-org", el("b", {}, b.title), el("small", {}, (b.classes || []).slice(0, 3).join(", "))), c("c-sc", B.compact(b.count || 0))], { id: b.eid })));
      $("#t-mkt-m").textContent = `${items.length} · 30d`;
    }
  }

  // ---- inspector
  let IX = {}, lastFocus = null;
  function inspect(id) {
    const e = IX[id]; if (!e) return;
    lastFocus = document.activeElement;
    const { it, kind, title, text } = e;
    const det = B.DET[id] || {};
    const ib = $("#t-ib"); ib.replaceChildren();
    $("#t-ik").textContent = `${B.KIND[kind]} · ${e.date.length === 10 ? B.fmtDate(e.date) : B.fmtLong(e.date)}`;
    ib.append(el("h2", {}, title));
    if (text) ib.append(el("p", { class: "t-id" }, text));
    const links = [...(it.links || []), ...(e.url ? [{ label: it.source || "Source", url: e.url }] : [])];
    ib.append(el("p", { class: "t-il" }, el("a", { class: "btn", href: B.breakdownURL(title, text || "", id), target: "_blank", rel: "noopener" }, "Ask Perplexity"),
      ...links.map((l) => el("a", { href: l.url, target: "_blank", rel: "noopener" }, l.label))));
    ib.append(B.detailPanel(it, kind, id, title, text || ""));
    ib.querySelectorAll(".dask").forEach((n) => n.remove());
    const p = $("#t-insp"); p.hidden = false; ib.scrollTop = 0;
    $("#t-ix").focus({ preventScroll: true });
    document.querySelectorAll(".t-r.sel").forEach((n) => n.classList.remove("sel"));
    document.querySelectorAll(`.t-r[data-id="${id}"]`).forEach((n) => n.classList.add("sel"));
    if (location.hash !== "#e-" + id) history.replaceState(null, "", "#e-" + id);
  }
  function closeInsp(silent) {
    const p = $("#t-insp"); if (p.hidden) return;
    p.hidden = true;
    if (!silent) { history.replaceState(null, "", "#terminal"); lastFocus && lastFocus.focus && lastFocus.focus({ preventScroll: true }); }
  }
  $("#t-ix").addEventListener("click", () => closeInsp());
  B.inspect = inspect;

  // ---- filter
  function applyFilter() {
    const q = $("#t-q").value.trim().toLowerCase();
    T.q = q.startsWith("ask ") ? "" : q;
    document.querySelectorAll("#term .t-b .t-r:not(.t-hd)").forEach((r) => { r.hidden = !!T.q && !r.textContent.toLowerCase().includes(T.q); });
  }
  let qt;
  $("#t-q").addEventListener("input", () => { clearTimeout(qt); qt = setTimeout(applyFilter, 120); });
  $("#t-q").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const v = $("#t-q").value.trim();
      if (/^ask\s+/i.test(v)) { window.open(B.askURL(v.replace(/^ask\s+/i, ""), "Breach Ledger terminal"), "_blank", "noopener"); return; }
      const first = document.querySelector("#term .t-b .t-r:not(.t-hd):not([hidden])");
      first && first.click();
    }
    if (e.key === "Escape") { $("#t-q").value = ""; applyFilter(); $("#t-q").blur(); }
  });

  // ---- keyboard
  const panels = () => [...document.querySelectorAll("#term .t-p")];
  function focusPanel(i) {
    T.panel = i;
    panels().forEach((p, ix) => p.classList.toggle("on", ix === i));
    const r = panels()[i].querySelector(".t-r:not(.t-hd):not([hidden])");
    r && r.focus();
  }
  function refresh() { const c = $("#t-checked"); c.textContent = "refreshing…"; B.pollAll(); }
  $("#t-live").addEventListener("click", refresh);
  document.addEventListener("keydown", (e) => {
    if (!document.body.classList.contains("view-term")) return;
    if (e.target.matches("input, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "/") { e.preventDefault(); $("#t-q").focus(); return; }
    if (e.key === "Escape") { closeInsp(); return; }
    if (/^[1-5]$/.test(e.key)) { focusPanel(+e.key - 1); return; }
    if (e.key === "r") { location.hash = "#report"; return; }
    if (e.key === "u") { refresh(); return; }
    if (e.key === "j" || e.key === "k" || e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!$("#t-insp").hidden && e.target.closest("#t-insp")) return;
      const rows = [...panels()[T.panel].querySelectorAll(".t-r:not(.t-hd):not([hidden])")];
      if (!rows.length) return;
      e.preventDefault();
      let i = rows.indexOf(document.activeElement);
      i = Math.max(0, Math.min(rows.length - 1, i + (e.key === "j" || e.key === "ArrowDown" ? 1 : -1)));
      rows[i].focus(); rows[i].scrollIntoView({ block: "nearest" });
    }
  });
  panels().forEach((p, ix) => p.addEventListener("focusin", () => { T.panel = ix; panels().forEach((q, j) => q.classList.toggle("on", j === ix)); }));

  // ---- clock and status
  B.onTick = () => {
    $("#t-clock").textContent = new Date().toLocaleTimeString("en-GB", { timeZone: "UTC" }) + " UTC";
    const s = B.LIVE.checked ? Math.round((Date.now() - B.LIVE.checked) / 1000) : null;
    $("#t-checked").textContent = s == null ? "" : `checked ${s < 60 ? s + "s" : Math.round(s / 60) + "m"} ago · rebuilt ${(T.D ? B.ago(T.D.generated) : "")}`;
  };

  B.onRender = (D) => {
    T.D = D; IX = index(D);
    const openId = !$("#t-insp").hidden && location.hash.startsWith("#e-") ? location.hash.slice(3) : null;
    drawKpi(D); drawHit(); drawFeed(); drawX(D); drawAct(D); drawMkt(D); applyFilter();
    if (!T.booted) { T.booted = true; if (/^#e-/.test(location.hash) && document.body.classList.contains("view-term")) inspect(location.hash.slice(3)); }
    else if (openId && IX[openId]) document.querySelectorAll(`.t-r[data-id="${openId}"]`).forEach((n) => n.classList.add("sel"));
    B.onTick();
  };

  route();
  if (/^#e-/.test(location.hash) && !document.body.classList.contains("view-term")) setView("term");
})();
