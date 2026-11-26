# Fresh clone: build, view, and check Cyber

Research for [askgina/cyber#49](https://github.com/askgina/cyber/issues/49), at `625e462bdc2ce5d632735e7f1c4c791cffebcb2f` (`origin/main`). **Observed** means directly tested. **Not checked** means not executed, even where the source or CI defines the procedure.

## Test setup

- Used a separate `ovnfs` checkout at `origin/main`. `git status -s` was empty at the start. `node_modules/` was present and left alone. This was not an `npm ci` test. Neither standalone Node check imports a package from `node_modules`.
- Listed the following paths before removal: `pages/`, `search_docs/`, `site/data-hot.json`, `site/data-details.json`, `site/data-history.json`, `pipeline/.prerender-state.json`, `pipeline/__pycache__/`. All seven were present, ignored, and untracked. Removed only those paths, in the research checkout. Confirmed all seven were absent before running the generators.
- Observed runtimes on Linux: Python **3.14.6**, Node **26.2.0**, npm **11.13.0**. Test commands used an empty environment with only `PATH`, `LC_ALL=C.UTF-8`, and an empty temporary `HOME` supplied. Wall times include process startup. Publishing the research branch is separate from the credential-free experiment.

## Command results

The two generators and two standalone checks used the committed snapshots **before** the live refresh attempt. The extra static preview used a separate `git archive` export of `site/` from the same commit, with no generated files.

| Command | Result | Exit | Wall time | Last output or evidence |
| --- | --- | ---: | ---: | --- |
| `rm -rf -- pages search_docs site/data-hot.json site/data-details.json site/data-history.json pipeline/.prerender-state.json pipeline/__pycache__` | Observed | 0 | 15.03 s for list, removal and verification together | `Cleanup verified`. No `git status -s` entries. |
| `python3 pipeline/split_data.py` | Observed | 0 | 1.954 s | `data-details.json: 6,523,642 UTF-8 bytes`<br>`data-history.json: 324,474 UTF-8 bytes`<br>`data-hot.json: 912,049 UTF-8 bytes`<br>`hot_days: 7` |
| `python3 pipeline/prerender.py` | Observed | 0 | 59.965 s | `prerender: 4688 HTML/Markdown pairs (90 daily, 4579 incident, 14 pattern, 5 view), 9 assets, 0 retired routes` |
| `node scripts/check-site.mjs` | Observed | 0 | 8.245 s | `site JS: 144895 / 165000 bytes`<br>`site CSS: 59040 / 71000 bytes`<br>`site data-hot.json: 912049 / 1048576 bytes`<br>`check-site: 33036/33036 checks passed` |
| `node scripts/check-pages-sync.mjs` | Observed | 0 | 0.656 s | `pages sync: 5/5 resume, prune and legacy cases passed` |
| `git status -s` (before live refresh) | Observed | 0 | 0.034 s | No output. Offline generation did not modify tracked files. |
| `timeout 300 python3 pipeline/build_data.py` (README's first local step, capped) | Observed | 124 | 300.078 s | No stdout or stderr (0 bytes). No final `ok` line. The timeout interrupted the refresh. |
| `git status -s` (immediately after live refresh) | Observed | 0 | 0.059 s | See full status below. |
| `python3 -m http.server --directory site` (README's second step, after live refresh attempt) | Observed | 0 | 1.070 s incl. probes and Ctrl-C | Ready in 0.229 s. `Serving HTTP on 0.0.0.0 port 8000 ...` then `Keyboard interrupt received, exiting.` |
| `python3 -m http.server --directory site` (snapshot-only export) | Observed | 0 | 0.980 s incl. probes and Ctrl-C | Ready in 0.532 s. `Serving HTTP on 0.0.0.0 port 8000 ...` then `Keyboard interrupt received, exiting.` |
| `curl -q -sS -I --max-time 5 -o /dev/null -w 'HTTP %{http_code} in %{time_total}s' http://127.0.0.1:8000/PATH` (snapshot-only export, use paths below) | Observed | 0 each | See below | File server, not a Worker. |
| `curl -X POST -H "Authorization: Bearer $BUILD_TOKEN" https://cyber.askgina.ai/__build` | Not checked | — | — | Privileged production action. No token needed for local work. |
| `npx wrangler deploy` | Not checked | — | — | Production deployment, not a clone prerequisite. |
| `"$CHROME_PATH" http://127.0.0.1:8000/` | Not checked | — | — | Browser rendering. Set `CHROME_PATH` to an installed browser. |
| `python3 pipeline/search_docs.py` | Not checked | — | — | Separate production search-document generator. Not needed for prerender or local checks. |

Both Node checks also printed a non-fatal `MODULE_TYPELESS_PACKAGE_JSON` warning on Node 26.

Snapshot-only HTTP responses (elapsed seconds): `/` 200 (0.009), `/data.json` 200 (0.008), `/archive.json` 200 (0.002), `/data-hot.json` 404 (0.002), `/leaderboard` 404 (0.012), `/report` 404 (0.026), `/api/search?q=example` 404 (0.009), `/llms-full.txt` 404 (0.001). HTTP error responses did not make these cURL commands fail because they did not use `--fail`. These tests prove that the server delivers the shell and data, not that a browser renders them. No local Chromium executable was found in the usual system and user cache locations.

The same cURL probes after the live attempt showed `/` 200 (0.006 s), `/data-hot.json` 200 (0.003 s), `/data.json` 200 (0.002 s), `/archive.json` 200 (0.002 s), `/leaderboard` 404 (0.004 s), `/report` 404 (0.005 s), `/api/search?q=example` 404 (0.001 s), and `/llms-full.txt` 404 (0.005 s). All exited 0. The served JSON still reported `generated=2026-11-24T19:12:13Z`. The hot file came from the earlier standalone split, not the timed-out refresh. Thus the literal server step still works, but this run did not complete the README's refresh-then-serve path with new data.

### What the README gets right, and what it misses

- The static server serves `site/` on port 8000. The committed `site/data.json` and `site/archive.json` already suffice for the basic preview. [The app](../../site/app.js) falls back to `/data.json` if `/data-hot.json` is unavailable. A live refresh is not necessary for a first look.
- The static server cannot serve the generated route tree from `pages/` or run the Worker. It does not resolve clean URLs such as `/leaderboard` and `/report` on direct entry. It also cannot provide `/api/search`, Worker headers and content negotiation, or generated discovery routes such as `/llms-full.txt`. In-app navigation is distinct from a direct HTTP load. Use the local Worker for a closer production preview.
- The README omits the offline split and prerender commands, the Worker harness, locked npm dependencies, supported runtimes, and the browser executable. `split_data.py` reads committed `site/data.json` and writes the three split files. `prerender.py` reads the two committed snapshots plus local curated inputs/caches and writes `pages/manifest.json`, HTML/Markdown pairs, discovery files, search refs, and ignored prerender state. It imports `search_docs.py` but does not require generated `search_docs/`. The two generators do not require live feeds, credentials, npm, or a pip install. Use the default prerender command. `--write-static-baselines` is not needed and writes into `site/`.
- The production split is no longer just a rollout plan. All five documented JSON endpoints returned `200` to anonymous HEAD requests and `304` to conditional HEAD requests. The README's first-build behavior is a fallback, not the current way to preview locally. This did not test the pre-publication fallback or download a live snapshot.

Public snapshot probes used `curl -q -sS --head --max-time 12 https://cyber.askgina.ai/PATH` and the same command with `-H "If-None-Match: $ETAG"`, substituting the returned ETag. Both commands exited 0 for each path.

| Path | Observed HEAD | Observed conditional HEAD |
| --- | --- | --- |
| `/data-hot.json` | 200, 0.193 s | 304, 0.169 s |
| `/data-details.json` | 200, 0.425 s | 304, 0.225 s |
| `/data-history.json` | 200, 0.299 s | 304, 0.304 s |
| `/data.json` | 200, 0.580 s | 304, 0.236 s |
| `/archive.json` | 200, 0.500 s | 304, 0.236 s |

### Live refresh: network and tracked writes

`build_data.py` uses Python's standard library and public HTTPS, not Cloudflare or GitHub credentials. It needs DNS, outbound HTTPS and usable CA certificates for fresh results. The source list changes with cache age, pagination and missing translations:

| Source | Network destinations (from source) |
| --- | --- |
| Core feeds and trackers | CISA KEV (`www.cisa.gov`), ransomware.live (`api.ransomware.live` recent/monthly victims and recent cyberattacks, `www.ransomware.live` stats), DefiLlama (`api.llama.fi`), SlowMist (`hacked.slowmist.io`), Have I Been Pwned (`haveibeenpwned.com`, public breach catalog). |
| RSS/Atom ([feed list](../../pipeline/build_data.py#L147-L162)) | `therecord.media`, `feeds.feedburner.com`, `databreaches.net`, `rekt.news`, `www.bleepingcomputer.com`, `krebsonsecurity.com`, `www.securityweek.com`, `www.darkreading.com`, `cyberscoop.com`, `www.helpnetsecurity.com`, `www.infosecurity-magazine.com`, `techcrunch.com`, `www.scworld.com`, `securityaffairs.com`, `www.csoonline.com`, `blog.cloudflare.com`. |
| Matching news and translation | `news.google.com` (Google News RSS), `hn.algolia.com` (Hacker News API), `clients5.google.com` and `api.mymemory.translated.net` (translation). |
| Official disclosures and archive backfill | `oag.ca.gov`, `www.atg.wa.gov`, `justice.oregon.gov`, `ocrportal.hhs.gov`, `efts.sec.gov`, `apps.web.maine.gov`, and the core catalog/claim APIs above. Some hosts return source errors or rate limits. |

X links are curated rather than fetched. The Builder's `codeload.github.com` download is part of production orchestration, not this local script. The script can record upstream failures and still publish data. It can also write caches incrementally before the final snapshot. Do not interpret a successful exit as evidence that every upstream responded, or a timeout as evidence that no files changed.

Observed `git status -s` after the only live attempt:

```text
 M pipeline/first_seen.json
 M pipeline/news_cache.json
 M pipeline/ransom_monthly.json
 M pipeline/translate_cache.json
 M pipeline/victims_cache.json
```

The run refreshed the ransomware.live monthly stats timestamp, added 2,163 news cache keys and added 1,139 translation cache keys. It did not change `site/data.json` or `site/archive.json`. The empty log does not identify which request or phase was active at timeout. The destination list above is from the source, not a network trace. No tracked files were restored by hand or included in the research commit.

## Requirements for the full checks (read only)

Read [`run-check.mjs`](../../scripts/run-check.mjs), [`local-worker.mjs`](../../scripts/local-worker.mjs), [`run-check-browser.mjs`](../../scripts/run-check-browser.mjs), [`verify-browser.mjs`](../../scripts/verify-browser.mjs) and [`ci.yml`](../../.github/workflows/ci.yml). Did not run those scripts locally.

- **Node and Python:** CI uses Node **22** and Python **3.12** on Ubuntu. The lockfile's Wrangler **4.168.0** and Miniflare **5.20261123.1-beta** require Node **22.12.0 or newer**. `playwright-core` **1.65.1** requires Node 20 or newer, so it does not raise that minimum. Python must be on `PATH` as `python3`. `check-site.mjs` calls it for HTML/XML parsing. The local Worker uses it for fixture generation as needed. The repo does not declare a minimum Python version. Use the CI version for parity, not an inferred minimum.
- **Install once:** `npm ci` installs Wrangler, its Miniflare/workerd runtime, esbuild, Playwright Core and axe-core. It needs access to `registry.npmjs.org` unless the npm cache has all packages. Use a platform supported by the native binaries. No global Wrangler, Docker, or Cloudflare login is needed for the local checks.
- **`npm run check`:** runs the page-sync and static checks, then starts the local Worker and runs the HTTP assertions against it. CI generates split files and pages before `npm run check`. The static check can skip missing generated artifacts, so generate them before claiming that coverage. The harness uses existing split files and `pages/manifest.json` when present. It tries to generate missing outputs in a temporary directory, but the missing-pages branch does not copy or link `pipeline/search_docs.py`, which `prerender.py` imports. Expect that branch to fail with `ModuleNotFoundError` on a clean clone with no pages. This is a source finding, not a reproduced full-gate error. Generate the fixtures explicitly as CI does.
- **`npm run check:browser:local`:** starts the same harness with `--seed-live` (meaning all live incident routes from the local snapshot, not the production site). It then launches headless Chromium with Playwright and tests 20 viewport/theme/view combinations plus focus, navigation and split-data behavior. Supply `CHROME_PATH` as the path to an executable Chromium or Chrome with its OS libraries installed. If unset, Playwright looks for its installed compatible browser. `npm ci` does not install that browser. The separate post-deploy workflow installs Chromium with `npx --no-install playwright-core install --with-deps chromium`, which needs browser download and OS package network access plus OS install permissions.
- **Ports and isolation:** Both check wrappers start installed `wrangler dev --local` on `127.0.0.1` with a free OS-selected port. The standalone harness also accepts `--port N`. It uses `--inspector-port 0` (no fixed inspector port), creates temporary state and seeds local R2 over loopback. It stubs Builder and AI Search, excludes production bindings and credentials, and supplies the `READY` URL to the checker. No separate preview server or port 8000 is required for the gates. The browser check does not need successful public responses. The app may still try to poll DefiLlama and HIBP in Chromium. Failures of those cross-origin refreshes are handled by the app. A remote `check:browser` run is separate and needs its target URL.

## References a new contributor cannot use as written

Scope: contributor-facing setup, production operations and baseline reproduction references. This is not a link audit of the incident data or its publisher citations.

| Where | What is inaccessible or outside the clone |
| --- | --- |
| [README: hosting and builds](../../README.md#L27-L34) | The 1Password item `breach-ledger BUILD_TOKEN` is private. The `POST /__build` route requires the production `BUILD_TOKEN`. The production `breach-ledger-state` R2 bucket and its `state.tar.gz` are not public download instructions. The committed snapshots and caches are the local equivalents for this task. |
| [README: deploy](../../README.md#L33) and [deploy workflow](../../.github/workflows/deploy.yml) | `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are repository secrets. Deploying or inspecting production bindings needs account access. Production uses R2 `breach-ledger-state` and `breach-ledger-ai-search`, AI Search `breach-ledger`, the Builder binding and Analytics Engine dataset `cyber_events`. The optional Worker analytics secrets `VISITOR_SECRET` and `POSTHOG_KEY` are not local inputs. |
| [Routes and payload baseline](../baselines/routes-and-payload.md), §§1–2 and Appendix C | The Builder's `http://builder` routes (`/health`, `/run`, `/out/...`), its R2 state, and the optional PostHog telemetry are internal to production. `/tmp/profile.py` is not shipped as a file. Appendix C gives the source to save there. Its inputs are the historical fixture, not today's measurements. |
| [Agent surface baseline](../baselines/agent-surface.md), §§3–4 | Four source links point to private `askgina/blog` at `9b83ddd05fd9b48294a8bcaffd0918acf952b146`: `scripts/generate-static-routes.mjs#L311-L409`, `functions/_middleware.ts`, `public/.well-known/agent-skills/read-ask-gina-blog/SKILL.md`, and `src/lib/blog-webmcp.ts`. All returned anonymous HTTP 404. |
| [Agent surface baseline](../baselines/agent-surface.md), §§1, 5 | Worker logs, AI Search index telemetry and the proposed staging checks require access or a staging URL. The document supplies no staging origin to clone users. |
| [Browser baseline](../baselines/browser-baseline.md), Scope and method | Managed `eval` browser and `../askgina-blog/node_modules/axe-core/axe.min.js` assume the original audit setup. The local replacement is this repo's locked axe-core and a local Chromium binary. |
| [Ora baseline](../baselines/ora-baseline.md), reproduction notes | `askgina-is-agentic-rescore-and-verify` and `askgina-ora-check-fix-recipes` are out-of-tree skill names. The public cURL example is inline. It is a live scan, not a local test. |

### Stale references and historical names

Link probes used `curl -q -sS -L --max-time 12 -o /dev/null -w '%{http_code} %{time_total} %{url_effective}' URL` without GitHub credentials. They exited 0 and took 0.127–1.517 s each. HTTP 404 was a response status, not a process error.

Every old issue link below uses `https://github.com/t-y-b-b/breach-ledger/issues/`. Replace the prefix with `https://github.com/askgina/cyber/issues/` and retain any fragment. All the canonical issue pages returned anonymous HTTP 200. Among the old URLs, only `#4` and `#15` redirected to the new location in this run. The rest returned 404. HTTP status does not verify a comment fragment.

| File | Old link occurrences |
| --- | --- |
| `docs/baselines/agent-surface.md` | `#24` (line 3), `#25#issuecomment-7159810635` (74), `#15` and `#18` (80), `#17#issuecomment-7159809567` (94), `#21` (259). |
| `docs/baselines/browser-baseline.md` | `#4` (line 3). |
| `docs/baselines/ora-baseline.md` | `#3` (line 3), `#8` (87), `#15` (88), `#23` (89). |
| `docs/baselines/record-inventory.md` | `#16` (line 3), `#17#issuecomment-7159809567` (3, repeated at 119). |
| `docs/baselines/routes-and-payload.md` | `#9` (line 3). |

- **Project name:** `Breach Ledger` in the agent-surface baseline heading, pinned source description, catalog and skill examples (lines 1, 3, 119, 123, 127, 228, 245, 248) is the former project name. `askgina/breach-ledger` is also an old repository slug. Its issue #24 returned 404. The npm package name in `package.json` and both lockfile name fields, plus `breach-ledger-smoke` and `breach-ledger-smoke-state` in `scripts/local-worker.mjs`, still use it.
- **Resource names:** The `wrangler.jsonc` Worker, R2 buckets and AI Search instance still use `breach-ledger` identifiers. The README's bucket and vault-item names use those legacy names. These are operational references, not safe search-and-replace targets. Use **Cyber** for the project and `askgina/cyber` for the repo.
- **Historical behavior is not onboarding:** The routes/payload baseline still describes a proposed split, a smaller Worker route list, no `site/_headers`, inline theme code, and Google Fonts. The browser baseline uses legacy hash navigation and the unsplit transfer. The agent-surface baseline describes pre-pagination search and discovery proposals. Use current `wrangler.jsonc`, [API docs](../../site/api.md), and `scripts/` for current behavior. The older record-inventory and Ora figures are point-in-time measurements. `site.FLOWS.md` also uses legacy `#leaderboard`/`#top` as the main view label and hardcodes example entries/counts. Current view routes are `/`, `/leaderboard`, `/report`.

## Shortest paths from a clean clone

Start at the repository root. Use Python 3.12 and, for the checks, Node 22 (at least 22.12). No data refresh, deployment or account is needed. For pages alone, use (a) only. For a static preview alone, use (b) directly. For checks, generate the pages and split files first.

| Goal | Exact command | Evidence |
| --- | --- | --- |
| (a) Generate routed pages | `python3 pipeline/prerender.py` | Observed: exit 0, 59.965 s. Output: `pages/manifest.json` and its artifacts. Split files are not inputs to this command. |
| For (b) Worker preview or (c): generate split files | `python3 pipeline/split_data.py` | Observed: exit 0, 1.954 s. The measured run split first, as CI does. |
| (b) View the static homepage | `python3 -m http.server --directory site` | Observed: exit 0 on Ctrl-C, 0.980 s including the snapshot-only probes. Open `http://127.0.0.1:8000/`. This command binds on all interfaces by default. |
| (b), alternate: install dependencies for a Worker preview (reuse for (c)) | `npm ci` | Not checked. A cached `node_modules/` was present. |
| (b), alternate: view the Worker-backed site | `node scripts/local-worker.mjs --seed-live` | Not checked. Keep it running, then open the loopback URL from `READY`. |
| (c) Run just the observed standalone checks after fixture generation | `node scripts/check-site.mjs` then `node scripts/check-pages-sync.mjs` | Observed: exits 0 and 0, 8.245 s and 0.656 s, respectively. No npm install required for these two. |
| (c) Run the full CI-equivalent local check after (a) and `npm ci` | `npm run check` | Not checked. This includes the two standalone checks, so the preceding row is optional when running the full check. |
| (c), optional: provision Chromium if not already installed | `npx --no-install playwright-core install --with-deps chromium` | Not checked. Use the installed Playwright browser or a preinstalled executable via `CHROME_PATH`. |
| (c), optional: run the local accessibility and navigation gate | `CHROME_PATH=/absolute/path/to/chromium npm run check:browser:local` | Not checked. Replace the example executable path. Omit `CHROME_PATH` if using an installed Playwright Chromium. |
