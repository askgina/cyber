import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import axe from 'axe-core';
import { chromium } from 'playwright-core';

const PROFILES = [
  { width: 1440, height: 900, deviceScaleFactor: 1.25, isMobile: false, hasTouch: false },
  { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
];
const VIEWS = {
  Terminal: { path: '/', container: '#term', skip: '#term' },
  Leaderboard: { path: '/leaderboard', container: '#board', skip: '#board' },
  Report: { path: '/report', container: '#rep', skip: '#main' },
  'Incident drawer': { path: '/', container: '#term' },
  'Command palette': { path: '/', container: '#term' },
};
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const DEFERRED = ['/data-details.json', '/data-history.json', '/archive.json'];
const DRAWER = '#t-insp';
const DRAWER_TITLE = '#t-ib h2';
const BASELINE_ID = 'n-9456adfe';
const COLD_MS = 8000; // Match the baseline's request observation window.
const STATE_MS = 8000; // Local fixtures answer fast; remote runs pass a larger --timeout.
const USAGE = 'Usage: node scripts/verify-browser.mjs --base-url <http(s)://host> [--timeout <ms>]';

function assert(ok, expected, observed) {
  if (!ok) throw new Error(`expected ${expected}; observed ${observed}`);
}

function options() {
  const { values } = parseArgs({ options: {
    'base-url': { type: 'string' }, timeout: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) { console.log(USAGE); return; }
  const base = URL.parse(values['base-url'] ?? '');
  if (!base || !['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.href !== `${base.origin}/`) {
    throw new Error(USAGE);
  }
  // A remote origin needs more than local fixture latency for a multi-MB data load.
  const timeout = values.timeout === undefined ? STATE_MS : Number(values.timeout);
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 120_000) throw new Error(USAGE);
  return { base, timeout };
}

async function observe(context, page, base) {
  const requests = [];
  const errors = new Set();
  const pending = new Set();
  context.on('request', (request) => {
    const url = new URL(request.url());
    requests.push(url);
    if (url.origin === base.origin) pending.add(request);
  });
  context.on('requestfinished', (request) => pending.delete(request));
  context.on('requestfailed', (request) => {
    pending.delete(request);
    if (new URL(request.url()).origin === base.origin) {
      errors.add(`same-origin request failed: ${request.method()} ${request.url()} (${request.failure()?.errorText})`);
    }
  });
  context.on('response', (response) => {
    if (new URL(response.url()).origin === base.origin && response.status() >= 400) {
      errors.add(`same-origin request failed: ${response.request().method()} ${response.url()} (HTTP ${response.status()})`);
    }
  });
  page.on('pageerror', (error) => errors.add(`uncaught page error: ${error.message}`));
  await context.exposeBinding('__verifyCsp', ({ frame }, directive, blocked) => {
    errors.add(`securitypolicyviolation: ${directive} blocked ${blocked} on ${frame.url()}`);
  });
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      void window.__verifyCsp(event.effectiveDirective, event.blockedURI);
    }, true);
  });
  // New contexts isolate themes/storage; also disable HTTP caching explicitly for
  // the baseline comparison. Never bypass CSP or intercept site requests.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  return { requests, errors, pending, cdp };
}

async function load(page, base, path) {
  const response = await page.goto(new URL(path, base).href, { waitUntil: 'load' });
  assert(response?.status() === 200, `HTTP 200 for ${path}`, `HTTP ${response?.status() ?? '(no response)'}`);
}

const waitForData = (page) => page.waitForFunction(() => Boolean(window.BL?.D && document.querySelector('#t-feed .t-r[data-id]')));
const nextPaint = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const drawer = (page) => page.locator(DRAWER);
const json = (value) => JSON.stringify(value) ?? '(missing)';
const normalize = (text) => text.trim().replace(/\s+/g, ' ');

async function readyView(page, view) {
  await page.locator(view.container).waitFor({ state: 'visible' });
  await waitForData(page);
  if (view.path === '/leaderboard') {
    await page.locator('#b-tbl tbody tr[data-key]').first().waitFor({ state: 'visible' });
  } else if (view.path === '/report') {
    // Report loads both tiers itself. Take the baseline after the hydrated render.
    await page.waitForFunction(() => window.BL?.detailsLoaded && window.BL?.historyLoaded);
    await page.locator('#news-list .entry').first().waitFor({ state: 'visible' });
  }
}

