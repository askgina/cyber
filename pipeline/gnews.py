"""Mainstream press coverage via Google News RSS search, plus story clustering.

Security trade feeds miss incidents that run first in general, finance or local press
(e.g. Reuters, Bloomberg, Handelsblatt, local TV). Google News search RSS is free and
covers thousands of outlets; we run a spread of incident queries in several languages.
"""
import re, html, math, urllib.parse, datetime as dt
from xml.etree import ElementTree as ET
from email.utils import parsedate_to_datetime
from collections import Counter

# (query, hl, gl, ceid). "when:2d" keeps results recent.
Q_EN = [
    "cyberattack", "\"cyber attack\"", "\"data breach\"", "hackers", "hacked", "ransomware attack",
    "\"data leak\"", "\"security incident\"", "\"unauthorized access\" data", "\"systems offline\" cyber",
    "\"breach notification\"", "\"personal information\" exposed breach", "\"crypto hack\" OR \"exploit\" drained",
    "\"stolen funds\" crypto", "\"zero-day\" exploited", "\"malicious package\" OR \"supply chain attack\"",
    "\"leaked\" database hackers", "\"cybersecurity incident\" 8-K",
    "cyberattack company", "\"data breach\" customers", "\"hackers stole\"", "\"cyber incident\" disrupts", "\"ransomware\" claims",
    "cyberattack hospital", "cyberattack council OR county OR city", "cyberattack \"school district\" OR university", "exchange hacked crypto",
    "\"notifying\" customers breach", "\"third-party vendor\" breach",
]
Q_INTL = [
    ("Hackerangriff OR Cyberangriff", "de", "DE", "DE:de"), ("Datenleck OR Datenleak", "de", "DE", "DE:de"),
    ("cyberattaque OR \"fuite de données\"", "fr", "FR", "FR:fr"), ("ciberataque OR \"filtración de datos\"", "es", "ES", "ES:es"),
    ("\"ataque hacker\" OR \"vazamento de dados\"", "pt-BR", "BR", "BR:pt-419"), ("\"attacco hacker\" OR \"violazione dei dati\"", "it", "IT", "IT:it"),
    ("サイバー攻撃 OR 不正アクセス OR ランサムウェア", "ja", "JP", "JP:ja"), ("해킹 OR 개인정보 유출", "ko", "KR", "KR:ko"),
    ("cyberattack OR \"data breach\"", "en-IN", "IN", "IN:en"), ("cyberattack OR \"data breach\"", "en-GB", "GB", "GB:en"),
    ("cyberattack OR \"data breach\"", "en-AU", "AU", "AU:en"), ("cyberattack OR \"data breach\"", "en-CA", "CA", "CA:en"),
    ("dataintrång OR cyberattack OR hackerattack", "sv", "SE", "SE:sv"), ("hack OR datalek OR cyberaanval", "nl", "NL", "NL:nl"),
    ("cyberatak OR \"wyciek danych\"", "pl", "PL", "PL:pl"), ("\"siber saldırı\" OR \"veri sızıntısı\"", "tr", "TR", "TR:tr"),
    ("黑客 OR 数据泄露 OR 网络攻击", "zh-TW", "TW", "TW:zh-Hant"), ("\"atac cibernetic\" OR \"atac informatic\"", "ro", "RO", "RO:ro"),
    ("ciberataque OR hackeo", "es-419", "MX", "MX:es-419"), ("\"кибератака\" OR \"утечка данных\"", "ru", "RU", "RU:ru"),
]

NOISE = re.compile(r"(\bhow to\b|\btips\b|\bprotect yourself\b|\bwebinar\b|\bprepared\b|\bmarket (size|share|report)\b|\bstocks? to\b|"
                   r"\bsurvey\b|\breport finds\b|\bstudy\b|\bawareness month\b|\bbest\b.*\b(tools|vpn)\b|\bpodcast\b|\bopinion\b|"
                   r"\bwhat is\b|\bexplained\b|\bcareer\b|\bjobs?\b|\bcourse\b|\bcertification\b|\binsurance market\b|\bfunding\b|\braises \$)", re.I)


