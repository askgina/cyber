# Cyber

[Cyber](https://cyber.askgina.ai/) is an hourly register of cyber incidents. It tracks crypto exploits, ransomware leak-site claims, vulnerabilities in CISA's Known Exploited Vulnerabilities catalog, security news, and early signals from X.

This repository contains the source for the hosted Cyber feed. You can preview it locally without Cloudflare credentials. It is not a turnkey production deployment or a channel for submitting incidents; report incidents to the affected organization or the relevant authority.

## Local quickstart

From the root of a fresh clone, use **Node.js 22** (22.12 or newer) and **Python 3.12** on your `PATH` as `python3`. These are the versions used in CI.

```sh
npm ci
python3 pipeline/split_data.py
python3 pipeline/prerender.py
node scripts/local-worker.mjs
```

Open the `READY http://127.0.0.1:…` URL. Try `/`, `/method`, `/api`, or `/data-hot.json`. The preview runs the actual Worker against local fixtures, with Builder and AI Search stubbed. It seeds a representative set of incident routes; for all incident routes from the current snapshot, use `node scripts/local-worker.mjs --seed-live` instead. Press Ctrl+C to stop it.

`npm ci` downloads dependencies. Generating fixtures uses the checked-in snapshots rather than fetching feeds; it writes ignored outputs under `site/` and `pages/`. No Docker, Cloudflare login, or production secrets are needed. The browser UI can still poll some public sources, but preview setup and checks don't depend on those responses.

### Checks

After installing dependencies and generating fixtures, run the same checks as the required pull request job:

```sh
python3 pipeline/check_curated.py
python3 pipeline/test_curated.py
npm run check
```

`npm run check` starts and stops its own Worker; you don't need to leave the preview running. Regenerate fixtures after changing snapshots or the page generators. Browser and accessibility checks are separate: with Chromium installed, run `CHROME_PATH=/absolute/path/to/chromium npm run check:browser:local` (omit `CHROME_PATH` if Playwright's compatible Chromium is already installed).

See [contributing](CONTRIBUTING.md) for PRs, [security](SECURITY.md) for vulnerabilities in Cyber itself, and [operations](docs/operations.md) for production and live feed refresh.

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

The code is released under the [MIT License](LICENSE). [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) applies only to Cyber’s original analysis, labels and summaries. Third-party material, including sourced fields in the downloads, is not covered by Cyber’s licence and remains subject to its source’s terms. Credit [Cyber](https://cyber.askgina.ai/) for its original work and retain any required upstream attribution. The breach catalog comes from [Have I Been Pwned](https://haveibeenpwned.com/) (CC BY 4.0).

- `pipeline/build_data.py` pulls public feeds and writes the data in `site/`.
- `pipeline/x_signals.json` contains facts and links curated by hand. Cyber does not collect posts from X automatically.
- `pipeline/incidents.json` contains the curated incident registry. The build attaches matching press stories and notices.
