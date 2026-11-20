(() => {
  "use strict";
  // Canonical public address of this page, used in "Ask Perplexity" prompts.
  const PAGE_URL = "https://www.perplexity.ai/computer/a/breach-ledger-8m02Ioy7S8.RlbVLw5GwoQ";
  const PPLX = "https://www.perplexity.ai/search?q=";
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === "class") n.className = v; else if (k === "html") n.innerHTML = v; else n.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(c));
    return n;
  };
  const fmtUSD = (n) => n == null ? "undisclosed" : n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${n}`;
  const fmtDate = (s) => new Date(s.length === 10 ? s + "T12:00:00Z" : s).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const fmtLong = (s) => new Date(s).toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" });
  const hoursAgo = (s) => (Date.now() - new Date(s).getTime()) / 36e5;
  const ago = (s) => { const h = hoursAgo(s); return h < 1 ? `${Math.max(1, Math.round(h * 60))}m ago` : h < 48 ? `${Math.round(h)}h ago` : fmtDate(s); };
  const xSearch = (q) => "https://x.com/search?f=live&q=" + encodeURIComponent(q);

  function askURL(text, context) {
    const q = `${text.trim()}\n\nContext: from Breach Ledger, a daily cyber incident tracker (${PAGE_URL})${context ? `, ${context}` : ""}. Explain what happened, how credible the claim is, and summarise the latest reporting with sources.`;
    return PPLX + encodeURIComponent(q);
  }

  // Side note with numbered links (SID-style margin notes)
  let noteNo = 0;
  function note(links, askText, askCtx) {
    const ol = el("ol");
    for (const l of links) {
      noteNo++;
      ol.append(el("li", {}, el("span", {}, String(noteNo)), el("a", { href: l.url, target: "_blank", rel: "noopener" }, l.label)));
    }
    noteNo++;
    ol.append(el("li", {}, el("span", {}, String(noteNo)), el("a", { href: askURL(askText, askCtx), target: "_blank", rel: "noopener", class: "ask-link" }, "Ask Perplexity")));
    return el("aside", { class: "note", "aria-label": "Sources" }, ol);
  }

  const KIND = { news: "News", crypto: "Crypto", kev: "Exploited", x: "X signal" };
  let DET = {}, LABEL = {}, LISTS = {}, ITEM = {};
  const state = { pattern: null, q: "", expanded: {} };

  function breakdownURL(title, text, id) {
    const det = DET[id] || {};
    const rel = (det.related || []).slice(0, 3).map((r) => r.title).join("; ");
    const q = `Give a full technical breakdown of this incident: "${title}". ${(text || "").slice(0, 600)}\n\nCover: the attack chain step by step, MITRE ATT&CK techniques, indicators of compromise, who is affected, how confirmed it is, how it compares with similar incidents${rel ? ` (for example ${rel})` : ""}, and concrete mitigations for software teams. Cite sources.\n\nContext: from Breach Ledger, a daily cyber incident tracker (${PAGE_URL}#e-${id}).`;
    return PPLX + encodeURIComponent(q);
  }

  function facts(rows) {
    return el("dl", { class: "facts" }, rows.filter((r) => r[1] != null && r[1] !== "" && !(Array.isArray(r[1]) && !r[1].length))
      .map(([k, v]) => el("div", {}, el("dt", {}, k), el("dd", {}, v))));
  }

  function patChips(ps) {
    return el("span", { class: "chips" }, ps.map((p) => {
      const b = el("button", { type: "button", class: "chip" + (state.pattern === p ? " on" : "") }, LABEL[p] || p);
      b.addEventListener("click", () => setFilter({ pattern: p }, true));
      return b;
    }));
  }

  function detailPanel(it, kind, id, title, text) {
    const det = DET[id] || {};
    const box = el("div", { class: "detail" });
    let rows;
    if (kind === "crypto") rows = [["Loss", fmtUSD(it.amount)], ["Returned", it.returned ? fmtUSD(it.returned) : null], ["Date", fmtDate(it.date)],
      ["Chains", it.chains.join(", ")], ["Classification", it.classification], ["Technique", it.technique], ["Target", it.target]];
    else if (kind === "kev") rows = [["CVE", it.id], ["Product", `${it.vendor} ${it.product}`], ["Added to KEV", fmtDate(it.date)], ["Patch due", it.due ? fmtDate(it.due) : null],
      ["Ransomware use", it.ransomware ? "Known" : "Not known"],
      ["Weakness", (it.cwes || []).length ? (det.cwes || it.cwes.map((c) => ({ id: c }))).map((c, ix) => [ix ? ", " : "", el("a", { href: `https://cwe.mitre.org/data/definitions/${c.id.replace("CWE-", "")}.html`, target: "_blank", rel: "noopener" }, c.id), c.name ? ` ${c.name.toLowerCase()}` : ""]).flat() : null]];
    else if (kind === "news") rows = [["Source", it.source], ["Published", fmtLong(it.date)]];
    else rows = [["Stage", it.stage], ["Category", it.category], ["Claimed", it.amount_usd_claimed ? fmtUSD(it.amount_usd_claimed) : null], ["First seen", fmtLong(it.date)]];
    rows.unshift(["Pattern", (det.patterns || []).length ? patChips(det.patterns) : null]);
    box.append(facts(rows));
    if (kind === "kev" && it.action) box.append(el("p", { class: "dnote" }, el("b", {}, "Required action. "), it.action));

    const an = det.analysis;
    if (an) {
      const sec = el("div", { class: "dsec" }, el("h4", {}, "Analysis"));
      if (an.summary) sec.append(el("p", {}, an.summary));
      if (an.attack_chain) sec.append(el("h5", {}, "Attack chain"), el("ol", { class: "steps" }, an.attack_chain.map((x) => el("li", {}, x))));
      if (an.open_questions) sec.append(el("h5", {}, "Open questions"), el("ul", { class: "bul" }, an.open_questions.map((x) => el("li", {}, x))));
      if (an.mitigations) sec.append(el("h5", {}, "Mitigations"), el("ul", { class: "bul" }, an.mitigations.map((x) => el("li", {}, x))));
      if (an.sources) sec.append(el("p", { class: "dsrc" }, "Analysis sources: ", an.sources.map((l, ix) => [ix ? ", " : "", el("a", { href: l.url, target: "_blank", rel: "noopener" }, l.label)]).flat()));
      box.append(sec);
    }

    if ((det.related || []).length) {
      const sec = el("div", { class: "dsec" }, el("h4", {}, "Similar incidents"));
      sec.append(el("ul", { class: "rel" }, det.related.map((r) => {
        const b = el("a", { href: `#e-${r.id}`, class: "jump" }, r.title);
        b.addEventListener("click", (e) => { e.preventDefault(); jumpTo(r.id); });
        return el("li", {}, el("span", { class: "rk" }, `${KIND[r.kind]} · ${fmtDate(r.date)}`), el("span", { class: "rt" }, b, el("span", { class: "why" }, r.why)), el("span", { class: "rs", title: "Similarity score" }, r.score.toFixed(2)));
      })));
      if (det.cluster) {
        const c = el("a", { href: `#${det.cluster}` }, "related-incident group");
        sec.append(el("p", { class: "dsrc" }, "Part of a ", c, " in Attack patterns."));
      }
      box.append(sec);
    }
    if ((det.precedents || []).length) {
      const sec = el("div", { class: "dsec" }, el("h4", {}, "Earlier attacks like this"));
      sec.append(el("ul", { class: "rel" }, det.precedents.map((p) => el("li", {},
        el("span", { class: "rk" }, `${p.date.slice(0, 4)} · ${fmtUSD(p.amount)}`),
        el("span", { class: "rt" }, el("a", { href: askURL(`${p.name} crypto hack (${p.date}), technique: ${p.technique || p.classification}`, "precedent for " + title), target: "_blank", rel: "noopener" }, p.name),
          el("span", { class: "why" }, [p.classification, p.technique].filter((x) => x && x !== "Unknown").join(" · ") + (p.why ? `; shared terms: ${p.why}` : ""))),
        el("span", { class: "rs", title: "Text similarity" }, p.score.toFixed(2))))));
      box.append(sec);
    }
    box.append(el("p", { class: "dask" }, el("a", { class: "btn", href: breakdownURL(title, text, id), target: "_blank", rel: "noopener" }, "Ask Perplexity for a full breakdown"),
      " ", el("a", { class: "link", href: `#e-${id}` }, "Link to this entry")));
    return box;
  }

  function entry({ id, kind, it, k, t, d, links, ask, ctx, clamp, title, text }) {
    const det = DET[id] || {};
    const prim = (det.patterns || []).find((p) => p !== "unclassified");
    const kk = [...k.filter(Boolean)];
    if (prim) kk.push(el("span", { class: "ptag" }, LABEL[prim]));
    const main = el("div", { class: "main" }, el("div", { class: "k" }, kk), el("p", { class: "t", html: t }));
    let p;
    if (d) { p = el("p", { class: "d" + (clamp && d.length > 260 ? " clamp" : "") }, d); main.append(p); }
    const b = el("button", { class: "more", type: "button", "aria-expanded": "false" }, "Details");
    const nrel = (det.related || []).length;
    if (nrel) b.append(el("span", { class: "cnt" }, ` · ${nrel} similar`));
    let panel = null;
    const toggle = (force) => {
      const open = force ?? !panel;
      if (open && !panel) { panel = detailPanel(it, kind, id, title, text); main.append(panel); p && p.classList.remove("clamp"); }
      else if (!open && panel) { panel.remove(); panel = null; p && clamp && d.length > 260 && p.classList.add("clamp"); }
      b.setAttribute("aria-expanded", String(open)); b.firstChild.textContent = open ? "Hide details" : "Details";
    };
    b.addEventListener("click", () => toggle());
    main.insertBefore(b, p ? p.nextSibling : null);
    const n = el("div", { class: "entry", id: `e-${id}`, "data-ctx": ctx }, main, note(links, ask, ctx));
    n._toggle = toggle;
    return n;
  }

  function matches(id, hay) {
    if (state.pattern && !((DET[id] || {}).patterns || []).includes(state.pattern)) return false;
    if (state.q) { const q = state.q.toLowerCase(); return q.split(/\s+/).every((w) => hay.includes(w)); }
    return true;
  }

  function list(key, container, items, render, initial) {
    LISTS[key] = { container, items, render, initial };
    items.forEach((it) => { if (it.eid) ITEM[it.eid] = key; });
    drawList(key);
  }
  function drawList(key) {
    const { container, items, render, initial } = LISTS[key];
    const filtering = state.pattern || state.q;
    const shown = filtering ? items.filter((it) => matches(it.eid, JSON.stringify(it).toLowerCase())) : items;
    container.replaceChildren();
    if (!shown.length) { container.append(el("p", { class: "empty" }, filtering ? "No entries match this filter." : "Nothing recorded in this window.")); return; }
    const lim = filtering || state.expanded[key] ? shown.length : initial;
    shown.slice(0, lim).forEach((it) => container.append(render(it)));
    if (shown.length > lim) {
      const b = el("button", { class: "showall", type: "button" }, `Show all ${shown.length}`);
      b.addEventListener("click", () => { state.expanded[key] = true; drawList(key); });
      container.append(b);
    }
  }

  function setFilter(f, scroll) {
    Object.assign(state, f);
    Object.keys(LISTS).forEach(drawList);
    drawPatterns();
    const active = state.pattern || state.q;
    const total = active ? Object.values(LISTS).reduce((a, L) => a + L.items.filter((it) => it.eid && matches(it.eid, JSON.stringify(it).toLowerCase())).length, 0) : 0;
    $("#fbar").hidden = !active; $("#clear-filter").hidden = !active;
    if (active) $("#fbar-text").textContent = `Showing ${total} ${total === 1 ? "entry" : "entries"}: ${[state.pattern && LABEL[state.pattern], state.q && `"${state.q}"`].filter(Boolean).join(" + ")}`;
    if ($("#q").value !== state.q) $("#q").value = state.q;
    if (scroll && state.pattern) $("#patterns").scrollIntoView({ behavior: "smooth" });
  }

  function jumpTo(id) {
    let n = document.getElementById("e-" + id);
    if (!n) {
      const key = ITEM[id]; if (!key) return;
      if (state.pattern || state.q) setFilter({ pattern: null, q: "" });
      state.expanded[key] = true; drawList(key);
      n = document.getElementById("e-" + id);
    }
    if (!n) return;
    n._toggle(true);
    n.scrollIntoView({ behavior: "smooth", block: "start" });
    n.classList.remove("flash"); void n.offsetWidth; n.classList.add("flash");
    history.replaceState(null, "", "#e-" + id);
  }

  function drawPatterns() {
    const P = D0.patterns || [];
    const max = Math.max(1, ...P.map((p) => p.total));
    table($("#patterns-tbl"), [{ label: "Pattern" }, { label: "", cls: "hide-sm" }, { label: "News", num: true }, { label: "Crypto", num: true }, { label: "Exploited", num: true }, { label: "X", num: true, cls: "hide-sm" }, { label: "7 days", num: true }, { label: "Crypto losses", num: true, cls: "hide-sm" }],
      P.map((p) => {
        const b = el("button", { type: "button", class: "plink", "aria-pressed": String(state.pattern === p.id) }, p.label);
        b.addEventListener("click", () => setFilter({ pattern: state.pattern === p.id ? null : p.id }));
        const tr = el("tr", { class: state.pattern === p.id ? "on" : null },
          el("td", {}, b), el("td", { class: "bar hide-sm" }, el("i", { style: `width:${(p.total / max) * 100}%` })),
          ...[p.news, p.crypto, p.kev].map((v) => el("td", { class: "num" }, v ? String(v) : "·")),
          el("td", { class: "num hide-sm" }, p.x ? String(p.x) : "·"), el("td", { class: "num" }, String(p.recent7)),
          el("td", { class: "num hide-sm" }, p.usd ? fmtUSD(p.usd) : "·"));
        return tr;
      }));
    $("#patterns-tbl").querySelectorAll("thead th").forEach((th, ix) => { if ([1, 5, 7].includes(ix)) th.classList.add("hide-sm"); });
  }

  function drawClusters() {
    const C = D0.clusters || [];
    const box = $("#cluster-list"); box.replaceChildren();
    if (!C.length) { box.append(el("p", { class: "empty" }, "No strongly related incidents this window.")); return; }
    C.forEach((c) => {
      const kinds = Object.entries(c.kinds).map(([k, n]) => `${n} ${KIND[k].toLowerCase()}`).join(", ");
      const ul = el("ul", { class: "rel" }, c.members.map((m, ix) => {
        const a = el("a", { href: `#e-${m}`, class: "jump" }, c.titles[ix]);
        a.addEventListener("click", (e) => { e.preventDefault(); jumpTo(m); });
        return el("li", {}, el("span", { class: "rk" }, KIND[m[0] === "n" ? "news" : m[0] === "c" ? "crypto" : m[0] === "k" ? "kev" : "x"]), el("span", { class: "rt" }, a));
      }));
      const main = el("div", { class: "main" },
        el("div", { class: "k" }, el("span", {}, `${c.size} entries`), el("span", {}, kinds), el("span", {}, `latest ${fmtDate(c.latest)}`), el("span", { title: "Average pairwise similarity" }, `cohesion ${c.cohesion.toFixed(2)}`)),
        el("p", { class: "t" }, c.terms.slice(0, 4).join(" · ")),
        el("div", { class: "cpat" }, patChips(c.patterns)), ul);
      const ask = `Are these incidents connected, and what attack pattern do they share? ${c.titles.join("; ")}`;
      box.append(el("div", { class: "entry", id: c.id, "data-ctx": "related-incident group" }, main, note([], ask, "related-incident group")));
    });
  }

  function table(tbl, head, rows) {
    tbl.replaceChildren(el("thead", {}, el("tr", {}, head.map((h) => el("th", { class: h.num ? "num" : h.cls }, h.label)))), el("tbody", {}, rows));
  }

  function barTable(tbl, label, pairs, total) {
    const max = Math.max(1, ...pairs.map((p) => p[1]));
    table(tbl, [{ label }, { label: "" }, { label: "7 days", num: true }], pairs.map(([n, c]) =>
      el("tr", {}, el("td", {}, n), el("td", { class: "bar" }, el("i", { style: `width:${(c / max) * 100}%` })), el("td", { class: "num" }, String(c)))));
  }

  let D0 = {};
  function render(D) {
    D0 = D; DET = D.details || {};
    (D.pattern_defs || []).forEach((p) => { LABEL[p.id] = p.label; });
    const k = D.kev, r = D.ransomware, c = D.crypto;
    const news48 = D.news.filter((n) => hoursAgo(n.date) <= 48);
    const crypto7 = c.items.filter((i) => hoursAgo(i.date + "T23:59:59Z") <= 24 * 7);
    $("#asof").textContent = fmtLong(D.generated);
    $("#foot-asof").textContent = "Last rebuilt " + fmtLong(D.generated);

    // Abstract
    const biggest = [...crypto7].sort((a, b) => (b.amount || 0) - (a.amount || 0))[0];
    $("#abstract").innerHTML =
      `In the past seven days, public sources recorded <b>${c.count_7d} crypto exploits</b> totalling at least <b>${fmtUSD(c.usd_7d)}</b>` +
      (biggest ? `, the largest at ${biggest.name} (${fmtUSD(biggest.amount)})` : "") +
      `; <b>${r.count_7d ?? "—"} ransomware leak-site claims</b>, ${r.count_24h ?? "—"} of them in the last 24 hours; and <b>${k.count_7d} newly confirmed exploited vulnerabilities</b> in CISA's catalog. ` +
      `${news48.length} incident reports appeared in the security press over the last 48 hours. Each entry below opens into a detail view with its attack pattern, similar incidents and sources, and links to its reporting, to live discussion on X and to Perplexity. ` +
      `Counts are claims as published, not verified totals.`;
    $("#ask-today").href = askURL("What are the most significant cyber security incidents, hacks and exploited vulnerabilities reported in the last 24 hours?", "today's summary");

    // Ticks
    const ticks = [
      [r.count_24h ?? "—", "Ransomware claims", "last 24 hours"],
      [c.count_7d, "Crypto exploits", `${fmtUSD(c.usd_7d)} lost, 7 days`],
      [k.count_7d, "Exploited CVEs added", "CISA KEV, 7 days"],
      [news48.length, "Incident reports", "security press, 48 hours"],
    ];
    $("#ticks").replaceChildren(...ticks.map(([n, l, s]) => el("div", { class: "tick" }, el("div", { class: "n" }, String(n)), el("div", { class: "l" }, l), el("div", { class: "s" }, s))));

    // Series
    const series = [["Ransomware", r.series], ["Crypto", c.series], ["Exploited CVEs", k.series]];
    const rows = series.map(([name, s]) => {
      const max = Math.max(1, ...s.map((x) => x[1]));
      const total = s.reduce((a, x) => a + x[1], 0);
      return el("div", { class: "row" }, el("div", { class: "name" }, name),
        el("div", { class: "cells", role: "img", "aria-label": `${name}: ${total} in 30 days` },
          s.map(([d, n]) => el("i", { class: n ? "" : "z", title: `${fmtDate(d)}: ${n}`, style: n ? `--w:${Math.max(18, Math.sqrt(n / max) * 100)}%` : null }))),
        el("div", { class: "total" }, String(total)));
    });
    const s0 = series[0][1];
    rows.push(el("div", { class: "axis" }, el("span"), el("span", {}, el("span", {}, fmtDate(s0[0][0])), el("span", {}, fmtDate(s0[14][0])), el("span", {}, "Today")), el("span", { style: "text-align:right" }, "30 days")));
    $("#series").replaceChildren(...rows);

    // Today
    $("#today-lede").textContent = `${news48.length} reports in the last 48 hours from The Record, The Hacker News, BleepingComputer, DataBreaches.net and others, newest first. Headlines are filtered for incidents, exploitation and disclosures.`;
    list("news", $("#news-list"), D.news, (n) => entry({
      id: n.eid, kind: "news", it: n, title: n.title, text: n.summary,
      k: [el("span", {}, n.source), el("span", {}, ago(n.date))],
      t: escape(n.title), d: n.summary, clamp: true,
      links: [{ label: n.source, url: n.url }, { label: "Search X", url: xSearch(n.title.split(/[:—–-]/)[0].slice(0, 90)) }],
      ask: n.title, ctx: `news item from ${n.source}`,
    }), 8);

    list("x", $("#x-list"), D.x || [], (x) => entry({
      id: x.eid, kind: "x", it: x, title: x.subject, text: x.claim,
      k: [el("span", { class: `stage ${x.stage}` }, x.stage), el("span", {}, x.category), el("span", {}, fmtDate(x.date))],
      t: `${escape(x.subject)}${x.amount_usd_claimed ? ` <span class="amt">· ${fmtUSD(x.amount_usd_claimed)} claimed</span>` : ""}`,
      d: x.claim, links: x.links, ask: `${x.subject}: ${x.claim}`, ctx: "early signal from X",
    }), 6);

    // Crypto
    $("#crypto-lede").textContent = `${c.count_30d} exploits in the last 30 days, ${fmtUSD(c.usd_30d)} in reported losses. On-chain incidents are the easiest to corroborate: amounts and wallet flows are public, and protocols usually confirm on X within hours.`;
    list("crypto", $("#crypto-list"), c.items, (i) => entry({
      id: i.eid, kind: "crypto", it: i, title: i.name, text: i.desc,
      k: [el("span", {}, fmtDate(i.date)), i.chains.length ? el("span", {}, i.chains.slice(0, 3).join(", ") + (i.chains.length > 3 ? ` +${i.chains.length - 3}` : "")) : null, el("span", {}, i.technique || i.classification || "")],
      t: `${escape(i.name)} <span class="amt">· ${fmtUSD(i.amount)}</span>${i.returned ? ` <span class="amt">(${fmtUSD(i.returned)} returned)</span>` : ""}`,
      d: i.desc, clamp: true, links: i.links, ask: `${i.name} crypto exploit (${i.date}): ${i.desc.slice(0, 300)}`, ctx: "crypto exploit entry",
    }), 10);

    // Ransomware
    const cov = r.coverage_days && r.coverage_days < 29 ? ` The local index currently covers ${Math.round(r.coverage_days)} days and fills in as the job runs.` : "";
    $("#ransom-lede").textContent = `${r.count_7d ?? "—"} organisations were listed on ransomware leak sites in the last seven days, and ${r.count_30d ?? "—"} over 30 days. These are extortion claims by criminal groups; many are inflated, recycled or never confirmed, so only aggregates are shown.${cov}`;
    barTable($("#groups-tbl"), "Group", r.groups_7d || []);
    barTable($("#sectors-tbl"), "Sector", r.sectors_7d || []);
    barTable($("#countries-tbl"), "Country", r.countries_7d || []);
    $("#groups-tbl").querySelectorAll("tbody tr").forEach((tr, ix) => {
      const g = r.groups_7d[ix][0];
      const td = tr.firstChild; td.replaceChildren(el("a", { href: `https://www.ransomware.live/group/${encodeURIComponent(g.toLowerCase())}`, target: "_blank", rel: "noopener" }, g));
    });

    // KEV
    $("#kev-lede").textContent = `${k.count_30d} vulnerabilities were added to CISA's Known Exploited Vulnerabilities catalog in the last 30 days (${k.count_7d} this week)` + (k.ransomware_linked_30d ? `, ${k.ransomware_linked_30d} with known ransomware use` : "") + `. A KEV listing is the strongest public confirmation that a flaw is being exploited in the wild.`;
    list("kev", $("#kev-list"), k.items, (v) => entry({
      id: v.eid, kind: "kev", it: v, title: `${v.id}: ${v.name}`, text: v.desc,
      k: [el("span", {}, v.id), el("span", {}, `added ${fmtDate(v.date)}`), v.ransomware ? el("span", { class: "stage Confirmed" }, "ransomware use") : null],
      t: `${escape(v.vendor)} ${escape(v.product)} <span class="amt">· ${escape(v.name.toLowerCase().startsWith(v.vendor.toLowerCase() + " ") ? v.name.slice(v.vendor.length + 1) : v.name)}</span>`,
      d: v.desc, clamp: true, links: v.links, ask: `${v.id}: ${v.name}. ${v.desc}`, ctx: "CISA KEV entry",
    }), 10);

    // Patterns
    const P = D.patterns || [];
    const top = P.filter((p) => p.id !== "unclassified").slice(0, 3).map((p) => `${p.label.toLowerCase()} (${p.total})`).join(", ");
    $("#patterns-lede").textContent = `Every entry is tagged with one or more attack patterns, from its text, DefiLlama's classification or CISA's weakness codes. The most common this window: ${top}. Select a pattern, or type below, to filter every list on the page.`;
    drawPatterns(); drawClusters();
    let qt; $("#q").addEventListener("input", (e) => { clearTimeout(qt); qt = setTimeout(() => setFilter({ q: e.target.value.trim() }), 150); });
    $("#clear-filter").addEventListener("click", () => setFilter({ pattern: null, q: "" }));
    $("#fbar-clear").addEventListener("click", () => setFilter({ pattern: null, q: "" }));
    if (/^#e-/.test(location.hash)) setTimeout(() => jumpTo(location.hash.slice(3)), 50);

    $("#status").textContent = `Last build ${D.generated}.` + (D.errors.length ? ` Partial: ${D.errors.length} source${D.errors.length > 1 ? "s" : ""} unavailable this hour; previous values kept.` : " All sources responded.");
    $("#cite-block").textContent = `Breach Ledger. "A Daily Record of Cyber Incidents."\nRetrieved ${fmtLong(D.generated)}.\n${PAGE_URL}`;
  }

  function escape(s) { return String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch])); }

  // Selection → Ask Perplexity
  const pop = $("#ask-pop");
  let selText = "", selCtx = "";
  function sectionOf(node) {
    const n = node.nodeType === 1 ? node : node.parentElement;
    const sec = n && n.closest("section[id]");
    const h = sec && sec.querySelector("h2");
    const ent = n && n.closest(".entry");
    const t = ent && ent.querySelector(".t");
    return [h ? `section "${h.textContent}"` : "", t ? `entry "${t.textContent.trim()}"` : ""].filter(Boolean).join(", ");
  }
  function showPop() {
    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : "";
    if (!text || text.length < 3 || !sel.rangeCount) { pop.hidden = true; return; }
    const range = sel.getRangeAt(0);
    if (!$("#main").contains(range.commonAncestorContainer)) { pop.hidden = true; return; }
    const rect = range.getBoundingClientRect();
    selText = text.slice(0, 1200); selCtx = sectionOf(range.startContainer);
    pop.style.left = `${Math.min(Math.max(rect.left + rect.width / 2, 70), document.documentElement.clientWidth - 70) + window.scrollX}px`;
    pop.style.top = `${rect.top + window.scrollY - 10}px`;
    pop.hidden = false;
  }
  document.addEventListener("mouseup", () => setTimeout(showPop, 0));
  document.addEventListener("keyup", (e) => { if (e.key === "Escape") pop.hidden = true; else if (e.shiftKey) showPop(); });
  document.addEventListener("selectionchange", () => { const s = window.getSelection(); if (!s || s.isCollapsed) setTimeout(() => { const s2 = window.getSelection(); if (!s2 || s2.isCollapsed) pop.hidden = true; }, 200); });
  let touchT; document.addEventListener("touchend", () => { clearTimeout(touchT); touchT = setTimeout(showPop, 350); });
  pop.addEventListener("mousedown", (e) => e.preventDefault());
  pop.addEventListener("click", () => { window.open(askURL(selText, selCtx), "_blank", "noopener"); pop.hidden = true; });

  // Active section in TOC + nav
  function spy() {
    const ids = ["today", "news", "x-signals", "patterns", "clusters", "crypto", "ransomware", "groups", "sectors", "exploited", "method", "stages", "sources", "limits", "cite"];
    const obs = new IntersectionObserver((ents) => {
      ents.forEach((e) => {
        if (!e.isIntersecting) return;
        const id = e.target.id;
        document.querySelectorAll(".toc a").forEach((a) => a.classList.toggle("on", a.getAttribute("href") === "#" + id));
        const top = e.target.closest("section[id]")?.id || id;
        document.querySelectorAll("header nav a").forEach((a) => a.classList.toggle("on", a.getAttribute("href") === "#" + top));
      });
    }, { rootMargin: "0px 0px -75% 0px" });
    ids.forEach((id) => { const n = document.getElementById(id); n && obs.observe(n); });
  }

  fetch("data.json", { cache: "no-store" })
    .then((r) => r.json()).then((D) => { render(D); spy(); })
    .catch(() => { $("#abstract").textContent = "The record could not be loaded. Try again in a moment."; });
})();
