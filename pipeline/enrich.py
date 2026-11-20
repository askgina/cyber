"""Attack-pattern tagging, similarity and clustering for Breach Ledger.

Deterministic and dependency-free so it can run every hour. The hourly agent may add
hand-written analysis to pipeline/analysis_notes.json (keyed by incident id); it is merged in.
"""
import re, math, json, os, hashlib
from collections import Counter, defaultdict

# Ordered: earlier patterns win as the "primary" pattern.
PATTERNS = [
    ("key-compromise", "Key and credential compromise",
     r"private key|deployer key|key compromis|key leaked|keys? (were )?(stolen|exposed|leaked)|api key|seed phrase|signing (key|credential)|hot wallet|admin(istrator)? account|privileged account|credential|password|hard.coded|session (token|cookie)|oauth|account takeover|stolen tokens?|mfa|2fa|access token"),
    ("supply-chain", "Supply chain and third parties",
     r"supply.chain|third.party|supplier|service provider|hosting provider|dependency|\bnpm\b|pypi|malicious package|front.?end compromise|frontend|dns hijack|\bdns\b|web3auth|plugin|browser extension|\bsdk\b|managed service|\bmsp\b|n-able"),
    ("bridge", "Bridges and cross-chain",
     r"bridge|cross.chain|relayer|wrapped|multisig|\bbls\b|validator|message spoofing"),
    ("contract-logic", "Smart contract logic flaws",
     r"share accounting|accounting|arithmetic|rounding|logic flaw|protocol logic|reentran|price manipulation|oracle|flash.?loan|unbacked mint|infinite mint|access control|input validation|proof verifier|signature verification|external call|reward logic|governance|malicious proposal|token approval"),
    ("edge-device", "Edge and perimeter devices",
     r"firewall|\bvpn\b|gateway|expressway|sonicwall|fortinet|fortigate|fortios|ivanti|citrix|netscaler|\bf5\b|big-ip|palo alto|pan-os|zyxel|router|\basa\b|edge device|juniper|sophos|wing ftp|cisco|synology|\bnas\b"),
    ("enterprise-platform", "Enterprise platform zero-days",
     r"vcenter|esxi|vmware|\bsap\b|netweaver|exchange server|sharepoint|weblogic|oracle e-business|confluence|jira|active directory|veeam|servicenow|apache|windows|microsoft|redcap|zero.day|0.day"),
    ("injection-rce", "Injection and code execution",
     r"injection|deserializ|remote code|\brce\b|code execution|path traversal|directory traversal|command|arbitrary file|file upload|\bxss\b|cross.site|\bsql\b|ssrf|unsafe reflection|template"),
    ("memory", "Memory corruption",
     r"buffer overflow|use.after.free|out.of.bounds|heap|memory corruption|type confusion|integer overflow|stack overflow"),
    ("phishing", "Phishing and social engineering",
     r"phish|social engineering|impersonat|vishing|lure|malicious link|drainer|address poisoning|help.?desk|scam|fake (app|site|job)"),
    ("ransomware", "Ransomware and extortion",
     r"ransomware|extortion|encrypt(ed|ion)? (files|systems)|leak site|ransom"),
    ("data-exposure", "Data exposure and theft",
     r"exposes (the )?(data|personal|customer)|exposed (the )?(data|records|personal|customer|information)|data leak|leaked (data|records|files)|stole data|steal data|data of|records|customer (info|data)|personal (information|data)|database|misconfigur|data breach|breach notification|\bpii\b|medical"),
    ("ai", "AI systems and agents",
     r"\bai\b|\bllm|gpt|ai agent|agentic|prompt injection|litellm|\bmcp\b|copilot|chatbot|jailbreak|model context"),
    ("state-linked", "State-linked activity",
     r"china.linked|chinese|russia|north korea|lazarus|\biran|\bapt\d*\b|state.sponsored|nation.state|espionage|typhoon|unc\d+|kimsuky|sandworm"),
    ("outage", "Disruption and outages",
     r"outage|disruption|ddos|denial of service|offline|wiper|sabotage"),
]
LABEL = {k: v for k, v, _ in PATTERNS}
RX = [(k, re.compile(r, re.I)) for k, _, r in PATTERNS]

