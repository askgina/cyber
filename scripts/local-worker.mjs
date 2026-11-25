import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { experimental_readRawConfig } from 'wrangler';
import {
  artifactFile, liveIncidentIds, PAGES, readJSON, ROOT, samplePages, SITE, SPLIT_FILES,
} from './lib/worker-fixtures.mjs';

const usage = 'Usage: node scripts/local-worker.mjs [--port N] [--seed-live]';
const loopback = '127.0.0.1';
const localOnlyEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLOUDFLARE_|CF_|WRANGLER_)/.test(key)));
Object.assign(localOnlyEnv, { CI: '1', WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false' });

function childProcess(command, args, cwd) {
  const child = spawn(command, args, { cwd, env: localOnlyEnv, stdio: ['ignore', 2, 2], detached: process.platform !== 'win32' });
  let result;
  const closed = new Promise((resolve) => {
    child.once('error', (error) => resolve(result = error));
    child.once('close', (code, signal) => resolve(result = { code, signal }));
  });
  function kill(signal) {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  return {
    closed,
    async stop() {
      kill('SIGTERM');
      const timeout = setTimeout(() => kill('SIGKILL'), 1_500);
      try { await closed; }
      finally { clearTimeout(timeout); kill('SIGKILL'); }
    },
    get result() { return result; },
  };
}

async function generate(args, cwd, signal) {
  signal.throwIfAborted();
  const child = childProcess('python3', ['-B', ...args], cwd);
  const stop = () => { child.stop().catch((error) => console.error(error.message)); };
  signal.addEventListener('abort', stop, { once: true });
  try {
    const result = await child.closed;
    signal.throwIfAborted();
    if (result instanceof Error) throw result;
    if (result.code !== 0) throw new Error(`python3 ${args.join(' ')} failed (${result.code ?? result.signal})`);
  } finally { signal.removeEventListener('abort', stop); }
}

async function exists(path) {
  try { await access(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function prepareFixtures(work, signal, seedLive) {
  const haveSplit = (await Promise.all(SPLIT_FILES.map((name) => exists(join(SITE, name))))).every(Boolean);
  const havePages = await exists(join(PAGES, 'manifest.json'));
  const scratch = join(work, 'generator');
  const scratchSite = join(scratch, 'site'), scratchPipeline = join(scratch, 'pipeline');
  if (!haveSplit || !havePages) {
    // The generators derive their output paths from their own location. Run scratch copies
    // so a check never writes split files, private prerender state, or baselines into the repo.
    await mkdir(scratchSite, { recursive: true });
    await mkdir(scratchPipeline, { recursive: true });
    for (const name of ['data.json', 'archive.json', 'index.html']) await symlink(join(SITE, name), join(scratchSite, name));
  }
  if (!haveSplit) {
    await copyFile(join(ROOT, 'pipeline/split_data.py'), join(scratchPipeline, 'split_data.py'));
    await generate(['pipeline/split_data.py'], scratch, signal);
  }
  if (!havePages) {
    for (const name of ['enrich.py', 'incidents.json', 'incidents_archive.json', 'archive_cache']) {
      await symlink(join(ROOT, 'pipeline', name), join(scratchPipeline, name));
    }
    // prerender.py resolves __file__, so only the entry point itself must be copied.
    await copyFile(join(ROOT, 'pipeline/prerender.py'), join(scratchPipeline, 'prerender.py'));
    await generate(['pipeline/prerender.py'], scratch, signal);
  }
  const pagesDir = havePages ? PAGES : join(scratch, 'pages');
  const liveIds = seedLive ? liveIncidentIds(await readJSON(join(SITE, 'data.json'))) : [];
  const fixture = samplePages(await readJSON(join(pagesDir, 'manifest.json')), liveIds);
  const files = new Map(['data.json', 'archive.json', ...SPLIT_FILES].map((name) => [name, {
    path: join(!SPLIT_FILES.includes(name) || haveSplit ? SITE : scratchSite, name), type: 'application/json',
  }]));
  function addPage(key, type) {
    files.set(`pages/${key}`, { path: artifactFile(pagesDir, key), type });
  }
  for (const { html, md } of Object.values(fixture.manifest.routes)) {
    addPage(html, 'text/html; charset=utf-8');
    addPage(md, 'text/markdown; charset=utf-8');
  }
  for (const { key, type } of Object.values(fixture.manifest.assets)) addPage(key, type);
  const searchRefs = fixture.manifest.internal?.search_refs;
  const routes = fixture.manifest.routes;
  const liveRef = Object.keys(routes).find((path) => routes[path].scope === 'live' && /^\/incidents\/(?:r|n|x|c|k|b)-/.test(path))?.split('/').at(-1);
  let archiveRef;
  if (searchRefs) {
    addPage(searchRefs.key, 'application/json; charset=utf-8');
    const refs = await readJSON(artifactFile(pagesDir, searchRefs.key));
    archiveRef = Object.keys(refs).find((ref) => ref.startsWith('a:') && routes[`/incidents/${refs[ref]}`]?.scope === 'archive');
  }
  return { ...fixture, files, liveCount: liveIds.length, liveRef, archiveRef };
}

async function freePort() {
  const server = createServer();
  return await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, loopback, () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function setupWrangler(work, token, fixture) {
  const { rawConfig: config } = experimental_readRawConfig({ config: join(ROOT, 'wrangler.jsonc') });
  await build({
    entryPoints: [join(ROOT, 'scripts/lib/local-entry.mjs')], outfile: join(work, 'worker.mjs'), bundle: true, format: 'esm',
    define: {
      LOCAL_FIXTURE_TOKEN: JSON.stringify(token), LOCAL_SEARCH_LIVE_REF: JSON.stringify(fixture.liveRef ?? null),
      LOCAL_SEARCH_ARCHIVE_REF: JSON.stringify(fixture.archiveRef ?? null),
    },
    plugins: [{ name: 'local-bindings', setup(builder) {
      builder.onResolve({ filter: /^@cloudflare\/containers$/ }, ({ path }) => ({ path, namespace: 'local-stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'local-stub' }, () => ({
        contents: 'export class Container {} export function getContainer(stub) { return stub; }',
      }));
    } }],
  });
  const localConfig = join(work, 'wrangler.jsonc');
  // Allowlist only local bindings. Never inherit routes, containers, secrets, ACCOUNT_ID,
  // analytics destinations or AI Search bindings from the production configuration.
  await writeFile(localConfig, JSON.stringify({
    name: 'breach-ledger-smoke', main: 'worker.mjs',
    compatibility_date: config.compatibility_date, compatibility_flags: config.compatibility_flags,
    assets: { directory: resolve(ROOT, config.assets.directory), binding: config.assets.binding,
      run_worker_first: config.assets.run_worker_first, html_handling: config.assets.html_handling,
      not_found_handling: config.assets.not_found_handling },
    r2_buckets: [{ binding: 'STATE', bucket_name: 'breach-ledger-smoke-state' }],
    ratelimits: config.ratelimits?.map(({ name, namespace_id, simple }) => ({ name, namespace_id, simple })),
  }));
  return localConfig;
}

async function seed(base, token, fixture, dev, signal) {
  const endpoint = `${base}/__local_fixture`;
  const headers = { 'x-fixture-token': token };
  for (;;) {
    signal.throwIfAborted();
    if (dev.result) throw new Error(`Wrangler stopped before it was ready: ${dev.result.code ?? dev.result.signal ?? dev.result}`);
    const response = await fetch(endpoint, { headers, signal }).catch(() => null);
    if (response?.status === 204) break;
    await response?.body?.cancel();
    await delay(150, undefined, { signal });
  }
  async function put(key, bytes, type) {
    const response = await fetch(endpoint, { method: 'PUT', headers: { ...headers, 'x-fixture-key': key, 'content-type': type }, body: bytes, signal });
    if (response.status !== 204) throw new Error(`Seeding ${key}: expected 204, got ${response.status} ${await response.text()}`);
  }
  const files = [...fixture.files];
  if (!fixture.liveCount) {
    for (let i = 0; i < files.length; i += 8) {
      await Promise.all(files.slice(i, i + 8).map(async ([key, { path, type }]) => put(key, await readFile(path), type)));
    }
  } else {
    const snapshots = files.filter(([key]) => !key.startsWith('pages/'));
    const objects = files.filter(([key]) => key.startsWith('pages/'));
    await Promise.all(snapshots.map(async ([key, { path, type }]) => put(key, await readFile(path), type)));
    const batchSize = 64, objectsPerWave = 6 * batchSize;
    for (let i = 0; i < objects.length; i += objectsPerWave) {
      const wave = objects.slice(i, i + objectsPerWave);
      await Promise.all(Array.from({ length: Math.ceil(wave.length / batchSize) }, async (_, j) => {
        const batch = wave.slice(j * batchSize, (j + 1) * batchSize);
        const parts = await Promise.all(batch.map(async ([key, { path, type }]) => [key, new Blob([await readFile(path)], { type })]));
        const body = new FormData();
        for (const [key, blob] of parts) body.append(key, blob);
        const response = await fetch(endpoint, { method: 'PATCH', headers, body, signal });
        if (response.status !== 204) throw new Error(`Seeding page batch ${batch[0][0]}: expected 204, got ${response.status} ${await response.text()}`);
      }));
    }
  }
  await put('pages-manifest.json', JSON.stringify(fixture.manifest), 'application/json');
  const close = await fetch(endpoint, { method: 'POST', headers, signal });
  if (close.status !== 204) throw new Error(`Couldn't close seeding endpoint: ${close.status}`);
}

async function main() {
  const { values } = parseArgs({ options: { port: { type: 'string' }, 'seed-live': { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) { console.log(usage); return; }
  if (values.port !== undefined && (!/^\d+$/.test(values.port) || +values.port < 1 || +values.port > 65535)) throw new Error(usage);
  const stop = new AbortController();
  const onSignal = () => stop.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const startup = AbortSignal.any([stop.signal, AbortSignal.timeout(85_000)]);
  const work = await mkdtemp(join(tmpdir(), 'ledger-worker-'));
  let dev;
  try {
    const token = randomBytes(24).toString('hex');
    const fixture = await prepareFixtures(work, startup, values['seed-live']);
    const configDir = join(work, 'config');
    await mkdir(configDir);
    const config = await setupWrangler(configDir, token, fixture);
    const port = values.port ?? await freePort();
    const base = `http://${loopback}:${port}`;
    startup.throwIfAborted();
    // Launch the installed CLI, not npx (which can download code).
    dev = childProcess(process.execPath, [join(ROOT, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--config', config,
      '--local', '--no-bundle', '--ip', loopback, '--port', String(port), '--inspector-port', '0',
      '--persist-to', join(work, 'state'), '--show-interactive-dev-session=false', '--log-level', 'warn'], configDir);
    await seed(base, token, fixture, dev, startup);
    console.error(`FIXTURES --indexable-id ${fixture.indexableId} --noindex-id ${fixture.noindexId}`);
    console.error(`Seeded ${Object.keys(fixture.manifest.routes).length} routes and ${fixture.files.size + 1} local R2 objects`);
    if (values['seed-live']) console.error(`Included all ${fixture.liveCount} live incident routes`);
    console.log(`READY ${base}`);
    const stopped = new Promise((resolve) => {
      if (stop.signal.aborted) resolve();
      else stop.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    const result = await Promise.race([dev.closed, stopped]);
    if (!stop.signal.aborted) throw new Error(`Wrangler exited: ${result.code ?? result.signal ?? result}`);
  } catch (error) {
    if (!stop.signal.aborted) throw error;
  } finally {
    try { await dev?.stop(); }
    finally {
      await rm(work, { recursive: true, force: true });
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
  }
}

main().catch((error) => { console.error(`local-worker: ${error.message}`); process.exitCode = 1; });
