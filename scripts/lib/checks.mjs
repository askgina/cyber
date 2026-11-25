import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const parser = fileURLToPath(new URL('./parse-markup.py', import.meta.url));

export function markup(format, source) {
  const result = spawnSync('python3', ['-B', parser, format], {
    input: source, encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim().split('\n').at(-1));
  return JSON.parse(result.stdout);
}

export function xmlDiscovery(path, source) {
  const doc = markup('xml', source);
  const sitemap = doc.root === '{http://www.sitemaps.org/schemas/sitemap/0.9}urlset';
  const locations = doc.locations;
  const validURLs = locations.length > 0 && locations.every((url) => /^https?:\/\//i.test(url) && URL.canParse(url));
  const valid = path === '/sitemap.xml' ? sitemap && doc.children.every((tag) => tag === 'url') && locations.length === doc.children.length && validURLs :
    path === '/feed.xml' ? doc.root === 'rss' && doc.children.includes('channel') :
    (sitemap || doc.root === 'schemamap') && validURLs;
  if (!valid) throw new Error(`unexpected ${doc.root} document (${doc.children.length} children, ${locations.length} loc elements)`);
  return doc;
}

export function jsonFeed(source) {
  const doc = JSON.parse(source);
  if (!/^https:\/\/jsonfeed\.org\/version\/1(?:\.1)?$/.test(doc?.version) || !doc.title || !Array.isArray(doc.items)) {
    throw new Error('expected JSON Feed v1/v1.1 with a title and items array');
  }
  return doc;
}

export function robotsRules(source) {
  const groups = [];
  let group;
  for (const line of source.split(/\r?\n/)) {
    const [directive, ...parts] = line.split('#')[0].split(':');
    const key = directive.trim().toLowerCase(), value = parts.join(':').trim();
    if (key === 'user-agent' && value) {
      if (!group || group.rules.length) groups.push(group = { agents: [], rules: [] });
      group.agents.push(value.toLowerCase());
    } else if (group && (key === 'allow' || key === 'disallow')) group.rules.push({ key, value });
  }
  return groups;
}

export function hasRobotsDirective(value, directive) {
  return (value ?? '').toLowerCase().split(/[\s,]+/).includes(directive);
}

export function linkTargets(header) {
  // A comma is a separator only outside the URI and quoted parameters (RFC 8288).
  const link = /[ \t]*<([^<>\s]*)>(?:[ \t]*;[ \t]*[\w!#$%&'*+.^`|~\x2d]+(?:[ \t]*=[ \t]*(?:"(?:[^"\\]|\\.)*"|[\w!#$%&'*+.^`|~\x2d]+))?)*[ \t]*(?:,|$)/y;
  const targets = [];
  let offset = 0;
  while (offset < header.length) {
    link.lastIndex = offset;
    const match = link.exec(header);
    if (!match) throw new Error(`Invalid Link value at offset ${offset}: ${header.slice(offset, offset + 100)}`);
    targets.push(match[1]);
    offset = link.lastIndex;
  }
  return targets;
}

export function reporter(name) {
  const failures = [];
  let total = 0;
  function record(check, ok, expected, observed) {
    total++;
    if (!ok) failures.push({ Check: check, Expected: expected, Observed: String(observed ?? '(missing)') });
  }
  return {
    record,
    equal(check, observed, expected) { record(check, observed === expected, expected, observed); },
    done() {
      console.log(`${name}: ${total - failures.length}/${total} checks passed`);
      if (failures.length) {
        console.table(failures);
        process.exitCode = 1;
      }
    },
  };
}
