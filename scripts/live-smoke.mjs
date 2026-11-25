import { parseArgs } from 'node:util';

const USAGE = 'Usage: node scripts/live-smoke.mjs --base-url <http(s)://host>';
const PUBLIC_ORIGIN = 'https://cyber.askgina.ai';
const HTML = { status: 200, type: 'text/html', document: true };
const HOT = '/data-hot.json';
const probes = [
  ...['/', '/leaderboard', '/report', '/method'].map((path) => ({ path, ...HTML })),
  { path: '/robots.txt', status: 200, type: 'text/plain' },
  { path: '/sitemap.xml', status: 200, type: 'application/xml' },
  { path: '/feed.xml', status: 200, type: 'application/rss+xml' },
  { path: '/feed.json', status: 200, type: 'application/feed+json' },
  { path: HOT, status: 200, type: 'application/json', hot: true },
  { path: '/this-path-does-not-exist-smoke', status: 404, type: 'text/html', noindex: true },
  { path: '/index.html', status: 301, redirect: true },
];

function hasToken(value, token) {
  return (value ?? '').toLowerCase().split(',').some((part) => part.trim() === token);
}

async function main(base) {
  const summary = [], failures = [];
  async function probe({ path, status, type, document, noindex, redirect, hot, revalidation }, etag) {
    const label = path + (revalidation ? ' (If-None-Match)' : '');
    const row = { Request: label, Expected: status, Observed: '—', Result: 'FAIL' };
    summary.push(row);
    const start = failures.length;
    const check = (field, ok, expected, observed) => {
      if (!ok) failures.push({ Request: label, Check: field, Expected: expected, Observed: observed ?? '(missing)' });
    };
    if (revalidation && !etag) {
      check('Revalidation precondition', false, 'valid ETag from initial GET', 'no ETag; request not sent');
      return;
    }
    let response;
    try {
      // GET only, no search endpoint, no retries, and never follow redirects.
      response = await fetch(new URL(path, base), {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15_000),
        headers: { Accept: type ?? '*/*', ...(revalidation && { 'If-None-Match': etag }) },
      });
      const h = (name) => response.headers.get(name);
      row.Observed = response.status;
      check('Status', response.status === status, status, response.status);
      if (type) check('Content-Type', h('Content-Type')?.split(';')[0].trim().toLowerCase() === type, type, h('Content-Type'));
      check('X-Content-Type-Options', h('X-Content-Type-Options')?.toLowerCase() === 'nosniff', 'nosniff', h('X-Content-Type-Options'));
      if (document || noindex) {
        check('Content-Security-Policy', /(?:^|;)\s*default-src\s+'self'(?:\s*;|$)/i.test(h('Content-Security-Policy') ?? ''),
          "enforcing policy with default-src 'self'", h('Content-Security-Policy'));
        check('Vary', hasToken(h('Vary'), 'accept'), 'includes Accept', h('Vary'));
      }
      if (document) {
        check('Link', /<\/feed\.xml>[^,]*\brel="alternate"/.test(h('Link') ?? '') && /<\/sitemap\.xml>[^,]*\brel="sitemap"/.test(h('Link') ?? ''),
          'RSS alternate and sitemap discovery links', h('Link'));
        check('X-Robots-Tag', !/\bnoindex\b/i.test(h('X-Robots-Tag') ?? ''), 'not noindex', h('X-Robots-Tag'));
      }
      if (noindex) check('X-Robots-Tag', /\bnoindex\b/i.test(h('X-Robots-Tag') ?? ''), 'includes noindex', h('X-Robots-Tag'));
      if (redirect) {
        const location = h('Location');
        const target = location && URL.parse(location, base);
        check('Location', target?.href === `${base.origin}/` || target?.href === `${PUBLIC_ORIGIN}/`, 'canonical homepage /', location);
      }
      const actualTag = h('ETag');
      if (hot || revalidation) check('Cache-Control', hasToken(h('Cache-Control'), 'no-cache'), 'includes no-cache', h('Cache-Control'));
      const validTag = /^(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"$/.test(actualTag ?? '');
      if (hot) check('ETag', validTag, 'a quoted HTTP entity tag', actualTag);
      if (revalidation) {
        // Cloudflare adds or drops the weak marker when it compresses a body, so compare entity tags weakly.
        const opaque = (tag) => (tag ?? '').replace(/^W\//, '');
        check('ETag', opaque(actualTag) === opaque(etag), etag, actualTag);
        check('Response body', response.body === null, 'no body on 304', 'body present');
      }
      row.Result = start === failures.length ? 'PASS' : 'FAIL';
      return hot && validTag ? actualTag : undefined;
    } catch (error) {
      const detail = error.cause?.message ? `${error.message}: ${error.cause.message}` : error.message;
      check('HTTP request', false, 'a response', detail);
    } finally {
      // The smoke checks response metadata, not the contents of multi-MB fixtures.
      await response?.body?.cancel().catch(() => {});
    }
  }

  for (const spec of probes) {
    const etag = await probe(spec);
    if (spec.hot) await probe({ path: HOT, status: 304, revalidation: true }, etag);
  }
  console.log(`HTTP smoke: ${base.origin}`);
  console.table(summary);
  if (failures.length) {
    console.table(failures);
    process.exitCode = 1;
  }
}

try {
  const { values } = parseArgs({ options: { 'base-url': { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) console.log(USAGE);
  else {
    const base = URL.parse(values['base-url'] ?? '');
    if (!base || !['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.href !== `${base.origin}/`) {
      throw new Error(USAGE);
    }
    await main(base);
  }
} catch (error) {
  console.error(`HTTP smoke: ${error.message}`);
  process.exitCode = 1;
}
