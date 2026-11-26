"""English-only output: translate non-English headlines and snippets, with a persistent cache.

Uses the public Google Translate web endpoint (no key). Failures leave the text unchanged and are retried next run.
"""
import json, os, re, time, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "pipeline", "translate_cache.json")
_c = json.load(open(CACHE)) if os.path.exists(CACHE) else {}
_dirty = False
LATIN_EN = re.compile(r"\b(the|and|of|to|in|for|on|with|after|data|hack|hackers|breach|attack|cyber|says|hit|by)\b", re.I)


def needs(text, lang=None):
    """True when text is probably not English."""
    if not text or len(text) < 4: return False
    letters = [ch for ch in text if ch.isalpha()]
    if not letters: return False
    non_ascii = sum(1 for ch in letters if ord(ch) > 127) / len(letters)
    if non_ascii > 0.3: return True
    if lang and lang != "en":
        # an English headline in a regional edition: keep it if it reads as English
        return len(LATIN_EN.findall(text)) < 2
    en_hits = len(LATIN_EN.findall(text))
    if non_ascii > 0.08 and en_hits < 2: return True
    fo = len(FOREIGN.findall(text))
    return fo >= 2 and fo > en_hits


FOREIGN = re.compile(r"\b(de|het|een|van|voor|bij|met|niet|naar|zijn|wordt|op|la|el|los|las|una|un|del|por|para|con|que|en|der|die|das|und|ein|eine|nach|bei|mit|ist|auf|f\u00fcr|le|les|du|des|une|sur|avec|pour|est|et|au|aux|dans|par|pas|été|il|di|per|della|che|och|av|som|ikke|og|af|til|dla|nie|si\u0119|na|w|do|ze|pe|s\u00e3o|uma|dos|das|em|ao)\b", re.I)
_blocked = False


def _batch(qs):
    """Translate a batch in one request (Chrome-extension endpoint takes repeated q= params)."""
    u = "https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=en&" + "&".join("q=" + urllib.parse.quote(q) for q in qs)
    req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
    r = json.loads(urllib.request.urlopen(req, timeout=30).read().decode())
    out = []
    for x in r:
        out.append(x[0] if isinstance(x, list) else x)
    return out


_mm = {"n": 0, "off": False}


def _mymemory(q):
    """Fallback when Google rate-limits: MyMemory free API, one string per call, small daily quota."""
    if _mm["off"] or _mm["n"] >= 80: return None
    _mm["n"] += 1
    u = "https://api.mymemory.translated.net/get?langpair=autodetect|en&q=" + urllib.parse.quote(q[:480])
    try:
        r = json.loads(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"}), timeout=20).read().decode())
    except Exception:
        _mm["off"] = True; return None
    if r.get("quotaFinished") or r.get("responseStatus") != 200: _mm["off"] = True; return None
    out = (r.get("responseData") or {}).get("translatedText") or ""
    if not out or "MYMEMORY WARNING" in out.upper(): return None
    return out


def prefetch(texts, lang=None):
    """Translate every uncached non-English string, batched. Stops for this run if the service rate-limits."""
    global _dirty, _blocked
    todo = list(dict.fromkeys(t for t in texts if isinstance(t, str) and t not in _c and needs(t, lang)))
    i = 0
    while i < len(todo) and not _blocked:
        chunk, size = [], 0
        while i < len(todo) and len(chunk) < 40:
            q = todo[i][:600]; enc = len(urllib.parse.quote(q)) + 3
            if chunk and size + enc > 7000: break
            chunk.append(todo[i]); size += enc; i += 1
        try:
            res = _batch([q[:600] for q in chunk])
            for src, out in zip(chunk, res):
                out = (out or "").replace("\u200b", "").strip()
                if out and out != src.strip(): _c[src] = out; _dirty = True
            time.sleep(0.3)
        except Exception as e:
            if "429" in str(e): _blocked = True
            print(f"translate: batch failed: {type(e).__name__}: {e} ({len(todo) - i} strings left)", flush=True)
            time.sleep(1)
    if _blocked:
        # shortest first so headlines win the small fallback quota
        for src in sorted([x for x in todo if x not in _c], key=len):
            out = _mymemory(src)
            if out is None and _mm["off"]: break
            if out and out.strip() != src.strip(): _c[src] = out.strip(); _dirty = True
            time.sleep(0.2)


def en(text, lang=None):
    """English version of text from the cache (call prefetch first). Returns the input when unknown."""
    if not needs(text, lang): return text
    if text not in _c and not _blocked: prefetch([text], lang)
    return _c.get(text, text)


def many(texts, lang=None, budget=400):
    """Translate a list, at most `budget` uncached calls per run."""
    out, n = [], 0
    for t in texts:
        if needs(t, lang) and t not in _c:
            if n >= budget: out.append(t); continue
            n += 1
        out.append(en(t, lang))
    return out


def save():
    if _dirty:
        # keep the cache bounded
        items = list(_c.items())[-20000:]
        json.dump(dict(items), open(CACHE, "w"), ensure_ascii=False)
