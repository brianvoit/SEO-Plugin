// Tests the four housekeeping changes that carry real logic:
//   1. favicon rows: per-icon download + a linked-file open glyph
//   2. the Drive folder browser's filter box
//   3. robots.txt URL linkification (content.js)
//   4. Search tab: regex-driven chart + weekly bucketing on long ranges
//
// The DOM assumption behind (3) was checked against a real browser before it
// was written: a text/plain response is rendered as <body><pre>…</pre></body>
// with document.contentType === 'text/plain'. That is what the fixture models.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { ROOT } from './helpers.mjs';

const gsc       = await readFile(path.join(ROOT, 'popup-gsc.js'), 'utf8');
const content   = await readFile(path.join(ROOT, 'content.js'), 'utf8');
const inspector = await readFile(path.join(ROOT, 'popup-inspector.js'), 'utf8');
const clients   = await readFile(path.join(ROOT, 'popup-clients.js'), 'utf8');
const html      = await readFile(path.join(ROOT, 'popup.html'), 'utf8');
const css       = await readFile(path.join(ROOT, 'popup.css'), 'utf8');

const slice = (src, start, end) => {
  const a = src.indexOf(start);
  const b = src.indexOf(end);
  assert.ok(a !== -1, `could not find "${start}" — update the slice markers`);
  assert.ok(b > a, `could not find "${end}" after it`);
  return src.slice(a, b);
};

// ─── 4b. Weekly bucketing on long ranges ──────────────────────────────────────

describe('weekly bucketing for 12M and 16M', () => {
  const gscBucketWeekly = new Function(
    `${slice(gsc, 'function gscBucketWeekly(', 'function renderCombinedChart(')}
     return gscBucketWeekly;`
  )();

  /** n consecutive days from 2026-01-01, each with the given per-day values. */
  const days = (n, fn = () => ({ clicks: 1, impressions: 10, position: 5 })) =>
    Array.from({ length: n }, (_, i) => {
      const d = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
      const v = fn(i);
      return { date: d, ctr: v.impressions ? v.clicks / v.impressions : 0, ...v };
    });

  test('365 days collapse to 53 points, not 365', () => {
    // The whole reason this exists: 365 points across ~320px is sub-pixel.
    assert.equal(gscBucketWeekly(days(365)).length, 53);
  });

  test('a partial final week is kept, not dropped', () => {
    // 365 = 52 weeks + 1 day. Dropping the remainder would silently lose data.
    const out = gscBucketWeekly(days(365));
    assert.equal(out[out.length - 1].dates.length, 1);
  });

  test('clicks and impressions are summed', () => {
    const [w] = gscBucketWeekly(days(7, () => ({ clicks: 2, impressions: 20, position: 4 })));
    assert.equal(w.clicks, 14);
    assert.equal(w.impressions, 140);
  });

  test('position is impression-weighted, not a plain mean', () => {
    // One day at position 1 with 1000 impressions and six at position 50 with
    // 1 each is a good week, and a plain mean would report it as a bad one.
    const [w] = gscBucketWeekly(days(7, (i) =>
      i === 0 ? { clicks: 0, impressions: 1000, position: 1 } : { clicks: 0, impressions: 1, position: 50 }));
    assert.ok(w.position < 2, `impression-weighted position should stay near 1, got ${w.position}`);
    const plainMean = (1 + 50 * 6) / 7;
    assert.ok(Math.abs(w.position - plainMean) > 30, 'this looks like a plain mean');
  });

  test('CTR is recomputed from the totals rather than averaged', () => {
    const [w] = gscBucketWeekly(days(7, (i) =>
      i === 0 ? { clicks: 100, impressions: 100 } : { clicks: 0, impressions: 900 }));
    assert.equal(w.clicks, 100);
    assert.equal(w.impressions, 5500);
    assert.ok(Math.abs(w.ctr - 100 / 5500) < 1e-9);
  });

  test('a week with no impressions reports zero, not NaN', () => {
    // NaN would render as a broken SVG path, not as an empty one.
    const [w] = gscBucketWeekly(days(7, () => ({ clicks: 0, impressions: 0, position: 0 })));
    assert.equal(w.ctr, 0);
    assert.equal(w.position, 0);
  });

  test('each bucket carries every date it covers, for annotation lookup', () => {
    const [w] = gscBucketWeekly(days(14));
    assert.equal(w.dates.length, 7);
    assert.equal(w.date, w.dates[0]);
    assert.equal(w.weekEnd, w.dates[6]);
  });

  test('the threshold is 365, so 12M and 16M bucket and 3M/6M do not', () => {
    const min = Number(/GSC_WEEKLY_MIN_RANGE = (\d+)/.exec(gsc)[1]);
    assert.equal(min, 365);
    [365, 480].forEach(r => assert.ok(r >= min, `${r} should bucket`));
    [28, 90, 180].forEach(r => assert.ok(r < min, `${r} should stay daily`));
  });

  test('renderGscCharts applies it only above the threshold', () => {
    assert.match(gsc, /Number\(range\) >= GSC_WEEKLY_MIN_RANGE \? gscBucketWeekly\(daily\) : daily/);
  });

  test('the tooltip shows a range for a bucket, not just its first day', () => {
    // Showing "Aug 3" for Aug 3–9 would overstate what the point represents.
    assert.match(gsc, /d\.weekEnd\s*\n?\s*\? `\$\{formatDateLong\(d\.date, showYear\)\} – \$\{formatDateLong\(d\.weekEnd, showYear\)\}`/);
  });
});

