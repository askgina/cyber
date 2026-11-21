"""Score X signals by project.

Each signal in x_signals.json is one project or organisation, with every post we found about it
(from any account, including ordinary users). This module turns those posts into:
  - a credibility score (0-100) from how many independent accounts report it and how credible they are,
  - a lifecycle stage (Rumour, Claimed, Corroborated, Confirmed, Post-mortem, or Disputed / False alarm),
  - a stage history with the post or record that moved it,
  - links to matching database entries (DefiLlama, SlowMist, HIBP, CISA KEV, news).
The hourly agent only records posts and facts; stages are computed here so they are consistent.
"""
import datetime as dt, json, os, re

ROLE_W = {"official": 1.0, "security": 0.7, "investigator": 0.65, "media": 0.4,
          "aggregator": 0.2, "user": 0.12, "unknown": 0.08}
ROLE_LABEL = {"official": "Affected party", "security": "Security firm", "investigator": "Investigator",
              "media": "Media", "aggregator": "Aggregator", "user": "User", "unknown": "Unverified account"}
STAGES = ["Rumour", "Claimed", "Corroborated", "Confirmed", "Post-mortem"]

def parse(s):
    if len(s) == 10: s += "T12:00:00Z"
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
def iso(d): return d.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def post_time(p):
    """X status IDs encode their creation time; prefer that over a hand-entered date."""
    m = re.search(r"/status/(\d{15,})", p.get("url", ""))
    if m:
        return iso(dt.datetime.fromtimestamp(((int(m.group(1)) >> 22) + 1288834974657) / 1000, dt.timezone.utc))
    return p.get("date")

def handle_of(p):
    if p.get("handle"): return p["handle"].lstrip("@")
    m = re.search(r"x\.com/([A-Za-z0-9_]+)/status", p.get("url", ""))
    return m.group(1) if m else "unknown"

def norm(s): return re.sub(r"[^a-z0-9]", "", re.sub(r"\(.*?\)", "", s.lower()))

def weight(p, registry):
    role = registry.get(p["handle"]) or registry.get(p["handle"].lower()) or p.get("role") or "unknown"
    w = ROLE_W.get(role, ROLE_W["unknown"])
    if role not in ("official",):
        if p.get("evidence") == "onchain": w = min(0.9, w * 1.35 + 0.05)
        elif p.get("evidence") in ("screenshot", "link"): w = min(0.85, w * 1.15)
    return role, w

def evaluate(posts, db_hits, postmortem, outcome, registry, upto=None, age_h=None):
    """Score using only evidence up to time `upto`."""
    ps = [p for p in posts if upto is None or p["date"] <= upto]
    best = {}
    official_confirm = official_deny = False
    for p in ps:
        role, w = weight(p, registry)
        p["role"], p["w"] = role, round(w, 2)
        if role == "official":
            if p.get("stance") == "deny": official_deny = True
            elif p.get("stance") in ("confirm", "update", "postmortem", "report"): official_confirm = True
            continue
        if p.get("stance") == "deny": continue
        best[p["handle"]] = max(best.get(p["handle"], 0), w)
    corro = 1.0
    for w in best.values(): corro *= (1 - w)
    corro = 1 - corro
    credible = sum(1 for w in best.values() if w >= 0.5)
    hits = [h for h in db_hits if upto is None or h["date"] <= upto]
    pm = postmortem if postmortem and (upto is None or (postmortem.get("date") or "") <= upto) else None
    score = round(100 * corro)
    if official_confirm or hits: score = max(score, 85)
    if pm: score = 100
    if pm: stage = "Post-mortem"
    elif official_confirm or hits: stage = "Confirmed"
    elif official_deny: stage = "Disputed"
    elif corro >= 0.7 or credible >= 2: stage = "Corroborated"
    elif credible >= 1 or corro >= 0.3: stage = "Claimed"
    else: stage = "Rumour"
    if upto is None and stage in ("Rumour", "Claimed") and age_h is not None and age_h > 72: stage = "Unconfirmed"
    if upto is None and outcome in ("false-alarm", "retracted"): stage = "False alarm" if outcome == "false-alarm" else "Retracted"
    return {"score": score, "stage": stage, "accounts": len(best) + (1 if official_confirm or official_deny else 0),
            "credible": credible + (1 if official_confirm else 0), "official": official_confirm, "denied": official_deny}

