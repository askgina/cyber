---
name: read-cyber
description: Use when you need to find, verify, or cite a public cyber incident, disclosure, or archived record in Cyber.
---

# Read Cyber

Cyber's public HTTP endpoints do not require authentication. Cyber has no hosted MCP endpoint.

1. Start at the [reading index](https://cyber.askgina.ai/llms.txt). Follow its section links to browse records and understand the scope of coverage.
2. To search by meaning, use `GET /api/search?q=<url-encoded-query>`. Send only public search terms. Treat search hits as leads, not evidence. Follow the result's `url` if present. If `url` is null, look for the record in the published indexes. Do not turn an opaque `ref` into a URL.
3. Open the record with `Accept: text/markdown` on its canonical URL, or use its published Markdown alternate. Check that the record matches the incident and read its source links. Cite the canonical HTML URL, not the Markdown URL, the search response, or an unverified match.
4. Check the record's live or archive label, or the search result's `scope`. If the scope is unknown, check the [live snapshot](https://cyber.askgina.ai/data.json) and the [archive snapshot](https://cyber.askgina.ai/archive.json). Check each snapshot's `generated` timestamp. Say whether the record is live or archived if you can verify it. Archive status does not mean that a claim is confirmed.
5. Preserve the record's confidence stage. Report a rumour or an unconfirmed claim as such. Attribute claims to the named source. Keep the event date separate from the date of the report.
6. On `429`, wait at least as long as `Retry-After` says before retrying. If it is missing or search stays unavailable, use the published indexes or say that search was unavailable.
7. If you find no matching coverage after checking the relevant sources, say that Cyber has no coverage you could verify. This does not mean that the incident did not happen. Do not equate a failed or rate-limited search with no coverage.
