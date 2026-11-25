#!/usr/bin/env python3
"""Hourly data build for The Breach Ledger. Writes the monolith and split payloads."""
import json, re, time, html, urllib.request, urllib.parse, datetime as dt, os, sys
from xml.etree import ElementTree as ET
from collections import Counter
import split_data

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
kev_all = []
kev_raw = hibp_raw = llama_raw = None  # raw pulls, reused by the year-to-date archive
try:
    d = json.loads(get("https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json"))
    kev_raw = d["vulnerabilities"]
    for v in d["vulnerabilities"]:
        a = parse_iso(v["dateAdded"])
        kev_all.append(a)
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
ransom_called = days_ago(oldest) < 29
if ransom_called:
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

# ---- ransomware.live monthly totals (public stats page), for month-to-date and year-to-date
RM = os.path.join(ROOT, "pipeline", "ransom_monthly.json")
ransom_monthly = json.load(open(RM)) if os.path.exists(RM) else {}
try:
    if not ransom_monthly or days_ago(parse_iso(ransom_monthly.get("fetched", "2000-01-01"))) > 0.2:
        page = get("https://www.ransomware.live/stats", 40).decode("utf-8", "replace")
        m_ = re.search(r"monthlyData\s*=\s*(\{.*?\})\s*;", page, re.S)
        ransom_monthly = {"fetched": iso(NOW), "source": "https://www.ransomware.live/stats", "months": json.loads(m_.group(1))}
        json.dump(ransom_monthly, open(RM, "w"))
except Exception as e:
    errors.append(f"ransomware stats: {e}")

# ---- DefiLlama hacks
crypto = []
crypto_hist = []
llama_all = []
try:
    llama_raw = json.loads(get("https://api.llama.fi/hacks"))
    for h in llama_raw:
        d0 = dt.datetime.fromtimestamp(h["date"], dt.timezone.utc)
        llama_all.append((d0, h.get("amount") or 0, h.get("name")))
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

# ---- News RSS/Atom. Feeds only carry their latest items, so every hit is kept in a 10-day cache;
# otherwise stories drop out of the 7-day window as soon as the feed rolls over.
FEEDS = [("The Record", "https://therecord.media/feed"),
         ("The Hacker News", "https://feeds.feedburner.com/TheHackersNews"),
         ("DataBreaches.net", "https://databreaches.net/feed/"),
         ("rekt", "https://rekt.news/rss/feed.xml"),
         ("BleepingComputer", "https://www.bleepingcomputer.com/feed/"),
         ("Krebs on Security", "https://krebsonsecurity.com/feed/"),
         ("SecurityWeek", "https://www.securityweek.com/feed/"),
         ("Dark Reading", "https://www.darkreading.com/rss.xml"),
         ("CyberScoop", "https://cyberscoop.com/feed/"),
         ("Help Net Security", "https://www.helpnetsecurity.com/feed/"),
         ("Infosecurity Magazine", "https://www.infosecurity-magazine.com/rss/news/"),
         ("TechCrunch", "https://techcrunch.com/category/security/feed/"),
         ("SC Media", "https://www.scworld.com/rss"),
         ("Security Affairs", "https://securityaffairs.com/feed"),
         ("CSO Online", "https://www.csoonline.com/feed/"),
         ("Cloudflare", "https://blog.cloudflare.com/tag/security/rss/")]
KW = re.compile(r"\b(hack|hacked|hackers?|breach|breached|breaches|ransomware|exploit|exploited|exploits|stolen|steal|leak|leaked|attack|attacks|compromise[sd]?|drain(ed)?|zero-day|0-day|extortion|intrusion|stole|outage|incident|backdoor(ed)?|malicious|trojani[sz]ed|data exposure|exposed)\b", re.I)
news = []
SKIP = re.compile(r"(webinar|sponsored|\bhow to\b|you.re flying blind|\bguide\b|\bpodcast\b|week in review|\bweekly recap\b|\bsponsor\b|\bpartner content\b|\bbest\b.*\btools\b)", re.I)
from email.utils import parsedate_to_datetime
def clean(s): return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()
NC = os.path.join(ROOT, "pipeline", "news_cache.json")
ncache = json.load(open(NC)) if os.path.exists(NC) else {}
def feed_items(root):
    for it in root.iter("item"):
        yield clean(it.findtext("title")), (it.findtext("link") or "").strip(), it.findtext("pubDate"), it.findtext("description")
    A = "{http://www.w3.org/2005/Atom}"
    for it in root.iter(A + "entry"):
        ln = next((l.get("href") for l in it.findall(A + "link") if l.get("rel") in (None, "alternate")), "")
        yield clean(it.findtext(A + "title")), ln, it.findtext(A + "updated") or it.findtext(A + "published"), it.findtext(A + "summary") or it.findtext(A + "content")
