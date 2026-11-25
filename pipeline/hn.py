"""Company breach disclosures, found through Hacker News.

Companies post incident notices on their own blogs and status pages, often 12-18 hours before
any outlet we read writes about them. Someone usually submits the notice to Hacker News within
minutes, so HN works as a free, keyless index of first-party disclosures across all companies.

We keep link stories whose title reads like a disclosure and whose link is the affected
organisation's own page (or its formal filing). Coverage by news sites, researchers and
commentators is dropped: it reaches us through the feeds and Google News anyway.
"""
import json, re, urllib.parse
from concurrent.futures import ThreadPoolExecutor

API = "https://hn.algolia.com/api/v1/search_by_date?"
QUERIES = ["security incident", "data breach", "breach", "breached", "compromised", "hacked",
           "unauthorized access", "cyberattack", "security notice", "incident report"]
TITLE = re.compile(r"\b(security (incident|notice|attack|breach)|data breach|breach(ed)?|compromised?|"
                   r"hacked|unauthori[sz]ed access|cyber ?attack|intrusion|stolen)\b", re.I)
# Discussion, advice and retrospectives about breaches in general, not a disclosure of one.
NOISE = re.compile(r"^(ask|show|tell|launch) hn\b|\b(how|why|guide|tips|lessons|should|shouldn.t|every|everything|"
                   r"tutorial|explained|history of|years? (after|later)|book|course|podcast|interview|"
                   r"opinion|essay|study|survey|paper|thesis|outage|i got hacked)\b|\?$", re.I)
MIN_POINTS = 3
# News sites, social networks and code hosts: anyone can post there, so a link is not the company speaking.
# (X is covered separately; news coverage arrives through the feeds and Google News.)
NOT_OWN = {"twitter.com", "x.com", "github.com", "gist.github.com", "bsky.app", "mastodon.social", "reddit.com",
           "medium.com", "substack.com", "linkedin.com", "youtube.com", "techcrunch.com", "bleepingcomputer.com",
           "therecord.media", "thehackernews.com", "securityweek.com", "theregister.com", "arstechnica.com",
           "wired.com", "theverge.com", "reuters.com", "bloomberg.com", "krebsonsecurity.com", "databreaches.net",
           "cyberscoop.com", "darkreading.com", "securityaffairs.com", "helpnetsecurity.com", "zdnet.com"}
# Places where an organisation files its own incident report even though the site is not its own.
FILINGS = {"bugzilla.mozilla.org", "sec.gov"}
# Subdomains an organisation uses for its own notices.
OWN_PAGE = {"status", "trust", "security", "support", "help", "blog", "news", "investors", "ir"}
DISCLOSURE_TITLE = re.compile(r"\b(security (incident|notice|update|breach)|incident report|post[- ]?mortem|"
                              r"update on (our|the) .*incident|notice of (data|security))\b", re.I)


def host(url):
    h = (urllib.parse.urlsplit(url).hostname or "").lower()
    return h[4:] if h.startswith("www.") else h


def brand(h):
    parts = h.split(".")
    if len(parts) >= 3 and parts[-2] in ("co", "com", "org", "net", "ac", "gov") and len(parts[-1]) == 2:
        return parts[-3]
    return parts[-2] if len(parts) >= 2 else h


def names(name, title):
    """The title names the organisation as a word, or as two joined words ("GL.iNet" for gl-inet.com)."""
    if len(name) < 3:
        return False
    w = re.findall(r"[a-z0-9]+", title.lower())
    return name in w or name in {a + b for a, b in zip(w, w[1:])}


def first_party(h, title):
    """The link is the affected organisation's own page (or its formal filing), not someone writing about it."""
    if any(h == f or h.endswith("." + f) for f in FILINGS):
        return True
    if any(h == d or h.endswith("." + d) for d in NOT_OWN):
        return False
    if names(re.sub(r"[^a-z0-9]", "", brand(h)), title):
        return True
    return bool(DISCLOSURE_TITLE.search(title)) and (h.split(".")[0] in OWN_PAGE or h.count(".") == 1)


def collect(now, get, errors, hours=36):
    since = int(now.timestamp()) - hours * 3600

    def fetch(q):
        url = API + urllib.parse.urlencode({"query": q, "tags": "story", "restrictSearchableAttributes": "title",
                                            "numericFilters": f"created_at_i>{since}", "hitsPerPage": 100})
        try:
            return json.loads(get(url, 20))["hits"], None
        except Exception as e:
            return [], f"hn {q}: {e}"

    with ThreadPoolExecutor(max_workers=5) as pool:
        results = list(pool.map(fetch, QUERIES))
    out, seen = [], set()
    for hits, err in results:
        if err:
            errors.append(err)
        for h in hits:
            title, url = (h.get("title") or "").strip(), (h.get("url") or "").strip()
            if not url or h["objectID"] in seen:
                continue
            seen.add(h["objectID"])
            if (h.get("points") or 0) < MIN_POINTS or not TITLE.search(title) or NOISE.search(title):
                continue
            site = host(url)
            if not site or not first_party(site, title):
                continue
            out.append({"date": h["created_at"][:19] + "Z", "source": site, "title": title, "url": url,
                        "summary": f"Disclosure published on {site} and surfaced on Hacker News.",
                        "via": "Hacker News", "hn": f"https://news.ycombinator.com/item?id={h['objectID']}",
                        "disclosure": True, "lang": "en"})
    out.sort(key=lambda x: x["date"])
    return out


def merge(stories, disclosures):
    """Attach each company's own notice to the press story that names the company, else keep it as its own story.

    Disclosure titles are short and generic ("Security incident in November 2026"), so the press clustering
    would glue them to unrelated headlines; matching on the company name avoids that.
    """
    by_site = {}
    for d in sorted(disclosures, key=lambda d: d["date"]):
        by_site.setdefault(d["source"], d)  # one notice per site: the earliest
    for site, d in by_site.items():
        name = re.sub(r"[^a-z0-9]", "", brand(site))
        o = {"source": site, "url": d["url"], "date": d["date"], "title": d["title"]}
        match = [s for s in stories if names(name, s["title"])]
        if match:
            s = min(match, key=lambda s: s["date"])
            s["outlets"] = [o] + [x for x in s["outlets"] if x["source"] != site][:24]
            s["n_outlets"] = len({x["source"] for x in s["outlets"]})
            s["date"] = min(s["date"], d["date"])  # first seen: when the company said it
            s["disclosure"] = d["url"]
        else:
            stories.append({**d, "latest": d["date"], "outlets": [o], "n_outlets": 1})
    stories.sort(key=lambda s: s["date"], reverse=True)
    return stories
