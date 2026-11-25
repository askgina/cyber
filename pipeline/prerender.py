#!/usr/bin/env python3
"""Build Cyber's public HTML/Markdown pairs and discovery assets from local snapshots.

pipeline/.prerender-state.json is private build state, not part of the publication manifest.
It preserves public identifiers, durable records, the rolling news/X cohort and
retired routes when rows disappear from the much shorter live feed windows.
"""
import argparse
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from email.utils import format_datetime
from hashlib import sha1, sha256
from html import escape
import json
import math
from pathlib import Path
import re
from urllib.parse import quote, unquote, urlsplit
import xml.etree.ElementTree as ET

from enrich import CWE_MAP, DEFILLAMA_MAP, tag
from search_docs import records as search_records

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = "https://cyber.askgina.ai"
HOME = ORIGIN + "/"
SITE_NAME = "Cyber"
DESCRIPTION = "A register of cyber incidents, crypto exploits, breach notices, exploited vulnerabilities and early signals from public sources."
CISA = "https://www.cisa.gov/known-exploited-vulnerabilities-catalog"
SLUG = re.compile(r"[a-z0-9][a-z0-9._-]{1,120}")
CVE = re.compile(r"cve-[0-9]{4}-[0-9]{4,}", re.I)
INVALID_TEXT = re.compile(r"[^\x09\x0a\x0d\x20-\ud7ff\ue000-\ufffd\U00010000-\U0010ffff]")
SITEMAP = "http://www.sitemaps.org/schemas/sitemap/0.9"
ATOM = "http://www.w3.org/2005/Atom"
NAV = {"/": "Terminal", "/leaderboard": "Leaderboard", "/report": "Report", "/method": "Method", "/api": "API"}
SHELL_VIEWS = ("/", "/leaderboard", "/report")
TYPES = {"inc": "Curated incident", "crypto": "Crypto tracker record", "kev": "CISA KEV catalog entry",
         "breach": "Have I Been Pwned listing", "notice": "Official notice", "sec": "SEC filing",
         "news": "News report", "x": "X signal"}
LLMS_INDEXES = ("llms.txt", "incidents/llms.txt", "patterns/llms.txt", "method/llms.txt")
LLMS_FULL = "llms-full.txt"
ASSET_TYPES = {"sitemap.xml": "application/xml", "feed.xml": "application/rss+xml",
               "feed.json": "application/feed+json", "schemamap.xml": "application/xml",
               **dict.fromkeys((*LLMS_INDEXES, LLMS_FULL), "text/markdown")}
AGENCIES = {"california": "California AG", "washington": "Washington AG", "oregon": "Oregon DOJ",
            "hhs": "HHS OCR", "sec": "SEC EDGAR"}
SHARED_NOTICE_AGENCIES = {"HHS OCR", "Oregon DOJ"}
X_HOSTS = {"x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"}
TAXONOMY_DATE = "2026-11-20"  # Revision of the bundled pattern definitions in enrich.py.
METHOD_DATE = "2026-11-25"  # Revision of the method text below.
API_DATE = "2026-11-25"  # Revision of the public API documentation below.


def text(value):
    if type(value) is bool:
        return "Yes" if value else "No"
    if isinstance(value, (list, tuple)):
        return ", ".join(t for v in value if (t := text(v)))
    if type(value) in (int, float):
        return str(value) if type(value) is int or math.isfinite(value) else ""
    return " ".join(INVALID_TEXT.sub("", value).split()) if isinstance(value, str) else ""


def source_url(value):
    if not isinstance(value, str):
        return ""
    value = value.strip()
    if not value or INVALID_TEXT.search(value) or re.search(r"[\x00-\x20\x7f\\]", value):
        return ""
    try:
        parsed = urlsplit(value)
        if parsed.scheme in ("http", "https") and parsed.hostname and parsed.username is None:
            return value
    except ValueError:
        pass
    return ""


