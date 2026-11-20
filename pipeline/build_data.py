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
                "due": v.get("dueDate"),
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
    if k in cache: return
    cache[k] = {"date": iso(parse_iso(ds)), "group": v.get("group") or "unknown",
                "sector": v.get("activity") or "Not found", "country": v.get("country") or "??"}
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
    }

# ---- DefiLlama hacks
crypto = []
try:
    for h in json.loads(get("https://api.llama.fi/hacks")):
        d0 = dt.datetime.fromtimestamp(h["date"], dt.timezone.utc)
        if days_ago(d0) <= 30:
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

# ---- X signals (curated / agent-collected; facts + link only)
xsig = []
if os.path.exists(XFILE):
    try:
        xsig = [x for x in json.load(open(XFILE)) if days_ago(parse_iso(x["date"])) <= 7]
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
data = {
    "generated": iso(NOW), "errors": errors,
    "kev": {"total_catalog": kev_total, "count_7d": len(window(kev, 7)), "count_30d": len(kev),
            "ransomware_linked_30d": sum(k["ransomware"] for k in kev), "items": kev[:40],
            "series": daily(kev, "date")},
    "ransomware": {**ransom, "coverage_days": ransom_coverage_days, "series": daily(victims, "date")},
    "crypto": {"count_7d": len([c for c in c30 if days_ago(parse_iso(c["date"])) <= 7]), "count_30d": len(c30),
               "usd_7d": sum((c["amount"] or 0) for c in c30 if days_ago(parse_iso(c["date"])) <= 7),
               "usd_30d": sum((c["amount"] or 0) for c in c30), "items": c30[:60], "series": daily(c30, "date")},
    "news": news[:40], "x": xsig,
}
json.dump(data, open(OUT, "w"), indent=1)
print("ok", {k: (len(v["items"]) if isinstance(v, dict) and "items" in v else None) for k, v in data.items()}, "news", len(news), "errors", errors)
