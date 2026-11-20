#!/usr/bin/env python3
"""Hourly data build for The Breach Ledger. Writes site/data.json."""
import json, re, time, html, urllib.request, urllib.parse, datetime as dt, os, sys
from xml.etree import ElementTree as ET
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "site", "data.json")
XFILE = os.path.join(ROOT, "pipeline", "x_signals.json")
UA = {"User-Agent": "Mozilla/5.0 (BreachLedger; +research)"}
NOW = dt.datetime.now(dt.timezone.utc)

def get(url, timeout=60):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

def iso(d): return d.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
def days_ago(d): return (NOW - d).total_seconds() / 86400
def parse_iso(s):
    s = s.replace("Z", "+00:00")
    if len(s) == 10: s += "T00:00:00+00:00"
    d = dt.datetime.fromisoformat(s)
    return d if d.tzinfo else d.replace(tzinfo=dt.timezone.utc)
def xsearch(q): return "https://x.com/search?f=live&q=" + urllib.parse.quote(q)

errors = []

# ---- CISA KEV
kev = []
try:
    d = json.loads(get("https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json"))
    for v in d["vulnerabilities"]:
        a = parse_iso(v["dateAdded"])
        if days_ago(a) <= 30:
            kev.append({
                "id": v["cveID"], "date": v["dateAdded"], "vendor": v["vendorProject"],
                "product": v["product"], "name": v["vulnerabilityName"],
                "desc": v["shortDescription"], "ransomware": v.get("knownRansomwareCampaignUse") == "Known",
                "due": v.get("dueDate"), "cwes": v.get("cwes") or [], "action": v.get("requiredAction"),
                "links": [
                    {"label": "NVD", "url": f"https://nvd.nist.gov/vuln/detail/{v['cveID']}"},
                    {"label": "CISA KEV", "url": "https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search_api_fulltext=" + v["cveID"]},
                    {"label": "X", "url": xsearch(v["cveID"])},
                ]})
    kev.sort(key=lambda x: x["date"], reverse=True)
    kev_total = len(d["vulnerabilities"])
except Exception as e:
    errors.append(f"kev: {e}"); kev_total = None

# ---- ransomware.live: hourly recentvictims merged into a local 35-day cache;
# monthly bulk endpoints are only tried when the cache is thin (they rate-limit hard).
CACHE = os.path.join(ROOT, "pipeline", "victims_cache.json")
cache = json.load(open(CACHE)) if os.path.exists(CACHE) else {}
def add_victim(v):
    ds = v.get("discovered") or v.get("attackdate")
    if not ds: return
    k = f"{v.get('victim')}|{v.get('group')}"
    if k in cache:
        cache[k].setdefault("url", v.get("url"))
        return
    cache[k] = {"date": iso(parse_iso(ds)), "group": v.get("group") or "unknown",
                "sector": v.get("activity") or "Not found", "country": v.get("country") or "??",
                "victim": v.get("victim") or "", "url": v.get("url"), "desc": (v.get("description") or "")[:200]}
try:
    for v in json.loads(get("https://api.ransomware.live/v2/recentvictims")): add_victim(v)
except Exception as e:
    errors.append(f"ransomware recent: {e}")
oldest = min((parse_iso(c["date"]) for c in cache.values()), default=NOW)
if days_ago(oldest) < 29:
    months = []
    for back in (0, 31):
        p_ = NOW - dt.timedelta(days=back)
        if (p_.year, p_.month) not in months: months.append((p_.year, p_.month))
    for y, m in months:
        try:
            for v in json.loads(get(f"https://api.ransomware.live/v2/victims/{y}/{m:02d}", 90)): add_victim(v)
        except Exception as e:
            errors.append(f"ransomware {y}-{m:02d}: {e}")
        time.sleep(3)
cache = {k: v for k, v in cache.items() if days_ago(parse_iso(v["date"])) <= 35}
for k, v in cache.items(): v.setdefault("victim", k.rsplit("|", 1)[0])
json.dump(cache, open(CACHE, "w"))
victims = [v for v in cache.values() if days_ago(parse_iso(v["date"])) <= 30]
ransom_coverage_days = round(min(30, days_ago(min((parse_iso(v["date"]) for v in victims), default=NOW))), 1)

def window(rows, days, key="date"):
    return [r for r in rows if days_ago(parse_iso(r[key])) <= days]

