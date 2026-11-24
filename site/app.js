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

  const KIND = { inc: "Incident", news: "News", crypto: "Crypto", kev: "Exploited", x: "X signal", breach: "Breach" };
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

  const STAGES = ["Rumour", "Claimed", "Corroborated", "Confirmed", "Post-mortem"];
  const ROLE = { official: "Affected party", security: "Security firm", investigator: "Investigator", media: "Media", aggregator: "Aggregator", user: "User", unknown: "Unverified account" };
  const hrs = (h) => h == null ? null : h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${h.toFixed(h < 10 ? 1 : 0)} h` : `${Math.round(h / 24)} days`;
  function track(stage) {
    const i = STAGES.indexOf(stage);
    const n = el("span", { class: "track" + (i < 0 ? " off" : ""), role: "img", "aria-label": `Stage: ${stage}` });
    STAGES.forEach((s, ix) => n.append(el("i", { class: ix <= i ? "on" : null, title: s })));
    n.append(el("b", {}, stage));
    return n;
  }
  function xFor(eid) { return (D0.x || []).find((x) => (x.matches || []).some((m) => m.eid === eid)); }

  function detailPanel(it, kind, id, title, text) {
    const det = DET[id] || {};
    const box = el("div", { class: "detail" });
    let rows;
    if (kind === "crypto") rows = [["Loss", fmtUSD(it.amount)], ["Returned", it.returned ? fmtUSD(it.returned) : null], ["Date", fmtDate(it.date)],
      ["Chains", it.chains.join(", ")], ["Classification", it.classification], ["Technique", it.technique],
      ["SlowMist method", it.slowmist_method && it.slowmist_method !== it.technique ? it.slowmist_method : null], ["Target", it.target],
      ["Listed by", (it.sources || []).join(", ")], ["Press coverage", it.n_outlets ? `${it.n_outlets} outlet${it.n_outlets === 1 ? "" : "s"}, first ${fmtLong(it.first_press)}` : null],
      ["In totals", it.offchain ? "No: bank-account fraud, not a crypto loss" : "Yes, gross (before frozen or returned funds)"]];
    else if (kind === "breach") rows = [["Accounts", it.count ? it.count.toLocaleString("en-US") : null], ["Domain", it.domain || null], ["Breach date", it.breach_date ? fmtDate(it.breach_date) + " " + it.breach_date.slice(0, 4) : null],
      ["Added to HIBP", fmtLong(it.added)], ["Data exposed", it.classes.join(", ")], ["Verified", it.verified ? "Yes" : "No"]];
    else if (kind === "kev") rows = [["CVE", it.id], ["Product", `${it.vendor} ${it.product}`], ["Added to KEV", fmtDate(it.date)], ["Patch due", it.due ? fmtDate(it.due) : null],
      ["Ransomware use", it.ransomware ? "Known" : "Not known"],
      ["Weakness", (it.cwes || []).length ? (det.cwes || it.cwes.map((c) => ({ id: c }))).map((c, ix) => [ix ? ", " : "", el("a", { href: `https://cwe.mitre.org/data/definitions/${c.id.replace("CWE-", "")}.html`, target: "_blank", rel: "noopener" }, c.id), c.name ? ` ${c.name.toLowerCase()}` : ""]).flat() : null]];
    else if (kind === "news") rows = [["Source", it.source], ["First seen", fmtLong(it.date)], ["Coverage", it.n_outlets > 1 ? `${it.n_outlets} outlets` : null]];
    else if (kind === "arc") { const a = it._arc; let host = ""; try { host = a.u ? new URL(a.u).hostname.replace(/^www\./, "") : ""; } catch (e) {}
      rows = [["Record", { inc: "Incident", crypto: "Crypto hack", ransom: "Ransomware leak-site claim", breach: "Breach added to Have I Been Pwned", notice: "Official breach notice", sec: "SEC 8-K, Item 1.05 (material cybersecurity incident)", kev: "Added to CISA Known Exploited Vulnerabilities" }[a.k] || a.k],
        ["Date", fmtDate(a.d.slice(0, 10)) + " " + a.d.slice(0, 4)], ["Organisation", a.o], ["Scale", a.s || null], ["Details", a.x || null],
        ["Source", a.u ? el("a", { href: a.u, target: "_blank", rel: "noopener" }, host || "Open") : null]]; }
    else if (kind === "inc") rows = [["Type", it.type], ["Status", it.status], ["Sector", it.sector], ["Country", it.country], ["Threat actor", it.actor], ["Initial access", it.vector],
      ["Records", it.records ? it.records.toLocaleString("en-US") : null], ["Loss", it.usd ? fmtUSD(it.usd) : null],
      ["Incident date", it.event_date ? fmtDate(it.event_date) + " " + it.event_date.slice(0, 4) : null], ["First reported", fmtLong(it.first_reported)],
      ["Latest", fmtLong(it.latest)], ["Coverage", `${it.n_outlets} outlet${it.n_outlets === 1 ? "" : "s"}${(it.notices || []).length ? `, ${it.notices.length} official notice${it.notices.length === 1 ? "" : "s"}` : ""}`]];
    else {
      const db = (it.matches || []).map((m) => [(m.sources || []).length ? m.sources.join(" and ") : m.label, m.listed_at ? ` listed ${hrs(m.lag_h)} after the first post` : " list it"].join("")).join("; ");
      rows = [["Stage", track(it.stage)], ["Credibility", `${it.score} / 100`],
        ["Accounts", `${it.accounts} posting, ${it.credible} credible${it.official ? ", affected party has confirmed" : ", no word from the affected party"}`],
        ["Claimed", it.amount_usd_claimed ? fmtUSD(it.amount_usd_claimed) : null], ["First post", fmtLong(it.date)],
        ["To confirmation", it.hours_to_confirm != null ? (it.hours_to_confirm < 0.05 ? "Confirmed in the earliest post found" : hrs(it.hours_to_confirm) + " after the first post") : (it.stale ? `Unconfirmed after ${hrs(it.age_h)}` : "Not yet")],
        ["Post-mortem", it.postmortem && it.postmortem.url ? el("a", { href: it.postmortem.url, target: "_blank", rel: "noopener" }, `${it.postmortem.label || "Write-up"}${it.postmortem.auto ? " (found automatically)" : ""}`) : "Not published yet"],
        ["Databases", db || "Not yet in DefiLlama, SlowMist, HIBP or CISA"],
        ["Press", it.press_lead_h != null ? `First article ${hrs(it.press_lead_h)} after the first post` : null]];
    }
    if (kind === "crypto") { const x = xFor(id); if (x) rows.push(["First on X", `${fmtLong(x.date)} (${x.posts.length} posts, now ${x.stage.toLowerCase()})`]); }
    rows.unshift(["Pattern", (det.patterns || []).length ? patChips(det.patterns) : null]);
    box.append(facts(rows));
    const tm = (t) => `${fmtDate(t)} ${t.length > 10 ? new Date(t).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }) : ""}`;
    const A = (url, label) => el("a", { href: url, target: "_blank", rel: "noopener" }, label);
    if (kind === "inc") {
      if ((it.affected || []).length) box.append(el("div", { class: "dsec" }, el("h4", {}, `Affected organisations (${it.affected.length} named)`), el("p", { class: "dnote" }, it.affected.join(", "))));
      if ((it.payloads || []).length) box.append(el("div", { class: "dsec" }, el("h4", {}, "How the attack worked"), el("ul", { class: "plain" }, it.payloads.map((x) => el("li", {}, x)))));
      if ((it.guidance || []).length) box.append(el("div", { class: "dsec" }, el("h4", {}, "What to do"), el("ul", { class: "plain" }, it.guidance.map((x) => el("li", {}, x)))));
      if ((it.updates || []).length) box.append(el("div", { class: "dsec" }, el("h4", {}, "Developments"),
        el("ol", { class: "life" }, it.updates.map((u) => el("li", {}, el("span", { class: "rk" }, tm(u.date)), el("span", { class: "rt" }, u.url ? A(u.url, u.text) : u.text))))));
      if ((it.notices || []).length) box.append(el("div", { class: "dsec" }, el("h4", {}, "Official notices"),
        el("ul", { class: "rel" }, it.notices.map((o) => el("li", {}, el("span", { class: "rk" }, fmtDate(o.date)), el("span", { class: "rt" }, A(o.url, o.title), o.count ? ` (${o.count.toLocaleString("en-US")} people)` : ""))))));
      if ((it.sources || []).length) box.append(el("div", { class: "dsec" }, el("h4", {}, "Key sources"),
        el("ul", { class: "rel" }, it.sources.map((l) => el("li", {}, el("span", { class: "rt" }, A(l.url, l.label)))))));
    }
    if ((kind === "inc" || kind === "news" || kind === "crypto") && (it.outlets || []).length > (kind === "crypto" ? 0 : 1)) {
      const os = it.outlets.slice().sort((a, b) => a.date < b.date ? -1 : 1);
      box.append(el("div", { class: "dsec" }, el("h4", {}, `Coverage timeline (${it.n_outlets} outlets)`),
        el("ul", { class: "rel posts" }, os.map((o) => el("li", {}, el("span", { class: "rk" }, tm(o.date)),
          el("span", { class: "rt" }, A(o.url, o.source), el("span", { class: "why" }, o.title)))))));
    }
    if (kind === "kev" && it.action) box.append(el("p", { class: "dnote" }, el("b", {}, "Required action. "), it.action));

    if (kind === "x" && (it.history || []).length) {
      const sec = el("div", { class: "dsec" }, el("h4", {}, "How it was confirmed"));
      sec.append(el("ol", { class: "life" }, it.history.map((h) => el("li", {}, el("span", { class: "rk" }, `${fmtDate(h.t)} ${new Date(h.t).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" })} UTC`), el("span", { class: "ls" }, h.stage),
        el("span", { class: "rt" }, h.url ? el("a", { href: h.url, target: "_blank", rel: "noopener" }, h.by) : h.by)))));
      box.append(sec);
    }
    if (kind === "x" && (it.posts || []).length) {
      const sec = el("div", { class: "dsec" }, el("h4", {}, `Posts (${it.posts.length})`));
      sec.append(el("ul", { class: "rel posts" }, it.posts.map((p) => el("li", {},
        el("span", { class: "rk" }, `${fmtDate(p.date)} ${new Date(p.date).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" })}`),
        el("span", { class: "rt" }, el("a", { href: p.url, target: "_blank", rel: "noopener" }, "@" + p.handle), el("span", { class: "role" }, ` ${ROLE[p.role] || p.role}${p.stance && p.stance !== "report" ? " · " + p.stance : ""}${p.evidence === "onchain" ? " · on-chain evidence" : ""}`), p.note ? el("span", { class: "why" }, p.note) : null),
        el("span", { class: "rs", title: "Account weight" }, p.w != null ? p.w.toFixed(2) : "")))));
      sec.append(el("p", { class: "dsrc" }, "Weight reflects who the account is: affected party 1.0, security firm 0.7, investigator 0.65, media 0.4, aggregator 0.2, user 0.12, unverified 0.08; raised for on-chain evidence. Credibility combines independent accounts, so many users reporting the same thing adds up."));
      box.append(sec);
    }
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
    if (document.body.classList.contains("view-term") && window.BL && BL.inspect) return BL.inspect(id);
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
    table($("#patterns-tbl"), [{ label: "Pattern" }, { label: "", cls: "hide-sm" }, { label: "News", num: true }, { label: "Crypto", num: true }, { label: "Exploited", num: true }, { label: "Breaches", num: true, cls: "hide-sm" }, { label: "X", num: true, cls: "hide-sm" }, { label: "7 days", num: true }, { label: "Crypto losses", num: true, cls: "hide-sm" }],
      P.map((p) => {
        const b = el("button", { type: "button", class: "plink", "aria-pressed": String(state.pattern === p.id) }, p.label);
        b.addEventListener("click", () => setFilter({ pattern: state.pattern === p.id ? null : p.id }));
        const tr = el("tr", { class: state.pattern === p.id ? "on" : null },
          el("td", {}, b), el("td", { class: "bar hide-sm" }, el("i", { style: `width:${(p.total / max) * 100}%` })),
          ...[p.news, p.crypto, p.kev].map((v) => el("td", { class: "num" }, v ? String(v) : "·")),
          el("td", { class: "num hide-sm" }, p.breach ? String(p.breach) : "·"), el("td", { class: "num hide-sm" }, p.x ? String(p.x) : "·"), el("td", { class: "num" }, String(p.recent7)),
          el("td", { class: "num hide-sm" }, p.usd ? fmtUSD(p.usd) : "·"));
        return tr;
      }));
    $("#patterns-tbl").querySelectorAll("thead th").forEach((th, ix) => { if ([1, 5, 6, 8].includes(ix)) th.classList.add("hide-sm"); });
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
        return el("li", {}, el("span", { class: "rk" }, KIND[{ n: "news", c: "crypto", k: "kev", x: "x", b: "breach" }[m[0]]]), el("span", { class: "rt" }, a));
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
  // KPI strip cells, same markup as the leaderboard's .b-k
  function kpis(box, cells) {
    box.replaceChildren(...cells.map(([n, l, s]) => el("div", { class: "b-k" }, el("span", {}, l), el("b", {}, String(n)), el("i", {}, s))));
  }

  let D0 = {};
  function render(D) {
    D0 = D; DET = D.details || {}; noteNo = 0;
    (D.pattern_defs || []).forEach((p) => { LABEL[p.id] = p.label; });
    const k = D.kev, r = D.ransomware, c = D.crypto;
    const news48 = D.news.filter((n) => hoursAgo(n.date) <= 48);
    const crypto7 = c.items.filter((i) => hoursAgo(i.date + "T23:59:59Z") <= 24 * 7);
    $("#asof").textContent = fmtLong(D.generated);
    $("#foot-asof").textContent = "Last rebuilt " + fmtLong(D.generated);

    // Abstract
    const biggest = [...crypto7].sort((a, b) => (b.amount || 0) - (a.amount || 0))[0];
    $("#abstract").innerHTML = `What was hacked today, who was hit, how much was taken and how they got in, from ransomware leak sites, CISA, DefiLlama, SlowMist, Have I Been Pwned, the security press and X. Polled live, rebuilt hourly. This week: <b>${c.count_7d} crypto exploits</b> (${fmtUSD(c.usd_7d)}), <b>${r.count_7d ?? "—"} ransomware claims</b>, <b>${k.count_7d} exploited flaws</b>${biggest ? `; largest loss ${escape(biggest.name)}, ${fmtUSD(biggest.amount)}` : ""}.`;
    $("#ask-today").href = askURL("What are the most significant cyber security incidents, hacks and exploited vulnerabilities reported in the last 24 hours?", "today's summary");

    // Ticks
    const ticks = [
      [r.count_24h ?? "—", "Ransomware claims", "last 24 hours"],
      [c.count_7d, "Crypto exploits", `${fmtUSD(c.usd_7d)} lost, 7 days`],
      [k.count_7d, "Exploited CVEs added", "CISA KEV, 7 days"],
      [news48.length, "Incident reports", "security press, 48 hours"],
      [D.breaches ? compact(D.breaches.accounts_30d) : "—", "Breached accounts", `${D.breaches ? D.breaches.count_30d : 0} breaches added to HIBP, 30 days`],
    ];
    kpis($("#ticks"), ticks);

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
      k: [track(x.stage), el("span", {}, `${x.score}/100`), el("span", {}, `${x.accounts} accounts, ${x.credible} credible`), el("span", {}, `first post ${ago(x.date)}`), x.stale ? el("span", { class: "stale" }, "unconfirmed 24h+") : null],
      t: `${escape(x.subject)}${x.amount_usd_claimed ? ` <span class="amt">· ${fmtUSD(x.amount_usd_claimed)} claimed</span>` : ""}`,
      d: x.claim, links: x.links, ask: `${x.subject}: ${x.claim}`, ctx: "early signal from X",
    }), 6);

    // Crypto
    $("#crypto-lede").textContent = `${c.count_30d} exploits in the last 30 days, ${fmtUSD(c.usd_30d)} in reported losses. On-chain incidents are the easiest to corroborate: amounts and wallet flows are public, and protocols usually confirm on X within hours.`;
    list("crypto", $("#crypto-list"), c.items, (i) => entry({
      id: i.eid, kind: "crypto", it: i, title: i.name, text: i.desc,
      k: [el("span", {}, fmtDate(i.date)), i.chains.length ? el("span", {}, i.chains.slice(0, 3).join(", ") + (i.chains.length > 3 ? ` +${i.chains.length - 3}` : "")) : null, el("span", {}, i.technique || i.classification || ""), (i.sources || []).length > 1 ? el("span", { title: i.sources.join(", ") }, `${i.sources.length} sources`) : null],
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
    const B = D.breaches || { items: [], count_30d: 0, accounts_30d: 0 };
    $("#breach-lede").textContent = `${B.count_30d} breaches were added to Have I Been Pwned in the last 30 days, exposing ${B.accounts_30d.toLocaleString("en-US")} accounts. HIBP loads a breach only after obtaining and checking the data, so these are confirmed exposures; the breach itself may be older than the date it was added.`;
    list("breach", $("#breach-list"), B.items, (b) => entry({
      id: b.eid, kind: "breach", it: b, title: b.title, text: b.desc,
      k: [el("span", {}, `added ${ago(b.added)}`), b.domain ? el("span", {}, b.domain) : null, b.breach_date ? el("span", {}, `breached ${b.breach_date.slice(0, 7)}`) : null],
      t: `${escape(b.title)} <span class="amt">· ${b.count ? b.count.toLocaleString("en-US") : "?"} accounts</span>`,
      d: b.desc, clamp: true, links: b.links, ask: `${b.title} data breach: ${b.desc.slice(0, 300)}`, ctx: "Have I Been Pwned breach entry",
    }), 8);

    drawLive(D);
    drawGlance(D);

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
  $("#main").addEventListener("scroll", () => { if (!pop.hidden) showPop(); }, { passive: true });
  document.addEventListener("keyup", (e) => { if (e.key === "Escape") pop.hidden = true; else if (e.shiftKey) showPop(); });
  document.addEventListener("selectionchange", () => { const s = window.getSelection(); if (!s || s.isCollapsed) setTimeout(() => { const s2 = window.getSelection(); if (!s2 || s2.isCollapsed) pop.hidden = true; }, 200); });
  let touchT; document.addEventListener("touchend", () => { clearTimeout(touchT); touchT = setTimeout(showPop, 350); });
  pop.addEventListener("mousedown", (e) => e.preventDefault());
  pop.addEventListener("click", () => { window.open(askURL(selText, selCtx), "_blank", "noopener"); pop.hidden = true; });

  // Active section in TOC + nav
  function spy() {
    const ids = ["glance", "live", "today", "news", "x-signals", "patterns", "clusters", "crypto", "ransomware", "groups", "sectors", "breaches", "exploited", "method", "stages", "sources", "elsewhere", "limits", "cite"];
    const obs = new IntersectionObserver((ents) => {
      ents.forEach((e) => {
        if (!e.isIntersecting) return;
        const id = e.target.id;
        document.querySelectorAll(".toc a").forEach((a) => a.classList.toggle("on", a.getAttribute("href") === "#" + id));
        const top = e.target.closest("section[id]")?.id || id;
        document.querySelectorAll(".r-jump a").forEach((a) => a.classList.toggle("on", a.getAttribute("href") === "#" + top));
      });
    }, { rootMargin: "0px 0px -75% 0px" });
    ids.forEach((id) => { const n = document.getElementById(id); n && obs.observe(n); });
  }

  const compact = (n) => n >= 1e9 ? (n / 1e9).toFixed(1) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "K" : String(n);
  const ts = (s) => new Date(s.length === 10 ? s + "T00:00:00Z" : s).getTime();
  const norm = (n) => n.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]/g, "");
  const LIVE = { checked: null, extra: [], fresh: new Set(), prevIds: null, seen: null };
  LIVE.seen = Date.now();

  function events(D) {
    const ev = [];
    (D.notices || []).forEach((o) => ev.push({ kind: "notice", key: "o:" + o.url + o.org, url: o.url, t: o.date.endsWith("T00:00:00Z") ? o.date.slice(0, 10) : o.date, title: o.kind === "notice" ? o.title : `${o.org}: ${o.title}`, sub: o.source }));
    D.news.forEach((n) => ev.push({ id: n.eid, kind: "news", t: n.date, title: n.title, sub: n.n_outlets > 1 ? `${n.source} +${n.n_outlets - 1} outlet${n.n_outlets > 2 ? "s" : ""}` : n.source }));
    (D.x || []).forEach((x) => ev.push({ id: x.eid, kind: "x", t: x.date, title: x.subject, sub: `${x.stage}, ${x.accounts} accounts` + (x.amount_usd_claimed ? ` · ${fmtUSD(x.amount_usd_claimed)} claimed` : "") }));
    D.crypto.items.forEach((c) => ev.push({ id: c.eid, kind: "crypto", t: c.date, title: c.name, sub: `${fmtUSD(c.amount)}${c.technique && c.technique !== "Unknown" ? " · " + c.technique : ""}` }));
    D.kev.items.forEach((v) => ev.push({ id: v.eid, kind: "kev", t: v.date, title: `${v.vendor} ${v.product}`, sub: v.id }));
    ((D.breaches || {}).items || []).forEach((b) => ev.push({ id: b.eid, kind: "breach", t: b.added, title: b.title, sub: `${compact(b.count || 0)} accounts` }));
    return ev;
  }

  function drawLive(D) {
    const ev = [...LIVE.extra, ...events(D)].sort((a, b) => ts(b.t) - ts(a.t) || (b.t.length - a.t.length));
    const feed = $("#feed"); feed.replaceChildren();
    ev.slice(0, 12).forEach((e) => {
      const fresh = LIVE.fresh.has(e.id) || e.live || (LIVE.seen && e.t.length > 10 && ts(e.t) > LIVE.seen);
      const when = el("span", { class: "when", "data-ago": e.t.length > 10 ? e.t : null }, e.t.length > 10 ? ago(e.t) : fmtDate(e.t));
      const title = e.id ? el("a", { href: `#e-${e.id}`, class: "jump" }, e.title) : el("a", { href: e.url, target: "_blank", rel: "noopener" }, e.title);
      if (e.id) title.addEventListener("click", (x) => { x.preventDefault(); jumpTo(e.id); });
      feed.append(el("li", { class: fresh ? "fresh" : null }, when, el("span", { class: "fk" }, KIND[e.kind]), el("span", { class: "ft" }, title, el("span", { class: "fs" }, e.sub)), fresh ? el("span", { class: "new" }, "New") : el("span")));
    });
    if (LIVE.seen) {
      const n = ev.filter((e) => ts(e.t) > LIVE.seen && e.t.length > 10).length + ev.filter((e) => e.t.length === 10 && ts(e.t) > LIVE.seen).length;
      const s = $("#since"); s.hidden = false;
      s.textContent = n ? `${n} new ${n === 1 ? "entry" : "entries"} since you opened this page.` : `Watching for new entries since you opened this page.`;
    }
    // 24 hours
    const H = D.hourly || [];
    const rows = [["Ransomware", "ransomware"], ["Reports", "news"], ["X signals", "x"]].map(([name, key]) => {
      const max = Math.max(1, ...H.map((h) => h[key]));
      const total = H.reduce((a, h) => a + h[key], 0);
      return el("div", { class: "row" }, el("div", { class: "name" }, name),
        el("div", { class: "cells h24", role: "img", "aria-label": `${name}: ${total} in 24 hours` },
          H.map((h) => el("i", { class: h[key] ? "" : "z", title: `${new Date(h.t).toLocaleTimeString("en-US", { hour: "numeric" })}: ${h[key]}`, style: h[key] ? `--w:${Math.max(22, Math.sqrt(h[key] / max) * 100)}%` : null }))),
        el("div", { class: "total" }, String(total)));
    });
    if (H.length) rows.push(el("div", { class: "axis" }, el("span"), el("span", {}, el("span", {}, "24h ago"), el("span", {}, "12h"), el("span", {}, "Now")), el("span")));
    $("#hours").replaceChildren(...rows);
    setTimeout(() => window.BL && BL.onRender && BL.onRender(D0), 0);
  }

  function drawGlance(D) {
    const IXT = (eid) => { const n = (D.news || []).find((x) => x.eid === eid) || (D.x || []).find((x) => x.eid === eid); return n ? n.date : null; };
    const day = 24;
    const B = D.breaches || { items: [] };
    const R = D.ransomware || {};
    const inDay = (t) => t && (t.length === 10 ? hoursAgo(t + "T23:59:59Z") <= day : hoursAgo(t) <= day);
    const pats = (id) => ((DET[id] || {}).patterns || []).filter((p) => p !== "unclassified");
    const cr = D.crypto.items.filter((c) => !c.offchain && inDay(c.date));
    const br = B.items.filter((b) => inDay(b.added));
    const kv = D.kev.items.filter((v) => inDay(v.date));
    const nw = D.news.filter((n) => inDay(n.date));
    const rv = R.items_24h || [];
    const brief = D.brief && D.brief.incidents ? D.brief : null;

    $("#g-date").textContent = ", " + new Date(D.generated).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
    $("#g-brief").textContent = brief ? brief.headline : "";
    $("#g-brief").hidden = !brief;

    // Rows: curated first, then anything structured the brief did not cover.
    const rows = [];
    const seen = new Set();
    // Follow-ups on incidents that began more than 3 days ago are kept apart from today's hits.
    const ups = [];
    const isOld = (i) => i.update || (i.since && hoursAgo(i.since + "T23:59:59Z") > 72);
    const briefByOrg = new Map((brief?.incidents || []).map((i) => [i.org.toLowerCase(), i]));
    // Curated incident registry: every outlet and notice attached, so one row per real incident.
    const regScale = (r) => r.usd ? fmtUSD(r.usd) : r.records ? `${compact(r.records)} records` : (r.n_outlets ? `${r.n_outlets} outlet${r.n_outlets === 1 ? "" : "s"}` : "");
    const regRow = (r) => ({ org: r.org, what: r.title, scale: regScale(r), patterns: [], type: r.type, rid: "r-" + r.id, eid: (r.stories[0] || {}).eid, since: r.first_reported.slice(0, 10), n_outlets: r.n_outlets, reg: r, t: r.first_reported });
    (D.registry || []).forEach((r) => {
      const h = hoursAgo(r.first_reported);
      const item = briefByOrg.get(r.org.toLowerCase());
      if (h <= day && !item?.update) rows.push(regRow(r));
      else if (hoursAgo(r.latest) <= day || item?.update) {
        const row = regRow(r);
        ups.push({ ...row, eid: item?.eid || row.eid, t: r.latest, since: item?.update && item.since === null ? null : item?.since || r.event_date || row.since, what: item?.update ? item.what : ((r.updates || []).slice(-1)[0] || {}).text || (r.stories[0] || {}).title || r.title });
        if (item?.eid) seen.add(item.eid);
      }
      else return;
      r.stories.forEach((s) => s.eid && seen.add(s.eid));
    });
    // most-covered first: coverage breadth is the best available signal of significance
    const sig = (r) => (r.reg ? r.reg.n_outlets + Math.log10(1 + (r.reg.records || 0)) * 2 + Math.log10(1 + (r.reg.usd || 0)) * 2 : 0);
    const regOrgs = (D.registry || []).map((r) => (r.match || []).map((m) => m.toLowerCase())).flat().filter((m) => m.length >= 4);
    const regNames = (D.registry || []).filter((r) => hoursAgo(r.latest) <= day * 3).map((r) => r.org.toLowerCase().replace(/\s*\(.*?\)/g, "").trim()).filter((m) => m.length >= 4);
    const covered = (i) => { const o = (i.org || "").toLowerCase().replace(/\s*\(.*?\)/g, "").trim(); return regOrgs.some((m) => (i.org || "").toLowerCase().includes(m)) || (o.length >= 4 && regNames.some((m) => o.includes(m) || m.includes(o))); };
    if (brief) brief.incidents.filter((i) => !(i.eid && seen.has(i.eid)) && !covered(i)).forEach((i) => { (isOld(i) ? ups : rows).push({ ...i, t: (DET[i.eid] && IXT(i.eid)) || (i.since ? i.since + "T12:00:00Z" : null), patterns: i.patterns || pats(i.eid) }); i.eid && seen.add(i.eid); });
    const covR = (name) => covered({ org: name }) || (D.registry || []).some((r) => hoursAgo(r.latest) <= day && name && r.org.toLowerCase().split(/[ (]/)[0] === name.toLowerCase().split(/[ (]/)[0]);
    cr.filter((c) => !seen.has(c.eid) && !covR(c.name)).sort((a, b) => (b.amount || 0) - (a.amount || 0)).forEach((c) =>
      rows.push({ org: c.name, what: `Crypto exploit${c.technique && c.technique !== "Unknown" ? ": " + c.technique.toLowerCase() : ""}${c.chains.length ? " on " + c.chains.slice(0, 2).join(", ") : ""}.`, scale: fmtUSD(c.amount), patterns: pats(c.eid), eid: c.eid, n: c.amount || 0, t: c.listed_at || c.date + "T12:00:00Z" }));
    br.filter((b) => !seen.has(b.eid) && !covR(b.title)).forEach((b) =>
      rows.push({ org: b.title, what: `Breach added to Have I Been Pwned: ${(b.classes || []).slice(0, 3).join(", ").toLowerCase()}.`, scale: `${compact(b.count || 0)} accounts`, patterns: pats(b.eid), eid: b.eid, t: b.added }));
    kv.filter((v) => !seen.has(v.eid)).forEach((v) =>
      rows.push({ org: `${v.vendor} ${v.product}`, what: `${v.id} confirmed exploited in the wild; added to CISA KEV.`, scale: v.ransomware ? "Ransomware use" : "Exploited", patterns: pats(v.eid), eid: v.eid, t: v.date.length === 10 ? v.date + "T12:00:00Z" : v.date }));
    (D.notices || []).filter((o) => o.kind === "notice" && inDay(o.date.slice(0, 10)) && !covered({ org: o.org })).forEach((o) =>
      rows.push({ org: o.org, what: `${o.title}${o.breach_date ? `; breach began ${fmtDate(o.breach_date)} ${o.breach_date.slice(0, 4)}` : ""}.`, scale: o.count ? `${compact(o.count)} people` : "Notice", type: "Official notice", url: o.url, t: o.date }));
    (D.x || []).filter((x) => inDay(x.date) && !seen.has(x.eid) && !covR(x.project || x.subject) && !(x.matches || []).some((m) => seen.has(m.eid) || rows.some((r) => r.eid === m.eid)) && x.stage !== "Rumour").forEach((x) =>
      rows.push({ org: x.subject, what: `On X only so far: ${x.accounts} accounts, ${x.credible} credible. ${x.claim.split(". ")[0]}.`, scale: x.amount_usd_claimed ? `${fmtUSD(x.amount_usd_claimed)} claimed` : x.stage, patterns: pats(x.eid), eid: x.eid, t: x.date }));
    if (!brief) nw.slice(0, 6).forEach((n) => rows.push({ org: n.title, what: n.source, scale: "", patterns: pats(n.eid), eid: n.eid, t: n.date }));

    // one ordering for everything: registry coverage, crypto loss size; official notices last
    // newest first by when it was first reported; developments on older incidents by latest update
    const ts = (r) => new Date(r.t || 0).getTime() || 0;
    rows.sort((a, b) => ts(b) - ts(a));
    ups.sort((a, b) => ts(b) - ts(a));
    const named = rv.filter((v) => v.victim && !/\*/.test(v.victim));
    const usd = cr.reduce((a, c) => a + (c.amount || 0), 0);
    const acc = br.reduce((a, b) => a + (b.count || 0), 0);
    const ticks = [
      [rows.length + rv.length, "Organisations hit", `${rows.length} reported, ${rv.length} on leak sites`],
      [usd ? fmtUSD(usd) : "$0", "Stolen in crypto", `${cr.length} exploit${cr.length === 1 ? "" : "s"}`],
      [acc ? compact(acc) : "0", "Accounts exposed", `${br.length} breach${br.length === 1 ? "" : "es"} confirmed by HIBP`],
      [kv.length, "Exploited flaws", "newly confirmed by CISA"],
      [nw.length, "Incident reports", "security press"],
    ];
    kpis($("#g-ticks"), ticks);

    const tb = el("tbody");
    const LIM = 8;
    rows.forEach((r, ix) => {
      const name = r.eid ? el("a", { href: `#e-${r.eid}`, class: "jump" }, r.org) : el("span", {}, r.org);
      if (r.eid) name.addEventListener("click", (x) => { x.preventDefault(); jumpTo(r.eid); });
      const chips = (r.patterns || []).slice(0, 1).map((p) => { const b = el("button", { type: "button", class: "chip" }, LABEL[p] || p); b.addEventListener("click", () => setFilter({ pattern: p }, true)); return b; });
      tb.append(el("tr", { class: ix >= LIM && !LIVE.allHit ? "more-row" : null, hidden: ix >= LIM && !LIVE.allHit ? "" : null }, el("td", { class: "org" }, name, el("span", { class: "what" }, r.what)), el("td", { class: "num sc" }, r.scale || ""), el("td", { class: "pc" }, chips)));
    });
    const ub = el("tbody", { class: "upd" });
    if (ups.length) {
      ub.append(el("tr", {}, el("th", { colspan: "3" }, "Developments on older incidents")));
      ups.forEach((r) => {
        const name = r.eid ? el("a", { href: `#e-${r.eid}`, class: "jump" }, r.org) : el("span", {}, r.org);
        if (r.eid) name.addEventListener("click", (x) => { x.preventDefault(); jumpTo(r.eid); });
        ub.append(el("tr", {}, el("td", { class: "org" }, name, el("span", { class: "what" }, r.what)), el("td", { class: "num sc" }, r.since ? "since " + fmtDate(r.since) : ""), el("td", { class: "pc" })));
      });
    }
    $("#g-hit").replaceChildren(el("thead", {}, el("tr", {}, el("th", {}, "Organisation and what happened"), el("th", { class: "num" }, "Scale"), el("th", { class: "pc" }, "Pattern"))), tb, ub);
    const mb = $("#g-more");
    mb.hidden = rows.length <= LIM;
    mb.textContent = LIVE.allHit ? "Show fewer" : `Show all ${rows.length}`;
    mb.onclick = () => { LIVE.allHit = !LIVE.allHit; drawGlance(D0); };

    // Patterns today
    const cnt = {};
    rows.forEach((r) => (r.patterns || []).forEach((p) => { cnt[p] = (cnt[p] || 0) + 1; }));
    if (rv.length) cnt.ransomware = (cnt.ransomware || 0) + rv.length;
    const pr = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 8);
    LIVE.today = { rows, ups, rv, named, usd, acc, cr, br, kv, nw, pats: pr };
    const max = Math.max(1, ...pr.map((p) => p[1]));
    $("#g-pat").replaceChildren(...pr.map(([p, n]) => {
      const b = el("button", { type: "button", class: "gpr" }, el("span", { class: "gl" }, LABEL[p] || p), el("span", { class: "gb" }, el("i", { style: `--w:${Math.max(4, (n / max) * 100)}%` })), el("span", { class: "gn" }, String(n)));
      b.addEventListener("click", () => setFilter({ pattern: p }, true));
      return b;
    }));

    const groups = {};
    rv.forEach((v) => { groups[v.group] = (groups[v.group] || 0) + 1; });
    const topG = Object.entries(groups).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([g, n]) => `${g} (${n})`).join(", ");
    $("#g-ransom").replaceChildren(
      ...named.slice(0, 8).map((v) => el("li", {}, el("a", { href: v.url || "https://www.ransomware.live", target: "_blank", rel: "noopener" }, v.victim), el("span", { class: "fs" }, [v.group, v.sector && !/not found/i.test(v.sector) ? v.sector : null, v.country && v.country !== "??" ? v.country : null].filter(Boolean).join(" · ")))),
      el("li", { class: "more" }, `${rv.length} claims in 24 hours${named.length > 8 ? `, ${named.length - 8} more named` : ""}. Most active: ${topG || "none"}. `, el("a", { href: "#ransomware" }, "Groups and sectors")));
  }

  function tick() {
    window.BL && BL.onTick && BL.onTick();
    document.querySelectorAll("[data-ago]").forEach((n) => { n.textContent = ago(n.dataset.ago); });
    if (LIVE.checked) {
      const s = Math.round((Date.now() - LIVE.checked) / 1000);
      $("#live-status").textContent = `Checked ${s < 60 ? s + "s" : Math.round(s / 60) + "m"} ago · page data rebuilt ${ago(D0.generated)}`;
    }
  }

  // Poll DefiLlama directly (CORS-enabled) for exploits newer than the last build
  async function pollLlama() {
    try {
      const r = await fetch("https://api.llama.fi/hacks", { cache: "no-store" }); const all = await r.json();
      const known = new Set(D0.crypto.items.map((c) => norm(c.name)));
      const cut = Date.now() - 3 * 864e5;
      all.filter((h) => h.date * 1000 > cut && !known.has(norm(h.name))).forEach((h) => {
        const key = "live-" + norm(h.name);
        if (LIVE.extra.some((e) => e.key === key)) return;
        LIVE.extra.push({ key, live: true, kind: "crypto", t: new Date().toISOString(), amount: h.amount || 0, title: h.name, url: "https://defillama.com/hacks",
          sub: `${fmtUSD(h.amount)} · newly listed on DefiLlama, ${fmtDate(new Date(h.date * 1000).toISOString())}` });
      });
      LIVE.checked = Date.now(); drawLive(D0); tick();
    } catch (e) { /* keep last state */ }
  }
  async function pollHIBP() {
    try {
      const r = await fetch("https://haveibeenpwned.com/api/v3/breaches", { cache: "no-store" }); const all = await r.json();
      const known = new Set(((D0.breaches || {}).items || []).map((b) => b.name));
      all.filter((b) => ts(b.AddedDate) > ts(D0.generated) && !known.has(b.Name)).forEach((b) => {
        const key = "live-hibp-" + b.Name;
        if (LIVE.extra.some((e) => e.key === key)) return;
        LIVE.extra.push({ key, live: true, kind: "breach", t: b.AddedDate, count: b.PwnCount || 0, title: b.Title, url: `https://haveibeenpwned.com/Breach/${b.Name}`, sub: `${compact(b.PwnCount || 0)} accounts · just added to HIBP` });
      });
      LIVE.checked = Date.now(); drawLive(D0); tick();
    } catch (e) {}
  }
  async function pollData(first) {
    try {
      const D = await (await fetch("data.json", { cache: "no-store" })).json();
      if (!first && D.generated === D0.generated) { LIVE.checked = Date.now(); tick(); return; }
      const ids = new Set(events(D).map((e) => e.id));
      if (LIVE.prevIds) ids.forEach((id) => { if (!LIVE.prevIds.has(id)) LIVE.fresh.add(id); });
      LIVE.prevIds = ids;
      const open = [...document.querySelectorAll(".entry .more[aria-expanded='true']")].map((b) => b.closest(".entry").id.slice(2));
      const y = window.scrollY, my = $("#main").scrollTop;
      LIVE.extra = LIVE.extra.filter((e) => !events(D).some((x) => norm(x.title) === norm(e.title)));
      render(D);
      if (state.pattern || state.q) setFilter({});
      open.forEach((id) => { const n = document.getElementById("e-" + id); n && n._toggle(true); });
      LIVE.fresh.forEach((id) => { const n = document.getElementById("e-" + id); n && n.classList.add("is-new"); });
      if (!first) { window.scrollTo(0, y); $("#main").scrollTop = my; }
      LIVE.checked = Date.now(); tick();
      if (first) {
        spy();
        if (/^#e-/.test(location.hash)) setTimeout(() => jumpTo(location.hash.slice(3)), 50);
        else if (document.body.classList.contains("view-report") && location.hash.length > 1) {
          // the section moved down as the lists above it filled in
          const n = document.getElementById(location.hash.slice(1));
          if (n && $("#main").contains(n)) n.scrollIntoView({ behavior: "instant" });
        }
        pollLlama(); setTimeout(pollHIBP, 4000);
        setInterval(() => pollData(false), 5 * 60e3);
        setInterval(pollLlama, 2 * 60e3);
        setInterval(pollHIBP, 10 * 60e3);
        setInterval(tick, 1000);
      }
    } catch (e) {
      if (first) $("#abstract").textContent = "The record could not be loaded. Try again in a moment.";
    }
  }

    let qt; $("#q").addEventListener("input", (e) => { clearTimeout(qt); qt = setTimeout(() => setFilter({ q: e.target.value.trim() }), 150); });
    $("#clear-filter").addEventListener("click", () => setFilter({ pattern: null, q: "" }));
    $("#fbar-clear").addEventListener("click", () => setFilter({ pattern: null, q: "" }));

  window.BL = Object.assign(window.BL || {}, {
    // null until data.json has loaded: board.js renders straight away only when B.D is set
    get D() { return D0.generated ? D0 : null; }, get DET() { return DET; }, LABEL, KIND, LIVE, ROLE, STAGES,
    detailPanel, track, el, fmtUSD, fmtDate, fmtLong, ago, compact, askURL, breakdownURL, xSearch, escape, hoursAgo,
    setFilter, jumpTo: (id) => jumpTo(id), events: () => [...LIVE.extra, ...events(D0)],
    pollAll: () => { pollLlama(); pollHIBP(); pollData(false); },
  });
  pollData(true);
})();
