(() => {
  "use strict";
  // Canonical public address of this page, used in "Ask Perplexity" prompts.
  const PAGE_URL = "__PAGE_URL__".startsWith("__") ? location.href.split("#")[0] : "__PAGE_URL__";
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

  function entry({ k, t, d, links, ask, ctx, clamp }) {
    const main = el("div", { class: "main" }, el("div", { class: "k" }, k), el("p", { class: "t", html: t }));
    if (d) {
      const p = el("p", { class: "d" + (clamp ? " clamp" : "") }, d);
      main.append(p);
      if (clamp && d.length > 260) {
        const b = el("button", { class: "more", type: "button", "aria-expanded": "false" }, "Read more");
        b.addEventListener("click", () => { const open = p.classList.toggle("clamp"); b.textContent = open ? "Read more" : "Show less"; b.setAttribute("aria-expanded", String(!open)); });
        main.append(b);
      }
    }
    return el("div", { class: "entry", "data-ctx": ctx }, main, note(links, ask, ctx));
  }

  function list(container, items, render, initial) {
    container.replaceChildren();
    if (!items.length) { container.append(el("p", { class: "empty" }, "Nothing recorded in this window.")); return; }
    items.slice(0, initial).forEach((it) => container.append(render(it)));
    if (items.length > initial) {
      const b = el("button", { class: "showall", type: "button" }, `Show all ${items.length}`);
      b.addEventListener("click", () => { items.slice(initial).forEach((it) => container.insertBefore(render(it), b)); b.remove(); });
      container.append(b);
    }
  }

  function table(tbl, head, rows) {
    tbl.replaceChildren(el("thead", {}, el("tr", {}, head.map((h) => el("th", { class: h.num ? "num" : h.cls }, h.label)))), el("tbody", {}, rows));
  }

  function barTable(tbl, label, pairs, total) {
    const max = Math.max(1, ...pairs.map((p) => p[1]));
    table(tbl, [{ label }, { label: "" }, { label: "7 days", num: true }], pairs.map(([n, c]) =>
      el("tr", {}, el("td", {}, n), el("td", { class: "bar" }, el("i", { style: `width:${(c / max) * 100}%` })), el("td", { class: "num" }, String(c)))));
  }

  function render(D) {
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
      `${news48.length} incident reports appeared in the security press over the last 48 hours. Each entry below links to its reporting, to live discussion on X, and to Perplexity for a sourced explanation. ` +
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
    list($("#news-list"), D.news, (n) => entry({
      k: [el("span", {}, n.source), el("span", {}, ago(n.date))],
      t: escape(n.title), d: n.summary, clamp: true,
      links: [{ label: n.source, url: n.url }, { label: "Search X", url: xSearch(n.title.split(/[:—–-]/)[0].slice(0, 90)) }],
      ask: n.title, ctx: `news item from ${n.source}`,
    }), 8);

    list($("#x-list"), D.x || [], (x) => entry({
      k: [el("span", { class: `stage ${x.stage}` }, x.stage), el("span", {}, x.category), el("span", {}, fmtDate(x.date))],
      t: `${escape(x.subject)}${x.amount_usd_claimed ? ` <span class="amt">· ${fmtUSD(x.amount_usd_claimed)} claimed</span>` : ""}`,
      d: x.claim, links: x.links, ask: `${x.subject}: ${x.claim}`, ctx: "early signal from X",
    }), 6);

    // Crypto
    $("#crypto-lede").textContent = `${c.count_30d} exploits in the last 30 days, ${fmtUSD(c.usd_30d)} in reported losses. On-chain incidents are the easiest to corroborate: amounts and wallet flows are public, and protocols usually confirm on X within hours.`;
    list($("#crypto-list"), c.items, (i) => entry({
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
    table($("#kev-tbl"), [{ label: "CVE" }, { label: "Vulnerability" }, { label: "Added", num: true }, { label: "Links", cls: "hide-sm" }],
      k.items.map((v) => el("tr", {},
        el("td", {}, v.id),
        el("td", {}, el("span", {}, v.name), el("span", { class: "sub" }, `${v.vendor} ${v.product}${v.ransomware ? " · ransomware use" : ""}`)),
        el("td", { class: "num" }, fmtDate(v.date)),
        el("td", { class: "hide-sm" }, ...v.links.map((l, ix) => [ix ? " " : "", el("a", { href: l.url, target: "_blank", rel: "noopener" }, l.label)]).flat(),
          " ", el("a", { href: askURL(`${v.id}: ${v.name}. ${v.desc}`, "CISA KEV entry"), target: "_blank", rel: "noopener" }, "Ask")))));

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
    const ids = ["today", "news", "x-signals", "crypto", "ransomware", "groups", "sectors", "exploited", "method", "stages", "sources", "limits", "cite"];
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
