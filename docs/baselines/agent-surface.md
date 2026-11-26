# Breach Ledger agent surface baseline

Research for [#24](https://github.com/askgina/cyber/issues/24). Source baseline: Breach Ledger `a312f6c` and Ask Gina Blog `9b83ddd`. **Observed** means measured on the public endpoint or checked against the pinned source, as marked below. **Target** means a contract for downstream work, not a claim about production. The discovery documents, WebMCP tools, and clean incident routes are not present in the source baseline.

## 1. Live `/api/search`

### Six-request sample

On 2026-11-25 at 10:36:17–10:36:24 UTC, six sequential cURL requests went to `https://cyber.askgina.ai/api/search`. Each used `Accept: application/json` and a fresh cURL invocation, with no redirects, retries, or cache bypass. All responses used HTTP/2 and had `CF-Ray` suffix `LHR`. Times are client wall-clock seconds, including connection setup. TTFB is time to first byte. A dash means the header was absent.

| # | Method and query | Status | Results / body bytes | TTFB / total (s) | `Cache-Control` | `CF-Cache-Status` | `X-Robots-Tag` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `GET ?q=ransomware` | 200 | 8 / 2714 | 4.006487 / 4.006541 | `public, max-age=300` | — | — |
| 2 | `GET ?q=CVE` | 200 | 8 / 3918 | 2.321766 / 2.321813 | `public, max-age=300` | — | — |
| 3 | `GET ?q=ransomware` | 200 | 8 / 2714 | 0.096805 / 0.096863 | `public, max-age=14400` | `HIT` | — |
| 4 | `GET ?q=a` | 200 | 0 / 14 | 0.077586 / 0.078084 | — | — | — |
| 5 | `HEAD ?q=ransomware` | 200 | no body / 0 | 0.064009 / 0.064155 | `public, max-age=14400` | `HIT` | — |
| 6 | `POST ?q=ransomware` (empty body) | 200 | 8 / 2714 | 0.093860 / 0.093909 | `public, max-age=14400` | `HIT` | — |

All six returned `Content-Type: application/json`. The three hits sent `Age: 2`, `Accept-Ranges: bytes`, and `Last-Modified: Wed, 25 Nov 2026 10:36:21 GMT`. Their `Expires` values were `Wed, 25 Nov 2026 14:36:23 GMT` for the repeat GET and HEAD, and `Wed, 25 Nov 2026 14:36:24 GMT` for POST. The HEAD advertised `Content-Length: 2714` without sending a body. Neither `Allow` nor `Retry-After` appeared in the six responses. The two `ransomware` GET bodies and the POST body had the same SHA-256 (`3181340dd75e9c06d2e5897f149d52d985acdbcd2c7c3fa1af97b5ff4a2a9d38`).

The repeat GET was about **41× faster** than the first GET for the same query (4,007 ms vs 97 ms total). The first two requests are **miss-like**: they had slow timings and the Worker miss header, not a literal `CF-Cache-Status: MISS`. One of the three cache-eligible GETs was a confirmed hit (1/3). Exclude the short query and method checks from that denominator. This is a controlled sample, not a production hit rate, percentile, or service-level objective.

The checked-in Worker writes successful searches to `caches.default` with `max-age=300`. On hits, the public response advertised **14,400 seconds** instead. The sample does not identify the Cloudflare setting responsible or establish how long the edge retains an entry. Audit the effective cache rules and browser TTL before publishing any TTL promise. The hits are incompatible with a current client-facing `no-store` guarantee.

### Request, status, and response schema

The [Worker](../../worker/index.js#L200-L215) reads the first `q` URL query parameter. It trims it, collapses runs of JavaScript whitespace to one space, and truncates to 300 UTF-16 code units. Fewer than three code units, including a missing `q`, returns an empty success before cache lookup or rate limiting. The command palette has its own four-character threshold and a debounce. Neither is an API requirement. There is no request body, authentication, pagination, or caller-defined result limit in the Worker contract.

| Status | Exact application envelope | Evidence |
| --- | --- | --- |
| `200` | `{ "results": [...] }`; an empty response is `{"results":[]}`. No `error` field. | Observed. |
| `429` | `{"results":[],"error":"too many searches, try again in a minute"}` | Worker limit branch. No `Retry-After`, rate-limit counters, `Cache-Control`, or `X-Robots-Tag` set by that branch. Not triggered live. |
| `502` | `{"results":[],"error":"search unavailable"}` | Worker catches search failures. No `Cache-Control` or `X-Robots-Tag` set by that branch. Not triggered live. |

The Worker returns JSON in each branch above. It does not emit application `400`, `401`, or `405` for `/api/search`. Treat Cloudflare or runtime errors outside those branches as HTTP failures, not as guaranteed JSON. In-memory mocks checked `429`, `502`, the short-query early return, and the unguarded cold POST path without consuming live quota.

Each success has at most eight results in upstream order after discarding chunks without a heading and duplicate headings. The [search adapter](../../worker/index.js#L104-L122) requests hybrid retrieval with OR keyword matching, up to 12 results, and reranking. It serializes the following fields, not the raw AI Search schema:

| Field | JSON type and presence | Meaning |
| --- | --- | --- |
| `title` | string, required | Trimmed first `#` heading of the chunk. |
| `ref` | string or `null`, required | Trimmed `Record:` line below the heading, or `null` when missing or blank. Opaque lookup key, not a URL. |
| `kind` | string, required | First segment of the index item key. Generated values: `incident`, `crypto`, `kev`, `breach`, `notice`, `sec`, `x-signal`, `news`. If the upstream key is absent, this can be `""`. |
| `date` | string, normally present | Second segment of the key after removing `.md`. Generated keys use `YYYY-MM-DD`; if there is no second segment, JSON omits `date`. This is the indexed record day, not the index or response timestamp. |
| `score` | number, required | Upstream relevance score rounded to two decimals, with zero as the fallback. Not confidence or source reliability. |
| `snippet` | string, required | Text after the heading up to the next heading, with the `Record:` line removed and whitespace collapsed. Trimmed and cut at 160 UTF-16 code units, without an added ellipsis. Can be empty. |

Exact example item from request 1:

```json
{
  "title": "Ransomware attack on Huntress",
  "ref": "r-huntress-ransomware-attack",
  "kind": "incident",
  "date": "2026-06-01",
  "score": 0.95,
  "snippet": "Organisation: Huntress. Type: ransomware. Sector: Cybersecurity. Country: US. Status: confirmed. First reported: 2026-06-01. Ransomnews listed Huntress as a con"
}
```

**Methods.** The Worker branches on the exact pathname regardless of method. It constructs a new **GET** cache key from that origin and the encoded, normalized, lowercase query. It sends the normalized query with original case to AI Search on a miss. This accounts for the observed shared GET/HEAD/POST representation and means a cold HEAD or POST can invoke search. Only warm HEAD and POST were tested live. Use GET for the public contract. Before publishing, reject unsupported methods before the cache lookup (e.g. `405` with `Allow: GET` for a GET-only contract). If HEAD is retained, define and test body-free behavior and whether it can consume miss budget. Do not advertise POST or treat its observed 200 as an alternative API.

### Traffic, quota, and index lag

| Question | Evidence and remaining work |
| --- | --- |
| Which calls consume budget? | [`SEARCH_LIMIT`](../../wrangler.jsonc) is configured for 20 uncached eligible requests per 60 seconds per `CF-Connecting-IP` (fallback `unknown`). A hit or short query bypasses it. The two miss-like requests consumed at most two upstream calls on this Worker path. The limit is [approximate and local to a Cloudflare location](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/). The [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/) does not replicate entries between data centers. |
| Shared egress | Users, agents, or jobs sharing an egress IP at the same location can contend for one miss budget, even with different queries. One egress sample with no `429` cannot measure that impact or prove spare capacity. Measure with synthetic clients on a staging deployment with mock search and known budgets. |
| Production hit rate and headroom | Unknown. The search branch does not emit search request metrics. `ledger_stats.searchable_documents` counts manifest files, not queries, indexed files, or billing. Collect a representative traffic window with hit, miss, short-query, throttle (by layer), upstream outcome, and duration counters. Calculate hit rate as `hits / (hits + misses)` for eligible cache lookups and compare upstream call counts with the AI Search dashboard. Log status, timing, and coarse cohorts, not query text or raw IPs. |
| Vendor allowance | [Cloudflare's published limits and pricing](https://developers.cloudflare.com/ai-search/platform/limits-pricing/) list 1,000 included semantic queries per account per month and bill hybrid queries above the allowance at $0.75/1,000 once billing begins Dec 1, 2026. This is an included allowance, not a hard rate limit or evidence of remaining account quota. Check current account plan, usage by all callers, billing, and configured budgets before choosing public thresholds. |
| Index lag | Not measured. The hourly cron starts at `:07`. The [build and index sync](../../worker/index.js#L26-L45) publishes snapshots to R2, then [uploads changed search documents, removes stale files, and starts an indexing job](../../worker/index.js#L73-L101) when files changed. Job creation is not completion. The data build can succeed despite sync failure. The vendor's [external-source sync default](https://developers.cloudflare.com/ai-search/configuration/indexing/syncing/) is 24 hours, not a claim about this instance's configured sync interval. This sample contains no known newly published record, and result dates are source dates. Record snapshot activation, upload completion, job completion, and first retrieval of a known new or corrected record via an uncached staging query or authorized job telemetry. Track cached-result staleness separately. |

The owner decision in [#25](https://github.com/askgina/cyber/issues/25#issuecomment-7159810635) is **target policy**: anonymous access, separate outer request and tighter miss budgets, an explicit `429` with `Retry-After`, and edge-only reuse with client-facing `Cache-Control: no-store`. Numbers and retry timing are not established by this baseline. Apply `no-store` on the outgoing response on both hits and misses, not to the stored success copy. Do not cache throttles or failures. Verify the headers on wire and keep a rollback switch for public search exposure. Do not send secrets or personal data in `q`: `no-store` does not remove query strings from URLs or operational logs.

## 2. Canonical record links

**Current behavior:** [`pipeline/search_docs.py`](../../pipeline/search_docs.py#L16-L37) writes `Record:` values. [`site/palette.js`](../../site/palette.js#L54-L65) checks the live index, then loads the archive as needed. [`site/term.js`](../../site/term.js#L229-L247) creates the archive indexes and prefills the combined index without overwriting live records. Its public navigation is a browser fragment, `/#e-<id>`. A non-curated archive row gets `a-<zero-based array position>` at load time. That position can change on every build. The current API has no URL field, and this baseline did not test any clean incident URL over HTTP.

**Target under Map 3 [#15](https://github.com/askgina/cyber/issues/15) and [#18](https://github.com/askgina/cyber/issues/18):** Resolve the exact ref in one shared route registry. If the matched record has an active, source-qualified standalone route, return `https://cyber.askgina.ai/incidents/<id>`, where `<id>` is the registry's public ID as a single percent-encoded path segment. Prefer the live representation of the same ID; falling back to its archive representation must not change the URL. Do not convert a search result's `kind`, title, snippet, or date to an ID. Section/feed entries and external source URLs are not canonical incident URLs. Use an exact `ref → public ID` alias map and an `ID → active canonical route` map from the same snapshot. The second lookup must succeed even when the first is an identity mapping.

| `/api/search` ref | Exact current lookup | Canonical route rule |
| --- | --- | --- |
| `r-<slug>` | Match `"r-" + row.id` in `data.json.registry`; otherwise match `"r-" + row.r` in `archive.json.items` with `k == "inc"` and record data in `rec`. The search producer uses `a.r` or `a.rec.id`. | `/incidents/r-<slug>` for an active registry entry. Keep the prefix and slug unchanged across live-to-archive transitions. |
| `c-<eid-suffix>` | Match `data.json.crypto.items[].eid`; the producer of that ID hashes the original `name + date`. | `/incidents/<eid>` if published, or follow a confirmed registry alias for the same event. Join any archive counterpart by authoritative identity, not just name. |
| `k-<eid-suffix>` | Match `data.json.kev.items[].eid`; the input to the hash is the exact `id` (CVE ID). | `/incidents/<eid>` if published. An archive `kev` row carries the CVE in `s` and the NVD URL; use the CVE as the identity bridge when building the registry. |
| `b-<eid-suffix>` | Match `data.json.breaches.items[].eid`; the input to the hash is HIBP `name`, not the display title. | `/incidents/<eid>` if published. An archive `breach` row supplies the HIBP name in its `/Breach/<Name>` source URL; use that source identity to join. |
| `n-<eid-suffix>` | Match `data.json.news[].eid`; the input to the hash is the article URL. The current inspector can pivot to a linked crypto record through `news[].crypto`. | `/incidents/<eid>` only if the news record itself has an eligible route, or return a registry-confirmed canonical alias. A UI pivot or a related article alone does not make it the same record. |
| `x-<eid-suffix>` | Match `data.json.x[].eid`; the input to the hash is the original `subject + date[:10]`. Index `kind` is `x-signal`. | `/incidents/<eid>` only if the signal has an eligible route. Preserve its status and provenance. Do not silently turn a rumour into a confirmed incident. |
| `a:<k>\|<d>\|<o>\|<t>\|<u>` | Exact match against the prebuilt archive lookup using `"a:" + k + "\|" + d + "\|" + o + "\|" + (t \|\| "") + "\|" + (u \|\| "")`. `d` is the full stored date, `o` the name, `t` the title, and `u` the source URL. Current search emits this for `crypto`, `kev`, `breach`, `notice`, and `sec`. | `/incidents/<registry-assigned-id>` if eligible. Resolve the archive key to the row, then the row to its durable ID. Reuse a verified live ID for the same record or allocate a persistent ID from source identity. Never publish `a-<array position>` or place the raw `a:...` ref in the path. |

`<eid-suffix>` is the first eight lowercase hex characters of SHA-1 over the original UTF-8 input ([`pipeline/enrich.py`](../../pipeline/enrich.py#L100-L136)). Look up IDs rather than rehashing display strings: display fields can be translated or corrected, and short hashes can collide. `c-`, `k-`, and `b-` are valid live IDs but are **not** emitted directly for those kinds by the current search generator; look for `a:` keys instead. Archive `ransom` rows are not indexed by that generator. `n-` and `x-` are from the live snapshot, with news capped at 1,500 records. A formerly live result can become stale or disappear entirely from the current snapshots.

Build the `a:` keys from stored fields and compare the complete string, including trailing separators for empty fields. Do not split the ref on `|`: the fields themselves are not escaped. The ref can change if a title or source changes. Store aliases or regenerate the search document and invalidate stale results when needed. Do not use the key as the durable ID. The baseline has no general archive ID allocator. For KEV and HIBP, registry builders can reuse the existing prefix/hash scheme with known upstream keys. For other archive-only records, persist source-qualified identity and an allocated ID rather than hashing mutable presentation fields. Check uniqueness and treat ambiguous lookups as unresolved. Treat the pipeline's `dup` hint as a candidate: it is heuristic, not by itself proof of a merge. Respect [#17](https://github.com/askgina/cyber/issues/17#issuecomment-7159809567): full **eligible** archive history, durable curated incidents, 90 days for daily/routine routes, and `410` on retirement or `301` only to a true successor.

Verified against the checked-in snapshots (`generated: 2026-11-24T19:12:13Z`), not by fetching canonical URLs. The archive snapshot had 12,833 rows with no duplicate full archive keys. The search producer grouped 4,572 eligible sections into 1,028 `(kind, day)` files. These are fixture counts, not production index or quota measurements:

- `r-huntress-ransomware-attack` matched an archive `inc` row and not the live `registry`. Its Map 3 path is `/incidents/r-huntress-ransomware-attack` when the registry publishes it.
- The first live `CVE` hit's full `a:kev|…` key matched one archive row, representing `CVE-2026-66384`. The old inspector ID for **that snapshot only** was `a-4515`. Reusing the exact KEV ID rule yields `k-79fb3997` and therefore `/incidents/k-79fb3997` **if** the registry assigns and publishes that ID. No such live row was present in the local snapshot.
- `n-a0ed97ce` matched one live news row. This verifies its identity, not that `/incidents/n-a0ed97ce` will be published.

**For agents and WebMCP:** Use the active registry to supply an absolute canonical URL and label the underlying record `live` or `archive`. Confirm that the canonical response identifies the record before citing it. Return `canonicalUrl: null` (or exclude the result from a list of citable incidents) for null refs, misses, ambiguities, stale hits, and non-standalone records. If available, expose provenance as separate source links, not as the canonical URL. HTTP agents cannot perform the complete join from the current API alone. Before advertising link-bearing search, expose the registry resolution in the HTTP response or a documented public lookup, and share that resolver with WebMCP. Do not claim that the raw `ref` alone is a citation.

## 3. Target HTTP discovery artifacts

The Ask Gina Blog [generator](https://github.com/askgina/blog/blob/9b83ddd05fd9b48294a8bcaffd0918acf952b146/scripts/generate-static-routes.mjs#L311-L409) shows the proven `rel="ard"` pattern on the home page, `llms.txt` and section indexes, a feed-only Schema Map, and digest computation after origin substitution. The same generator adds the HTML discovery link when rendering `/`. Its [middleware](https://github.com/askgina/blog/blob/9b83ddd05fd9b48294a8bcaffd0918acf952b146/functions/_middleware.ts) keeps `/.well-known/` out of Markdown negotiation and serves negotiated HTML/Markdown with `Vary: Accept, User-Agent`. It uses the GET representation for HEAD metadata, sets `x-markdown-tokens` on Markdown, and returns Markdown `404` with `X-Robots-Tag: noindex` for a missing page. Do not route JSON or discovery files through that negotiation. The blog is a static publication, so it does not supply the Cyber API catalog or OpenAPI example. The [Ora playbook](https://ora.ai/skill.md) describes the audit checks; the specifications below govern the formats.

### `/.well-known/ard.json` — `application/json`

[ARD v0.91 proposal §§4–5 and Appendix D](https://agenticresourcediscovery.org/spec/) and its [`ArdManifest` schema](https://github.com/ards-project/ard-spec/blob/main/spec/schemas/ard-entry.schema.json) require an object with an `entries` array. Each entry requires `identifier` (domain-anchored `urn:air:`), `displayName`, `type` (media type), and exactly one of `url` (absolute artifact URI) or `data` (inline object). Include two to five `representativeQueries` strings per entry for discovery. `description`, `capabilities: string[]`, and entry-level JSON-LD `@context` are optional. Blog fields `specVersion: "1.0"` and `host: {displayName, identifier, documentationUrl}` may be kept as envelope metadata; ARD does not require them. This version number is not the ARD draft version.

Publish the file at the well-known path and add `<link rel="ard" href="/.well-known/ard.json">` to the home page. The response may also advertise it with `Link: </.well-known/ard.json>; rel="ard"`. Example for the target (all links must resolve first):

```json
{
  "entries": [
    {
      "identifier": "urn:air:cyber.askgina.ai:ledger:public-api",
      "displayName": "Breach Ledger public API catalog",
      "type": "application/linkset+json",
      "url": "https://cyber.askgina.ai/.well-known/api-catalog",
      "description": "Find the public search and snapshot operations and their OpenAPI description.",
      "representativeQueries": ["How can I search the breach ledger?", "Where can I fetch the archive snapshot?"]
    },
    {
      "identifier": "urn:air:cyber.askgina.ai:ledger:read-cyber",
      "displayName": "Read Breach Ledger",
      "type": "text/markdown",
      "url": "https://cyber.askgina.ai/.well-known/agent-skills/read-cyber/SKILL.md",
      "description": "Find and cite public ledger records with provenance.",
      "representativeQueries": ["How do I cite a reported ransomware incident?", "Is this ledger record live or archived?"]
    }
  ]
}
```

Cyber search is not an ARD Registry API. Do not declare it as `application/ai-registry+json`, a remote MCP service, or an A2A agent.

### `/.well-known/api-catalog` — RFC 9727

[RFC 9727 §§2–4](https://www.rfc-editor.org/rfc/rfc9727#section-2) requires an HTTPS GET that returns an API catalog in [RFC 9264 §4.2](https://www.rfc-editor.org/rfc/rfc9264#section-4.2) JSON Linkset format. Use `Content-Type: application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"` (profile recommended by the RFC). HTTPS HEAD must return the discovery `Link` header and no body. Send `Link: </.well-known/api-catalog>; rel="api-catalog"` on GET and HEAD, and advertise the same link on the home page. The document must have a `linkset` array of context objects. Use absolute `anchor` and `href` values. Each relation name maps to an array of target objects with `href` and optional metadata such as `type`. Include actual API endpoint links and link to the machine-readable OpenAPI description with `service-desc`. A human-oriented `service-doc` is optional.

```json
{
  "linkset": [
    {
      "anchor": "https://cyber.askgina.ai/.well-known/api-catalog",
      "item": [
        { "href": "https://cyber.askgina.ai/api/search" },
        { "href": "https://cyber.askgina.ai/data.json" },
        { "href": "https://cyber.askgina.ai/archive.json" }
      ],
      "service-desc": [{ "href": "https://cyber.askgina.ai/openapi.json", "type": "application/json" }]
    },
    {
      "anchor": "https://cyber.askgina.ai/api/search",
      "service-desc": [{ "href": "https://cyber.askgina.ai/openapi.json", "type": "application/json" }],
      "service-doc": [{ "href": "https://cyber.askgina.ai/llms.txt", "type": "text/plain" }]
    },
    {
      "anchor": "https://cyber.askgina.ai/data.json",
      "service-desc": [{ "href": "https://cyber.askgina.ai/openapi.json", "type": "application/json" }]
    },
    {
      "anchor": "https://cyber.askgina.ai/archive.json",
      "service-desc": [{ "href": "https://cyber.askgina.ai/openapi.json", "type": "application/json" }]
    }
  ]
}
```

### `/openapi.json` — OpenAPI 3.1 JSON

Use [OAS 3.1.2](https://spec.openapis.org/oas/v3.1.2.html) and serve `application/json`. The root is an object with `openapi: "3.1.2"`, `info: {title, version, description}`, `servers: [{url: "https://cyber.askgina.ai"}]`, `paths`, and schema definitions under `components.schemas`. Use `security: []` for anonymous operations. Use `externalDocs: {url: "https://cyber.askgina.ai/llms.txt"}` and a response `Link` back to the API catalog. Give each GET a distinct `operationId`, description, and status-keyed `responses` with a `description`, typed `content`, and documented headers. Model dependencies and caching as observed until the new policy ships, then update the document with the same release. Do not expose build or analytics endpoints.

| Path and suggested `operationId` | Parameters and response content |
| --- | --- |
| `/api/search` · `searchIncidentsByMeaning` | `parameters: [{name: "q", in: "query", required: false, schema: {type: "string"}, description: "…"}]` for current behavior. Explain trim, whitespace collapse, truncation, and short-query `200`; do not use schema bounds to imply server-side rejections. Model `200`, `429`, and `502` with JSON schemas below. On rollout of #25, declare the `Retry-After` response header on `429` (e.g. `schema: {type: "integer", minimum: 1}` for delta-seconds if that is the format implemented) and document client `Cache-Control: no-store`. If the handler enforces GET-only, document `405` and `Allow` as method behavior, not a callable POST operation. Do not specify a fixed `CF-Cache-Status`. |
| `/data.json` · `getLiveSnapshot` | `200` with typed JSON snapshot, UTC `generated` (`date-time`) and `errors: string[]` for partial upstream failures. The [builder](../../pipeline/build_data.py#L540-L558) defines `kev`, `ransomware`, `crypto`, `breaches`, `windows`, `details` as objects; `news`, `registry`, `notices`, `x`, `hourly`, `clusters`, `patterns`, `pattern_defs` as arrays; `news_headlines_7d` and `triage_n` as integers; `brief` as object or null. Type nested record arrays and source link fields from the builder and fixtures (retain `registry[].id` and `*.eid` where emitted). The curated live list keeps records updated in the last 45 days. Do not treat that window as an archive cutoff or assume every source is current at `generated`. |
| `/archive.json` · `getArchiveSnapshot` | `200` with JSON object requiring `generated` (`date-time`), `from` (`date`, currently `2026-01-01`), `counts` (kind → integer), `monthly` (kind → 12-element integer array in the current producer), and `items` (archive row array). Per the [archive builder](../../pipeline/archive.py#L242-L263), row fields `d`, `k`, `o`, `t` are strings. `k` takes `inc`, `crypto`, `ransom`, `kev`, `breach`, `notice`, `sec`. Optional strings `s`, `u`, `x` carry scale/label, source URL, and context. Curated `inc` adds `r` (registry slug) and `rec` (compact record with optional omitted fields). Crypto may have `dup` (candidate `r-…` ID). No server-issued `a-<position>` field. Preserve scope and source gaps in the description. |

The [snapshot routes](../../worker/index.js#L194-L199) set `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-cache`, and an R2 `ETag` on success. OAS `content` can use `application/json`. Both return `503` with plain-text `Not built yet` if the R2 object is missing. Do not promise conditional `304` merely because the Worker sends an ETag. These routes were checked in source, not probed. Document desired freshness as an hourly build cadence, not a hard SLA or a guarantee of atomic publication.

Exact schema components for the current search envelopes (values in `SearchError.error` can also be constrained per status using `const`):

```json
{
  "SearchResponse": {
    "type": "object", "required": ["results"], "additionalProperties": false,
    "properties": {
      "results": {"type": "array", "maxItems": 8, "items": {"$ref": "#/components/schemas/SearchResult"}}
    }
  },
  "SearchResult": {
    "type": "object", "required": ["title", "ref", "kind", "score", "snippet"], "additionalProperties": false,
    "properties": {
      "title": {"type": "string"},
      "ref": {"type": ["string", "null"]},
      "kind": {"type": "string"},
      "date": {"type": "string", "description": "Index key day, normally YYYY-MM-DD."},
      "score": {"type": "number"},
      "snippet": {"type": "string", "maxLength": 160}
    }
  },
  "SearchError": {
    "type": "object", "required": ["results", "error"], "additionalProperties": false,
    "properties": {
      "results": {"type": "array", "maxItems": 0},
      "error": {"type": "string", "enum": ["too many searches, try again in a minute", "search unavailable"]}
    }
  }
}
```

### `/.well-known/agent-skills/index.json` — `application/json`

The [Agent Skills Discovery draft v0.2.0](https://github.com/cloudflare/agent-skills-discovery-rfc#discovery-index) requires the `$schema` URI and `skills` array. Each entry requires `name`, `type`, `description`, `url`, and `digest`. Use `type: "skill-md"` for a single Markdown file (the other draft type is `archive`). The root-relative `url` resolves against the index URL. Match the frontmatter name and description. The blog generator has the single-artifact shape and a correct byte hashing pattern, but omits `$schema`. Do not copy that omission: the draft treats an index without it as v0.1.0.

Example index for the exact Markdown sample below (UTF-8 with LF, including its final newline):

```json
{
  "$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
  "skills": [
    {
      "name": "read-cyber",
      "type": "skill-md",
      "description": "Find and cite public Breach Ledger records. Use to verify reported cyber incidents, disclosures, and archive entries.",
      "url": "/.well-known/agent-skills/read-cyber/SKILL.md",
      "digest": "sha256:8b9ba48a52ddf8256f9ecd7f54920d65980fe56a5efcaa7790b399496d404d45"
    }
  ]
}
```

Generate `"sha256:" + createHash("sha256").update(finalArtifactBytes).digest("hex")` from the final served file. The suffix is exactly 64 lowercase hex digits. Apply origin templating and newline changes **before** hashing. Validate against the downloaded artifact bytes after HTTP transfer decoding, not a Markdown parser's output or the output of a second template pass. Publish the index and artifact together; reject a mismatch. The sample hash is not a digest of a live Cyber asset.

### `/.well-known/agent-skills/read-cyber/SKILL.md` — `text/markdown; charset=utf-8`

Per the [Agent Skills specification](https://agentskills.io/specification), start with `---` YAML frontmatter containing `name` and nonempty `description`, then Markdown instructions. The name is 1–64 lowercase ASCII letters, digits or hyphens, with no leading, trailing, or consecutive hyphens. It must match the directory name. The description is at most 1,024 characters and describes when to use the skill. Use the [blog skill](https://github.com/askgina/blog/blob/9b83ddd05fd9b48294a8bcaffd0918acf952b146/public/.well-known/agent-skills/read-ask-gina-blog/SKILL.md) as the model: a short read-and-cite workflow with limits and no scripts. Example target bytes (exclude the fences):

```markdown
---
name: read-cyber
description: Find and cite public Breach Ledger records. Use to verify reported cyber incidents, disclosures, and archive entries.
---

# Read Breach Ledger

1. Read the [ledger index](https://cyber.askgina.ai/llms.txt) or use `GET /api/search?q=<query>` as described in [OpenAPI](https://cyber.askgina.ai/openapi.json). Send only public search terms.
2. Treat results as leads. Verify the record at its canonical incident URL and check the named sources. Do not turn an opaque search ref into a URL.
3. Use the [live snapshot](https://cyber.askgina.ai/data.json) for current coverage and the [archive snapshot](https://cyber.askgina.ai/archive.json) for historical coverage. Check `generated`. State which snapshot supports your answer.
4. Cite the canonical HTML URL if one exists. Use its Markdown alternate for reading. Keep claims, confirmed facts, and dates distinct. Say when you cannot verify a match.
5. On `429`, honor `Retry-After` when present. If search is unavailable, use the published indexes or say that search could not be verified.
```

### Related entry points

Follow the blog's `llms.txt` structure: a title, a blockquoted summary, a short “When to use this site” section, and linked Markdown section indexes. Link to the API catalog, OpenAPI, and skill. Keep `/llms-full.txt` optional and separate from the concise index. The blog's `schemamap.xml` uses `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:sf="http://schema.org/schemas/schemafeed/0.1">` with `<url><loc>…</loc><sf:contentType>structuredData/rss</sf:contentType></url>` for its RSS feed. Advertise the map with `schemamap: https://cyber.askgina.ai/schemamap.xml` in `robots.txt` when it exists. Use the schema map for actual structured feeds ([#21](https://github.com/askgina/cyber/issues/21)), not as an alternate API catalog. Keep HTML, Markdown, JSON, and XML response media types distinct.

## 4. Target Browser WebMCP

The [WebMCP Community Group draft](https://webmachinelearning.github.io/webmcp/#model-context-container) puts the secure-context API on `document.modelContext`. [Chrome's imperative documentation](https://developer.chrome.com/docs/ai/webmcp/imperative-api) uses that entry point. The [older proposal](https://webmachinelearning.github.io/webmcp/docs/proposal.html) used `navigator.modelContext`; keep that only as a trailing compatibility fallback. Do not infer broad browser support from either document. This is in-page registration, not a hosted MCP server or a well-known HTTP endpoint.

The [blog WebMCP implementation](https://github.com/askgina/blog/blob/9b83ddd05fd9b48294a8bcaffd0918acf952b146/src/lib/blog-webmcp.ts) registers three tools with typed input, read-only annotations, structured returns, and an `AbortController` for cleanup. For Cyber, check that `registerTool` is callable on `document.modelContext`, then try `navigator.modelContext` if necessary. Preserve the method receiver, register once per lifecycle, and catch synchronous throws and asynchronous rejections. If neither is available, do nothing and leave the site usable. Do not register the same tool twice on both surfaces.

| Tool field or call | Required shape / Cyber use |
| --- | --- |
| `name` | Required string. Unique in the relevant context, 1–128 ASCII letters, digits, `_`, `-`, or `.`. Use verb-led `snake_case`. |
| `description` | Required string. Describe when to use the tool and what it returns. `title` is an optional UI label. |
| `inputSchema` | JSON Schema object. Optional in draft IDL but supply it for each tool. Use `type: "object"`, typed `properties` with descriptions, `required` for mandatory fields, and `additionalProperties: false`. Validate again in `execute`. |
| `execute(input, {signal})` | Required callback returning a promise with a JSON-serializable result. Forward the execution abort signal to `fetch`. Return a plain result object, not a remote MCP JSON-RPC envelope. |
| `annotations` | For read tools: `{readOnlyHint: true, untrustedContentHint: true, consequentialHint: false}`. Treat third-party text as data, not instructions. |
| `outputSchema` | Optional JSON Schema object in the current draft. Chrome documents it from version 159. Where used, make it self-contained and match the actual result object. Do not rely on the browser to validate or enforce output on older versions. |
| `registerTool(tool, {signal})` | Draft returns `Promise<undefined>`; older compatibility code may encounter a synchronous method. The optional registration signal controls unregistering. Use a separate signal for cancelling each execution. |

Proposed search input schema:

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "minLength": 3,
      "maxLength": 300,
      "description": "Public keywords or a natural-language query about a ledger incident."
    }
  },
  "required": ["query"],
  "additionalProperties": false
}
```

Implement `search_incidents_by_meaning` with same-origin `GET /api/search?q=…`. Check length again after normalization. Resolve results through the same route registry used by the HTTP surface. Suggested output is either `{ok: true, results: Hit[]}` (at most eight) or `{ok: false, code: string, message: string, retryAfterSeconds?: integer}`. A `Hit` carries the API search fields and `{id: string|null, canonicalUrl: string|null, scope: "live"|"archive"|null, sources: [{label: string, url: string}]}`. Surface rate limits, upstream failures, and invalid input as explicit errors instead of empty search results. Parse `Retry-After` when present, and do not retry automatically within the tool. Offer bounded `list_incidents`, `read_incident`, `list_patterns`, and `read_pattern` tools with stable input IDs, capped list sizes, source links, and effective snapshot scope. Do not build a pattern URL until the route registry supplies it.

**Declarative alternative.** [Chrome's form API](https://developer.chrome.com/docs/ai/webmcp/declarative-api) recognizes `<form toolname="…" tooldescription="…">`. Named controls supply input properties, `required` marks required controls, and `toolparamdescription` gives an explicit property description (otherwise the browser can use the label or `aria-description`). The default flow lets the user submit the filled form. The boolean attribute `toolautosubmit` enables automatic submission. For a client-handled submission, use `SubmitEvent.agentInvoked`, call `preventDefault()`, and use `respondWith(Promise)` to return structured results. Chrome documents `toolactivated` and `toolcancel` on `document.modelContext` and CSS focus states `:tool-form-active` and `:tool-submit-active`. These form APIs are Chrome-specific experimental guidance, not the portable imperative registration contract. Ora's WebMCP check looks for imperative registration, not declarative forms alone. Do not add a second hidden or autosubmitting search form just for discovery.

## 5. Release checks

1. Before enabling discovery, validate ARD entries and every advertised media type and link. Check catalog GET/HEAD, OpenAPI operation schemas against actual payloads, and the published skill digest against downloaded bytes. A `200` that returns the app shell does not pass.
2. Verify the separate budgets, `Retry-After`, client `no-store`, GET/HEAD policy, and error mapping on staging. Use staging or authorized telemetry to measure cache ratio, shared-egress impact, index lag, and quota headroom rather than replaying load against production.
3. Test registry joins with a live and archived curated incident, an archive-only row, a source correction, duplicate keys, and null/stale refs. Follow every non-null URL in the test set and check content and canonical identity. Verify real `404`, retirement `410`, and any confirmed successor redirect.
4. In a WebMCP-capable browser, verify registration, typed calls, abort behavior, and errors. In an unsupported browser, verify zero registration errors and a working command palette. Run a fresh Ora scan only after the target is deployed. Neither standards review nor the six-request search sample is proof of an Ora score.
