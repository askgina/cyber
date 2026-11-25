// Register browser tools only when WebMCP is available. Tool calls do not change the page.
(() => {
  "use strict";
  let context;
  try {
    const current = document.modelContext;
    context = typeof current?.registerTool === "function" ? current : navigator.modelContext;
    if (typeof context?.registerTool !== "function") return;
  } catch { return; }

  const R = window.BLRoutes;
  const source = new URL(R.SITE_ORIGIN).hostname;
  const incidentId = /^(?!a-[0-9]+$)(?!.*\.[mM][dD]$)[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
  const patternId = /^[A-Za-z0-9][A-Za-z0-9-]{0,80}$/;
  const isIncidentId = (id) => typeof id === "string" && incidentId.test(id);
  const error = (code, message, extra) => ({ ok: false, code, error: message, ...extra });
  const success = (data) => ({ ok: true, ...data, source });
  const unavailable = (resource) => error("unavailable", `${resource} is unavailable.`);
  const request = (path, accept, options) => fetch(path, {
    headers: { Accept: accept }, signal: options?.signal, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer",
  });
  function failure(response, resource) {
    if (response.status === 404) return error("not_found", `${resource} not found.`);
    if (response.status === 429) {
      const delay = response.headers.get("Retry-After")?.trim();
      return error("rate_limited", `${resource} is rate limited.`, {
        retryAfterSeconds: /^\d+$/.test(delay) && Number.isSafeInteger(Number(delay)) ? Number(delay) : null,
      });
    }
    return unavailable(resource);
  }

  function canonicalIncidentURL(value) {
    const prefix = R.SITE_ORIGIN + "/incidents/";
    return typeof value === "string" && value.startsWith(prefix) && isIncidentId(value.slice(prefix.length)) ? value : null;
  }

  async function search(input, options) {
    const query = typeof input?.query === "string" ? input.query.trim().replace(/\s+/g, " ") : "";
    if (query.length < 3 || query.length > 300) return error("invalid_input", "Query must contain 3 to 300 characters.");
    const response = await request("/api/search?" + new URLSearchParams({ q: query }), "application/json", options);
    if (!response.ok) return failure(response, "Search");
    const { results } = await response.json();
    if (!Array.isArray(results)) return unavailable("Search");
    return success({ results: results.slice(0, 8).map((result) => {
      const url = canonicalIncidentURL(result.url);
      return {
        title: result.title, kind: result.kind, date: result.date ?? null, snippet: result.snippet ?? null,
        url, scope: url && ["live", "archive"].includes(result.scope) ? result.scope : null, source,
        ...(url ? {} : { note: "This record has no standalone page." }),
      };
    }) });
  }

  const recentKinds = ["incident", "crypto", "kev", "breach", "news", "x-signal"];
  function recent({ kind, limit = 10 }) {
    if ((kind !== undefined && !recentKinds.includes(kind)) || !Number.isInteger(limit) || limit < 1) {
      return error("invalid_input", "Use a listed kind and a positive integer limit.");
    }
    const snapshot = window.BL?.D;
    if (!snapshot) return unavailable("The incident snapshot");
    const incidents = [];
    const add = (type, rows, project) => {
      if (kind && kind !== type) return;
      for (const row of rows || []) {
        const [id, title, date] = project(row);
        if (isIncidentId(id)) incidents.push({ id, title, date, kind: type, url: R.SITE_ORIGIN + R.incidentPath(id) });
      }
    };
    add("incident", snapshot.registry, (r) => [r.id && "r-" + r.id, r.title || r.org, r.first_reported]);
    add("crypto", snapshot.crypto?.items, (r) => [r.eid, r.name, r.date]);
    add("kev", snapshot.kev?.items, (r) => [r.eid, `${r.id}: ${r.name}`, r.date]);
    add("breach", snapshot.breaches?.items, (r) => [r.eid, r.title, r.added]);
    add("news", snapshot.news, (r) => [r.eid, r.title, r.date]);
    add("x-signal", snapshot.x, (r) => [r.eid, r.subject, r.date]);
    incidents.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    return success({ generated: snapshot.generated, incidents: incidents.slice(0, Math.min(limit, 25)) });
  }

  function patterns() {
    const definitions = window.BL?.D?.pattern_defs;
    if (!Array.isArray(definitions)) return unavailable("The pattern list");
    return success({ patterns: definitions.filter((p) => patternId.test(p.id)).map((p) => ({
      id: p.id, title: p.label, url: R.SITE_ORIGIN + R.patternPath(p.id),
    })) });
  }

  function readDocument(resource, matches, pathFor) {
    return async (input, options) => {
      const id = input?.id;
      if (typeof id !== "string" || !matches(id)) return error("invalid_input", `Use a canonical ${resource.toLowerCase()} ID.`);
      const path = pathFor(id);
      const response = await request(path, "text/markdown", options);
      if (!response.ok) return failure(response, resource);
      if (!/^text\/markdown(?:\s*;|$)/i.test(response.headers.get("Content-Type") || "")) return unavailable(`${resource} Markdown`);
      return success({ id, url: R.SITE_ORIGIN + path, markdown: await response.text() });
    };
  }

  const schema = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
  const idField = (description, pattern, maxLength) => schema({ id: { type: "string", description, pattern, maxLength } }, ["id"]);
  const tools = [
    ["search_incidents_by_meaning", "Search Cyber for incident reports by topic. Results include excerpts and canonical URLs when available.",
      schema({ query: { type: "string", minLength: 3, maxLength: 300, description: "Public keywords or a question about an incident." } }, ["query"]), search, "Search"],
    ["list_recent_incidents", "List the newest records in the loaded Cyber snapshot. Does not fetch additional records.",
      schema({ kind: { type: "string", enum: recentKinds, description: "Optional record type." },
        limit: { type: "integer", minimum: 1, maximum: 25, default: 10, description: "Maximum number of records." } }), recent, "The incident snapshot"],
    ["get_incident", "Read a published Cyber incident as Markdown. Use the ID from its canonical URL.",
      idField("Canonical ID after /incidents/.", incidentId.source, 121), readDocument("Incident", isIncidentId, R.incidentPath), "Incident"],
    ["list_patterns", "List Cyber pattern IDs, labels and canonical URLs from the loaded snapshot.", schema({}), patterns, "The pattern list"],
    ["get_pattern", "Read a published Cyber pattern as Markdown. Use an ID from list_patterns.",
      idField("Pattern ID after /patterns/.", patternId.source, 81), readDocument("Pattern", (id) => patternId.test(id), R.patternPath), "Pattern"],
  ];

  const registration = new AbortController();
  window.addEventListener("pagehide", (event) => { if (!event.persisted) registration.abort(); });
  for (const [name, description, inputSchema, execute, resource] of tools) {
    try {
      const result = context.registerTool({
        name, description, inputSchema,
        annotations: { readOnlyHint: true, untrustedContentHint: true, consequentialHint: false },
        async execute(input, options) {
          try { return await execute(input ?? {}, options); }
          catch { return options?.signal?.aborted ? error("cancelled", "The request was cancelled.") : unavailable(resource); }
        },
      }, { signal: registration.signal });
      Promise.resolve(result).catch(() => {}); // Some implementations return void; others reject unsupported registrations.
    } catch { /* an unavailable browser tool must not break the page */ }
  }
})();
