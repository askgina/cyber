#!/usr/bin/env python3
"""Hourly build runner for Breach Ledger, inside a Cloudflare Container.

POST /run      body: state.tar.gz from R2 (caches from the previous run; may be empty on the first run).
               Downloads the latest code and curated data from GitHub main, restores the caches over it,
               runs pipeline/build_data.py, then packs the outputs.
GET  /out/NAME JSON data (full, split, or archive) or state.tar.gz from the last successful run.
GET  /out/{search,pages}/manifest.json  Index of generated search documents or public pages.
POST /out/{search,pages}/bundle         JSON list of relative keys -> {key: UTF-8 text}.
"""
import io, json, os, re, shutil, subprocess, tarfile, threading, time, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO_TARBALL = "https://codeload.github.com/askgina/cyber/tar.gz/refs/heads/main"
WORK = "/work"
OUT = "/work/out"
# Files the build writes and reads back next run. Everything else (code, curated JSON) comes from git.
STATE = ["pipeline/victims_cache.json", "pipeline/ransom_monthly.json", "pipeline/news_cache.json",
         "pipeline/first_seen.json", "pipeline/translate_cache.json", "pipeline/triage_queue.json",
         "pipeline/archive_cache", "pipeline/.prerender-state.json", "site/data.json", "site/archive.json"]
LOCK = threading.Lock()
SERVER_VERSION = "2026-11-25.3 prerender"  # bump on changes; the build response reports it
SPLIT_OUTPUTS = ("data-hot.json", "data-details.json", "data-history.json")
DATA_OUTPUTS = ("data.json", "archive.json") + SPLIT_OUTPUTS


def fetch_repo(dest):
    for attempt in range(4):  # the first outbound connection after a cold start is sometimes reset
        try:
            with urllib.request.urlopen(REPO_TARBALL, timeout=120) as r:
                data = r.read()
            break
        except OSError:
            if attempt == 3:
                raise
            time.sleep(3 * (attempt + 1))
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as t:
        t.extractall(WORK, filter="data")
    top = os.path.join(WORK, "breach-ledger-main")
    shutil.rmtree(dest, ignore_errors=True)
    os.rename(top, dest)


def restore_state(repo, blob):
    if not blob:
        return 0
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as t:
        names = [m for m in t.getmembers() if any(m.name == p or m.name.startswith(p + "/") for p in STATE)]
        t.extractall(repo, members=names, filter="data")
        return len(names)


def pack_outputs(repo):
    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(OUT)
    with tarfile.open(os.path.join(OUT, "state.tar.gz"), "w:gz") as t:
        for p in STATE:
            if os.path.exists(os.path.join(repo, p)):
                t.add(os.path.join(repo, p), arcname=p)
    for name in DATA_OUTPUTS:
        path = os.path.join(repo, "site", name)
        if name not in SPLIT_OUTPUTS or os.path.isfile(path):
            shutil.copy(path, os.path.join(OUT, name))
    # AI Search documents (one file per type per day) and their manifest; the Worker uploads only changed ones
    if os.path.isdir(os.path.join(repo, "search_docs")):
        shutil.copytree(os.path.join(repo, "search_docs"), os.path.join(OUT, "search"))
    if os.path.isdir(os.path.join(repo, "pages")):
        shutil.copytree(os.path.join(repo, "pages"), os.path.join(OUT, "pages"),
                        ignore=shutil.ignore_patterns(".state.json", ".*.tmp"))


