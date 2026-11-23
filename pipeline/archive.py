#!/usr/bin/env python3
"""Year-to-date archive: every incident since 2026-01-01 across all sources -> site/archive.json.

build(now, get, errors, ctx) is called once per hourly build from build_data.py. It is incremental:
raw pulls are cached under pipeline/archive_cache/ and each run only does a small amount of network work:
  - ransomware.live /v2/victims/{YYYY}/{MM}: one file per month (the endpoint groups by attack date).
    At most ONE call per run (rate limit: 1/min). Priority: missing month > current month (>3h old) >
    previous month (>12h old) > stalest older month (>7 days old). Recent victims from the hourly
    victims_cache.json are merged into ransom_recent.json every run, so new listings show up without calls.
  - DefiLlama, CISA KEV, HIBP: one call each per run (or reuse the raw data build_data already fetched via ctx),
    stored as one file per source per month.
  - SlowMist-only crypto items (ctx["crypto"]) accumulate in slowmist.json.
  - Official notices: the hourly 14-day pull (ctx["notices"]) is merged every run; one stale source (>24h) is
    re-pulled in full from 2026-01-01 per run.
  - Curated registry: registry.load() (incidents.json + incidents_archive.json).

Run directly for the initial backfill:  python3 pipeline/archive.py --backfill
"""
import json, os, re, sys, time, glob, urllib.request, datetime as dt

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CDIR = os.path.join(HERE, "archive_cache")
OUT = os.path.join(ROOT, "site", "archive.json")
FROM = "2026-01-01"
FROM_DT = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
RANSOM_GAP = 61
KINDS = ["inc", "crypto", "ransom", "kev", "breach", "notice", "sec"]
NOTICE_SOURCES = ["california", "washington", "oregon", "hhs", "sec"]

if HERE not in sys.path: sys.path.insert(0, HERE)


# ---------------------------------------------------------------- helpers
def _iso(d): return d.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
def _p(s):
    s = str(s).replace("Z", "+00:00").replace(" ", "T")
    if len(s) == 10: s += "T00:00:00+00:00"
    s = re.sub(r"\.\d+", "", s)
    d = dt.datetime.fromisoformat(s)
    return d if d.tzinfo else d.replace(tzinfo=dt.timezone.utc)
def _age_h(now, s):
    try: return (now - _p(s)).total_seconds() / 3600
    except Exception: return 1e9
def _norm(n): return re.sub(r"[^a-z0-9]", "", re.sub(r"\(.*?\)", "", (n or "").lower()))
def _trim(s, n): s = re.sub(r"\s+", " ", str(s or "")).strip(); return s if len(s) <= n else s[: n - 1].rstrip() + "…"
def _money(a):
    if not a: return ""
    a = float(a)
    if a >= 1e9: return f"${a / 1e9:.2f}B"
    if a >= 1e6: return f"${a / 1e6:.1f}M"
    if a >= 1e3: return f"${a / 1e3:.0f}K"
    return f"${a:,.0f}"
def _path(name): return os.path.join(CDIR, name)
def _load(name, default=None):
    try: return json.load(open(_path(name)))
    except Exception: return default
def _save(name, obj):
    os.makedirs(CDIR, exist_ok=True)
    tmp = _path(name) + ".tmp"
    json.dump(obj, open(tmp, "w"), ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, _path(name))
def _months(now):
    out, y, m = [], 2026, 1
    while (y, m) <= (now.year, now.month):
        out.append((y, m)); m += 1
        if m == 13: y, m = y + 1, 1
    return out
def _month_split(rows, key, prefix):
    """Write rows into one file per month: {prefix}_{YYYY-MM}.json."""
    by = {}
    for r in rows: by.setdefault(r[key][:7], []).append(r)
    for mo, rs in by.items():
        if mo >= FROM[:7]: _save(f"{prefix}_{mo}.json", rs)
