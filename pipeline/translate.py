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
    return non_ascii > 0.08 and len(LATIN_EN.findall(text)) < 2


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
            time.sleep(1)


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
