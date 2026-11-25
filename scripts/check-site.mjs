import { createHash } from 'node:crypto';
import { readFile, readdir, stat, open } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { CSP, SITE_ORIGIN } from '../worker/headers.js';
import { hasRobotsDirective, jsonFeed, markup, reporter, robotsRules, xmlDiscovery } from './lib/checks.mjs';
import { artifactFile, CORE_ROUTES, DISCOVERY_FILES, PAGES, readJSON, ROOT, SITE } from './lib/worker-fixtures.mjs';

// Uncompressed deployment bytes; ~25% headroom over the Phase 3 site.
const BUDGETS = { JS: 165_000, CSS: 71_000, Hot: 1_048_576 };
const check = reporter('check-site');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const SKILL_PATH = '/.well-known/agent-skills/read-cyber/SKILL.md';
const CATALOG_PATH = '/.well-known/api-catalog';
const DISCOVERY_TYPES = {
  '/.well-known/ard.json': 'application/json; charset=utf-8',
  [CATALOG_PATH]: 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
  '/openapi.json': 'application/json; charset=utf-8',
  '/.well-known/agent-skills/index.json': 'application/json; charset=utf-8',
  [SKILL_PATH]: 'text/markdown; charset=utf-8',
};
const PUBLIC_OPERATIONS = {
  '/api/search': 'searchIncidentsByMeaning',
  '/data.json': 'getLiveSnapshot',
  '/data-hot.json': 'getHotSnapshot',
  '/archive.json': 'getArchiveSnapshot',
};
const DISCOVERY_WORKER_ROUTES = new Set([...Object.keys(PUBLIC_OPERATIONS), '/llms-full.txt']);

async function inspect(label, expected, read) {
  try {
    const value = await read();
    check.record(label, true, expected, expected);
    return value;
  } catch (error) {
    check.record(label, false, expected, error.code === 'ENOENT' ? 'missing file' : error.message);
  }
}

async function getText(name) {
  return await inspect(`site/${name}`, 'readable file', () => readFile(join(SITE, name), 'utf8'));
}

function headerRules(source) {
  const rules = new Map();
  let path;
  for (const line of source.split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      path = text;
      if (!rules.has(path)) rules.set(path, new Map());
    } else {
      const colon = text.indexOf(':');
      if (path && colon > 0) rules.get(path).set(text.slice(0, colon).toLowerCase(), text.slice(colon + 1).trim());
    }
  }
  return rules;
}

async function checkReference(ref, label) {
  return inspect(label, 'reference points to an existing site file', async () => {
    const url = new URL(ref, SITE_ORIGIN);
    const localPath = decodeURIComponent(url.pathname).slice(1);
    if (!localPath || !(await stat(artifactFile(SITE, localPath))).isFile()) throw new Error(`not a file: ${url.pathname}`);
  });
}