def _month_join(prefix):
    out = []
    for f in sorted(glob.glob(_path(f"{prefix}_2*.json"))):
        try: out += json.load(open(f))
        except Exception: pass
    return out


# ---------------------------------------------------------------- ransomware.live
def _victim(v):
    ds = v.get("discovered") or v.get("attackdate") or v.get("date")
    if not ds: return None
    press = v.get("press") if isinstance(v.get("press"), dict) else {}
    return {"d": _iso(_p(ds)), "a": (v.get("attackdate") or "")[:10], "victim": _trim(v.get("victim"), 120),
            "group": v.get("group") or "unknown", "country": v.get("country") or "",
            "sector": v.get("activity") or v.get("sector") or "", "domain": v.get("domain") or "",
            "url": v.get("url") or "", "press": press.get("source") or ""}


def ransom_fetch(get, y, m, now):
    raw = json.loads(get(f"https://api.ransomware.live/v2/victims/{y}/{m:02d}", 90))
    rows = [r for r in (_victim(v) for v in raw) if r]
    _save(f"ransom_{y}-{m:02d}.json", {"fetched": _iso(now), "rows": rows})
    st = _load("state.json", {}); st["ransom_last_call"] = _iso(now); _save("state.json", st)
    return len(rows)


def ransom_pick(now):
    """Which month (if any) to pull this run."""
    cur = (now.year, now.month)
    prev = (now.year - (now.month == 1), 12 if now.month == 1 else now.month - 1)
    stale = []
    for y, m in _months(now):
        c = _load(f"ransom_{y}-{m:02d}.json")
        if c is None: return (y, m)
        stale.append((c.get("fetched", ""), (y, m)))
    age = {ym: _age_h(now, f) for f, ym in stale}
    if age.get(cur, 1e9) > 3: return cur
    if age.get(prev, 1e9) > 12: return prev
    f, ym = min(stale)
    return ym if _age_h(now, f) > 24 * 7 else None


def ransom_step(now, get, errors, ctx):
    # hourly recent victims (victims_cache.json, ~35 days) accumulate here forever
    rec = _load("ransom_recent.json", {})
    for k, v in (ctx.get("victims") or {}).items():
        if k in rec or (v.get("date") or "") < FROM: continue
        rec[k] = {"d": v["date"], "a": "", "victim": _trim(v.get("victim") or k.rsplit("|", 1)[0], 120),
                  "group": v.get("group") or "unknown", "country": "" if v.get("country") == "??" else v.get("country") or "",
                  "sector": "" if (v.get("sector") or "").lower() == "not found" else v.get("sector") or "",
                  "domain": "", "url": v.get("url") or "", "press": ""}
    _save("ransom_recent.json", rec)
    if ctx.get("ransom_called"): return  # build_data already hit the endpoint this run
    st = _load("state.json", {})
    if _age_h(now, st.get("ransom_last_call", "2000-01-01")) * 3600 < RANSOM_GAP: return
    ym = ransom_pick(now)
    if not ym: return
    try: ransom_fetch(get, ym[0], ym[1], now)
    except Exception as e: errors.append(f"archive ransomware {ym[0]}-{ym[1]:02d}: {e}")


def ransom_rows():
    rows, seen = [], {}
    for f in sorted(glob.glob(_path("ransom_2*.json"))):
        for r in (json.load(open(f)).get("rows") or []):
            k = f"{r['victim']}|{r['group']}".lower()
            if k not in seen: seen[k] = r; rows.append(r)
    for k, r in (_load("ransom_recent.json", {}) or {}).items():
        k2 = f"{r['victim']}|{r['group']}".lower()
        if k2 in seen:
            for f in ("url", "country", "sector"):
                if not seen[k2].get(f) and r.get(f): seen[k2][f] = r[f]
        else:
            seen[k2] = r; rows.append(r)
    return [r for r in rows if r["d"] >= FROM]


