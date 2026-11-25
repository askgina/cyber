# Ora / Is Agentic baseline

Baseline for [GitHub issue #3](https://github.com/t-y-b-b/breach-ledger/issues/3).

- **Target and final URL:** `https://cyber.askgina.ai/`. Ora reported the input as `https://cyber.askgina.ai`.
- **Scan timestamp (UTC):** `2026-11-25T10:36:16.103Z` (`scannedAt` from Ora).
- **Ora overall:** **D (37/100)**. **Is Agentic Essentials:** **70** — “Ready with a few material gaps”.
- **Scan ID:** `642941`. **Duration:** 2724 ms. **Scoring:** [version 3](https://ora.ai/api/ranker/releases/3/rules), revision 22.
- **Completion and freshness:** Ora returned `analysisStatus: "complete"` and `pendingChecks: []`. The request forced a fresh scan, and `scannedAt` matched the run. Ora did not return `servedFromCache` or `resultAgeSeconds`.

Reproduce with the Ora endpoint documented in `askgina-is-agentic-rescore-and-verify` and the fresh parameters from `askgina-ora-check-fix-recipes`:

```sh
curl -sS -m 240 -X POST 'https://ora.ai/api/scan?include=essentials&fresh=1' \
  -H 'content-type: application/json' \
  --data '{"url":"https://cyber.askgina.ai/","force":true,"fresh":true}'
```

## Scores and check counts

| Ora layer | Layer ID | Points | Pass | Fail | Warning | N/A | Total |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Discovery | `discovery` | 8 / 12 | 4 | 4 | 0 | 6 | 14 |
| Access | `accessibility` | 11.5 / 34 | 7 | 24 | 1 | 8 | 40 |
| Usability | `usability` | 10.33 / 41 | 5 | 17 | 3 | 54 | 79 |
| Payments | `payments` | 0 / 0 | 0 | 0 | 0 | 5 | 5 |
| **All checks** | — | — | **16** | **45** | **4** | **73** | **138** |

The table shows the layer scores as Ora returned them. The overall Ora score is a separate field, not a sum of the layer scores shown here. The check tables list every `pass`, `fail`, and `warning`. The `na` checks are counted above but are not passes or failures.

### Essentials breakdown

| Component | Points | Passing / total |
| --- | ---: | ---: |
| Required | 60 / 80 | 4 / 6 |
| Recommended | 8.9 / 20 | 4 / 12 |
| Bonus | +1.5 | 6 bonus signals |

Ora reported 18 eligible Essentials checks. It returned these surface scores separately:

| Surface | Surface ID | Score | Passing / total |
| --- | --- | ---: | ---: |
| Public website | `web` | 53 | 8 / 17 |
| MCP | `mcp` | 83 | 0 / 1 |

| Essentials access signal | Signal ID | State | Passing / total |
| --- | --- | --- | ---: |
| Agents can reach the site | `reachability` | `clear` | 2 / 2 |
| Core content is available | `content` | `clear` | 1 / 1 |
| Navigation fails safely | `navigation` | `mixed` | 1 / 2 |
| Controls are understandable | `controls` | `clear` | 4 / 4 |

## How to read the results

- The tables use `layers[].checks[]` for status, points (`score / maxScore`), Ora tier, and the exact `details` text. The Essentials tier comes from `essentials.checks`. “Bonus” marks the `bonus` flag in the corresponding score system. A dash means Ora returned no Essentials entry for the check.
- The two crawler-policy checks passed because a missing `robots.txt` defaults to allowed in Ora's sample. They do not show that Cyber published a crawler policy. The `content-no-js` pass covers the homepage only. Ora found no inner pages to sample.
- The search and directory results reference Ask Gina docs, MCP, or its ChatGPT app. They do not establish Cyber-specific integrations. Ora did not discover a responding API in its scan, but the [repository Worker](../../worker/index.js) defines `/api/search`. The `public-api` result is a discovery finding, not a claim that this route does not exist.
- Map placement identifies the primary area to investigate. It does not establish a root cause or require every optional integration Ora checks.

## Passing checks

| Check ID | Ora layer | Status | Ora points | Ora tier | Essentials tier | Ora details |
| --- | --- | --- | ---: | --- | --- | --- |
| `agentic-search-specific` | `discovery` | `pass` | 4 / 4 | recommended | recommended | In a search for your API docs, your docs came up at #1 (https://askgina.ai/docs). In a search for your MCP server, SDK or CLI, we found your MCP server at #4 (https://docs.askgina.ai/predictions-mcp/introduction) |
| `robots-ai-policy-quality` | `discovery` | `pass` | 1 / 1 | required | — | AI search crawlers: allowed in 3 of 3 checks (3 crawlers on 1 page). AI training crawlers: allowed in 2 of 2 checks (2 crawlers on 1 page), not scored. No robots.txt (HTTP 404); crawl permission defaults to allowed. No applicable crawl or usage restriction found for 3 search crawlers (oai-searchbot, claude-searchbot, perplexitybot) on 1 public page: https://cyber.askgina.ai/. Declared policy only; absence of a Content Signal expresses no usage preference. Paths outside this sample, live bot access, indexing, and model training are not verified |
| `chatgpt-app-listed` | `discovery` | `pass` | 2 / 2 | recommended (bonus) | recommended (bonus) | Found in ChatGPT app directory: "Ask Gina" |
| `noindex-directives` | `discovery` | `pass` | 1 / 1 | recommended | recommended | No noindex on the homepage: no robots, googlebot or bingbot meta tag and no X-Robots-Tag header hides it from search. |
| `content-no-js` | `accessibility` | `pass` | 5 / 5 | required | required | Homepage: 5536 chars, semantic headings (1 H1 + 10 H2s + 12 H3s), 30.8% content ratio. No inner pages checked: the scan found none to sample. |
| `bot-detection` | `accessibility` | `pass` | 2 / 2 | required | required | Site accessible to 4 agent user-agents (ChatGPT-User, OAI-SearchBot, Claude-User, PerplexityBot). |
| `robots-agent-user-policy` | `accessibility` | `pass` | 1 / 1 | required | — | No robots.txt (HTTP 404); crawl permission defaults to allowed. No applicable crawl or usage restriction found for 3 user-triggered agents (chatgpt-user, claude-user, perplexity-user) on 1 public page: https://cyber.askgina.ai/. Declared policy only; absence of a Content Signal expresses no usage preference. Paths outside this sample, live bot access, indexing, and model training are not verified |
| `redirect-hygiene` | `accessibility` | `pass` | 1 / 1 | recommended | required | No meta-refresh or JavaScript-redirect stubs across 5 checked pages |
| `page-token-budget` | `accessibility` | `pass` | 1 / 1 | recommended | recommended | All 1 measured page fit an agent context budget (largest ~2K tokens) |
| `content-start-position` | `accessibility` | `pass` | 1 / 1 | emerging | recommended | Main content starts within the first 5,000 characters of text on all 1 measured page (latest after 665 characters) |
| `agent-crawler-reachability` | `accessibility` | `pass` | 1 / 1 | recommended | required | Reachable to every agent we tested - ChatGPT-User: reachable, OAI-SearchBot: reachable, Claude-User: reachable, PerplexityBot: reachable |
| `ax-document-structure` | `usability` | `pass` | 3 / 3 | emerging (bonus) | required (bonus) | Server HTML is a well-structured document (main=true, landmarks=3/4, h1=1, maxHeadingSkip=1). |
| `ax-native-controls` | `usability` | `pass` | 3 / 3 | emerging (bonus) | required (bonus) | 76 native controls, 0 non-native div-soup affordances (100% native). |
| `ax-accessible-names` | `usability` | `pass` | 2 / 2 | emerging (bonus) | required (bonus) | 75/76 interactive elements have a computable accessible name (99%). |
| `ax-form-labeling` | `usability` | `pass` | 2 / 2 | emerging (bonus) | required (bonus) | 4/4 form controls have an associated label (100%). |
| `ax-tree-injection-safe` | `usability` | `pass` | 2 / 2 | emerging (bonus) | recommended (bonus) | No hidden instruction text detected in accessibility-tree attributes or off-screen content. |

## Failing checks and warnings by map

Warnings received partial credit and do not count as failures.

| Map | Fail | Warning |
| --- | ---: | ---: |
| [Map 2: Static Foundations, Metadata, Security, Performance & Accessibility](https://github.com/t-y-b-b/breach-ledger/issues/8) | 6 | 1 |
| [Map 3: Crawlable Architecture, Hourly Prerendering, Feeds & Route Analytics](https://github.com/t-y-b-b/breach-ledger/issues/15) | 2 | 0 |
| [Map 4: Agent Readiness, Markdown Negotiation & API/WebMCP Discovery](https://github.com/t-y-b-b/breach-ledger/issues/23) | 37 | 3 |
| **Total** | **45** | **4** |

### Map 2: Static Foundations, Metadata, Security, Performance & Accessibility

This group covers site identity, structured data, trust pages, and HTTP `Link` headers. The brand-search result is a search snapshot, not proof of a metadata defect.

| Check ID | Ora layer | Status | Ora points | Ora tier | Essentials tier | Ora details |
| --- | --- | --- | ---: | --- | --- | --- |
| `brand-search-accuracy` | `discovery` | `fail` | 0 / 3 | required | recommended | cyber.askgina.ai was not in the top 10 for "Cyber" (searched your brand name alone: no main product term from your homepage qualified) |
| `link-headers-discovery` | `accessibility` | `fail` | 0 / 1 | emerging (bonus) | recommended (bonus) | No HTTP Link response headers (RFC 8288) found |
| `json-ld` | `accessibility` | `fail` | 0 / 2 | required | recommended | No JSON-LD structured data found on homepage |
| `json-ld-entity-linking` | `accessibility` | `fail` | 0 / 1 | recommended | recommended (bonus) | No JSON-LD found  - no entity linking possible |
| `org-schema-completeness` | `accessibility` | `fail` | 0 / 1 | recommended | recommended | No JSON-LD found - Organization schema missing |
| `trust-anchors` | `accessibility` | `fail` | 0 / 1 | required | recommended | No trust anchor pages found with sufficient content (About, Contact, Privacy) |
| `metadata-completeness` | `accessibility` | `warning` | 0.5 / 1 | required | recommended | Only 1/4 metadata signals present - missing: canonical URL, og:image, og:type |

### Map 3: Crawlable Architecture, Hourly Prerendering, Feeds & Route Analytics

This group covers crawlable maps and feeds. Ora could not check for NLWeb schema feeds without `robots.txt` (Map 2). The feed work belongs to Map 3.

| Check ID | Ora layer | Status | Ora points | Ora tier | Essentials tier | Ora details |
| --- | --- | --- | ---: | --- | --- | --- |
| `sitemap` | `accessibility` | `fail` | 0 / 1 | required | recommended | No sitemap found |
| `nlweb-schema-feeds` | `accessibility` | `fail` | 0 / 1 | emerging | emerging (bonus) | No robots.txt found - cannot check for Schema Feeds |

### Map 4: Agent Readiness, Markdown Negotiation & API/WebMCP Discovery

This group covers agent discovery, Markdown, and API and tool surfaces. The `agent-friendly-404` warning belongs here because HTTP 404 already works and the missing part is the negotiated Markdown body. Map 2 also tracks the static 404 documents.

| Check ID | Ora layer | Status | Ora points | Ora tier | Essentials tier | Ora details |
| --- | --- | --- | ---: | --- | --- | --- |
| `ard-catalog` | `discovery` | `fail` | 0 / 1 | required | emerging (bonus) | No /.well-known/ard.json, no same-site rel="ard" link, and no legacy /.well-known/ai-catalog.json |
| `agent-rules-repo` | `discovery` | `fail` | 0 / 1 | emerging | emerging (bonus) | Could not locate a public repo containing agent configs or rules. If our probes missed it, AI coding agents likely will too - link the repo from your homepage or docs so it's discoverable. |
| `agent-plugins-repo` | `discovery` | `fail` | 0 / 1 | emerging (bonus) | emerging (bonus) | No Agent Plugins manifest (plugin.json) found in discovered repos |
| `agent-discovery-file` | `accessibility` | `fail` | 0 / 2 | emerging | emerging (bonus) | No agent discovery file found |
| `a2a-agent-card` | `accessibility` | `fail` | 0 / 2 | emerging (bonus) | recommended (bonus) | No A2A agent card found at /.well-known/agent-card.json |
| `skills-sh-listed` | `accessibility` | `fail` | 0 / 1 | emerging | emerging (bonus) | No official skills self-published on skills.sh (100 community skills with potential relation to this domain found, but only self-published official skills count) |
| `mcp-well-known-discovery` | `accessibility` | `fail` | 0 / 2 | emerging (bonus) | emerging (bonus) | No MCP server URL discovered |
| `markdown-url-fallback` | `accessibility` | `fail` | 0 / 2 | emerging (bonus) | emerging (bonus) | Homepage does not support the .md suffix. Probed https://cyber.askgina.ai/index.md and it did not return markdown (expected a text/markdown content-type or a non-HTML body with markdown structure). Serve /index.md so agents can fetch one canonical markdown URL for the site root. |
| `modular-llms-txt` | `accessibility` | `fail` | 0 / 1 | emerging (bonus) | emerging (bonus) | No section-level llms.txt found. Tried /docs/llms.txt, /api/llms.txt, /developers/llms.txt, /guides/llms.txt, /reference/llms.txt. This is a bonus check: it can add a point and never costs one. |
| `llms-txt-exists` | `accessibility` | `fail` | 0 / 1 | required | emerging (bonus) | No llms.txt found at https://cyber.askgina.ai/llms.txt. Publish it at the site root, where agents that follow the llms.txt spec look for it. |
| `llms-txt-formatting` | `accessibility` | `fail` | 0 / 2 | recommended | emerging (bonus) | No llms.txt found to evaluate quality |
| `public-api-docs` | `accessibility` | `fail` | 0 / 4 | required | — | No public API or documentation page linked from homepage |
| `agent-instruction` | `accessibility` | `fail` | 0 / 1 | required | recommended | No agent instruction file with when-to-use guidance found |
| `skills-sh-quality` | `accessibility` | `fail` | 0 / 2 | emerging | emerging (bonus) | No official skills on skills.sh to evaluate |
| `markdown-link-alternate` | `accessibility` | `fail` | 0 / 1 | emerging (bonus) | emerging (bonus) | No sampled page advertises a markdown alternate. Add &lt;link rel="alternate" type="text/markdown" href="..."&gt; (or the equivalent Link response header) pointing at a markdown twin of the page. |
| `openapi-spec` | `accessibility` | `fail` | 0 / 8 | required | — | No OpenAPI/Swagger specification found |
| `api-catalog-rfc9727` | `accessibility` | `fail` | 0 / 2 | emerging (bonus) | recommended (bonus) | No /.well-known/api-catalog found (RFC 9727) |
| `markdown-negotiation` | `accessibility` | `fail` | 0 / 1 | emerging | emerging (bonus) | Missing markdown content negotiation. Homepage returned text/html when probed with Accept: text/markdown (expected text/markdown), and none of the well-known root paths (/llms.md, /auth.md, /agents.md, /developers.md, /api.md, /index.md, /skill.md, /agent.md, /developer.md) returned markdown. Cold-arrival agents that land on the homepage from web search cannot get a markdown representation - serve text/markdown on the homepage via Accept negotiation, or publish a static /llms.md at the root. |
| `markdown-negotiation-vary` | `accessibility` | `fail` | 0 / 1 | recommended (bonus) | required | Homepage https://cyber.askgina.ai does not meet the Markdown negotiation requirements: Accept: text/markdown returned text/html; Vary header missing Accept (got "none") |
| `agent-ua-markdown` | `accessibility` | `fail` | 0 / 1 | emerging (bonus) | emerging (bonus) | No probed bot User-Agent (ChatGPT-User, Claude-User, Perplexity-User) receives markdown when requesting HTML. Optional: detect AI-bot UAs server-side and serve them a markdown representation directly. |
| `public-api` | `usability` | `fail` | 0 / 8 | required | — | No API endpoint that responds was found (REST, GraphQL or NLWeb /ask) |
| `web-bot-auth-directory` | `usability` | `fail` | 0 / 2 | emerging (bonus) | emerging (bonus) | No /.well-known/http-message-signatures-directory found |
| `auth-md-exists` | `usability` | `fail` | 0 / 2 | emerging (bonus) | emerging (bonus) | No /auth.md found at site root |
| `auth-md-structure` | `usability` | `fail` | 0 / 2 | emerging (bonus) | emerging (bonus) | No /auth.md found at site root |
| `agent-auth-discovery-metadata` | `usability` | `fail` | 0 / 3 | emerging (bonus) | emerging (bonus) | Neither /.well-known/oauth-protected-resource nor /.well-known/oauth-authorization-server found. Probed: cyber.askgina.ai, api.cyber.askgina.ai. |
| `agent-auth-www-authenticate` | `usability` | `fail` | 0 / 1 | emerging (bonus) | recommended (bonus) | No 401 with WWW-Authenticate: Bearer resource_metadata=... found. Probed [https://api.cyber.askgina.ai/]. |
| `agent-auth-endpoints-reachable` | `usability` | `fail` | 0 / 2 | emerging (bonus) | emerging (bonus) | No agent_auth endpoint URIs found in AS metadata or /auth.md prose; nothing to probe |
| `webmcp` | `usability` | `fail` | 0 / 8 | required | emerging (bonus) | No WebMCP support detected - no document.modelContext / navigator.modelContext usage found (scanned 5 of 5 same-origin script bundle(s) for modelContext registrations) |
| `json-error-responses` | `usability` | `fail` | 0 / 3 | required | — | API does not return JSON error responses (or no API detected) |
| `nlweb-ask` | `usability` | `fail` | 0 / 1 | emerging | emerging (bonus) | No NLWeb-conformant /ask endpoint found via GET or POST |
| `nlweb-streaming` | `usability` | `fail` | 0 / 1 | emerging | emerging (bonus) | NLWeb /ask does not support SSE streaming via GET or POST |
| `mcp-server-card` | `usability` | `fail` | 0 / 2 | emerging (bonus) | emerging (bonus) | No MCP server card found (checked /.well-known/mcp/server-card.json, the site's ai-catalog.json, servers[].card in mcp.json, and &lt;server&gt;/server-card) |
| `mcp-multi-surface-coverage` | `usability` | `fail` | 0 / 2 | recommended (bonus) | emerging (bonus) | This bonus needs two MCP servers: one for your product so agents can take actions, and a separate one for your documentation so agents can answer questions from your docs. |
| `mcp-app-registry` | `usability` | `fail` | 0 / 4 | recommended | emerging (bonus) | No MCP Apps support detected - this product has an in-agent UI surface but exposes no ui:// resources or tool UI metadata for agents to render. |
| `a2ui-support` | `usability` | `fail` | 0 / 2 | emerging | emerging (bonus) | No A2UI or generative UI support detected |
| `api-schema-analysis` | `usability` | `fail` | 0 / 2 | recommended | — | No API schema detected |
| `function-calling-compat` | `usability` | `fail` | 0 / 2 | recommended | — | No API spec found - function calling requires discoverable endpoints |
| `onboarding-friction` | `usability` | `warning` | 1 / 2 | recommended | — | Onboarding signals described but not verified live: self-serve key generation |
| `mcp-server` | `usability` | `warning` | 8.33 / 10 | required | recommended | First-party MCP server published by product org (the official MCP Registry, ai.askgina/gina). Add live handshake at /.well-known/mcp for full credit. |
| `agent-friendly-404` | `usability` | `warning` | 1 / 2 | recommended | required | The nonexistent path https://cyber.askgina.ai/__ora-404-probe-d8dcdpwd correctly returns HTTP 404. Partial credit: no Markdown error body was detected. |
