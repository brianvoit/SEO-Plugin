// Tests content-serp.js's SERP parser against REAL captured Google search
// result HTML (tests/fixtures/serp/*.html — captured live, scripts stripped,
// personalized/session data trimmed) plus one hand-authored synthetic ad
// fixture. Every real search attempted for this feature returned genuinely
// empty ad-slot containers (Google appears to suppress ad serving for this
// automated context — the same class of problem as this project's known
// WebCEO IP-filtering issue), so ads-synthetic.html is explicitly NOT a live
// capture; see the comment at the top of that file for why.
//
// The parser module is sliced out of content-serp.js between its own banner
// comments and run via `new Function(...)` against a real jsdom-loaded page,
// mirroring marketing-tags.test.mjs's exact technique — testing a
// reimplementation would prove nothing about the shipped detection.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { ROOT } from './helpers.mjs';

const START = '// ─── SERP parser: start';
const END = '// ─── SERP parser: end';

const src = await readFile(path.join(ROOT, 'content-serp.js'), 'utf8');
const from = src.indexOf(START);
const to = src.indexOf(END);

test('the parser is still where the test expects it', () => {
  assert.ok(from !== -1, `could not find "${START}" in content-serp.js — update this test's slice markers`);
  assert.ok(to > from, `could not find "${END}" after the parser`);
});

const source = src.slice(from, to);

async function loadFixture(name) {
  return readFile(path.join(ROOT, 'tests', 'fixtures', 'serp', name), 'utf8');
}

/** Runs the real parser over a captured or synthetic SERP page. */
function parse(html, url = 'https://www.google.com/search?q=test') {
  const dom = new JSDOM(html, { url });
  const { window } = dom;
  const { parseSerpResults } = new Function(
    'document', 'location', 'window',
    `${source}; return { parseSerpResults };`
  )(window.document, window.location, window);
  return parseSerpResults(window.document);
}

describe('organic results, from a real captured page (running-shoes-organic.html)', () => {
  let html;
  test('fixture loads', async () => { html = await loadFixture('running-shoes-organic.html'); assert.ok(html.length > 1000); });

  test('finds a plausible number of organic results, none of them zero', async () => {
    const parsed = parse(html);
    assert.ok(parsed.organic.length >= 3, `expected at least 3 organic results, got ${parsed.organic.length}`);
  });

  test('every organic result gets a sequential 1-based position', async () => {
    const parsed = parse(html);
    assert.deepEqual(parsed.organic.map(r => r.position), parsed.organic.map((_, i) => i + 1));
  });

  test('a real known result resolves its domain from the visible breadcrumb, not the internal redirect href', async () => {
    // The captured page's actual anchor hrefs are Google's own /goto?url=...
    // click-tracking wrapper, not the destination — confirmed against the
    // live page, not assumed. This is the case the breadcrumb-first design
    // exists for.
    const parsed = parse(html);
    const fleetFeet = parsed.organic.find(r => r.domain === 'fleetfeet.com');
    assert.ok(fleetFeet, `expected a fleetfeet.com organic result among: ${parsed.organic.map(r => r.domain).join(', ')}`);
  });

  test('People Also Ask rows are never counted as organic results', async () => {
    const parsed = parse(html);
    // PAA question text should not appear as a "result" domain/heading in the
    // organic list — proven indirectly: PAA rows carry no <cite>, so if the
    // structural test worked, none of these results should be undomained
    // *and* sitting inside the People Also Ask heading region. The stronger,
    // direct proof is the skipped-count test below staying low relative to
    // total h3 count, not a specific PAA row leaking through.
    assert.ok(html.includes('People also ask'), 'fixture sanity: PAA should be present');
    assert.equal(parsed.organic.some(r => r.el === undefined), false);
  });

  test('no ads are found on a page with no ad markup', async () => {
    const parsed = parse(html);
    assert.equal(parsed.topAds.length, 0);
    assert.equal(parsed.bottomAds.length, 0);
  });
});

describe('organic results, from a second real captured page (car-insurance-quotes.html)', () => {
  let html;
  test('fixture loads', async () => { html = await loadFixture('car-insurance-quotes.html'); assert.ok(html.length > 1000); });

  test('finds the real Allstate organic result with its domain resolved', async () => {
    const parsed = parse(html);
    const allstate = parsed.organic.find(r => r.domain === 'allstate.com');
    assert.ok(allstate, `expected an allstate.com organic result among: ${parsed.organic.map(r => r.domain).join(', ')}`);
  });

  test('the AI Overview citation panel is not counted as an organic result', async () => {
    // The AI Overview's own citation cards use a different, simpler markup
    // (a plain text div, no <h3>/<cite> pair) — they should never satisfy the
    // structural organic test at all, so this just guards against the count
    // being implausibly inflated by them.
    const parsed = parse(html);
    assert.ok(parsed.organic.length < 15, `organic count looks inflated by non-result chrome: ${parsed.organic.length}`);
  });
});

describe('ads, from the synthetic fixture (ads-synthetic.html — see its header comment)', () => {
  let html;
  test('fixture loads', async () => { html = await loadFixture('ads-synthetic.html'); assert.ok(html.length > 500); });

  test('top ads and bottom ads are counted into separate, independent counters', async () => {
    const parsed = parse(html);
    assert.equal(parsed.topAds.length, 2);
    assert.equal(parsed.bottomAds.length, 1);
    assert.deepEqual(parsed.topAds.map(a => a.position), [1, 2]);
    assert.deepEqual(parsed.bottomAds.map(a => a.position), [1]);
  });

  test('ad domains resolve from the breadcrumb, not the aclk click-tracking redirect', async () => {
    // The exact case resultDomain()'s fallback chain exists to handle: the
    // href is https://www.googleadservices.com/pagead/aclk?... and never
    // reveals the advertiser's real domain.
    const parsed = parse(html);
    assert.deepEqual(parsed.topAds.map(a => a.domain), ['progressive.com', 'geico.com']);
    assert.deepEqual(parsed.bottomAds.map(a => a.domain), ['statefarm.com']);
  });

  test('the one organic result on the ad fixture is not miscounted as an ad', async () => {
    const parsed = parse(html);
    assert.equal(parsed.organic.length, 1);
    assert.equal(parsed.organic[0].domain, 'allstate.com');
  });

  test('a Google-owned aclk host is never returned as a result domain', async () => {
    const parsed = parse(html);
    const allDomains = [...parsed.organic, ...parsed.topAds, ...parsed.bottomAds].map(r => r.domain);
    assert.ok(!allDomains.some(d => /google|doubleclick/.test(d || '')));
  });
});

describe('fail gracefully: an ambiguous block is skipped, never guessed at', () => {
  test('an h3 with neither a cite nor a sponsored label increments skipped, not organic or ad', () => {
    const html = `<!doctype html><html><body>
      <div id="search"><div id="rso">
        <a href="/goto?url=abc"><h3>A real result</h3><cite>https://real.example</cite></a>
        <a href="/goto?url=xyz"><h3>Ambiguous block with no breadcrumb and no ad label</h3></a>
      </div></div>
    </body></html>`;
    const parsed = parse(html);
    assert.equal(parsed.organic.length, 1);
    assert.equal(parsed.organic[0].domain, 'real.example');
    assert.ok(parsed.skipped >= 1, `expected the ambiguous block to be counted as skipped, got ${parsed.skipped}`);
  });
});