def _clean(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()


def collect(now, get, errors, days=3, when="2d", extra=()):
    out, seen = [], set()
    jobs = [(q, "en-US", "US", "US:en") for q in Q_EN] + Q_INTL + list(extra)
    for q, hl, gl, ceid in jobs:
        url = "https://news.google.com/rss/search?" + urllib.parse.urlencode({"q": q + " when:" + when, "hl": hl, "gl": gl, "ceid": ceid})
        try:
            root = ET.fromstring(get(url, 25))
        except Exception as e:
            errors.append(f"gnews {q[:30]}: {e}")
            continue
        for it in root.iter("item"):
            t = _clean(it.findtext("title")); link = (it.findtext("link") or "").strip(); pd = it.findtext("pubDate")
            src_el = it.find("source"); src = _clean(src_el.text if src_el is not None else "")
            if not (t and link and pd): continue
            if src and t.endswith(" - " + src): t = t[: -len(src) - 3].strip()
            try: d0 = parsedate_to_datetime(pd)
            except Exception: continue
            if (now - d0).total_seconds() > days * 86400: continue
            key = (src.lower(), re.sub(r"\W+", "", t.lower())[:80])
            if key in seen or NOISE.search(t): continue
            seen.add(key)
            out.append({"date": d0.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "source": src or "Google News",
                        "title": t, "url": link, "summary": "", "via": "Google News", "lang": hl.split("-")[0]})
    return out


# ---------------------------------------------------------------- clustering
STOP = set("""a an the and or of to in on for with by from at as is are was were be been has have had it its this that these those
after before over into amid about against new says said say report reports reported reportedly claims claim claimed confirms confirmed
confirm hit hits struck suffers suffered faces facing probe probes investigating investigation investigate updates update latest
data breach breaches breached hack hacked hacker hackers hacking cyber cyberattack cyberattacks attack attacks attacked security incident
incident leak leaked leaks exposed exposes exposure stolen stole steal ransomware gang group threat actors actor customers customer users
information personal million millions thousands people affected impacted could may might will via amid more than up off out what who
how why why when where week today day news online system systems services service it's company firm giant major massive""".split())


def _tokens(title):
    words = re.findall(r"[A-Za-z0-9][A-Za-z0-9'&.-]*|[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]{2,}", title)
    toks = []
    for w in words:
        lw = w.lower().strip(".'")
        if len(lw) < 3 and not w.isupper(): continue
        if lw in STOP: continue
        toks.append(lw)
    return set(toks)


def cluster(items, hours=96, thresh=0.42):
    """Group headlines about the same incident. Weighted overlap of rare title tokens within a time window."""
    toks = [_tokens(i["title"]) for i in items]
    df = Counter(t for ts in toks for t in ts)
    N = max(1, len(items))
    idf = {t: math.log(1 + N / c) for t, c in df.items()}
    ts_ = [dt.datetime.fromisoformat(i["date"].replace("Z", "+00:00")).timestamp() for i in items]
    order = sorted(range(len(items)), key=lambda k: ts_[k])
    W = lambda ts: sum(idf[t] for t in ts) or 1
    cl = []  # each: {"m": [idx], "core": set, "t": last ts, "cnt": Counter}
    for k in order:
        tk = toks[k]; best, bs = None, 0
        for c in cl:
            if ts_[k] - c["t0"] > hours * 3600: continue
            shared = tk & c["core"]
            if not shared or max(idf[t] for t in shared) < 2.0: continue
            s = sum(idf[t] for t in shared) / min(W(tk), W(c["core"]))
            if s >= thresh and s > bs: best, bs = c, s
        if best is None:
            cl.append({"m": [k], "core": set(tk), "t0": ts_[k], "cnt": Counter(tk)})
        else:
            best["m"].append(k); best["cnt"].update(tk)
            n = len(best["m"]); seed = toks[best["m"][0]]
            best["core"] = {t for t in seed if best["cnt"][t] >= 0.3 * n} | {t for t, c in best["cnt"].items() if c >= max(2, 0.5 * n)}
            if not best["core"]: best["core"] = set(seed)
    # second pass: merge clusters about the same story that formed separately (different wording or language)
    cl.sort(key=lambda c: -len(c["m"]))
    merged = []
    for c in cl:
        for m in merged:
            if abs(c["t0"] - m["t0"]) > hours * 3600: continue
            shared = c["core"] & m["core"]
            if not shared or max(idf[t] for t in shared) < 2.5: continue
            if sum(idf[t] for t in shared) / min(W(c["core"]), W(m["core"])) >= 0.5:
                m["m"] += c["m"]; m["core"] |= c["core"] if len(c["m"]) > 2 else set(); break
        else:
            merged.append(c)
    groups = {i: c["m"] for i, c in enumerate(merged)}
    return [[items[k] for k in sorted(g, key=lambda k: ts_[k])] for g in groups.values()]


TRADE = {"BleepingComputer", "The Record", "The Hacker News", "SecurityWeek", "Dark Reading", "DataBreaches.net", "CyberScoop",
         "Infosecurity Magazine", "Help Net Security", "TechCrunch", "SC Media", "Security Affairs", "CSO Online", "rekt", "Krebs on Security"}


def stories(items):
    """One row per story: the lead item (prefer English trade press, then earliest) with all outlets attached."""
    out = []
    for g in cluster(items):
        lead = min(g, key=lambda i: (i.get("lang", "en") != "en", i["source"] not in TRADE, i["date"]))
        outlets, seen = [], set()
        for i in g:
            if i["source"] in seen: continue
            seen.add(i["source"]); outlets.append({"source": i["source"], "url": i["url"], "date": i["date"], "title": i["title"], **({"title_orig": i["title_orig"]} if i.get("title_orig") else {})})
        s = dict(lead)
        s["date"] = g[0]["date"]  # first seen anywhere
        s["latest"] = g[-1]["date"]
        s["outlets"] = outlets[:25]
        s["n_outlets"] = len(outlets)
        if not s.get("summary"):
            s["summary"] = next((i["summary"] for i in g if i.get("summary")), "")
        out.append(s)
    out.sort(key=lambda s: s["date"], reverse=True)
    return out