from concurrent.futures import ThreadPoolExecutor
def _fetch_feed(feed):
    try: return get(feed[1], 30), None
    except Exception as e: return None, e
with ThreadPoolExecutor(max_workers=8) as _pool:  # fetch in parallel, process in list order
    _feeds = list(_pool.map(_fetch_feed, FEEDS))
for (name, url), (raw, ferr) in zip(FEEDS, _feeds):
    try:
        if ferr: raise ferr
        root = ET.fromstring(raw)
        for t, l, pd, desc in feed_items(root):
            if not (t and l and pd): continue
            try: d0 = parsedate_to_datetime(pd)
            except Exception: d0 = parse_iso(pd[:19] + "Z" if "T" in pd else pd)
            if days_ago(d0) > 10 or l in ncache: continue
            desc = clean(desc)[:280]
            if not KW.search(t) or SKIP.search(t + " " + desc): continue
            ncache[l] = {"date": iso(d0), "source": name, "title": t, "url": l, "summary": desc}
    except Exception as e:
        errors.append(f"news {name}: {e}")
# ---- mainstream, finance and non-English press via Google News search (security trade press misses many incidents)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gnews
try:
    for g in gnews.collect(NOW, get, errors):
        if g["url"] not in ncache: ncache[g["url"]] = g
except Exception as e:
    errors.append(f"gnews: {e}")
# ---- companies' own incident notices, found through Hacker News (usually hours before any press)
import hn
try:
    for g in hn.collect(NOW, get, errors):
        if g["url"] not in ncache: ncache[g["url"]] = g
except Exception as e:
    errors.append(f"hn: {e}")
ncache = {k: v for k, v in ncache.items() if days_ago(parse_iso(v["date"])) <= 10}
# ---- everything on the page is in English: translate non-English headlines once, keep the original for matching
import translate
for _lg in {v.get("lang") for v in ncache.values()}:
    translate.prefetch([x for v in ncache.values() if v.get("lang") == _lg and "title_orig" not in v for x in (v["title"], v.get("summary") or "")], _lg)
for v in sorted(ncache.values(), key=lambda v: v["date"], reverse=True):
    if "title_orig" in v or not translate.needs(v["title"], v.get("lang")): continue
    t_en = translate.en(v["title"], v.get("lang"))
    if t_en != v["title"]:
        v["title_orig"], v["title"] = v["title"], t_en
        if v.get("summary"): v["summary"] = translate.en(v["summary"], v.get("lang"))
translate.save()
json.dump(ncache, open(NC, "w"))
headlines = [v for v in ncache.values() if days_ago(parse_iso(v["date"])) <= 7]
# one row per story, with every outlet that covered it
news = gnews.stories(headlines)
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
# Tracker labels can differ even when both feeds refer to the same event.
# Limit explicit equivalences to the event date so they cannot merge later incidents.
CRYPTO_ALIASES = os.path.join(ROOT, "pipeline", "crypto_aliases.json")
try:
    crypto_alias_config = json.load(open(CRYPTO_ALIASES))
except (OSError, ValueError):
    crypto_alias_config = {}
