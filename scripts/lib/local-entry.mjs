import worker from '../../worker/index.js';
import { ARCHIVE_TITLE, SEARCH_CONTROL, SEARCH_REF, SEARCH_TITLE, UNRESOLVED_TITLE } from './search-fixture.mjs';

const AI_SEARCH = {
  async search() {
    return { chunks: [
      [SEARCH_TITLE, LOCAL_SEARCH_LIVE_REF ?? SEARCH_REF],
      [ARCHIVE_TITLE, LOCAL_SEARCH_ARCHIVE_REF ?? 'a:fixture|2026-11-24|Test||'],
      [UNRESOLVED_TITLE, SEARCH_REF],
    ].map(([title, ref]) => ({
      item: { key: 'inc/2026-11-24.md' }, score: 1,
      text: `# ${title}\n\nRecord: ${ref}\n\nA fixed response from the in-process search stub.`,
    })) };
  },
};
const allow = { async limit() { return { success: true }; } };
const refuse = { async limit() { return { success: false }; } };
const failSearch = { async search() { throw new Error('injected AI Search failure'); } };
const BUILDER = {
  async fetch() { return new Response('Builder is disabled in the local smoke test', { status: 503 }); },
  async stop() {},
};
const bindings = new WeakMap();
let seedOpen = true;

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (seedOpen && path === '/__local_fixture' && request.headers.get('x-fixture-token') === LOCAL_FIXTURE_TOKEN) {
      if (request.method === 'POST') seedOpen = false;
      else if (request.method === 'PUT') {
        const key = request.headers.get('x-fixture-key');
        const contentType = request.headers.get('content-type');
        await env.STATE.put(key, await request.arrayBuffer(), { httpMetadata: { contentType } });
      } else if (request.method === 'PATCH') {
        const entries = [...(await request.formData()).entries()];
        for (let i = 0; i < entries.length; i += 8) {
          await Promise.all(entries.slice(i, i + 8).map(async ([key, file]) => {
            await env.STATE.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
          }));
        }
      } else if (request.method !== 'GET') return new Response(null, { status: 405 });
      return new Response(null, { status: 204 });
    }
    // Everything on the public request path uses production dispatch, unchanged.
    if (!bindings.has(env)) bindings.set(env, { ...env, AI_SEARCH, BUILDER, SEARCH_REQ_LIMIT: allow, SEARCH_LIMIT: allow });
    const local = bindings.get(env);
    const pagesMode = request.headers.get('x-ledger-local-pages');
    if (pagesMode === 'r2-error' || (path === '/llms.txt' && ['static-fallback', 'missing-asset'].includes(pagesMode))) {
      const STATE = {
        async get(key) {
          if (pagesMode === 'r2-error') throw new Error('injected pages R2 failure');
          return key === 'pages-manifest.json' ? null : env.STATE.get(key);
        },
      };
      const ASSETS = pagesMode === 'missing-asset' ? { async fetch() { return new Response(null, { status: 404 }); } } : env.ASSETS;
      return worker.fetch(request, { ...local, STATE, ASSETS }, ctx);
    }
    const mode = request.headers.get(SEARCH_CONTROL);
    if (path === '/api/search' && mode) {
      return worker.fetch(request, { ...local,
        SEARCH_REQ_LIMIT: mode === 'request-limit' ? refuse : allow,
        SEARCH_LIMIT: mode === 'miss-limit' ? refuse : allow,
        AI_SEARCH: mode === 'upstream-error' ? failSearch : AI_SEARCH,
      }, ctx);
    }
    return worker.fetch(request, local, ctx);
  },
};
