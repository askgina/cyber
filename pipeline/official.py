#!/usr/bin/env python3
"""Official breach / incident notices from free public sources (no API keys).

collect(now, get, errors) -> list[dict] with keys:
  date, org, source, url, title, summary, count, breach_date, kind
Every source is isolated in its own try/except; failures are appended to `errors`
as "official <name>: <reason>" and collection continues.

Sources
  - California AG (oag.ca.gov)          kind=notice  (CA does not publish counts)
  - Washington AG (atg.wa.gov)          kind=notice  (WA publishes WA-resident counts only -> summary, count=None)
  - Oregon DOJ (justice.oregon.gov)     kind=notice  ("Number Affected" column -> count)
  - HHS OCR breach portal (CSV export)  kind=notice  (healthcare, 500+ people; JSF form POST)
  - SEC EDGAR 8-K / 8-K/A Item 1.05     kind=notice  (EDGAR full-text search, filtered on items=1.05)
  - ransomware.live recentcyberattacks  kind=press-attack (press-reported attacks; one call)
  - Maine AG: public database offline since autumn 2026 (AG notice cites abuse); probed, logs an error.
"""
import csv, html, io, json, re, time, uuid, urllib.parse, urllib.request, http.cookiejar
import datetime as dt

WINDOW_DAYS = 14
SEC_UA = {"User-Agent": "BreachLedger research ash@askgina.ai"}
UA = {"User-Agent": "Mozilla/5.0 (BreachLedger; +research)"}