same_events = crypto_alias_config.get("_same_events", {})
for s_ in slow:
    if days_ago(parse_iso(s_["date"])) > 30: continue
    equivalent = same_events.get(s_["date"], {}).get(s_["name"])
    hit = next((c for c in crypto if c["date"] == s_["date"] and c["name"] == equivalent), None)
    if hit is None:
        hit = next((c for c in crypto if near(c["date"], s_["date"]) and (norm(c["name"]) == norm(s_["name"]) or norm(s_["name"]) in norm(c["name"]) or norm(c["name"]) in norm(s_["name"])) and len(norm(s_["name"])) >= 3), None)
    sm_links = [{"label": "SlowMist", "url": "https://hacked.slowmist.io/?search=" + urllib.parse.quote(s_["name"])}]
    if s_["ref"]: sm_links.append({"label": "SlowMist reference", "url": s_["ref"]})
    if hit:
        sources = hit.setdefault("sources", ["DefiLlama"])
        if "SlowMist" not in sources: sources.append("SlowMist")
        # Explicitly linked trackers may use different loss definitions or have
        # different confidence in the entry vector. Keep the canonical figures
        # and technique; link to the other tracker without combining its claims.
        if not equivalent: hit["slowmist_method"] = s_["method"]
        hit["links"] = hit["links"][:-1] + [l for l in sm_links if l["url"] not in [x["url"] for x in hit["links"]]] + hit["links"][-1:]
    else:
        crypto.append({"date": s_["date"], "name": s_["name"], "amount": s_["amount"], "returned": None, "chains": [],
                       "classification": None, "technique": s_["method"], "target": None, "desc": s_["desc"],
                       "sources": ["SlowMist"], "links": sm_links + [{"label": "Search X", "url": xsearch(f"{s_['name']} (exploit OR hack OR drained)")}]})
        # SlowMist also lists off-chain fraud (e.g. money moved out of bank accounts); list it, but keep it out of crypto loss totals
        if re.search(r"bank'?s own accounts|transfer(red)? funds to other financial institutions|wire transfer|fiat", s_["desc"], re.I):
            crypto[-1]["offchain"] = True
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
hibp_all = []
try:
    hibp_raw = json.loads(get("https://haveibeenpwned.com/api/v3/breaches", 60))
    for b in hibp_raw:
        if not (b.get("IsSpamList") or b.get("IsFabricated")): hibp_all.append((parse_iso(b["AddedDate"]), b.get("PwnCount") or 0))
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
kev_backfill = backfill or not any(k.startswith("k:") for k in first_seen)
for v in kev:
    k = "k:" + v["id"] + ":" + v["date"]
    if k not in first_seen: first_seen[k] = None if kev_backfill else iso(NOW)
    v["listed_at"] = first_seen[k]
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
        xsig = [x for x in scored if days_ago(parse_iso(x.get("last") or x["date"])) <= 7]  # still active in the last week
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

c30 = [c for c in crypto if not c.get("offchain")]
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
# ---- press coverage of a crypto incident belongs on that incident, not as separate news rows
# Aliases: the listed name, its parts, names the X signal uses, and a hand-kept list (pipeline/crypto_aliases.json)
_CA = {k: v for k, v in crypto_alias_config.items() if not k.startswith("_")}
_GENERIC = {"bridge", "finance", "protocol", "exchange", "wallet", "token", "lending", "swap", "labs", "network", "dao", "defi", "cex", "dex", "v1", "v2", "v3"}
def _aliases(c):
    nm = c["name"]; out = {nm, re.sub(r"\s*\(.*?\)", "", nm).strip(), *re.findall(r"\((.*?)\)", nm)}
    for x in xsig:
        if any(h.get("kind") == "crypto" and h.get("ref") == id(c) for h in x.get("matches", [])) or norm(x.get("project") or "") == norm(nm):
            out |= {x.get("project") or "", *x.get("aliases", [])}
    out |= set(_CA.get(nm, []))
    return [a for a in out if a and len(a) >= 4 and a.lower() not in _GENERIC]
_claimed = set()
for c in [c for c in crypto if not c.get("offchain") and days_ago(parse_iso(c["date"])) <= 30 and (c["amount"] or 0) >= 250000]:
    al = _aliases(c)
    rx = re.compile(r"(?<![A-Za-z0-9])(" + "|".join(re.escape(a) for a in sorted(al, key=len, reverse=True)) + r")(?![A-Za-z0-9])", re.I)
    d0 = parse_iso(c["date"]) - dt.timedelta(days=1)
    hits = [n for n in news if id(n) not in _claimed and parse_iso(n["date"]) >= d0
            and (rx.search(n["title"] + " | " + n.get("title_orig", "")) or any(rx.search(o.get("title", "") + " | " + o.get("title_orig", "")) for o in n.get("outlets", [])[:3]))]
    if not hits: continue
    outs, seen_o = [], set()
    for n in hits:
        _claimed.add(id(n)); n["_crypto"] = c
        for o in n.get("outlets") or [{"source": n["source"], "url": n["url"], "date": n["date"], "title": n["title"]}]:
            if o["url"] in seen_o: continue
            seen_o.add(o["url"]); outs.append(o)
    outs.sort(key=lambda o: o["date"])
    c["outlets"] = outs[:40]; c["n_outlets"] = len({o["source"] for o in outs}); c["first_press"] = outs[0]["date"]