// ─── 4a. The regex box drives the chart ───────────────────────────────────────

describe('the query search filters the chart', () => {
  /** Runs the real gscVisibleQueries against controllable module state. */
  function boot({ queries, search = '', exclude = false, intent = null, hideBranded = false, pattern = '' }) {
    const body = slice(gsc, 'function gscVisibleQueries(', '// Chart for the regex box');
    return new Function('cfg', `
      let _gscQueries = cfg.queries;
      let _gscQuerySearch = cfg.search;
      let _gscQuerySearchExclude = cfg.exclude;
      let _gscIntentFilter = cfg.intent;
      let gscHideBranded = cfg.hideBranded;
      const gscBrandedPattern = () => cfg.pattern;
      const isQueryBranded = (q, p) => !!p && new RegExp(p, 'i').test(q);
      const intentOf = (q) => cfg.intents ? cfg.intents[q] : null;
      ${body}
      return gscVisibleQueries().map(q => q.query);
    `)({ queries, search, exclude, intent, hideBranded, pattern, intents: arguments[0] && arguments[0].intents });
  }

  const Q = ['red shoes', 'blue shoes', 'red hats'].map(q => ({ query: q }));

  test('with no search, everything is visible', () => {
    assert.deepEqual(boot({ queries: Q }), ['red shoes', 'blue shoes', 'red hats']);
  });

  test('a match regex narrows to what the table shows', () => {
    assert.deepEqual(boot({ queries: Q, search: 'shoes' }), ['red shoes', 'blue shoes']);
  });

  test('exclude mode inverts it, matching the Excl. toggle', () => {
    assert.deepEqual(boot({ queries: Q, search: 'shoes', exclude: true }), ['red hats']);
  });

  test('an invalid regex is treated as no filter, exactly as the table does', () => {
    // Mid-typing "(" must not blank the chart.
    assert.deepEqual(boot({ queries: Q, search: '(' }), ['red shoes', 'blue shoes', 'red hats']);
  });

  test('the branded filter still applies underneath', () => {
    assert.deepEqual(boot({ queries: Q, hideBranded: true, pattern: 'red' }), ['blue shoes']);
  });

  test('branded and regex compose', () => {
    assert.deepEqual(boot({ queries: Q, search: 'shoes', hideBranded: true, pattern: 'red' }), ['blue shoes']);
  });

  test('a clicked query still outranks the regex', () => {
    // Precedence is explicit, so a selected single query is never overridden
    // by whatever happens to be in the search box.
    const fn = slice(gsc, 'function refreshGscChartForState()', 'function selectGscQuery(');
    const order = ['_gscSelectedQuery', '_gscQuerySearch', '_gscIntentFilter']
      .map(k => fn.indexOf(k));
    assert.ok(order[0] < order[1] && order[1] < order[2], 'precedence is query > search > intent');
  });

  test('the chart call is debounced, not fired per keystroke', () => {
    // Each one is a live GSC request.
    assert.match(gsc, /function scheduleGscSearchChart\(\)[\s\S]*?clearTimeout\(_gscSearchChartTimer\)/);
    assert.match(gsc, /_gscSearchChartTimer = setTimeout\(/);
  });

  test('a stale response cannot overwrite a newer one', () => {
    // "s"/"sh"/"sho"/"shoe" can land in any order.
    const fn = slice(gsc, 'async function applyGscSearchChartFilter()', 'function scheduleGscSearchChart()');
    assert.match(fn, /const token = \+\+_gscSearchChartToken/);
    assert.match(fn, /if \(token !== _gscSearchChartToken/);
  });

  test('the filter bar says which direction the regex runs', () => {
    assert.match(gsc, /'Chart excludes:' : 'Chart matches:'/);
  });
});

// ─── 3. robots.txt linkification ──────────────────────────────────────────────

describe('robots.txt URLs become links', () => {
  function run(text, { contentType = 'text/plain', pathname = '/robots.txt' } = {}) {
    // runScripts is required for window.eval to run inside the window's realm —
    // without it the slice executes in Node's, where `document` is undefined.
    const dom = new JSDOM('<!doctype html><html><body></body></html>',
      { url: `https://example.com${pathname}`, runScripts: 'outside-only' });
    const w = dom.window;
    const pre = w.document.createElement('pre');
    pre.textContent = text;
    w.document.body.appendChild(pre);
    Object.defineProperty(w.document, 'contentType', { value: contentType, configurable: true });
    w.eval(`${slice(content, 'const ROBOTS_URL_RE', '} // end idempotency guard')}
            linkifyRobotsTxt();`);
    return { doc: w.document, pre: w.document.querySelector('pre') };
  }

  const ROBOTS = 'User-agent: *\nDisallow: /admin/\n\nSitemap: https://example.com/sitemap.xml\nSitemap: https://example.com/sitemap-news.xml\n';

  test('every sitemap URL becomes an anchor', () => {
    const { pre } = run(ROBOTS);
    const hrefs = [...pre.querySelectorAll('a')].map(a => a.getAttribute('href'));
    assert.deepEqual(hrefs, ['https://example.com/sitemap.xml', 'https://example.com/sitemap-news.xml']);
  });

  test('the visible text is unchanged — only the markup gained links', () => {
    const { pre } = run(ROBOTS);
    assert.equal(pre.textContent, ROBOTS);
  });

  test('directives and comments around the URL survive intact', () => {
    const { pre } = run(ROBOTS);
    assert.ok(pre.textContent.includes('User-agent: *'));
    assert.ok(pre.textContent.includes('Disallow: /admin/'));
  });

  test('Allow/Disallow patterns are NOT linked', () => {
    // `/*.php$` is a match pattern, not a URL; linking it would 404.
    const { pre } = run('User-agent: *\nDisallow: /*.php$\nDisallow: /*?sort=\n');
    assert.equal(pre.querySelectorAll('a').length, 0);
  });

  test('trailing punctuation is left outside the link', () => {
    const { pre } = run('# see https://example.com/policy.\n');
    assert.equal(pre.querySelector('a').getAttribute('href'), 'https://example.com/policy');
  });

  test('links carry noopener noreferrer', () => {
    const { pre } = run(ROBOTS);
    assert.equal(pre.querySelector('a').getAttribute('rel'), 'noopener noreferrer');
  });

  test('an HTML page that happens to live at /robots.txt is untouched', () => {
    // Somebody's real page must never be rewritten.
    const { pre } = run(ROBOTS, { contentType: 'text/html' });
    assert.equal(pre.querySelectorAll('a').length, 0);
  });

  test('a plain-text file that is not robots.txt is untouched', () => {
    const { pre } = run(ROBOTS, { pathname: '/notes.txt' });
    assert.equal(pre.querySelectorAll('a').length, 0);
  });

  test('a robots.txt with no URLs is left completely alone', () => {
    const { pre } = run('User-agent: *\nDisallow:\n');
    assert.equal(pre.querySelectorAll('a').length, 0);
  });

  test('running twice does not double-wrap', () => {
    // The content script is idempotency-guarded, but a re-injection shouldn't
    // nest anchors even so.
    const { doc, pre } = run(ROBOTS);
    assert.equal(pre.dataset.seoLinkified, '1');
    assert.equal(doc.querySelectorAll('a a').length, 0);
  });
});

// ─── 1. Favicon row actions ───────────────────────────────────────────────────

describe('favicon panel: download and open', () => {
  test('every declared icon row gets a download button', () => {
    assert.match(inspector, /if \(i\.href\) actions\.appendChild\(faviconDownloadBtn\(i\.href\)\)/);
  });

  test('the download button sits beside the status chip, not replacing it', () => {
    const block = slice(inspector, "actions.className = 'favicon-row-actions'", 'row.append(tag, hrefEl, actions)');
    assert.match(block, /faviconIconChip\(live, i\.href\)/);
    assert.match(block, /faviconDownloadBtn/);
  });

  test('download goes through blob + anchor — there is no downloads permission', async () => {
    const manifest = JSON.parse(await readFile(path.join(ROOT, 'manifest.base.json'), 'utf8'));
    assert.ok(!manifest.permissions.includes('downloads'), 'if this is added, simplify faviconDownload');
    const fn = slice(inspector, 'async function faviconDownload(', 'function faviconDownloadBtn(');
    assert.match(fn, /URL\.createObjectURL/);
    assert.match(fn, /a\.download = name/);
  });

  test('a failed download reports on the button instead of doing nothing', () => {
    const fn = slice(inspector, 'async function faviconDownload(', 'function faviconDownloadBtn(');
    assert.match(fn, /Download failed/);
    assert.match(fn, /btn\.disabled = false/);
  });

  test('the filename comes from the icon URL, not a generic default', () => {
    const fn = slice(inspector, 'async function faviconDownload(', 'function faviconDownloadBtn(');
    assert.match(fn, /path\.split\('\/'\)\.pop\(\)/);
  });

  test('clicking download does not also trigger the row (which opens a tab)', () => {
    assert.match(inspector, /btn\.addEventListener\('click', \(e\) => \{ e\.stopPropagation\(\); faviconDownload/);
  });

  test('the manifest section header carries an open glyph', () => {
    assert.match(inspector, /groupName === 'WEB APP MANIFEST' && fav && fav\.manifestHref/);
    assert.match(inspector, /faviconOpenBtn\(fav\.manifestHref/);
  });

  test('both buttons are glyph-only but still have accessible names', () => {
    ['faviconDownloadBtn', 'faviconOpenBtn'].forEach(fn => {
      const body = inspector.slice(inspector.indexOf(`function ${fn}(`));
      assert.match(body.slice(0, 700), /labelIconButton\(btn,/, `${fn} has no accessible name`);
      assert.doesNotMatch(body.slice(0, 700), /btn\.textContent =/, `${fn} should be glyph-only`);
    });
  });

  test('the header button is pushed flush right', () => {
    assert.match(css, /\.field-header > \.favicon-row-btn \{ margin-left: auto; \}/);
  });
});

// ─── 2. Drive folder browser filter ───────────────────────────────────────────

describe('the Drive folder browser filter', () => {
  const render = new Function('cfg', `
    let _driveBrowserItems = cfg.items;
    let _driveBrowserFilter = cfg.filter;
    const rows = [];
    const listEl = { replaceChildren: () => rows.splice(0), appendChild: (r) => rows.push(r) };
    const emptyEl = { textContent: '', hidden: null, classList: { toggle: (c, on) => { emptyEl.hidden = on; } } };
    const document = { getElementById: (id) => id === 'drive-browser-list' ? listEl : emptyEl };
    const driveBrowserRow = (id, name) => ({ id, name });
    ${slice(clients, 'function renderDriveBrowserItems()', 'async function driveBrowserLoad()')}
    renderDriveBrowserItems();
    return { rows, emptyText: emptyEl.textContent, emptyHidden: emptyEl.hidden };
  `);

  const items = ['Acme Corp', 'Beta Ltd', 'acme archive'].map((name, i) => ({ id: `f${i}`, name, isDrive: false }));

  test('an empty filter shows everything', () => {
    assert.equal(render({ items, filter: '' }).rows.length, 3);
  });

  test('typing narrows the list', () => {
    assert.deepEqual(render({ items, filter: 'beta' }).rows.map(r => r.name), ['Beta Ltd']);
  });

  test('matching is case-insensitive and matches anywhere in the name', () => {
    assert.deepEqual(render({ items, filter: 'ACME' }).rows.map(r => r.name), ['Acme Corp', 'acme archive']);
  });

  test('whitespace-only input is not treated as a filter', () => {
    assert.equal(render({ items, filter: '   ' }).rows.length, 3);
  });

  test('a filter matching nothing says so, distinctly from an empty folder', () => {
    // "No folders here" would be a lie when the folder has three.
    const out = render({ items, filter: 'zzz' });
    assert.equal(out.rows.length, 0);
    assert.match(out.emptyText, /matches/);
    assert.equal(out.emptyHidden, false);
  });

  test('a genuinely empty folder keeps the original message', () => {
    const out = render({ items: [], filter: '' });
    assert.equal(out.emptyText, 'No folders here.');
  });

  test('filtering never refetches — it only re-renders', () => {
    const handler = slice(clients, "getElementById('drive-browser-filter').addEventListener", '\n});');
    assert.match(handler, /renderDriveBrowserItems\(\)/);
    assert.doesNotMatch(handler, /sendMessageWithTimeout|driveBrowserLoad/);
  });

  test('descending into a folder clears the filter', () => {
    const load = slice(clients, 'async function driveBrowserLoad()', "const DRIVE_BROWSER_MAX_PAGES");
    assert.match(load, /_driveBrowserFilter = ''/);
    assert.match(load, /filterInput\.value = ''/);
  });

  test('the input exists and is labelled', () => {
    assert.ok(html.includes('id="drive-browser-filter"'));
    const tag = html.slice(html.indexOf('id="drive-browser-filter"') - 60, html.indexOf('id="drive-browser-filter"') + 320);
    assert.match(tag, /aria-label=/);
  });
});