def run(blob):
    repo = os.path.join(WORK, "repo")
    t0 = time.time()
    fetch_repo(repo)
    restored = restore_state(repo, blob)
    p = subprocess.run(["python3", "pipeline/build_data.py"], cwd=repo, capture_output=True, text=True, timeout=12 * 60)
    log = (p.stdout + p.stderr)[-4000:]
    if p.returncode != 0:
        return 500, {"ok": False, "exit": p.returncode, "log": log}
    s = subprocess.run(["python3", "pipeline/search_docs.py"], cwd=repo, capture_output=True, text=True, timeout=120)
    p = subprocess.run(["python3", "pipeline/prerender.py"], cwd=repo, capture_output=True, text=True, timeout=180)
    pack_outputs(repo)
    gen = json.load(open(os.path.join(repo, "site", "data.json"))).get("generated")
    man = os.path.join(OUT, "search", "manifest.json")
    docs = {"exit": s.returncode, "output": (s.stdout + s.stderr)[-600:], "files": len(json.load(open(man))) if os.path.exists(man) else 0}
    prerender = {"exit": p.returncode, "output": (p.stdout + p.stderr)[-600:], "routes": 0, "assets": 0, "retired": 0}
    man = os.path.join(OUT, "pages", "manifest.json")
    if p.returncode == 0 and os.path.isfile(man):
        with open(man, encoding="utf-8") as f:
            pages = json.load(f)
        prerender.update((key, len(pages[key])) for key in ("routes", "assets", "retired"))
    return 200, {"ok": True, "server": SERVER_VERSION, "generated": gen, "restored_files": restored,
                 "search_docs": docs, "prerender": prerender, "seconds": round(time.time() - t0), "log": log[-1500:]}


class H(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _bundle(self, directory):
        try:
            length = int(self.headers.get("content-length") or 0)
            if not 0 <= length <= 1024 * 1024:
                return self._send(413, {"error": "invalid bundle length"})
            keys = json.loads(self.rfile.read(length) or b"[]")
        except (ValueError, RecursionError):
            return self._send(400, {"error": "expected a JSON list of relative keys"})
        if not isinstance(keys, list) or not all(isinstance(key, str) for key in keys):
            return self._send(400, {"error": "expected a JSON list of relative keys"})
        base = os.path.realpath(os.path.join(OUT, directory))
        out = {}
        for key in keys:
            if key in out or not re.fullmatch(r"[a-zA-Z0-9._/-]{1,512}", key) or any(
                part in ("", ".", "..") or part.startswith(".") for part in key.split("/")
            ):
                continue
            path = os.path.realpath(os.path.join(base, key))
            if path.startswith(base + os.sep) and os.path.isfile(path):
                try:
                    with open(path, encoding="utf-8") as f:
                        out[key] = f.read()
                except FileNotFoundError:  # pack_outputs may have replaced the snapshot.
                    continue
        return self._send(200, out)

    def do_POST(self):
        if self.path in ("/out/search/bundle", "/out/pages/bundle"):
            return self._bundle(self.path.split("/")[2])
        if self.path != "/run":
            return self._send(404, {"error": "not found"})
        if not LOCK.acquire(blocking=False):
            return self._send(409, {"error": "a build is already running"})
        try:
            n = int(self.headers.get("content-length") or 0)
            blob = self.rfile.read(n) if n else b""
            code, res = run(blob)
            self._send(code, res)
        except Exception as e:
            self._send(500, {"ok": False, "error": repr(e)})
        finally:
            LOCK.release()

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"ok": True})
        if not self.path.startswith("/out/"):
            return self._send(404, {"error": "not found"})
        name = self.path.removeprefix("/out/")
        if name in ("search/manifest.json", "pages/manifest.json") and os.path.isfile(os.path.join(OUT, name)):
            with open(os.path.join(OUT, name), "rb") as f:
                return self._send(200, f.read())
        if name not in DATA_OUTPUTS + ("state.tar.gz",) or not os.path.exists(os.path.join(OUT, name)):
            return self._send(404, {"error": "not found"})
        ctype = "application/gzip" if name.endswith(".gz") else "application/json"
        self._send(200, open(os.path.join(OUT, name), "rb").read(), ctype)

    def log_message(self, fmt, *args):
        print("%s %s" % (self.address_string(), fmt % args), flush=True)


if __name__ == "__main__":
    os.makedirs(WORK, exist_ok=True)
    ThreadingHTTPServer(("0.0.0.0", 8080), H).serve_forever()