# claimed stories stay in the feed (developments are news) but open the crypto entry; the registry never sees them
# keep every story covered by 2+ outlets, by the security trade press or disclosed by the company itself, then the newest single-outlet ones
_keep = [n for n in news if n.get("n_outlets", 1) >= 2 or n["source"] in gnews.TRADE or n.get("disclosure")]
_rest = [n for n in news if n not in _keep][: max(0, 450 - len(_keep))]
news_out = sorted(_keep + _rest, key=lambda n: n["date"], reverse=True)
crypto_out, kev_out = crypto[:60], kev[:40]
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
# Brief entries tied to an incident that started more than 3 days ago are follow-ups, not new hits.
eid_date = {}
for kind, rows in by_kind.items():
    for o in rows:
        if o.get("eid"):
            eid_date[o["eid"]] = o.get("first") if kind == "x" else (o.get("added") if kind == "breach" else o.get("date"))
if brief:
    for i in brief.get("incidents", []):
        # A linked article or post dates the disclosure, not necessarily the incident.
        linked_date = eid_date.get(i.get("eid"))
        d0 = i.get("since") or linked_date
        if d0:
            # An explicit null marks an incident whose exact start day is unknown.
            if "since" not in i or i["since"] is not None:
                i["since"] = d0[:10]
            i["update"] = bool(i.get("update")) or any(
                days_ago(parse_iso(d if len(d) > 10 else d + "T23:59:59Z")) > 3
                for d in (d0, linked_date) if d
            )
# ---- official breach notices (state AGs, HHS, SEC 8-K Item 1.05, press-reported attacks)
notices = []
try:
    import official
    notices = official.collect(NOW, get, errors)
except ImportError:
    pass
except Exception as e:
    errors.append(f"official: {e}")
# ---- incident registry: curated records with every matching story and notice attached
import registry
REG = os.path.join(ROOT, "pipeline", "incidents.json")
reg_recs, unmatched = registry.attach(registry.load(REG), [n for n in news if "_crypto" not in n], notices, NOW)
for n in news:
    if "_crypto" in n:
        _c = n.pop("_crypto")
        if _c.get("eid"): n["crypto"] = _c["eid"]
tq = registry.triage_queue(unmatched, NOW)
# outlets are kept in full for matching above; the page only needs the first few per story
news_out = [dict(n, outlets=n.get("outlets", [])[:10]) if len(n.get("outlets", [])) > 10 else n for n in news_out]
json.dump({"generated": iso(NOW), "queue": tq}, open(os.path.join(ROOT, "pipeline", "triage_queue.json"), "w"), indent=1, ensure_ascii=False)
# ---- counts by window: last hour, 24h, 7d, month to date, year to date
def win_bounds():
    som = NOW.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    soy = som.replace(month=1)
    return {"1h": NOW - dt.timedelta(hours=1), "24h": NOW - dt.timedelta(hours=24), "7d": NOW - dt.timedelta(days=7), "30d": NOW - dt.timedelta(days=30), "ytd": soy}
WB = win_bounds()
def day_in(d, w):  # day-granular dates count from the start of their day
    return d >= WB[w].replace(hour=0, minute=0, second=0, microsecond=0) if w in ("1h", "24h", "7d") else d >= WB[w]
def seen_in(listed, d, w):
    if w in ("1h", "24h"):
        return parse_iso(listed) >= WB[w] if listed else (w == "24h" and d >= (NOW - dt.timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0))
    return day_in(d, w)