# ---------------------------------------------------------------- single-file feeds (KEV, HIBP, DefiLlama)
def kev_step(now, get, errors, ctx):
    try:
        raw = ctx.get("kev_raw") or json.loads(get("https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json"))["vulnerabilities"]
        rows = [{"id": v["cveID"], "date": v["dateAdded"], "vendor": v.get("vendorProject"), "product": v.get("product"),
                 "name": v.get("vulnerabilityName"), "ransomware": v.get("knownRansomwareCampaignUse") == "Known",
                 "cwes": v.get("cwes") or []} for v in raw if v.get("dateAdded", "") >= FROM]
        _month_split(rows, "date", "kev")
    except Exception as e: errors.append(f"archive kev: {e}")


def hibp_step(now, get, errors, ctx):
    try:
        raw = ctx.get("hibp_raw") or json.loads(get("https://haveibeenpwned.com/api/v3/breaches", 60))
        rows = [{"name": b["Name"], "title": b.get("Title"), "domain": b.get("Domain"), "added": b["AddedDate"],
                 "breach_date": b.get("BreachDate"), "count": b.get("PwnCount"), "classes": (b.get("DataClasses") or [])[:6]}
                for b in raw if b.get("AddedDate", "") >= FROM and not (b.get("IsSpamList") or b.get("IsFabricated"))]
        _month_split(rows, "added", "hibp")
    except Exception as e: errors.append(f"archive hibp: {e}")


def llama_step(now, get, errors, ctx):
    try:
        raw = ctx.get("llama_raw") or json.loads(get("https://api.llama.fi/hacks"))
        rows = []
        for h in raw:
            d0 = dt.datetime.fromtimestamp(h["date"], dt.timezone.utc)
            if d0 < FROM_DT: continue
            rows.append({"date": d0.strftime("%Y-%m-%d"), "name": h.get("name"), "amount": h.get("amount"),
                         "technique": h.get("technique"), "classification": h.get("classification"),
                         "chains": h.get("chain") or [], "target": h.get("targetType"), "source": h.get("source"),
                         "returned": h.get("returnedFunds")})
        _month_split(rows, "date", "defillama")
    except Exception as e: errors.append(f"archive defillama: {e}")
    # SlowMist-only items (not on DefiLlama) from the hourly merge; off-chain fraud excluded
    sm = _load("slowmist.json", {})
    for c in ctx.get("crypto") or []:
        if c.get("sources") != ["SlowMist"] or c.get("offchain") or c["date"] < FROM: continue
        k = _norm(c["name"]) + ":" + c["date"]
        ref = next((l["url"] for l in c.get("links", []) if l.get("label") == "SlowMist reference"), None)
        sm[k] = {"date": c["date"], "name": c["name"], "amount": c.get("amount"), "technique": c.get("technique"),
                 "desc": _trim(c.get("desc"), 200), "ref": ref}
    _save("slowmist.json", sm)


# ---------------------------------------------------------------- official notices
SRC_LABEL = {"California AG": "california", "Washington AG": "washington", "Oregon DOJ": "oregon",
             "HHS OCR": "hhs", "SEC EDGAR": "sec"}


def _notice_merge(src, rows, fetched=None):
    c = _load(f"notice_{src}.json", {"fetched": None, "rows": []})
    have = {(_norm(r["org"]), r["date"][:10]): r for r in c["rows"]}
    for r in rows:
        if r["date"] < FROM: continue
        k = (_norm(r["org"]), r["date"][:10])
        if k not in have or (r.get("count") and not have[k].get("count")):
            have[k] = {x: r.get(x) for x in ("date", "org", "url", "title", "summary", "count", "breach_date")}
    c["rows"] = sorted(have.values(), key=lambda r: r["date"], reverse=True)
    if fetched: c["fetched"] = fetched
    _save(f"notice_{src}.json", c)
    return len(c["rows"])