def find_matches(sig, crypto, breaches, kev, news):
    names = {norm(n) for n in [sig.get("project") or sig["subject"], sig["subject"], *sig.get("aliases", [])] if n}
    words = [w for w in {*(sig.get("aliases") or []), sig.get("project") or sig["subject"]} if len(w) >= 4]
    t0 = parse(sig["first"])
    def near(d, days=5): return abs((parse(d) - t0).total_seconds()) <= days * 86400
    hits = []
    for c in crypto:
        if norm(c["name"]) in names and near(c["date"]):
            hits.append({"kind": "crypto", "ref": id(c), "eid": c.get("eid"), "label": "DefiLlama" if "DefiLlama" in c.get("sources", ["DefiLlama"]) else c["sources"][0],
                         "date": c["date"] + "T23:59:59Z", "sources": c.get("sources", [])})
    for b in breaches:
        if (norm(b["title"]) in names or norm(b["name"]) in names) and near(b["added"], 30):
            hits.append({"kind": "breach", "ref": id(b), "eid": b.get("eid"), "label": "Have I Been Pwned", "date": b["added"]})
    for k in kev:
        if any(norm(n) in names for n in (k["product"], f"{k['vendor']} {k['product']}", k["id"])) and near(k["date"], 14):
            hits.append({"kind": "kev", "ref": id(k), "eid": k.get("eid"), "label": "CISA KEV", "date": k["date"] + "T23:59:59Z"})
    press = []
    for n in news:
        if near(n["date"], 5) and any(re.search(r"\b" + re.escape(w) + r"\b", n["title"], re.I) for w in words):
            press.append({"ref": id(n), "eid": n.get("eid"), "source": n["source"], "date": n["date"], "title": n["title"]})
    return hits, press

def score_signals(xsig, crypto, breaches, kev, news, registry_path, now):
    registry = {}
    if os.path.exists(registry_path):
        registry = {k: v for k, v in json.load(open(registry_path)).items() if not k.startswith("_")}
    registry.update({k.lower(): v for k, v in list(registry.items())})
    out = []
    for s in xsig:
        posts = []
        for p in s.get("posts", []):
            q = dict(p); q["handle"] = handle_of(p); q["date"] = post_time(p) or s["date"]
            posts.append(q)
        posts.sort(key=lambda p: p["date"])
        s["first"] = posts[0]["date"] if posts else s["date"]
        hits, press = find_matches(s, crypto, breaches, kev, news)
        pm = s.get("postmortem")
        if not pm:
            # Automatic post-mortem detection: a rekt write-up or an article titled as a post-mortem / root cause.
            for n in press:
                if n["source"].lower().startswith("rekt") or re.search(r"post-?mortem|root cause|incident report|what happened", n["title"], re.I):
                    src = next((x for x in news if x.get("eid") == n["eid"]), {})
                    pm = {"date": n["date"], "label": n["source"], "url": src.get("url"), "auto": True}
                    break
        # History: replay evidence in time order and record each stage change.
        events = [(p["date"], "post", p) for p in posts] + [(h["date"], "db", h) for h in hits]
        if pm and pm.get("date"): events.append((pm["date"], "pm", pm))
        events.sort(key=lambda e: e[0])
        hist, last = [], None
        for t, kind, ref in events:
            st = evaluate(posts, hits, pm, None, registry, upto=t)["stage"]
            if st != last:
                by = (f"@{ref['handle']}" if kind == "post" else ref.get("label", "Post-mortem"))
                hist.append({"t": t, "stage": st, "by": by, "url": ref.get("url") if kind != "db" else None, "eid": ref.get("eid") if kind == "db" else None})
                last = st
        age_h = (now - parse(s["first"])).total_seconds() / 3600
        cur = evaluate(posts, hits, pm, s.get("outcome"), registry, age_h=age_h)
        if cur["stage"] != last and cur["stage"] == "Unconfirmed":
            hist.append({"t": iso(parse(s["first"]) + dt.timedelta(hours=72)), "stage": "Unconfirmed", "by": "no confirmation after 72 hours", "url": None})
        if cur["stage"] != last and cur["stage"] in ("False alarm", "Retracted"):
            hist.append({"t": s.get("outcome_date") or iso(now), "stage": cur["stage"], "by": "outcome", "url": s.get("outcome_url")})
        conf_t = next((h["t"] for h in hist if h["stage"] in ("Confirmed", "Post-mortem")), None)
        s.update({
            "date": s["first"], "last": max([p["date"] for p in posts] + [(pm or {}).get("date") or s["first"]]), "posts": [{k: p.get(k) for k in ("date", "handle", "role", "w", "stance", "evidence", "url", "note")} for p in posts],
            "postmortem": pm, "outcome": s.get("outcome"),
            "score": cur["score"], "stage": cur["stage"], "accounts": cur["accounts"], "credible": cur["credible"],
            "official": cur["official"], "history": hist, "matches": hits, "press": press[:6],
            "hours_to_confirm": round((parse(conf_t) - parse(s["first"])).total_seconds() / 3600, 1) if conf_t else None,
            "press_lead_h": round((parse(press[-1]["date"] if False else min(p["date"] for p in press)) - parse(s["first"])).total_seconds() / 3600, 1) if press else None,
            "stale": cur["stage"] in ("Rumour", "Claimed") and age_h > 24,
            "age_h": round(age_h, 1),
        })
        out.append(s)
    return out
