import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { SITE_ORIGIN } from '../worker/headers.js';
import { hasRobotsDirective, jsonFeed, linkTargets, reporter, robotsRules, xmlDiscovery } from './lib/checks.mjs';
import { CORE_ROUTES, DISCOVERY_FILES, LLMS_FILES, PAGES, readJSON, samplePages, SITE } from './lib/worker-fixtures.mjs';
import { ARCHIVE_TITLE, SEARCH_CONTROL, SEARCH_TITLE, UNRESOLVED_TITLE } from './lib/search-fixture.mjs';

const usage = 'Usage: node scripts/check-worker.mjs --base-url <url> [--indexable-id <id>] [--noindex-id <id>]';
const MIME = { html: 'text/html', md: 'text/markdown', json: 'application/json' };
const ROBOTS = 'x-robots-tag';
const check = reporter('check-worker');
const mediaType = (r) => r.headers.get('content-type')?.split(';')[0].trim().toLowerCase();

async function main() {
  const { values } = parseArgs({ options: {
    'base-url': { type: 'string' }, 'indexable-id': { type: 'string' }, 'noindex-id': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) { console.log(usage); return; }
  if (!values['base-url'] || !/^https?:\/\//i.test(values['base-url'])) throw new Error(usage);
  const origin = new URL(values['base-url']).origin;
  for (const name of ['indexable-id', 'noindex-id']) {
    if (values[name] !== undefined && !/^[a-z0-9][a-z0-9._-]{0,120}$/i.test(values[name])) throw new Error(`Invalid --${name}: ${values[name]}`);
  }
  const request = (path, options) => fetch(new URL(path, origin), { redirect: 'manual', signal: AbortSignal.timeout(10_000), ...options });
  async function run(path, options, expectedStatus, test = () => {}, label = '') {
    const target = path instanceof URL ? path.pathname + path.search : path;
    const name = `${options?.method ?? 'GET'} ${target}${label ? ` (${label})` : ''}`;
    let response;
    try {
      response = await request(path, options);
      check.equal(`${name} status`, response.status, expectedStatus);
      if (response.status !== expectedStatus) return;
      await test(response, name);
    } catch (error) {
      check.record(name, false, 'successful request and response checks', error.cause?.message ?? error.message);
    } finally { if (response && !response.bodyUsed) await response.body?.cancel(); }
  }
  function type(r, name, expected) { check.equal(`${name} Content-Type`, mediaType(r), expected); }
  function secure(r, name) {
    const csp = r.headers.get('content-security-policy');
    check.record(`${name} CSP`, Boolean(csp && !/['"]?unsafe-(?:inline|eval)\b/i.test(csp)), 'CSP without unsafe-inline or unsafe-eval', csp);
    const hsts = r.headers.get('strict-transport-security');
    check.record(`${name} HSTS`, /(?:^|;)\s*max-age=[1-9]\d*/i.test(hsts ?? ''), 'positive max-age', hsts);
    check.equal(`${name} X-Content-Type-Options`, r.headers.get('x-content-type-options')?.toLowerCase(), 'nosniff');
    check.equal(`${name} X-Frame-Options`, r.headers.get('x-frame-options')?.toUpperCase(), 'DENY');
  }
  function staticSecurity(r, name) {
    secure(r, name);
    check.equal(`${name} Referrer-Policy`, r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    check.equal(`${name} Permissions-Policy`, r.headers.get('permissions-policy'),
      'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  }
  function noindex(r, name) {
    const value = r.headers.get(ROBOTS);
    check.record(`${name} X-Robots-Tag`, hasRobotsDirective(value, 'noindex'), 'contains noindex', value);
  }
  function vary(r, name) {
    const header = r.headers.get('vary');
    const tokens = (header ?? '').toLowerCase().split(',').map((token) => token.trim()).filter(Boolean);
    check.record(`${name} Vary`, tokens.includes('accept') && tokens.includes('user-agent') && new Set(tokens).size === tokens.length,
      'Accept and User-Agent with no duplicates', header);
  }
  function hasLink(r, name, target, rel, linkType) {
    const header = r.headers.get('link');
    const quoted = `<${SITE_ORIGIN}${target}>; rel="${rel}"${linkType ? `; type="${linkType}"` : ''}`;
    check.record(`${name} Link ${rel}`, Boolean(header?.includes(quoted)), quoted, header);
  }
  async function document(r, name, pathname, markdown) {
    type(r, name, markdown ? MIME.md : MIME.html);
    vary(r, name);
    if (markdown) {
      hasLink(r, name, pathname, 'canonical');
      const body = await r.text();
      check.equal(`${name} x-markdown-tokens`, r.headers.get('x-markdown-tokens'), String(Math.ceil(body.length / 4)));
    } else {
      hasLink(r, name, pathname === '/' ? '/index.md' : `${pathname}.md`, 'alternate', MIME.md);
    }
  }
  async function parse(r, name, expected, parser) {
    try {
      const doc = parser(await r.text());
      check.record(`${name} body`, true, expected, expected);
      return doc;
    } catch (error) { check.record(`${name} body`, false, expected, error.message); }
  }

  const advertised = new Map();
  await run('/', undefined, 200, (r, name) => {
    type(r, name, MIME.html); secure(r, name);
    const header = r.headers.get('link');
    check.record(`${name} Link`, Boolean(header?.trim()), 'non-empty Link response header', header);
    if (!header?.trim()) return;
    try {
      for (const target of linkTargets(header)) {
        const url = new URL(target, origin);
        if (![origin, SITE_ORIGIN].includes(url.origin)) continue;
        // The Worker can emit its production origin even in local dev. Check the
        // same resource on the supplied origin; never contact production by accident.
        const local = new URL(origin);
        local.pathname = url.pathname;
        local.search = url.search;
        advertised.set(local.href, local);
      }
    } catch (error) {
      check.record(`${name} Link syntax`, false, 'valid Link header with URI references', error.message);
    }
  });
  for (const target of advertised.values()) await run(target, undefined, 200, undefined, 'advertised by / Link');
  for (const [from, to] of [['/index.html', '/'], ['/leaderboard/', '/leaderboard']]) {
    await run(from, undefined, 301, (r, name) => {
      const location = r.headers.get('location');
      const url = location && new URL(location, origin);
      check.record(`${name} Location`, url?.pathname === to && [origin, SITE_ORIGIN].includes(url.origin) && !url.search && !url.hash,
        `canonical path ${to} on the site or test origin without query/fragment`, location);
    });
  }
  for (const path of CORE_ROUTES.slice(1)) await run(path, undefined, 200, (r, name) => type(r, name, MIME.html));

  let sitemap;
  for (const [path, expectedType] of Object.entries(DISCOVERY_FILES)) {
    await run(path, undefined, 200, async (r, name) => {
      type(r, name, expectedType);
      if (path === '/feed.json') await parse(r, name, 'well-formed JSON Feed', jsonFeed);
      else {
        const doc = await parse(r, name, 'well-formed discovery XML with the expected root', (body) => xmlDiscovery(path, body));
        if (path === '/sitemap.xml') sitemap = doc;
      }
    });
  }
  let localSample;
  if (!values['indexable-id'] || !values['noindex-id']) {
    try { localSample = samplePages(await readJSON(join(PAGES, 'manifest.json'))); }
    catch (error) {
      if (error.code !== 'ENOENT') check.record('pages/manifest.json', false, 'valid local fixture manifest', error.message);
    }
  }
  const sitemapIncident = sitemap?.locations.map((url) => new URL(url).pathname).find((path) => /^\/incidents\/[a-z0-9][a-z0-9._-]{0,120}$/i.test(path));
  const indexable = values['indexable-id'] ?? localSample?.indexableId ?? sitemapIncident?.split('/').at(-1);
  const unlisted = values['noindex-id'] ?? localSample?.noindexId;
  for (const [id, unindexed, flag] of [[indexable, false, '--indexable-id'], [unlisted, true, '--noindex-id']]) {
    if (!id) { check.record(`Incident fixture ${flag}`, false, 'ID from local-worker FIXTURES or the local manifest', '(missing)'); continue; }
    await run(`/incidents/${id}`, undefined, 200, (r, name) => {
      type(r, name, MIME.html);
      if (unindexed) noindex(r, name);
      else check.equal(`${name} X-Robots-Tag`, r.headers.get(ROBOTS), null);
    });
  }

  const readerAgents = ['ChatGPT-User', 'Claude-User', 'Perplexity-User', 'ClaudeBot', 'OAI-SearchBot', 'PerplexityBot'];
  const browser = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8';
  const weightedCases = [
    ['text/html;q=.4,text/markdown;q=.9', 'Mozilla/5.0', true, 'Markdown preferred'],
    ['text/html;q=.9,text/markdown;q=.4', readerAgents[0], false, 'HTML preferred over agent UA'],
    ['text/*;q=.7,text/html;q=.2', 'Mozilla/5.0', true, 'text wildcard'],
    ['*/*;q=.6,text/html;q=.1', 'Mozilla/5.0', true, 'global wildcard'],
    ['text/markdown;q=0,*/*;q=.9', readerAgents[0], false, 'explicit Markdown veto'],
    ['text/*;q=0,*/*;q=.9', readerAgents[0], false, 'text wildcard veto'],
    ['text/html;q=.7,text/markdown;q=.7', 'Mozilla/5.0', false, 'normal tie defaults to HTML'],
    [browser, 'Mozilla/5.0', false, 'browser Accept'],
    [browser, readerAgents[0], false, 'browser Accept overrides agent UA'],
    ...readerAgents.map((ua) => ['*/*', `${ua}/1.0`, true, ua]),
  ];
  for (const [accept, ua, markdown, label] of weightedCases) {
    await run('/', { headers: { Accept: accept, 'User-Agent': ua } }, 200,
      (r, name) => document(r, name, '/', markdown), label);
  }
  const sitemapPaths = sitemap?.locations.map((url) => new URL(url).pathname) ?? [];
  const pattern = sitemapPaths.filter((path) => path.startsWith('/patterns/')).sort()[0];
  const daily = sitemapPaths.filter((path) => path.startsWith('/daily/')).sort().at(-1);
  for (const [name, path] of [['pattern', pattern], ['daily page', daily]]) {
    check.record(`${name} fixture`, Boolean(path), 'listed in sitemap', path);
  }
  for (const path of [...CORE_ROUTES, indexable && `/incidents/${indexable}`, pattern, daily].filter(Boolean)) {
    const companion = path === '/' ? '/index.md' : `${path}.md`;
    let tokens, etag;
    await run(companion, { headers: { Accept: 'text/html,text/markdown;q=0' } }, 200, async (r, name) => {
      tokens = r.headers.get('x-markdown-tokens');
      etag = r.headers.get('etag');
      await document(r, name, path, true);
    }, 'explicit Markdown');
    await run(path, { method: 'HEAD', headers: { Accept: 'text/markdown' } }, 200, async (r, name) => {
      type(r, name, MIME.md); vary(r, name); hasLink(r, name, path, 'canonical');
      check.equal(`${name} x-markdown-tokens`, r.headers.get('x-markdown-tokens'), tokens);
      check.equal(`${name} body length`, (await r.arrayBuffer()).byteLength, 0);
    }, 'negotiated Markdown');
    await run(companion, { method: 'HEAD', headers: { Accept: 'text/html' } }, 200, async (r, name) => {
      type(r, name, MIME.md); vary(r, name); hasLink(r, name, path, 'canonical');
      check.equal(`${name} x-markdown-tokens`, r.headers.get('x-markdown-tokens'), tokens);
      check.equal(`${name} body length`, (await r.arrayBuffer()).byteLength, 0);
    }, 'explicit Markdown');
    if (path === '/' && etag) {
      await run(path, { headers: { Accept: 'text/markdown', 'If-None-Match': etag } }, 304, async (r, name) => {
        vary(r, name); hasLink(r, name, path, 'canonical');
        check.equal(`${name} x-markdown-tokens`, r.headers.get('x-markdown-tokens'), tokens);
        check.equal(`${name} body length`, (await r.arrayBuffer()).byteLength, 0);
      }, 'negotiated Markdown ETag');
    }
  }

  for (const path of ['/incidents/worker-gate-definitely-absent-0142', '/worker-gate-definitely-absent-0142']) {
    for (const [extension, expectedType] of Object.entries({ html: MIME.html, md: MIME.md })) {
      const template = (await readFile(join(SITE, `404.${extension}`), 'utf8')).trim();
      await run(path, { headers: { Accept: expectedType } }, 404, async (r, name) => {
        const markdown = expectedType === MIME.md;
        type(r, name, expectedType); noindex(r, name); vary(r, name);
        hasLink(r, name, markdown ? '/404' : '/404.md', markdown ? 'canonical' : 'alternate', markdown ? undefined : MIME.md);
        const raw = await r.text();
        if (markdown) check.equal(`${name} x-markdown-tokens`, r.headers.get('x-markdown-tokens'), String(Math.ceil(raw.length / 4)));
        const body = raw.trim();
        check.record(`${name} 404 document`, body === template, `body of site/404.${extension}`, `${body.length} chars: ${body.slice(0, 95).replace(/\s+/g, ' ')}`);
      }, `Accept: ${expectedType}`);
    }
  }

  await run('/incidents/worker-gate-definitely-absent-0142', { method: 'HEAD', headers: { 'User-Agent': 'ClaudeBot/1.0' } }, 404, async (r, name) => {
    type(r, name, MIME.md); vary(r, name); noindex(r, name); hasLink(r, name, '/404', 'canonical');
    check.record(`${name} x-markdown-tokens`, /^\d+$/.test(r.headers.get('x-markdown-tokens') ?? ''), 'integer Markdown token count', r.headers.get('x-markdown-tokens'));
    check.equal(`${name} body length`, (await r.arrayBuffer()).byteLength, 0);
  }, 'agent UA');
  for (const path of LLMS_FILES) {
    await run(path, undefined, 200, async (r, name) => {
      type(r, name, MIME.md);
      const body = await r.text();
      check.record(`${name} body`, /^#\s+.+/m.test(body), 'Markdown heading', body.slice(0, 80));
    });
    await run(path, { method: 'HEAD' }, 200, async (r, name) => {
      type(r, name, MIME.md);
      check.equal(`${name} body length`, (await r.arrayBuffer()).byteLength, 0);
    });
  }
  await run('/search-refs.json', undefined, 404);
  await run('/llms.txt', { headers: { 'x-ledger-local-pages': 'static-fallback' } }, 200, async (r, name) => {
    type(r, name, MIME.md);
    const body = await r.text();
    check.record(`${name} body`, body === await readFile(join(SITE, 'llms.txt'), 'utf8'), 'exact site/llms.txt fallback', `${body.length} chars`);
  }, 'R2 miss, static fallback');
  await run('/llms.txt', { headers: { 'x-ledger-local-pages': 'missing-asset' } }, 503, (r, name) => {
    check.equal(`${name} Retry-After`, r.headers.get('retry-after'), '3600');
  }, 'missing in R2 and static assets');
  if (indexable) await run(`/incidents/${indexable}`, { headers: { 'x-ledger-local-pages': 'r2-error' } }, 500, undefined, 'R2 read failure');

  let etag;
  await run('/data-hot.json', undefined, 200, async (r, name) => {
    type(r, name, MIME.json);
    etag = r.headers.get('etag');
    check.record(`${name} ETag`, /^"[^"\r\n]+"$/.test(etag ?? ''), 'strong quoted ETag', etag);
    await parse(r, name, 'JSON data object', (body) => {
      const doc = JSON.parse(body);
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('not a JSON object');
      return doc;
    });
  });
  for (const condition of [etag, etag && `W/${etag}`]) {
    if (!condition) continue;
    await run('/data-hot.json', { headers: { 'If-None-Match': condition } }, 304, async (r, name) => {
      check.equal(`${name} ETag`, r.headers.get('etag'), etag);
      check.equal(`${name} body length`, (await r.arrayBuffer()).byteLength, 0);
    }, `If-None-Match ${condition.startsWith('W/') ? 'weak' : 'strong'}`);
  }
  await run('/data-hot.json', { method: 'HEAD' }, 200, async (r, name) => {
    type(r, name, MIME.json);
    check.equal(`${name} body length`, (await r.arrayBuffer()).byteLength, 0);
    if (etag) check.equal(`${name} ETag`, r.headers.get('etag'), etag);
  });
  await run('/data-hot.json', { method: 'POST' }, 405, (r, name) => {
    const allow = r.headers.get('allow');
    check.record(`${name} Allow`, ['GET', 'HEAD'].every((method) => allow?.split(/\s*,\s*/).includes(method)), 'GET and HEAD', allow);
  });
  await run('/archive.json', undefined, 200, (r, name) => type(r, name, MIME.json));

  await run('/robots.txt', undefined, 200, async (r, name) => {
    const groups = robotsRules(await r.text());
    const wildcard = groups.filter(({ agents }) => agents.includes('*')).flatMap(({ rules }) => rules);
    for (const path of ['/api/search', '/e', '/__build']) {
      check.record(`${name} Disallow: ${path}`, wildcard.some(({ key, value }) => key === 'disallow' && value === path) &&
        !wildcard.some(({ key, value }) => key === 'allow' && value === path), 'wildcard group disallows this path', JSON.stringify(wildcard));
    }
  });
  await run('/styles.css', undefined, 200, staticSecurity);
  const font = (await readdir(join(SITE, 'fonts'))).filter((name) => name.endsWith('.woff2')).sort()[0];
  if (font) await run(`/fonts/${font}`, undefined, 200, staticSecurity);
  else check.record('Font fixture', false, 'at least one .woff2 in site/fonts', '(none)');

  const searchMode = (value) => ({ headers: { [SEARCH_CONTROL]: value } });
  async function searchResponse(r, name, expectedError) {
    type(r, name, MIME.json);
    check.equal(`${name} X-Robots-Tag`, r.headers.get(ROBOTS), 'noindex, nofollow');
    check.equal(`${name} Cache-Control`, r.headers.get('cache-control'), 'no-store');
    const data = await parse(r, name, 'search result JSON', JSON.parse);
    if (expectedError && data) {
      check.equal(`${name} error`, data.error, expectedError);
      check.equal(`${name} results`, JSON.stringify(data.results), '[]');
    }
    return data;
  }
  const search = '/api/search?q=ransomware';
  const nonce = randomUUID();
  const cold = `/api/search?q=uncached-rate-limit-check-${nonce}`;
  const failure = `/api/search?q=upstream-failure-check-${nonce}`;
  await run('/api/search?q=ab', searchMode('miss-limit'), 200, async (r, name) => {
    const data = await searchResponse(r, name);
    check.equal(`${name} results`, JSON.stringify(data?.results), '[]');
  }, 'short query, misses refused');
  const linked = [];
  await run(search, undefined, 200, async (r, name) => {
    const data = await searchResponse(r, name);
    const results = Array.isArray(data?.results) ? data.results : [];
    check.equal(`${name} fixture result count`, results.length, 3);
    for (const [title, scope] of [[SEARCH_TITLE, 'live'], [ARCHIVE_TITLE, 'archive'], [UNRESOLVED_TITLE, null]]) {
      const row = results.find((item) => item.title === title);
      check.equal(`${name} ${title} scope`, row?.scope, scope);
      const url = row?.url && URL.parse(row.url);
      if (scope === null) check.equal(`${name} ${title} url`, row?.url, null);
      else {
        const valid = url?.origin === SITE_ORIGIN && /^\/incidents\/[a-z0-9][a-z0-9._-]{0,120}$/.test(url.pathname) && !url.search && !url.hash &&
          (scope === 'archive' ? row.ref?.startsWith('a:') : url.pathname === `/incidents/${row.ref}`);
        check.record(`${name} ${title} url`, valid, `canonical linked ${scope} incident`, row?.url);
        if (valid) linked.push(url.pathname);
      }
    }
  });
  for (const path of linked) await run(path, undefined, 200, undefined, 'search result URL');
  await run(search, searchMode('miss-limit'), 200, searchResponse, 'cache hit bypasses miss limit');
  for (const [method, path] of [['POST', search], ['HEAD', cold]]) {
    await run(path, { method, ...searchMode('request-limit') }, 405, async (r, name) => {
      check.equal(`${name} Allow`, r.headers.get('allow'), 'GET');
      if (method === 'POST') await searchResponse(r, name, 'method not allowed');
      else {
        type(r, name, MIME.json);
        check.equal(`${name} Cache-Control`, r.headers.get('cache-control'), 'no-store');
        check.equal(`${name} X-Robots-Tag`, r.headers.get(ROBOTS), 'noindex, nofollow');
        check.equal(`${name} body length`, (await r.arrayBuffer()).byteLength, 0);
      }
    }, 'method before limiter');
  }
  for (const [path, mode] of [[search, 'request-limit'], [cold, 'miss-limit']]) {
    await run(path, searchMode(mode), 429, async (r, name) => {
      check.equal(`${name} Retry-After`, r.headers.get('retry-after'), '60');
      await searchResponse(r, name, 'rate limited');
    }, mode);
  }
  await run(cold, undefined, 200, searchResponse, '429 not cached');
  await run(failure, searchMode('upstream-error'), 502, (r, name) => searchResponse(r, name, 'search unavailable'), 'upstream unavailable');
  await run(failure, undefined, 200, searchResponse, '502 not cached');
  await run('/e', { method: 'POST', headers: { 'Content-Type': MIME.json }, body: JSON.stringify({ e: 'view', p: { view: 'report' } }) }, 204);
  await run('/__build', undefined, 403);
  check.done();
}

main().catch((error) => { console.error(`check-worker: ${error.message}`); process.exitCode = 1; });