async function visibleThemeName(page, cdp, container) {
  const selector = `${container} .t-theme`;
  const button = page.locator(selector);
  const visible = normalize(await button.innerText());
  // Read Chromium's computed accessible name, not the raw aria-label attribute.
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
  const name = normalize(nodes[0]?.name?.value ?? '');
  assert(visible && name.toLowerCase().includes(visible.toLowerCase()),
    `theme button accessible name containing visible text ${json(visible)}`, json(name));
}

async function chooseRow(page, newsOnly = false) {
  // Prefer the precise baseline row if it is still live. Otherwise use a current
  // hit, or a feed row if the snapshot is too old to have current hits.
  for (const panel of ['#t-hit', '#t-feed']) {
    const ids = await page.locator(`${panel} .t-r[data-id]:visible`).evaluateAll((rows, newsOnly) => {
      // Some news rows intentionally open a linked crypto incident instead.
      const news = newsOnly && new Set(BL.D.news.filter((item) => !item.crypto).map((item) => item.eid));
      return rows.map((row) => row.dataset.id).filter((id) => news ? news.has(id) : !/^a-/.test(id));
    }, newsOnly);
    const id = ids.includes(BASELINE_ID) ? BASELINE_ID : ids[0];
    if (id) return { id, row: page.locator(`${panel} .t-r[data-id=${json(id)}]:visible`).first() };
  }
  throw new Error(`expected a visible Terminal row with a ${newsOnly ? 'news' : 'live incident'} ID; observed none`);
}

async function openDrawer(page, row) {
  await row.click();
  await drawer(page).waitFor({ state: 'visible' });
  const title = page.locator(DRAWER_TITLE);
  await title.waitFor({ state: 'visible' });
  return normalize(await title.innerText());
}

function firstDifference(expected, observed, path = '$') {
  if (Object.is(expected, observed)) return;
  if (!expected || !observed || typeof expected !== 'object' || typeof observed !== 'object' ||
      Array.isArray(expected) !== Array.isArray(observed)) return { path, expected, observed };
  if (Array.isArray(expected) && expected.length !== observed.length) {
    return { path: `${path}.length`, expected: expected.length, observed: observed.length };
  }
  for (const key of new Set([...Object.keys(expected), ...Object.keys(observed)])) {
    const next = Array.isArray(expected) ? `${path}[${key}]` : `${path}[${json(key)}]`;
    if (!Object.hasOwn(expected, key) || !Object.hasOwn(observed, key)) {
      return { path: next, expected: expected[key], observed: observed[key] };
    }
    const diff = firstDifference(expected[key], observed[key], next);
    if (diff) return diff;
  }
}

async function recordFocus(page, selector) {
  const state = await page.evaluate((sel) => {
    const active = document.activeElement;
    return { ok: document.querySelector(sel)?.contains(active), active: active?.outerHTML.split('>')[0] + '>' };
  }, selector);
  assert(state.ok, `focus in ${selector}`, state.active);
}

async function skipLink(page, view) {
  await page.locator('a.skip').focus();
  await page.keyboard.press('Enter');
  await recordFocus(page, view.skip);
}

async function hiddenTabStops(page) {
  await page.locator('a.skip').focus();
  const limit = await page.locator('*').count() + 2;
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => {
      const active = document.activeElement;
      return { hidden: active?.closest('[aria-hidden="true"]') ? active.outerHTML.split('>')[0] + '>' : null,
        wrapped: active?.matches('a.skip') };
    });
    assert(!focus.hidden, 'no Tab focus inside an aria-hidden="true" subtree in Terminal', focus.hidden);
    if (focus.wrapped) return;
  }
  assert(false, 'Tab to complete one traversal of the Terminal document', `no wrap after ${limit} Tabs`);
}