ransom = {}
if victims:
    v7 = window(victims, 7)
    ransom = {
        "count_24h": len(window(victims, 1)), "count_7d": len(v7), "count_30d": len(victims),
        "groups_7d": Counter(v["group"] for v in v7).most_common(8),
        "sectors_7d": Counter(v["sector"] for v in v7 if v["sector"].lower() not in ("not found", "")).most_common(8),
        "countries_7d": Counter(v["country"] for v in v7 if v["country"] not in ("??", "")).most_common(8),
        "items_24h": sorted(({kk: v.get(kk) for kk in ("date", "victim", "group", "sector", "country", "url", "desc")}
                             for v in window(victims, 1)), key=lambda v: v["date"], reverse=True)[:200],
    }

# ---- DefiLlama hacks
crypto = []
crypto_hist = []
try:
    for h in json.loads(get("https://api.llama.fi/hacks")):
        d0 = dt.datetime.fromtimestamp(h["date"], dt.timezone.utc)
        if days_ago(d0) > 30:
            if h.get("description"):
                h["_date"] = d0.strftime("%Y-%m-%d"); crypto_hist.append(h)
            continue
        if True:
            links = [{"label": "DefiLlama", "url": "https://defillama.com/hacks"},
                     {"label": "Search X", "url": xsearch(f"{h['name']} (exploit OR hack OR drained)")}]
            if h.get("source"): links.insert(0, {"label": "Source", "url": h["source"]})
            crypto.append({"date": d0.strftime("%Y-%m-%d"), "name": h["name"], "amount": h.get("amount"),
                           "returned": h.get("returnedFunds"), "chains": h.get("chain") or [],
                           "classification": h.get("classification"), "technique": h.get("technique"),
                           "target": h.get("targetType"), "desc": h.get("description") or "", "links": links})
    crypto.sort(key=lambda x: (x["date"], x["amount"] or 0), reverse=True)
except Exception as e:
    errors.append(f"defillama: {e}")

# ---- News RSS
FEEDS = [("The Record", "https://therecord.media/feed"),
         ("The Hacker News", "https://feeds.feedburner.com/TheHackersNews"),
         ("DataBreaches.net", "https://databreaches.net/feed/"),
         ("rekt", "https://rekt.news/rss/feed.xml"),
         ("BleepingComputer", "https://www.bleepingcomputer.com/feed/"),
         ("Krebs on Security", "https://krebsonsecurity.com/feed/")]
KW = re.compile(r"\b(hack|hacked|hackers?|breach|breached|ransomware|exploit|exploited|stolen|leak|leaked|attack|compromise[sd]?|drain(ed)?|zero-day|0-day|extortion|intrusion|stole|outage|incident)\b", re.I)
news = []
SKIP = re.compile(r"(webinar|sponsored|\bhow to\b|you.re flying blind|\bguide\b|\bpodcast\b|week in review|\bweekly recap\b)", re.I)
from email.utils import parsedate_to_datetime
def clean(s): return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()
for name, url in FEEDS:
    try:
        root = ET.fromstring(get(url, 30))
        for it in root.iter("item"):
            t = clean(it.findtext("title")); l = (it.findtext("link") or "").strip()
            pd = it.findtext("pubDate")
            if not (t and l and pd): continue
            d0 = parsedate_to_datetime(pd)
            if days_ago(d0) > 7: continue
            desc = clean(it.findtext("description"))[:280]
            if not KW.search(t) or SKIP.search(t + " " + desc): continue
            news.append({"date": iso(d0), "source": name, "title": t, "url": l, "summary": desc})
    except Exception as e:
        errors.append(f"news {name}: {e}")
news.sort(key=lambda x: x["date"], reverse=True)


# ---- SlowMist Hacked (second crypto source; merged with DefiLlama)
def norm(n): return re.sub(r"[^a-z0-9]", "", re.sub(r"\(.*?\)", "", n.lower()))
slow = []
try:
    for pg in (1, 2):
        page = get(f"https://hacked.slowmist.io/?page={pg}", 30).decode("utf-8", "replace")
        for li in re.findall(r"<li>(.*?)</li>", page, re.S):
            m_t = re.search(r'class="time">([0-9-]{10})', li); m_n = re.search(r"Hacked target: </em>(.*?)</h3>", li, re.S)
            if not (m_t and m_n): continue
            d_ = re.search(r"Description of the event: </em>(.*?)</p>", li, re.S)
            a_ = re.search(r"Amount of loss: </em>(.*?)</span>", li, re.S)
            meth = re.search(r"Attack method: </em>(.*?)</span>", li, re.S)
            ref = re.search(r'link-reference"><a href="([^"]+)"', li)
            amt = re.sub(r"[^0-9.]", "", clean(a_.group(1))) if a_ else ""
            slow.append({"date": m_t.group(1), "name": clean(m_n.group(1)), "desc": clean(d_.group(1)) if d_ else "",
                         "amount": float(amt) if amt else None, "method": clean(meth.group(1)) if meth else None,
                         "ref": html.unescape(ref.group(1)) if ref else None})
        time.sleep(1)
