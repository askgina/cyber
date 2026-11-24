#!/usr/bin/env python3
"""Search documents for Cloudflare AI Search: one Markdown file per record type per day.

Reads site/data.json and site/archive.json (written by build_data.py) and writes search_docs/<kind>/<YYYY-MM-DD>.md
plus search_docs/manifest.json ({key: sha256}). Daily files keep hourly changes small: only files whose content
changed are uploaded and re-indexed. Each record is a "# heading" section followed by a "Record: <ref>" line, which
the page uses to open that exact record.
"""
import collections, hashlib, json, os, shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "search_docs")
NEWS_LIMIT = 1500


def records(D, A):
    """(kind, day, title, ref, body). ref is the record's id on the page (#e-<id>); archive rows without a stable id
    get "a:<type>|<date>|<name>", which the page resolves once the archive is loaded."""
    for a in A:
        k = a["k"]
        if k == "inc" and a.get("rec"):
            r = a["rec"]
            lines = [f"Organisation: {r.get('org')}. Type: {r.get('type')}. Sector: {r.get('sector')}. Country: {r.get('country')}. Status: {r.get('status')}. First reported: {(r.get('first_reported') or '')[:10]}.",
                     r.get("summary") or ""]
            if r.get("vector"): lines.append("How they got in: " + r["vector"])
            if r.get("affected"): lines.append("Affected: " + " ".join(r["affected"]))
            if r.get("guidance"): lines.append("What to do: " + " ".join(r["guidance"]))
            lines += [f"Update {u['date'][:10]}: {u['text']}" for u in r.get("updates") or []]
            lines.append("Sources: " + "; ".join(f"{s.get('label')} <{s.get('url')}>" for s in r.get("sources") or []))
            yield "incident", (r.get("first_reported") or a["d"])[:10], r.get("title") or r.get("org"), "r-" + (a.get("r") or r.get("id")), "\n".join(l for l in lines if l)
        elif k in ("crypto", "kev", "breach", "notice", "sec"):
            ref = f"a:{k}|{a['d']}|{a['o']}|{a.get('t') or ''}|{a.get('u') or ''}"  # unique: same-day records can share a name
            yield k, a["d"][:10], f"{a['o']}: {a.get('t', '')}", ref, f"{a.get('t', '')}\n{a.get('x', '')}\nDate: {a['d'][:10]}. Source: {a.get('u', '')}"
    for x in D.get("x") or []:
        posts = "\n".join(f"- {p.get('url')} ({p.get('role')}, {p.get('stance')}): {p.get('note', '')}" for p in x.get("posts") or [])
        yield "x-signal", (x.get("date") or "")[:10], x.get("subject") or x.get("project"), x.get("eid"), f"{x.get('claim', '')}\nStage: {x.get('stage')}. Credibility: {x.get('score')}/100.\n{posts}"
    for n in (D.get("news") or [])[:NEWS_LIMIT]:
        yield "news", n["date"][:10], n["title"], n.get("eid"), f"{n.get('summary', '')}\nOutlet: {n.get('source')}. {n.get('url')}"


def main():
    D = json.load(open(os.path.join(ROOT, "site", "data.json")))
    A = json.load(open(os.path.join(ROOT, "site", "archive.json")))["items"]
    groups = collections.defaultdict(list)
    for kind, day, title, ref, body in records(D, A):
        if day and title:
            groups[(kind, day)].append(f"# {title.strip()}\n\nRecord: {ref or ''}\n\n{body.strip()}")
    shutil.rmtree(OUT, ignore_errors=True)
    manifest = {}
    for (kind, day), items in sorted(groups.items()):
        key = f"{kind}/{day}.md"
        text = f"---\nkind: {kind}\ndate: {day}\n---\n\n" + "\n\n".join(sorted(items)) + "\n"
        path = os.path.join(OUT, key)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        open(path, "w").write(text)
        manifest[key] = hashlib.sha256(text.encode()).hexdigest()
    json.dump(manifest, open(os.path.join(OUT, "manifest.json"), "w"), indent=0, sort_keys=True)
    print(f"search_docs: {len(manifest)} files")


if __name__ == "__main__":
    main()