async function checkHTML(file, manifest) {
  const source = await getText(file);
  if (source === undefined) return;
  const tags = await inspect(`site/${file} markup`, 'parseable HTML', () => markup('html', source));
  if (!tags) return;
  const meta = (kind, value) => tags.find(({ tag, attrs }) => tag === 'meta' && attrs[kind]?.toLowerCase() === value)?.attrs.content;
  const hrefs = (rel) => tags.filter(({ tag, attrs }) => tag === 'link' && attrs.rel?.toLowerCase().split(/\s+/).includes(rel)).map(({ attrs }) => attrs.href);
  if (file === 'index.html') {
    check.equal(`${file} canonical`, hrefs('canonical').join(', '), `${SITE_ORIGIN}/`);
    for (const key of ['og:type', 'og:title', 'og:description', 'og:url', 'og:image']) {
      const content = meta('property', key);
      check.record(`${file} ${key}`, Boolean(content?.trim()), 'non-empty Open Graph meta content', content);
    }
    const card = meta('name', 'twitter:card');
    check.record(`${file} twitter:card`, Boolean(card?.trim()), 'non-empty Twitter Card meta content', card);
  } else {
    const value = meta('name', 'robots');
    check.record(`${file} robots meta`, hasRobotsDirective(value, 'noindex'), 'contains noindex', value);
  }

  let ldCount = 0;
  const references = new Map();
  for (const { tag, attrs, line, body, closed } of tags) {
    const label = `${file}:${line} <${tag}>`;
    if (Object.hasOwn(attrs, 'style')) check.record(`${label} style attribute`, false, 'no style= attribute', attrs.style ?? '(bare style=)');
    if (tag === 'script') {
      const jsonLD = attrs.type?.trim().toLowerCase() === 'application/ld+json' && !Object.hasOwn(attrs, 'src');
      if (jsonLD) {
        ldCount++;
        await inspect(`${label} JSON-LD`, 'closed application/ld+json script with valid JSON-LD object or array', () => {
          if (!closed) throw new Error('script is not closed');
          const data = JSON.parse(body);
          if (!isObject(data) && !(Array.isArray(data) && data.length && data.every(isObject))) throw new Error('expected an object or array of objects');
        });
      } else {
        check.record(`${label} script source`, Boolean(attrs.src?.trim() && !body?.trim() && closed),
          'closed external script tag with no inline code', attrs.src ? `src=${attrs.src}, ${body?.trim().length ?? 0} chars of inline code` : 'inline script without JSON-LD type');
      }
    }
    if ((tag === 'script' && Object.hasOwn(attrs, 'src')) || (tag === 'link' && Object.hasOwn(attrs, 'href'))) {
      const source = tag === 'script' ? attrs.src : attrs.href;
      const url = source && URL.canParse(source, SITE_ORIGIN) ? new URL(source, SITE_ORIGIN) : null;
      check.record(`${label} origin`, url?.origin === SITE_ORIGIN, `same origin ${SITE_ORIGIN}`, url?.origin ?? source);
    }
    const candidates = ['href', 'src', 'poster'].map((key) => attrs[key]);
    if (tag === 'object') candidates.push(attrs.data);
    if (/^(?:og:image|twitter:image)$/.test(attrs.property ?? attrs.name ?? '')) candidates.push(attrs.content);
    for (const key of ['srcset', 'imagesrcset']) {
      if (attrs[key]) candidates.push(...[...attrs[key].matchAll(/(?:^|[,\s])(\/(?!\/)[^,\s]+)/g)].map((match) => match[1]));
    }
    for (const ref of candidates) {
      const value = ref?.trim();
      if (!value || !URL.canParse(value, SITE_ORIGIN) || !/^(?:\/|https?:\/\/)/i.test(value)) continue;
      const url = new URL(value, SITE_ORIGIN);
      if (url.origin !== SITE_ORIGIN) continue;
      // Navigation to a Worker document is not a static file reference.
      if ((tag === 'a' || tag === 'link' && attrs.rel?.toLowerCase() === 'canonical') &&
          (CORE_ROUTES.includes(url.pathname) || manifest?.routes?.[url.pathname])) continue;
      references.set(url.pathname, references.get(url.pathname) ?? label);
    }
  }
  if (file === 'index.html') check.record(`${file} JSON-LD count`, ldCount > 0, 'at least one JSON-LD script', ldCount);
  for (const [ref, label] of references) await checkReference(ref, `${label} ${ref}`);
}

async function checkDiscovery(prefix, paths) {
  for (const [url, file] of paths) {
    await inspect(`${prefix}${url}`, url.endsWith('.json') ? 'parseable JSON Feed' : 'well-formed XML with the expected discovery root', async () => {
      const body = await readFile(file, 'utf8');
      return url.endsWith('.json') ? jsonFeed(body) : xmlDiscovery(url, body);
    });
  }
}