windows = {"bounds": {k: iso(v) for k, v in WB.items()}, "rows": {}}
cw = {}
for w in WB:
    if w in ("1h", "24h"):
        rows_ = [c for c in c30 if seen_in(c.get("listed_at"), parse_iso(c["date"]), w)]
        cw[w] = {"n": len(rows_), "usd": sum(c["amount"] or 0 for c in rows_)}
    else:
        # DefiLlama's full history, plus SlowMist-only incidents DefiLlama has not listed yet (same set the page lists)
        rows_ = [(a, nm, d) for d, a, nm in llama_all if d >= WB[w]] + \
                [(c["amount"] or 0, c["name"], parse_iso(c["date"])) for c in c30 if c["sources"] == ["SlowMist"] and day_in(parse_iso(c["date"]), w)]
        top = max(rows_, default=None)
        cw[w] = {"n": len(rows_), "usd": sum(a for a, _, _ in rows_),
                 "top": {"name": top[1], "usd": top[0], "date": top[2].strftime("%Y-%m-%d")} if top else None}
windows["rows"]["crypto"] = cw
yr, mo = str(NOW.year), NOW.month
rm = (ransom_monthly.get("months") or {}).get(yr)
rw = {w: {"n": sum(1 for v in victims if parse_iso(v["date"]) >= WB[w])} for w in ("1h", "24h", "7d", "30d")}
if rm:
    rw["ytd"] = {"n": sum(rm[:mo]), "src": "ransomware.live stats"}
windows["rows"]["ransomware"] = rw
kw = {}
for w in WB:
    if w in ("1h", "24h"): kw[w] = {"n": sum(1 for v in kev if seen_in(v.get("listed_at"), parse_iso(v["date"]), w))}
    else: kw[w] = {"n": sum(1 for a in kev_all if a >= WB[w])}
windows["rows"]["kev"] = kw
windows["rows"]["breach"] = {w: {"n": sum(1 for d, _ in hibp_all if d >= WB[w]), "acc": sum(c for d, c in hibp_all if d >= WB[w])} for w in WB}
windows["rows"]["news"] = {w: {"n": sum(1 for n in news if parse_iso(n["date"]) >= WB[w]),
                               "headlines": sum(1 for n in headlines if parse_iso(n["date"]) >= WB[w])} for w in ("1h", "24h", "7d")}
windows["rows"]["incidents"] = {w: {"n": sum(1 for r in reg_recs if parse_iso(r["first_reported"]) >= WB[w])} for w in WB}
# notices carry a day, not a time: a notice dated today counts as last 24h (not last hour)
windows["rows"]["notices"] = {w: {"n": sum(1 for o in notices if (parse_iso(o["date"]) + dt.timedelta(hours=23, minutes=59)) >= WB[w] and (w != "1h" or o["date"][11:19] != "00:00:00"))} for w in ("1h", "24h", "7d")}
windows["rows"]["x"] = {w: {"n": sum(1 for x in xsig if parse_iso(x["first"]) >= WB[w])} for w in ("1h", "24h", "7d")}

# ---- year-to-date archive (site/archive.json, lazily loaded by the page); incremental, cached in pipeline/archive_cache/
try:
    import archive
    archive.build(NOW, get, errors, {"victims": cache, "ransom_called": ransom_called, "kev_raw": kev_raw,
                                     "hibp_raw": hibp_raw, "llama_raw": llama_raw, "crypto": crypto, "notices": notices})
except Exception as e:
    errors.append(f"archive: {e}")
