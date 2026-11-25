# Cyber

[Cyber](https://cyber.askgina.ai/) is an hourly register of cyber incidents. It tracks crypto exploits, ransomware leak-site claims, vulnerabilities in CISA's Known Exploited Vulnerabilities catalog, security news, and early signals from X.

## JSON endpoints

All endpoints are relative to `https://cyber.askgina.ai/` and support `GET` and `HEAD`. Send `If-None-Match` with the `ETag` from your last response to get a bodyless `304 Not Modified` when the data has not changed.

| Endpoint | Contents |
| --- | --- |
| `/data-hot.json` | Startup data: recent incident summaries and aggregate counts. Until the split is published, this URL serves the full `/data.json` snapshot. |
| `/data-details.json` | Full record details for on-demand loading. |
| `/data-history.json` | Older records within the snapshot window. This is separate from the year-to-date archive. |
| `/data.json` | Full, unsplit snapshot for existing clients. |
| `/archive.json` | Year-to-date archive. |

Before the first split build, the details and history endpoints return `404` with `{"error":"split not built yet"}`. Clients should request these two files only when the startup payload contains `"split": true`. If the full snapshot or archive is not available yet, its endpoint returns `503`.

## Data and license

The code is released under the [MIT License](LICENSE). Cyber's published dataset is available under the [Creative Commons Attribution 4.0 International license (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/). Credit [Cyber](https://cyber.askgina.ai/) and keep the original source attributions when reusing the data. Linked third-party material remains subject to its own terms. The breach catalog comes from [Have I Been Pwned](https://haveibeenpwned.com/) (CC BY 4.0).

- `pipeline/build_data.py` pulls public feeds and writes the data in `site/`.
- `pipeline/x_signals.json` contains facts and links curated by hand. Cyber does not collect posts from X automatically.
- `pipeline/incidents.json` contains the curated incident registry. The build attaches matching press stories and notices.

## Hosting and builds

- The Cloudflare Worker (`worker/index.js`) serves the static site and reads the JSON endpoints from R2. It starts the `Builder` container at seven minutes past each hour (`7 * * * *`).
- The container downloads `main`, restores the previous build's caches from `state.tar.gz`, and runs the pipeline. The Worker stores the output and caches in the `breach-ledger-state` R2 bucket. The Worker publishes the split files once the build produces all three.
- Edits to curated files on `main` appear after the next successful hourly build. The checked-in JSON snapshots and caches are for local use.
- To start a build now, run `curl -X POST -H "Authorization: Bearer $BUILD_TOKEN" https://cyber.askgina.ai/__build`. The token is in 1Password under `breach-ledger BUILD_TOKEN`.
- `.github/workflows/deploy.yml` deploys changes to `site/`, `worker/`, `container/`, `wrangler.jsonc`, and the package files on `main`. It uses the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets.
- To view the site locally, run `python3 pipeline/build_data.py`, then `python3 -m http.server --directory site`.
