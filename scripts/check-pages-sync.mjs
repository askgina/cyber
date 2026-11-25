import assert from 'node:assert/strict';
import { syncPages } from '../worker/pages.js';

// A full pages sync uploads thousands of objects over minutes, and a run can be cut off
// part-way. syncPages must then resume from what R2 already holds instead of re-uploading
// everything for a manifest that was never published. This drives it against an in-memory
// R2 stand-in.

function fakeState(seed = {}) {
  const store = new Map();
  for (const [key, value] of Object.entries(seed)) store.set(key, value);
  const list = ({ prefix = '', cursor } = {}) => {
    const keys = [...store.keys()].filter((key) => key.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const slice = keys.slice(start, start + 2); // Small pages exercise the cursor loop.
    return {
      objects: slice.map((key) => ({
        key, customMetadata: store.get(key).customMetadata, size: store.get(key).body.length,
      })),
      truncated: start + 2 < keys.length,
      cursor: start + 2 < keys.length ? String(start + 2) : undefined,
    };
  };
  return {
    store,
    async get(key) {
      if (!store.has(key)) return null;
      const { body } = store.get(key);
      return { json: async () => JSON.parse(body), httpEtag: `"${key.length.toString(16)}"`, body: null };
    },
    async put(key, value, options = {}) {
      store.set(key, {
        body: typeof value === 'string' ? value : new TextDecoder().decode(value),
        customMetadata: options.customMetadata,
      });
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
    },
    async head(key) {
      if (!store.has(key)) return null;
      return { httpEtag: `"${key.length.toString(16)}"`, size: store.get(key).body.length };
    },
    async list(options) {
      return list(options);
    },
  };
}

function manifestFor(count) {
  const routes = {};
  for (let i = 0; i < count; i++) {
    routes[`/incidents/t-${i}`] = { html: `t-${i}.html`, html_sha: `h${i}`, md: `t-${i}.md`, md_sha: `m${i}`, index: true };
  }
  return { generated: '2026-11-25T00:00:00Z', routes, assets: {} };
}

function fakeBuilder(manifest, { failAtCall } = {}) {
  const counters = { bundleCalls: 0, keysRequested: [], inFlight: 0, peak: 0 };
  return {
    get bundleCalls() { return counters.bundleCalls; },
    get keysRequested() { return counters.keysRequested; },
    get peak() { return counters.peak; },
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/out/pages/manifest.json') return Response.json(manifest);
      if (url.pathname !== '/out/pages/bundle') throw new Error(`unexpected builder request ${url.pathname}`);
      counters.bundleCalls += 1;
      const call = counters.bundleCalls;
      counters.inFlight += 1;
      counters.peak = Math.max(counters.peak, counters.inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5)); // Let lanes overlap.
        if (failAtCall && call === failAtCall) return new Response('boom', { status: 500 });
        const keys = JSON.parse(await request.text());
        counters.keysRequested.push(...keys);
        return Response.json(Object.fromEntries(keys.map((key) => [key, `<${key}>`])));
      } finally {
        counters.inFlight -= 1;
      }
    },
  };
}

const pageKeys = (state) => [...state.store.keys()].filter((key) => key.startsWith('pages/'));
const untracked = (state) => pageKeys(state).filter((key) => !state.store.get(key).customMetadata?.sha);

// 1. An interrupted run keeps what it uploaded, records each object's sha, and publishes nothing.
{
  const state = fakeState();
  const builder = fakeBuilder(manifestFor(250), { failAtCall: 2 });
  await assert.rejects(syncPages({ STATE: state }, builder), /pages bundle: 500/);
  assert.equal(state.store.has('pages-manifest.json'), false, 'a failed sync publishes no manifest');
  // Three lanes run at once, so the batches that were already in flight also land.
  const kept = pageKeys(state).length;
  assert.ok(kept >= 100 && kept <= 300, `objects from completed batches stay in R2 (kept ${kept})`);
  assert.equal(untracked(state).length, 0, 'every uploaded object carries its manifest sha');
  assert.equal(builder.peak, 3, 'three bundle downloads overlap');
}

// 2. The next run uploads only what is missing, then publishes the manifest.
{
  const state = fakeState();
  await assert.rejects(syncPages({ STATE: state }, fakeBuilder(manifestFor(250), { failAtCall: 2 })));

  const builder = fakeBuilder(manifestFor(250));
  const result = await syncPages({ STATE: state }, builder);
  assert.ok(builder.bundleCalls <= 4, `only the missing objects are requested (${builder.bundleCalls} batches)`);
  assert.ok(result.uploaded <= 400, `the resumed run reports the objects it uploaded (${result.uploaded})`);
  assert.equal(pageKeys(state).length, 500, 'every manifest object is in R2');
  assert.ok(state.store.has('pages-manifest.json'), 'the manifest is published once all uploads succeed');
}

// 3. An unchanged manifest makes no bundle requests.
{
  const state = fakeState();
  await syncPages({ STATE: state }, fakeBuilder(manifestFor(250)));
  const builder = fakeBuilder(manifestFor(250));
  const result = await syncPages({ STATE: state }, builder);
  assert.equal(builder.bundleCalls, 0, 'nothing is downloaded or uploaded for an unchanged manifest');
  assert.equal(result.uploaded, 0);
}

// 4. Dropped routes are deleted from R2.
{
  const state = fakeState();
  await syncPages({ STATE: state }, fakeBuilder(manifestFor(250)));
  const builder = fakeBuilder(manifestFor(240));
  const result = await syncPages({ STATE: state }, builder);
  assert.equal(builder.bundleCalls, 0);
  assert.equal(result.deleted, 20, 'both representations of each dropped route are deleted');
  assert.equal(pageKeys(state).length, 480);
}

// 5. Objects uploaded before shas were recorded are re-uploaded once, then trusted; an
// object no manifest references is deleted.
{
  const state = fakeState();
  const manifest = manifestFor(250);
  for (const entry of Object.values(manifest.routes).slice(0, 25)) {
    state.store.set(`pages/${entry.html}`, { body: 'old' });
    state.store.set(`pages/${entry.md}`, { body: 'old' });
  }
  state.store.set('pages/orphan.html', { body: 'orphan' });
  await syncPages({ STATE: state }, fakeBuilder(manifest));
  assert.equal(untracked(state).length, 0, 'legacy objects are re-uploaded with their sha');
  assert.equal(pageKeys(state).length, 500, 'the orphaned object is deleted');
  assert.equal(state.store.has('pages/orphan.html'), false);

  const again = fakeBuilder(manifest);
  await syncPages({ STATE: state }, again);
  assert.equal(again.bundleCalls, 0, 'the next run trusts the recorded shas');
}

console.log('pages sync: 5/5 resume, prune and legacy cases passed');