def _clean(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()


def _mdy(s):
    """Parse M/D/YYYY (or M/D/YY) -> aware UTC datetime, else None."""
    m = re.search(r"(\d{1,2})/(\d{1,2})/(\d{2,4})", s or "")
    if not m: return None
    mo, d, y = map(int, m.groups())
    if y < 100: y += 2000
    try: return dt.datetime(y, mo, d, tzinfo=dt.timezone.utc)
    except ValueError: return None


def _iso(d): return d.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
def _day(d): return d.strftime("%Y-%m-%d") if d else None
def _int(s):
    s = re.sub(r"[,\s]", "", s or "")
    return int(s) if s.isdigit() else None
def _norm(n): return re.sub(r"[^a-z0-9]", "", re.sub(r"\(.*?\)", "", (n or "").lower()))
def _fmt(n): return f"{n:,}"


def _row(date, org, source, url, title, summary="", count=None, breach_date=None, kind="notice"):
    return {"date": _iso(date), "org": org.strip()[:160], "source": source, "url": url, "title": title,
            "summary": (summary or "")[:280], "count": count, "breach_date": breach_date, "kind": kind}


# ---------------------------------------------------------------- California AG
def california(now, get, cutoff, max_pages=4):
    out = []
    for page in range(max_pages):  # ~50 rows/page, newest first; stop once older than cutoff
        t = get("https://oag.ca.gov/privacy/databreach/list" + (f"?page={page}" if page else ""), 30).decode("utf-8", "replace")
        body = t[t.find("<tbody"):t.find("</tbody>")]
        rows = re.findall(r"<tr.*?</tr>", body, re.S)
        if not rows: break
        oldest = None
        for r in rows:
            a = re.search(r'<a href="([^"]+)"[^>]*>(.*?)</a>', r, re.S)
            rep = re.search(r'views-field-created[^>]*>\s*([\d/]+)', r)
            if not a or not rep: continue
            d = _mdy(rep.group(1)); oldest = d if oldest is None or d < oldest else oldest
            if d < cutoff: continue
            bds = re.findall(r'content="(\d{4}-\d{2}-\d{2})T', r)
            org = _clean(a.group(2)); url = urllib.parse.urljoin("https://oag.ca.gov/", a.group(1))
            summ = ("Breach date(s): " + ", ".join(bds) + ". ") if bds else ""
            out.append(_row(d, org, "California AG", url, f"{org} reported a data breach to the California AG",
                            summ + f"Reported {_day(d)}.", None, bds[0] if bds else None))
        if oldest and oldest < cutoff: break
        time.sleep(0.3)
    return out


# ---------------------------------------------------------------- Washington AG
def washington(now, get, cutoff, max_pages=1):
    out = []
    for page in range(max_pages):  # 50 rows/page, newest first
        t = get("https://www.atg.wa.gov/data-breach-notifications" + (f"?page={page}" if page else ""), 30).decode("utf-8", "replace")
        body = t[t.find("<tbody"):t.find("</tbody>")]
        rows = re.findall(r"<tr.*?</tr>", body, re.S)
        got = _wa_rows(rows, cutoff, out)
        if not rows or got < len(rows): break
        time.sleep(0.3)
    return out


def _wa_rows(rows, cutoff, out):
    n = 0
    for r in rows:
        cells = {m.group(1): m.group(2) for m in re.finditer(r'<td[^>]*views-field-field-([a-z-]+)"[^>]*>(.*?)</td>', r, re.S)}
        rd = re.search(r'datetime="(\d{4}-\d{2}-\d{2})', cells.get("report-date", ""))
        if not rd: continue
        d = dt.datetime.fromisoformat(rd.group(1)).replace(tzinfo=dt.timezone.utc)
        if d < cutoff: continue
        a = re.search(r'<a href="([^"]+)"[^>]*>(.*?)</a>', cells.get("full-title", ""), re.S)
        org = _clean(a.group(2) if a else cells.get("full-title"))
        bd = re.search(r'datetime="(\d{4}-\d{2}-\d{2})', cells.get("start-date", ""))
        wa = _int(_clean(cells.get("number-wa-affected")))
        info = _clean(cells.get("information-compromised"))
        summ = (f"{_fmt(wa)} Washington residents affected. " if wa else "") + (f"Data: {info}" if info else "")
        out.append(_row(d, org, "Washington AG", a.group(1) if a else "https://www.atg.wa.gov/data-breach-notifications",
                        f"{org} reported a data breach to the Washington AG", summ, None, bd.group(1) if bd else None))
        n += 1
    return n


# ---------------------------------------------------------------- Oregon DOJ
def oregon(now, get, cutoff):
    out = []
    t = get("https://justice.oregon.gov/consumer/databreach/", 40).decode("utf-8", "replace")
    body = t[t.find("<tbody"):t.find("</tbody>")]
    for r in re.findall(r"<tr.*?</tr>", body, re.S):
        c = [_clean(x) for x in re.findall(r"<td[^>]*>(.*?)</td>", r, re.S)]
        if len(c) < 6: continue  # Organization, Reported, Breach dates, Discovery, Notice sent, Number affected
        d = _mdy(c[1])
        if not d or d < cutoff: continue
        bd = _mdy(c[2]); n = _int(c[5])
        summ = (f"Breach dates: {c[2]}. " if c[2] else "") + (f"Discovered {c[3]}. " if c[3] else "") + \
               (f"Consumers notified {c[4]}." if c[4] else "")
        out.append(_row(d, c[0], "Oregon DOJ", "https://justice.oregon.gov/consumer/databreach/",
                        f"{c[0]} reported a data breach to the Oregon DOJ", summ, n, _day(bd)))
    return out


# ---------------------------------------------------------------- HHS OCR breach portal
def hhs(now, get, cutoff):
    """JSF app: GET front page -> POST 'View HIPAA Breach Reports' -> POST 'Export as CSV' (session cookie + ViewState)."""
    B = "https://ocrportal.hhs.gov/ocr/breach/"
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def req(url, fields=None):
        data, h = None, dict(UA)
        if fields is not None:
            bd = uuid.uuid4().hex
            data = ("".join(f'--{bd}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n' for k, v in fields.items())
                    + f"--{bd}--\r\n").encode()
            h["Content-Type"] = "multipart/form-data; boundary=" + bd
        with op.open(urllib.request.Request(url, data=data, headers=h), timeout=40) as r:
            return r.read(), r.headers.get("Content-Type", "")
    def form_fields(t):
        form = re.search(r'<form id="ocrForm".*?</form>', t, re.S).group(0)
        f = {}
        for m in re.finditer(r"<input([^>]*)>", form):
            a = m.group(1); n = re.search(r'name="([^"]+)"', a); v = re.search(r'value="([^"]*)"', a)
            ty = re.search(r'type="([^"]+)"', a)
            if n and (not ty or ty.group(1) in ("hidden", "text")): f[n.group(1)] = html.unescape(v.group(1)) if v else ""
        return form, f
    t = req(B + "breach_frontpage.jsf")[0].decode("utf-8", "replace")
    form, f = form_fields(t)
    link = re.search(r"\{'(ocrForm:j_idt\d+)':'[^']+'\},''\);return false\">\s*View HIPAA Breach Reports", form)
    if not link: raise RuntimeError("front page: 'View HIPAA Breach Reports' link not found")
    f[link.group(1)] = link.group(1)
    t = req(B + "breach_frontpage.jsf", f)[0].decode("utf-8", "replace")
    form, f = form_fields(t)
    action = urllib.parse.urljoin(B, re.search(r'<form id="ocrForm"[^>]*action="([^"]+)"', t).group(1))
    exp = re.search(r"\{'(ocrForm:j_idt\d+)':'[^']+'\},''\);return false\"><img[^>]*title=\"Export as CSV\"", form)
    if not exp: raise RuntimeError("report page: CSV export control not found")
    f[exp.group(1)] = exp.group(1)
    data, ctype = req(action, f)
    if "csv" not in ctype: raise RuntimeError(f"export returned {ctype}")
    rows = list(csv.reader(io.StringIO(data.decode("utf-8-sig", "replace"))))
    out = []
    # columns: Name of Covered Entity, State, Covered Entity Type, Individuals Affected, Breach Submission Date,
    #          Type of Breach, Location of Breached Information, Business Associate Present, Web Description
    for r in rows[1:]:
        if len(r) < 7: continue
        d = _mdy(r[4])
        if not d or d < cutoff: continue
        n = _int(r[3])
        summ = f"{r[2]} ({r[1]}). {r[5]}; location: {r[6]}." + (f" {r[8]}" if len(r) > 8 and r[8] else "")
        out.append(_row(d, r[0], "HHS OCR", "https://ocrportal.hhs.gov/ocr/breach/breach_report.jsf",
                        f"{r[0]} reported a health data breach to HHS OCR", summ, n, None))
    hhs.latest = max((_mdy(r[4]) for r in rows[1:] if len(r) > 4 and _mdy(r[4])), default=None)
    return out


# ---------------------------------------------------------------- SEC EDGAR 8-K Item 1.05
def sec(now, get, cutoff):
    def efts(q, form, frm=0):
        u = ("https://efts.sec.gov/LATEST/search-index?" + urllib.parse.urlencode(
            {"q": q, "forms": form, "dateRange": "custom", "startdt": _day(cutoff), "enddt": _day(now), "from": frm}))
        req = urllib.request.Request(u, headers=SEC_UA)
        for attempt in range(2):
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    d = json.loads(r.read())
                if "hits" in d: return d["hits"]["hits"], d["hits"]["total"]["value"]
            except Exception:
                if attempt: raise
            time.sleep(1.0)
        raise RuntimeError(f"bad EFTS response for {q!r} {form}")
    seen, out = set(), []
    # EFTS phrase matching on "Item 1.05" is unreliable, so search broad cyber terms and keep only filings
    # whose structured `items` include 1.05.
    queries = [('"Material Cybersecurity Incidents"', "8-K", 1), ('"cybersecurity incident"', "8-K", 2),
               ("cybersecurity", "8-K", 4), ("cybersecurity", "8-K/A", 2), ('"Item 1.05"', "8-K", 1)]
    for q, form, pages in queries:
        for p in range(pages):
            hits, total = efts(q, form, p * 100)
            for h in hits:
                s = h["_source"]; adsh = s.get("adsh")
                if "1.05" not in (s.get("items") or []) or adsh in seen: continue
                seen.add(adsh)
                d = dt.datetime.fromisoformat(s["file_date"]).replace(tzinfo=dt.timezone.utc)
                name = s["display_names"][0] if s.get("display_names") else "Unknown"
                org = re.sub(r"\s*\(CIK \d+\)\s*$", "", name); org = re.sub(r"\s*\([A-Z0-9.,\- ]+\)\s*$", "", org).strip()
                cik = int((s.get("ciks") or ["0"])[0])
                url = f"https://www.sec.gov/Archives/edgar/data/{cik}/{adsh.replace('-', '')}/{adsh}-index.htm"
                is_a = s.get("form", form).endswith("/A")
                title = (f"{org} filed an amended 8-K/A updating a material cybersecurity incident" if is_a else
                         f"{org} disclosed a material cybersecurity incident in an SEC 8-K (Item 1.05)")
                summ = f"Form {s.get('form', form)} filed {s['file_date']}; items {', '.join(s.get('items') or [])}." + \
                       (f" Period of report {s['period_ending']}." if s.get("period_ending") else "")
                out.append(_row(d, org, "SEC EDGAR", url, title, summ, None, s.get("period_ending")))
            time.sleep(0.25)
            if (p + 1) * 100 >= total: break
    return out


# ---------------------------------------------------------------- ransomware.live press-reported attacks
def ransomware_live(now, get, cutoff):
    data = json.loads(get("https://api.ransomware.live/v2/recentcyberattacks", 40))  # rate-limited: call once
    out = []
    for v in data:
        ds = v.get("date") or v.get("added")
        if not ds: continue
        d = dt.datetime.fromisoformat(ds[:10]).replace(tzinfo=dt.timezone.utc)
        if d < cutoff: continue
        org = (v.get("victim") or v.get("domain") or "").strip()
        if not org: continue
        cc = v.get("country") or ""
        summ = _clean(v.get("summary") or v.get("description") or v.get("title"))
        out.append(_row(d, org, "ransomware.live (press)", v.get("url") or v.get("link"),
                        f"Press report: cyberattack on {org}" + (f" ({cc})" if cc else ""),
                        summ, None, None, "press-attack"))
    return out


# ---------------------------------------------------------------- Maine AG
def maine(now, get, cutoff):
    """Maine's public breach database (apps.web.maine.gov/online/aeviewer/ME/40/list.shtml) returns 404 and the
    agviewer list redirects to an AG page saying the public database is offline. Probe and report."""
    try:
        t = get("https://apps.web.maine.gov/online/aeviewer/ME/40/list.shtml", 20).decode("utf-8", "replace")
    except Exception as e:
        raise RuntimeError(f"public database offline per Maine AG notice ({e})")
    links = re.findall(r'href="([^"]*/aeviewer/ME/40/[0-9a-f-]{36}\.shtml)"[^>]*>(.*?)</a>', t, re.S)
    if not links: raise RuntimeError("list page returned no notice links")
    out = []
    for href, name in links[:40]:  # detail pages carry the date + total persons affected
        u = urllib.parse.urljoin("https://apps.web.maine.gov/online/aeviewer/ME/40/", href)
        s = _clean(get(u, 20).decode("utf-8", "replace"))
        nd = _mdy((re.search(r"Date\(s\) of consumer notification:?\s*([\d/\-]+)", s) or [None, ""])[1])
        if not nd or nd < cutoff: continue
        n = _int((re.search(r"Total number of persons affected \(including residents\):?\s*([\d,]+)", s) or [None, ""])[1])
        bd = _mdy((re.search(r"Date\(s\) Breach Occur+ed:?\s*([\d/\-]+)", s) or [None, ""])[1])
        org = _clean(name)
        out.append(_row(nd, org, "Maine AG", u, f"{org} reported a data breach to the Maine AG", "", n, _day(bd)))
        time.sleep(0.3)
    return out


SOURCES = [("california", california), ("washington", washington), ("oregon", oregon), ("hhs", hhs),
           ("sec", sec), ("ransomware.live", ransomware_live), ("maine", maine)]


def collect(now, get, errors):
    cutoff = (now - dt.timedelta(days=WINDOW_DAYS)).replace(hour=0, minute=0, second=0, microsecond=0)
    rows = []
    collect.stats = {}
    for name, fn in SOURCES:
        t0 = time.time()
        try:
            got = fn(now, get, cutoff)
            rows.extend(got)
            collect.stats[name] = (len(got), round(time.time() - t0, 1))
        except Exception as e:
            errors.append(f"official {name}: {e}")
            collect.stats[name] = (None, round(time.time() - t0, 1))
    # dedupe by (normalised org, day); keep the row with a count, remember the others as extra links
    best = {}
    for r in rows:
        k = (_norm(r["org"]), r["date"][:10])
        if k not in best:
            best[k] = r; continue
        cur = best[k]
        keep, drop = (r, cur) if (r["count"] and not cur["count"]) else (cur, r)
        keep.setdefault("also", []).append({"source": drop["source"], "url": drop["url"]})
        keep["breach_date"] = keep["breach_date"] or drop["breach_date"]
        best[k] = keep
    out = [r for r in best.values() if parse_day(r["date"]) <= now + dt.timedelta(days=1)]
    out.sort(key=lambda r: r["date"], reverse=True)
    return out


def parse_day(s): return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


if __name__ == "__main__":
    def get(url, timeout=60):
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
            return r.read()
    now = dt.datetime.now(dt.timezone.utc)
    errs = []; t0 = time.time()
    rows = collect(now, get, errs)
    print(f"official notices, last {WINDOW_DAYS} days: {len(rows)} rows (after dedupe) in {time.time() - t0:.1f}s")
    for name, (n, secs) in collect.stats.items():
        print(f"  {name:16s} {'FAILED' if n is None else n:>6}  ({secs}s)")
    if getattr(hhs, "latest", None): print(f"  (HHS OCR latest submission date in portal: {_day(hhs.latest)})")
    by_src = {}
    for r in rows: by_src.setdefault(r["source"], []).append(r)
    for src, rs in by_src.items():
        print(f"\n== {src} ({len(rs)})")
        for r in rs[:3]: print("  ", json.dumps(r, ensure_ascii=False)[:400])
    print("\nerrors:", errs)