const nonempty = (value) => typeof value === 'string' && Boolean(value.trim());
const absoluteHTTP = (value) => nonempty(value) && !/\s/.test(value) && /^https?:\/\//i.test(value) && URL.canParse(value);
const cyberURL = (value) => {
  if (!absoluteHTTP(value)) return false;
  const { origin, username, password } = new URL(value);
  return origin === SITE_ORIGIN && !username && !password;
};

function* jsonValues(value) {
  yield value;
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) yield* jsonValues(child);
  }
}

async function checkAgentReferences(name, refs) {
  const paths = new Set();
  for (const ref of refs) {
    const url = new URL(ref, `${SITE_ORIGIN}${name}`);
    if (url.origin === SITE_ORIGIN) paths.add(url.pathname);
  }
  for (const path of paths) {
    if (!DISCOVERY_WORKER_ROUTES.has(path)) {
      const filePath = path.endsWith('/') ? `${path}index.html` : path;
      await checkReference(filePath, `${name} → ${path}`);
    }
  }
}

async function checkAgentDiscovery() {
  async function getJSON(path) {
    return inspect(`site${path}`, 'parseable JSON object', async () => {
      const value = await readJSON(join(SITE, path.slice(1)));
      if (!isObject(value)) throw new Error('expected a JSON object');
      return value;
    });
  }

  const ardPath = '/.well-known/ard.json';
  const ard = await getJSON(ardPath);
  if (ard) {
    const entries = Array.isArray(ard.entries) ? ard.entries : [];
    for (const path of [CATALOG_PATH, '/openapi.json', SKILL_PATH, '/llms.txt']) {
      check.record(`${ardPath} entry ${path}`, entries.some((entry) => entry?.url === `${SITE_ORIGIN}${path}`),
        'entry with absolute Cyber URL', 'entry missing');
    }
    const identifiers = new Set();
    for (const [i, entry] of entries.entries()) {
      const valid = isObject(entry) && !Object.hasOwn(entry, 'data') && cyberURL(entry.url) &&
        nonempty(entry.identifier) && /^urn:air:cyber\.askgina\.ai:[\w.:-]+$/.test(entry.identifier) &&
        !identifiers.has(entry.identifier) && nonempty(entry.displayName) && nonempty(entry.description) &&
        nonempty(entry.type) && /^[\w.+-]+\/[\w.+-]+$/.test(entry.type) &&
        Array.isArray(entry.representativeQueries) && entry.representativeQueries.length >= 2 &&
        entry.representativeQueries.length <= 5 && entry.representativeQueries.every(nonempty);
      check.record(`${ardPath} entries[${i}]`, valid,
        'unique domain URN, display name, media type, absolute Cyber HTTPS URL, description and 2–5 queries', JSON.stringify(entry));
      if (valid) identifiers.add(entry.identifier);
    }
    await checkAgentReferences(ardPath, [...jsonValues(ard)].filter(absoluteHTTP));
  }

  const catalog = await getJSON(CATALOG_PATH);
  if (catalog) {
    const sets = Array.isArray(catalog.linkset) ? catalog.linkset : [];
    check.record(`${CATALOG_PATH} linkset`, sets.length > 0, 'nonempty linkset array', JSON.stringify(catalog.linkset));
    for (const [i, context] of sets.entries()) {
      check.record(`${CATALOG_PATH} linkset[${i}].anchor`, absoluteHTTP(context?.anchor), 'absolute HTTP(S) URL', context?.anchor);
      for (const [rel, targets] of Object.entries(context ?? {})) {
        if (rel === 'anchor') continue;
        check.record(`${CATALOG_PATH} linkset[${i}].${rel}`, Array.isArray(targets) && targets.length > 0 &&
          targets.every((target) => isObject(target) && absoluteHTTP(target.href)), 'array of links with absolute HTTP(S) hrefs', JSON.stringify(targets));
      }
    }
    const root = sets.find((context) => context?.anchor === `${SITE_ORIGIN}${CATALOG_PATH}`);
    for (const [rel, paths] of Object.entries({
      item: Object.keys(PUBLIC_OPERATIONS), 'service-desc': ['/openapi.json'], 'service-doc': ['/llms.txt'],
    })) {
      const targets = Array.isArray(root?.[rel]) ? root[rel].map((target) => target?.href) : [];
      for (const path of paths) {
        check.record(`${CATALOG_PATH} ${rel} ${path}`, targets.includes(`${SITE_ORIGIN}${path}`),
          'link in the catalog context', 'link missing');
      }
    }
    await checkAgentReferences(CATALOG_PATH, [...jsonValues(catalog)].filter(absoluteHTTP));
  }

  const openapiPath = '/openapi.json';
  const api = await getJSON(openapiPath);
  if (api) {
    check.record(`${openapiPath} version`, nonempty(api.openapi) && /^3\.1(?:\.|$)/.test(api.openapi), 'OpenAPI 3.1', api.openapi);
    check.record(`${openapiPath} security`, Array.isArray(api.security) && api.security.length === 0, '[] (no authentication)', JSON.stringify(api.security));
    const paths = Object.keys(api.paths ?? {});
    check.record(`${openapiPath} paths`, paths.length === Object.keys(PUBLIC_OPERATIONS).length &&
      paths.every((path) => Object.hasOwn(PUBLIC_OPERATIONS, path)), 'exactly the four public read routes', paths.join(', '));
    for (const [path, operationId] of Object.entries(PUBLIC_OPERATIONS)) {
      const pathItem = api.paths?.[path];
      check.equal(`${openapiPath} GET ${path} operationId`, pathItem?.get?.operationId, operationId);
      const otherMethods = Object.keys(pathItem ?? {}).filter((key) => /^(put|post|delete|options|head|patch|trace)$/.test(key));
      check.record(`${openapiPath} ${path} methods`, otherMethods.length === 0, 'only GET is documented', otherMethods.join(', '));
    }
    const responses = api.paths?.['/api/search']?.get?.responses;
    for (const status of ['405', '429', '502']) {
      check.record(`${openapiPath} search response ${status}`, isObject(responses?.[status]), 'response object', JSON.stringify(responses?.[status]));
    }
    check.record(`${openapiPath} search 429 Retry-After`, isObject(responses?.['429']?.headers?.['Retry-After']), 'Retry-After header object',
      JSON.stringify(responses?.['429']?.headers));
    const refs = [];
    for (const value of jsonValues(api)) {
      if (!isObject(value)) continue;
      if (Array.isArray(value.servers)) refs.push(...value.servers.map((server) => server?.url));
      if (Object.hasOwn(value, 'externalDocs')) refs.push(value.externalDocs?.url);
    }
    const valid = (ref) => nonempty(ref) && URL.canParse(ref, `${SITE_ORIGIN}${openapiPath}`);
    check.record(`${openapiPath} servers and externalDocs URLs`, refs.length > 0 && refs.every(valid), 'valid URL references', JSON.stringify(refs));
    await checkAgentReferences(openapiPath, refs.filter(valid));
  }

  const index = await getJSON('/.well-known/agent-skills/index.json');
  if (index) check.equal('skills index schema', index.$schema, 'https://schemas.agentskills.io/discovery/0.2.0/schema.json');
  const skill = await inspect(`site${SKILL_PATH}`, 'readable Markdown file', () => readFile(join(SITE, SKILL_PATH.slice(1))));
  if (skill) {
    // Parse the flat plain-scalar front matter used here, without a YAML dependency.
    const parsed = /^---\r?\nname: read-cyber\r?\ndescription: ([A-Za-z][^\r\n:#]*)\r?\n---\r?\n([\s\S]*)$/.exec(skill.toString('utf8'));
    check.record(`${SKILL_PATH} front matter and body`, Boolean(parsed && parsed[1].length <= 1024 && /^#\s+.+/m.test(parsed[2])),
      'read-cyber name, nonempty description and Markdown heading', parsed ? 'parsed front matter' : 'invalid front matter');
    if (index) {
      const entry = Array.isArray(index.skills) ? index.skills.find((item) => item?.name === 'read-cyber') : undefined;
      check.equal('skills index read-cyber type', entry?.type, 'skill-md');
      check.equal('skills index read-cyber URL', entry?.url, `${SITE_ORIGIN}${SKILL_PATH}`);
      if (parsed) check.equal('skills index read-cyber description', entry?.description, parsed[1]);
      check.equal('skills index read-cyber digest', entry?.digest, `sha256:${createHash('sha256').update(skill).digest('hex')}`);
    }
  }
}

async function checkPrerender() {
  const file = join(PAGES, 'manifest.json');
  let manifest;
  try { manifest = await readJSON(file); }
  catch (error) {
    if (error.code !== 'ENOENT') check.record('pages/manifest.json', false, 'parseable JSON', error.message);
    return;
  }
  if (!isObject(manifest?.routes) || !isObject(manifest?.assets)) {
    check.record('pages/manifest.json', false, 'routes and assets objects', 'missing or invalid');
    return;
  }
  check.record('pages/manifest.json', true, 'routes and assets objects', 'present');
  const objects = new Map();
  function digest(key, sha, label) {
    const ok = typeof key === 'string' && Boolean(key) && /^[a-f0-9]{64}$/.test(sha);
    check.record(`${label} object reference`, ok, 'relative object key and SHA-256', JSON.stringify({ key, sha }));
    if (!ok) return;
    if (objects.has(key)) check.equal(`${label} shared ${key} digest`, sha, objects.get(key));
    objects.set(key, sha);
  }
  for (const path of CORE_ROUTES) check.record(`manifest route ${path}`, isObject(manifest.routes[path]), 'a core route entry', manifest.routes[path] ? 'present' : '(missing)');
  for (const [path, entry] of Object.entries(manifest.routes)) {
    check.record(`manifest route ${path} index`, typeof entry?.index === 'boolean', 'boolean', entry?.index);
    digest(entry?.html, entry?.html_sha, `${path} HTML`);
    digest(entry?.md, entry?.md_sha, `${path} Markdown`);
  }
  const assetPaths = new Map();
  for (const [path, type] of Object.entries(DISCOVERY_FILES)) {
    const asset = manifest.assets[path];
    check.equal(`manifest asset ${path} type`, asset?.type?.split(';')[0], type);
    if (!asset) continue;
    digest(asset.key, asset.sha, path);
    const location = await inspect(`manifest asset ${path} path`, 'path inside pages/', () => artifactFile(PAGES, asset.key));
    if (location) assetPaths.set(path, location);
  }
  const entries = [...objects];
  for (let i = 0; i < entries.length; i += 32) {
    await Promise.all(entries.slice(i, i + 32).map(async ([key, sha]) => {
      const file = await inspect(`pages/${key}`, 'readable prerender object', () => readFile(artifactFile(PAGES, key)));
      if (file !== undefined) check.equal(`pages/${key} SHA-256`, createHash('sha256').update(file).digest('hex'), sha);
    }));
  }
  await checkDiscovery('pages', assetPaths);
  return manifest;
}

async function checkBudgets() {
  const files = (await readdir(SITE, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
  let js = 0, css = 0, fonts = 0;
  for (const entry of files) {
    const file = join(entry.parentPath, entry.name);
    if (/\.(?:js|mjs|cjs)$/i.test(entry.name)) js += (await stat(file)).size;
    if (/\.css$/i.test(entry.name)) css += (await stat(file)).size;
    if (/\.woff2$/i.test(entry.name)) {
      fonts++;
      const bytes = Buffer.alloc(4);
      const fd = await open(file);
      try { await fd.read(bytes, 0, 4, 0); }
      finally { await fd.close(); }
      check.equal(`${relative(ROOT, file)} WOFF2 magic`, bytes.toString('latin1'), 'wOF2');
    }
  }
  check.record('site fonts', fonts > 0, 'at least one WOFF2 font', fonts);
  for (const [label, bytes] of [['JS', js], ['CSS', css]]) {
    console.log(`site ${label}: ${bytes} / ${BUDGETS[label]} bytes`);
    check.record(`site total ${label} bytes`, bytes > 0 && bytes <= BUDGETS[label], `1–${BUDGETS[label]} bytes`, bytes);
  }
  try {
    const { size } = await stat(join(SITE, 'data-hot.json'));
    console.log(`site data-hot.json: ${size} / ${BUDGETS.Hot} bytes`);
    check.record('site/data-hot.json byte budget', size <= BUDGETS.Hot, `≤ ${BUDGETS.Hot} bytes`, size);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function main() {
  const manifest = await checkPrerender();
  await checkHTML('index.html', manifest);
  await checkHTML('404.html', manifest);
  const md = await getText('404.md');
  if (md !== undefined) check.record('site/404.md content', /^#\s+.+/m.test(md), 'Markdown heading', md.slice(0, 80));
  const headers = await getText('_headers');
  if (headers !== undefined) {
    const rules = headerRules(headers);
    check.equal('site/_headers /* Content-Security-Policy', rules.get('/*')?.get('content-security-policy'), CSP);
    for (const path of ['/404.html', '/404.md']) {
      const value = rules.get(path)?.get('x-robots-tag');
      check.record(`site/_headers ${path} X-Robots-Tag`, hasRobotsDirective(value, 'noindex'), 'contains noindex', value);
    }
    for (const [path, type] of Object.entries(DISCOVERY_TYPES)) {
      const rule = rules.get(path);
      // Workers Assets joins headers from matching rules, so the skill inherits /*.md.
      const contentTypes = [rule?.get('content-type'), path === SKILL_PATH ? rules.get('/*.md')?.get('content-type') : undefined];
      check.equal(`site/_headers ${path} Content-Type`, contentTypes.filter(Boolean).join(', '), type);
      check.equal(`site/_headers ${path} Access-Control-Allow-Origin`, rule?.get('access-control-allow-origin'), '*');
      check.equal(`site/_headers ${path} Cache-Control`, rule?.get('cache-control'), 'public, max-age=300');
    }
    check.equal(`site/_headers ${CATALOG_PATH} Link`, rules.get(CATALOG_PATH)?.get('link'), `<${CATALOG_PATH}>; rel="api-catalog"`);
  }
  const robots = await getText('robots.txt');
  if (robots !== undefined) {
    const schemaMap = `Schemamap: ${SITE_ORIGIN}/schemamap.xml`;
    check.record('site/robots.txt Schemamap', robots.split(/\r?\n/).includes(schemaMap), schemaMap, 'directive missing or incorrect');
    const wildcard = robotsRules(robots).filter(({ agents }) => agents.includes('*')).flatMap(({ rules }) => rules);
    for (const path of ['/api/search', '/e', '/__build']) {
      check.record(`site/robots.txt Disallow: ${path}`, wildcard.some(({ key, value }) => key === 'disallow' && value === path) &&
        !wildcard.some(({ key, value }) => key === 'allow' && value === path), 'wildcard group disallows this path', JSON.stringify(wildcard));
    }
  }
  const web = await inspect('site/manifest.webmanifest', 'valid JSON web app manifest', async () => {
    const data = await readJSON(join(SITE, 'manifest.webmanifest'));
    if (!isObject(data) || !data.name?.trim() || !data.start_url || !Array.isArray(data.icons) || !data.icons.length) throw new Error('missing name, start_url or icons');
    return data;
  });
  if (web) for (const icon of web.icons) await checkReference(icon?.src, `manifest.webmanifest icon ${icon?.src}`);
  await checkDiscovery('site', Object.keys(DISCOVERY_FILES).map((path) => [path, join(SITE, path.slice(1))]));
  await checkAgentDiscovery();
  await checkBudgets();
  check.done();
}

main().catch((error) => { console.error(`check-site: ${error.message}`); process.exitCode = 1; });
