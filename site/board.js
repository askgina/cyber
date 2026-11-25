// Hacks leaderboard: CoinGecko-style ranked table over year-to-date crypto exploits.
(() => {
  "use strict";
  const B = window.BL;
  if (!B) return;
  const R = window.BLRoutes;
  const { el, fmtUSD, fmtDate } = B;
  const $ = (s, r = document) => r.querySelector(s);

  const S = { sort: "amount", dir: "desc", cat: null, q: "", rows: [], all: [], ready: false, err: null, generated: null, open: null };
  const FIRST_DIR = { amount: "desc", date: "desc", name: "asc", category: "asc" };
  let archiveP = null, archive = null, rowPick = 0;
  const active = () => document.body.classList.contains("view-board");

  function parseScale(s) {
    if (s == null || s === "") return null;
    const m = String(s).trim().replace(/,/g, "").match(/^\$([0-9]+(?:\.[0-9]+)?)\s*([KMB])?$/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    const mul = { K: 1e3, M: 1e6, B: 1e9 }[m[2] ? m[2].toUpperCase() : ""] || 1;
    return n * mul;
  }

  const TARGETS = /^(Wallet|CEX|DEX|DeFi Protocol|Chain|Bridge|Exchange|Protocol)$/i;
  function parseX(x) {
    const parts = String(x || "").split("·").map((p) => p.trim()).filter(Boolean);
    const out = { technique: null, classification: null, chains: [], target: null };
    if (!parts.length) return out;
    let i = 0;
    if (parts[0] === "SlowMist" && parts.length > 1) {
      out.classification = parts[1] || "Unclassified";
      return out;
    }
    out.technique = parts[i] || null;
    out.classification = parts[i + 1] || null;
    const rest = parts.slice(i + 2);
    if (!rest.length) return out;
    if (TARGETS.test(rest[rest.length - 1])) out.target = rest.pop();
    if (rest[0] && rest[0].length < 80 && !/^On [A-Z]/.test(rest[0])) {
      out.chains = rest[0].split(/,\s*/).filter(Boolean);
    }
    return out;
  }

  function norm(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function loadArchive() {
    if (!active() || archiveP) return archiveP;
    S.err = null;
    archiveP = fetch("/archive.json", { cache: "no-cache" }).then((r) => {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then((data) => {
      archive = data;
      if (active()) fill(B.D, archive);
    }).catch(() => {
      // Archive failed: still show the recent rows and retry on the next visit.
      S.err = true;
      if (active()) fill(B.D, null);
    }).finally(() => { archiveP = null; });
    return archiveP;
  }

  function bootBoard() {
    if (!active()) return;
    if (archive) fill(B.D, archive);
    else { loadArchive(); drawTable(); }
  }

  function buildRows(D, archive) {
    const live = ((D && D.crypto) || {}).items || [];
    const byKey = new Map();
    live.forEach((c) => byKey.set(norm(c.name) + "|" + c.date, c));

    const used = new Set();
    const rows = [];
    ((archive && archive.items) || []).forEach((a, i) => {
      if (a.k !== "crypto") return;
      const key = norm(a.o) + "|" + a.d;
      const hit = byKey.get(key);
      if (hit) used.add(key);
      const x = parseX(a.x);
      const amount = hit && hit.amount != null ? hit.amount : parseScale(a.s);
      const category = (hit && hit.classification) || x.classification || "Unclassified";
      const links = (hit && hit.links) || (a.u ? [{ label: "Source", url: a.u }] : []);
      rows.push({
        key: (hit && hit.eid) || ("arc-" + key),
        eid: hit && hit.eid,
        archiveId: "a-" + i, // same snapshot-local lookup as the terminal archive
        name: (hit && hit.name) || a.o,
        date: (hit && hit.date) || a.d,
        amount,
        returned: hit ? hit.returned : null,
        category,
        technique: (hit && hit.technique) || x.technique,
        target: (hit && hit.target) || x.target,
        chains: (hit && hit.chains && hit.chains.length) ? hit.chains : x.chains,
        url: (links[0] && links[0].url) || a.u || "https://defillama.com/hacks",
        links,
        desc: hit && hit.desc,
        offchain: !!(hit && hit.offchain),
        sources: (hit && hit.sources) || null,
        it: hit || null,
      });
    });

    live.forEach((c) => {
      const key = norm(c.name) + "|" + c.date;
      if (used.has(key)) return;
      rows.push({
        key: c.eid || ("live-" + key),
        eid: c.eid,
        name: c.name,
        date: c.date,
        amount: c.amount != null ? c.amount : null,
        returned: c.returned,
        category: c.classification || "Unclassified",
        technique: c.technique,
        target: c.target,
        chains: c.chains || [],
        url: (c.links && c.links[0] && c.links[0].url) || "https://defillama.com/hacks",
        links: c.links || [],
        desc: c.desc,
        offchain: !!c.offchain,
        sources: c.sources,
        it: c,
      });
    });
    return rows;
  }

  function cmp(a, b) {
    const { sort, dir } = S;
    if (sort === "amount") {
      const am = a.amount == null, bm = b.amount == null;
      if (am && bm) return a.name.localeCompare(b.name);
      if (am) return 1;
      if (bm) return -1;
      if (a.amount !== b.amount) return dir === "asc" ? a.amount - b.amount : b.amount - a.amount;
      return a.name.localeCompare(b.name);
    }
    let c;
    if (sort === "date") c = (a.date || "").localeCompare(b.date || "");
    else c = String(a[sort] || "").localeCompare(String(b[sort] || ""), undefined, { sensitivity: "base" });
    if (!c) c = a.name.localeCompare(b.name);
    return dir === "asc" ? c : -c;
  }

  function visible() {
    const q = S.q.toLowerCase();
    return S.all.filter((r) => {
      if (S.cat && r.category !== S.cat) return false;
      if (!q) return true;
      if (r.name.toLowerCase().includes(q)) return true;
      // Only look at other fields when the query matches no names, so
      // a search for "Binance" returns the exchange, not every hack on that chain.
      if (S.all.some((x) => x.name.toLowerCase().includes(q))) return false;
      const hay = [r.category, r.technique, r.target, (r.chains || []).join(" ")].join(" ").toLowerCase();
      return hay.includes(q);
    }).sort(cmp);
  }

  function setSort(key) {
    if (S.sort === key) S.dir = S.dir === "asc" ? "desc" : "asc";
    else { S.sort = key; S.dir = FIRST_DIR[key] || "asc"; }
    drawTable();
  }

  function kpi(rows) {
    const n = rows.length;
    const usd = rows.reduce((s, r) => s + (r.offchain ? 0 : (r.amount || 0)), 0);
    const asof = S.generated ? fmtDate(S.generated) + " " + S.generated.slice(0, 4) : "—";
    const box = $("#b-kpi");
    if (!box) return;
    box.replaceChildren(
      el("div", { class: "b-k" }, el("span", {}, S.cat || "Year to date"), el("b", {}, String(n)), el("i", {}, n === 1 ? "hack" : "hacks")),
      el("div", { class: "b-k" }, el("span", {}, "Lost"), el("b", {}, fmtUSD(usd)), el("i", {}, "gross, as reported")),
      el("div", { class: "b-k" }, el("span", {}, "As of"), el("b", {}, asof), el("i", {}, "rebuilt hourly")),
    );
  }

  function drawCats() {
    const box = $("#b-cats");
    if (!box) return;
    const counts = new Map();
    S.all.forEach((r) => counts.set(r.category, (counts.get(r.category) || 0) + 1));
    const cats = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const chip = (label, cat, n) => {
      const b = el("button", { type: "button", class: "chip" + (S.cat === cat ? " on" : ""), "aria-pressed": S.cat === cat ? "true" : "false" },
        label, n != null ? el("i", {}, " " + n) : null);
      b.addEventListener("click", () => { S.cat = cat; drawCats(); drawTable(); });
      return b;
    };
    box.replaceChildren(chip("All", null, S.all.length), ...cats.map(([c, n]) => chip(c, c, n)));
  }

  function th(label, key, cls) {
    const active = S.sort === key;
    const btn = el("button", { type: "button", class: "b-sort" }, label, el("i", { "aria-hidden": "true" }, active ? (S.dir === "asc" ? "▲" : "▼") : " "));
    btn.addEventListener("click", () => setSort(key));
    const attrs = { class: (cls || "") + (key ? " sortable" : ""), "aria-sort": active ? (S.dir === "asc" ? "ascending" : "descending") : "none" };
    return el("th", attrs, key ? btn : label);
  }

  function drawTable() {
    const tbl = $("#b-tbl");
    if (!tbl) return;
    const rows = visible();
    S.rows = rows;
    kpi(rows);
    const head = el("thead", {}, el("tr", {},
      th("#", null, "num"),
      th("Name", "name"),
      th("Date", "date"),
      th("Category", "category"),
      th("Amount lost", "amount", "num"),
      th("Returned", null, "num hide-sm"),
      th("Target", null, "hide-sm"),
      th("Chains", null, "hide-sm"),
    ));
    const body = el("tbody");
    if (!S.ready && !S.err) {
      body.append(el("tr", {}, el("td", { colspan: "8", class: "empty" }, "Loading the leaderboard…")));
    } else if (S.err && !rows.length) {
      body.append(el("tr", {}, el("td", { colspan: "8", class: "empty" }, "The leaderboard could not be loaded. Try again in a moment.")));
    } else if (!rows.length) {
      body.append(el("tr", {}, el("td", { colspan: "8", class: "empty" }, "No hacks match this filter.")));
    } else {
      rows.forEach((r, i) => {
        const tr = el("tr", { tabindex: "0", role: "button", "data-key": r.key, class: r.offchain ? "offchain" : (S.open === r.key ? "sel" : null) });
        tr.append(
          el("td", { class: "num" }, String(i + 1)),
          el("td", {}, el("span", { class: "t" }, r.name, r.offchain ? el("span", { class: "flag" }, "Off-chain") : null), r.technique ? el("span", { class: "sub" }, r.technique) : null),
          el("td", {}, fmtDate(r.date) + " " + r.date.slice(0, 4)),
          el("td", {}, r.category),
          el("td", { class: "num" }, r.amount != null ? fmtUSD(r.amount) : "—"),
          el("td", { class: "num hide-sm" }, r.returned ? fmtUSD(r.returned) : "—"),
          el("td", { class: "hide-sm" }, r.target || "—"),
          el("td", { class: "hide-sm chains" }, (r.chains && r.chains.length) ? r.chains.join(", ") : "—"),
        );
        tr.addEventListener("click", (e) => { if (!e.target.closest("a")) openRow(r, true); });
        tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openRow(r, true); } });
        body.append(tr);
      });
    }
    tbl.replaceChildren(head, body);
    const wrap = document.querySelector(".b-table-wrap");
    if (wrap) wrap.scrollTop = 0;
    const note = $("#b-note");
    if (note) note.textContent = rows.length
      ? `${rows.length} shown · loss figures as reported, often revised · off-chain fraud is listed but excluded from the total · DefiLlama, SlowMist and the year-to-date archive`
      : "";
  }

  function closeInsp(restoreRoute) {
    const box = $("#b-insp");
    const selected = document.querySelectorAll("#b-tbl tbody tr.sel");
    if (box) box.hidden = true;
    S.open = null;
    selected.forEach((n) => n.classList.remove("sel"));
    if (restoreRoute) {
      B.dismissIncident();
      (selected[0] || $("#board")).focus({ preventScroll: true });
    }
  }

  function openRow(r, navigate) {
    const id = r.eid || r.archiveId;
    if (navigate && id) {
      const pick = ++rowPick;
      if (!r.eid && r.archiveId && B.D && !B.historyLoaded) {
        const from = location.href;
        return B.ensureHistory().then(() => {
          if (!active() || location.href !== from || pick !== rowPick) return;
          const liveId = S.all.find((row) => row.archiveId === r.archiveId)?.eid;
          R.navigate(R.incidentPath(liveId || id));
        });
      }
      return R.navigate(R.incidentPath(id));
    }
    const box = $("#b-insp");
    const body = $("#b-ib");
    if (!box || !body) return;
    const opening = box.hidden;
    S.open = r.key;
    document.querySelectorAll("#b-tbl tbody tr").forEach((n) => n.classList.toggle("sel", n.getAttribute("data-key") === r.key));
    $("#b-ik").textContent = r.name;
    body.replaceChildren();
    if (r.it && B.detailPanel) {
      body.append(B.detailPanel(r.it, "crypto", r.eid || r.key, r.name, r.desc || ""));
    } else {
      const rows = [
        ["Loss", r.amount != null ? fmtUSD(r.amount) : "undisclosed"],
        ["Date", fmtDate(r.date) + " " + r.date.slice(0, 4)],
        ["Category", r.category],
        ["Technique", r.technique],
        ["Target", r.target],
        ["Chains", (r.chains && r.chains.length) ? r.chains.join(", ") : null],
        ["Source", r.url ? el("a", { href: r.url, target: "_blank", rel: "noopener" }, "Open source") : null],
      ].filter((x) => x[1] != null && x[1] !== "");
      const dl = el("dl", { class: "facts" }, rows.map(([k, v]) => el("div", {}, el("dt", {}, k), el("dd", {}, v))));
      body.append(dl);
      if (r.desc) body.append(el("p", { class: "d" }, r.desc));
      if (id) body.append(el("a", { href: R.incidentPath(id), class: "link" }, "Link to this entry"));
    }
    box.hidden = false;
    if (opening) $("#b-ix").focus({ preventScroll: true });
  }

  function inspectBoard(id) {
    if (!document.body.classList.contains("view-board")) return false;
    const r = S.all.find((x) => x.eid === id || x.archiveId === id);
    if (!r) return false;
    openRow(r, false);
    B.setIncidentTitle(id, r.name);
    if (r.it && !B.detailsLoaded) B.ensureDetails();
    return true;
  }

  function fill(D, archive) {
    S.generated = (D && D.generated) || (archive && archive.generated) || null;
    S.all = buildRows(D, archive);
    S.ready = true;
    drawCats();
    drawTable();
    B.showRoutedIncident();
  }

  function boot() {
    const q = $("#b-q");
    if (q) {
      let t;
      q.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { S.q = q.value.trim(); drawTable(); }, 120); });
    }
    const ix = $("#b-ix");
    if (ix) ix.addEventListener("click", () => closeInsp(true));
    document.addEventListener("keydown", (e) => {
      if (e.defaultPrevented || e.key !== "Escape" || $("#pal").open) return;
      if (!document.body.classList.contains("view-board")) return;
      if ($("#b-insp") && !$("#b-insp").hidden) { e.preventDefault(); closeInsp(true); }
    });

    const prev = B.onRender;
    B.onRender = (D) => {
      if (prev) prev(D);
      if (active()) fill(D, archive);
    };
    bootBoard();
  }

  B.bootBoard = bootBoard;
  B.inspectBoard = inspectBoard;
  B.closeBoard = () => closeInsp(false);
  B.boardRecordKind = (id) => R.isArchiveId(id) ? archive?.items?.[Number(id.slice(2))]?.k : null;
  B.parseScale = parseScale;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