def notice_fetch(src, now, get):
    import official
    fn = getattr(official, src)
    rows = fn(now, get, FROM_DT, max_pages=200) if src in ("california", "washington") else fn(now, get, FROM_DT)
    for r in rows:
        r.pop("also", None)
    return _notice_merge(src, rows, _iso(now)), len(rows)


def notice_step(now, get, errors, ctx, full=False):
    by = {}
    for n in ctx.get("notices") or []:
        src = SRC_LABEL.get(n.get("source"))
        if src: by.setdefault(src, []).append(n)
        for a in n.get("also") or []:  # official.collect merged same-day duplicates; keep each source's row
            s2 = SRC_LABEL.get(a.get("source"))
            if s2: by.setdefault(s2, []).append(dict(n, url=a.get("url"), source=a.get("source")))
    for src, rows in by.items(): _notice_merge(src, rows)
    stale = sorted((_load(f"notice_{s}.json", {}).get("fetched") or "", s) for s in NOTICE_SOURCES)
    todo = [s for f, s in stale if full or _age_h(now, f or "2000-01-01") > 24]
    for s in (todo if full else todo[:1]):
        try: notice_fetch(s, now, get)
        except Exception as e: errors.append(f"archive notices {s}: {e}")


# ---------------------------------------------------------------- items
REC_KEYS = ("org", "title", "summary", "type", "status", "sector", "country", "records", "usd", "actor", "vector",
            "event_date", "first_reported", "sources", "updates", "affected", "payloads", "guidance")


def _rec(r):
    out = {}
    for k in REC_KEYS:
        v = r.get(k)
        if v in (None, "", [], {}): continue
        if k == "summary": v = _trim(v, 500)
        if k == "updates": v = [{kk: (_trim(vv, 300) if isinstance(vv, str) and kk != "url" else vv) for kk, vv in u.items()} for u in v[-5:]]
        if k == "sources": v = v[:5]
        if k == "guidance": v = [_trim(g, 200) for g in v[:3]]
        out[k] = v
    return out


def _it(d, k, o, t, s, u, x, **kw):
    it = {"d": d, "k": k, "o": _trim(o, 90), "t": _trim(t, 160), "s": s or "", "u": u or "", "x": _trim(x, 160)}
    it.update(kw)
    return it