# Year to date is the archive: the YTD box shows the same per-type counts as the "YTD" archive tab, and its total
# equals the tab's "All" count. A crypto hack that is also a curated incident is marked "dup" and counted once
# (as the incident), the same rule the page uses to list it once under All.
try:
    _AP = os.path.join(ROOT, "site", "archive.json")
    _doc = json.load(open(_AP))
    _arc = _doc["items"]
    _STOP = {"cex", "dex", "protocol", "finance", "exchange", "the"}
    def _tok(s):
        return next((w for w in re.sub(r"[^a-z0-9 ]", " ", (s or "").lower()).split() if len(w) > 2 and w not in _STOP), None)
    _incs = [a for a in _arc if a["k"] == "inc" and a.get("r")]
    for a in _arc:
        a.pop("dup", None)
        if a["k"] != "crypto": continue
        w, t0 = _tok(a.get("o")), parse_iso(a["d"])
        m = w and next((b for b in _incs if abs((parse_iso(b["d"]) - t0).total_seconds()) <= 4 * 86400 and w in (b.get("o") or "").lower()), None)
        if m: a["dup"] = "r-" + m["r"]
    json.dump(_doc, open(_AP + ".tmp", "w"), ensure_ascii=False, separators=(",", ":")); os.replace(_AP + ".tmp", _AP)
    _yr = [a for a in _arc if a["d"][:4] == str(NOW.year)]
    _ytd = Counter(a["k"] for a in _yr)
    _R = windows["rows"]
    _R["crypto"]["ytd"] = {**_R["crypto"].get("ytd", {}), "n": _ytd["crypto"]}
    _R["ransomware"]["ytd"] = {"n": _ytd["ransom"]}
    _R["kev"]["ytd"] = {"n": _ytd["kev"]}
    _R["breach"]["ytd"] = {**_R["breach"].get("ytd", {}), "n": _ytd["breach"]}
    _R["incidents"]["ytd"] = {"n": _ytd["inc"]}
    _R["notices"]["ytd"] = {"n": _ytd["notice"] + _ytd["sec"]}
    _R["archive"] = {"ytd": {"n": sum(1 for a in _yr if not a.get("dup")), "records": len(_yr), "dup": sum(1 for a in _yr if a.get("dup"))}}
except Exception as e:
    errors.append(f"ytd from archive: {e}")
# older registry records are served from archive.json; data.json keeps the last 45 days
reg_page = [r for r in reg_recs if days_ago(parse_iso(r["latest"])) <= 45]

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
    "news": news_out, "news_headlines_7d": len(headlines), "registry": reg_page, "notices": notices[:300], "triage_n": len(tq), "x": xsig,
    "breaches": {"count_30d": len(breaches), "accounts_30d": sum(b["count"] or 0 for b in breaches), "items": breaches},
    "hourly": hourly, "windows": windows,
    "brief": brief,
    "details": details, "clusters": clusters[:12], "patterns": pattern_stats, "pattern_defs": pattern_defs,
}
# ---- final English pass over every human-readable string on the page (headlines, outlet names, notices, X posts)
_TXT = {"title", "summary", "desc", "text", "label", "titles", "why", "note", "headline", "also"}
_NAME = {"source", "org", "outlet", "account_name", "name"}
def _english(o, key=None):
    if isinstance(o, dict): return {k: (v if k in ("match", "exclude", "aliases", "title_orig") else _english(v, k)) for k, v in o.items()}
    if isinstance(o, list): return [_english(v, key) for v in o]
    if isinstance(o, str) and not o.startswith("http"):
        if key in _NAME:  # proper names: only transliterate non-Latin scripts, leave accented Latin names alone
            letters = [ch for ch in o if ch.isalpha()]
            if letters and sum(ord(ch) > 0x24f for ch in letters) / len(letters) > 0.3: return translate.en(o)
            return o
        if key in _TXT: return translate.en(o)
    return o
def _gather(o, key=None, acc=None):
    if isinstance(o, dict):
        for k, v in o.items():
            if k not in ("match", "exclude", "aliases", "title_orig"): _gather(v, k, acc)
    elif isinstance(o, list):
        for v in o: _gather(v, key, acc)
    elif isinstance(o, str) and not o.startswith("http") and (key in _TXT or key in _NAME): acc.append(o)
    return acc
translate.prefetch(_gather(data, None, []))
data = _english(data)
translate.save()
with open(OUT + ".tmp", "w", encoding="utf-8") as f:
    json.dump(data, f, separators=(",", ":"), ensure_ascii=False)
os.replace(OUT + ".tmp", OUT)
try:
    split_data.write_split_files(data, os.path.join(ROOT, "site"))
except Exception as exc:
    reason = f"{type(exc).__name__}: {exc}"
    try:
        split_data.remove_split_files(os.path.join(ROOT, "site"))
    except OSError as cleanup_exc:
        reason += f"; {cleanup_exc}"
    print("Split payload generation failed; keeping data.json only:", " ".join(reason.splitlines()), file=sys.stderr)
print("ok", {k: (len(v["items"]) if isinstance(v, dict) and "items" in v else None) for k, v in data.items()}, "news", len(news), "errors", errors)
