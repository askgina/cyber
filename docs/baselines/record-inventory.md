# Record inventory and publishing baseline

[Issue #16](https://github.com/t-y-b-b/breach-ledger/issues/16) · [Decision #17](https://github.com/t-y-b-b/breach-ledger/issues/17#issuecomment-7159809567)

**Baseline:** 12,833 archive rows and 2,033 live record fragments. Under the proposed eligibility rules below, the available data supports **3,272 archive/durable record pages** and **95 routine record pages**. With 90 daily pages and 18 view/pattern pages, the Decision #17 budget is **3,475 routes, 6,950 HTML/Markdown objects, and about 20.23 MB** of new page content. The route budget is a projection, not a count of pages already served.

## Measurement scope

- Both `site/data.json` and `site/archive.json` have `generated: 2026-11-24T19:12:13Z` (Git snapshot `c9d9548`). The archive covers January 1 through November 24, inclusive: 328 UTC days. The last day is partial. Six older curated incidents are in the registry but outside `archive.json`.
- Python read both snapshots, the two registry inputs, the X input, and every JSON file in `pipeline/archive_cache/`. The inventory follows `pipeline/build_data.py`, `pipeline/archive.py`, `pipeline/registry.py`, and `pipeline/search_docs.py`. It also checks the code that assigns IDs, resolves hashes, and writes to R2. It does not make network requests or infer records beyond the saved data.
- Counts are per record kind, not counts of unique real-world incidents across all sources. Summaries, enrichment, archive representations, and news coverage can refer to the same event. The saved live build reports that the Maine notice database was offline. Live windows, source availability, cache coverage, and feed limits affect how many rows were saved.

## Section and view hashes

The current site uses one HTML document. A fragment selects a view, scrolls to an element, or opens a record in JavaScript. The server does not receive the fragment. The table lists the authored navigation and report anchors, not internal DOM IDs for controls and display fields.

| Hash | Current behavior | Canonical destination for the route budget |
| --- | --- | --- |
| No hash, `#`, `#terminal` | Terminal, the default view. A bare `#` is also the initial Ask button placeholder. | `/` |
| `#leaderboard`, `#top` | Crypto leaderboard. Although the report opening has `id="top"`, the router explicitly sends `#top` to the leaderboard. | `/leaderboard` |
| `#report` | Opens the report at the top. | `/report` |
| `#glance` | Report's Today overview and 24-hour summary. | `/report#glance` |
| `#live` | Live feed and hourly activity. | `/report#live` |
| `#fig1` | Report figure with counts and daily series. It is a DOM anchor, not a navigation command. | `/report#fig1` |
| `#today` | Report section for current coverage. This is distinct from `#glance`. | `/report#today` |
| `#news` | Reported stories. | `/report#news` |
| `#x-signals` | Early signals on X. | `/report#x-signals` |
| `#patterns` | Pattern counts and filters. | `/report#patterns` |
| `#clusters` | Related-incident groups in the report. | `/report#clusters` |
| `#crypto` | Crypto incident list. | `/report#crypto` |
| `#ransomware` | Ransomware leak-site claims and aggregate counts. | `/report#ransomware` |
| `#groups` | Ransomware group counts. | `/report#groups` |
| `#sectors` | Ransomware sector and country counts. | `/report#sectors` |
| `#breaches` | HIBP additions. | `/report#breaches` |
| `#exploited` | CISA Known Exploited Vulnerabilities (KEV). | `/report#exploited` |
| `#method` | Method and scope. | `/method` |
| `#stages`, `#sources`, `#elsewhere`, `#limits` | Method subsections: confidence stages, sources, other trackers, and limitations. | Corresponding fragment on `/method` |
| `#cite` | Citation. | `/report#cite` |
| `#term` | Skip link target for the terminal container. The router does not treat it as `#terminal`. | Accessibility anchor only |
| `#cl-<6 lowercase hex>` | Dynamic cluster anchor. The digest is the first six hex digits of SHA-1 over sorted member IDs joined with `\|`. Any membership change can change the ID. | No standalone route |

`#e-<ref>` is a separate record dispatcher, not a section hash. It can open a leaderboard match in that view or fall back to the terminal inspector. Terminal archive tabs (`7d`, `YTD`, `Crypto`, `Ransom`, `KEV`, `HIBP`), the archive type/month filters, and pattern filters do not define hashes. `#archive` and `#YYYY-MM-DD` are not current routes. The router falls back to the report for other hashes and attempts to scroll to the matching DOM ID. This fallback does not make those IDs public routes.

## Record IDs and stability

`h8(s)` below means the first eight lowercase hex digits of SHA-1 over the UTF-8 string `s`. The `+` operator denotes concatenation with **no separator**. `enrich.py` assigns `eid` before the final English text pass. These IDs are lookup values, not a durable public URL contract.

| Kind | Exact current ID or reference | Stability and proposed public identity |
| --- | --- | --- |
| Curated incident | `#e-r-<id>`. `id` comes directly from the registry. Archive field `r` holds the same unprefixed ID. | The 1,136 IDs are unique. All match `[a-z0-9]+(?:-[a-z0-9]+)*` in this snapshot. The loader does not enforce that format. Keep `/incidents/r-<id>` unchanged after publication. Edits to an incident and moves between registry files do not change the ID. Only an explicit merge should redirect it. |
| Crypto | `#e-c-<h8(name + date)>`, where `date` is the tracker day `YYYY-MM-DD`. The separate first-seen key is `c:<normalized-name>:<date>`, with parenthetical text removed and remaining text reduced to lowercase ASCII letters and digits. | A tracker rename, preferred tracker change, or date correction can change the `eid`. Assign a permanent key on first publication from a provider event ID when available. Otherwise use a vetted tracker row and its original event name/day, then retain aliases for corrections and equivalent tracker entries. |
| KEV | `#e-k-<h8(id)>`, where `id` is the exact `cveID` from CISA. The first-seen key is `k:<id>:<dateAdded>`. | Use the lowercased CVE in the public key, for example `kev-cve-YYYY-NNNN`. The CVE survives changes to dates, vendors, titles, and descriptions. The `k-` hash survives changes except to the actual input ID and is present only in the live slice. |
| HIBP breach | `#e-b-<h8(name)>`, using the exact HIBP `Name`, not `Title` or `Domain`. | Use the HIBP record key, available in `/Breach/<Name>` in the archive source URL. Keep the original `Name` as an alias and freeze the public slug. An upstream rename can change the legacy hash. |
| News | `#e-n-<h8(url)>`, using the lead story's exact URL. `gnews.stories()` prefers English, then trade press, then the earliest item. Its story date is the earliest date in the cluster, not necessarily the lead article date. | Reclustering, source preference, feed expiry, or a different URL wrapper can change the ID. For eligible news, pin a published story key to the publisher's canonical article URL or an editorial cluster ID. Alias replaced leads. Do not hash a Google News wrapper as the canonical key. |
| X signal | `#e-x-<h8(subject + date[:10])>`. In the scored output `date == first`: the earliest post time, preferably decoded from its numeric X status ID, otherwise taken from a supplied date. | Subject edits, earlier evidence, or a split/merge can change the ID. Use an assigned signal key anchored to a saved status ID, not the mutable subject or the currently earliest post. Keep evidence and stage changes on the same page. |
| Archive-only or archived copy | `archive.json` has **no serialized `id` field**. `term.js` synthesizes `r-<r>` for curated rows and `a-<zero-based items array index>` for the other 11,703 rows. An archive inspector can emit `#e-a-<index>`. | Array position is ephemeral: inserts, removals, and reordering can silently change which record a stale hash opens. Never use it for a permanent slug or a redirect without a versioned position-to-ID map. For an archived copy of a live crypto, KEV or HIBP row, use the same canonical record key as the live copy. |
| Archive search reference | `a:<k>\|<d>\|<o>\|<t-or-empty>\|<u-or-empty>` (literal pipe separators). `search_docs.py` emits it for `crypto`, `kev`, `breach`, `notice`, and `sec`. `term.js` builds a lookup for all archive kinds, including `inc` and `ransom`. | The palette loads the archive, resolves the reference, then sets `#e-<id>`. An `a:` string is not itself a fragment route. It has no escaping for embedded pipes and depends on the display name, title, day, and source URL. It is unique in this snapshot, not stable across edits or translation. Use CVE, HIBP Name, a pinned crypto key, a notice report/document ID, or an SEC accession number instead. For catalog rows without individual IDs, pin the provider/original entity/submission-day tuple. |
| Group claims and live notices | Live ransomware has no `eid`. The cache key is exact `victim\|group`. The archive trims the victim name and deduplicates `victim\|group` case-insensitively, with monthly rows taking precedence over recent rows. The live notice feed key is `o:` + URL + organization. | No public detail ID in the live feed. `official.py` also coalesces live notices by normalized organization and UTC date. The archive merges per source by normalized organization and UTC date. These keys can collapse distinct claims or notices. Do not promote them directly to public IDs. SEC rows are deduped by accession during fetch, then can be further coalesced by the archive merge. |
| Browser-only poll rows and leaderboard keys | Crypto browser-poll key `live-<normalized-name>` and HIBP poll key `live-hibp-<Name>` have no `eid`. The board joins on lowercased alphanumeric-only `name\|date`. Board-only keys are `arc-<join-key>` or `live-<join-key>` when there is no live `eid`. | Poll rows link out. Board-only keys are for inspection, not emitted permalinks. Names, dates, or the available live row can change the key. |
| Patterns | `p.id` is the exact code-defined key in `pattern_defs` and `patterns`, not a hash fragment. | Use the 14 defined IDs unchanged for `/patterns/<p.id>`. Keep a stable alias if the taxonomy changes. `unclassified` is a fallback bucket, not a topic page. |
| Daily report | Proposed `/daily/YYYY-MM-DD`, keyed by UTC calendar day. Existing series use `YYYY-MM-DD`. Search buckets use `<kind>/YYYY-MM-DD.md`, not the public page path. | Freeze the UTC day even after corrections. Store corrections under that same date. Do not use the build timestamp, local time, or a relative string such as `today` for the key. |

The 14 pattern IDs are `key-compromise`, `supply-chain`, `bridge`, `contract-logic`, `edge-device`, `enterprise-platform`, `injection-rce`, `memory`, `phishing`, `ransomware`, `data-exposure`, `ai`, `state-linked`, and `outage`. The snapshot has 15 statistics rows (including `unclassified`, with 466 records) and 12 cluster rows. None of the current pattern rows is a standalone article. The budget reserves one page per defined pattern if it gains a substantive explanation, evidence, and cited examples. Clusters, updates, precedent cards, notices attached to incidents, and related links do not multiply record pages.

**Normalize once and store the mapping.** Keep curated and pattern identifiers as written. For generated routes, namespace by kind and prefer a source-assigned ID. When a readable slug is needed, apply Unicode NFKD, discard combining marks and non-ASCII characters, lowercase, replace runs outside `[a-z0-9]` with a single hyphen, and trim hyphens. Use a kind-based fallback for an empty slug. Pin the result and resolve collisions with a checked suffix from a longer digest of the immutable source key (serialize tuple components unambiguously). Do not rely on the 32-bit legacy hash for uniqueness. Normalize article URLs against verified publisher canonicals. Strip fragments and known tracking parameters, but preserve parameters that identify the article. Leave historical keys in an alias map. Resolve `#e-` and known `a:` inputs in the browser for old bookmarks/search hits. Never guess a successor from an ordinal, a fuzzy name match, or a generic section.

## Source coverage and eligibility

A URL count means an absolute HTTP(S) URL with a hostname in the indicated source field. It does not mean the URL was fetched, confirms a claim, or links directly to one record. Title and text counts require nonblank strings. Date counts require parseable dates and use the source-specific date below. A record must identify a distinct source-backed event, vulnerability, breach, notice, filing, or story and state what the evidence does and does not establish. A clear source URL plus concise structured facts can qualify. A template headline, a tracking link alone, or a recycled feed snippet cannot.

### Live feed and curated inputs

| Input and kind | Rows | With URL | With title/name | With description, summary or claim | With date | Quality and disposition |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `data.registry` | 655 | 655 | 655 | 655 | 655 | Curated source + summary + `first_reported`. These have durable IDs. 649 are in the 2026 archive and six predate it. |
| `data.crypto.items` | 60 | 60 | 60 | 59 | 60 | DefiLlama and SlowMist. 40 have an incident-specific reference, separate from the tracker/X search links. All 60 join to archive rows. |
| `data.kev.items` | 39 | 39 | 39 | 39 | 39 | CVE, vendor/product, CISA details, NVD link and `dateAdded`. All 39 join to archive rows. |
| `data.breaches.items` | 8 | 8 | 8 | 8 | 8 | HIBP record link, description and listing time (`added`), separate from breach date. All eight join to archive rows. |
| `data.news` | 1,005 | 1,005 | 1,005 | 116 | 1,005 | 889 have no summary. 911 lead URLs are Google News wrappers, 94 are direct. 940 have at least two outlets. 54 already open a crypto record, and 359 have an `eid` attached to a live curated story. **54 qualify for a routine page.** |
| `data.x` | 266 | 266 | 266 | 266 | 266 | 1,393 attached posts. Every signal has a status link, but only 45 are Confirmed and 24 Post-mortem. The other 197 are Corroborated (107), Unconfirmed (65), Claimed (12), Rumour (11), or Disputed (2). **41 qualify for a routine page.** |
| `data.notices` | 100 | 100 | 100 | 100 | 100 | 61 press-attack rows, 21 California, 17 Oregon, and one Washington. The 39 agency notices also appear in the archive. The press-attack rows stay as evidence/feed links here, not new pages. |
| `data.ransomware.items_24h` | 19 | 19 | 19 | 19 | 19 | The descriptions range from 3 to 200 characters. All 19 link to the tracker and match archive claims. Treat these as attributed claims, not verified incident accounts. |
| `pipeline/incidents.json` | 605 | 605 | 605 | 605 | 605 | Curated active input. |
| `pipeline/incidents_archive.json` | 531 | 531 | 531 | 531 | 531 | Same schema. Not the same archive as `site/archive.json`. |
| Merged curated inputs | 1,136 | 1,136 | 1,136 | 1,136 | 1,136 | `registry.load()` merges by ID, with the active input winning. There are no overlapping IDs here. 487 have a separate `event_date` and 251 have updates. All 1,136 qualify. |
| `pipeline/x_signals.json` | 297 | 297 | 297 | 297 | 297 | 1,483 posts. Raw signals have no top-level date. A date is available from post timestamps or status IDs for all 297. Scoring then keeps 266 from signals active in the past week by `last`, not `first`. Do not add the other 31 to the scored-route budget. |

Registry URLs come from `sources[].url`. Crypto, KEV and HIBP use `links[].url`. X uses posts, links, or the postmortem URL. News, notices, and live claims use `url`. The five `eid` lists total **1,378** unique IDs, exactly matching the `details` map. Those IDs plus the 655 `r-` IDs give **2,033** live record fragments. `registry.attach()` can add outlets, stories and notices and can advance `latest`. The live registry retains rows based on `latest` within 45 days, not `first_reported`. None of those changes creates a new curated ID.

`data.news_headlines_7d` counts 9,981 input headlines. It is not a route count. The 1,005 rows are selected story clusters. The live crypto list is capped at 60 against 65 thirty-day archive entries. KEV is capped at 40 but stores 39; HIBP stores eight. The archive holds 9,532 ransomware rows, not the 9,833 in the external YTD ransomware statistics. The live ransomware summary reports 1,262 in its rolling 30-day window. The 30 calendar archive days below hold 1,313 claims. These windows and deduplication rules differ. The brief has 12 incident mentions, not 12 more records. The chart has 24 hourly bins and three 30-day series, not historical page objects. The 200 triage rows are matching work, not standalone pages.

For the budget, admit a live news story only when its lead URL is direct (not `news.google.com`), its stripped summary has at least 120 characters and differs from its stripped title ignoring case, and it is not already linked to a crypto record or attached to a live curated story by `eid`. For X, require at least 120 characters of stripped claim text, a status URL, a Confirmed or Post-mortem stage, and no existing crypto/HIBP/KEV database match. These are repeatable inventory gates, not a substitute for checking the source and editorial context before indexation. Keep excluded stories and signals as feed entries or source links. The 54 qualifying news rows and 41 qualifying X rows are measured from the checked-in snapshots, not recovered from unsaved past feeds.

### Archive rows and cache evidence

| `archive.items[].k` | Rows | With URL `u` | With title `t` | Description or context | With date `d` | Eligible archive rows |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| `inc` | 1,130 | 1,130 | 1,130 | 1,130 curated `rec.summary` | 1,130 | 1,130 |
| `crypto` | 380 | 380 | 380 | 380 structured `x` rows, not full descriptions | 380 | 380 |
| `ransom` | 9,532 | 9,523 | 9,532 | 0 descriptions. 9,531 have metadata `x` (sector/country/domain). Titles are claim templates. | 9,532 | 0 |
| `kev` | 311 | 311 | 311 | 311 structured `x` rows. The compact archive drops the CISA short description. | 311 | 311 |
| `breach` | 120 | 120 | 120 | 120 structured `x` rows. The compact archive drops the HIBP prose. | 120 | 120 |
| `notice` | 1,335 | 1,335 | 1,335 | 1,335 nonblank summary snippets after the agency label. Many are filing or report metadata, not an account of the incident. | 1,335 | 1,300 |
| `sec` | 25 | 25 | 25 | 25 filing summaries made from form/date/item metadata. No filing narrative in the snapshot. | 25 | 25 |
| **Total** | **12,833** | **12,824** | **12,833** | | **12,833** | **3,266** |

Use `first_reported` for curated incidents, event day for crypto, discovery/posting day for claims, CISA catalog addition day for KEV, HIBP addition day for breach, report/submission day for notices, and filing day for SEC. A reporting day does not establish the date of compromise.

- **Crypto:** 368 DefiLlama rows point to its general hacks page, and 12 SlowMist-only archive rows have incident-specific URLs. The 368 have named, dated rows in the tracker cache, with source fields for target and other facts such as classification, chain, technique or loss. The 12 have cached descriptions, techniques and separate references. Count these as source-qualified only if the page cites the exact named/datelined tracker entry and distinguishes tracker estimates from confirmation. Live overlays supply 28 additional incident-specific references, for **40 distinct crypto records with direct references** across the two snapshots. Use those where available.
- **KEV and HIBP:** all have a record-specific link. Archive KEV rows have the CVE and vendor/product facts. HIBP rows have the record name, added day, count and breach/data-class metadata. Use these as sourced catalog entries, not reconstructions of an attack. Restore longer source text only when available and appropriate to reuse. Attribute HIBP.
- **Notices and SEC:** join archived notices to the agency cache. Use source, day and URL for California, Washington and SEC. For HHS/Oregon, add the archived organization name (whitespace-normalized and truncated to 90 characters) because the list URL is shared. Qualify California if there is a separate breach date or reported count (507 of 542). The other **35** have only the report-date template as usable context. Washington needs a breach date, affected count or data-type detail (212 of 212). Oregon needs a breach date or count (181 of 181). HHS needs a reported count and its agency row with breach context (400 of 400). The 581 Oregon/HHS citations go to agency lists. The page must identify the specific reporting entity and submission date so the cited row can be found. SEC has 25 accession-specific links. Budget them as filing pages, not independent incident narratives.
- **Ransomware:** 9,174 archive URLs are tracker `/id/` links, 349 are external links, and nine claims have no URL. None carries substantive incident prose in the archive. A linked or named claim alone is not eligible. Where independent evidence warrants a page, create or enrich the curated incident and cite the claim there with its attribution and uncertainty.
- **Overlap:** all live crypto, KEV, HIBP, and 24-hour claim rows join to their archive kind. The crypto join uses the leaderboard normalization (lowercase alphanumeric name plus day), KEV uses CVE, HIBP uses `Name`, and claims use trimmed case-insensitive victim/group. No `dup` flags are present in the saved archive. The current build has a token-and-±4-day crypto/registry heuristic that would suggest 55 candidates on these inputs, including false matches. The archive also adds registry cross-references on 37 HIBP rows, 165 notices and 15 SEC rows. These are not identity proofs. The budget counts distinct catalog and documentary records as such, merges live/archive copies by kind, and does not automatically subtract unreviewed cross-kind candidates. If review establishes a true duplicate, consolidate it under the canonical record and redirect an already-published alias.

`pipeline/archive_cache/` holds **52 files and 3,345,672 uncompressed bytes**. The 11 monthly files per source contain 368 DefiLlama rows, 311 KEVs, 120 HIBP rows and 9,523 raw ransomware rows, respectively. The five notice caches contain 1,360 rows including SEC. `slowmist.json` holds 12 rows and `ransom_recent.json` holds 1,458 accumulated entries. Those recent claims overlap monthly data, so adding the two counts would overstate the archive. `state.json` records ransomware fetch state. The month slices rebuild from source catalog data, the recent ransomware cache accumulates, and agency caches merge incrementally. An unchanged record date is not evidence that a record's contents did not change.

## Route budget and retention

[Decision #17](https://github.com/t-y-b-b/breach-ledger/issues/17#issuecomment-7159809567) selects **full eligible archive history**, a **90-day rolling window for daily/routine routes**, and **durable curated pages**. Keep archive record pages separate from daily browse/report routes. Keep eligible archive crypto, KEV, HIBP, notice and SEC records beyond 90 days. Retire daily and qualifying routine news/X routes after 90 UTC calendar days. Do not retire a routine route simply because it left a shorter live feed window: persist its normalized snapshot until expiry. Return `410 Gone` for a retired route and `301` only for a true merged successor. Keep route status in the routing layer, not as an HTML/Markdown pair per retired URL. An unknown route is not a retirement and should return `404`.

One route below means one canonical HTML page plus one Markdown companion. Companion URLs and aliases are not extra canonical HTML routes. The budget assumes four fixed views (`/`, `/leaderboard`, `/report`, `/method`), 14 conditional pattern pages, one `/incidents/<id>` route per eligible record, and one daily report per covered UTC day in the selected window. There are zero persisted daily report pages today. The daily figures reserve capacity for a sourced day summary (including attributed aggregates when no individual page qualifies), not one page per kind per day. Six archive days outside the last 90 have no eligible record rows and may lack enough material for a substantive daily page. Count the partial latest day but label it as partial. Do not backfill daily pages for the six isolated older curated records outside the archive period.

The depth comparisons below use inclusive UTC cutoffs: Oct 26 (30d), Aug 27 (90d), and Nov 25, 2025 (365d). They keep all curated records in every scenario. The comparison cuts both noncurated archive records and routine pages at the stated depth. Only the last line implements the decision. All 12,833 archive rows are within 365 days, so 365d and full use the same available records and daily coverage. Only 2,103 archive rows are within 30d and 4,523 within 90d, before eligibility. No continuous news/X archive exists, so deeper routine scenarios do not synthesize older news/X rows.

| Depth | Curated, all ages | Crypto | KEV | HIBP | Notices | SEC | Routine news / X | Daily | Views + patterns | Total routes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 30d | 1,136 | 65 | 39 | 8 | 114 | 0 | 54 / 38 | 30 | 18 | **1,502** |
| 90d | 1,136 | 142 | 113 | 23 | 366 | 5 | 54 / 41 | 90 | 18 | **1,988** |
| 365d | 1,136 | 380 | 311 | 120 | 1,300 | 25 | 54 / 41 | 328 | 18 | **3,713** |
| Full available depth | 1,136 | 380 | 311 | 120 | 1,300 | 25 | 54 / 41 | 328 | 18 | **3,713** |
| **Decision #17: full eligible archive + 90d routine** | **1,136** | **380** | **311** | **120** | **1,300** | **25** | **54 / 41** | **90** | **18** | **3,475** |

| Depth | Est. HTML bytes | Est. Markdown bytes | Est. combined bytes | Page objects at 2 per route |
| --- | ---: | ---: | ---: | ---: |
| 30d | 7,554,552 | 2,014,404 | 9,568,956 | 3,004 |
| 90d | 9,926,004 | 2,490,018 | 12,416,022 | 3,976 |
| 365d | 18,449,603 | 4,220,268 | 22,669,871 | 7,426 |
| Full available depth | 18,449,603 | 4,220,268 | 22,669,871 | 7,426 |
| **Decision #17** | **16,499,907** | **3,732,844** | **20,232,751** | **6,950** |

**Byte model.** For each eligible record project `title + "\n" + body` with `search_docs.records()`, without its search `Record:` reference or daily front matter. Use full merged inputs for curated payloads, compact archive rows for noncurated archive payloads, and live records for news/X. Count UTF-8 bytes after Python `html.escape()` and add 4,096 per HTML page for markup, metadata, navigation and structured data. Count unescaped UTF-8 bytes and add 512 for each Markdown companion. Reserve 12,288 HTML and 3,072 Markdown bytes per fixed view, and 8,192 and 2,048 respectively per pattern or day. This sizes evidence and templates, not the final renderer. It excludes shared assets, full copies of source documents, compression, feeds, sitemaps and routing metadata. The estimated averages for a record pair range from about 5.1 KB (crypto) to 7.8 KB (X), based on these inputs. Prototype actual pages before using the estimates as limits.

Two sensitivities matter. If publication requires an incident-specific source URL rather than an identifiable official/tracker catalog row, 340 crypto records and 581 notices would need enrichment first. That stricter gate yields **2,554 policy routes and 15,432,984 estimated page bytes**. Conversely, a continuously persisted 90-day news cohort will be larger than the available slice. A constant rate of 54 qualifying stories per seven days would imply about 694, or about 640 more pairs (~3.50 MB) than this snapshot budget. That is an illustration, not a measured 90-day estimate.

## Hourly churn and R2 footprint

### Timestamp activity versus changed records

The 23 **completed** UTC bins in `data.hourly` contain 527 news stories, 18 ransomware claims, and zero X first posts. The partial 19:00 bin is excluded. Combined activity was 9–39 records per completed hour, with a lower quartile of 17, median 25, and 90th percentile of 32.6. The busiest completed bin was 09:00 UTC, with 39. The snapshot's trailing-hour counters separately show 13 news stories from 26 headlines, three newly listed KEVs and no new crypto listings or ransomware/X entries. Completed bins and the trailing hour are different intervals. They count source timestamps, not new or corrected rows written by a build. Archive `d` is day-granular, so archive write churn must come from snapshot differences.

For the differences below, Python loaded both JSON files at each commit using `git show`. Within each endpoint, the two `generated` timestamps agree. Live rows were keyed by record identity (`id` for registry/CVE, `eid` for news/X, normalized name+day for crypto, HIBP Name, agency-style org+day for notices, victim/group for claims). Archive rows were keyed by kind plus registry ID, normalized name/day, CVE, HIBP Name, source/org/day or victim/group as applicable. Compare values, not array position. Ignore elapsed-time display fields `age_days` and `age_h`; do not count the separate `details` map as source records. An identity change under these keys can still appear as a removal and an addition. Do not add live and archive deltas to claim a count of distinct real-world events.

| Interval (UTC, from `generated`) | Git pair | Live added / changed / removed | Archive added / changed / removed | Search docs added / changed / removed | Search bytes put | Projected record pages added / changed / removed |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Nov 24 16:22:54 → 17:14:17 (51m 23s, quiet archive) | `ffded2d` → `03ed247` | 46 / 114 / 28 | 0 / 0 / 0 | 0 / 9 / 0 | 492,607 | 4 / 1 / 0 |
| Nov 24 17:14:17 → 18:05:04 (50m 47s, quiet archive) | `03ed247` → `3d7fcba` | 53 / 118 / 37 | 1 / 1 / 0 | 1 / 10 / 0 | 507,237 | 6 / 1 / 0 |
| Nov 24 18:05:04 → 19:07:16 (62m 12s, active) | `3d7fcba` → `d2b3748` | 54 / 140 / 64 | 8 / 0 / 0 | 1 / 12 / 0 | 670,858 | 5 / 2 / 0 |
| Nov 23 12:33:45 → 13:33:27 (59m 42s, editorial updates) | `c89687f` → `edd625d` | 57 / 97 / 16 | 17 / 9 / 0 | 0 / 29 / 0 | 918,484 | 20 / 11 / 0 |
| Nov 23 11:33:26 → 12:33:45 (60m 19s, backfill/correction) | `aa0decb` → `c89687f` | 94 / 100 / 17 | 535 / 178 / 1 | 198 / 159 / 0 | 1,679,056 | 536 / 174 / 1 |

Search deltas compare the exact Markdown grouping and SHA-256 content manifest from today's `search_docs.py` applied to each historical JSON pair. Projected page deltas apply the eligibility gates to the historical JSON, curated inputs and notice caches at the same commits. They compare the normalized `day, title, body` record payload, not complete templates. The correction interval includes the Jan–Oct curated backfill (`b95125d`) and changes to cross-references, so the archive can change across hundreds of old dates in one hour. It is a measured burst, not a normal arrival rate.

A quiet archive hour in this sample can still change 188–208 live feed rows, mostly rolling story/coverage data. It changes **0–2 archive rows**, **9–11 search objects**, and **5–7 eligible record payloads** (10–14 projected page puts). The active example changes eight archive rows and seven eligible record payloads. The editorial interval changes 26 archive rows and 31 eligible payloads. For the correction hour, budget **714 archive row deltas, 357 search puts, 1,420 projected record page puts, and two page object removals**. The two quiet samples could also dirty four and three daily page pairs, respectively, if daily pages include all changed qualifying records dated in the active window. The correction could affect 64 active daily report dates (128 additional puts). View/pattern pages need dependency checks and are not counted in the delta column. Only rewrite them when their published content changes.

### Current and projected R2 inventory

| Object set | Objects | Bytes at baseline |
| --- | ---: | ---: |
| State `data.json` | 1 | 8,720,485 |
| State `archive.json` | 1 | 4,362,882 |
| State `state.tar.gz` | 1 | ~7,384,514 |
| State `search-manifest.json` | 1 | 92,599 |
| AI Search Markdown buckets | 1,028 | 2,911,908 |
| **Current layout, after successful sync of these inputs** | **1,032** | **~23,472,388** |
| Decision #17 page pairs, if also stored in R2 | 6,950 | ~20,232,751 |
| **Current layout plus projected pages** | **7,982** | **~43,705,139** |

The state tar size is a local in-memory gzip reconstruction using `container/server.py`'s `STATE` paths. It includes the two JSON snapshots as well as the caches. Tar metadata and live cache sizes can change the result. This is an estimate of steady object inventory for these inputs, not a listing of either deployed bucket. Search grouping yields 4,572 record sections in 1,028 files: 266 incident, 214 crypto, 139 KEV, 100 HIBP, 254 notice, 23 SEC, eight news, and 24 X files. Search excludes ransom, patterns, and the six pre-archive curated incidents. It includes all selected archive kinds and the live news/X rows admitted by the search generator, even if they fail public-page eligibility. Search Markdown and public Markdown serve different purposes.

`worker/index.js` rewrites the three state payloads every successful build and rewrites the search manifest after successful search sync. This is four state puts even if no record changes. Search only puts new or hash-changed keys and deletes stale keys. In the sampled quiet intervals that is **13–15 puts** including state, versus **361 puts** in the correction interval. The resident object totals are not multiplied by hours. For the proposed public pages use the same content-hash approach: do not include a build-wide `generated` timestamp, relative age, live rank, or unstable cluster relations in every record payload. Keep replacements and 410/301 state in a compact route registry. No manifest, tombstone objects, version history, or additional caching is included in the page-pair totals.