def items(now, errors):
    out = []
    # curated registry
    try:
        import registry
        reg = registry.load(os.path.join(HERE, "incidents.json"))
        for r in reg.get("incidents", []):
            d = (r.get("first_reported") or "")[:10]
            if d < FROM: continue
            sc = []
            if r.get("usd"): sc.append(_money(r["usd"]))
            if r.get("records"): sc.append(f"{int(r['records']):,} records" if str(r["records"]).isdigit() else str(r["records"]))
            if r.get("actor"): sc.append(str(r["actor"]))
            x = " · ".join(str(v) for v in (r.get("type"), r.get("sector"), r.get("country"), r.get("actor"), r.get("vector")) if v)
            src = (r.get("sources") or [{}])[0].get("url", "")
            out.append(_it(d, "inc", r.get("org"), r.get("title"), " · ".join(sc[:2]), src, x, r=r.get("id"), rec=_rec(r)))
    except Exception as e: errors.append(f"archive registry: {e}")
    # crypto: DefiLlama + SlowMist-only
    seen = set()
    for c in _month_join("defillama"):
        seen.add(_norm(c["name"]))
        x = " · ".join(v for v in (c.get("technique"), c.get("classification"), ", ".join(c.get("chains") or []), c.get("target")) if v)
        out.append(_it(c["date"], "crypto", c["name"], f"{c['name']} lost {_money(c['amount'])}" + (f" ({c['technique']})" if c.get("technique") else "") if c.get("amount") else f"{c['name']} exploit" + (f" ({c['technique']})" if c.get("technique") else ""),
                       _money(c.get("amount")), c.get("source") or "https://defillama.com/hacks", x))
    for c in (_load("slowmist.json", {}) or {}).values():
        if _norm(c["name"]) in seen: continue
        out.append(_it(c["date"], "crypto", c["name"], f"{c['name']} hacked" + (f" ({c['technique']})" if c.get("technique") else ""),
                       _money(c.get("amount")), c.get("ref") or "https://hacked.slowmist.io/", " · ".join(v for v in ("SlowMist", c.get("technique"), c.get("desc")) if v)))
    # ransomware leak sites
    for v in ransom_rows():
        x = " · ".join(v_ for v_ in (v.get("sector"), v.get("country"), v.get("domain") if _norm(v.get("domain")) not in _norm(v["victim"]) + "com" else "") if v_)
        out.append(_it(v["d"][:10], "ransom", v["victim"], f"Listed on the {v['group']} leak site",
                       v["group"], v.get("press") or v.get("url"), x))
    # KEV
    for v in _month_join("kev"):
        x = " · ".join(s for s in (v["id"], v.get("vendor"), "ransomware use" if v.get("ransomware") else "", " ".join(v.get("cwes") or [])) if s)
        out.append(_it(v["date"], "kev", f"{v.get('vendor')} {v.get('product')}", f"CISA KEV: {v.get('name') or v['id']}", v["id"],
                       f"https://nvd.nist.gov/vuln/detail/{v['id']}", x))
    # HIBP
    for b in _month_join("hibp"):
        out.append(_it(b["added"][:10], "breach", b.get("title") or b["name"], f"{b.get('title') or b['name']} breach added to Have I Been Pwned",
                       f"{b['count']:,} accounts" if b.get("count") else "", f"https://haveibeenpwned.com/Breach/{b['name']}",
                       " · ".join(s for s in (b.get("domain"), ("breached " + b["breach_date"]) if b.get("breach_date") else "", ", ".join(b.get("classes") or [])) if s)))
    # official notices
    for src in NOTICE_SOURCES:
        label = {v: k for k, v in SRC_LABEL.items()}[src]
        for n in (_load(f"notice_{src}.json", {}) or {}).get("rows", []):
            k = "sec" if src == "sec" else "notice"
            sc = f"{n['count']:,} people" if n.get("count") else ""
            if not sc and src == "washington":
                m = re.match(r"([\d,]+) Washington residents", n.get("summary") or "")
                if m: sc = f"{m.group(1)} WA residents"
            out.append(_it(n["date"][:10], k, n["org"], n.get("title"), sc, n.get("url"),
                           label + " · " + _trim(n.get("summary"), 130)))
    return out


def _xref(out):
    """Registry incident vs notice / HIBP breach of the same org within ±30 days: keep both, cross-reference in x."""
    others = {}
    for it in out:
        if it["k"] in ("notice", "breach", "sec"):
            n = _norm(it["o"])
            if len(n) >= 4: others.setdefault(n[:6], []).append((n, it))
    for it in out:
        if it["k"] != "inc": continue
        n = _norm(it["o"])
        if len(n) < 4: continue
        d0 = _p(it["d"])
        for n2, o in others.get(n[:6], []):
            if not (n2 == n or (len(n) >= 6 and (n2.startswith(n) or n.startswith(n2)))): continue
            if abs((_p(o["d"]) - d0).days) > 30: continue
            lab = {"breach": "HIBP", "sec": "SEC 8-K"}.get(o["k"], o["x"].split(" · ")[0])
            if lab not in it["x"]: it["x"] = _trim(it["x"] + f" · also {lab} {o['d']}", 220)
            tag = f"registry {it['r']}"
            if tag not in o["x"]: o["x"] = _trim(o["x"], 120) + " · " + tag


