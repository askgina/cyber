# Breach Ledger

Hourly-updated register of cyber incidents (crypto exploits, ransomware leak-site claims, CISA KEV, security news, X signals).

- `pipeline/build_data.py` — pulls public feeds and writes `site/data.json`.
- `pipeline/x_signals.json` — curated early signals from X (facts + links only; Claimed / Corroborated / Confirmed).
- `pipeline/victims_cache.json` — rolling 35-day ransomware.live cache (committed so hourly runs avoid bulk endpoints).
- `site/` — static page, deployed as the Perplexity app "Breach Ledger" (asset f26d3622-8cbb-4bcf-9195-b54bc391b0a1).
