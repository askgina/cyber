# Routes, CSP and payload baseline

Baseline for [issue #9](https://github.com/t-y-b-b/breach-ledger/issues/9), at `a312f6c`. This report distinguishes checked-in code, observed public headers, and a proposed split measured offline. No routing, security policy, or payload has changed.

## 1. Route and header ownership

[`wrangler.jsonc`](../../wrangler.jsonc#L8-L17) maps `cyber.askgina.ai` to the Worker and binds `site/` as `ASSETS`. The exact `run_worker_first` list is `/`, `/index.html`, `/e`, `/data.json`, `/archive.json`, `/__build`, `/api/search`. Query strings do not change the path match. [`site/.assetsignore`](../../site/.assetsignore) excludes both JSON files from the asset upload. There is no `site/_headers`, `_redirects`, or configured SPA fallback. See Cloudflare's [Worker routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/), [HTML handling](https://developers.cloudflare.com/workers/static-assets/routing/advanced/html-handling/), and [asset headers](https://developers.cloudflare.com/workers/static-assets/headers/).

| Path | Does `worker/index.js` run? | Response and header owner |
| --- | --- | --- |
| `/` | **Worker-first** | The Worker schedules page-load analytics only for document `GET`s, then returns `env.ASSETS.fetch(req)` unchanged. `ASSETS` serves HTML with `Content-Type: text/html`, `Cache-Control: public, max-age=0, must-revalidate`, and a static asset `ETag`. The edge also reports `CF-Cache-Status` in the probe. |
| `/index.html` | **Worker-first** | The same analytics check and passthrough apply. Default asset canonicalization sends `307` with `Location: /` for the probed request, not a second copy of the HTML. |
| `/index`, `/index/` | No for the asset-router redirects (not Worker-first) | `307` with `Location: /` and `Location: /index`, respectively, in the probes. The final `/` request runs the Worker. |
| `/styles.css` | No, matching asset goes straight to the asset router | Static defaults as for `/` except `Content-Type: text/css` and an asset-specific validator. |
| `/app.js`, `/term.js`, `/board.js`, `/palette.js`, `/track.js` | No, matching assets go straight to the asset router | All five return `Content-Type: text/javascript`, the same default cache policy, their own `ETag`, and `CF-Cache-Status: HIT` in the probes. This includes the routing of the `?v=` references in HTML. |
| `/data.json`, `/archive.json` | **Worker-first** | `DATA` maps the path to an R2 `STATE` object. The Worker streams the body with `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-cache`, and `ETag: o.httpEtag`. It does not check `If-None-Match` itself. If the key is missing, it returns `503` and `Not built yet` (plain text), with no application cache header or validator. There is no static fallback. |
| `/e` | **Worker-first** | `POST` returns an empty `204` for accepted, ignored, malformed, or rate-limited events. The code sets no response headers. Other methods fall through to `ASSETS`; `HEAD` returns `404`. |
| `/api/search` | **Worker-first** | `Response.json`, `Content-Type: application/json`. A normalized query shorter than three characters returns `200` with empty results and no explicit cache header. Success for longer queries has `Cache-Control: public, max-age=300`, also on the cached response. The `429` and `502` JSON branches set no explicit cache header. The handler does not restrict methods. |
| `/__build` | **Worker-first** | An authorized `POST` returns JSON (`200` on success, `500` on exception), with no explicit cache header. Other requests return `403` plain text (`text/plain;charset=UTF-8` in the `HEAD` probe), with no explicit cache header. |
| Unknown paths, including `/favicon.ico`; the proposed split paths do not exist yet | Asset lookup first, then Worker on a miss | The Worker falls through to `ASSETS`. No matching file or configured fallback means `404`; there were no application headers on the `/favicon.ico` probe. The real favicon is a `data:` URL. |

The view names `#terminal`, `#leaderboard`, `#report`, report section anchors, and `#e-…` links are fragments, not HTTP routes. [`term.js:12–36`](../../site/term.js#L12-L36) handles them in the browser. The cron trigger (`7 * * * *`) and internal `http://builder` requests do not share this public route table. The Worker calls `POST /run`, `GET /out/{data.json,archive.json,state.tar.gz,search/manifest.json}` and `POST /out/search/bundle` through the container binding. The container also has `GET /health`. Its `_send()` sets `Content-Type` (JSON by default, `application/gzip` for the state tarball) and `Content-Length`; Python's HTTP handler adds `Server` and `Date`. Those internal response headers are not forwarded with the public JSON. See [`worker/index.js:26–43, 75–101, 173–226`](../../worker/index.js) and [`container/server.py:80–123`](../../container/server.py#L80-L123).

### Public HEAD comparison

Command (no redirect following or compression negotiation):

```sh
for path in / /styles.css /data.json; do
  printf '\n%s\n' "$path"
  curl -sI "https://cyber.askgina.ai$path"
done
```

All three returned `HTTP/2 200`, `Date: Wed, 25 Nov 2026 10:36:11 GMT`, and `Server: cloudflare`. The other returned headers were:

| Header | `/` | `/styles.css` | `/data.json` |
| --- | --- | --- | --- |
| `Content-Type` | `text/html` | `text/css` | `application/json; charset=utf-8` |
| `Cache-Control` | `public, max-age=0, must-revalidate` | `public, max-age=0, must-revalidate` | `no-cache` |
| `ETag` | `"6232af3804f3b0364066b742fdc488ac"` | `"18542558f51b1aa52ab675b54379fa8c"` | `"53ceb9d2d347d1fed26819a0c7e078b7"` |
| `CF-Cache-Status` | `HIT` | `HIT` | absent |
| `CF-Ray` | `a60002cb0b74c198-LHR` | `a60002cbdd14f65f-LHR` | `a60002cd299ddb2e-LHR` |

The HTML `HIT` reflects asset delivery, not a bypass of the configured Worker. A `HEAD` request does not exercise the page-load analytics branch. Supplemental `HEAD` requests checked the canonical redirects, all five JS files, `/archive.json`, `/favicon.ico`, `/e`, `/api/search` without a query, and `/__build`. No POST requests were made. The three primary probes had no `Content-Encoding`, CSP (enforcing or report-only), `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `Strict-Transport-Security`, CORS allow-origin, or `Set-Cookie` header.

**Placement consequence:** header mutations in `worker/index.js` cannot affect direct CSS/JS hits. Asset header rules can cover static responses, including HTML returned unchanged through `ASSETS.fetch`, but not Worker-created R2/API/build/event responses. Any required headers on those branches must be set separately. Check the canonical document response itself; putting CSP on the CSS or JSON response does not apply it to the page.

## 2. Browser CSP inventory

### Scripts, handlers and HTML parsing

| Construct | Inventory and consequence |
| --- | --- |
| Inline `<script>` | Exactly one, [`index.html:7–22`](../../site/index.html#L7-L22). The theme IIFE reads `localStorage['bl-theme']` before first paint, sets `data-theme`, syncs accessibility state at `DOMContentLoaded`, and delegates theme clicks. No nonce or existing hash policy. The exact checked-in block body (including surrounding newlines) has CSP source `'sha256-LC40C6vnbrlzqFhv1ZiETuSN8ofe5uAomhg8r+ncClU='`. Hash the deployed bytes if using a hash. If externalizing, preserve pre-paint behavior and the theme command in the palette. |
| External `<script>` | Five same-origin, versioned classic scripts at [`index.html:275–279`](../../site/index.html#L275-L279), in this order: `app.js`, `term.js`, `board.js`, `track.js`, `palette.js`. No third-party script tags, dynamic script loading, or inline script injected by these files. |
| Inline event attributes | Zero static `on*=` attributes, zero generated string event attributes, and no hard-coded `javascript:` URL. Listeners use `addEventListener`, except [`app.js:616`](../../site/app.js#L616) sets `#g-more.onclick` to a JS function. That assignment is not inline handler source and does not need a CSP exception. `BL.onRender` and `BL.onTick` are ordinary JS callbacks. |
| `eval` / `Function` constructor | None in the browser code or Worker. Browser timers take functions; `new RegExp` in `palette.js` does not evaluate JS. No `unsafe-eval` dependency found. |
| `innerHTML` (two assignments) | [`app.js:11`](../../site/app.js#L7-L15): shared `el()` assigns `n.innerHTML` when an `html` attribute is supplied. Its only caller with `html:` is `entry()` at line 192. `render()` supplies escaped news titles and escaped X/crypto/breach/KEV titles or names with fixed amount/label markup. [`app.js:329`](../../site/app.js#L327-L330): `render()` assigns `#abstract.innerHTML` from a template with `<b>` counters and an escaped largest-loss name. No `outerHTML`, `insertAdjacentHTML`, or `document.write`. Neither assignment requires `unsafe-inline`, but both need attention if enforcing Trusted Types. Prefer text nodes and explicit elements; verify URL scheme checks separately for source links. |

### Inline styles: 11 attribute sites, plus three CSSOM writes

`index.html` has **zero** `style="…"` attributes and no `<style>` block. This does **not** make `style-src-attr 'none'` safe today. The shared [`el()`](../../site/app.js#L7-L15) passes each non-null `style` to `setAttribute('style', value)`. Terminal uses the same helper (`B.el`). These are real inline style attributes even though a same-origin script creates them.

| Source | Element and value | UI affected |
| --- | --- | --- |
| [`app.js:274`](../../site/app.js#L274), `drawPatterns()` | `td.bar > i`: `width: (p.total / max) * 100%` | Report attack-pattern bars |
| [`app.js:310`](../../site/app.js#L310), `barTable()` | `td.bar > i`: `width: (count / max) * 100%` | Report ransomware groups, sectors, and countries |
| [`app.js:349`](../../site/app.js#L349), `render()` | `.cells > i`: nonzero counts set `--w` to `max(18, sqrt(n / max) * 100)%`; zero passes `null` | Report 30-day series |
| [`app.js:353`](../../site/app.js#L353), `render()` | `.axis` last `span`: literal `text-align:right` | Report 30-day caption |
| [`app.js:511`](../../site/app.js#L511), `drawLive()` | `.cells.h24 > i`: nonzero bins set `--w` to `max(22, sqrt(count / max) * 100)%`; zero passes `null` | Report hourly chart |
| [`app.js:626`](../../site/app.js#L626), `drawGlance()` | `.gb > i`: `--w` with a 4% minimum | Report Today pattern bars |
| [`term.js:211`](../../site/term.js#L211), `drawAct()` | `.hc > i`: `--v` with a 0.18 minimum for nonzero bins, otherwise `0` | Terminal hourly activity; `styles.css:440` tests `.hc i[style*="--v:0"]`, so migrate that selector too if using a class |
| [`term.js:219`](../../site/term.js#L219), `drawAct()` | `.c-bar > i`: `--w` ratio to maximum | Terminal Today pattern bars |
| [`term.js:275`](../../site/term.js#L275), `drawArchive()` | `.t-amon .bar > i`: `--v` with a 0.06 minimum for nonzero bins, otherwise `0` | Terminal YTD month bars |
| [`term.js:316`](../../site/term.js#L316), `drawMkt()` | `.c-bar > i`: `--w` ratio to largest group | Terminal ransomware group bars |
| [`term.js:318`](../../site/term.js#L318), `drawMkt()` | `.c-bar > i`: `--w` ratio to largest sector | Terminal ransomware sector bars |

There are also direct CSSOM writes: `showPop()` sets `#ask-pop.style.left` and `.top` to pixel positions ([`app.js:445–446`](../../site/app.js#L437-L448)); `drawTape()` calls `tape.style.setProperty('--dur', …)` for the ticker duration ([`term.js:135`](../../site/term.js#L131-L136), consumed at `styles.css:385`). These can serialize as `style` attributes in the DOM, but browsers apply per-property writes differently from `setAttribute('style', …)` or `style.cssText` under CSP. There is no `cssText` write. Test per-property writes as well as any replacement for the 11 string-attribute sites under the actual policy. `board.js`, `palette.js`, and `track.js` create no inline styles. `styles.css` uses external rules, custom properties and font-family names, with no `@import`, `@font-face`, or `url()` resource loads of its own.

### Origins and schemes, by use

All hosts below use `https://` unless stated otherwise. A navigation link is not a script, image, or Fetch dependency. Do not copy the link inventory into `connect-src`.

| Use | Origin or scheme | Evidence |
| --- | --- | --- |
| Same-origin scripts, CSS, application Fetch and beacon | `'self'` (`cyber.askgina.ai` on the public site) | `index.html:29,275–279`; `app.js:677` (`data.json`); `term.js:234` and `board.js:49` (`archive.json`); `palette.js:75` (`/api/search`); `track.js:9–10` (`/e`). The canonical site URL embedded in Perplexity prompts and the citation is text, not an extra fetch. |
| Font stylesheet and connection hint | `fonts.googleapis.com` | `index.html:25,27`; `/css2` requests Geist, IBM Plex Mono and Instrument Serif. Relevant to stylesheet loading. |
| Font binaries and cross-origin connection hint | `fonts.gstatic.com` | `index.html:26` (`preconnect` with `crossorigin`); Google stylesheet loads the binaries here. Relevant to `font-src`. |
| Image resource | `data:` | `index.html:28` SVG favicon. The percent-encoded `http://www.w3.org/2000/svg` namespace is not a network request. No separate favicon fetch is needed for this icon. |
| Browser Fetch | `api.llama.fi`, `haveibeenpwned.com` | `app.js:649–674,699–702`: `/hacks` on startup and every two minutes; `/api/v3/breaches` after four seconds and then every ten minutes. Manual refresh calls both. Both feeds are cross-origin `connect-src` dependencies. HIBP is also an outbound source link. |
| Ask and X search navigations | `www.perplexity.ai`, `x.com` | `app.js:4–25,45–49,455`, `term.js:382`, `palette.js:50`: anchor or `window.open` to Perplexity search. `app.js:21,362` and generated record links navigate to X search/posts. `track.js:46` matches `perplexity.ai` in hrefs; it does not contact it. No X or Perplexity embed or programmatic fetch. |
| Other hard-coded browser navigations | `www.cisa.gov`, `www.ransomware.live`, `defillama.com`, `hacked.slowmist.io`, `rekt.news`, `haveibeenpwned.com`, `therecord.media`, `thehackernews.com`, `www.bleepingcomputer.com`, `databreaches.net`, `krebsonsecurity.com`, `smartcontractshacking.com`, `securityalliance.org`, `axis-intelligence.com`, `cyberzenpulse.com`, `cybermap.kaspersky.com`, `www.fortiguard.com`, `attackmap.sonicwall.com`, `www.defconlevel.com`, `cwe.mitre.org` | Static source/tracker anchors at `index.html:237–251`; CWE details, group links and feed fallbacks in `app.js`, `term.js` and `board.js`. `nvd.nist.gov` is also a generated link from `pipeline/build_data.py:46` and the archive build. |
| Data-supplied links | Variable external origins | Sources, articles and coverage timelines, X posts/history/post-mortems, notices, guidance sources, crypto and KEV references, ransomware rows and archive records. The browser assigns these to `href` or opens them on user action, not as subresources. E.g. `app.js:30–38,90–156,478–496,635`, `term.js:51–59,139–143,332–346`, `board.js:56–110,247–269`. See the snapshot inventory below. |
| Worker egress | `eu.i.posthog.com`; internal `http://builder` | `worker/index.js:29–37,68–69,75–95,164–169`. PostHog receives server-side analytics only if configured. R2, Analytics Engine, and AI Search are Worker bindings, not browser origins. |
| Container and pipeline egress | `codeload.github.com`; `www.cisa.gov`, `api.ransomware.live`, `www.ransomware.live`, `api.llama.fi`, `hacked.slowmist.io`, `haveibeenpwned.com` | `container/server.py:12,23–28` downloads the build source. `pipeline/build_data.py` pulls the catalogs/API and stats; `pipeline/archive.py` reuses them or fetches them for backfill. These requests do not depend on browser CSP. |
| Pipeline RSS/Atom | `therecord.media`, `feeds.feedburner.com`, `databreaches.net`, `rekt.news`, `www.bleepingcomputer.com`, `krebsonsecurity.com`, `www.securityweek.com`, `www.darkreading.com`, `cyberscoop.com`, `www.helpnetsecurity.com`, `www.infosecurity-magazine.com`, `techcrunch.com`, `www.scworld.com`, `securityaffairs.com`, `www.csoonline.com`, `blog.cloudflare.com` | `build_data.py:146–181`. `http://www.w3.org/2005/Atom` is an XML namespace, not egress. |
| Other pipeline helpers | `news.google.com`, `clients5.google.com`, `api.mymemory.translated.net`, `oag.ca.gov`, `www.atg.wa.gov`, `justice.oregon.gov`, `ocrportal.hhs.gov`, `efts.sec.gov`, `apps.web.maine.gov` | Delegated Google News searches (`gnews.py`), translation (`translate.py`), and official disclosures (`official.py`). `www.sec.gov` is a generated EDGAR link in `official.py`, not the SEC search endpoint. |

The source inventory does not assume what an external navigation or an upstream request may redirect to. The browser code has no third-party frames, web workers, WebSockets, or event streams.

## 3. `data.json` consumers

[`build_data.py:543–583`](../../pipeline/build_data.py#L543-L583) produces the full dataset. It writes JSON with `indent=1` and the default ASCII escaping. [`app.js:675–703`](../../site/app.js#L675-L703) fetches the full file at startup, on manual refresh, and every five minutes with `cache: 'no-store'`. It stores the object as `D0`/`BL.D`, exposes `BL.DET`, `BL.LABEL`, `BL.events()` and `BL.LIVE.today`, and calls `BL.onRender(D0)`. Report rendering currently runs even when hidden. Terminal builds a record index (`IX`) and exposes `BL.index()`. Board wraps `BL.onRender` after Terminal. Palette does not fetch or read `data.json` directly: `results()` and `openRecord()` use the Terminal index, `semSearch()` calls the same-origin search endpoint, and the refresh command calls `BL.pollAll()`.

`—` means no key-level read in that file. An index consumer can open a record and invoke the Terminal/shared detail renderer; that is not a separate read of `D`. `worker/index.js` serves and copies the whole file opaquely in `fetch()`/`buildOnce()` for **every** key; the last column identifies only fields parsed by `emitStats()` (when `POSTHOG_KEY` is set). The container also stages, restores and serves the file as a whole; its only explicit key read is `generated`. `track.js` uses the id-to-kind index on record opens, not the payload itself.

| Top-level key | `site/app.js` | `site/term.js` | `site/board.js` | `site/palette.js` | `pipeline/search_docs.py` | `container/server.py` | `worker/index.js` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `generated` | `render()` timestamps, status and citation; `drawGlance()` date; `tick()` age; `pollHIBP()` cutoff; `pollData()` change detection; `BL.D` readiness | `BL.onTick()` rebuild age | `fill()` KPI date and `boot()` archive-failure fallback | — | — | `run()` build result | — (logs `res.generated` from the container) |
| `errors` | `render()` partial-source status | — | — | — | — | — | — |
| `kev` | `render()` counts, ransomware-linked count, series and entries; `events()` feed; `drawGlance()` hits; `detailPanel()` item facts | `index()`, `windows()`, `drawMkt()`; `drawFeed()`/`drawHit()` via `app.js` | — | `results()`/`openRecord()` via `IX` (CVE/name/description/date/id) | — (KEV is indexed from archive `A`) | — | — (`windows.rows.kev` instead) |
| `ransomware` | `render()` counts, coverage, series and group/sector/country tables; `drawGlance()` `items_24h` and named-victim rows | `windows()` `items_24h`; `drawMkt()` 7-day group/sector counts; `drawHit()` via `LIVE.today` | — | — (no live ransomware index; YTD is separate) | — | — | — (`windows.rows.ransomware` instead) |
| `crypto` | `render()` counts/USD/series/items; `events()` feed; `drawGlance()` hits; `pollLlama()` dedup; `detailPanel()` facts and links | `index()`, `windows()`, `drawMkt()`; feed/hits via `app.js`; `inspect()` also remaps crypto-linked news | `buildRows()` merges `items` with YTD archive by normalized name/date; `openRow()` passes item to shared detail | `results()`/`openRecord()` via `IX` (name/description/date/id) | — (crypto indexed from `A`) | — | — (`windows.rows.crypto` instead) |
| `news` | `render()` headlines/count/list; `events()` feed; `drawGlance()` hits and brief dates; `detailPanel()` outlet timeline; report filters search item JSON | `index()`; feed/hits via `app.js`; `inspect()` news-to-crypto redirect | — | `results()`/`openRecord()` via `IX` (title/summary/date/id) | `records()`: first 1,500 news rows, `date`, `title`, `eid`, `summary`, `source`, `url` | — | `emitStats()`: distinct `source` count and array length |
| `news_headlines_7d` | — | — | — | — | — | — | — |
| `registry` | `drawGlance()` curated records and follow-ups, dedup via `match`/`org` and `stories`; `detailPanel(kind='inc')` facts, sources and timelines when called by Terminal | `index()` (including `affected` for search), `windows()`, `drawMkt()` (7d); `drawHit()` via `LIVE.today` | — | `results()`/`openRecord()` via `IX` (org/title/summary/affected/date, `r-` id) | — (curated incidents indexed from `A.items[].rec`) | — | `emitStats()`: `country` |
| `notices` | `events()` feed (`url`, `org`, `date`, `kind`, `title`, `source`); `drawGlance()` recent official notices | `windows()` recent counts; `drawFeed()`/`drawHit()` via `app.js` | — | — (archive notice/SEC refs handled separately) | — (notices and SEC indexed from `A`) | — | — (`windows.rows.notices` instead) |
| `triage_n` | — | — | — | — | — | — | — |
| `x` | `render()` signal list; `events()` feed; `drawGlance()` hits/cross-matches; `xFor()`/`detailPanel()` corroboration, posts, history and links | `index()`, `drawX()`; feed/hits via `app.js` | `openRow()` indirectly via shared `detailPanel()` → `xFor()` for crypto corroboration | `results()`/`openRecord()` via `IX` (subject/claim/date/id) | `records()`: `date`, `subject`/`project`, `eid`, `claim`, `stage`, `score`, `posts[].{url,role,stance,note}` | — | `emitStats()`: signal count and sum of `posts.length` |
| `breaches` | `render()` totals and entries; `events()` feed; `drawGlance()` hits; `pollHIBP()` dedup by item name; `detailPanel()` item facts | `index()`, `windows()`, `drawMkt()`; feed/hits via `app.js` | — | `results()`/`openRecord()` via `IX` (title/description/added/id) | — (breaches indexed from `A`) | — | — (`windows.rows.breach` instead) |
| `hourly` | `drawLive()` report chart | `drawAct()` activity bins (`t`, `ransomware`, `news`, `x`) | — | — | — | — | — |
| `windows` | — | `windows()` reads `rows.{crypto,ransomware,kev,breach,incidents,notices,archive}` per interval; combines live and server counts; `drawKpi()` uses `archive.ytd.dup` and crypto `top` | — | — | — | — | `emitStats()`: `rows.*.ytd` for archive `n`; crypto `n`/`usd`; ransomware/KEV/incidents/notices `n`; breach `n`/`acc` |
| `brief` | `drawGlance()` headline and incidents, matching, age and follow-up flags | `drawHit()` and `drawAct()` via `LIVE.today` | — | — | — | — | — |
| `details` | `render()` sets `DET`; `entry()` primary tag/count; `matches()` filters; `drawGlance()` tags/brief lookup; `detailPanel()` analysis, patterns, related, cluster, CWE and precedents; `breakdownURL()` related titles | `inspect()` reads `B.DET[id]` into an unused local; uses `breakdownURL()` and `detailPanel()` for the actual UI | `openRow()` uses shared `detailPanel()` for live crypto records | — (record open delegates to Terminal) | — | — | — |
| `clusters` | `drawClusters()` related-incident groups, member links and labels | — | — | — | — | — | — |
| `patterns` | `render()` common-pattern prose; `drawPatterns()` counts, bars and filter buttons | — (uses today's derived patterns, not this key) | — | — | — | — | — |
| `pattern_defs` | `render()` builds `LABEL` (id → label) for detail chips, entries, filters, and Today | `drawHit()` and `drawAct()` read `B.LABEL` | — | — | — | — | — |

Key references: [`app.js`](../../site/app.js) (`render:318`, `events:478`, `drawGlance:519`, polling and `BL:649–722`); [`term.js`](../../site/term.js) (`index:39`, `windows:66`, `drawMkt:292`, inspector/index export `332–363`, render hook `426`); [`board.js`](../../site/board.js) (`buildRows:56`, `openRow:247`, `boot:291`); [`palette.js`](../../site/palette.js) (`results:30`, `openRecord:59`, `semSearch:68`); [`search_docs.py:16–47`](../../pipeline/search_docs.py#L16-L47); [`server.py:49–77`](../../container/server.py#L49-L77); [`worker/index.js:48–70`](../../worker/index.js#L48-L70).

- `kev.total_catalog`, `crypto.history_size`, and `windows.bounds` have no field-level readers in the above files. Neither do `windows.rows.news` and `.x`. Terminal intentionally recomputes its 1-hour/24-hour cards; the build's longer-window counts are not substitutes for the item lists.
- `windows.rows.archive` and `windows.rows.notices.ytd` are absent in this `data.json` snapshot. Both are conditional writer output ([`build_data.py:513–539`](../../pipeline/build_data.py#L513-L539)) and have readers. The byte tables report what is in the snapshot, not zero-byte placeholders for possible fields.
- Separate archive consumers: `term.loadArchive()` starts on the YTD tab, a terminal query of at least three characters, or an initial deep-link miss. `palette.openRecord()` can request it to resolve a semantic result (`r-…` or `a:<type>|<date>|<org>|<title>|<url>`). **Board already fetches `/archive.json` at boot even when hidden.** `board.boot()` and its `onRender` wrapper do not check the view. `search_docs.main()` also reads the archive server-side; Worker stats read archive `items[].x` as well as `D.registry[].country`.

## 4. Exact byte profile

Input: checked-in `site/data.json`, `generated = 2026-11-24T19:12:13Z`, SHA-256 `28e6f53b6a48c7dd88312a78f1b304d7c4881217b50ee10506b64f68d0b90ffd`. This is not the live R2 body. The separate checked-in `site/archive.json` has the same `generated` and SHA-256 `190209da7f87edff32baa7966499a463fa29f7e3530464e3ee01806377dac186`.

- **Raw** is the checked-in file, as bytes. **Compact** is Python JSON with UTF-8, `ensure_ascii=False`, `separators=(',', ':')`, original key order, no final newline. The ASCII-escaped compact variant is **7,640,556 B**, **2,358,475 B** gzip; the tables use the UTF-8 variant.
- For a member, count the exact span from the opening quote of the key to the end of the value. It includes the key, colon, and all bytes inside the value, but excludes surrounding indentation and the following comma. The top-level framing row accounts for the omitted braces, commas and whitespace.
- Gzip is GNU gzip 1.12, `gzip -n -9 -c`. The whole-file rows compress full valid documents. Each key or subkey row compresses its own bytes as one independent gzip stream. For repeated paths, join the spans with `,` + LF (raw) or `,` (compact) before compressing. The byte counts before compression exclude those join separators. **Do not add gzip rows** to infer file size or per-field wire cost. Nested rows are subsets of their parents, not additional bytes.
- `[]` in a path denotes all elements of an array. `details.*` groups the 1,378 dynamic record-id keys, and the table includes their nested members. `Members` counts occurrences of the key (a key with an array value counts once per parent, not once per element). The full size of positional tuples or scalar arrays is charged to the containing key; they have no named subkeys. See [subkey tables](#appendix-a-subkey-byte-tables).

| Key | Members | Raw | Compact | Gzip raw | Gzip compact |
| --- | ---: | ---: | ---: | ---: | ---: |
| `generated` | 1 | 35 | 34 | 55 | 54 |
| `errors` | 1 | 100 | 94 | 110 | 105 |
| `kev` | 1 | 61,937 | 53,528 | 7,727 | 7,547 |
| `ransomware` | 1 | 9,808 | 7,823 | 3,359 | 3,286 |
| `crypto` | 1 | 152,225 | 131,774 | 50,590 | 50,314 |
| `news` | 1 | 2,760,093 | 2,427,759 | 968,602 | 964,292 |
| `news_headlines_7d` | 1 | 25 | 24 | 45 | 44 |
| `registry` | 1 | 2,780,850 | 2,425,158 | 833,389 | 825,627 |
| `notices` | 1 | 56,098 | 50,634 | 12,177 | 12,037 |
| `triage_n` | 1 | 15 | 14 | 35 | 34 |
| `x` | 1 | 956,859 | 771,268 | 174,924 | 167,637 |
| `breaches` | 1 | 10,045 | 8,467 | 3,093 | 3,038 |
| `hourly` | 1 | 2,075 | 1,448 | 241 | 217 |
| `windows` | 1 | 2,109 | 1,174 | 505 | 444 |
| `brief` | 1 | 5,977 | 5,151 | 2,224 | 2,176 |
| `details` | 1 | 1,907,480 | 1,559,866 | 349,927 | 331,638 |
| `clusters` | 1 | 10,741 | 8,657 | 3,525 | 3,446 |
| `patterns` | 1 | 2,921 | 2,078 | 739 | 701 |
| `pattern_defs` | 1 | 1,033 | 806 | 388 | 363 |
| Top-level framing | — | 59 | 20 | — | — |
| **Whole `site/data.json`** | **19 keys** | **8,720,485** | **7,455,777** | **2,407,207** | **2,368,687** |

## 5. Measured 7-day split (proposal, not deployed)

A time filter alone is not enough: all 1,005 news rows and all 266 active X signals already qualify. Keep list and KPI fields hot; move detail-only fields and older records off the startup path. These sizes come from serializing the projected objects, not applying an estimated compression ratio.

### Partition and sizes

Use the snapshot's `generated` as the clock. The inclusive cutoff is **2026-11-17T19:12:13Z** (seven days before `generated`). Interpret bare dates at 23:59:59 UTC for split eligibility. When two fields are listed, either one can qualify the row. This retains recently listed crypto/KEV and recent developments on older registry/X records. The notice timestamps in this snapshot are already full ISO timestamps.

| List | Time field(s) | Hot rows | Older rows | Retained list bytes in hot (UTF-8 compact value only) |
| --- | --- | ---: | ---: | ---: |
| `news` | `date` | 1,005 | 0 | 183,784 |
| `x` | `last` or `date` | 266 | 0 | 147,217 |
| `registry` | `latest` or `first_reported` | 533 | 122 | 321,604 |
| `crypto.items` | `date` or `listed_at` | 17 | 43 | 4,013 |
| `kev.items` | `date` or `listed_at` | 14 | 25 | 3,533 |
| `breaches.items` | `added` | 3 | 5 | 785 |
| `notices` | `date` | 30 | 70 | 15,639 |
| **Lists subtotal** | | **1,868** | **265** | **676,575** |

- **Hot:** Keep the counters and series outside `items`, `hourly`, `windows`, `brief`, `patterns`, `pattern_defs`, `errors`, `generated`, `news_headlines_7d`, `triage_n`, and all of `ransomware` (including the 24-hour list). These total **19,806 B**, including the wrapper bytes outside the three `items` arrays but excluding top-level keys and framing. Project the six record lists with the field sets in the reproducer; keep full hot notices. Add **94,846 B** for `registry_aliases` (2,725 distinct lowercase aliases used in Report Today dedup) and **77,099 B** for the summary `details` map (1,305 keys, `patterns` and `related_n` only). To preserve `drawGlance()`, hot registry stories carry `eid`/`title` and hot updates carry only the last text. X carries match `eid`s and `posts_n`, not full match or post bodies.
- **Details:** Store the full `D.details` map plus `records` keyed by `eid` (or `r-` + registry `id`). For each of the 1,838 projected hot rows, store omitted fields here, including original values of any projected nested arrays. Examples are news summaries, source URLs and outlet timelines, registry evidence/updates/affected lists, X posts/history, and full crypto/KEV/breach inspector fields. Older rows are already full in History. Details carries the same `generated` as Hot.
- **History:** Store all 265 older rows, `clusters`, the same `generated`, and the original zero-based positions of older rows. Hot and older subsets each keep source order. History covers the remainder of the existing `data.json` windows, not the YTD archive. Keep `/archive.json` separate so a Report or 30-day tab does not pay for YTD.

**Hot budget:** `676,575 + 19,806 + 94,846 + 77,099 + 225` (top-level keys and framing) `= 868,551 B`. This is **180,025 B below 1 MiB** (`1,048,576 B`). Here *raw HTTP body* means the uncompressed UTF-8 compact JSON emitted by this proposal, not a pretty-printed copy or gzip size.

| Proposed response | Uncompressed bytes | Exact gzip bytes | First load |
| --- | ---: | ---: | --- |
| `/data-hot.json` | **868,551** | **229,501** | Default Terminal boot; only this JSON is polled on the existing five-minute schedule |
| `/data-details.json` | **6,623,676** | **2,201,959** | First inspector/expanded detail or a Report/text-search action requiring full row text/links; share one in-flight fetch per generation |
| `/data-history.json` | **321,902** | **84,282** | First older-record link, related groups, Report lists beyond the hot window, or Crypto/KEV/HIBP tab requiring its full 30-day list |
| `/archive.json` (unchanged file) | **4,362,882** | **983,253** | YTD tab/search, an archived result, or entry to Leaderboard; gate `board.boot()` so hidden Board no longer fetches it |

The reproducer also restores all original rows and subkeys and checks equality with the parsed monolith. This proves the budget for this fixture, not every future feed. The cold details file is still large. An id-addressed or sharded detail tier could reduce first-inspector cost later; those alternative sizes are not in the table. If a session loads all three split responses, it receives **7,814,129 B** uncompressed or **2,515,742 B** across the three gzip streams, excluding YTD. The gain is fewer startup bytes, not a smaller full download. The gzip numbers are local artifacts, not predictions of negotiated Cloudflare transfer sizes.

### Preserve behavior and enforce the cap

1. Publish only a matching generation of all three files. Stage them under versioned R2 keys, switch the current hot pointer only after every upload succeeds, and check that lazy responses match the current `generated`. Key lazy caches by generation. Otherwise a five-minute refresh can join different records or leave an open inspector stale. Add the new Worker-first paths, R2 mapping and application response headers when implementing the split.
2. Render Terminal from hot list fields and aggregates. Use the hot detail summaries for tags and related counts, and `registry_aliases` for brief dedup. Keep the 1-hour/24-hour recomputation and live Llama/HIBP polling. The visible live feed uses recent rows; derive the all-window feed count from the full build or update it when History loads. Avoid silently labeling hot-only lists or result counts as covering 30 days/YTD.
3. Resolve missing IDs through History and then the YTD archive. A known hot ID only needs Details when the inspector opens. Preserve `eid`, the `r-` prefix, crypto-linked news remapping, and full archive keys; do not build new IDs from filtered array offsets. Keep YTD dedup and all existing window totals. Keep palette title matches immediate and hydrate full-text matches when required. Render Report only upon entry; hydrate its current text/links and fetch older lists, groups and filters on demand, rather than during hidden startup. Rejoin rows by position when restoring the full pre-split list order.
4. Keep indexing, build metadata and `ledger_stats` on the full build object (or retain a server-only monolith during migration). The 1,500-news limit, X post provenance, country counts and YTD aggregates cannot be computed from trimmed rows alone. `pack_outputs()`, the Worker output mapping, and the browser loaders all need to change together; the full archive remains a distinct input.
5. Make `len(serialized_hot) <= 1_048_576` a build/publish assertion on actual UTF-8 bytes. Reject an oversize generation and keep the last known good generation available, with an alert. Do not drop current records silently to hit the cap. Test a default Terminal cold load (no Details, History or archive), each lazy trigger, old/new deep links and search refs, a five-minute refresh with an open inspector, and failure/retry. Compare counts and inspector content with the monolithic baseline.

## Appendix A. Subkey byte tables

Only keys present in the checked-in file are shown. Expand each table to see the complete named-field profile for that section.

<details>
<summary><code>kev</code> subkeys (21)</summary>

| Path | Members | Raw | Compact | Gzip raw | Gzip compact |
| --- | ---: | ---: | ---: | ---: | ---: |
| `kev.count_30d` | 1 | 15 | 14 | 35 | 34 |
| `kev.count_7d` | 1 | 14 | 13 | 34 | 33 |
| `kev.items` | 1 | 60,763 | 52,923 | 7,544 | 7,377 |
| `kev.items[].action` | 39 | 20,279 | 19,772 | 477 | 461 |
| `kev.items[].cwes` | 39 | 1,455 | 879 | 220 | 203 |
| `kev.items[].date` | 39 | 780 | 741 | 100 | 96 |
| `kev.items[].desc` | 39 | 11,611 | 11,566 | 3,970 | 3,964 |
| `kev.items[].due` | 39 | 741 | 702 | 111 | 108 |
| `kev.items[].eid` | 39 | 741 | 702 | 277 | 271 |
| `kev.items[].id` | 39 | 883 | 844 | 205 | 198 |
| `kev.items[].links` | 39 | 14,232 | 10,722 | 764 | 717 |
| `kev.items[].links[].label` | 117 | 1,755 | 1,638 | 69 | 65 |
| `kev.items[].links[].url` | 117 | 8,382 | 8,265 | 646 | 638 |
| `kev.items[].listed_at` | 39 | 753 | 714 | 80 | 78 |
| `kev.items[].name` | 39 | 3,218 | 3,179 | 1,228 | 1,222 |
| `kev.items[].product` | 39 | 1,085 | 1,046 | 440 | 437 |
| `kev.items[].ransomware` | 39 | 740 | 701 | 55 | 53 |
| `kev.items[].vendor` | 39 | 800 | 761 | 296 | 293 |
| `kev.ransomware_linked_30d` | 1 | 26 | 25 | 46 | 45 |
| `kev.series` | 1 | 1,064 | 520 | 161 | 135 |
| `kev.total_catalog` | 1 | 21 | 20 | 39 | 38 |

</details>

<details>
<summary><code>ransomware</code> subkeys (16)</summary>

| Path | Members | Raw | Compact | Gzip raw | Gzip compact |
| --- | ---: | ---: | ---: | ---: | ---: |
| `ransomware.count_24h` | 1 | 15 | 14 | 35 | 34 |
| `ransomware.count_30d` | 1 | 17 | 16 | 37 | 36 |
| `ransomware.count_7d` | 1 | 15 | 14 | 35 | 34 |
| `ransomware.countries_7d` | 1 | 241 | 93 | 104 | 90 |
| `ransomware.coverage_days` | 1 | 21 | 20 | 41 | 40 |
| `ransomware.groups_7d` | 1 | 280 | 132 | 141 | 128 |
| `ransomware.items_24h` | 1 | 7,741 | 6,778 | 2,900 | 2,875 |
| `ransomware.items_24h[].country` | 19 | 285 | 266 | 75 | 72 |
| `ransomware.items_24h[].date` | 19 | 570 | 551 | 150 | 145 |
| `ransomware.items_24h[].desc` | 19 | 2,749 | 2,721 | 1,403 | 1,404 |
| `ransomware.items_24h[].group` | 19 | 365 | 346 | 164 | 161 |
| `ransomware.items_24h[].sector` | 19 | 469 | 450 | 162 | 159 |
| `ransomware.items_24h[].url` | 19 | 1,620 | 1,601 | 712 | 707 |
| `ransomware.items_24h[].victim` | 19 | 678 | 659 | 387 | 384 |
| `ransomware.sectors_7d` | 1 | 330 | 182 | 179 | 162 |
| `ransomware.series` | 1 | 1,095 | 551 | 208 | 176 |

</details>

<details>
<summary><code>crypto</code> subkeys (31)</summary>

| Path | Members | Raw | Compact | Gzip raw | Gzip compact |
| --- | ---: | ---: | ---: | ---: | ---: |
| `crypto.count_30d` | 1 | 15 | 14 | 35 | 34 |
| `crypto.count_7d` | 1 | 14 | 13 | 34 | 33 |
| `crypto.history_size` | 1 | 20 | 19 | 40 | 39 |
| `crypto.items` | 1 | 151,028 | 131,150 | 50,363 | 50,105 |
| `crypto.items[].amount` | 60 | 949 | 889 | 229 | 221 |
| `crypto.items[].chains` | 60 | 2,211 | 1,446 | 386 | 363 |
| `crypto.items[].classification` | 60 | 2,071 | 2,011 | 247 | 243 |
| `crypto.items[].date` | 60 | 1,200 | 1,140 | 117 | 113 |
| `crypto.items[].desc` | 60 | 31,328 | 31,196 | 10,878 | 10,889 |
| `crypto.items[].eid` | 60 | 1,140 | 1,080 | 395 | 389 |
| `crypto.items[].first_press` | 10 | 370 | 360 | 134 | 129 |
| `crypto.items[].links` | 60 | 22,840 | 17,216 | 2,054 | 2,011 |
| `crypto.items[].links[].label` | 188 | 4,020 | 3,832 | 127 | 125 |
| `crypto.items[].links[].url` | 188 | 12,280 | 12,092 | 1,947 | 1,935 |
| `crypto.items[].listed_at` | 60 | 1,146 | 1,086 | 116 | 113 |
| `crypto.items[].n_outlets` | 10 | 145 | 135 | 61 | 59 |
| `crypto.items[].name` | 60 | 1,319 | 1,259 | 587 | 581 |
| `crypto.items[].outlets` | 10 | 72,703 | 65,490 | 32,734 | 32,775 |
| `crypto.items[].outlets[].date` | 150 | 4,500 | 4,350 | 779 | 768 |
| `crypto.items[].outlets[].source` | 150 | 3,550 | 3,384 | 831 | 822 |
| `crypto.items[].outlets[].title` | 150 | 12,100 | 11,923 | 3,991 | 3,984 |
| `crypto.items[].outlets[].title_orig` | 23 | 2,413 | 2,064 | 1,101 | 1,102 |
| `crypto.items[].outlets[].url` | 150 | 42,886 | 42,736 | 24,394 | 24,376 |
| `crypto.items[].returned` | 60 | 963 | 903 | 58 | 53 |
| `crypto.items[].slowmist_method` | 27 | 1,139 | 1,112 | 205 | 202 |
| `crypto.items[].sources` | 60 | 2,564 | 1,676 | 106 | 92 |
| `crypto.items[].target` | 60 | 1,304 | 1,244 | 167 | 164 |
| `crypto.items[].technique` | 60 | 2,001 | 1,941 | 458 | 453 |
| `crypto.series` | 1 | 1,064 | 520 | 168 | 141 |
| `crypto.usd_30d` | 1 | 23 | 22 | 43 | 42 |
| `crypto.usd_7d` | 1 | 20 | 19 | 40 | 39 |

</details>

<details>
<summary><code>news</code> subkeys (18)</summary>

| Path | Members | Raw | Compact | Gzip raw | Gzip compact |
| --- | ---: | ---: | ---: | ---: | ---: |
| `news[].crypto` | 54 | 1,188 | 1,134 | 142 | 137 |
| `news[].date` | 1,005 | 30,150 | 29,145 | 3,879 | 3,847 |
| `news[].eid` | 1,005 | 19,095 | 18,090 | 5,821 | 5,796 |
| `news[].lang` | 911 | 10,932 | 10,021 | 642 | 631 |
| `news[].latest` | 1,005 | 32,160 | 31,155 | 4,528 | 4,506 |
| `news[].n_outlets` | 1,005 | 14,186 | 13,181 | 806 | 799 |
| `news[].outlets` | 1,005 | 2,071,389 | 1,819,730 | 894,680 | 894,390 |
| `news[].outlets[].date` | 3,639 | 109,170 | 105,531 | 14,108 | 14,058 |
| `news[].outlets[].source` | 3,639 | 90,483 | 85,671 | 21,326 | 21,066 |
| `news[].outlets[].title` | 3,639 | 337,582 | 331,398 | 90,403 | 90,106 |
| `news[].outlets[].title_orig` | 1,708 | 271,748 | 177,362 | 62,106 | 58,233 |
| `news[].outlets[].url` | 3,639 | 1,088,810 | 1,085,171 | 622,533 | 622,286 |
| `news[].source` | 1,005 | 25,016 | 23,808 | 6,260 | 6,233 |
| `news[].summary` | 1,005 | 39,773 | 38,651 | 11,153 | 11,133 |
| `news[].title` | 1,005 | 92,962 | 91,336 | 34,899 | 34,768 |
| `news[].title_orig` | 295 | 51,608 | 32,687 | 16,511 | 15,758 |
| `news[].url` | 1,005 | 289,283 | 288,278 | 165,786 | 165,704 |
| `news[].via` | 911 | 18,220 | 17,309 | 114 | 108 |

</details>

<details>
<summary><code>registry</code> subkeys (55)</summary>

| Path | Members | Raw | Compact | Gzip raw | Gzip compact |
| --- | ---: | ---: | ---: | ---: | ---: |
| `registry[].actor` | 655 | 10,767 | 10,109 | 1,191 | 1,181 |
| `registry[].affected` | 146 | 17,114 | 15,188 | 6,276 | 6,197 |
| `registry[].age_days` | 655 | 10,342 | 9,687 | 1,338 | 1,310 |
| `registry[].country` | 655 | 10,143 | 9,488 | 882 | 863 |
| `registry[].event_date` | 655 | 14,398 | 13,743 | 996 | 985 |
| `registry[].exclude` | 62 | 2,048 | 1,728 | 651 | 632 |
| `registry[].first_reported` | 655 | 26,080 | 25,425 | 2,305 | 2,281 |
| `registry[].guidance` | 157 | 34,239 | 32,144 | 9,883 | 9,794 |
| `registry[].id` | 655 | 22,880 | 22,225 | 8,523 | 8,462 |
| `registry[].latest` | 655 | 20,460 | 19,805 | 2,286 | 2,247 |
| `registry[].match` | 655 | 130,746 | 101,422 | 37,842 | 36,750 |
| `registry[].n_outlets` | 655 | 9,231 | 8,576 | 502 | 489 |
| `registry[].notices` | 655 | 34,681 | 30,216 | 5,707 | 5,630 |
| `registry[].notices[].also` | 3 | 417 | 300 | 148 | 131 |
| `registry[].notices[].also[].source` | 3 | 75 | 72 | 50 | 48 |
| `registry[].notices[].also[].url` | 3 | 195 | 192 | 100 | 96 |
| `registry[].notices[].breach_date` | 47 | 1,069 | 1,022 | 169 | 163 |
| `registry[].notices[].count` | 47 | 623 | 576 | 101 | 97 |
| `registry[].notices[].date` | 47 | 1,410 | 1,363 | 138 | 137 |
| `registry[].notices[].kind` | 47 | 890 | 843 | 81 | 79 |
| `registry[].notices[].org` | 47 | 1,555 | 1,488 | 726 | 718 |
| `registry[].notices[].source` | 47 | 1,381 | 1,334 | 138 | 136 |
| `registry[].notices[].summary` | 47 | 7,816 | 7,733 | 2,844 | 2,842 |
| `registry[].notices[].title` | 47 | 3,452 | 3,389 | 874 | 869 |
| `registry[].notices[].url` | 47 | 3,878 | 3,831 | 1,375 | 1,367 |
| `registry[].org` | 655 | 19,089 | 18,324 | 7,850 | 7,794 |
| `registry[].outlets` | 655 | 1,173,227 | 1,038,987 | 497,860 | 497,898 |
| `registry[].outlets[].date` | 2,062 | 61,860 | 59,798 | 8,388 | 8,351 |
| `registry[].outlets[].source` | 2,062 | 51,838 | 49,141 | 12,944 | 12,827 |
| `registry[].outlets[].title` | 2,062 | 191,616 | 188,245 | 48,072 | 47,920 |
| `registry[].outlets[].title_orig` | 1,064 | 152,496 | 107,131 | 34,969 | 33,344 |
| `registry[].outlets[].url` | 2,062 | 615,822 | 613,760 | 351,055 | 350,848 |
| `registry[].payloads` | 133 | 21,204 | 19,808 | 6,605 | 6,545 |
| `registry[].records` | 655 | 10,057 | 9,402 | 697 | 684 |
| `registry[].sector` | 655 | 15,520 | 14,865 | 2,428 | 2,409 |
| `registry[].sources` | 655 | 264,439 | 221,313 | 69,165 | 67,208 |
| `registry[].sources[].label` | 1,639 | 59,719 | 57,565 | 15,189 | 15,068 |
| `registry[].sources[].url` | 1,639 | 151,626 | 149,987 | 50,256 | 50,124 |
| `registry[].status` | 655 | 13,949 | 13,294 | 536 | 527 |
| `registry[].stories` | 655 | 468,641 | 419,265 | 206,189 | 205,123 |
| `registry[].stories[].date` | 893 | 26,790 | 25,897 | 4,063 | 4,030 |
| `registry[].stories[].eid` | 893 | 12,735 | 11,842 | 2,482 | 2,470 |
| `registry[].stories[].n` | 893 | 5,410 | 4,517 | 565 | 542 |
| `registry[].stories[].source` | 893 | 22,703 | 21,609 | 5,907 | 5,892 |
| `registry[].stories[].title` | 893 | 84,115 | 82,674 | 28,470 | 28,393 |
| `registry[].stories[].url` | 893 | 258,999 | 258,106 | 147,199 | 147,129 |
| `registry[].summary` | 655 | 174,358 | 173,160 | 54,468 | 54,619 |
| `registry[].title` | 655 | 52,791 | 51,991 | 17,910 | 17,863 |
| `registry[].type` | 655 | 14,859 | 14,204 | 868 | 857 |
| `registry[].updates` | 655 | 100,026 | 88,748 | 29,445 | 28,979 |
| `registry[].updates[].date` | 308 | 7,694 | 7,386 | 962 | 955 |
| `registry[].updates[].text` | 308 | 43,909 | 43,406 | 15,379 | 15,348 |
| `registry[].updates[].url` | 308 | 29,084 | 28,776 | 11,339 | 11,317 |
| `registry[].usd` | 654 | 7,274 | 6,620 | 207 | 199 |
| `registry[].vector` | 655 | 19,222 | 18,537 | 4,625 | 4,599 |

</details>

<details>
<summary><code>notices</code> subkeys (12)</summary>

| Path | Members | Raw | Compact | Gzip raw | Gzip compact |
| --- | ---: | ---: | ---: | ---: | ---: |
| `notices[].also` | 7 | 917 | 714 | 214 | 196 |
| `notices[].also[].source` | 7 | 175 | 168 | 62 | 60 |
| `notices[].also[].url` | 7 | 469 | 462 | 156 | 152 |
| `notices[].breach_date` | 100 | 2,196 | 2,096 | 234 | 228 |
| `notices[].count` | 100 | 1,307 | 1,207 | 137 | 133 |
| `notices[].date` | 100 | 3,000 | 2,900 | 109 | 104 |
| `notices[].kind` | 100 | 1,966 | 1,866 | 94 | 91 |
| `notices[].org` | 100 | 3,188 | 3,044 | 1,437 | 1,421 |
| `notices[].source` | 100 | 3,059 | 2,959 | 162 | 161 |
| `notices[].summary` | 100 | 19,068 | 18,918 | 6,516 | 6,526 |
| `notices[].title` | 100 | 7,107 | 6,971 | 1,689 | 1,684 |
| `notices[].url` | 100 | 8,941 | 8,841 | 3,204 | 3,192 |

</details>

<details>
<summary><code>x</code> subkeys (56)</summary>

| Path | Members | Raw | Compact | Gzip raw | Gzip compact |
| --- | ---: | ---: | ---: | ---: | ---: |
| `x[].accounts` | 266 | 3,488 | 3,222 | 308 | 299 |
| `x[].age_h` | 266 | 3,634 | 3,368 | 636 | 627 |
| `x[].aliases` | 266 | 18,435 | 14,088 | 6,077 | 5,974 |
| `x[].amount_usd_claimed` | 266 | 6,954 | 6,688 | 165 | 163 |
| `x[].category` | 266 | 5,635 | 5,369 | 273 | 267 |
| `x[].claim` | 266 | 63,616 | 63,132 | 20,535 | 20,504 |
| `x[].credible` | 266 | 3,458 | 3,192 | 185 | 178 |
| `x[].date` | 266 | 7,980 | 7,714 | 1,247 | 1,231 |
| `x[].eid` | 266 | 5,054 | 4,788 | 1,581 | 1,573 |
| `x[].first` | 266 | 8,246 | 7,980 | 1,273 | 1,238 |
| `x[].history` | 266 | 96,497 | 72,402 | 13,330 | 12,947 |
| `x[].history[].by` | 516 | 11,664 | 11,148 | 2,924 | 2,903 |
| `x[].history[].eid` | 451 | 4,961 | 4,510 | 65 | 60 |
| `x[].history[].stage` | 516 | 10,257 | 9,741 | 467 | 457 |
| `x[].history[].t` | 516 | 13,926 | 13,410 | 2,253 | 2,232 |
| `x[].history[].url` | 516 | 27,636 | 27,120 | 7,826 | 7,778 |
| `x[].hours_to_confirm` | 266 | 6,351 | 6,085 | 296 | 289 |
| `x[].last` | 266 | 7,970 | 7,704 | 1,326 | 1,309 |
| `x[].links` | 266 | 89,761 | 75,342 | 24,840 | 24,327 |
| `x[].links[].label` | 532 | 21,334 | 20,564 | 6,055 | 6,016 |
| `x[].links[].url` | 532 | 48,539 | 48,007 | 17,169 | 17,134 |
| `x[].matches` | 266 | 8,622 | 6,617 | 659 | 619 |
| `x[].matches[].date` | 28 | 840 | 812 | 124 | 122 |
| `x[].matches[].eid` | 28 | 532 | 504 | 225 | 219 |
| `x[].matches[].kind` | 28 | 412 | 384 | 71 | 68 |
| `x[].matches[].label` | 28 | 561 | 533 | 108 | 106 |
| `x[].matches[].lag_h` | 5 | 64 | 59 | 51 | 49 |
| `x[].matches[].listed_at` | 28 | 566 | 538 | 88 | 85 |
| `x[].matches[].sources` | 14 | 659 | 407 | 84 | 74 |
| `x[].official` | 266 | 4,475 | 4,209 | 125 | 123 |
| `x[].outcome` | 266 | 3,990 | 3,724 | 67 | 60 |
| `x[].postmortem` | 266 | 8,972 | 8,160 | 1,782 | 1,757 |
| `x[].postmortem.auto` | 1 | 12 | 11 | 32 | 31 |
| `x[].postmortem.date` | 24 | 714 | 690 | 202 | 197 |
| `x[].postmortem.label` | 24 | 991 | 955 | 413 | 406 |
| `x[].postmortem.url` | 24 | 2,005 | 1,981 | 1,070 | 1,064 |
| `x[].posts` | 266 | 466,953 | 372,061 | 77,730 | 74,946 |
| `x[].posts[].date` | 1,393 | 41,790 | 40,397 | 6,111 | 6,059 |
| `x[].posts[].evidence` | 1,393 | 25,251 | 23,858 | 606 | 591 |
| `x[].posts[].handle` | 1,393 | 32,442 | 31,049 | 7,595 | 7,563 |
| `x[].posts[].note` | 1,393 | 122,096 | 119,079 | 30,080 | 29,858 |
| `x[].posts[].role` | 1,393 | 24,195 | 22,802 | 1,069 | 1,049 |
| `x[].posts[].stance` | 1,393 | 25,328 | 23,935 | 533 | 523 |
| `x[].posts[].url` | 1,393 | 85,344 | 83,951 | 22,048 | 21,911 |
| `x[].posts[].w` | 1,393 | 12,059 | 10,666 | 1,165 | 1,133 |
| `x[].press` | 266 | 53,546 | 43,111 | 13,925 | 13,622 |
| `x[].press[].date` | 253 | 7,590 | 7,337 | 1,298 | 1,281 |
| `x[].press[].eid` | 253 | 3,863 | 3,610 | 937 | 929 |
| `x[].press[].source` | 253 | 6,278 | 5,989 | 1,768 | 1,756 |
| `x[].press[].title` | 253 | 22,430 | 22,110 | 8,607 | 8,603 |
| `x[].press_lead_h` | 266 | 5,315 | 5,049 | 454 | 445 |
| `x[].project` | 266 | 8,354 | 8,070 | 3,250 | 3,241 |
| `x[].score` | 266 | 2,960 | 2,694 | 404 | 393 |
| `x[].stage` | 266 | 5,760 | 5,494 | 301 | 294 |
| `x[].stale` | 266 | 3,701 | 3,435 | 88 | 83 |
| `x[].subject` | 266 | 20,416 | 20,117 | 7,165 | 7,151 |

</details>

<details>
<summary><code>breaches</code> subkeys (17)</summary>

| Path | Members | Raw | Compact | Gzip raw | Gzip compact |
| --- | ---: | ---: | ---: | ---: | ---: |
| `breaches.accounts_30d` | 1 | 24 | 23 | 44 | 43 |
| `breaches.count_30d` | 1 | 14 | 13 | 34 | 33 |
| `breaches.items` | 1 | 9,980 | 8,416 | 3,060 | 3,008 |
| `breaches.items[].added` | 8 | 248 | 240 | 117 | 111 |
| `breaches.items[].breach_date` | 8 | 216 | 208 | 92 | 90 |
| `breaches.items[].classes` | 8 | 1,327 | 967 | 394 | 375 |
| `breaches.items[].count` | 8 | 123 | 115 | 88 | 84 |
| `breaches.items[].desc` | 8 | 4,602 | 4,514 | 2,012 | 2,023 |
| `breaches.items[].domain` | 8 | 177 | 169 | 111 | 108 |
| `breaches.items[].eid` | 8 | 152 | 144 | 98 | 94 |
| `breaches.items[].links` | 8 | 1,904 | 1,408 | 296 | 278 |
| `breaches.items[].links[].label` | 16 | 376 | 360 | 67 | 65 |
| `breaches.items[].links[].url` | 16 | 928 | 912 | 237 | 232 |
| `breaches.items[].name` | 8 | 141 | 133 | 107 | 104 |
| `breaches.items[].sensitive` | 8 | 143 | 135 | 47 | 45 |
| `breaches.items[].title` | 8 | 150 | 142 | 107 | 105 |
| `breaches.items[].verified` | 8 | 128 | 120 | 41 | 39 |

</details>

<details>
<summary><code>hourly</code> subkeys (4)</summary>

| Path | Members | Raw | Compact | Gzip raw | Gzip compact |
| --- | ---: | ---: | ---: | ---: | ---: |
| `hourly[].news` | 24 | 238 | 214 | 83 | 79 |
| `hourly[].ransomware` | 24 | 360 | 336 | 62 | 60 |
| `hourly[].t` | 24 | 648 | 624 | 112 | 109 |
| `hourly[].x` | 24 | 144 | 120 | 31 | 29 |

</details>

<details>
<summary><code>windows</code> subkeys (109)</summary>

| Path | Members | Raw | Compact | Gzip raw | Gzip compact |
| --- | ---: | ---: | ---: | ---: | ---: |
| `windows.bounds` | 1 | 182 | 153 | 111 | 100 |
| `windows.bounds.1h` | 1 | 28 | 27 | 48 | 47 |
| `windows.bounds.24h` | 1 | 29 | 28 | 49 | 48 |
| `windows.bounds.30d` | 1 | 29 | 28 | 49 | 48 |
| `windows.bounds.7d` | 1 | 28 | 27 | 48 | 47 |
| `windows.bounds.ytd` | 1 | 29 | 28 | 44 | 43 |
| `windows.rows` | 1 | 1,905 | 1,008 | 431 | 387 |
| `windows.rows.breach` | 1 | 271 | 141 | 117 | 102 |
| `windows.rows.breach.1h` | 1 | 40 | 20 | 45 | 38 |
| `windows.rows.breach.1h.acc` | 1 | 8 | 7 | 28 | 27 |
| `windows.rows.breach.1h.n` | 1 | 6 | 5 | 26 | 25 |
| `windows.rows.breach.24h` | 1 | 41 | 21 | 46 | 39 |
| `windows.rows.breach.24h.acc` | 1 | 8 | 7 | 28 | 27 |
| `windows.rows.breach.24h.n` | 1 | 6 | 5 | 26 | 25 |
| `windows.rows.breach.30d` | 1 | 48 | 28 | 54 | 48 |
| `windows.rows.breach.30d.acc` | 1 | 15 | 14 | 35 | 34 |
| `windows.rows.breach.30d.n` | 1 | 6 | 5 | 26 | 25 |
| `windows.rows.breach.7d` | 1 | 46 | 26 | 52 | 46 |
| `windows.rows.breach.7d.acc` | 1 | 14 | 13 | 34 | 33 |
| `windows.rows.breach.7d.n` | 1 | 6 | 5 | 26 | 25 |
| `windows.rows.breach.ytd` | 1 | 51 | 31 | 57 | 51 |
| `windows.rows.breach.ytd.acc` | 1 | 16 | 15 | 36 | 35 |
| `windows.rows.breach.ytd.n` | 1 | 8 | 7 | 28 | 27 |
| `windows.rows.crypto` | 1 | 602 | 361 | 221 | 195 |
| `windows.rows.crypto.1h` | 1 | 40 | 20 | 45 | 38 |
| `windows.rows.crypto.1h.n` | 1 | 6 | 5 | 26 | 25 |
| `windows.rows.crypto.1h.usd` | 1 | 8 | 7 | 28 | 27 |
| `windows.rows.crypto.24h` | 1 | 47 | 27 | 52 | 45 |
| `windows.rows.crypto.24h.n` | 1 | 6 | 5 | 26 | 25 |
| `windows.rows.crypto.24h.usd` | 1 | 14 | 13 | 32 | 31 |
| `windows.rows.crypto.30d` | 1 | 156 | 99 | 115 | 102 |
| `windows.rows.crypto.30d.n` | 1 | 7 | 6 | 27 | 26 |
| `windows.rows.crypto.30d.top` | 1 | 96 | 65 | 85 | 78 |
| `windows.rows.crypto.30d.top.date` | 1 | 20 | 19 | 40 | 39 |
| `windows.rows.crypto.30d.top.name` | 1 | 21 | 20 | 41 | 40 |
| `windows.rows.crypto.30d.top.usd` | 1 | 17 | 16 | 32 | 31 |
| `windows.rows.crypto.30d.usd` | 1 | 19 | 18 | 39 | 38 |
| `windows.rows.crypto.7d` | 1 | 152 | 95 | 115 | 102 |
| `windows.rows.crypto.7d.n` | 1 | 7 | 6 | 27 | 26 |
| `windows.rows.crypto.7d.top` | 1 | 95 | 64 | 87 | 80 |
| `windows.rows.crypto.7d.top.date` | 1 | 20 | 19 | 40 | 39 |
| `windows.rows.crypto.7d.top.name` | 1 | 22 | 21 | 42 | 41 |
| `windows.rows.crypto.7d.top.usd` | 1 | 15 | 14 | 33 | 32 |
| `windows.rows.crypto.7d.usd` | 1 | 17 | 16 | 37 | 36 |
| `windows.rows.crypto.ytd` | 1 | 162 | 105 | 122 | 109 |
| `windows.rows.crypto.ytd.n` | 1 | 8 | 7 | 28 | 27 |
| `windows.rows.crypto.ytd.top` | 1 | 96 | 65 | 85 | 78 |
| `windows.rows.crypto.ytd.top.date` | 1 | 20 | 19 | 40 | 39 |
| `windows.rows.crypto.ytd.top.name` | 1 | 21 | 20 | 41 | 40 |
| `windows.rows.crypto.ytd.top.usd` | 1 | 17 | 16 | 32 | 31 |
| `windows.rows.crypto.ytd.usd` | 1 | 24 | 23 | 44 | 43 |
| `windows.rows.incidents` | 1 | 183 | 88 | 87 | 74 |
| `windows.rows.incidents.1h` | 1 | 25 | 12 | 38 | 32 |
| `windows.rows.incidents.1h.n` | 1 | 6 | 5 | 26 | 25 |
| `windows.rows.incidents.24h` | 1 | 26 | 13 | 39 | 33 |
| `windows.rows.incidents.24h.n` | 1 | 6 | 5 | 26 | 25 |
| `windows.rows.incidents.30d` | 1 | 28 | 15 | 41 | 35 |
| `windows.rows.incidents.30d.n` | 1 | 8 | 7 | 28 | 27 |
| `windows.rows.incidents.7d` | 1 | 27 | 14 | 40 | 34 |
| `windows.rows.incidents.7d.n` | 1 | 8 | 7 | 28 | 27 |
| `windows.rows.incidents.ytd` | 1 | 29 | 16 | 42 | 36 |
| `windows.rows.incidents.ytd.n` | 1 | 9 | 8 | 29 | 28 |
| `windows.rows.kev` | 1 | 174 | 79 | 80 | 67 |
| `windows.rows.kev.1h` | 1 | 25 | 12 | 38 | 32 |
| `windows.rows.kev.1h.n` | 1 | 6 | 5 | 26 | 25 |
| `windows.rows.kev.24h` | 1 | 26 | 13 | 39 | 33 |
| `windows.rows.kev.24h.n` | 1 | 6 | 5 | 26 | 25 |
| `windows.rows.kev.30d` | 1 | 27 | 14 | 40 | 34 |
| `windows.rows.kev.30d.n` | 1 | 7 | 6 | 27 | 26 |
| `windows.rows.kev.7d` | 1 | 26 | 13 | 39 | 33 |
| `windows.rows.kev.7d.n` | 1 | 7 | 6 | 27 | 26 |
| `windows.rows.kev.ytd` | 1 | 28 | 15 | 41 | 35 |
| `windows.rows.kev.ytd.n` | 1 | 8 | 7 | 28 | 27 |
| `windows.rows.news` | 1 | 183 | 103 | 99 | 85 |
| `windows.rows.news.1h` | 1 | 48 | 28 | 54 | 48 |
| `windows.rows.news.1h.headlines` | 1 | 15 | 14 | 35 | 34 |
| `windows.rows.news.1h.n` | 1 | 7 | 6 | 27 | 26 |
| `windows.rows.news.24h` | 1 | 52 | 32 | 58 | 52 |
| `windows.rows.news.24h.headlines` | 1 | 17 | 16 | 37 | 36 |
| `windows.rows.news.24h.n` | 1 | 8 | 7 | 28 | 27 |
| `windows.rows.news.7d` | 1 | 52 | 32 | 58 | 52 |
| `windows.rows.news.7d.headlines` | 1 | 17 | 16 | 37 | 36 |
| `windows.rows.news.7d.n` | 1 | 9 | 8 | 29 | 28 |
| `windows.rows.notices` | 1 | 111 | 52 | 69 | 57 |
| `windows.rows.notices.1h` | 1 | 25 | 12 | 38 | 32 |
| `windows.rows.notices.1h.n` | 1 | 6 | 5 | 26 | 25 |
| `windows.rows.notices.24h` | 1 | 26 | 13 | 39 | 33 |
| `windows.rows.notices.24h.n` | 1 | 6 | 5 | 26 | 25 |
| `windows.rows.notices.7d` | 1 | 26 | 13 | 39 | 33 |
| `windows.rows.notices.7d.n` | 1 | 7 | 6 | 27 | 26 |
| `windows.rows.ransomware` | 1 | 223 | 121 | 118 | 103 |
| `windows.rows.ransomware.1h` | 1 | 25 | 12 | 38 | 32 |
| `windows.rows.ransomware.1h.n` | 1 | 6 | 5 | 26 | 25 |
| `windows.rows.ransomware.24h` | 1 | 27 | 14 | 40 | 34 |
| `windows.rows.ransomware.24h.n` | 1 | 7 | 6 | 27 | 26 |
| `windows.rows.ransomware.30d` | 1 | 29 | 16 | 42 | 36 |
| `windows.rows.ransomware.30d.n` | 1 | 9 | 8 | 29 | 28 |
| `windows.rows.ransomware.7d` | 1 | 27 | 14 | 40 | 34 |
| `windows.rows.ransomware.7d.n` | 1 | 8 | 7 | 28 | 27 |
| `windows.rows.ransomware.ytd` | 1 | 66 | 46 | 73 | 66 |
| `windows.rows.ransomware.ytd.n` | 1 | 9 | 8 | 29 | 28 |
| `windows.rows.ransomware.ytd.src` | 1 | 30 | 29 | 50 | 49 |
| `windows.rows.x` | 1 | 106 | 47 | 61 | 49 |
| `windows.rows.x.1h` | 1 | 25 | 12 | 38 | 32 |
| `windows.rows.x.1h.n` | 1 | 6 | 5 | 26 | 25 |
| `windows.rows.x.24h` | 1 | 26 | 13 | 39 | 33 |
| `windows.rows.x.24h.n` | 1 | 6 | 5 | 26 | 25 |
| `windows.rows.x.7d` | 1 | 27 | 14 | 40 | 34 |
| `windows.rows.x.7d.n` | 1 | 8 | 7 | 28 | 27 |

</details>

<details>
<summary><code>brief</code> subkeys (11)</summary>

| Path | Members | Raw | Compact | Gzip raw | Gzip compact |
| --- | ---: | ---: | ---: | ---: | ---: |
| `brief.headline` | 1 | 274 | 273 | 211 | 211 |
| `brief.incidents` | 1 | 5,646 | 4,834 | 2,116 | 2,073 |
| `brief.incidents[].eid` | 12 | 212 | 200 | 129 | 125 |
| `brief.incidents[].org` | 12 | 307 | 295 | 209 | 207 |
| `brief.incidents[].patterns` | 12 | 533 | 370 | 128 | 116 |
| `brief.incidents[].scale` | 12 | 464 | 452 | 232 | 230 |
| `brief.incidents[].since` | 10 | 202 | 192 | 68 | 66 |
| `brief.incidents[].update` | 10 | 145 | 135 | 49 | 47 |
| `brief.incidents[].url` | 12 | 1,298 | 1,286 | 717 | 710 |
| `brief.incidents[].what` | 12 | 1,796 | 1,775 | 927 | 923 |
| `brief.updated` | 1 | 33 | 32 | 53 | 52 |

</details>

<details>
<summary><code>details</code> subkeys (31)</summary>

| Path | Members | Raw | Compact | Gzip raw | Gzip compact |
| --- | ---: | ---: | ---: | ---: | ---: |
| `details.*` | 1,378 | 1,901,954 | 1,558,477 | 349,818 | 331,633 |
| `details.*.action` | 39 | 20,279 | 19,772 | 477 | 461 |
| `details.*.analysis` | 283 | 418,834 | 365,999 | 99,782 | 96,892 |
| `details.*.analysis.attack_chain` | 283 | 80,259 | 73,887 | 16,865 | 16,212 |
| `details.*.analysis.mitigations` | 283 | 74,824 | 69,193 | 14,396 | 13,944 |
| `details.*.analysis.open_questions` | 283 | 40,492 | 35,650 | 6,392 | 6,266 |
| `details.*.analysis.patterns` | 271 | 12,697 | 8,841 | 674 | 633 |
| `details.*.analysis.sources` | 283 | 118,152 | 96,426 | 25,916 | 24,574 |
| `details.*.analysis.sources[].label` | 703 | 29,634 | 28,587 | 5,730 | 5,698 |
| `details.*.analysis.sources[].url` | 703 | 62,617 | 61,914 | 15,683 | 15,381 |
| `details.*.analysis.summary` | 283 | 77,483 | 76,920 | 19,762 | 19,631 |
| `details.*.cluster` | 294 | 6,468 | 6,174 | 905 | 891 |
| `details.*.cwes` | 39 | 3,994 | 2,431 | 540 | 507 |
| `details.*.cwes[].id` | 57 | 852 | 795 | 182 | 175 |
| `details.*.cwes[].name` | 57 | 1,153 | 1,096 | 308 | 304 |
| `details.*.patterns` | 1,378 | 55,822 | 40,602 | 2,060 | 1,964 |
| `details.*.precedents` | 60 | 25,856 | 19,468 | 3,635 | 3,524 |
| `details.*.precedents[].amount` | 104 | 1,714 | 1,610 | 302 | 293 |
| `details.*.precedents[].classification` | 104 | 3,973 | 3,869 | 322 | 319 |
| `details.*.precedents[].date` | 104 | 2,080 | 1,976 | 414 | 406 |
| `details.*.precedents[].name` | 104 | 1,938 | 1,834 | 685 | 676 |
| `details.*.precedents[].score` | 104 | 1,348 | 1,244 | 173 | 166 |
| `details.*.precedents[].technique` | 104 | 3,783 | 3,679 | 598 | 596 |
| `details.*.precedents[].why` | 104 | 3,572 | 3,468 | 1,121 | 1,112 |
| `details.*.related` | 1,378 | 1,328,542 | 1,081,268 | 207,837 | 195,691 |
| `details.*.related[].date` | 4,603 | 133,530 | 128,927 | 13,604 | 13,352 |
| `details.*.related[].id` | 4,603 | 82,854 | 78,251 | 14,711 | 14,401 |
| `details.*.related[].kind` | 4,603 | 61,613 | 57,010 | 1,338 | 1,326 |
| `details.*.related[].score` | 4,603 | 59,312 | 54,709 | 4,277 | 4,190 |
| `details.*.related[].title` | 4,603 | 372,492 | 365,349 | 76,249 | 75,340 |
| `details.*.related[].why` | 4,603 | 349,265 | 344,662 | 25,739 | 25,631 |

</details>

<details>
<summary><code>clusters</code> subkeys (12)</summary>

| Path | Members | Raw | Compact | Gzip raw | Gzip compact |
| --- | ---: | ---: | ---: | ---: | ---: |
| `clusters[].cohesion` | 12 | 191 | 179 | 65 | 62 |
| `clusters[].id` | 12 | 204 | 192 | 111 | 107 |
| `clusters[].kinds` | 12 | 426 | 252 | 95 | 83 |
| `clusters[].kinds.kev` | 1 | 8 | 7 | 28 | 27 |
| `clusters[].kinds.news` | 9 | 81 | 72 | 43 | 41 |
| `clusters[].kinds.x` | 9 | 55 | 46 | 37 | 35 |
| `clusters[].latest` | 12 | 384 | 372 | 134 | 130 |
| `clusters[].members` | 12 | 1,452 | 1,042 | 507 | 483 |
| `clusters[].patterns` | 12 | 505 | 370 | 141 | 129 |
| `clusters[].size` | 12 | 109 | 97 | 46 | 44 |
| `clusters[].terms` | 12 | 1,055 | 700 | 354 | 329 |
| `clusters[].titles` | 12 | 5,764 | 5,309 | 2,226 | 2,210 |

</details>

<details>
<summary><code>patterns</code> subkeys (10)</summary>

| Path | Members | Raw | Compact | Gzip raw | Gzip compact |
| --- | ---: | ---: | ---: | ---: | ---: |
| `patterns[].breach` | 15 | 165 | 150 | 42 | 40 |
| `patterns[].crypto` | 15 | 167 | 152 | 59 | 57 |
| `patterns[].id` | 15 | 278 | 263 | 166 | 161 |
| `patterns[].kev` | 15 | 121 | 106 | 53 | 50 |
| `patterns[].label` | 15 | 527 | 512 | 288 | 283 |
| `patterns[].news` | 15 | 150 | 135 | 72 | 69 |
| `patterns[].recent7` | 15 | 195 | 180 | 79 | 77 |
| `patterns[].total` | 15 | 166 | 151 | 73 | 70 |
| `patterns[].usd` | 15 | 170 | 155 | 89 | 85 |
| `patterns[].x` | 15 | 97 | 82 | 66 | 62 |

</details>

<details>
<summary><code>pattern_defs</code> subkeys (2)</summary>

| Path | Members | Raw | Compact | Gzip raw | Gzip compact |
| --- | ---: | ---: | ---: | ---: | ---: |
| `pattern_defs[].id` | 14 | 258 | 244 | 159 | 154 |
| `pattern_defs[].label` | 14 | 504 | 490 | 279 | 277 |

</details>

## Appendix B. Snapshot link origins

This is a conservative inventory of HTTP(S) values in `url`, `u`, `href`, and `links` fields of the two checked-in JSON files. It includes unused nested links and lists origins, not paths or redirect targets. A URL-looking string stored as a label or organization name is not treated as a link. There are **1,001** origins in `data.json` and **1,495** in `archive.json`, or **1,561** distinct origins across both. This list is not a browser CSP allowlist.

<details>
<summary>Sorted snapshot origin list (1,561)</summary>

```text
http://biz.chosun.com  http://economictimes.indiatimes.com  http://store.jpost.com  http://vtstatepolice.blogspot.com
http://www.bbc.co.uk  http://www.beckersdental.com  http://www.cbc.ca  http://www.city.nishinomiya.lg.jp
http://www.economictimes.indiatimes.com  http://www.reuters.com  https://3news.com  https://9to5mac.com
https://abc30.com  https://abc7chicago.com  https://abcnews.com  https://about.goldwin.co.jp
https://about.mercari.com  https://actu.fr  https://advisor.ca  https://africa.businessinsider.com
https://ago.vermont.gov  https://agportal-s3bucket.s3.amazonaws.com  https://ainews.leverageai.com.au  https://airwaysmag.com
https://alcabodelacalle.es  https://amatas.com  https://ambcrypto.com  https://anassahel.com
https://andovermanews.com  https://android-mt.ouest-france.fr  https://announcements.asx.com.au  https://ants.gouv.fr
https://aopa.org  https://apnews.com  https://apps.web.maine.gov  https://arcus.xyz
https://arstechnica.com  https://ascii.jp  https://assets.theregister.com  https://atarde.com.br
https://atlas.brandefense.io  https://au.pcmag.com  https://audiovisual.ec.europa.eu  https://autopay.pl
https://autos.yahoo.com  https://aviatrix.ai  https://awarely.ro  https://aws.amazon.com
https://azertag.az  https://bakersfieldnow.com  https://bakuinitiative.org  https://bbc.com
https://beavercountian.com  https://beincrypto.com  https://beinsure.com  https://bell.ca
https://beninwebtv.bj  https://berlin.t-online.de  https://beyondmachines.net  https://biotechmorning.com
https://bitcoinmagazine.com  https://bitquery.io  https://bitrise.io  https://biz.chosun.com
https://biz.heraldcorp.com  https://blackdiamondequipment.co.kr  https://blackshard.com.au  https://blacktree.nl
https://bleepingcomputer.com  https://blockaid.io  https://blockonomi.com  https://blog.confiant.com
https://blog.defichain.com  https://blog.learntprm.com  https://blog.ostraca.fr  https://blog.railway.com
https://blog.rankiteo.com  https://blog.solidityscan.com  https://bocm.es  https://boldinvestors.com.au
https://boletinbien.com  https://bombardir.ru  https://borncity.com  https://br.tradingview.com
https://bravo.etoday.co.kr  https://breach.house  https://breachcensus.com  https://breaches.fru.dev
https://breachhistory.com  https://breachnews.com  https://breachrecord.com  https://breachtally.com
https://breisgau.live  https://bromure.io  https://bsky.social  https://bugzilla.mozilla.org
https://burgenland.orf.at  https://c-level.folha.uol.com.br  https://ca.news.yahoo.com  https://campussecuritytoday.com
https://cbc.ca  https://cecuro.ai  https://cert.cyber.gouv.fr  https://cert.europa.eu
https://chainflip.io  https://chambanatoday.com  https://chatplus.jp  https://checkidapp.com
https://chicagocrusader.com  https://ciberlatam.com  https://cioafrica.co  https://cisoclub.mx
https://citywire.com  https://cl-ex.co.jp  https://claimmoney.com  https://claimwatch.org
https://clb.org.hk  https://cloud.google.com  https://cloudsecurityalliance.org  https://cnnespanol.cnn.com
https://coastalabc.com  https://cobak.co  https://coin360.com  https://coinchoose.com
https://coincu.com  https://coinedition.com  https://coinlaw.io  https://coinmarketcap.com
https://coinness.com  https://coinone.co.kr  https://coinpaper.com  https://coinpedia.org
https://coinscoop.org  https://cointelegraph.com  https://coldcard.com  https://colevannote.com
https://company.golfdigest.co.jp  https://company.meetsmore.com  https://contents.online.nojima.co.jp  https://convergenciadigital.com.br
https://corp.helpfeel.com  https://corp.shiseido.com  https://corp.teamspirit.com  https://corp.zozo.com
https://corpus.data-landscapers.io  https://corrierefiorentino.corriere.it  https://cotidianul.md  https://cpj.org
https://credit.rogerscapital.mu  https://cryip.co  https://crypto-economy.com  https://crypto.news
https://cryptobriefing.com  https://cryptoslate.com  https://cryptowatchdesk.com  https://ct24.ceskatelevize.cz
https://cursor.com  https://cxtoday.com  https://cyberalberta.ca  https://cyberasia.io
https://cyberdefence24.pl  https://cyberdesk.africa  https://cyberguy.com  https://cyberinsider.com
https://cybermonit.com  https://cybernews.com  https://cyberpress.org  https://cyberq.tw
https://cyberscoop.com  https://cybersecuretoday.com  https://cybersecuritynews.com  https://cybersecuritythreatai.com
https://cybersecuritytimes.com  https://cybersecuritytracker.ai  https://cybershitty.com  https://cybersixt.com
https://cypro.co.uk  https://dailysecurityreview.com  https://darknetsearch.com  https://darkwebinformer.com
https://data.wa.gov  https://databreach.com  https://databreach.watch  https://databreachcost.com
https://databreaches.net  https://de.tradingview.com  https://defi-planet.com  https://defillama.com
https://denvillenow.com  https://dependencywatch.io  https://dev.to  https://devops.com
https://diariofinanciero.do  https://diesec.com  https://dig.watch  https://docs.bromcom.com
https://docs.fluidkey.com  https://docs.mistral.ai  https://doorayhelp.oc.nhncloud.com  https://dreamgroup.com
https://durhamcas.ca  https://dysruptionhub.com  https://e.vnexpress.net  https://ebuildersecurity.se
https://ec.europa.eu  https://ec.ltn.com.tw  https://economictimes.indiatimes.com  https://economy24.co.za
https://economynext.com  https://edition.cnn.com  https://edscoop.com  https://efe.com
https://egw.news  https://ehs.killeenisd.org  https://elciudadanoweb.com  https://eldesconcierto.cl
https://elperiodic.ad  https://elvaq.com  https://emops.twse.com.tw  https://en.alphanews.live
https://en.east-inc.jp  https://en.fnnews.com  https://en.gamespark.jp  https://en.kabutan.com
https://en.moneyandbanking.co.th  https://en.nocutnews.co.kr  https://en.parapolitika.gr  https://en.sedaily.com
https://eng.lsm.lv  https://english.tupaki.com  https://ensegundos.do  https://entrevue.fr
https://equixly.com  https://estore.jp  https://etherscan.io  https://f.aa.com.tr
https://factotal.com  https://fakti.bg  https://faq.airreserve.net  https://fc.bnext.com.tw
https://fergusnow.com  https://ffessm.fr  https://files.microcms-assets.io  https://finance.yahoo.com
https://financialintelligence.ro  https://finwave.jp  https://flatt.tech  https://foresiet.com
https://forklog.com  https://forum.gl-inet.com  https://forum.torproject.org  https://fox5sandiego.com
https://fox8.com  https://fr.finance.yahoo.com  https://frameprivacy.com  https://france3-regions.franceinfo.fr
https://frederickcitymedia.com  https://frenchbreaches.com  https://fs2.magicalir.net  https://fuitesinfos.fr
https://g1.globo.com  https://gbcode.rthk.hk  https://geeko.lesoir.be  https://github.com
https://gl-i.net  https://globalnews.ca  https://go-seahorses.jp  https://go.theregister.com
https://goq.co.jp  https://grafa.com  https://grahamcluley.com  https://grow.cleverbridge.com
https://grupo.renfe.com  https://guardian.security  https://guavy.com  https://hacked.slowmist.io
https://hackerfeeds.com  https://hackread.com  https://hackyourmom.com  https://hard2bit.com
https://haveibeenpwned.com  https://hawaii.edu  https://hd-hyundairobotics.com  https://healsecurity.com
https://healthexec.com  https://helix.ml  https://hellostake.com  https://help.contabo.com
https://help.wealthsimple.com  https://helpnetsecurity.com  https://hify.ai  https://hr.daouoffice.com
https://huggingface.co  https://hunt.io  https://icelandinsider.is  https://icelandmonitor.mbl.is
https://ici.radio-canada.ca  https://ico.org.uk  https://idscan.net  https://idtechwire.com
https://ilmanifesto.it  https://inc42.com  https://indianexpress.com  https://industrialcyber.co
https://infcurion.com  https://info-tours.fr  https://informante.web.na  https://informationsecuritybuzz.com
https://infosecu.technews.tw  https://infosightinc.com  https://innovatopia.jp  https://intellizence.com
https://interaktiv.tagesspiegel.de  https://interlira-reports.com  https://internet.gmo  https://internet.watch.impress.co.jp
https://intracare.co.nz  https://intro.newsystock.com  https://invaders.ie  https://investor.hasbro.com
https://investor.sailpoint.com  https://investor.sprc.co.th  https://investors.amgen.com  https://investx.fr
https://inyourgeek.com  https://iol.co.za  https://iotex.io  https://ir.jackhenry.com
https://irpimedia.irpi.eu  https://it-online.co.za  https://itdef.net  https://itnerd.blog
https://japan.cnet.com  https://japancyberwatch.com  https://japandailysun.com  https://japanhacked.jp
https://japanir.jp  https://jornalatual.com.br  https://jornaleconomico.sapo.pt  https://jscrambler.com
https://justice.gov  https://justice.oregon.gov  https://kalkine.com.au  https://karelia-news.net
https://kdhnews.com  https://kfor.com  https://kodekloud.com  https://koreatechdesk.com
https://kotaku.com  https://kr.tanium.com  https://krebsonsecurity.com  https://kurier.at
https://labs.cloudsecurityalliance.org  https://lamilano.it  https://lana.gov.ly  https://lava.security
https://layerzero.network  https://leak-watch.org  https://leakdex.co.kr  https://ledgertranscript.com
https://legalinsurrection.com  https://legoland.jp  https://lequotidien.sn  https://libyaobserver.ly
https://libyaupdate.com  https://life.miraeasset.com  https://lisbonbrief.com  https://lists.gnu.org
https://live.deutsche-boerse.com  https://lockergnome.com  https://maison.kose.co.jp  https://malice.ai
https://mallory.ai  https://manabinoba.blog  https://marathi.timesnownews.com  https://matchsystems.com
https://mbiz.heraldcorp.com  https://me-en.kaspersky.com  https://medcitynews.com  https://media-innovation.jp
https://medsecledger.com  https://meduza.io  https://mezha.net  https://mfn.se
https://minerxbt.substack.com  https://mlq.ai  https://mobiletime.la  https://moldovalive.md
https://monadnockcommunityhospital.com  https://moncompte.ffjudo.com  https://money.bg  https://money.udn.com
https://mothership.sg  https://mpost.io  https://mpowerhealth.com  https://mraircanada.mediaroom.com
https://mscnews.net  https://murciatoday.com  https://mybroadband.co.za  https://myfox8.com
https://mynewsla.com  https://n.news.naver.com  https://nashaniva.com  https://naukawpolsce.pl
https://nbreview.de  https://ncnews.com.br  https://nebusec.ai  https://news.bitcoin.com
https://news.bloombergtax.com  https://news.cision.com  https://news.cnyes.com  https://news.err.ee
https://news.google.com  https://news.jp  https://news.kbs.co.kr  https://news.risky.biz
https://news.sbs.co.kr  https://news.sktelecom.com  https://news.sony-sasti.jp  https://news.sulat.com
https://news.web.nhk  https://news.yahoo.co.jp  https://news.ycombinator.com  https://news3lv.com
https://newsdesk.hk  https://newsfield.net  https://newsfile.futunn.com  https://newsmoris.com
https://newsonjapan.com  https://newspim.com  https://newsprd.rthk.hk  https://newsroom.adt.com
https://newsroom.aholddelhaize.com  https://newsroom.kddi.com  https://newsroom.notified.com  https://newsroom.stubhub.com
https://nophi.sh  https://nos.nl  https://noticias.dupin.com.ar  https://novita.ai
https://now-hacked.com  https://nqbrief.com  https://nsearchives.nseindia.com  https://nulab.com
https://nvd.nist.gov  https://ny1.com  https://oag.ca.gov  https://oag.my.site.com
https://ocrportal.hhs.gov  https://ocsecurityaudit.com  https://offset7.com  https://olympix.security
https://omni.se  https://omnibus.au.dk  https://oodaloop.com  https://open-group.co.jp
https://openai.com  https://openclassactions.com  https://openrouter.ai  https://opguardian.com
https://opnhc.com  https://optmsg.com  https://orf-at.translate.goog  https://ostraca.fr
https://osv.dev  https://ourcryptotalk.com  https://outlook.monmouth.edu  https://outposts.io
https://paragraf.bg  https://parsippanyfocus.com  https://pasivite.fr  https://pasqualepillitteri.it
https://payy.network  https://phala.com  https://pharmaphorum.com  https://phoebehealth.com
https://pillarlibraries.org  https://pipc.go.kr  https://piracymap.com  https://pirorin.com
https://plaid.co.jp  https://playciso.com  https://pleno.news  https://policy.dktechin.com
https://politicallore.com  https://portal.smartertools.com  https://portaldobitcoin.uol.com.br  https://prefeitura.pbh.gov.br
https://presse-augsburg.de  https://production.marketing-interactive.com  https://protectindiana.org  https://protocolreport.com
https://pulse.kalir.io  https://pwn.watch  https://qa.philstar.com  https://questions-statements.parliament.uk
https://railway.com  https://ransomlens.com  https://ransomnews.com  https://ransomware.comparitech.com
https://ransomware.live  https://rassemblementnational.fr  https://raven.io  https://rci.fm
https://rekt.news  https://reliaquest.com  https://renews.com.ua  https://research.jfrog.com
https://reservision.world  https://revistaclevel.com  https://risky.biz  https://rizap.co.jp
https://rocket-boys.co.jp  https://rsecurity.tech  https://rya-sge.github.io  https://sada.ly
https://safedep.io  https://safeguard.sh  https://san.com  https://scambaba.com
https://scan.netsecurity.ne.jp  https://securelist.com  https://secureresearch.com  https://securityaffairs.com
https://securityboulevard.com  https://securitylabs.datadoghq.com  https://securityleaders.com.br  https://securityonline.info
https://securitypointbreak.com  https://segafave.co.jp  https://sekurak.pl  https://settlementinsight.com
https://shieldworkz.com  https://shop.hololivepro.com  https://shop.weverse.io  https://siliconcanals.com
https://skift.com  https://skylancesecurity.com  https://skyticket.jp  https://slowmist.medium.com
https://slowtwitch.com  https://smartscope.blog  https://socket.dev  https://socradar.io
https://sonicmoov.com  https://sonomos.ai  https://southportland.gov  https://specialarad.ro
https://splash247.com  https://ssl4.eir-parts.net  https://stadt-bremerhaven.de  https://stage.flz.de
https://stalkchain.com  https://static1.squarespace.com  https://status.airbyte.com  https://status.apify.com
https://status.bitrise.io  https://status.chainflip.io  https://status.digdir.no  https://status.donorperfect.com
https://status.gofundme.com  https://status.optimizely.com  https://status.polymarket.com  https://stjames.wa.edu.au
https://storage.courtlistener.com  https://store.dcentwallet.com  https://straussborrelli.com  https://strobes.co
https://studio.design  https://suaragarut.id  https://support.broadcom.com  https://support.learnworlds.com
https://support.optimizely.com  https://support.seazon.fr  https://svenskamassan.se  https://swedenherald.com
https://tangem.com  https://tanstack.com  https://tass.ru  https://tbreak.com
https://tech.yahoo.com  https://techbeacon.net  https://techcrunch.com  https://techjournal.org
https://techpulse.be  https://techsoma.africa  https://techtools.cz  https://techwatch.info
https://telenord.it  https://teollimi.com  https://tfgmedia.co.za  https://tfl.gov.uk
https://th.headtopics.com  https://the-european.eu  https://the483.com  https://thearabianpost.com
https://theblock.co  https://thechainobserver.com  https://thecio.uk  https://theconversation.com
https://thecyber.news  https://thecyberexpress.com  https://thedeadpixelssociety.com  https://thedefiant.io
https://thedetail.co.za  https://thefacts.com  https://thefnp.com  https://thehackernews.com
https://thelaymansecurity.com  https://themarketperiodical.com  https://thenextweb.com  https://thenonprofittimes.com
https://thepaypers.com  https://therecord.media  https://theuptimereport.com  https://theweatherreport.ai
https://threatbeat.com  https://threatpaper.com  https://today.rtl.lu  https://tokyobrief.com
https://tokyodispatch.com  https://topclassactions.com  https://topics.smt.docomo.ne.jp  https://total-croatia-news.com
https://tpwd.texas.gov  https://tradebrains.in  https://tradersunion.com  https://travelnews.co.za
https://travelweekly.com.au  https://trezor.io  https://tribuna.com  https://triple-a.io
https://trustlist.uk  https://tugatech.com.pt  https://tw.stock.yahoo.com  https://tweakers.net
https://ua.news  https://uctoday.com  https://ufla.br  https://ufm.dk
https://uk.pcmag.com  https://unchainedcrypto.com  https://united24media.com  https://updates.gyazo.com
https://upstox.com  https://usethebitcoin.com  https://vercel.com  https://veritas.enc.edu
https://voiceofvienna.org  https://voxpopulinoticias.com.mx  https://vulnpocalypse.dev  https://weartv.com
https://web-equinor-web-sites-prod.c2.radix.equinor.com  https://web.archive.org  https://web3auth.io  https://weblink-asx-announcements.old-mountain-2586.workers.dev
https://wgme.com  https://whatgotpwned.com  https://whysofrance.com  https://world.kbs.co.kr
https://wta.flz.de  https://wvmetronews.com  https://ww2.money-link.com.tw  https://www.0101maruigroup.co.jp
https://www.20minutes.fr  https://www.24heures.ch  https://www.24horas.cl  https://www.24sata.hr
https://www.4029tv.com  https://www.404media.co  https://www.5min.at  https://www.5newsonline.com
https://www.9news.com  https://www.abc.net.au  https://www.abc27.com  https://www.acidpeak.com
https://www.acuite.fr  https://www.ad-hoc-news.de  https://www.ad.nl  https://www.adelaidenow.com.au
https://www.adequacy.app  https://www.adminbyrequest.com  https://www.adnkronos.com  https://www.advantest.com
https://www.advertisernewssouth.com  https://www.afp.com  https://www.aftonbladet.se  https://www.agentbeam.com
https://www.ai-primer.com  https://www.aikido.dev  https://www.ainj.co.jp  https://www.airports.com.na
https://www.ajunews.com  https://www.ajupress.com  https://www.akb.uscourts.gov  https://www.aljazeera.com
https://www.allrecipes.com  https://www.ally.security  https://www.am730.com.hk  https://www.aman-alliance.org
https://www.americanfootballinternational.com  https://www.androidheadlines.com  https://www.andst-hd.co.jp  https://www.animenewsnetwork.com
https://www.ansa.it  https://www.anthropic.com  https://www.aol.co.uk  https://www.areb.uscourts.gov
https://www.argusdelassurance.com  https://www.arkansasonline.com  https://www.armenews.com  https://www.asiae.co.kr
https://www.asos.com  https://www.assinews.it  https://www.atf.gov  https://www.atg.wa.gov
https://www.auvieuxcampeur.fr  https://www.aviacionline.com  https://www.axios.com  https://www.aytolalaguna.es
https://www.azcourts.gov  https://www.aztecaquintanaroo.com  https://www.babaocagi.com.tr  https://www.bangordailynews.com
https://www.bankier.pl  https://www.bankinfosecurity.com  https://www.banklesstimes.com  https://www.banquealimentaire.org
https://www.battipaglia1929.it  https://www.baxter.com  https://www.bazonline.ch  https://www.bbc.co.uk
https://www.bbc.com  https://www.beckershospitalreview.com  https://www.beckersspine.com  https://www.bellingcat.com
https://www.berlin.de  https://www.betterment.com  https://www.beyondiam.com  https://www.beyondtrust.com
https://www.bfmtv.com  https://www.bgnes.com  https://www.bike.no  https://www.binance.com
https://www.biometricupdate.com  https://www.bitdefender.com  https://www.bitdigest.io  https://www.bitget.com
https://www.bitquery.io  https://www.bk.mufg.jp  https://www.blackfog.com  https://www.bleepingcomputer.com
https://www.blick.ch  https://www.blockhead.co  https://www.bloomberg.com  https://www.bluewin.ch
https://www.bmj.com  https://www.bndestem.nl  https://www.bnnbloomberg.ca  https://www.bookit.co.nz
https://www.boursier.com  https://www.boursorama.com  https://www.br.de  https://www.breach.house
https://www.breachtally.com  https://www.brightdefense.com  https://www.brightnexus.com  https://www.brinztech.com
https://www.broadcom.com  https://www.brownhealth.org  https://www.brusselstimes.com  https://www.bta.bg
https://www.business-standard.com  https://www.businessdesk.co.nz  https://www.businesswire.com  https://www.businessworld.in
https://www.bz-berlin.de  https://www.cadaminuto.com.br  https://www.campograndenews.com.br  https://www.capcom.co.jp
https://www.carexpert.com.au  https://www.cass.ad  https://www.cathaypacific.com  https://www.cbc.ca
https://www.cbsnews.com  https://www.cde.ca.gov  https://www.cdjapan.co.jp  https://www.cdt.ch
https://www.cegedim.fr  https://www.cert-in.org.in  https://www.certik.com  https://www.ceskenoviny.cz
https://www.cfdt.fr  https://www.chaffeecountytimes.com  https://www.chainalysis.com  https://www.chainguard.dev
https://www.chambourcy.fr  https://www.channelnews.fr  https://www.channelnewsasia.com  https://www.chiba-tv.com
https://www.chiemgau24.de  https://www.chosun.com  https://www.chronline.com  https://www.circuit-magazine.com
https://www.ciro.ca  https://www.cisa.gov  https://www.cisco.com  https://www.cisonews.net
https://www.city.amagasaki.hyogo.jp  https://www.city.iwamizawa.hokkaido.jp  https://www.cjlogistics.com  https://www.cjwwradio.com
https://www.claimdepot.com  https://www.cleveland.com  https://www.cleveland19.com  https://www.cloaked.com
https://www.club-t.com  https://www.clubic.com  https://www.cnbc.com  https://www.cnet.com
https://www.cnhi.com  https://www.cnn.com  https://www.cnnbrasil.com.br  https://www.coinbase.com
https://www.coindesk.com  https://www.cointribune.com  https://www.coloradocountycitizen.com  https://www.columbian.com
https://www.comparitech.com  https://www.comptia.org  https://www.computerweekly.com  https://www.computing.co.uk
https://www.connectwise.com  https://www.consumer.sc.gov  https://www.convergenciadigital.com.br  https://www.corp.musenet.co.jp
https://www.couriermail.com.au  https://www.cp24.com  https://www.cpomagazine.com  https://www.cpr.dk
https://www.crn.com  https://www.crnasia.com  https://www.cryptobreaking.com  https://www.cryptometer.io
https://www.cryptopolitan.com  https://www.cryptotimes.io  https://www.csa.gov.sg  https://www.csis.org
https://www.csoonline.com  https://www.ctvnews.ca  https://www.cve.org  https://www.cyber.nj.gov
https://www.cyberattaque.org  https://www.cyberbreaches.org  https://www.cyberdaily.au  https://www.cyberkit.win
https://www.cybermaterial.com  https://www.cybersecitalia.it  https://www.cybersecuritydive.com  https://www.cyera.com
https://www.dailian.co.kr  https://www.dailybaltic.com  https://www.dailyherald.com  https://www.dailymail.com
https://www.dailymaverick.co.za  https://www.dailymirror.lk  https://www.dailysecu.com  https://www.dailysentinel.com
https://www.dailysweden.com  https://www.dakotanewsnetwork.com  https://www.dallasnews.com  https://www.darkreading.com
https://www.databreaches.net  https://www.databreachtoday.com  https://www.datatooza.com  https://www.dawn.com
https://www.dcforecasts.com  https://www.ddaily.co.kr  https://www.decryptiondigest.com  https://www.defenseone.com
https://www.democrata.es  https://www.devdiscourse.com  https://www.dexpose.io  https://www.dhnet.be
https://www.diariandorra.ad  https://www.diariopopular.com.ar  https://www.die-glocke.de  https://www.diepresse.com
https://www.digital.go.jp  https://www.digitaltoday.co.kr  https://www.discoverairdrie.com  https://www.dkkaraoke.co.jp
https://www.dl-online.com  https://www.dn.no  https://www.donaukurier.de  https://www.donorperfect.com
https://www.dragos.com  https://www.drift.trade  https://www.drupal.org  https://www.dsci.in
https://www.dtnext.in  https://www.dtnpf.com  https://www.dtu.dk  https://www.dutchnews.nl
https://www.dvi.gov.lv  https://www.dw.com  https://www.dyfed-powys.police.uk  https://www.e-rumoi.jp
https://www.eani.org.uk  https://www.ebn.co.kr  https://www.echolive.ie  https://www.economictimes.indiatimes.com
https://www.ecostylia.com  https://www.education.gouv.fr  https://www.egr.global  https://www.ehandel.se
https://www.eicoh.com  https://www.ekonomim.com  https://www.elastic.co  https://www.eldiario.es
https://www.eldigitaldealbacete.com  https://www.electricbloomwebzine.com  https://www.elliptic.co  https://www.elmostrador.cl
https://www.emeryreddy.com  https://www.emol.com  https://www.endesa.com  https://www.endorlabs.com
https://www.engadget.com  https://www.enseignementsup-recherche.gouv.fr  https://www.eon.io  https://www.epark-relax.co.jp
https://www.equinor.com  https://www.escudodigital.com  https://www.esecurityplanet.com  https://www.eset.com
https://www.eskenazihealth.edu  https://www.estadao.com.br  https://www.etnownews.com  https://www.ettoday.net
https://www.etvbharat.com  https://www.euronews.com  https://www.europapress.es  https://www.europarl.europa.eu
https://www.examiner-enterprise.com  https://www.excite.co.jp  https://www.expressnews.com  https://www.eyeonannapolis.net
https://www.facebook.com  https://www.fairgambling.com  https://www.fakenhamtimes.co.uk  https://www.farmersjournal.ie
https://www.farmweeknow.com  https://www.fastcompany.com  https://www.faz.net  https://www.fbi.gov
https://www.fehmarnbusiness.com  https://www.ffgolf.org  https://www.fidelity.com  https://www.fiercebymitu.com
https://www.fiercehealthcare.com  https://www.financemagnates.com  https://www.finanzen.at  https://www.finanzen.net
https://www.finextra.com  https://www.fldoe.org  https://www.flypeach.com  https://www.forescout.com
https://www.fortune.com  https://www.fox26houston.com  https://www.foxbangor.com  https://www.foxnews.com
https://www.fphcare.com  https://www.franceinfo.fr  https://www.frederickhealth.org  https://www.freepressjournal.in
https://www.freightwaves.com  https://www.frontier-enterprise.com  https://www.ft.com  https://www.fullertonhealth.com
https://www.gadgets360.com  https://www.galaxywarden.com  https://www.gamespark.jp  https://www.gat.report
https://www.gate.com  https://www.gate.tr  https://www.geeknative.com  https://www.geisinger.org
https://www.generation-nt.com  https://www.genomeweb.com  https://www.giants.jp  https://www.gl-inet.com
https://www.globalsecurity.org  https://www.gmanetwork.com  https://www.gmc-uk.org  https://www.goe.go.kr
https://www.gov.pl  https://www.gov.uk  https://www.govexec.com  https://www.govinfosecurity.com
https://www.govtech.com  https://www.gp.se  https://www.greaterkashmir.com  https://www.grupoaseguranza.com
https://www.guardian.co.tt  https://www.gunze.co.jp  https://www.gunzesports.com  https://www.gwneukoelln.de
https://www.hackmageddon.com  https://www.halborn.com  https://www.hani.co.kr  https://www.hankookilbo.com
https://www.hankyung.com  https://www.hawaii.edu  https://www.healthcaredive.com  https://www.heise.de
https://www.hellorayo.co.uk  https://www.helpnetsecurity.com  https://www.helsinkitimes.fi  https://www.hexnode.com
https://www.hfndigital.com  https://www.hipaajournal.com  https://www.hkmu.edu.hk  https://www.hkpc.org
https://www.hln.be  https://www.hotelvor9.de  https://www.houmatoday.com  https://www.houstonchronicle.com
https://www.hsbc.com.tw  https://www.humansecurity.com  https://www.huntress.com  https://www.ians.com
https://www.idcf.jp  https://www.ideal.es  https://www.ideastream.org  https://www.identidadcorrentina.com.ar
https://www.iene.eu  https://www.igamingrepublic.com  https://www.ilga-europe.org  https://www.ilgiornaleditalia.it
https://www.ilmattino.it  https://www.ilpiccolo.it  https://www.ilpost.it  https://www.imca-int.com
https://www.imidaily.com  https://www.inc.com  https://www.incibe.es  https://www.independent.co.uk
https://www.independent.ie  https://www.inderes.fi  https://www.index.hr  https://www.indianagazette.com
https://www.indiatoday.in  https://www.infobae.com  https://www.informacion.es  https://www.informnny.com
https://www.infosecurity-magazine.com  https://www.infosyvelines.fr  https://www.inside-it.ch  https://www.insidehighered.com
https://www.inspect-data.com  https://www.intelfusions.com  https://www.intelligenceonline.com  https://www.internetbode.nl
https://www.inyourgeek.com  https://www.iotinsider.com  https://www.iowaattorneygeneral.gov  https://www.iprofesional.com
https://www.ipsos.com  https://www.iranintl.com  https://www.irishmirror.ie  https://www.ironmountain.com
https://www.isec.news  https://www.isssource.com  https://www.it-daily.net  https://www.ithome.com.tw
https://www.itpro.com  https://www.itweb.co.za  https://www.jal.co.jp  https://www.japanesefromjapan.com
https://www.japantimes.co.jp  https://www.jiji.com  https://www.jins.com  https://www.jn.pt
https://www.jnsa.org  https://www.jornaldenegocios.pt  https://www.journaldugeek.com  https://www.journaltech.com
https://www.jumonji-u.ac.jp  https://www.justice.gov  https://www.karibinfo.com  https://www.kaspersky.com
https://www.kaupr.io  https://www.kawai.co.jp  https://www.kepco.co.kr  https://www.kinkisharyo.com
https://www.kioskmarketplace.com  https://www.kleinezeitung.at  https://www.kma-online.de  https://www.kmbc.com
https://www.kmib.co.kr  https://www.kookje.co.kr  https://www.koreaherald.com  https://www.kotakneo.com
https://www.krone.at  https://www.ku.dk  https://www.kucoin.com  https://www.kxan.com
https://www.kxii.com  https://www.kyash.co  https://www.kyoto-np.co.jp  https://www.kyuden.co.jp
https://www.laliga.com  https://www.landkreis-greiz.de  https://www.langleytwigg.co.nz  https://www.laopiniondemalaga.es
https://www.lapoliticaonline.com  https://www.lapresse.ca  https://www.latercera.com  https://www.latimes.com
https://www.lavanguardia.com  https://www.lavoixdunord.fr  https://www.law.com  https://www.law360.com
https://www.lawcommentary.com  https://www.lawnext.com  https://www.lawyerly.com.au  https://www.lbc.co.uk
https://www.le-droit.fr  https://www.lechotouristique.com  https://www.ledauphine.com  https://www.legalcheek.com
https://www.legit.ng  https://www.lemanbleu.ch  https://www.lemonde.fr  https://www.lemoniteurdespharmacies.fr
https://www.leprogres.fr  https://www.lescrous.fr  https://www.lesnumeriques.com  https://www.lesoir.be
https://www.letelegramme.fr  https://www.letemps.ch  https://www.linfo.re  https://www.linformaticien.com
https://www.livebitcoinnews.com  https://www.lloydslist.com  https://www.lne.es  https://www.lnews.jp
https://www.loblaw.ca  https://www.logi-today.com  https://www.londonstockexchange.com  https://www.lrt.lt
https://www.mactrast.com  https://www.maersk.com  https://www.magzter.com  https://www.maine.gov
https://www.mainichi.co.jp  https://www.malwarebytes.com  https://www.mandom.co.jp  https://www.marketscreener.com
https://www.marketsmojo.com  https://www.marketwatch.com  https://www.mass.gov  https://www.masterofmalt.com
https://www.mattinopadova.it  https://www.mckesson.com  https://www.mddionline.com  https://www.mdjonline.com
https://www.medianama.com  https://www.mediapost.com  https://www.medtechdive.com  https://www.meinbezirk.at
https://www.mercedes-benz.co.jp  https://www.mercor.com  https://www.merkur.de  https://www.messaggeromarittimo.it
https://www.metro.pr  https://www.metro.tokyo.lg.jp  https://www.minotdailynews.com  https://www.minsimnews.com
https://www.mirror.co.uk  https://www.mitsuifudosan.co.jp  https://www.mittelbayerische.de  https://www.mittelhessen.de
https://www.mk.co.kr  https://www.mnews.tw  https://www.mobilicites.com  https://www.mobilissimo.ro
https://www.mobiliteit.nl  https://www.moldpres.md  https://www.moneycontrol.com  https://www.moneymanagement.com.au
https://www.mononews.gr  https://www.morgenpost.de  https://www.morphisec.com  https://www.mprnews.org
https://www.mt.co.kr  https://www.musashinomura.co.jp  https://www.musicbusinessworldwide.com  https://www.mutuelle-familiale.fr
https://www.mz.de  https://www.n-able.com  https://www.nabu.gov.ua  https://www.nbc4i.com
https://www.nbcnews.com  https://www.nbcrightnow.com  https://www.ncl.ac.uk  https://www.ncsc.gov.uk
https://www.ndr.de  https://www.ndtvprofit.com  https://www.neshobademocrat.com  https://www.nettavisen.no
https://www.neuried.net  https://www.newindianexpress.com  https://www.newjerseyhills.com  https://www.news.com.au
https://www.news.gov.hk  https://www.news1.kr  https://www.news4hackers.com  https://www.news5cleveland.com
https://www.news9.com  https://www.newsbytesapp.com  https://www.newsday.com  https://www.newsian.co.kr
https://www.newsis.com  https://www.newsoresund.se  https://www.newspim.com  https://www.newsroom.info
https://www.newswire.lk  https://www.nextgov.com  https://www.nikkei.com  https://www.nine.com.au
https://www.nitori.co.jp  https://www.njherald.com  https://www.nn.de  https://www.nna.jp
https://www.noen.at  https://www.nominis.io  https://www.nordkurier.de  https://www.northjersey.com
https://www.nottinghampost.com  https://www.novocure.com  https://www.npr.org  https://www.nrk.no
https://www.ntnews.com.au  https://www.numerique.gouv.fr  https://www.nwaonline.com  https://www.nychealthandhospitals.org
https://www.nysportsday.com  https://www.nytimes.com  https://www.nzherald.co.nz  https://www.nzx.com
https://www.nzz.ch  https://www.oaic.gov.au  https://www.ochsner.org  https://www.odaily.news
https://www.odido.nl  https://www.omroepbrabant.nl  https://www.onedegree.hk  https://www.onlanka.com
https://www.orientaldiamond.jp  https://www.osaki.co.jp  https://www.ouest-france.fr  https://www.ourtownny.com
https://www.pbs.org  https://www.pcgameshardware.de  https://www.pcmag.com  https://www.perthnow.com.au
https://www.philstar.com  https://www.phonandroid.com  https://www.phonearena.com  https://www.pilotonline.com
https://www.pingcap.com  https://www.planet.fr  https://www.pmc.gov.au  https://www.pnld.co.uk
https://www.poder360.com.br  https://www.pointguardai.com  https://www.politico.com  https://www.politico.eu
https://www.postech.ac.kr  https://www.pref.nagano.lg.jp  https://www.pref.nara.lg.jp  https://www.pressherald.com
https://www.presso-inn.com  https://www.prestigein.com  https://www.primeintellect.ai  https://www.privacyguides.org
https://www.prnewswire.com  https://www.pryorinfopub.com  https://www.publica.ch  https://www.publico.pt
https://www.pwc.com  https://www.pymnts.com  https://www.qcnews.com  https://www.quantstamp.com
https://www.quimper.bzh  https://www.quintenews.com  https://www.radiofrance.fr  https://www.railwaygazette.com
https://www.rakus.co.jp  https://www.rakuten-sec.co.jp  https://www.ransomlook.io  https://www.ransomware.live
https://www.rappler.com  https://www.rcvs.org.uk  https://www.recordedfuture.com  https://www.recruit.co.jp
https://www.reddit.com  https://www.redeszone.net  https://www.regierung.li  https://www.renfe.com
https://www.repubblica.it  https://www.rescana.com  https://www.research-live.com  https://www.retaildive.com
https://www.reuters.com  https://www.revolution-energetique.com  https://www.rfi.fr  https://www.riken.jp
https://www.risky.biz  https://www.rivervalleydemocratgazette.com  https://www.rnz.co.nz  https://www.rockpapershotgun.com
https://www.romania-insider.com  https://www.roth-industries.com  https://www.royalgazette.com  https://www.rp.pl
https://www.rrobserver.com  https://www.rsi.ch  https://www.rtbf.be  https://www.rte.ie
https://www.ruv.is  https://www.rvaschools.net  https://www.sabcnews.com  https://www.sacbee.com
https://www.saechsische.de  https://www.saga-s.co.jp  https://www.saga-u.ac.jp  https://www.salesforce.com
https://www.sankei.com  https://www.sanspo.com  https://www.satechnews.co.za  https://www.schweiz-republikkorea.eda.admin.ch
https://www.scmp.com  https://www.scotsman.com  https://www.scottishnews.com  https://www.scworld.com
https://www.seattletimes.com  https://www.sec.gov  https://www.secnews.gr  https://www.secure.com
https://www.secureblink.com  https://www.security-insider.de  https://www.security.io  https://www.securitymagazine.com
https://www.securitystudies.info  https://www.securityweek.com  https://www.sega.co.jp  https://www.seisadohto.ac.jp
https://www.semafor.com  https://www.shawlocal.com  https://www.shimamura.gr.jp  https://www.shinailbo.co.kr
https://www.shintoku-town.jp  https://www.sify.com  https://www.skagerakenergi.no  https://www.slashgear.com
https://www.smarttoday.co.kr  https://www.sn-online.de  https://www.snl24.com  https://www.snowpeak.co.jp
https://www.soccer.ru  https://www.solid-adv.co.jp  https://www.solutions-numeriques.com  https://www.sophos.com
https://www.sourcenext.com  https://www.sourcesecurity.com  https://www.sourcetrail.com  https://www.southcarolinapublicradio.org
https://www.spedidam.fr  https://www.spiegel.de  https://www.sra.nl  https://www.stadlerrail.com
https://www.starvedrock.media  https://www.statecollege.com  https://www.stepsecurity.io  https://www.stingrai.io
https://www.stocktitan.net  https://www.straitstimes.com  https://www.streetinsider.com  https://www.stripe-intl.com
https://www.stuff.co.nz  https://www.sudinfo.be  https://www.sueddeutsche.de  https://www.suntory-kenko.com
https://www.sverigesradio.se  https://www.svt.se  https://www.swissinfo.ch  https://www.swr.de
https://www.syracuse.com  https://www.t-online.de  https://www.t13.cl  https://www.tag24.de
https://www.tagesschau.de  https://www.taipeitimes.com  https://www.taiwannews.com.tw  https://www.talkesport.com
https://www.tanea.gr  https://www.tanium.com  https://www.tanium.jp  https://www.tapinto.net
https://www.tbsnews.net  https://www.tech-quire.com  https://www.techfinitive.com  https://www.technadu.com
https://www.techpartner.news  https://www.techradar.com  https://www.techrepublic.com  https://www.techspot.com
https://www.techtimes.com  https://www.techzine.eu  https://www.tecmundo.com.br  https://www.teiss.co.uk
https://www.telecompaper.com  https://www.telegraphindia.com  https://www.telemundopr.com  https://www.temairazu.co.jp
https://www.tf1info.fr  https://www.thaicert.or.th  https://www.the-independent.com  https://www.theblock.co
https://www.theconveyor.co  https://www.thedailystar.com  https://www.thedp.com  https://www.thedrive.com
https://www.thefivenines.com  https://www.theglobeandmail.com  https://www.theguardian.com  https://www.thelec.net
https://www.thelocal.dk  https://www.thelocal.no  https://www.thenationalnews.com  https://www.thenewhumanitarian.org
https://www.thenewsminute.com  https://www.theregister.com  https://www.thesiteoueb.net  https://www.thestandard.com.hk
https://www.thetimes.com  https://www.theverge.com  https://www.thk.com  https://www.threatfabric.com
https://www.threatintelreport.com  https://www.threshold.network  https://www.ticketnews.com  https://www.tiemposur.com.ar
https://www.timeslive.co.za  https://www.timesnownews.com  https://www.tipranks.com  https://www.tjb.co.kr
https://www.together.ai  https://www.tokyo-gas.co.jp  https://www.tokyohoso.co.jp  https://www.torontotoday.ca
https://www.tourmag.com  https://www.town.tanagura.fukushima.jp  https://www.tradingview.com  https://www.travelweekly-asia.com
https://www.trellix.com  https://www.trendaisecurity.com  https://www.trendmicro.com  https://www.triathlonireland.com
https://www.triesteprima.it  https://www.triple-a.io  https://www.troyhunt.com  https://www.ttt.live
https://www.tv4.se  https://www.tvnet.lv  https://www.uchealth.org  https://www.uhhospitals.org
https://www.uni-leipzig.de  https://www.uniroma1.it  https://www.univision.com  https://www.unmc.edu
https://www.upguard.com  https://www.upi.com  https://www.uscourts.gov  https://www.uzdaily.uz
https://www.valdemoro.es  https://www.valoraanalitik.com  https://www.valueaddedresource.net  https://www.vettimes.com
https://www.villesaintpascal.com  https://www.volksfreund.de  https://www.vrt.be  https://www.wa.de
https://www.walb.com  https://www.wapt.com  https://www.wargamer.com  https://www.waseda.jp
https://www.watch.impress.co.jp  https://www.watson.ch  https://www.wbng.com  https://www.wcax.com
https://www.wcvb.com  https://www.web3isgoinggreat.com  https://www.webacy.com  https://www.wect.com
https://www.welcometoquincywa.com  https://www.welivesecurity.com  https://www.wellandtribune.ca  https://www.westsideseattle.com
https://www.whalesbook.com  https://www.whatsapp.com  https://www.whec.com  https://www.winnipegfreepress.com
https://www.winonacounty.gov  https://www.winonapost.com  https://www.wired.com  https://www.wiz.io
https://www.wjol.com  https://www.wkok.com  https://www.wkow.com  https://www.wmtw.com
https://www.wn.de  https://www.wnp.pl  https://www.wochenblatt-reporter.de  https://www.woodtv.com
https://www.wordfence.com  https://www.wow-world.co.jp  https://www.wrbl.com  https://www.wrtv.com
https://www.wsj.com  https://www.wthr.com  https://www.wtva.com  https://www.wtvm.com
https://www.wtwco.com  https://www.wusa9.com  https://www.wvnews.com  https://www.wz.de
https://www.xleague.jp  https://www.yahoo.com  https://www.yesilsivasligazetesi.com  https://www.yna.co.kr
https://www.yo.xyz  https://www.yourcentralvalley.com  https://www.zaobao.com.sg  https://www.zurich.com.hk
https://www2.jpx.co.jp  https://www2.sagawa-exp.co.jp  https://www3.nhk.or.jp  https://x.com
https://xposedornot.com  https://yaamlabs.com  https://yellow.com  https://yeny.jp
https://yle.fi  https://ymca.org.sg  https://zdnet.co.kr  https://zeabur.com
https://zerotolerance.me
```

</details>

## Appendix C. Reproduce the profile and split

Run the Python below from the repository root with Python 3.12 and GNU gzip 1.12. It reads only the checked-in inputs and prints results. `members(blob, group_ids=False)` expands the `details.*` group into per-ID rows if needed. `FIELDS` is the exact allowlist for record fields in the hot measurement. For the link inventory, recursively collect HTTP(S) values under `url`, `u`, `href`, and `links` (including string array elements), and combine the URL scheme and lowercase authority. Do not resolve the links over the network.

<details>
<summary>Read-only Python reproducer</summary>

```python
import collections, datetime as dt, json, re, subprocess
from pathlib import Path

raw = Path('site/data.json').read_bytes()
D = json.loads(raw)

def compact(o):
    return json.dumps(o, ensure_ascii=False, separators=(',', ':')).encode('utf-8')

def gzip(b):
    return len(subprocess.check_output(['gzip', '-n', '-9', '-c'], input=b))

def members(blob, group_ids=True):
    # Record character offsets, then encode each exact span to count bytes.
    s = blob.decode('utf-8')
    decoder = json.JSONDecoder()
    ws = re.compile(r'\s*')
    spans = collections.defaultdict(list)
    def skip(i):
        return ws.match(s, i).end()
    def walk(i, path):
        if s[i] not in '{[':
            return decoder.raw_decode(s, i)[1]
        obj = s[i] == '{'
        stop = '}' if obj else ']'
        i = skip(i + 1)
        while s[i] != stop:
            start = i
            if obj:
                key, i = decoder.raw_decode(s, i)
                colon = skip(i)
                assert s[colon] == ':'
                name = '*' if group_ids and path == 'details' else key
                member = f'{path}.{name}' if path else name
                i = walk(skip(colon + 1), member)
                spans[member].append(s[start:i].encode('utf-8'))
            else:
                i = walk(i, path + '[]')
            i = skip(i)
            if s[i] != stop:
                assert s[i] == ','
                i = skip(i + 1)
        return i + 1
    assert skip(walk(skip(0), '')) == len(s)
    return spans


def measure():
    c = compact(D)
    R, C = members(raw), members(c)
    print('WHOLE', len(raw), len(c), gzip(raw), gzip(c))
    print('ASCII COMPACT', len(json.dumps(D,separators=(',', ':')).encode()), gzip(json.dumps(D,separators=(',', ':')).encode()))
    for k in D:
        line = stat(R, C, k)
        print(line)
    print('OVERHEAD',len(raw)-sum(len(R[k][0]) for k in D),len(c)-sum(len(C[k][0]) for k in D))
    return R,C


def stat(R, C, k):
    r, c = R[k], C[k]
    assert len(r) == len(c)
    return f'| `{k}` | {len(r):,} | {sum(map(len,r)):,} | {sum(map(len,c)):,} | {gzip(b",\n".join(r)):,} | {gzip(b",".join(c)):,} |'

FIELDS = {
    'news': 'eid date source title n_outlets crypto',
    'x': 'eid date last subject project claim stage score accounts credible stale amount_usd_claimed',
    'registry': 'id first_reported latest event_date org title type country status usd records n_outlets',
    'crypto': 'eid date listed_at name amount returned chains classification technique target offchain',
    'kev': 'eid id date listed_at vendor product name ransomware due',
    'breaches': 'eid name title added breach_date count classes',
}

def fixture(D):
    # Source order is preserved within each tier. Build token is carried by each file.
    gen = D['generated']
    cut = dt.datetime.fromisoformat(gen) - dt.timedelta(days=7)
    wrappers = {'crypto', 'kev', 'breaches'}
    hot = {k: v for k, v in D.items() if k not in (*FIELDS, 'notices', 'details', 'clusters')}
    detail = {'generated': gen, 'details': D['details'], 'records': {}}
    history = {'generated': gen, 'clusters': D['clusters'], 'positions': {}}
    counts = {}
    keep_ids = set()
    def t(s):
        return dt.datetime.fromisoformat(s if len(s) > 10 else s + 'T23:59:59Z')
    for kind, date_fields in {
        'news': ('date',), 'x': ('last', 'date'), 'registry': ('latest', 'first_reported'),
        'crypto': ('date', 'listed_at'), 'kev': ('date', 'listed_at'), 'breaches': ('added',),
        'notices': ('date',),
    }.items():
        src = D[kind]['items'] if kind in wrappers else D[kind]
        recent, old, positions = [], [], []
        for i, row in enumerate(src):
            if not any(row.get(k) and t(row[k]) >= cut for k in date_fields):
                old.append(row)
                positions.append(i)
                continue
            if kind == 'notices':
                recent.append(row)
                continue
            id_ = 'r-' + row['id'] if kind == 'registry' else row['eid']
            assert id_ not in keep_ids
            keep_ids.add(id_)
            keys = set(FIELDS[kind].split())
            pr = {k:v for k,v in row.items() if k in keys}
            if kind == 'registry':
                pr['stories'] = [{k:v for k,v in item.items() if k in {'eid','title'}} for item in row['stories']]
                pr['updates'] = [{k:v for k,v in item.items() if k == 'text'} for item in row['updates'][-1:]]
            if kind == 'x':
                pr['matches'] = [{'eid': m['eid']} for m in row['matches'] if m.get('eid')]
                pr['posts_n'] = len(row['posts'])
            tail = {k:v for k,v in row.items() if k not in keys}
            detail['records'][id_] = tail
            recent.append(pr)
        counts[kind] = (len(recent), len(old))
        hot[kind] = (D[kind] | {'items': recent}) if kind in wrappers else recent
        history[kind] = old
        history['positions'][kind] = positions
    # All registry aliases are used to suppress duplicates in the current brief. The
    # other alias fallback in drawGlance only checks registry rows at most 3 days old.
    hot['registry_aliases'] = sorted({m.lower() for r in D['registry'] for m in (r.get('match') or []) if len(m.lower()) >= 4})
    hot['details'] = {k: {'patterns': v['patterns'], 'related_n': len(v['related'])}
                      for k, v in D['details'].items() if k in keep_ids}
    return cut, counts, hot, detail, history


def rejoin(hot, detail, history):
    merged = {k: v for k, v in hot.items() if k != 'registry_aliases'}
    merged.update(details=detail['details'], clusters=history['clusters'])
    assert hot['generated'] == detail['generated'] == history['generated']
    for kind, positions in history['positions'].items():
        wrapped = kind in {'crypto', 'kev', 'breaches'}
        recent = hot[kind]['items'] if wrapped else hot[kind]
        new = iter(recent)
        old = dict(zip(positions, history[kind], strict=True))
        rows = []
        for i in range(len(recent) + len(old)):
            if i in old:
                rows.append(old[i])
                continue
            row = next(new).copy()
            if kind != 'notices':
                id_ = 'r-' + row['id'] if kind == 'registry' else row['eid']
                row.pop('posts_n', None)
                row.update(detail['records'][id_])
            rows.append(row)
        merged[kind] = hot[kind] | {'items': rows} if wrapped else rows
    return merged


def splits():
    cut, counts, hot, detail, history = fixture(D)
    assert rejoin(hot, detail, history) == D
    assert len(compact(hot)) <= 1_048_576
    print('CUTOFF', cut.isoformat(), 'COUNTS', counts)
    for k,v in hot.items():
        if k in {'crypto','kev','breaches'}:
            print('HOT items', k,len(compact(v['items'])))
        print('HOT value', k,len(compact(v)))
    print('HOT details/aliases', len(hot['details']), len(hot['registry_aliases']))
    for name, obj in (('data-hot.json',hot),('data-details.json',detail), ('data-history.json',history), ('archive.json',json.loads(Path('site/archive.json').read_bytes()))):
        b = compact(obj)
        print(name,len(b),gzip(b))
    archive = Path('site/archive.json').read_bytes()
    print('archive actual',len(archive),gzip(archive))
    print('hot headroom',2**20-len(compact(hot)))


if __name__ == '__main__':
    import sys
    if 'split' in sys.argv:
        splits()
    else:
        R,C = measure()
        if 'subkeys' in sys.argv:
            for root in D:
                names = sorted(k for k in R if k.startswith(root+'.') or k.startswith(root+'[]'))
                if not names: continue
                print('\n<details>\n<summary><code>'+root+'</code> subkeys ('+str(len(names))+')</summary>\n')
                print('| Path | Members | Raw | Compact | Gzip raw | Gzip compact |')
                print('| --- | ---: | ---: | ---: | ---: | ---: |')
                for k in names: print(stat(R,C,k))
                print('\n</details>')
```

Run as `python /tmp/profile.py` for top-level sizes, `python /tmp/profile.py subkeys` for the nested tables, or `python /tmp/profile.py split` for the proposed files. Each gzip result includes its own stream overhead. The measurements exclude HTTP headers.

</details>