DEFILLAMA_MAP = {
    "Key Compromise": "key-compromise", "Frontend & Infrastructure": "supply-chain",
    "Bridge & Cross-Chain": "bridge", "Protocol Logic": "contract-logic",
    "Token & Share Accounting": "contract-logic", "Oracle Manipulation": "contract-logic",
    "Access Control": "contract-logic", "Input Validation": "contract-logic",
    "Reentrancy": "contract-logic", "Governance": "contract-logic",
    "Market Manipulation": "contract-logic", "Social Engineering": "phishing", "Rugpull": "phishing",
}
CWE_MAP = {
    "CWE-798": ("key-compromise", "Hard-coded credentials"), "CWE-522": ("key-compromise", "Insufficiently protected credentials"),
    "CWE-287": ("key-compromise", "Improper authentication"), "CWE-306": ("key-compromise", "Missing authentication"),
    "CWE-288": ("key-compromise", "Authentication bypass"), "CWE-290": ("key-compromise", "Authentication bypass by spoofing"),
    "CWE-862": ("key-compromise", "Missing authorization"), "CWE-863": ("key-compromise", "Incorrect authorization"),
    "CWE-77": ("injection-rce", "Command injection"), "CWE-78": ("injection-rce", "OS command injection"),
    "CWE-89": ("injection-rce", "SQL injection"), "CWE-94": ("injection-rce", "Code injection"),
    "CWE-502": ("injection-rce", "Deserialization of untrusted data"), "CWE-22": ("injection-rce", "Path traversal"),
    "CWE-434": ("injection-rce", "Unrestricted file upload"), "CWE-918": ("injection-rce", "Server-side request forgery"),
    "CWE-79": ("injection-rce", "Cross-site scripting"), "CWE-20": ("injection-rce", "Improper input validation"),
    "CWE-917": ("injection-rce", "Expression language injection"), "CWE-470": ("injection-rce", "Unsafe reflection"),
    "CWE-116": ("injection-rce", "Improper output encoding"), "CWE-74": ("injection-rce", "Injection"),
    "CWE-787": ("memory", "Out-of-bounds write"), "CWE-416": ("memory", "Use after free"),
    "CWE-125": ("memory", "Out-of-bounds read"), "CWE-119": ("memory", "Memory buffer bounds"),
    "CWE-120": ("memory", "Classic buffer overflow"), "CWE-843": ("memory", "Type confusion"),
    "CWE-190": ("memory", "Integer overflow"), "CWE-122": ("memory", "Heap overflow"), "CWE-121": ("memory", "Stack overflow"),
    "CWE-200": ("data-exposure", "Information exposure"), "CWE-269": ("key-compromise", "Improper privilege management"),
    "CWE-284": ("key-compromise", "Improper access control"), "CWE-352": ("injection-rce", "Cross-site request forgery"),
    "CWE-284 ": ("key-compromise", "Improper access control"),
}

STOP = set("""a an the and or of to in on for by with from at as is are was were be been has have had it its this that
these those after before over into via than then their his her our your they them we you he she not no but which who whom
what when where how also about more most new says said report reports reported reportedly approximately around about
million billion attacker attackers attack attacks hackers hacker vulnerability vulnerabilities flaw flaws security
users user using used use can could may might will would including include includes other such while during between
one two three four five six seven eight nine ten first last across per all any each some many much least nearly
team protocol platform company firm services service data system systems funds november october december
september unknown logic base defi remain remains further involving losses loss financial transferred allows allowed
according investigating investigation incident incidents affected affecting stolen drained exploit exploited exploits
critical patch patches patched issue issues recent recently week today yesterday hours days""".split())

def toks(s):
    out = []
    for w in re.findall(r"[a-z0-9][a-z0-9\-\.]{1,}", (s or "").lower()):
        w = w.strip(".-")
        if len(w) > 2 and w not in STOP and not w.isdigit(): out.append(w)
    return out

def tag(text, extra=()):
    found = [k for k, rx in RX if rx.search(text)]
    for e in extra:
        if e and e not in found: found.insert(0, e)
    # keep order by PATTERNS priority, but extras (authoritative) first
    seen, out = set(), []
    for k in list(extra) + found:
        if k and k not in seen: seen.add(k); out.append(k)
    return out or ["unclassified"]

def iid(prefix, s):
    return prefix + "-" + hashlib.sha1(s.encode()).hexdigest()[:8]

