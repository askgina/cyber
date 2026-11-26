"""Incident registry: one curated record per real-world incident.

pipeline/incidents.json is written by the hourly agent (and by hand). The build attaches every
matching press story and official notice to each record, so a record keeps growing as coverage
arrives, and lists press stories that no record explains yet (the triage queue).
"""
import json, os, re, datetime as dt

def _p(s):
    s = s.replace("Z", "+00:00")
    if len(s) == 10: s += "T00:00:00+00:00"
    d = dt.datetime.fromisoformat(s)
    return d if d.tzinfo else d.replace(tzinfo=dt.timezone.utc)


def _rx(terms):
    parts = []
    for t in terms:
        t = t.strip()
        if not t: continue
        e = re.escape(t)
        # word boundaries for Latin terms only; CJK has no spaces
        parts.append(e if re.search(r"[^\x00-\x7f]", t) else r"(?<![A-Za-z0-9])" + e + r"(?![A-Za-z0-9])")
    return re.compile("|".join(parts), re.I) if parts else None


def _load1(path):
    try:
        with open(path, encoding="utf-8") as stream:
            return json.load(stream)
    except Exception:
        return {"incidents": []}


def load(path, archive_path=None):
    """incidents.json merged with incidents_archive.json (same schema, same folder; missing = empty).
    Deduped by id; records in incidents.json win."""
    reg = _load1(path)
    arch = _load1(archive_path or os.path.join(os.path.dirname(os.path.abspath(path)), "incidents_archive.json"))
    have = {r.get("id") for r in reg.get("incidents", [])}
    extra = [r for r in arch.get("incidents", []) if r.get("id") not in have]
    return dict(reg, incidents=list(reg.get("incidents", [])) + extra)


def attach(reg, news, notices, now, window_days=10):
    """Return (records, unmatched_news). Mutates nothing on disk."""
    recs = []
    claimed = set()
    for r in reg.get("incidents", []):
        rx = _rx(r.get("match") or [r.get("org", "")])
        if rx is None: continue
        t0 = _p(r["first_reported"]) - dt.timedelta(days=2)
        hits, outlets, seen = [], [], set()
        ex = _rx(r.get("exclude") or [])
        ok = lambda t: bool(rx.search(t)) and not (ex and ex.search(t))
        for n in news:
            # judge each outlet on its own headline and date: a mixed cluster must not lend its coverage, or an early stray
            # headline its date, to every incident in it
            own = [o for o in (n.get("outlets") or [{"source": n["source"], "url": n["url"], "date": n["date"], "title": n["title"]}])
                   if ok(o.get("title", "") + " | " + o.get("title_orig", "")) and _p(o["date"]) >= t0]
            lead_matches = ok(n["title"] + " | " + n.get("title_orig", ""))
            if not own and not (lead_matches and _p(n.get("latest", n["date"])) >= t0): continue
            # A mixed cluster can have a lead about a different organisation.
            # Show the matching outlet, not the unrelated lead or its detail link.
            story = n if lead_matches else {
                **min(own, key=lambda o: o["date"]),
                "latest": max(o["date"] for o in own),
                "n_outlets": len({o["source"] for o in own}),
            }
            hits.append(story); claimed.add(n["url"])
            for o in own:
                if o["source"] in seen: continue
                seen.add(o["source"]); outlets.append(o)
        offs = [o for o in notices if rx.search(o.get("org", "") + " " + o.get("title", "")) and _p(o["date"]) >= t0]
        outlets.sort(key=lambda o: o["date"])
        latest = max([n.get("latest", n["date"]) for n in hits] + [u["date"] for u in r.get("updates", [])] + [r["first_reported"]])
        rec = dict(r)
        rec["outlets"] = outlets[:40]
        rec["n_outlets"] = len(outlets)
        rec["stories"] = [{"title": n["title"], "source": n["source"], "url": n["url"], "date": n["date"], "eid": n.get("eid"), "n": n.get("n_outlets", 1)} for n in sorted(hits, key=lambda n: n["date"], reverse=True)[:12]]
        rec["notices"] = offs[:10]
        rec["latest"] = latest
        rec["age_days"] = round((now - _p(r["first_reported"])).total_seconds() / 86400, 2)
        recs.append(rec)
    recs.sort(key=lambda r: r["latest"], reverse=True)
    unmatched = [n for n in news if n["url"] not in claimed]
    return recs, unmatched


def triage_queue(unmatched, now, hours=48):
    """Stories nobody has explained yet, most covered first."""
    q = [n for n in unmatched if (now - _p(n["date"])).total_seconds() <= hours * 3600]
    q.sort(key=lambda n: (-n.get("n_outlets", 1), n["date"]))
    return [{"date": n["date"], "title": n["title"], "source": n["source"], "url": n["url"], "n_outlets": n.get("n_outlets", 1),
             "also": [o["title"] for o in n.get("outlets", [])[1:4]]} for n in q[:200]]