def _english(out):
    try:
        import translate
    except Exception:
        return
    def nonlatin(s):
        letters = [ch for ch in s if ch.isalpha()]
        return bool(letters) and sum(ord(ch) > 0x24f for ch in letters) / len(letters) > 0.3
    texts = [it[f] for it in out for f in ("o", "t") if it.get(f) and (nonlatin(it[f]) or (f == "t" and it["k"] == "inc"))]
    translate.prefetch(texts)
    for it in out:
        if it.get("o") and nonlatin(it["o"]): it["o"] = _trim(translate.en(it["o"]), 90)
        if it.get("t") and (nonlatin(it["t"]) or it["k"] == "inc"): it["t"] = _trim(translate.en(it["t"]), 160)
    translate.save()


def write(now, errors):
    out = items(now, errors)
    out = [it for it in out if FROM <= it["d"][:10] <= now.strftime("%Y-%m-%d")]
    _xref(out)
    _english(out)
    out.sort(key=lambda it: (it["d"], it["k"] == "inc"), reverse=True)
    counts = {k: 0 for k in KINDS}
    monthly = {k: [0] * 12 for k in KINDS}
    for it in out:
        counts[it["k"]] += 1
        if it["d"][:4] == "2026": monthly[it["k"]][int(it["d"][5:7]) - 1] += 1
    for it in out:  # drop empty fields to save bytes
        for f in ("s", "u", "x"):
            if not it.get(f): it.pop(f, None)
    doc = {"generated": _iso(now), "from": FROM, "counts": counts, "monthly": monthly, "items": out}
    tmp = OUT + ".tmp"
    json.dump(doc, open(tmp, "w"), ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, OUT)
    return doc


def build(now, get, errors, ctx=None):
    """Hourly incremental step + rewrite site/archive.json. ctx keys (all optional): victims, ransom_called,
    kev_raw, hibp_raw, llama_raw, crypto, notices."""
    ctx = ctx or {}
    t0 = time.time()
    for step in (kev_step, hibp_step, llama_step, notice_step, ransom_step):
        try: step(now, get, errors, ctx)
        except Exception as e: errors.append(f"archive {step.__name__}: {e}")
    doc = write(now, errors)
    build.stats = {"secs": round(time.time() - t0, 1), "counts": doc["counts"]}
    return doc


if __name__ == "__main__":
    UA = {"User-Agent": "Mozilla/5.0 (BreachLedger; +research)"}
    def get(url, timeout=60):
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
            return r.read()
    errs = []
    now = dt.datetime.now(dt.timezone.utc)
    if "--backfill" in sys.argv:
        vc = os.path.join(HERE, "victims_cache.json")
        ctx = {"victims": json.load(open(vc)) if os.path.exists(vc) else {}}
        for step in (kev_step, hibp_step, llama_step): step(now, get, errs, ctx)
        if "--no-notices" not in sys.argv:
            for s in NOTICE_SOURCES:
                t0 = time.time()
                try: print("notices", s, notice_fetch(s, now, get), f"{time.time() - t0:.0f}s", flush=True)
                except Exception as e: print("notices", s, "FAILED", e, flush=True); errs.append(f"{s}: {e}")
        ransom_step(now, get, errs, dict(ctx, ransom_called=True))
        if "--no-ransom" not in sys.argv:
            for y, m in _months(now):
                if _load(f"ransom_{y}-{m:02d}.json") is not None and "--refresh" not in sys.argv: continue
                st = _load("state.json", {})
                wait = RANSOM_GAP - _age_h(dt.datetime.now(dt.timezone.utc), st.get("ransom_last_call", "2000-01-01")) * 3600
                if wait > 0: time.sleep(wait)
                for attempt in range(3):
                    try:
                        print("ransom", y, m, ransom_fetch(get, y, m, dt.datetime.now(dt.timezone.utc)), flush=True); break
                    except Exception as e:
                        print("ransom", y, m, "error", e, flush=True); time.sleep(RANSOM_GAP + 5)
    doc = write(dt.datetime.now(dt.timezone.utc), errs)
    print("counts", doc["counts"]); print("monthly", json.dumps(doc["monthly"])); print("errors", errs)
    print("size", os.path.getsize(OUT))