def build_incidents(news, crypto, kev, xsig, breaches=()):
    inc = []
    for n in news:
        text = f"{n['title']}. {n['summary']}"
        inc.append({"id": iid("n", n["url"]), "kind": "news", "date": n["date"], "title": n["title"],
                    "text": n["summary"], "source": n["source"], "url": n["url"], "patterns": tag(text),
                    "entities": [], "_t": text})
    for c in crypto:
        extra = [DEFILLAMA_MAP.get(c.get("classification"))]
        text = f"{c['name']} {c.get('classification') or ''} {c.get('technique') or ''} {c.get('target') or ''} {' '.join(c['chains'])}. {c['desc']}"
        inc.append({"id": iid("c", c["name"] + c["date"]), "kind": "crypto", "date": c["date"], "title": c["name"],
                    "text": c["desc"], "amount": c.get("amount"), "returned": c.get("returned"), "chains": c["chains"],
                    "technique": c.get("technique"), "classification": c.get("classification"), "target": c.get("target"),
                    "language": c.get("language"), "patterns": tag(text, [e for e in extra if e]),
                    "entities": [x.lower() for x in c["chains"]] + [c["name"].lower()], "_t": text})
    for v in kev:
        cwes = v.get("cwes") or []
        extra = [CWE_MAP[c][0] for c in cwes if c in CWE_MAP]
        text = f"{v['vendor']} {v['product']} {v['name']}. {v['desc']}"
        inc.append({"id": iid("k", v["id"]), "kind": "kev", "date": v["date"], "title": f"{v['id']} · {v['vendor']} {v['product']}",
                    "cve": v["id"], "text": v["desc"], "vendor": v["vendor"], "product": v["product"], "vuln": v["name"],
                    "cwes": [{"id": c, "name": CWE_MAP.get(c, (None, ""))[1]} for c in cwes], "due": v.get("due"),
                    "ransomware": v.get("ransomware"), "action": v.get("action"),
                    "patterns": tag(text, extra), "entities": [v["vendor"].lower(), v["product"].lower()], "_t": text})
    for x in xsig:
        text = f"{x['subject']}. {x['claim']}"
        inc.append({"id": iid("x", x["subject"] + x["date"][:10]), "kind": "x", "date": x["date"], "title": x["subject"],
                    "text": x["claim"], "stage": x.get("stage"), "patterns": tag(text, [{"crypto": None}.get(x.get("category"))]),
                    "entities": [x["subject"].lower()], "_t": text})
    for b in breaches:
        text = f"{b['title']} {b.get('domain') or ''} data breach. {b['desc']} Exposed: {', '.join(b.get('classes') or [])}"
        inc.append({"id": iid("b", b["name"]), "kind": "breach", "date": b["added"], "title": b["title"],
                    "text": b["desc"], "patterns": tag(text, ["data-exposure"]),
                    "entities": [x for x in [(b.get("domain") or "").lower()] if x], "_t": text})
    return inc

def tfidf(docs):
    df = Counter()
    tl = [Counter(toks(d)) for d in docs]
    for t in tl: df.update(set(t))
    N = len(docs)
    vecs = []
    for t in tl:
        v = {w: (1 + math.log(c)) * math.log((N + 1) / (df[w] + 0.5)) for w, c in t.items()}
        norm = math.sqrt(sum(x * x for x in v.values())) or 1
        vecs.append({w: x / norm for w, x in v.items()})
    return vecs

def cos(a, b):
    if len(a) > len(b): a, b = b, a
    return sum(x * b.get(w, 0) for w, x in a.items())

def shared_terms(a, b, k=4):
    common = [(a[w] * b[w], w) for w in a if w in b]
    return [w for _, w in sorted(common, reverse=True)[:k]]

