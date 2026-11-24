#!/usr/bin/env python3
"""Hourly build runner for Breach Ledger, inside a Cloudflare Container.

POST /run      body: state.tar.gz from R2 (caches from the previous run; may be empty on the first run).
               Downloads the latest code and curated data from GitHub main, restores the caches over it,
               runs pipeline/build_data.py, then packs the outputs.
GET  /out/NAME data.json, archive.json or state.tar.gz from the last successful run.
"""
import io, json, os, shutil, subprocess, tarfile, threading, time, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO_TARBALL = "https://codeload.github.com/t-y-b-b/breach-ledger/tar.gz/refs/heads/main"
WORK = "/work"
OUT = "/work/out"
# Files the build writes and reads back next run. Everything else (code, curated JSON) comes from git.
STATE = ["pipeline/victims_cache.json", "pipeline/ransom_monthly.json", "pipeline/news_cache.json",
         "pipeline/first_seen.json", "pipeline/translate_cache.json", "pipeline/triage_queue.json",
         "pipeline/archive_cache", "site/data.json", "site/archive.json"]
LOCK = threading.Lock()
SERVER_VERSION = "2026-11-25.1 search-docs"  # bump on changes; the build response reports it


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
    for name in ("data.json", "archive.json"):
        shutil.copy(os.path.join(repo, "site", name), os.path.join(OUT, name))
    # AI Search documents (one file per type per day) and their manifest; the Worker uploads only changed ones
    if os.path.isdir(os.path.join(repo, "search_docs")):
        shutil.copytree(os.path.join(repo, "search_docs"), os.path.join(OUT, "search"))


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
    pack_outputs(repo)
    gen = json.load(open(os.path.join(repo, "site", "data.json"))).get("generated")
    man = os.path.join(OUT, "search", "manifest.json")
    docs = {"exit": s.returncode, "output": (s.stdout + s.stderr)[-600:], "files": len(json.load(open(man))) if os.path.exists(man) else 0}
    return 200, {"ok": True, "server": SERVER_VERSION, "generated": gen, "restored_files": restored, "search_docs": docs, "seconds": round(time.time() - t0), "log": log[-1500:]}


class H(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path == "/out/search/bundle":  # body: JSON list of keys -> {key: text}
            keys = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"[]")
            base = os.path.realpath(os.path.join(OUT, "search"))
            out = {}
            for k in keys:
                p = os.path.realpath(os.path.join(base, k))
                if p.startswith(base + os.sep) and os.path.isfile(p):
                    out[k] = open(p, encoding="utf-8").read()
            return self._send(200, out)
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
        name = self.path.removeprefix("/out/")
        if self.path == "/health":
            return self._send(200, {"ok": True})
        if name == "search/manifest.json" and os.path.exists(os.path.join(OUT, name)):
            return self._send(200, open(os.path.join(OUT, name), "rb").read())
        if name not in ("data.json", "archive.json", "state.tar.gz") or not os.path.exists(os.path.join(OUT, name)):
            return self._send(404, {"error": "not found"})
        ctype = "application/gzip" if name.endswith(".gz") else "application/json"
        self._send(200, open(os.path.join(OUT, name), "rb").read(), ctype)

    def log_message(self, fmt, *args):
        print("%s %s" % (self.address_string(), fmt % args), flush=True)


if __name__ == "__main__":
    os.makedirs(WORK, exist_ok=True)
    ThreadingHTTPServer(("0.0.0.0", 8080), H).serve_forever()