except Exception as e:
    errors.append(f"slowmist: {e}")
def near(a, b, days=5): return abs((parse_iso(a) - parse_iso(b)).days) <= days
for s_ in slow:
    if days_ago(parse_iso(s_["date"])) > 30: continue
    hit = next((c for c in crypto if near(c["date"], s_["date"]) and (norm(c["name"]) == norm(s_["name"]) or norm(s_["name"]) in norm(c["name"]) or norm(c["name"]) in norm(s_["name"])) and len(norm(s_["name"])) >= 3), None)
    sm_links = [{"label": "SlowMist", "url": "https://hacked.slowmist.io/?search=" + urllib.parse.quote(s_["name"])}]
    if s_["ref"]: sm_links.append({"label": "SlowMist reference", "url": s_["ref"]})
    if hit:
        hit.setdefault("sources", ["DefiLlama"]); hit["sources"].append("SlowMist")
        hit["slowmist_method"] = s_["method"]
        hit["links"] = hit["links"][:-1] + [l for l in sm_links if l["url"] not in [x["url"] for x in hit["links"]]] + hit["links"][-1:]
    else:
        crypto.append({"date": s_["date"], "name": s_["name"], "amount": s_["amount"], "returned": None, "chains": [],
                       "classification": None, "technique": s_["method"], "target": None, "desc": s_["desc"],
                       "sources": ["SlowMist"], "links": sm_links + [{"label": "Search X", "url": xsearch(f"{s_['name']} (exploit OR hack OR drained)")}]})
for c in crypto: c.setdefault("sources", ["DefiLlama"])
crypto.sort(key=lambda x: (x["date"], x["amount"] or 0), reverse=True)

# ---- link rekt.news post-mortems to matching crypto entries
for n in [n for n in news if n["source"] == "rekt"]:
    for c in crypto:
        if len(norm(c["name"])) >= 4 and norm(c["name"]) in norm(n["title"]):
            if n["url"] not in [l["url"] for l in c["links"]]:
                c["links"].insert(0, {"label": "rekt post-mortem", "url": n["url"]})
                c["sources"].append("rekt")

# ---- Have I Been Pwned: breaches added in the last 30 days (CC BY 4.0)
breaches = []
try:
    for b in json.loads(get("https://haveibeenpwned.com/api/v3/breaches", 60)):
        if days_ago(parse_iso(b["AddedDate"])) > 30 or b.get("IsSpamList") or b.get("IsFabricated"): continue
        breaches.append({"name": b["Name"], "title": b["Title"], "domain": b.get("Domain"), "breach_date": b.get("BreachDate"),
                         "added": b["AddedDate"], "count": b.get("PwnCount"), "classes": b.get("DataClasses") or [],
                         "verified": b.get("IsVerified"), "sensitive": b.get("IsSensitive"), "desc": clean(b.get("Description"))[:900],
                         "links": [{"label": "Have I Been Pwned", "url": f"https://haveibeenpwned.com/Breach/{b['Name']}"},
                                   {"label": "Search X", "url": xsearch(f"{b['Title']} breach")}]})
    breaches.sort(key=lambda x: x["added"], reverse=True)
except Exception as e:
    errors.append(f"hibp: {e}")

# ---- first-seen times: when each database first listed an entry (DefiLlama often lags X by hours)
FS = os.path.join(ROOT, "pipeline", "first_seen.json")
first_seen = json.load(open(FS)) if os.path.exists(FS) else None
backfill = first_seen is None
first_seen = first_seen or {}
for c in crypto:
    k = "c:" + norm(c["name"]) + ":" + c["date"]
    if k not in first_seen: first_seen[k] = None if backfill else iso(NOW)
    c["listed_at"] = first_seen[k]
first_seen = {k: v for k, v in first_seen.items() if k.rsplit(":", 1)[-1] >= iso(NOW - dt.timedelta(days=45))[:10]}
json.dump(first_seen, open(FS, "w"), indent=0)