def enrich(news, crypto, kev, xsig, history=None, notes_path=None, breaches=()):
    """Return (incidents, clusters, pattern_stats)."""
    inc = build_incidents(news, crypto, kev, xsig, breaches)
    # merge agent-written analysis; a note may override the auto-tagged patterns
    if notes_path and os.path.exists(notes_path):
        try:
            notes = json.load(open(notes_path))
            for i in inc:
                key = i.get("cve") or i["title"]
                if key in notes:
                    i["analysis"] = notes[key]
                    if notes[key].get("patterns"): i["patterns"] = list(notes[key]["patterns"])
        except Exception:
            pass
    hist = history or []  # older DefiLlama hacks for "similar past attacks"
    hist_docs = [f"{h['name']} {h.get('classification') or ''} {h.get('technique') or ''} {' '.join(h.get('chain') or [])}. {h.get('description') or ''}" for h in hist]
    vecs = tfidf([i["_t"] for i in inc] + hist_docs)
    iv, hv = vecs[:len(inc)], vecs[len(inc):]
    n = len(inc)
    sims = [[0.0] * n for _ in range(n)]
    for a in range(n):
        for b in range(a + 1, n):
            pa, pb = set(inc[a]["patterns"]) - {"unclassified"}, set(inc[b]["patterns"]) - {"unclassified"}
            pj = len(pa & pb) / len(pa | pb) if (pa | pb) else 0
            primary = 1 if inc[a]["patterns"][0] == inc[b]["patterns"][0] and inc[a]["patterns"][0] != "unclassified" else 0
            ent = 1 if set(inc[a]["entities"]) & set(inc[b]["entities"]) - {"ethereum", "multiple products"} else 0
            s = 0.6 * cos(iv[a], iv[b]) + 0.2 * pj + 0.1 * primary + 0.1 * ent
            sims[a][b] = sims[b][a] = s
    for a, i in enumerate(inc):
        cand = sorted(((sims[a][b], b) for b in range(n) if b != a), reverse=True)[:6]
        rel = []
        for s, b in cand:
            if s < 0.22: break
            j = inc[b]
            why = []
            sp = [p for p in i["patterns"] if p in j["patterns"] and p != "unclassified"]
            if sp: why.append("same pattern: " + ", ".join(LABEL[p] for p in sp[:2]))
            se = sorted(set(i["entities"]) & set(j["entities"]) - {"ethereum", "multiple products"})
            if se: why.append("shared: " + ", ".join(se[:2]))
            st = shared_terms(iv[a], iv[b], 3)
            if st: why.append("terms: " + ", ".join(st))
            rel.append({"id": j["id"], "kind": j["kind"], "title": j["title"], "date": j["date"], "score": round(s, 2), "why": "; ".join(why)})
        i["related"] = rel[:5]
        if i["kind"] == "crypto" and hist:
            hc = sorted(((cos(iv[a], hv[h]), h) for h in range(len(hist))), reverse=True)
            past = []
            for s, h in hc:
                if s < 0.14 or len(past) >= 3: break
                hh = hist[h]
                if hh["name"] == i["title"]: continue
                past.append({"name": hh["name"], "date": hh["_date"], "amount": hh.get("amount"), "technique": hh.get("technique"),
                             "classification": hh.get("classification"), "score": round(s, 2),
                             "why": ", ".join(shared_terms(iv[a], hv[h], 3))})
            i["precedents"] = past
    # clusters: union-find over strong links
    parent = list(range(n))
    def f(x):
        while parent[x] != x: parent[x] = parent[parent[x]]; x = parent[x]
        return x
    for a in range(n):
        for b in range(a + 1, n):
            if sims[a][b] >= 0.45: parent[f(a)] = f(b)
    groups = defaultdict(list)
    for a in range(n): groups[f(a)].append(a)
    clusters = []
    for g in groups.values():
        if len(g) < 2 or len(g) > 12: continue
        coh = sum(sims[a][b] for a in g for b in g if a < b) / max(1, len(g) * (len(g) - 1) / 2)
        if coh < 0.4: continue
        pats = Counter(p for a in g for p in inc[a]["patterns"] if p != "unclassified")
        terms = Counter()
        for a in g:
            for b in g:
                if a < b: terms.update(shared_terms(iv[a], iv[b], 4))
        kinds = Counter(inc[a]["kind"] for a in g)
        cid = "cl-" + hashlib.sha1("|".join(sorted(inc[a]["id"] for a in g)).encode()).hexdigest()[:6]
        clusters.append({"id": cid, "size": len(g), "members": [inc[a]["id"] for a in sorted(g, key=lambda a: inc[a]["date"], reverse=True)],
                         "titles": [inc[a]["title"] for a in sorted(g, key=lambda a: inc[a]["date"], reverse=True)],
                         "patterns": [p for p, _ in pats.most_common(3)], "terms": [t for t, _ in terms.most_common(5)],
                         "kinds": dict(kinds), "latest": max(inc[a]["date"] for a in g),
                         "cohesion": round(sum(sims[a][b] for a in g for b in g if a < b) / max(1, len(g) * (len(g) - 1) / 2), 2)})
        for a in g: inc[a]["cluster"] = cid
    clusters.sort(key=lambda c: (c["size"] * c["cohesion"], c["latest"]), reverse=True)
    # pattern stats
    stats = defaultdict(lambda: {"news": 0, "crypto": 0, "kev": 0, "x": 0, "breach": 0, "usd": 0, "total": 0, "recent7": 0})
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    for i in inc:
        p = i["patterns"][0]
        st = stats[p]; st[i["kind"]] += 1; st["total"] += 1; st["usd"] += i.get("amount") or 0
        d = datetime.fromisoformat((i["date"] + ("T00:00:00+00:00" if len(i["date"]) == 10 else "")).replace("Z", "+00:00"))
        if (now - d).days < 7: st["recent7"] += 1
    pattern_stats = [{"id": k, "label": LABEL.get(k, "Unclassified"), **v} for k, v in stats.items()]
    pattern_stats.sort(key=lambda s: s["total"], reverse=True)
    for i in inc: i.pop("_t", None)
    return inc, clusters, pattern_stats, [{"id": k, "label": v} for k, v, _ in PATTERNS]
