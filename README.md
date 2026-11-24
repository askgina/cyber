# Breach Ledger

Hourly-updated register of cyber incidents (crypto exploits, ransomware leak-site claims, CISA KEV, security news, X signals).

- `pipeline/build_data.py` — pulls public feeds and writes `site/data.json`.
- `pipeline/x_signals.json` — curated early signals from X (facts + links only; Claimed / Corroborated / Confirmed).
- `pipeline/victims_cache.json` — rolling 35-day ransomware.live cache (committed so hourly runs avoid bulk endpoints).
- `site/` — static page, served by Cloudflare (Workers static assets, `wrangler.jsonc`) at https://breach-ledger.cool-bush-8a29.workers.dev/.
- `.github/workflows/hourly.yml` — hourly: runs the build, commits caches and data back to `main`, deploys `site/` with `wrangler deploy` (secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`).