async function checkRoute(page, path, token) {
  // Actual Back is asynchronous. Avoid timing out with no diagnostic of the
  // observed path, canonical, or document identity.
  await page.waitForURL((url) => url.pathname === path, { waitUntil: 'load' }).catch(() => {});
  const actual = await page.evaluate(() => ({ path: location.pathname,
    canonical: document.querySelector('link[rel="canonical"]')?.href,
    token: window.__verifyNavDocument }));
  assert(actual.path === path, `pathname ${path}`, actual.path);
  assert(actual.canonical && URL.parse(actual.canonical)?.pathname === path && !new URL(actual.canonical).search && !new URL(actual.canonical).hash,
    `canonical with path ${path} and no query or fragment`, json(actual.canonical));
  assert(actual.token === token, `navigation to ${path} without a full reload`, 'new document');
}

async function main(base, timeout) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
  const rows = [], failures = [];
  console.log(`Browser gate: axe-core ${axe.version}, Chromium ${browser.version()}, ${base.origin}`);

  async function run(profile, label, fn, row) {
    const context = await browser.newContext(profile);
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    page.setDefaultNavigationTimeout(20_000);
    const start = failures.length;
    const fail = (name, message) => failures.push(`${label} — ${name}: ${message}`);
    const check = async (name, action) => {
      try { await action(); }
      catch (error) { fail(name, error.message); }
    };
    let monitor;
    try {
      monitor = await observe(context, page, base);
      await fn(page, monitor, check, fail);
      await nextPaint(page); // Let queued CSP events be delivered before reading the log.
    } catch (error) {
      fail('State setup or execution', error.message);
    } finally {
      // Don't close a context while its own beacon or lazy GET is still in
      // flight. Cross-origin data polling does not hold up this check.
      if (monitor) await check('Same-origin requests finish', async () => {
        const deadline = Date.now() + timeout;
        while (monitor.pending.size && Date.now() < deadline) await delay(50);
        assert(!monitor.pending.size, 'all same-origin requests to finish',
          `still pending: ${[...monitor.pending].map((request) => request.url()).join(', ')}`);
      });
      for (const error of monitor?.errors ?? []) fail('Browser health', error);
      await context.close();
    }
    const passed = start === failures.length;
    if (row) row.Result = passed ? 'PASS' : 'FAIL';
    for (const failure of failures.slice(start)) console.error(failure);
  }

  try {
    for (const { width, height, ...emulation } of PROFILES) {
      const size = `${width}×${height}`;
      const profile = { ...emulation, viewport: { width, height }, colorScheme: 'light' };
      for (const [state, view] of Object.entries(VIEWS)) {
        for (const theme of ['light', 'dark']) {
          const row = { Viewport: size, Theme: theme, State: state, Axe: 'not run', Result: 'FAIL' };
          rows.push(row);
          await run(profile, `${size} ${theme} ${state}`, async (page, monitor, check, fail) => {
            const started = Date.now();
            await load(page, base, view.path);
            await readyView(page, view);
            if (state === 'Terminal' && theme === 'light') {
              await check('Cold Terminal transfer', async () => {
                await delay(Math.max(0, COLD_MS - (Date.now() - started)));
                const paths = monitor.requests.filter((url) => url.origin === base.origin).map((url) => url.pathname);
                const unwanted = monitor.requests.filter((url) =>
                  (url.origin === base.origin && DEFERRED.includes(url.pathname)) ||
                  ['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname));
                assert(paths.includes('/data-hot.json') && !unwanted.length,
                  'a /data-hot.json request and no Details, History, archive or Google Fonts requests',
                  `/data-hot.json ${paths.includes('/data-hot.json') ? 'requested' : 'not requested'}; forbidden requests ${json([...new Set(unwanted.map(String))])}`);
              });
            }
            const themeButton = page.locator(`${view.container} .t-theme`);
            if (theme === 'dark') {
              await themeButton.click();
              const actual = await page.locator('html').getAttribute('data-theme');
              assert(actual === 'dark', 'dark theme after clicking the visible theme button', json(actual));
              await check('Dark theme label in name', () => visibleThemeName(page, monitor.cdp, view.container));
            } else {
              const actual = await page.locator('html').getAttribute('data-theme');
              assert(actual !== 'dark', 'initial light theme', json(actual));
            }
            if (state === 'Incident drawer') {
              const { row: opener } = await chooseRow(page);
              await openDrawer(page, opener);
              await check('Drawer details hydration', () => page.waitForFunction(() => window.BL?.detailsLoaded));
              await drawer(page).evaluate((element) => Promise.all(element.getAnimations()
                .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
                .map((animation) => animation.finished.catch(() => {}))));
            } else if (state === 'Command palette') {
              await page.locator('#t-q').focus();
              await page.keyboard.press('Control+k');
              await page.locator('dialog#pal[open]').waitFor({ state: 'visible' });
              assert(!(await page.locator('#pal-q').inputValue()), 'empty command palette query', json(await page.locator('#pal-q').inputValue()));
            }
            await check('Axe audit', async () => {
              await page.evaluate(() => document.fonts.ready.then(() => undefined));
              // CDP executes the library in the page realm without adding a script
              // tag or changing the site's content security policy.
              await page.evaluate(axe.source);
              const result = await page.evaluate(async (tags) => {
                const { violations } = await window.axe.run(document, { runOnly: { type: 'tag', values: tags } });
                return violations.filter(({ impact }) => impact === 'serious' || impact === 'critical')
                  .map(({ id, impact, nodes }) => ({ id, impact, count: nodes.length, sample: nodes[0]?.target.join(' > ') }));
              }, TAGS);
              row.Axe = result.length ? result.map(({ id, count }) => `${id} (${count})`).join(', ') : 'PASS';
              for (const { id, impact, count, sample } of result) fail('Axe audit', `${id} (${impact}), ${count} node(s); sample selector: ${sample}`);
            });
            if (view.skip) await check('Skip link focus', () => skipLink(page, view));
            if (state === 'Terminal') await check('Terminal Tab order', () => hiddenTabStops(page));
            if (state === 'Report') await check('Hydrated Report news links', async () => {
              const news = page.locator('#news-list');
              assert(await news.locator('a').count(), 'anchors in the hydrated news list', 'none');
              const missing = await news.locator('a:not([href])').evaluateAll((links) => links.map((a) => a.outerHTML));
              assert(!missing.length, 'all #news-list anchors to have an href', `${missing.length} missing href; sample ${missing[0]}`);
            });
          }, row);
        }
      }
      await run(profile, `${size} keyboard drawer`, async (page, _monitor, check) => {
        await load(page, base, '/');
        await waitForData(page);
        const { row } = await chooseRow(page);
        await row.focus();
        await check('Enter opens and keeps drawer open', async () => {
          await page.keyboard.press('Enter');
          await nextPaint(page);
          assert(await drawer(page).isVisible(), 'drawer still open after Enter keyup', 'drawer closed');
          await page.locator(DRAWER_TITLE).waitFor({ state: 'visible' });
          await page.waitForFunction(() => window.BL?.detailsLoaded);
          assert(await drawer(page).isVisible(), 'drawer still open after its details loaded', 'drawer closed');
        });
        await check('Escape closes drawer and restores row focus', async () => {
          if (!(await drawer(page).isVisible())) { await row.focus(); await openDrawer(page, row); }
          await page.keyboard.press('Escape');
          await nextPaint(page);
          assert(!(await drawer(page).isVisible()), 'drawer closed after Escape', 'drawer still open');
          const focus = await row.evaluate((el) => ({ restored: document.activeElement === el,
            actual: document.activeElement?.outerHTML.split('>')[0] + '>' }));
          assert(focus.restored, 'focus returned to the opening Terminal row', focus.actual);
        });
      });
    }

    const desktop = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.25, colorScheme: 'light' };
    await run(desktop, 'Split data parity', async (page, _monitor, check) => {
      await load(page, base, '/');
      await waitForData(page);
      const result = await page.evaluate(async () => {
        const details = await BL.ensureDetails();
        const history = await BL.ensureHistory();
        const { split, hot_days, registry_aliases, ...merged } = BL.D;
        const response = await fetch('/data.json', { cache: 'no-cache' });
        return { details, history, merged, status: response.status, full: response.ok ? await response.json() : null };
      });
      await check('Tier hydration', () => assert(result.details && result.history,
        'Details and History to load', `Details=${result.details}, History=${result.history}`));
      await check('Merged BL.D deep-equals /data.json', () => {
        assert(result.status === 200, 'HTTP 200 for /data.json', result.status);
        const diff = firstDifference(result.full, result.merged);
        assert(!diff, diff && `first differing path ${diff.path} = ${json(diff.expected)}`, diff && json(diff.observed));
      });
    });
    for (const path of ['/leaderboard', '/report']) {
      await run(desktop, `Client navigation ${path}`, async (page, _monitor, check) => {
        await load(page, base, '/');
        await waitForData(page);
        const token = await page.evaluate(() => window.__verifyNavDocument = Math.random());
        await check('Initial canonical', () => checkRoute(page, '/', token));
        await page.locator(`#term .t-views a[href="${path}"]`).click();
        await check(`Navigation to ${path}`, () => checkRoute(page, path, token));
        // Let view-triggered data requests finish before going back.
        if (new URL(page.url()).pathname === path) await readyView(page, Object.values(VIEWS).find((view) => view.path === path));
        await check('Back returns to Terminal', async () => {
          await page.goBack({ waitUntil: 'load' });
          await checkRoute(page, '/', token);
        });
      });
    }
    await run(desktop, 'Legacy #leaderboard', async (page, _monitor, check) => {
      await load(page, base, '/#leaderboard');
      await waitForData(page);
      await check('Legacy Leaderboard migration', () => {
        const observed = new URL(page.url()).pathname;
        assert(observed === '/leaderboard', 'pathname /leaderboard', observed);
      });
    });
    await run(desktop, 'Legacy #e-a-5', async (page, _monitor, check) => {
      await load(page, base, '/#e-a-5');
      await waitForData(page);
      await check('Archive hash does not become a standalone path', () => {
        const observed = new URL(page.url()).pathname;
        assert(observed !== '/incidents/a-5', 'pathname other than /incidents/a-5', observed);
      });
    });
    let liveRecord;
    await run(desktop, 'Live news record', async (page, _monitor, check) => {
      await load(page, base, '/');
      await waitForData(page);
      const { id, row } = await chooseRow(page, true);
      const source = normalize(await page.evaluate((id) => BL.D.news.find((record) => record.eid === id)?.source ?? '', id));
      const path = `/incidents/${encodeURIComponent(id)}`;
      const title = await openDrawer(page, row);
      liveRecord = { path, title };
      await check('Opening a live record sets its incident path', () => {
        const observed = new URL(page.url()).pathname;
        assert(observed === path, `pathname ${path}`, observed);
      });
      await check('News drawer has a source URL after details load', async () => {
        await page.waitForFunction(() => window.BL?.detailsLoaded);
        const links = await page.locator(`${DRAWER} .t-il a`).evaluateAll((anchors) => anchors.map((a) => [a.textContent, a.getAttribute('href')]));
        const href = links.find(([label]) => normalize(label) === source)?.[1];
        assert(source && href && /^https?:\/\//i.test(href) && URL.canParse(href),
          `a non-empty HTTP(S) href on the ${json(source)} source link`, json(href));
      });
    });
    await run(desktop, 'Live news record', async (page, _monitor, check) => {
      await check('Direct incident URL returns 200 and opens the same record', async () => {
        assert(liveRecord, 'a live record selected for direct navigation', 'no record was opened in Terminal');
        const { path, title } = liveRecord;
        await load(page, base, path);
        const observedPath = new URL(page.url()).pathname;
        assert(observedPath === path, `direct load at pathname ${path}`, observedPath);
        // Live records can be opened in the SPA drawer or served as a prerendered
        // record. In either representation require the exact incident headline.
        const titleLocator = page.locator(`${DRAWER_TITLE}:visible, main h1:visible`).first();
        await titleLocator.waitFor({ state: 'visible' });
        const directTitle = normalize(await titleLocator.innerText());
        assert(directTitle === title, `visible incident headline ${json(title)}`, json(directTitle));
      });
    });
  } finally {
    await browser.close();
    console.table(rows);
    console.log(`${rows.filter(({ Result }) => Result === 'PASS').length}/${rows.length} browser states passed; ${failures.length} failed assertion(s) or axe rule(s).`);
    if (failures.length) process.exitCode = 1;
  }
}

try {
  const config = options();
  if (config) await main(config.base, config.timeout);
} catch (error) {
  console.error(`Browser gate: ${error.message}`);
  process.exitCode = 1;
}
