# Breach Ledger

Hourly-updated register of cyber incidents (crypto exploits, ransomware leak-site claims, CISA KEV, security news, X signals).

- `pipeline/build_data.py` — pulls public feeds and writes `site/data.json`.
- `pipeline/x_signals.json` — curated early signals from X (facts + links only; Claimed / Corroborated / Confirmed). Added by hand; nothing reads X automatically.
- `pipeline/incidents.json` — curated incident registry; the build attaches matching press stories and notices.
- `site/` — static page: https://breach-ledger.cool-bush-8a29.workers.dev/

## Hosting and the hourly build (all on Cloudflare)

- `worker/index.js` — Worker `breach-ledger`: serves `site/` as static assets, serves `data.json` and `archive.json` from R2, and runs the build every hour (cron `7 * * * *`).
- `container/` — the `Builder` container (Python). Each run downloads the latest `main` from GitHub (code and curated JSON), restores the caches from R2 (`state.tar.gz`), runs `pipeline/build_data.py`, and hands back `data.json`, `archive.json` and the updated caches, which the Worker stores in R2 bucket `breach-ledger-state`.
- Caches and generated data are not committed anymore: edits to curated files on `main` are picked up by the next hourly run; the copies of `site/*.json` and the caches in git are only for local runs.
- Run a build now: `curl -X POST -H "Authorization: Bearer $BUILD_TOKEN" https://breach-ledger.cool-bush-8a29.workers.dev/__build` (token: 1Password "breach-ledger BUILD_TOKEN").
- `.github/workflows/deploy.yml` — on pushes that change `site/`, `worker/`, `container/` or `wrangler.jsonc`: `wrangler deploy` (secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`).
- Local: `python3 pipeline/build_data.py` then `python3 -m http.server --directory site`.
