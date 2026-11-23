// Terminal view: a dense, live, multi-panel layout over the same data as the report.
(() => {
  "use strict";
  const B = window.BL;
  const { el } = B;
  const $ = (s, r = document) => r.querySelector(s);
  const T = { tab: "inc", prevKpi: {}, seenFeed: null, panel: 0, q: "" };
  const KIND_S = { notice: "NOTICE", news: "NEWS", crypto: "CRYPTO", kev: "CVE", x: "X", breach: "BREACH", ransom: "RANSOM" };
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
    (D.registry || []).forEach((it) => ix["r-" + it.id] = { it, kind: "inc", title: it.org, search: (it.affected || []).join(" "), text: [it.title, it.summary].filter(Boolean).join(". ").replace(/\.\. /, ". "), date: it.first_reported, url: null });
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
  const WINS = [["1h", "Last hour"], ["24h", "Last 24h"], ["7d", "Last 7 days"], ["30d", "Last 30 days"], ["ytd", "Year to date"]];
  function windows(D) {
    const W = (D.windows && D.windows.rows) || {};
    const now = Date.now();
    const y0 = new Date(); y0.setUTCHours(0, 0, 0, 0); const yday = y0.getTime() - 864e5;
    const tms = (s) => new Date(s.length === 10 ? s + "T00:00:00Z" : s).getTime();
    const extra = (B.LIVE.extra || []);
    const out = {};
    WINS.forEach(([w]) => {
      const g = (k) => (W[k] || {})[w] || null;
      const r = { crypto: g("crypto"), ransomware: g("ransomware"), kev: g("kev"), breach: g("breach"), inc: g("incidents"), notices: g("notices") };
      if (w === "1h" || w === "24h") {
        const cut = now - (w === "1h" ? 36e5 : 864e5);
        const seen = (o) => o.listed_at ? tms(o.listed_at) >= cut : (w === "24h" && tms(o.date) >= yday);
        const cr = D.crypto.items.filter((o) => !o.offchain && seen(o));
        r.crypto = { n: cr.length, usd: cr.reduce((a, c) => a + (c.amount || 0), 0) };
        r.ransomware = { n: ((D.ransomware || {}).items_24h || []).filter((v) => tms(v.date) >= cut).length };
        r.kev = { n: D.kev.items.filter(seen).length };
        const br = ((D.breaches || {}).items || []).filter((b) => tms(b.added) >= cut);
        r.breach = { n: br.length, acc: br.reduce((a, b) => a + (b.count || 0), 0) };
        r.inc = { n: (D.registry || []).filter((x) => tms(x.first_reported) >= cut).length };
        r.notices = { n: (D.notices || []).filter((x) => w === "24h" ? tms(x.date) + 86399e3 >= cut : tms(x.date) >= cut && !x.date.endsWith("T00:00:00Z")).length };
        r.cut = cut;
      }
      // anything picked up live since the last build
      extra.forEach((e) => {
        if (r.cut && tms(e.t) < r.cut) return;
        if (e.kind === "crypto" && r.crypto) { r.crypto = { ...r.crypto, n: r.crypto.n + 1, usd: (r.crypto.usd || 0) + (e.amount || 0) }; }
        if (e.kind === "breach" && r.breach) { r.breach = { ...r.breach, n: r.breach.n + 1, acc: (r.breach.acc || 0) + (e.count || 0) }; }
      });
      r.total = [...(w === "30d" || w === "ytd" ? [] : ["inc"]), "crypto", "ransomware", "kev", "breach"].reduce((a, k) => a + (r[k] ? r[k].n : 0), 0);
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
      const top = r.crypto && r.crypto.top && r.crypto.top.usd >= 1e7 && (w === "7d" || w === "30d" || w === "ytd") ? r.crypto.top : null;
      const br = r.breach ? `${r.breach.n}${r.breach.acc ? " · " + B.compact(r.breach.acc) : ""}` : "n/a";
      const box = el("div", { class: "t-k t-w" + (changed ? " chg" : ""), title: "Press-reported incidents (curated registry, one per incident), crypto exploits, ransomware leak-site claims, newly exploited CVEs (CISA KEV) and breaches added to HIBP. Official notices are listed but not added to the total." },
        el("div", { class: "wh" }, el("span", {}, label), el("b", {}, n), el("i", {}, "incidents")),
        el("div", { class: "wb" },
          line("Press-reported", r.inc && (w === "1h" || w === "24h" || w === "7d") ? String(r.inc.n) : "n/a"),
          line("Crypto", cr),
          line("Ransomware", r.ransomware ? r.ransomware.n.toLocaleString("en-US") : "n/a"),
          line("Exploited CVEs", r.kev ? String(r.kev.n) : "n/a"),
          line("Breaches", br),
          r.notices && r.notices.n ? line("Official notices", String(r.notices.n)) : null),
        top ? el("div", { class: "wt" }, el("em", {}, "Largest "), `${top.name.replace(/ CEX$/, "")} ${B.fmtUSD(top.usd)}, ${B.fmtDate(top.date)}`) : null,
        w === "ytd" ? el("button", { type: "button", class: "t-kbtn" }, "Browse and search all since Jan 1 →") : null);
      if (w === "ytd") box.querySelector(".t-kbtn").addEventListener("click", () => { T.tab = "arc"; T.panel = 4; drawMkt(T.D); const p = document.querySelector('.t-p[data-k="5"]'); p && p.scrollIntoView({ block: "nearest", behavior: "smooth" }); });
      return box;
    }));
  }

  function drawTape(ev) {
    const items = ev.slice(0, 18).map((e) => el("button", { type: "button", class: "t-ti", "data-id": e.id || null, "data-url": e.url || null, title: "Open" }, c("tk", KIND_S[e.kind] || e.kind), " ", e.title, e.sub ? c("ts", " " + e.sub) : null));
    const tape = $("#t-tape");
    tape.replaceChildren(el("div", { class: "t-run" }, items), el("div", { class: "t-run", "aria-hidden": "true" }, items.map((n) => n.cloneNode(true))));
    tape.style.setProperty("--dur", Math.max(40, items.length * 5) + "s");
    if (!tape.dataset.wired) {
      tape.dataset.wired = "1";
      // the tape is clickable: open the item in the inspector, or its source if it has no detail view
      tape.addEventListener("click", (x) => {
        const b = x.target.closest(".t-ti"); if (!b) return;
        if (b.dataset.id && IX[b.dataset.id]) inspect(b.dataset.id);
        else if (b.dataset.url) window.open(b.dataset.url, "_blank", "noopener");
      });
    }
  }

  function drawHit() {
    const t = B.LIVE.today || { rows: [], rv: [] };
    const box = $("#t-hit"); box.replaceChildren();
    const when = (x) => { if (!x) return ""; const h = (Date.now() - new Date(x).getTime()) / 36e5; return h < 1 ? Math.max(1, Math.round(h * 60)) + "m ago" : h < 48 ? Math.round(h) + "h ago" : B.fmtDate(x); };
    box.append(el("div", { class: "t-r t-hd" }, c("c-t", "First"), c("c-org", "Organisation"), c("c-sc", "Scale"), c("c-pt", "Pattern")));
    t.rows.forEach((r) => box.append(row([
      c("c-t", when(r.t)),
      c("c-org", el("b", {}, r.org), el("small", {}, r.what)),
      c("c-sc", r.scale || ""),
      c("c-pt", r.type || ((r.patterns || [])[0] ? (B.LABEL[r.patterns[0]] || r.patterns[0]) : "")),
    ], { id: r.rid || r.eid, url: r.url, cls: r.url && !r.rid ? "dim" : null })));
    if ((t.ups || []).length) {
      box.append(el("div", { class: "t-r t-hd t-sep" }, c("c-t", "Updated"), c("c-org", "Developments on older incidents"), c("c-sc", "Began"), c("c-pt", "")));
      t.ups.forEach((r) => box.append(row([
        c("c-t", when(r.t)),
        c("c-org", el("b", {}, r.org), el("small", {}, r.what)),
        c("c-sc", r.since ? B.fmtDate(r.since) : ""),
        c("c-pt", r.type || ((r.patterns || [])[0] ? (B.LABEL[r.patterns[0]] || r.patterns[0]) : "")),
      ], { id: r.rid || r.eid, cls: "dim" })));
    }
    if ((t.named || []).length) box.append(el("div", { class: "t-r t-hd t-sep" }, c("c-t", "Posted"), c("c-org", "Named on ransomware leak sites"), c("c-sc", ""), c("c-pt", "")));
    (t.named || []).slice().sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0)).forEach((v) => box.append(row([
      c("c-t", when(v.date)),
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

  const TABS = { inc: "7d", arc: "Since Jan 1", crypto: "Crypto", ransom: "Ransom", kev: "KEV", breach: "HIBP" };

  // ---- year-to-date archive: a separate file, fetched on first use (search or the Since Jan 1 tab)
  const AK = { all: "All", inc: "Incidents", crypto: "Crypto", ransom: "Ransomware", breach: "Breaches", notice: "Notices", sec: "SEC 8-K", kev: "KEV" };
  const AKL = { inc: "Incident", crypto: "Crypto hack", ransom: "Ransomware claim", breach: "Breach (HIBP)", notice: "Official notice", sec: "SEC 8-K filing", kev: "Exploited CVE" };
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const AR = { data: null, p: null, err: null, kind: "all", month: null, ix: {} };
  function loadArchive() {
    if (AR.p) return AR.p;
    AR.p = fetch("./archive.json", { cache: "no-cache" }).then((r) => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))).then((j) => {
      (j.items || []).forEach((a, i) => {
        a._s = [a.o, a.t, a.s, a.x, a.k === "inc" && a.rec ? [a.rec.summary, (a.rec.affected || []).join(" ")].join(" ") : ""].filter(Boolean).join(" ").toLowerCase();
        a.m = +a.d.slice(5, 7) - 1;
        if (a.k === "inc" && a.r) { a.id = "r-" + a.r; if (a.rec) AR.ix[a.id] = { it: { ...a.rec, id: a.r, n_outlets: (a.rec.sources || []).length, latest: (a.rec.updates || []).length ? a.rec.updates[a.rec.updates.length - 1].date : a.rec.first_reported, notices: [], outlets: [], stories: [] }, kind: "inc", title: a.rec.org || a.o, text: [a.rec.title, a.rec.summary].filter(Boolean).join(". ").replace(/\.\. /, ". "), date: a.rec.first_reported || a.d, url: null }; }
        else { a.id = "a-" + i; AR.ix[a.id] = { it: { _arc: a, links: a.u ? [{ label: "Source", url: a.u }] : [] }, kind: "arc", label: AKL[a.k] || "Record", title: a.o, text: a.t, date: a.d, url: null }; }
      });
      // a crypto hack that is also a tracked incident shows once in "All" (as the incident)
      const tok = (s) => (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !/^(cex|dex|protocol|finance|exchange|the)$/.test(w))[0];
      const incs = (j.items || []).filter((a) => a.k === "inc");
      (j.items || []).forEach((a) => {
        if (a.k !== "crypto") return;
        const w = tok(a.o), t0 = Date.parse(a.d);
        const m = w && incs.find((b) => Math.abs(Date.parse(b.d) - t0) <= 4 * 864e5 && (b.o || "").toLowerCase().includes(w));
        if (m) { a.dup = m.id; m._s += " " + a._s; }
      });
      AR.data = j;
      for (const [k, v] of Object.entries(AR.ix)) if (!IX[k]) IX[k] = v;  // live records keep their richer entries
      drawMkt(T.D); applyFilter();
    }).catch((e) => { AR.err = String(e.message || e); drawMkt(T.D); });
    return AR.p;
  }
  function arcMatches(q, kind, month, keepDup) {
    const its = (AR.data && AR.data.items) || [];
    const words = q ? q.split(/\s+/).filter(Boolean) : [];
    return its.filter((a) => (kind === "all" ? (keepDup || !a.dup) : a.k === kind) && (month == null || a.m === month) && words.every((w) => a._s.includes(w)));
  }
  function drawArchive(box) {
    if (!AR.data) {
      box.append(el("p", { class: "t-empty" }, AR.err ? `Archive unavailable (${AR.err}).` : "Loading every record since January 1…"));
      loadArchive(); $("#t-mkt-m").textContent = "";
      return;
    }
    const q = T.q;
    const base = arcMatches(q, "all", AR.month);
    const byK = {}; arcMatches(q, "all", AR.month, true).forEach((a) => byK[a.k] = (byK[a.k] || 0) + 1);
    const chips = el("div", { class: "t-achips", role: "group", "aria-label": "Record type" }, ...Object.entries(AK).filter(([k]) => k === "all" || byK[k] || AR.kind === k).map(([k, l]) => {
      const b = el("button", { type: "button", class: AR.kind === k ? "on" : null, "aria-pressed": String(AR.kind === k) }, l, " ", el("i", {}, String(k === "all" ? base.length : byK[k] || 0)));
      b.addEventListener("click", () => { AR.kind = k; drawMkt(T.D); });
      return b;
    }));
    const forMonths = arcMatches(q, AR.kind, null);
    const mc = Array(12).fill(0); forMonths.forEach((a) => mc[a.m]++);
    const nowM = new Date().getUTCMonth(), max = Math.max(1, ...mc);
    const months = el("div", { class: "t-amon", role: "group", "aria-label": "Month" }, ...MON.slice(0, nowM + 1).map((m, i) => {
      const b = el("button", { type: "button", class: AR.month === i ? "on" : null, title: `${m}: ${mc[i].toLocaleString("en-US")} records${AR.month === i ? " (click to clear)" : ""}`, "aria-pressed": String(AR.month === i) },
        el("span", { class: "bar" }, el("i", { style: `--v:${mc[i] ? Math.max(.06, mc[i] / max) : 0}` })), el("span", { class: "ml" }, m));
      b.addEventListener("click", () => { AR.month = AR.month === i ? null : i; drawMkt(T.D); });
      return b;
    }));
    box.append(el("div", { class: "t-ahead" }, chips, months));
    const list = arcMatches(q, AR.kind, AR.month);
    const LIM = 300;
    if (!list.length) box.append(el("p", { class: "t-empty" }, q ? `Nothing since January 1 matches “${q}”.` : "No records."));
    list.slice(0, LIM).forEach((a) => box.append(row([
      c("c-t", B.fmtDate(a.d.slice(0, 10))),
      c("c-org", el("b", {}, a.o), el("small", {}, `${AKL[a.k] || a.k}${a.t && a.t !== a.o ? " · " + a.t : ""}`)),
      c("c-sc", (a.s || "").split(" · ")[0]),
    ], { id: a.id, url: a.u, cls: "arc" })));
    if (list.length > LIM) box.append(el("p", { class: "t-empty" }, `Showing the newest ${LIM} of ${list.length.toLocaleString("en-US")}. Narrow it with the filter, a type or a month.`));
    $("#t-mkt-m").textContent = `${list.length.toLocaleString("en-US")} of ${(AR.data.items || []).length.toLocaleString("en-US")}`;
  }

  function drawMkt(D) {
    const nArc = AR.data && T.q ? arcMatches(T.q, "all", null).length : null;
    $("#t-tabs").replaceChildren(...Object.entries(TABS).map(([k, l]) => {
      const b = el("button", { type: "button", role: "tab", "aria-selected": String(T.tab === k), class: T.tab === k ? "on" : null }, l, k === "arc" && nArc != null ? el("i", { class: "tn" }, " " + nArc.toLocaleString("en-US")) : null);
      b.addEventListener("click", () => { T.tab = k; drawMkt(T.D); applyFilter(); });
      return b;
    }));
    const box = $("#t-mkt"); box.replaceChildren();
    if (T.tab === "arc") { drawArchive(box); return; }
    if (T.tab === "inc") {
      const cutoff = Date.now() - 7 * 864e5;
      const items = (D.registry || []).filter((r) => Date.parse(r.first_reported) >= cutoff)
        .map((r) => ({ r, update: false, date: r.first_reported }))
        .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
      items.forEach(({ r, update, date }) => box.append(row([c("c-t", B.fmtDate(date)), c("c-org", el("b", {}, r.org), el("small", {}, update ? `Update · first reported ${B.fmtDate(r.first_reported)} · ${r.type}` : `${r.type}${r.country ? " · " + r.country : ""} · ${r.n_outlets} outlet${r.n_outlets === 1 ? "" : "s"}`)),
        c("c-sc", r.usd ? B.fmtUSD(r.usd) : r.records ? B.compact(r.records) : r.status)], { id: "r-" + r.id })));
      $("#t-mkt-m").textContent = `${items.length} new in 7d`;
    } else if (T.tab === "crypto") {
      const items = [...D.crypto.items].sort((a, b) => (b.amount || 0) - (a.amount || 0));
      items.forEach((i) => box.append(row([c("c-t", B.fmtDate(i.date)), c("c-org", el("b", {}, i.name), el("small", {}, i.offchain ? "Bank-account fraud, not counted in crypto totals" : [i.technique, i.chains.slice(0, 2).join(", ")].filter((x) => x && x !== "Unknown").join(" · "))), c("c-sc", B.fmtUSD(i.amount))], { id: i.eid, cls: i.offchain ? "dim" : null })));
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
    // a headline about a listed crypto hack opens that hack, with every outlet on it
    if (IX[id] && IX[id].kind === "news" && IX[id].it.crypto && IX[IX[id].it.crypto]) id = IX[id].it.crypto;
    const e = IX[id]; if (!e) return;
    lastFocus = document.activeElement;
    const { it, kind, title, text } = e;
    const det = B.DET[id] || {};
    const ib = $("#t-ib"); ib.replaceChildren();
    $("#t-ik").textContent = `${e.label || B.KIND[kind]} · ${e.date.length === 10 ? B.fmtDate(e.date) : B.fmtLong(e.date)}`;
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
    if (T.q.length >= 3 && !AR.p) loadArchive();
    if (T.lastQ !== T.q) {
      // searching always covers everything since Jan 1; clearing returns to the previous tab
      if (T.q.length >= 3 && T.tab !== "arc") { T.prevTab = T.tab; T.tab = "arc"; }
      else if (!T.q && T.prevTab) { T.tab = T.prevTab; T.prevTab = null; drawMkt(T.D); }
      T.lastQ = T.q; if (T.tab === "arc" || AR.data) drawMkt(T.D); }
    document.querySelectorAll("#term .t-b .t-r:not(.t-hd):not(.arc)").forEach((r) => { const e = r.dataset.id && IX[r.dataset.id]; r.hidden = !!T.q && !(r.textContent + " " + (e ? e.title + " " + (e.text || "") + " " + (e.search || "") : "")).toLowerCase().includes(T.q); });
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
    T.D = D; IX = index(D); for (const [k, v] of Object.entries(AR.ix)) if (!IX[k]) IX[k] = v;
    const openId = !$("#t-insp").hidden && location.hash.startsWith("#e-") ? location.hash.slice(3) : null;
    drawKpi(D); drawHit(); drawFeed(); drawX(D); drawAct(D); drawMkt(D); applyFilter();
    if (!T.booted) { T.booted = true; if (/^#e-/.test(location.hash) && document.body.classList.contains("view-term")) { const id0 = location.hash.slice(3); if (IX[id0]) inspect(id0); else loadArchive().then(() => inspect(id0)); } }
    else if (openId && IX[openId]) document.querySelectorAll(`.t-r[data-id="${openId}"]`).forEach((n) => n.classList.add("sel"));
    B.onTick();
  };

  route();
  if (/^#e-/.test(location.hash) && !document.body.classList.contains("view-term")) setView("term");
})();
