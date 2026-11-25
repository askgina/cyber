import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const SITE = join(ROOT, 'site');
export const PAGES = join(ROOT, 'pages');
export const CORE_ROUTES = ['/', '/leaderboard', '/report', '/method'];
export const SPLIT_FILES = ['data-hot.json', 'data-details.json', 'data-history.json'];
export const DISCOVERY_FILES = {
  '/sitemap.xml': 'application/xml',
  '/feed.xml': 'application/rss+xml',
  '/feed.json': 'application/feed+json',
  '/schemamap.xml': 'application/xml',
};

export const LLMS_FILES = ['/llms.txt', '/llms-full.txt', '/incidents/llms.txt', '/patterns/llms.txt', '/method/llms.txt'];

export async function readJSON(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export function artifactFile(directory, key) {
  if (typeof key !== 'string' || !key) throw new Error(`Invalid artifact key: ${key}`);
  const path = resolve(directory, key);
  if (!path.startsWith(resolve(directory) + sep)) throw new Error(`Artifact key escapes its directory: ${key}`);
  return path;
}

export function liveIncidentIds(data) {
  const groups = [data.news, data.x, data.crypto?.items, data.kev?.items, data.breaches?.items];
  const ids = groups.flatMap((rows) => (rows ?? []).map((row) => row.eid));
  ids.push(...(data.registry ?? []).map((row) => row.id && `r-${row.id}`));
  return [...new Set(ids.filter(Boolean))].sort();
}

export function samplePages(manifest, liveIds = []) {
  const entries = Object.entries(manifest.routes).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const daily = entries.filter(([path]) => path.startsWith('/daily/')).slice(-5);
  const patterns = entries.filter(([path]) => path.startsWith('/patterns/'));
  const incidents = entries.filter(([path]) => path.startsWith('/incidents/'));
  const indexable = incidents.find(([, entry]) => entry.index === true);
  const noindex = incidents.find(([, entry]) => entry.index === false);
  if (!indexable || !noindex || incidents.length < 40 || daily.length < 5 || !patterns.length) {
    throw new Error('Expected ≥40 incidents with both index flags, ≥5 daily pages and pattern pages in manifest.json');
  }
  const groups = new Map();
  for (const pair of incidents) {
    const prefix = pair[0].slice('/incidents/'.length).split('-')[0];
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push(pair);
  }
  const chosen = new Map([indexable, noindex]);
  // Round robin across ID prefixes so small source categories still have coverage.
  for (let row = 0; chosen.size < 40 || row === 0; row++) {
    for (const group of groups.values()) if (group[row]) chosen.set(...group[row]);
  }
  const missing = [];
  for (const id of liveIds) {
    const path = `/incidents/${id}`;
    const entry = manifest.routes[path];
    if (entry?.html && entry.md) chosen.set(path, entry);
    else missing.push(id);
  }
  if (missing.length) {
    throw new Error(`Prerender manifest is missing HTML/Markdown entries for ${missing.length} live incidents (e.g. ${missing.slice(0, 8).join(', ')}). Regenerate pages/ for this snapshot.`);
  }
  const core = CORE_ROUTES.map((path) => {
    if (!manifest.routes[path]) throw new Error(`Missing core route ${path} in manifest.json`);
    return [path, manifest.routes[path]];
  });
  const routes = Object.fromEntries([...core, ...patterns, ...daily, ...chosen]);
  const assets = Object.fromEntries(Object.keys(DISCOVERY_FILES).map((path) => {
    if (!manifest.assets?.[path]) throw new Error(`Missing asset ${path} in manifest.json`);
    return [path, manifest.assets[path]];
  }));
  for (const path of LLMS_FILES) if (manifest.assets?.[path]) assets[path] = manifest.assets[path];
  return {
    manifest: { ...manifest, routes, assets },
    indexableId: indexable[0].slice('/incidents/'.length),
    noindexId: noindex[0].slice('/incidents/'.length),
  };
}