# ---- X signals: one record per project with every post found; scored in xscore.py
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from xscore import score_signals, ROLE_LABEL
xsig = []
if os.path.exists(XFILE):
    try:
        raw = json.load(open(XFILE))
        scored = score_signals(raw, crypto, breaches, kev, news, os.path.join(ROOT, "pipeline", "x_accounts.json"), NOW)
        lead = {}
        for x in scored:
            for h in x["matches"]:
                h["listed_at"] = next((c.get("listed_at") for c in crypto if c.get("eid") is None and h["kind"] == "crypto"
                                       and norm(c["name"]) in {norm(x.get("project") or x["subject"]), *map(norm, x.get("aliases", []))}), None)
                if h.get("listed_at"):
                    h["lag_h"] = round((parse_iso(h["listed_at"]) - parse_iso(x["first"])).total_seconds() / 3600, 1)
        xsig = [x for x in scored if days_ago(parse_iso(x["date"])) <= 7]
        xsig.sort(key=lambda x: x["date"], reverse=True)
    except Exception as e:
        errors.append(f"x: {e}")

# ---- daily series 30d
def daily(rows, key):
    c = Counter(r[key][:10] for r in rows)
    out = []
    for i in range(29, -1, -1):
        day = (NOW - dt.timedelta(days=i)).strftime("%Y-%m-%d")
        out.append([day, c.get(day, 0)])
    return out

c30 = crypto
# ---- last 24 hours by hour, across timestamped sources
def hourly_bins():
    out = []
    for h in range(23, -1, -1):
        t0 = NOW.replace(minute=0, second=0, microsecond=0) - dt.timedelta(hours=h)
        t1 = t0 + dt.timedelta(hours=1)
        def cnt(rows, key): return sum(1 for r in rows if t0 <= parse_iso(r[key]) < t1)
        out.append({"t": iso(t0), "ransomware": cnt(victims, "date"), "news": cnt(news, "date"), "x": cnt(xsig, "date")})
    return out
hourly = hourly_bins()
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from enrich import enrich
news_out, crypto_out, kev_out = news[:40], crypto[:60], kev[:40]
incidents, clusters, pattern_stats, pattern_defs = enrich(
    news_out, crypto_out, kev_out, xsig, history=crypto_hist, breaches=breaches,
    notes_path=os.path.join(ROOT, "pipeline", "analysis_notes.json"))
# ---- curated brief for the top of the page, written by the hourly agent
brief = None
try:
    brief = json.load(open(os.path.join(ROOT, "pipeline", "today_brief.json")))
    if days_ago(parse_iso(brief["updated"])) > 1.5: brief = None
except Exception as e:
    if os.path.exists(os.path.join(ROOT, "pipeline", "today_brief.json")): errors.append(f"brief: {e}")
by_kind = {"news": news_out, "crypto": crypto_out, "kev": kev_out, "x": xsig, "breach": breaches}
pos = {k: 0 for k in by_kind}
details = {}
for inc in incidents:
    item = by_kind[inc["kind"]][pos[inc["kind"]]]; pos[inc["kind"]] += 1
    item["eid"] = inc["id"]
    details[inc["id"]] = {k: inc[k] for k in ("patterns", "related", "precedents", "cluster", "cwes", "analysis", "action") if k in inc}
# X signal matches were computed before ids existed; resolve them now.
by_ref = {id(o): o for rows in (crypto, breaches, kev, news) for o in rows}
for x in xsig:
    for h in x.get("matches", []) + x.get("press", []):
        o = by_ref.get(h.pop("ref", None))
        if o is not None: h["eid"] = o.get("eid")
data = {
    "generated": iso(NOW), "errors": errors,
    "kev": {"total_catalog": kev_total, "count_7d": len(window(kev, 7)), "count_30d": len(kev),
            "ransomware_linked_30d": sum(k["ransomware"] for k in kev), "items": kev_out,
            "series": daily(kev, "date")},
    "ransomware": {**ransom, "coverage_days": ransom_coverage_days, "series": daily(victims, "date")},
    "crypto": {"count_7d": len([c for c in c30 if days_ago(parse_iso(c["date"])) <= 7]), "count_30d": len(c30),
               "usd_7d": sum((c["amount"] or 0) for c in c30 if days_ago(parse_iso(c["date"])) <= 7),
               "usd_30d": sum((c["amount"] or 0) for c in c30), "items": crypto_out, "series": daily(c30, "date"),
               "history_size": len(crypto_hist)},
    "news": news_out, "x": xsig,
    "breaches": {"count_30d": len(breaches), "accounts_30d": sum(b["count"] or 0 for b in breaches), "items": breaches},
    "hourly": hourly,
    "brief": brief,
    "details": details, "clusters": clusters[:12], "patterns": pattern_stats, "pattern_defs": pattern_defs,
}
json.dump(data, open(OUT, "w"), indent=1)
print("ok", {k: (len(v["items"]) if isinstance(v, dict) and "items" in v else None) for k, v in data.items()}, "news", len(news), "errors", errors)
