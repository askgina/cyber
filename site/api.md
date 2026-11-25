---
title: "Public API"
description: "Read and search Cyber's public snapshots: read-only JSON endpoints, search by meaning, conditional requests, rate limits, JSON errors and a versioning policy."
canonical: "https://cyber.askgina.ai/api"
lastmod: "2026-11-25"
kind: "view"
index: true
---

# Public API

[HTML version](<https://cyber.askgina.ai/api>)

Read and search Cyber's public snapshots: read-only JSON endpoints, search by meaning, conditional requests, rate limits, JSON errors and a versioning policy.

## Endpoints

Every public endpoint is a read-only GET. There is no key, no sign-up and no write API.

| Path | Returns |
| --- | --- |
| [/api/search?q=](<https://cyber.askgina.ai/api/search>) | Ranked search results over indexed records, at most eight |
| [/data.json](<https://cyber.askgina.ai/data.json>) | Live snapshot: recent records, counts, brief and details |
| [/data-hot.json](<https://cyber.askgina.ai/data-hot.json>) | Compact snapshot for the dashboard; falls back to the live snapshot |
| [/data-details.json](<https://cyber.askgina.ai/data-details.json>) | Expanded details for compact-snapshot records |
| [/data-history.json](<https://cyber.askgina.ai/data-history.json>) | History series for compact-snapshot records |
| [/archive.json](<https://cyber.askgina.ai/archive.json>) | Yearly archive with counts by kind |
| [/openapi.json](<https://cyber.askgina.ai/openapi.json>) | OpenAPI 3.1 description of these endpoints |
| [/.well-known/api-catalog](<https://cyber.askgina.ai/.well-known/api-catalog>) | RFC 9727 linkset pointing at the API and its description |

## Search

GET /api/search?q=terms searches indexed records by meaning. The query is trimmed, whitespace-collapsed and cut to 300 characters; a query shorter than three characters returns an empty list.

A result carries a title, date, kind, score, a short snippet and, when the record has a public page, a canonical url with scope live or archive. A ref is an internal handle, not a citation: open the record at its published URL before repeating a claim.

Search caches results for five minutes per normalized query.

## Rate limits

Search allows 60 requests per minute per client address, of which at most 10 may be uncached. Every search response carries RateLimit-Limit, RateLimit-Reset and RateLimit-Policy; a refused request answers 429 with Retry-After: 60.

Snapshots are static objects and are not rate-limited. Prefer conditional requests and the compact snapshot: /data.json is several megabytes.

## Errors

Errors are JSON. A search error keeps the results key so one shape parses: \{"results":\[\],"error":"rate limited"\}. A snapshot error is \{"error":"…"\}.

| Status | Meaning |
| --- | --- |
| 404 | No such API path, or a snapshot part that has not been built |
| 405 | A method other than GET, or HEAD for snapshots; Allow names the accepted methods |
| 429 | Rate limited; Retry-After gives the wait in seconds |
| 502 | The search backend is unavailable; this is not an empty result |
| 503 | Storage is unavailable or the build has not produced this part; retry after Retry-After |

## Conditional requests

Snapshots return an ETag with Cache-Control: no-cache. Send If-None-Match to revalidate; a matching strong or weak tag returns 304 with no body. Search responses are no-store.

## Versioning

The public API changes additively: fields may be added, while existing paths and field meanings stay stable, and /openapi.json records the current info.version. A breaking change would ship under a new path, so /api/search keeps its meaning. Retired record pages answer 301 or 410 instead of disappearing.

## Pagination

Search returns at most eight results in one response. Snapshots are complete documents, not pages: the archive lists items newest first from a start date and offers no cursor. Read a snapshot in full and filter locally instead of walking pages.

## Citing and reuse

Each record links to the sources it came from; cite the record page and the original source. The compiled data is published under CC BY 4.0 with Ask Gina as the publisher.

## Agent entry points

- [OpenAPI description](<https://cyber.askgina.ai/openapi.json>)
- [API catalog linkset](<https://cyber.askgina.ai/.well-known/api-catalog>)
- [Site guide for agents](<https://cyber.askgina.ai/llms.txt>)
- [Read Cyber skill](<https://cyber.askgina.ai/.well-known/agent-skills/read-cyber/SKILL.md>)
- [Method and sources](<https://cyber.askgina.ai/method>)