def timestamp(value):
    """Keep day-only dates day-only, normalize timestamp inputs to UTC."""
    try:
        if len(value) == 10:
            return date.fromisoformat(value).isoformat()
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return (stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except (TypeError, AttributeError, ValueError, OverflowError):
        return ""


def at_utc(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=timezone.utc)


def latest(*values):
    return max(filter(None, map(timestamp, values)), key=at_utc, default="")


def as_datetime(value):
    return at_utc(value).isoformat().replace("+00:00", "Z")


def h8(value):
    return sha1(value.encode("utf-8")).hexdigest()[:8]


def public_id(value, prefix):
    return value if isinstance(value, str) and value.startswith(prefix + "-") and SLUG.fullmatch(value) else ""


def path_for(slug):
    return "/incidents/" + slug


def identity(*parts):
    return json.dumps(parts, ensure_ascii=False, separators=(",", ":"))


def norm(value):
    t = text(value).casefold()
    return re.sub(r"[^a-z0-9]", "", t) or t


def links(*groups):
    result = {}
    for group in groups:
        for item in group or []:
            if not isinstance(item, dict) or not (url := source_url(item.get("url"))):
                continue
            parsed = urlsplit(url)
            if parsed.hostname in ("x.com", "twitter.com", "www.x.com", "www.twitter.com") and parsed.path == "/search":
                continue  # A search UI is not evidence.
            label = text(item.get("label") or item.get("source"))
            result.setdefault(url, label or parsed.hostname)
    return [[label, url] for url, label in result.items()]


def usd(value):
    if type(value) in (int, float) and (type(value) is int or math.isfinite(value)):
        return f"${value:,.2f}".removesuffix(".00")
    return ""


def scale(value):
    match = re.fullmatch(r"\$([0-9]+(?:\.[0-9]+)?)\s*([KMB]?)", text(value).replace(",", ""), re.I)
    if match:
        amount = float(match[1]) * {"": 1, "K": 1e3, "M": 1e6, "B": 1e9}[match[2].upper()]
        return amount if math.isfinite(amount) else None
    return None


def rows(snapshot, key=None):
    return (snapshot.get(key) or []) if isinstance(snapshot, dict) else (snapshot or [])


def read_json(path, default=None):
    if default is not None and not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def archive_org(value):
    name = text(value)
    # Match archive.py's serialized 90-character organization field, including its ellipsis.
    return name if len(name) <= 90 else name[:89].rstrip() + "…"


def notice_identity(kind, agency, day, url, org):
    # SHA-1 over compact UTF-8 JSON: [kind, agency, UTC reporting/filing day, source URL].
    # For HHS/Oregon append the archive-format organization, since their URLs are shared.
    # Washington's fallback list URL is shared too; disambiguate those rows by organization.
    shared = agency in SHARED_NOTICE_AGENCIES or urlsplit(url).path == "/data-breach-notifications"
    return identity(kind, agency, day, url, *([archive_org(org)] if shared else []))


def notice_indexable(row):
    agency = row.get("source")
    summary = text(row.get("summary"))
    breach_date = timestamp(row.get("breach_date")) or re.search(r"\bBreach dates?(?:\(s\))?:\s*\d", summary, re.I)
    count = row.get("count") or row.get("scale")
    if row.get("kind") == "sec":
        return True  # An accession-specific filing, not a reconstruction of the incident.
    if agency in ("California AG", "Oregon DOJ"):
        return bool(breach_date or count)
    if agency == "Washington AG":
        return bool(breach_date or count or re.search(r"\b(?:Data:\s*\S|Washington residents affected)", summary))
    if agency == "HHS OCR":
        return bool(count and re.search(r"\blocation:\s*\S|\b(?:Hacking/IT Incident|Unauthorized Access/Disclosure|Theft|Loss|Improper Disposal|Other)\b", summary, re.I))
    return False


def news_indexable(row, attached):
    url = source_url(row.get("url"))
    summary, title = (str(row.get(k) or "").strip() for k in ("summary", "title"))
    return bool(url and urlsplit(url).hostname != "news.google.com" and title and len(summary) >= 120
                and summary.casefold() != title.casefold() and not row.get("crypto") and row.get("eid") not in attached)


def status_url(value):
    url = source_url(value)
    if not url:
        return False
    parsed = urlsplit(url)
    return parsed.hostname in X_HOSTS and bool(re.search(r"/(?:status|statuses)/[0-9]+(?:/|$)", parsed.path))


def signal_indexable(row):
    return (row.get("stage") in ("Confirmed", "Post-mortem") and len(str(row.get("claim") or "").strip()) >= 120
            and any(status_url(link.get("url")) for link in [row, *(row.get("posts") or []), *(row.get("links") or [])])
            and not any(match.get("kind") in ("crypto", "breach", "kev") for match in row.get("matches") or []))


def archive_payload(a):
    return {"title": a.get("t"), "org": a.get("o"), "date": a.get("d"), "url": a.get("u"),
            "summary": a.get("x"), "scale": a.get("s"), "eid": a.get("eid"),
            "latest": a.get("latest"), "patterns": a.get("patterns"), "kind": a.get("k")}


def normalize(kind, row, archive=False, *, live_id="", index=True):
    """Carry explicit source claims, dates and facts; don't render aggregate or relative fields."""
    title = text(row.get("title"))
    org = text(row.get("org"))
    summary = text(row.get("summary"))
    published = timestamp(row.get("date"))
    ref = ""
    sources = links(row.get("links"), [{"label": row.get("source"), "url": row.get("url")}])
    facts = []
    updates = []
    tagged = []
    uncertainty = ""
    amount = None
    category = ""
    date_label = "Record date"

    if kind == "inc":
        slug = public_id("r-" + text(row.get("id")), "r") if text(row.get("id")) else ""
        key = identity(kind, slug)
        title = title or org
        published = timestamp(row.get("first_reported")) or published
        date_label = "First reported"
        sources = links(row.get("sources"), [{"url": row.get("url")}],
                        [{"label": "Update source", "url": u.get("url")} for u in row.get("updates") or []])
        updates = sorted([stamp, t] for u in row.get("updates") or []
                         if (stamp := timestamp(u.get("date"))) and (t := text(u.get("text"))))
        facts = [("Incident type", row.get("type")), ("Sector", row.get("sector")), ("Country", row.get("country")),
                 ("Reported status", row.get("status")), ("Incident date", timestamp(row.get("event_date"))),
                 ("Reported records affected", row.get("records")), ("Reported loss", usd(row.get("usd"))),
                 ("Attributed actor", row.get("actor")), ("Affected", row.get("affected"))]
        uncertainty = "This record reflects the cited reports and may be revised as more evidence becomes available."
        if not summary and not live_id and not (archive and row.get("scale")):
            return None
    elif kind == "crypto":
        org = text(row.get("name")) or org
        title = title or (f"{org}: reported crypto exploit" if org else "")
        if not org or not published:
            return None
        key = identity(kind, norm(org), published[:10])
        ref = public_id(row.get("eid"), "c") or "c-" + h8((row.get("name") or row.get("org")) + published[:10])
        slug = ref
        date_label = "Tracker incident date"
        amount = scale(row.get("scale")) if archive else row.get("amount")
        if type(amount) not in (int, float) or (type(amount) is float and not math.isfinite(amount)):
            amount = None
        parts = [p.strip() for p in summary.split("·")] if archive else []
        category = text(row.get("classification")) or (parts[1] if len(parts) > 1 and parts[0] != "SlowMist" else "")
        technique = text(row.get("technique")) or (parts[0] if parts and parts[0] != "SlowMist" else "")
        summary = text(row.get("desc")) or summary
        facts = [("Reported loss", row.get("scale") if archive else usd(amount)),
                 ("Reported returns", usd(row.get("returned"))), ("Tracker classification", category),
                 ("Reported technique", technique), ("Chains", row.get("chains")), ("Target type", row.get("target"))]
        tagged = [DEFILLAMA_MAP.get(category)]
        uncertainty = "Tracker figures are reported estimates and may be revised. A listing is not an independent verification."
    elif kind == "kev":
        cve = next((v for s in (row.get("id"), row.get("scale"), row.get("url"), title, summary)
                    if (v := CVE.search(text(s)))), None)
        ref = public_id(row.get("eid"), "k")
        key = identity(kind, cve[0].upper() if cve else ref)
        title = (f"{cve[0].upper()}: {title or text(row.get('name')) or org}" if cve
                 else title or text(row.get("name")))
        if cve:
            sources = links([{"label": "CISA KEV", "url": CISA + "?search_api_fulltext=" + cve[0].upper()}],
                            [{"label": "NVD", "url": "https://nvd.nist.gov/vuln/detail/" + cve[0].upper()}],
                            [{"label": label, "url": url} for label, url in sources])
            ref = ref or "k-" + h8(cve[0].upper())
        slug = ref
        published = timestamp(row.get("added")) or published
        date_label = "Date added to CISA KEV"
        cwes = row.get("cwes") or re.findall(r"CWE-\d+", summary)
        facts = [("CVE", cve[0].upper() if cve else ""), ("Vendor", row.get("vendor")), ("Product", row.get("product")),
                 ("Weakness identifiers", cwes), ("CISA remediation due", row.get("due")),
                 ("Ransomware use", "Listed as known" if row.get("ransomware") is True else
                  "Not listed as known" if row.get("ransomware") is False else ""),
                 ("CISA-required action", row.get("action"))]
        tagged = [CWE_MAP[c][0] for c in cwes if c in CWE_MAP]
        summary = text(row.get("desc")) or summary
        uncertainty = "CISA lists the vulnerability as exploited. The catalog addition date is not the date of any individual attack."
    elif kind == "breach":
        name = row.get("name") or ""
        if not name and (url := source_url(row.get("url"))):
            match = re.search(r"/breach/([^/]+)$", urlsplit(url).path, re.I)
            name = unquote(match[1]) if match else ""
        name = name or org
        if not name:
            return None
        key = identity(kind, name.casefold())
        ref = public_id(row.get("eid"), "b") or "b-" + h8(name)
        slug = ref
        title = title if archive else (f"{title or name}: Have I Been Pwned listing")
        org = org or name
        published = timestamp(row.get("added")) or published
        date_label = "Date listed by Have I Been Pwned"
        facts = [("Reported accounts", row.get("scale") if archive else row.get("count")), ("Domain", row.get("domain")),
                 ("Breach date", row.get("breach_date")), ("Data classes listed", row.get("classes")),
                 ("Marked verified by HIBP", row.get("verified"))]
        summary = text(row.get("desc")) or summary
        tagged = ["data-exposure"]
        uncertainty = "Listing date and breach date are distinct. Counts and data classes are as reported by Have I Been Pwned."
    elif kind in ("notice", "sec"):
        url = source_url(row.get("url"))
        if not url or not title or not published:
            return None
        agency = text(row.get("source"))
        key = notice_identity(kind, agency, published[:10], url, org)
        # Coalesced agency rows can inherit another agency's display title. Keep provenance clear.
        if kind == "notice" and org and agency and " reported a data breach to " in title and not title.endswith(agency):
            title = f"{org}: data breach notice ({agency})"
        slug = public_id(row.get("eid"), "sec" if kind == "sec" else "o") or ("sec-" if kind == "sec" else "o-") + h8(key)
        date_label = "Filing date" if kind == "sec" else "Reporting date"
        facts = [("Reporting source", agency), ("Reported affected count", row.get("count") or row.get("scale")),
                 ("Period of report" if kind == "sec" else "Reported breach date", row.get("breach_date"))]
        uncertainty = "The filing date is not necessarily the date of compromise." if kind == "sec" else "The notice date is not necessarily the date of compromise."
    elif kind == "news":
        url = source_url(row.get("url"))
        if not live_id and (not url or not summary or summary.casefold() == title.casefold()):
            return None
        key = identity(kind, live_id or url)
        slug = public_id(row.get("eid"), "n") or "n-" + h8(url)
        date_label = "First reported in this coverage"
        sources = links([{"label": row.get("source"), "url": url}], row.get("outlets"))
        facts = [("Lead outlet", row.get("source")), ("Reported status", row.get("status") or row.get("stage"))]
        uncertainty = "This entry summarizes attributed news coverage, not an independent confirmation."
    elif kind == "x":
        title = text(row.get("subject"))
        summary = text(row.get("claim"))
        published = timestamp(row.get("date")) or timestamp(row.get("first"))
        if not published or (not live_id and (not title or not summary or summary.casefold() == title.casefold())):
            return None
        posts = [{"label": "@" + text(p.get("handle")).lstrip("@") if p.get("handle") else "Original post", "url": p.get("url")}
                 for p in row.get("posts") or []]
        postmortem = row.get("postmortem")
        if isinstance(postmortem, dict):
            postmortem = postmortem.get("url")
        sources = links(posts, row.get("links"), [{"label": "Post-mortem", "url": postmortem}, {"url": row.get("url")}])
        slug = public_id(row.get("eid"), "x") or "x-" + h8(title + published[:10])
        key = identity(kind, slug)
        org = text(row.get("project"))
        date_label = "First signal"
        facts = [("Confidence stage", row.get("stage") or "Unspecified"), ("Recorded outcome", row.get("outcome")),
                 ("Claimed amount", usd(row.get("amount_usd_claimed")))]
        uncertainty = "This is a claim from cited sources. The confidence stage reflects available evidence, not a verdict."
    else:
        return None

    slug = live_id or slug
    if not (SLUG.fullmatch(slug) and published and ((title and sources) or live_id)):
        return None
    title = title or f"{TYPES[kind]}: {org or slug}"
    if row.get("disputed") is True:
        facts.append(("Disputed", True))
    if row.get("uncertainty"):
        facts.append(("Source uncertainty", row["uncertainty"]))
    facts = [[label, t] for label, value in facts if (t := text(value))]
    explicit_tags = row.get("patterns") or []
    patterns = sorted({p for p in explicit_tags if isinstance(p, str) and SLUG.fullmatch(p)})
    if not patterns:
        patterns = sorted(set(tag(" ".join([title, summary, text(row.get("type")), text(row.get("vector")),
                                            *(v for _, v in facts)]), tagged)))
    if not summary:
        context = "; ".join(f"{label.lower()}: {value}" for label, value in facts[:4])
        summary = f"{TYPES[kind]} for {org or title}, dated {published[:10]}" + (f" ({context})." if context else ".")
    modified = latest(published, row.get("latest"), row.get("last") if kind == "x" else None, *(stamp for stamp, _ in updates))
    return {"id": slug, "identity": key, "ref": ref or slug, "type": kind, "title": title, "org": org,
            "summary": summary, "date": published, "lastmod": modified, "date_label": date_label,
            "sources": sources, "facts": facts, "updates": updates, "patterns": patterns,
            "uncertainty": uncertainty, "archive": archive, "amount": amount, "category": category,
            "index": index, "live_id": live_id}


def notice_payload(row, cache):
    payload = archive_payload(row)
    agency, _, summary = text(payload["summary"]).partition(" · ")
    payload.update(source=agency, summary=summary)
    day, url = timestamp(payload["date"]), source_url(payload["url"])
    if day and url:
        key = notice_identity(row["k"], agency, day[:10], url, payload["org"])
        payload.update(cache.get(key, {}))
    return payload


def archive_source_keys(cache_dir):
    notices, names = {}, {}
    for filename, agency in AGENCIES.items():
        kind = "sec" if filename == "sec" else "notice"
        for row in rows(read_json(cache_dir / f"notice_{filename}.json", {}), "rows"):
            day, url = timestamp(row.get("date")), source_url(row.get("url"))
            if day and url:
                key = notice_identity(kind, agency, day[:10], url, row.get("org"))
                notices[key] = {**row, "source": agency, "kind": kind}
    groups = [read_json(path) for path in sorted(cache_dir.glob("defillama_*.json"))]
    groups.append(read_json(cache_dir / "slowmist.json", {}).values())
    for group in groups:
        for row in group:
            day, name = timestamp(row.get("date")), row.get("name")
            if day and name:
                names.setdefault((norm(archive_org(name)), day[:10]), name)
    return notices, names


def collect(data, archive, curated, state, asof, notice_cache=None, crypto_names=None):
    previous = {rec["identity"]: rec for rec in state.get("records", [])}
    records = {}
    retired = dict(state.get("retired", {}))
    aliases = {}
    occupied = {rec["id"]: rec["identity"] for rec in previous.values()}
    routine_cutoff = asof - timedelta(days=90)
    merges = {}
    details = data.get("details") or {}
    live = []
    attached = defaultdict(set)
    archive_refs = defaultdict(set)

    def live_record(kind, row, raw_id, index=True):
        prefix = {"inc": "r", "crypto": "c", "kev": "k", "breach": "b", "news": "n", "x": "x"}[kind]
        live_id = public_id(raw_id, prefix)
        payload = {"patterns": (details.get(live_id) or {}).get("patterns"), **row}
        record = normalize(kind, payload, live_id=live_id, index=index)
        if raw_id and (not live_id or record is None):
            raise ValueError(f"Could not normalize live record {raw_id!r}")
        if record:
            live.append(record)
        return record

    for row in rows(data, "registry"):
        slug = "r-" + row["id"]
        live_record("inc", row, slug)
        for story in row.get("stories") or []:
            if story.get("eid"):
                attached[story["eid"]].add(slug)
    for array, kind in (("crypto", "crypto"), ("kev", "kev"), ("breaches", "breach")):
        for row in rows(data.get(array) or {}, "items"):
            live_record(kind, row, row.get("eid"))
    for kind in ("news", "x"):
        for row in rows(data, kind):
            index = news_indexable(row, attached) if kind == "news" else signal_indexable(row)
            record = live_record(kind, row, row.get("eid"), index=index)
            if record:
                successor = row.get("dup") or row.get("superseded_by")
                if isinstance(successor, str):
                    record["merge"] = successor
                    record["index"] = False
                related = [successor]
                if kind == "news":
                    related += [row.get("crypto"), *sorted(attached.get(row.get("eid"), []))]
                else:
                    related += [match.get("eid") for match in row.get("matches") or []]
                record["related"] = list(dict.fromkeys(v for v in related if isinstance(v, str)))

    live_keys = {}
    for rec in live:
        key, slug = rec["identity"], rec["live_id"]
        if slug:
            if occupied.get(slug, key) != key:
                raise ValueError(f"Live ID collision: {slug}")
            live_keys[key] = slug
            occupied[slug] = key

    def add(record):
        if record is None:
            return None
        key = record["identity"]
        old, prior = previous.get(key), records.get(key)
        # Keep full source context when a previously live row becomes archive-only.
        if old and record["archive"] and not old["archive"] and record["index"] == old["index"] \
                and record["date"][:10] == old["date"][:10] and at_utc(record["lastmod"]) <= at_utc(old["lastmod"]):
            record = old
        if prior and prior["archive"] and not record["archive"]:
            sources = record["sources"] + [link for link in prior["sources"] if link[1] not in {s[1] for s in record["sources"]}]
            record = {**record, "sources": sources}
        slug = live_keys.get(key) or (old["id"] if old else record["id"])
        if occupied.get(slug, key) != key:
            slug = f"{slug[:104]}-{sha256(key.encode()).hexdigest()[:16]}"
            if occupied.get(slug, key) != key:
                raise ValueError(f"Public ID collision: {slug}")
        occupied[slug] = key
        aliases[slug] = key
        ref = record["ref"]
        if occupied.get(ref, key) == key:
            aliases[ref] = key
        if old and old["id"] != slug:
            retired[path_for(old["id"])] = {"status": 301, "location": path_for(slug)}
        records[key] = {**record, "id": slug}
        return records[key]

    for row in rows(archive, "items"):
        kind = row.get("k")
        payload = archive_payload(row)
        if kind == "inc" and row.get("r"):
            rec = normalize(kind, {**payload, **(row.get("rec") or {}), "id": row["r"]}, archive=True)
        elif kind == "crypto":
            day = timestamp(payload["date"])
            original = (crypto_names or {}).get((norm(payload["org"]), day[:10]))
            rec = normalize(kind, {**payload, "name": original}, archive=True)
            if rec and public_id(row.get("dup"), "r"):
                merges[rec["identity"]] = row["dup"]
        elif kind in ("kev", "breach"):
            rec = normalize(kind, payload, archive=True)
        elif kind in ("notice", "sec"):
            payload = notice_payload(row, notice_cache or {})
            rec = normalize(kind, payload, archive=True, index=notice_indexable(payload))
        else:
            continue
        add(rec)
        if rec and kind != "inc":
            for _, day, title, ref, _ in search_records({}, (row,)):
                if day and title and ref.startswith("a:"):
                    archive_refs[ref].add(rec["identity"])

    for row in curated:
        add(normalize("inc", row))
    for record in live:
        add(record)
    for row in rows(data, "notices"):
        if row.get("kind") == "press-attack":
            continue
        kind = "sec" if row.get("kind") == "sec" or row.get("source") == "SEC EDGAR" else "notice"
        day, url = timestamp(row.get("date")), source_url(row.get("url"))
        if not day or not url:
            continue
        payload = {**row, "kind": kind}
        key = notice_identity(kind, row.get("source"), day[:10], url, row.get("org"))
        if key in (notice_cache or {}):
            payload.update(notice_cache[key])
        if key not in records:
            add(normalize(kind, payload, index=notice_indexable(payload)))
    for key, old in previous.items():
        if key not in records:
            add(old)

    # Archive-only explicit merges can redirect. Currently live explorer IDs always get a page.
    for key, rec in list(records.items()):
        successor = merges.get(key) or rec.get("merge")
        if successor:
            dest = records.get(aliases.get(successor.removeprefix("/incidents/")))
            if dest and dest["id"] != rec["id"]:
                location = path_for(dest["id"])
                if key in live_keys:
                    records[key] = {**rec, "index": False, "merge": successor,
                                    "related": list(dict.fromkeys([successor, *rec.get("related", [])]))}
                else:
                    records.pop(key)
                    retired[path_for(rec["id"])] = {"status": 301, "location": location}
    for key, rec in list(records.items()):
        path = path_for(rec["id"])
        if rec["type"] in ("news", "x") and date.fromisoformat(rec["date"][:10]) < routine_cutoff:
            records.pop(key)
            retired.setdefault(path, {"status": 410})
        elif key not in live_keys and retired.get(path, {}).get("status") == 301:
            records.pop(key)  # Durable merges stay merged if the old source row comes back.
        else:
            retired.pop(path, None)
    routes = {rec["id"]: rec for rec in records.values()}
    for r in routes.values():
        related = []
        for alias in r.get("related", []):
            slug = alias.removeprefix("/incidents/")
            dest = records.get(aliases.get(slug))
            if dest and dest["id"] != r["id"]:
                related.append(dest["id"])
        r["related_ids"] = sorted(set(related))
    # Resolve against final active routes, after preferring live IDs and applying merges.
    search_refs = {}
    for ref, identities in archive_refs.items():
        if len(identities) == 1 and (record := records.get(next(iter(identities)))):
            search_refs[ref] = record["id"]
    return sorted(routes.values(), key=lambda rec: rec["id"]), retired, frozenset(live_keys.values()), search_refs


def link(label, href):
    return (label, href)


def absolute(path):
    return ORIGIN + path if path.startswith("/") else path


def new_page(path, kind, title, description, lastmod, sections, **fields):
    return {"path": path, "kind": kind, "title": title, "description": description,
            "lastmod": lastmod, "sections": sections, "index": True, **fields}


def section(title, *blocks, anchor=None):
    return {"title": title, "anchor": anchor, "blocks": blocks}


def record_row(record):
    return (link(record["title"], path_for(record["id"])), record["date"][:10], TYPES[record["type"]])


RECORD_COLUMNS = ("Record", "UTC date", "Source type")


def record_page(record, pattern_labels):
    facts = [(record["date_label"], record["date"])]
    if record["org"]:
        facts.append(("Organization / subject", record["org"]))
    confidence = next((v for k, v in record["facts"] if k == "Confidence stage"), "")
    facts += [(k, v) for k, v in record["facts"] if k != "Confidence stage"]
    if record["lastmod"] != record["date"]:
        facts.append(("Latest recorded update", record["lastmod"]))
    sections = [section("Record details", ("facts", facts)), section("Confidence and scope", ("p", record["uncertainty"]))]
    if record["updates"]:
        sections.append(section("Updates", ("facts", record["updates"])))
    if record["sources"]:
        sections.append(section("Sources", ("list", [link(label, url) for label, url in record["sources"]]), anchor="sources"))
    if record.get("related_ids"):
        sections.append(section("Related records", ("list", [link(f"View {slug}", path_for(slug)) for slug in record["related_ids"]])))
    patterns = [link(pattern_labels[p], "/patterns/" + p) for p in record["patterns"] if p in pattern_labels]
    if patterns:
        sections.append(section("Pattern tags", ("list", patterns)))
    return new_page(path_for(record["id"]), "incident", record["title"], record["summary"], record["lastmod"],
                    sections, record=record, index=record["index"], confidence=confidence)


def collection_pages(records, data, asof):
    groups = defaultdict(list)
    daily = defaultdict(list)
    earliest = (asof - timedelta(days=89)).isoformat()
    today = asof.isoformat()
    for record in records:
        for key in record["patterns"]:
            groups[key].append(record)
        day = record["date"][:10]
        if earliest <= day <= today:
            daily[day].append(record)
    pages = {}
    pattern_labels = {}
    for definition in rows(data, "pattern_defs"):
        key = definition.get("id", "")
        if not SLUG.fullmatch(key) or (key == "unclassified" and not groups[key]):
            continue
        title = text(definition.get("label")) or key
        pattern_labels[key] = title
        members = sorted_records(groups[key])
        described = text(definition.get("description")) or f"Source-linked Cyber records tagged {title}. Pattern tags help group coverage; they do not establish a common cause."
        block = ("table", (RECORD_COLUMNS, [record_row(r) for r in members])) if members else ("p", "No eligible records have this tag in the available snapshots.")
        modified = latest(definition.get("latest"), definition.get("date"), *(r["lastmod"] for r in members)) or TAXONOMY_DATE
        path = "/patterns/" + key
        pages[path] = new_page(path, "pattern", title, described, modified,
                               [section("Tagged records", block)], members=members)
    for day, members in daily.items():
        members = sorted_records(members)
        counts = Counter(r["type"] for r in members)
        description = f"Source-linked Cyber records dated {day} (UTC). A reporting, filing or catalog date does not necessarily identify when an incident occurred."
        sections = [section("Records by source type", ("facts", [(TYPES[k], str(n)) for k, n in sorted(counts.items())])),
                    section("Records", ("table", (RECORD_COLUMNS, [record_row(r) for r in members])))]
        path = "/daily/" + day
        pages[path] = new_page(path, "daily", f"Daily incident snapshot: {day}", description,
                               latest(day, *(r["lastmod"] for r in members)), sections, members=members)
    return pages, pattern_labels


def sorted_records(records):
    return sorted(records, key=lambda r: (at_utc(r["date"]), r["id"]), reverse=True)


def method_page():
    sections = [
        section("Collection and scope",
                ("p", "Cyber is rebuilt hourly from public feeds. The pipeline removes duplicates and recalculates counts for the last 24 hours, seven days and 30 days. An entry records what a source says and how far the claim has been corroborated; it is not a verdict."),
                ("p", "Curated incidents and eligible tracker, catalog, and disclosure records have durable pages. News and X signals have rolling 90-day coverage. Daily snapshots group eligible records by their UTC dates. Thin stubs, dynamic clusters and bare ransomware leak-site claims do not have standalone pages.")),
        section("Confidence stages",
                ("p", "X signals are grouped by incident, not by account. Scoring combines independent evidence. Base weights are 1.0 for an affected party, 0.7 for security firms, 0.65 for investigators, 0.4 for media, 0.2 for aggregators, 0.12 for ordinary users and 0.08 for unverified accounts. Stronger evidence, such as an on-chain reference, can raise a weight. The recorded stage can change as posts, disclosures or database listings arrive."),
                ("facts", [("Rumour", "Only low-weight accounts have reported the claim."),
                           ("Claimed", "At least one credible account or enough independent reports clears the threshold."),
                           ("Corroborated", "Two credible accounts or a combined credibility score of at least 70."),
                           ("Confirmed", "An affected party acknowledges it or a monitored database lists it."),
                           ("Post-mortem", "An affected party or independent investigator published a root-cause account."),
                           ("Unconfirmed", "The signal stayed at Rumour or Claimed for at least 24 hours."),
                           ("Disputed / False alarm", "The affected party denies the claim, or the claim was withdrawn or disproved.")]), anchor="stages"),
        section("Patterns and related records",
                ("p", "Pattern tags use text rules, DefiLlama classifications and CISA weakness codes. Related records are grouped by overlapping text, tags, vendors or chains. Tags and clusters help browse records; neither confirms a shared cause. Editorial analysis may correct automatic tags.")),
        section("Sources", ("list", [link("CISA Known Exploited Vulnerabilities catalog", CISA),
                                     link("DefiLlama hacks dataset", "https://defillama.com/hacks"),
                                     link("SlowMist Hacked", "https://hacked.slowmist.io/"),
                                     link("rekt analyses", "https://rekt.news/leaderboard"),
                                     link("Have I Been Pwned", "https://haveibeenpwned.com/"),
                                     link("ransomware.live leak-site index", "https://www.ransomware.live/"),
                                     link("California Attorney General breach notices", "https://oag.ca.gov/privacy/databreach/list"),
                                     link("HHS Office for Civil Rights breach portal", "https://ocrportal.hhs.gov/ocr/breach/breach_report.jsf"),
                                     link("SEC EDGAR filings", "https://www.sec.gov/edgar/search/"),
                                     link("The Record", "https://therecord.media/"),
                                     link("The Hacker News", "https://thehackernews.com/"),
                                     link("BleepingComputer", "https://www.bleepingcomputer.com/"),
                                     link("DataBreaches.net", "https://databreaches.net/"),
                                     link("Krebs on Security", "https://krebsonsecurity.com/")]),
                ("p", "The report also draws on state attorney general notices and selected posts on X. Individual records link to the sources used."), anchor="sources"),
        section("Other trackers", ("p", "Threat maps show vendor detections, not confirmed incidents, so they are not counted."),
                ("list", [link("Smart Contract Hacking dashboard", "https://smartcontractshacking.com/tools/web3-hacks-dashboard"),
                          link("SEAL 911 (active crypto incidents)", "https://securityalliance.org/"),
                          link("Axis Intelligence breach tracker", "https://axis-intelligence.com/data-breach-tracker/"),
                          link("Kaspersky Cybermap", "https://cybermap.kaspersky.com/"),
                          link("FortiGuard Threat Map", "https://www.fortiguard.com/threat-map"),
                          link("SonicWall Attack Map", "https://attackmap.sonicwall.com/")]), anchor="elsewhere"),
        section("For agents and developers",
                ("p", "Every human page has a machine-readable form. Start with the site guide, then read a page's Markdown twin or the combined corpus. Search and snapshots are public and read-only."),
                ("list", [link("Site guide for agents", "/llms.txt"),
                          link("Incident index", "/incidents/llms.txt"),
                          link("Pattern index", "/patterns/llms.txt"),
                          link("Method index", "/method/llms.txt"),
                          link("Combined corpus", "/llms-full.txt"),
                          link("Search API schema", "/openapi.json"),
                          link("Agent skill", "/.well-known/agent-skills/read-cyber/SKILL.md"),
                          link("RSS feed", "/feed.xml"),
                          link("JSON Feed", "/feed.json"),
                          link("Live JSON snapshot", "/data.json"),
                          link("Archive snapshot", "/archive.json")]), anchor="agents"),
        section("Limitations",
                ("p", "Feeds can lag disclosures and vary in coverage. Losses and affected counts are as reported and can change. Some news records are advisories rather than incident accounts. X coverage uses curated signals and search, not the full feed."),
                ("p", "Ransomware leak-site figures count claims by criminal groups, not independently verified incidents. The report gives group, sector and country aggregates without victim names. A listing, filing, or publication date can differ from the date of compromise."), anchor="limits"),
    ]
    return new_page("/method", "view", "Method and sources", "How Cyber collects, deduplicates and classifies records, scores early signals, and reports uncertainty.", METHOD_DATE, sections)


def api_page():
    endpoints = [
        (link("/api/search?q=", "/api/search"), "Ranked search results over indexed records, at most eight"),
        (link("/data.json", "/data.json"), "Live snapshot: recent records, counts, brief and details"),
        (link("/data-hot.json", "/data-hot.json"), "Compact snapshot for the dashboard; falls back to the live snapshot"),
        (link("/data-details.json", "/data-details.json"), "Expanded details for compact-snapshot records"),
        (link("/data-history.json", "/data-history.json"), "History series for compact-snapshot records"),
        (link("/archive.json", "/archive.json"), "Yearly archive with counts by kind"),
        (link("/openapi.json", "/openapi.json"), "OpenAPI 3.1 description of these endpoints"),
        (link("/.well-known/api-catalog", "/.well-known/api-catalog"), "RFC 9727 linkset pointing at the API and its description"),
    ]
    errors = [
        ("404", "No such API path, or a snapshot part that has not been built"),
        ("405", "A method other than GET, or HEAD for snapshots; Allow names the accepted methods"),
        ("429", "Rate limited; Retry-After gives the wait in seconds"),
        ("502", "The search backend is unavailable; this is not an empty result"),
        ("503", "Storage is unavailable or the build has not produced this part; retry after Retry-After"),
    ]
    sections = [
        section("Endpoints",
                ("p", "Every public endpoint is a read-only GET. There is no key, no sign-up and no write API."),
                ("table", (("Path", "Returns"), endpoints)), anchor="endpoints"),
        section("Search",
                ("p", "GET /api/search?q=terms searches indexed records by meaning. The query is trimmed, whitespace-collapsed and cut to 300 characters; a query shorter than three characters returns an empty list."),
                ("p", "A result carries a title, date, kind, score, a short snippet and, when the record has a public page, a canonical url with scope live or archive. A ref is an internal handle, not a citation: open the record at its published URL before repeating a claim."),
                ("p", "Search caches results for five minutes per normalized query."), anchor="search"),
        section("Rate limits",
                ("p", "Search allows 60 requests per minute per client address, of which at most 10 may be uncached. Every search response carries RateLimit-Limit, RateLimit-Reset and RateLimit-Policy; a refused request answers 429 with Retry-After: 60."),
                ("p", "Snapshots are static objects and are not rate-limited. Prefer conditional requests and the compact snapshot: /data.json is several megabytes."), anchor="limits"),
        section("Errors",
                ("p", 'Errors are JSON. A search error keeps the results key so one shape parses: {"results":[],"error":"rate limited"}. A snapshot error is {"error":"…"}.'),
                ("table", (("Status", "Meaning"), errors)), anchor="errors"),
        section("Conditional requests",
                ("p", "Snapshots return an ETag with Cache-Control: no-cache. Send If-None-Match to revalidate; a matching strong or weak tag returns 304 with no body. Search responses are no-store."), anchor="conditional"),
        section("Versioning",
                ("p", "The public API changes additively: fields may be added, while existing paths and field meanings stay stable, and /openapi.json records the current info.version. A breaking change would ship under a new path, so /api/search keeps its meaning. Retired record pages answer 301 or 410 instead of disappearing."), anchor="versioning"),
        section("Pagination",
                ("p", "Search returns at most eight results in one response. Snapshots are complete documents, not pages: the archive lists items newest first from a start date and offers no cursor. Read a snapshot in full and filter locally instead of walking pages."), anchor="pagination"),
        section("Citing and reuse",
                ("p", "Each record links to the sources it came from; cite the record page and the original source. The compiled data is published under CC BY 4.0 with Ask Gina as the publisher."), anchor="reuse"),
        section("Agent entry points",
                ("list", [link("OpenAPI description", "/openapi.json"),
                          link("API catalog linkset", "/.well-known/api-catalog"),
                          link("Site guide for agents", "/llms.txt"),
                          link("Read Cyber skill", "/.well-known/agent-skills/read-cyber/SKILL.md"),
                          link("Method and sources", "/method")]), anchor="agents"),
    ]
    return new_page("/api", "view", "Public API",
                    "Read and search Cyber's public snapshots: read-only JSON endpoints, search by meaning, conditional requests, rate limits, JSON errors and a versioning policy.",
                    API_DATE, sections)


def core_pages(data, records, generated, collections):
    recent = sorted_records(records)
    asof = at_utc(generated)
    cutoff = asof - timedelta(days=7)
    current = [r for r in recent if at_utc(r["date"]) >= cutoff]
    brief = data.get("brief") or {}
    brief_rows = []
    by_ref = {r["ref"]: r for r in records}
    by_ref.update((r["id"], r) for r in records)
    for item in brief.get("incidents") or []:
        record = by_ref.get(item.get("eid"))
        href = path_for(record["id"]) if record else source_url(item.get("url"))
        org, what = text(item.get("org")), text(item.get("what"))
        if org and what:
            brief_rows.append((link(org, href) if href else org, what, text(item.get("scale")) or "—"))
    latest_day = next(iter(sorted((p for p in collections if p.startswith("/daily/")), reverse=True)), "")
    browse = [link("Incident report", "/report"), link("Crypto leaderboard", "/leaderboard"), link("Method and sources", "/method"),
              link("API docs", "/api"), link("RSS feed", "/feed.xml"),
              link("Live data (JSON)", "/data.json"), link("Archive (JSON)", "/archive.json")]
    if latest_day:
        browse.append(link("Latest daily snapshot", latest_day))
    windows = data.get("windows") or {}
    counts = [(TYPES[k] if k in TYPES else "Ransomware leak-site claims", text(by_window.get("24h", {}).get("n")))
              for k, by_window in (windows.get("rows") or {}).items() if k in TYPES or k == "ransomware"]
    counts = [(name, value) for name, value in counts if value]
    terminal = new_page("/", "view", "Cyber: A daily record of cyber incidents", DESCRIPTION, generated, [
        section("Snapshot", ("facts", [("As of (UTC)", generated)]), ("table", (("Source type", "Last 24 hours"), counts))),
        section("Records dated in the last 24 hours", ("table", (RECORD_COLUMNS,
                [record_row(r) for r in recent if at_utc(r["date"]) >= asof - timedelta(hours=24)][:16]))),
        section("Recent eligible records", ("table", (RECORD_COLUMNS, [record_row(r) for r in recent[:16]]))),
        section("Recent X signals", ("table", ((*RECORD_COLUMNS, "Confidence stage"),
                [(*record_row(r), dict(r["facts"])["Confidence stage"]) for r in recent if r["type"] == "x"][:8]))),
        section("Browse Cyber", ("list", browse)),
    ])
    year = generated[:4]
    ranked = sorted((r for r in records if r["type"] == "crypto" and r["date"].startswith(year)),
                    key=lambda r: (r["amount"] is None, -(r["amount"] or 0), r["org"].casefold(), r["id"]))
    rank_rows = [(str(i) if r["amount"] is not None else "—", link(r["org"], path_for(r["id"])), r["date"][:10],
                  r["category"] or "Unclassified", next((v for k, v in r["facts"] if k == "Reported loss"), "Not reported"))
                 for i, r in enumerate(ranked, 1)]
    board_date = latest(*(r["lastmod"] for r in ranked)) or (year + "-01-01")
    board = new_page("/leaderboard", "view", f"Hacks leaderboard: {year} year to date",
                     "Year-to-date crypto tracker records ranked by reported USD loss. Loss figures can be revised and missing amounts are not treated as zero.",
                     board_date, [section("Year-to-date crypto records", ("table", (("Rank", "Incident", "Date", "Classification", "Reported loss"), rank_rows)))],
                     members=ranked)
    report = [section("Today", ("p", text(brief.get("headline")) or "Recent source-linked records from the current Cyber snapshot."),
                      ("table", (("Organization", "What was reported", "Scale"), brief_rows)), anchor="glance"),
              section("Recent incident records", ("table", (RECORD_COLUMNS, [record_row(r) for r in recent[:24]])), anchor="live")]
    for title, kind, anchor in (("Reported news", "news", "news"), ("Early signals on X", "x", "x-signals"),
                                ("Crypto exploits", "crypto", "crypto"), ("Data breaches", "breach", "breaches"),
                                ("Exploited vulnerabilities", "kev", "exploited"), ("Official notices and filings", "notice", "notices")):
        matches = [r for r in current if r["type"] == kind or (kind == "notice" and r["type"] == "sec")]
        table = ("table", (RECORD_COLUMNS, [record_row(r) for r in matches]))
        if kind == "x":
            table = ("table", ((*RECORD_COLUMNS, "Confidence stage"), [(*record_row(r), dict(r["facts"]).get("Confidence stage", "Unspecified")) for r in matches]))
        report.append(section(title, table, anchor=anchor))
    report.append(section("Patterns", ("table", (("Pattern", "Eligible records"),
                          [(link(p["title"], path), str(len(p["members"]))) for path, p in sorted(collections.items()) if p["kind"] == "pattern"])), anchor="patterns"))
    ransom = data.get("ransomware") or {}
    report.append(section("Ransomware claims", ("p", "Counts describe leak-site claims, not verified attacks."),
                          ("facts", [(s, text(ransom.get(k)) or "Not available") for k, s in (("count_24h", "24 hours"), ("count_7d", "Seven days"), ("count_30d", "30 days"))]),
                          anchor="ransomware"))
    for field, label, anchor in (("groups_7d", "Group", "groups"), ("sectors_7d", "Sector", "sectors"), ("countries_7d", "Country", "countries")):
        report.append(section(label + " counts over seven days", ("table", ((label, "Claims"), [[text(a), text(b)] for a, b in ransom.get(field) or []])), anchor=anchor))
    report.append(section("Citation and data", ("facts", [("Snapshot time (UTC)", generated)]),
                          ("list", [link("Method and sources", "/method"), link("Live snapshot", "/data.json"), link("Archive", "/archive.json")]), anchor="cite"))
    report_page = new_page("/report", "view", "Cyber incident report",
                           "Current reporting, early signals, crypto exploits, ransomware claim counts, breach listings, official notices and CISA KEV additions.",
                           generated, report, members=recent[:24])
    return {p["path"]: p for p in (terminal, board, report_page, method_page(), api_page())}


PUBLISHER = {"@type": "Organization", "@id": HOME + "#organization", "name": "Ask Gina", "url": "https://askgina.ai/",
             # Verified profiles let a reader tie this publisher to one identity.
             "sameAs": ["https://github.com/askgina/cyber", "https://github.com/askgina", "https://askgina.ai/"]}
WEBSITE = {"@type": "WebSite", "@id": HOME + "#website", "name": SITE_NAME, "url": HOME,
           "description": DESCRIPTION, "publisher": {"@id": PUBLISHER["@id"]}}
DATASET = {"@type": "Dataset", "@id": HOME + "#dataset", "name": "Cyber — Daily record of cyber incidents",
           "url": HOME, "description": DESCRIPTION, "license": "https://creativecommons.org/licenses/by/4.0/",
           "publisher": {"@id": PUBLISHER["@id"]}, "isAccessibleForFree": True,
           "distribution": [{"@type": "DataDownload", "contentUrl": ORIGIN + p, "encodingFormat": "application/json"}
                            for p in ("/data.json", "/archive.json")]}


def page_type(page):
    if not page["index"]:
        return "WebPage"
    if page["kind"] == "incident":
        return "TechArticle" if page["record"]["type"] == "kev" else "NewsArticle"
    return "WebPage" if page["path"] in ("/method", "/api") else "CollectionPage"


def breadcrumbs(page):
    return [(SITE_NAME, "/")] + ([(page["title"], page["path"])] if page["path"] != "/" else [])


def json_ld(page):
    url = absolute(page["path"])
    kind = page_type(page)
    entity = {"@type": kind, "@id": url + "#record", "name": page["title"], "url": url,
              "description": page["description"], "dateModified": page["lastmod"],
              "isPartOf": {"@id": WEBSITE["@id"]}, "publisher": {"@id": PUBLISHER["@id"]}}
    if not page["index"]:
        entity.pop("isPartOf")
        entity.pop("publisher")
    elif page["kind"] == "incident":
        r = page["record"]
        sources = [u for _, u in r["sources"]]
        entity.update(headline=r["title"], datePublished=r["date"], isBasedOn=sources, citation=sources,
                      mainEntityOfPage=url, articleSection=TYPES[r["type"]])
    if "members" in page:
        entity["mainEntity"] = {"@type": "ItemList", "@id": url + "#itemlist", "numberOfItems": len(page["members"]),
                                "itemListElement": [{"@type": "ListItem", "position": i, "name": r["title"],
                                                     "url": absolute(path_for(r["id"]))}
                                                    for i, r in enumerate(page["members"], 1)]}
    trail = {"@type": "BreadcrumbList", "@id": url + "#breadcrumb", "itemListElement":
             [{"@type": "ListItem", "position": i, "name": title, "item": absolute(path)}
              for i, (title, path) in enumerate(breadcrumbs(page), 1)]}
    graph = [entity, trail]
    if page["index"]:
        graph += [WEBSITE, PUBLISHER] + ([DATASET] if page["path"] == "/" else [])
    raw = json.dumps({"@context": "https://schema.org", "@graph": graph}, ensure_ascii=False, separators=(",", ":"))
    # Escape closing tags and every other opening delimiter (including HTML comments).
    return re.sub(r"<(/)?", lambda m: r"<\/" if m[1] else r"\u003c", raw)


def file_key(path):
    return path.lstrip("/") or "index"


def metadata(page):
    path = page["path"]
    url = absolute(path)
    title = page["title"]
    if page["kind"] == "incident":
        record = page["record"]
        source = "X signal, " if record["type"] == "x" else ""
        title += f" ({source}{record['date'][:10]})"
    title = escape(title + (" — Cyber" if path != "/" else ""))
    desc = escape(page["description"] if len(page["description"]) <= 200 else page["description"][:197].rsplit(" ", 1)[0] + "…")
    og = "article" if page["kind"] == "incident" and page["index"] else "website"
    robots = '' if page["index"] else '<meta name="robots" content="noindex, follow">\n'
    return f'''<title>{title}</title>
<meta name="description" content="{desc}">
{robots}<link rel="canonical" href="{escape(url)}">
<link rel="alternate" type="text/markdown" href="{ORIGIN}/{file_key(path)}.md">
<meta property="og:type" content="{og}">
<meta property="og:site_name" content="Cyber">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:url" content="{escape(url)}">
<meta property="og:image" content="{ORIGIN}/og-default.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{title}">
<meta name="twitter:description" content="{desc}">
<meta name="twitter:image" content="{ORIGIN}/og-default.png">
<script type="application/ld+json">{json_ld(page)}</script>'''


def cell_html(value, shell=False):
    if isinstance(value, tuple):
        label, href = value
        # Keep the workspace open and bypass its in-app inspector for canonical documents.
        attrs = ' target="_blank" rel="noopener"' if shell and href.startswith("/incidents/") else ""
        return f'<a href="{escape(href)}"{attrs}>{escape(label)}</a>'
    return escape(value)


def table_html(columns, body, shell=False):
    header = "".join(f'<th scope="col">{escape(h)}</th>' for h in columns)
    tr = "".join("<tr>" + "".join(f"<td>{cell_html(v, shell)}</td>" for v in row) + "</tr>" for row in body)
    if not tr:
        tr = f'<tr><td colspan="{len(columns)}">No entries in this snapshot.</td></tr>'
    return f"<thead><tr>{header}</tr></thead><tbody>{tr}</tbody>"


def block_html(block, shell=False):
    kind, value = block
    if kind == "p":
        return f"<p>{escape(value)}</p>"
    if kind == "facts":
        return '<dl class="facts">' + "".join(f"<div><dt>{escape(k)}</dt><dd>{cell_html(v, shell)}</dd></div>" for k, v in value) + "</dl>"
    if kind == "list":
        return '<ul class="sources">' + "".join(f"<li>{cell_html(v, shell)}</li>" for v in value) + "</ul>"
    if kind == "table":
        return '<table class="tbl">' + table_html(*value, shell=shell) + "</table>"
    raise ValueError(f"Unknown block {kind}")


def sections_html(sections, shell=False):
    out = []
    for sec in sections:
        attr = f' id="{escape(sec["anchor"])}"' if sec["anchor"] else ""
        blocks = "\n".join(block_html(b, shell=shell) for b in sec["blocks"])
        out.append(f'<section{attr}>\n<h2>{escape(sec["title"])}</h2>\n{blocks}\n</section>')
    return "\n".join(out)


def nav_html(path):
    return "".join(f'<a href="{href}"' + (' aria-current="page"' if path == href else "") + f'>{label}</a>'
                   for href, label in NAV.items())


def trail_html(page):
    crumb = breadcrumbs(page)
    return '<nav class="breadcrumbs" aria-label="Breadcrumb"><ol>' + "".join(
        f'<li>{cell_html((name, href))}</li>' if i < len(crumb) - 1 else f'<li aria-current="page">{escape(name)}</li>'
        for i, (name, href) in enumerate(crumb)) + "</ol></nav>"


def standalone_html(page):
    confidence = page.get("confidence")
    stage = f'<p><strong>Confidence stage:</strong> {escape(confidence)}</p>\n' if confidence else ''
    return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<script src="/theme-init.js"></script>
<link rel="stylesheet" href="/styles.css">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
{metadata(page)}
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<div class="doc-page">
<header><a href="/">Cyber</a><nav aria-label="Views">{nav_html(page["path"])}</nav></header>
<main id="content" tabindex="-1">
{trail_html(page)}
<h1>{escape(page["title"])}</h1>
{stage}<p>{escape(page["description"])}</p>
{sections_html(page["sections"])}
</main>
<footer><a href="/{file_key(page["path"])}.md">Markdown</a> · <a href="/feed.xml">RSS</a> · <a href="/method">Method and sources</a></footer>
</div>
</body>
</html>
'''


def substitute(template, pattern, value):
    rendered, found = re.subn(pattern, lambda m: value(m), template, count=1, flags=re.S)
    if not found:
        raise ValueError(f"SPA template marker not found: {pattern}")
    return rendered


def fill(template, element_id, content):
    opening = r'(<([\w-]+)\b[^>]*\bid="' + re.escape(element_id) + r'"[^>]*>)'
    return substitute(template, opening + r'[^<]*(</\2>)', lambda m: m[1] + content + m[3])


def shell_html(page, template):
    path = page["path"]
    view, skip = {"/": ("term", "term"), "/leaderboard": ("board", "board"), "/report": ("report", "main")}[path]
    # This content appears in the same visible elements the app replaces after hydration.
    # Preserve the original shell's scripts and IDs, without an executable inline bootstrap.
    head = re.compile(r'<title>.*?</title>|<link\b[^>]*(?:rel="canonical"|type="text/markdown")[^>]*>'
                      r'|<meta\b[^>]*(?:name="(?:description|twitter:[^"]+)"|property="og:[^"]+")[^>]*>'
                      r'|<script type="application/ld\+json">.*?</script>', re.S)
    shell = head.sub("", template)
    shell = substitute(shell, r"</head>", lambda _: metadata(page) + "\n</head>")
    shell = substitute(shell, r"<body(?:\s+class=\"[^\"]*\")?>", lambda _: f'<body class="view-{view}">')
    shell = substitute(shell, r'<a class="skip" href="[^"]*">', lambda _: f'<a class="skip" href="#{skip}">')
    shell = re.sub(r"<noscript>.*?</noscript>\s*", "", shell, count=1, flags=re.S)
    shell = re.sub(r'(<nav class="t-views"[^>]*>).*?</nav>',
                   lambda m: m[1] + nav_html(path) + "</nav>", shell, flags=re.S)
    sections = page["sections"]
    if view == "term":
        shell = fill(shell, "t-kpi", "".join(f'<div class="t-k">{escape(label)} · {escape(value)}</div>'
                     for label, value in sections[0]["blocks"][1][1][1]))
        shell = fill(shell, "t-hit", '<h1>' + escape(page["title"]) + '</h1><p>' + escape(page["description"]) + '</p>'
                     + trail_html(page) + block_html(sections[0]["blocks"][0], shell=True)
                     + block_html(sections[1]["blocks"][0], shell=True))
        shell = fill(shell, "t-feed", block_html(sections[2]["blocks"][0], shell=True))
        shell = fill(shell, "t-x", block_html(sections[3]["blocks"][0], shell=True))
        shell = fill(shell, "t-mkt", sections_html([sections[4]], shell=True))
    elif view == "board":
        shell = substitute(shell, r'<span id="b-h">[^<]*</span>', lambda _: f'<h1 id="b-h">{escape(page["title"])}</h1>')
        shell = fill(shell, "b-kpi", trail_html(page) + f'<p>{escape(page["description"])}</p>')
        shell = fill(shell, "b-tbl", table_html(*sections[0]["blocks"][0][1], shell=True))
    else:
        report = {sec["anchor"]: sec for sec in sections}
        shell = fill(shell, "r-title", escape(page["title"]))
        shell = fill(shell, "asof", escape(page["lastmod"]))
        shell = fill(shell, "abstract", escape(page["description"]))
        shell = substitute(shell, r'(<section class="t-p opening"[^>]*>\s*)', lambda m: m[1] + trail_html(page))
        shell = fill(shell, "g-brief", escape(report["glance"]["blocks"][0][1]))
        shell = fill(shell, "g-hit", table_html(*report["glance"]["blocks"][1][1], shell=True))
        shell = fill(shell, "feed", "".join(f'<li>{cell_html(r[0], shell=True)} · {escape(r[1])} · {escape(r[2])}</li>'
                                           for r in report["live"]["blocks"][0][1][1]))
        shell = fill(shell, "live-status", "Snapshot")
        for anchor, eid in (("news", "news-list"), ("x-signals", "x-list"), ("crypto", "crypto-list"),
                            ("breaches", "breach-list"), ("exploited", "kev-list")):
            shell = fill(shell, eid, block_html(report[anchor]["blocks"][0], shell=True))
        for anchor in ("patterns", "groups", "sectors", "countries"):
            shell = fill(shell, anchor + "-tbl", table_html(*report[anchor]["blocks"][0][1], shell=True))
        shell = fill(shell, "ransom-lede", escape(report["ransomware"]["blocks"][0][1] + " " + " · ".join(
            f"{label}: {value}" for label, value in report["ransomware"]["blocks"][1][1])))
        shell = fill(shell, "cite-block", escape(f"Cyber. Incident report. Snapshot: {page['lastmod']}. {ORIGIN}/report"))
        shell = substitute(shell, r'(<section class="t-p" id="cite">)',
                           lambda m: sections_html([report["notices"]], shell=True) + "\n" + m[1])
    return shell


def md_text(value):
    value = value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return re.sub(r"([\\`*_{}\[\]|~#!])", r"\\\1", value)


def md_cell(value):
    if isinstance(value, tuple):
        label, url = value
        dest = quote(absolute(url), safe=":/?#[]@!$&'()*+,;=%-_.~").replace("(", "%28").replace(")", "%29")
        return f"[{md_text(label)}](<{dest}>)"
    return md_text(value)


def block_md(block):
    kind, value = block
    if kind == "p":
        return md_text(value)
    if kind == "facts":
        return "\n".join(f"- **{md_text(k)}:** {md_cell(v)}" for k, v in value)
    if kind == "list":
        return "\n".join(f"- {md_cell(v)}" for v in value)
    if kind == "table":
        columns, body = value
        if not body:
            return "No entries in this snapshot."
        lines = [columns, ["---"] * len(columns), *body]
        return "\n".join("| " + " | ".join(map(md_cell, row)) + " |" for row in lines)
    raise ValueError(f"Unknown block {kind}")


def markdown(page):
    front = {"title": page["title"], "description": page["description"], "canonical": absolute(page["path"]),
             "lastmod": page["lastmod"], "kind": page["kind"], "index": page["index"]}
    header = "---\n" + "\n".join(f"{k}: {json.dumps(v, ensure_ascii=False)}" for k, v in front.items()) + "\n---"
    blocks = [header, "# " + md_text(page["title"]), md_cell(("HTML version", page["path"])), md_text(page["description"])]
    if page.get("confidence"):
        blocks.insert(3, "**Confidence stage:** " + md_text(page["confidence"]))
    for sec in page["sections"]:
        blocks.append("## " + md_text(sec["title"]))
        blocks += [block_md(block) for block in sec["blocks"]]
    return "\n\n".join(blocks) + "\n"


CORPUS_INCIDENT_FACTS = {
    "First reported", "Tracker incident date", "Date added to CISA KEV", "Date listed by Have I Been Pwned",
    "Reporting date", "Filing date", "First reported in this coverage", "First signal", "Organization / subject",
    "Incident type", "Sector", "Country", "Reported status", "Incident date", "Reported records affected",
    "Reported loss", "Attributed actor", "Affected", "Reported returns", "Tracker classification",
    "Reported technique", "Chains", "Target type", "CVE", "Vendor", "Product", "Weakness identifiers",
    "CISA remediation due", "Ransomware use", "Reported accounts", "Domain", "Breach date", "Data classes listed",
    "Marked verified by HIBP", "Reporting source", "Reported affected count", "Period of report",
    "Reported breach date", "Lead outlet", "Recorded outcome", "Claimed amount", "Disputed", "Source uncertainty",
    "Latest recorded update",
}
CORPUS_INCIDENT_BLOCKS = {
    ("Record details", "facts"), ("Confidence and scope", "p"), ("Updates", "facts"),
    ("Sources", "list"), ("Related records", "list"), ("Pattern tags", "list"),
}


def llms_header(title, summary, generated):
    return f"# {title}\n\n> {summary}\n\nSnapshot (UTC): {generated}. Rebuilt hourly. License: CC BY 4.0."


def llms_link(label, path, detail=""):
    return f"- [{md_text(label)}]({absolute(path)})" + (f": {md_text(detail)}" if detail else "")


def llms_section(title, entries):
    return f"## {title}\n\n" + "\n".join(entries) if entries else ""


def md_path(path):
    return "/" + file_key(path) + ".md"


def public_corpus_blocks(page, pages, scopes):
    """Project only public sections that already render on the selected pages."""
    site_host = urlsplit(ORIGIN).hostname

    def project_cell(value):
        if not isinstance(value, tuple):
            return value
        label, href = value
        parsed = urlsplit(absolute(href))
        if parsed.hostname != site_host:
            return value  # Sources are not Cyber routes.
        path = unquote(parsed.path).rstrip("/") or "/"
        if path in pages:
            label = f"{label} ({scopes[path]})" if path in scopes else label
            return label, md_path(path)
        return value if path in ("/feed.xml", "/data.json", "/archive.json") else label

    for sec in page["sections"]:
        blocks = []
        for kind, value in sec["blocks"]:
            if page["kind"] == "incident" and (sec["title"], kind) not in CORPUS_INCIDENT_BLOCKS:
                continue
            if kind == "facts":
                value = [(label, project_cell(cell)) for label, cell in value
                         if label not in ("As of (UTC)", "Snapshot time (UTC)")
                         and (sec["title"] != "Record details" or label in CORPUS_INCIDENT_FACTS)]
            elif kind == "list":
                value = [project_cell(cell) for cell in value]
            elif kind == "table" and page["kind"] != "incident":
                columns, body = value
                value = (columns, [tuple(project_cell(cell) for cell in row) for row in body])
            elif kind == "p":
                # The combined document already states the cadence once in its header.
                if page["path"] == "/method" and sec["title"] == "Collection and scope":
                    value = value.removeprefix("Cyber is rebuilt hourly from public feeds. ")
            else:
                continue
            if value:
                blocks.append(block_md((kind, value)))
        if blocks:
            yield f"### {md_text(sec['title'])}\n\n" + "\n\n".join(blocks)


def llms_assets(pages, scopes, generated):
    # Never serialize normalized records, raw data or private state. Content comes from the
    # rendered title, description, confidence and public sections of indexable pages.
    public = {path: page for path, page in sorted(pages.items()) if page["index"]}
    views = [public[path] for path in NAV if path in public]
    patterns = sorted((p for p in public.values() if p["kind"] == "pattern"), key=lambda p: p["title"].casefold())
    days = sorted((p for p in public.values() if p["kind"] == "daily"), key=lambda p: p["path"], reverse=True)
    incidents = sorted((p for p in public.values() if p["kind"] == "incident"),
                       key=lambda p: (at_utc(p["record"]["date"]), p["path"]), reverse=True)

    def entry(page, detail=""):
        return llms_link(page["title"], md_path(page["path"]), detail)

    def document(*parts):
        return "\n\n".join(filter(None, parts)) + "\n"

    index = document(
        llms_header(SITE_NAME, DESCRIPTION, generated),
        llms_section("Start here", [entry(page) for page in views] + [
            llms_link("Incident index", "/incidents/llms.txt", "Source-backed records by kind, labeled live or archive."),
            llms_link("Pattern index", "/patterns/llms.txt"), llms_link("Method index", "/method/llms.txt")]),
        llms_section("Latest daily snapshots", [entry(page) for page in days[:3]]),
        llms_section("Read programmatically", [
            llms_link("OpenAPI", "/openapi.json"),
            llms_link("Read Cyber skill", "/.well-known/agent-skills/read-cyber/SKILL.md"),
            llms_link("RSS", "/feed.xml"), llms_link("JSON Feed", "/feed.json"),
            llms_link("Live data (JSON)", "/data.json"), llms_link("Archive data (JSON)", "/archive.json"),
            llms_link("Sitemap", "/sitemap.xml")]),
        llms_section("Optional", [llms_link("Consolidated corpus", "/" + LLMS_FULL, "All indexable pages in one document.")]),
    )
    by_kind = defaultdict(list)
    for page in incidents:
        record = page["record"]
        by_kind[record["type"]].append(entry(page, f'{scopes[page["path"]]} · {record["date"][:10]}'))
    incident_index = document(
        llms_header("Cyber incident records", "Source-linked records eligible for indexing. Live means the record is present in the current snapshot; archive means it is not.", generated),
        *(llms_section(label + "s", by_kind[kind]) for kind, label in TYPES.items()),
    )
    pattern_index = document(llms_header("Cyber patterns", "Defined pattern tags and their source-linked records.", generated),
                             llms_section("Patterns", [entry(page) for page in patterns]))
    method_index = document(llms_header("Cyber method", "How the ledger collects records and describes evidence and uncertainty.", generated),
                            llms_section("Method and scope", [entry(public["/method"], public["/method"]["description"])]))

    corpus = [llms_header("Cyber — consolidated public corpus", DESCRIPTION, generated)]
    for page in (*views, *patterns, *days, *incidents):
        path = page["path"]
        heading = f"## {md_text(page['title'])}"
        label = f"Markdown · {scopes[path]}" if path in scopes else "Markdown"
        corpus.append(heading + "\n\n" + llms_link(label, md_path(path)))
        if path != "/":  # Already present as the document summary.
            corpus.append(md_text(page["description"]))
        if page.get("confidence"):
            corpus.append(f"**Confidence stage:** {md_text(page['confidence'])}")
        corpus.extend(public_corpus_blocks(page, public, scopes))
    return dict(zip((*LLMS_INDEXES, LLMS_FULL), (index, incident_index, pattern_index, method_index, document(*corpus))))


def xml_string(root):
    ET.indent(root, space="  ")
    return ET.tostring(root, encoding="utf-8", xml_declaration=True).decode("utf-8") + "\n"


def child(element, tag_name, value, **attrs):
    ET.SubElement(element, tag_name, attrs).text = value


def rss_html_text(value):
    # RSS readers commonly treat description as HTML, in addition to the XML decoding layer.
    return escape(value, quote=False)


def discovery(pages, recent, generated):
    ET.register_namespace("atom", ATOM)
    pages = {path: page for path, page in pages.items() if page["index"]}
    urlset = ET.Element("urlset", {"xmlns": SITEMAP})
    for path, page in sorted(pages.items()):
        u = ET.SubElement(urlset, "url")
        child(u, "loc", absolute(path))
        child(u, "lastmod", page["lastmod"])
    rss = ET.Element("rss", version="2.0")
    channel = ET.SubElement(rss, "channel")
    child(channel, "title", SITE_NAME + " — Cyber incidents")
    child(channel, "link", HOME)
    child(channel, "description", DESCRIPTION)
    child(channel, "language", "en")
    child(channel, "lastBuildDate", format_datetime(at_utc(generated), usegmt=True))
    ET.SubElement(channel, f"{{{ATOM}}}link", href=ORIGIN + "/feed.xml", rel="self", type="application/rss+xml")
    feed = {"version": "https://jsonfeed.org/version/1.1", "title": SITE_NAME + " — Cyber incidents",
            "home_page_url": HOME, "feed_url": ORIGIN + "/feed.json", "description": DESCRIPTION,
            "language": "en", "items": []}
    for r in recent:
        kind = TYPES[r["type"]]
        url = absolute(path_for(r["id"]))
        description = f"{r['summary']} {r['uncertainty']}"
        for label, value in r["facts"]:
            if label in ("Confidence stage", "Disputed", "Source uncertainty", "Reported status", "Recorded outcome"):
                description += f" {label}: {value}."
        item = ET.SubElement(channel, "item")
        child(item, "title", r["title"])
        child(item, "link", url)
        child(item, "guid", url, isPermaLink="true")
        child(item, "pubDate", format_datetime(at_utc(r["date"]), usegmt=True))
        child(item, "category", kind)
        child(item, "description", rss_html_text(description))
        feed["items"].append({"id": url, "url": url, "title": r["title"], "content_text": description,
                              "date_published": as_datetime(r["date"]), "date_modified": as_datetime(r["lastmod"]),
                              "tags": [kind]})
    schemamap = ET.Element("schemamap")

    def schema_entry(kind, url, modified, entity_id):
        entity = ET.SubElement(schemamap, "entity", type=kind)
        child(entity, "loc", url)
        child(entity, "id", entity_id)
        child(entity, "lastmod", modified)

    for entity in (WEBSITE, PUBLISHER, DATASET):
        schema_entry(entity["@type"], HOME, pages["/"]["lastmod"], entity["@id"])
    for path, page in sorted(pages.items()):
        if page_type(page) == "CollectionPage":
            schema_entry("CollectionPage", absolute(path), page["lastmod"], absolute(path) + "#record")
    for record in recent:
        url = absolute(path_for(record["id"]))
        schema_entry("TechArticle" if record["type"] == "kev" else "NewsArticle", url, record["lastmod"], url + "#record")
    outputs = {"sitemap.xml": xml_string(urlset), "feed.xml": xml_string(rss),
               "feed.json": json_string(feed), "schemamap.xml": xml_string(schemamap)}
    for asset, content in outputs.items():
        if asset.endswith(".xml"):
            ET.fromstring(content)
        else:
            json.loads(content)
    return outputs


def json_string(value):
    return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n"


def write(path, content):
    path.parent.mkdir(exist_ok=True, parents=True)
    data = content.encode("utf-8")
    path.write_bytes(data)
    return sha256(data).hexdigest()


def build(root, write_static_baselines=False):
    site, out = root / "site", root / "pages"
    data, archive = read_json(site / "data.json"), read_json(site / "archive.json")
    generated = timestamp(data.get("generated")) or timestamp(archive.get("generated"))
    if not generated:
        raise ValueError("Missing valid snapshot generation date in site/data.json and site/archive.json")
    asof = at_utc(generated).date()
    state_path = root / "pipeline" / ".prerender-state.json"
    state = read_json(state_path, {})
    curated = []
    for name in ("incidents_archive", "incidents"):
        curated += rows(read_json(root / "pipeline" / (name + ".json"), []), "incidents")
    notice_cache, crypto_names = archive_source_keys(root / "pipeline" / "archive_cache")
    records, retired, live_ids, search_refs = collect(data, archive, curated, state, asof, notice_cache, crypto_names)
    eligible = [record for record in records if record["index"]]
    pages, pattern_labels = collection_pages(eligible, data, asof)
    for path in state.get("daily", []):
        if path not in pages and path < "/daily/" + (asof - timedelta(days=89)).isoformat():
            retired[path] = {"status": 410}
    pages.update(core_pages(data, eligible, generated, pages))
    scopes = {}
    for record in records:
        page = record_page(record, pattern_labels)
        pages[page["path"]] = page
        scopes[page["path"]] = "live" if record["id"] in live_ids else "archive"
    for path in pages:
        retired.pop(path, None)
    assets = discovery(pages, sorted_records(eligible)[:100], generated)
    assets.update(llms_assets(pages, scopes, generated))
    refs = json_string(search_refs)
    json.loads(refs)
    template = (site / "index.html").read_text(encoding="utf-8")
    manifest = {"version": 1, "generated": generated, "routes": {}, "assets": {}, "retired": retired, "internal": {}}
    manifest_path = out / "manifest.json"
    previous_manifest = read_json(manifest_path, {})
    manifest_path.unlink(missing_ok=True)
    for path, page in sorted(pages.items()):
        key = file_key(path)
        html_key, md_key = key + ".html", key + ".md"
        html = shell_html(page, template) if path in ("/", "/leaderboard", "/report") else standalone_html(page)
        md = markdown(page)
        manifest["routes"][path] = {"html": html_key, "md": md_key, "html_sha": write(out / html_key, html),
                                    "md_sha": write(out / md_key, md), "lastmod": page["lastmod"], "kind": page["kind"],
                                    "index": page["index"]}
        if path in scopes:
            manifest["routes"][path]["scope"] = scopes[path]
        if write_static_baselines and path in NAV:
            write(site / md_key, md)
            # Standalone core pages also ship as static assets so the route answers before the
            # first build publishes a manifest entry. "/" and the shell views keep their template.
            if path not in SHELL_VIEWS:
                write(site / html_key, html)
    for key, content in assets.items():
        manifest["assets"]["/" + key] = {"key": key, "sha": write(out / key, content), "type": ASSET_TYPES[key] + "; charset=utf-8"}
        if write_static_baselines and key != LLMS_FULL:
            write(site / key, content)
    refs_key = "search-refs.json"
    manifest["internal"]["search_refs"] = {"key": refs_key, "sha": write(out / refs_key, refs)}
    # Only remove files previously generated under the expected layout, never arbitrary state paths.
    for path in previous_manifest.get("routes", {}).keys() - pages.keys():
        if re.fullmatch(r"/(?:incidents|daily|patterns)/[a-z0-9][a-z0-9._-]{1,120}", path):
            for suffix in (".html", ".md"):
                (out / (file_key(path) + suffix)).unlink(missing_ok=True)
    content = json_string(manifest)
    json.loads(content)
    state_content = json_string({"records": records, "retired": retired,
                                 "daily": sorted(p for p in pages if p.startswith("/daily/"))})
    json.loads(state_content)
    staged_state, staged_manifest = state_path.with_suffix(".tmp"), out / ".manifest.tmp"
    write(staged_state, state_content)
    write(staged_manifest, content)
    staged_state.replace(state_path)
    staged_manifest.replace(manifest_path)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write-static-baselines", action="store_true", help="copy feeds, maps, agent indexes and core Markdown to site/")
    args = parser.parse_args()
    manifest = build(ROOT, args.write_static_baselines)
    counts = Counter(item["kind"] for item in manifest["routes"].values())
    breakdown = ", ".join(f"{count} {kind}" for kind, count in sorted(counts.items()))
    print(f"prerender: {len(manifest['routes'])} HTML/Markdown pairs ({breakdown}), "
          f"{len(manifest['assets'])} assets, {len(manifest['retired'])} retired routes")


if __name__ == "__main__":
    main()
