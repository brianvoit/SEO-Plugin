// What a tag manager actually fired.
//
// Built from the real resource timing of edcoproducts.com, which turned out to
// answer the question outright: GTM stamps every Google-family request it
// fires with a `gtm=` container-version parameter. On that page
//   gtag/js?id=AW-921534015&gtm=4e68v0   → the container loaded it
//   gtag/js?id=G-9J498JCKHK              → no stamp, 984ms earlier, hardcoded
// so the two are distinguishable from evidence rather than from timing.
//
// The stamp proves THAT a container fired a tag, never WHICH one, and
// non-Google tags are never stamped at all. Those limits are the reason the
// panel keeps proven and inferred apart, and they are what these tests pin.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { ROOT } from './helpers.mjs';

const content = await readFile(path.join(ROOT, 'content.js'), 'utf8');
const tagsUi  = await readFile(path.join(ROOT, 'popup-tags.js'), 'utf8');

const source = content.slice(
  content.indexOf('const TAG_VENDORS'),
  content.indexOf('\n}', content.indexOf('function detectMarketingTags')) + 2
);

/** The real detector over a page with the given resource timeline. */
function scan(html, resources = []) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: 'https://site.test/' });
  const { window } = dom;
  window.performance.getEntriesByType = (t) => t === 'resource'
    ? resources.map(r => typeof r === 'string' ? { name: r, startTime: 100 } : r) : [];
  const { detectMarketingTags } = new Function(
    'document', 'performance', 'location',
    `${source}; return { detectMarketingTags };`
  )(window.document, window.performance, window.location);
  return detectMarketingTags();
}

const at = (name, startTime) => ({ name, startTime });
const find = (r, id) => r.vendors.find(v => v.id === id);

// The genuine edcoproducts.com timeline, trimmed to the relevant entries.
const EDCO = [
  at('https://www.googletagmanager.com/gtm.js?id=GTM-MZS4NCC4', 400),
  at('https://www.googletagmanager.com/gtag/js?id=G-9J498JCKHK', 596),
  at('https://stats.g.doubleclick.net/g/collect?tid=G-9J498JCKHK&en=page_view&gtm=45je68v0', 1001),
  at('https://www.googletagmanager.com/gtag/js?id=AW-921534015&cx=c&gtm=4e68v0', 1580),
  at('https://connect.facebook.net/en_US/fbevents.js', 1580),
  at('https://www.facebook.com/tr/?id=850651795521028&ev=PageView', 2664)
];

describe('the container stamp', () => {
  test('a library carrying gtm= is attributed to the container', () => {
    const r = scan('', EDCO);
    assert.equal(find(r, 'google-ads').loadedByTagManager, true);
    assert.equal(find(r, 'google-ads').tagManagerStamp, '4e68v0');
  });

  test('a library with no stamp is NOT attributed, even though GTM is present', () => {
    // G-9J498JCKHK is hardcoded on the page. Timing alone would have blamed
    // the container for it.
    assert.equal(find(scan('', EDCO), 'ga4').loadedByTagManager, false);
  });

  test('a stamped BEACON is recorded separately from a stamped library', () => {
    // GA4's library is page-loaded but its collect beacon carries the stamp:
    // the container drives the measurement without having loaded the library.
    // Merging the two would report a hand-placed snippet as GTM-injected.
    const ga4 = find(scan('', EDCO), 'ga4');
    assert.equal(ga4.loadedByTagManager, false);
    assert.equal(ga4.beaconsViaTagManager, true);
  });

  test('an unstamped non-Google tag gets no attribution from the URL', () => {
    // Meta is never stamped — timing is the only evidence there is.
    const meta = find(scan('', EDCO), 'meta-pixel');
    assert.equal(meta.loadedByTagManager, false);
    assert.equal(meta.beaconsViaTagManager, false);
  });

  test('every vendor records when it first hit the network', () => {
    const r = scan('', EDCO);
    assert.equal(find(r, 'gtm').firstAt, 400);
    assert.equal(find(r, 'ga4').firstAt, 596);
    assert.equal(find(r, 'meta-pixel').firstAt, 1580);
  });

  test('a page with no resources leaves firstAt null rather than zero', () => {
    // 0ms would read as "loaded first", which is a different claim.
    const r = scan('<script>fbq("init","850651795521028")</script>', []);
    assert.equal(find(r, 'meta-pixel').firstAt, null);
  });

  test('a malformed URL never throws the whole scan', () => {
    assert.doesNotThrow(() => scan('', [at('https://www.googletagmanager.com/gtm.js?id=GTM-AAA1', 10)]));
  });
});

describe('grouping proven from inferred', () => {
  const tagsAttribution = new Function(
    `${tagsUi.slice(tagsUi.indexOf('function tagsAttribution('), tagsUi.indexOf('// The container view'))}
     return tagsAttribution;`
  )();

  const V = (id, cat, over = {}) => ({ id, cat, label: id, ids: [], firstAt: null,
    loadedByTagManager: false, beaconsViaTagManager: false, tagManagerStamp: null, ...over });

  test('the real edcoproducts.com shape sorts into the right groups', () => {
    const a = tagsAttribution([
      V('gtm', 'tagmanager', { firstAt: 400, ids: ['GTM-MZS4NCC4'] }),
      V('ga4', 'analytics', { firstAt: 596, beaconsViaTagManager: true }),
      V('google-ads', 'pixel', { firstAt: 1580, loadedByTagManager: true, tagManagerStamp: '4e68v0' }),
      V('meta-pixel', 'pixel', { firstAt: 1580 })
    ]);
    assert.deepEqual(a.fired.map(v => v.id), ['google-ads'], 'stamped library');
    assert.deepEqual(a.measured.map(v => v.id), ['ga4'], 'page-loaded library, stamped beacons');
    assert.deepEqual(a.after.map(v => v.id), ['meta-pixel'], 'unstamped, later — inferred only');
    assert.deepEqual(a.independent, []);
  });

  test('a stamped beacon outranks timing, so it is never merely "after"', () => {
    // The page loaded the library; the container measures through it. Calling
    // that "loaded after the container" would lose the only proven half.
    const a = tagsAttribution([
      V('gtm', 'tagmanager', { firstAt: 100 }),
      V('ga4', 'analytics', { firstAt: 900, beaconsViaTagManager: true })
    ]);
    assert.deepEqual(a.measured.map(v => v.id), ['ga4']);
    assert.deepEqual(a.after, []);
  });

  test('a tag loading before the container is independent, not inferred', () => {
    // It cannot have been fired by something that had not loaded yet.
    const a = tagsAttribution([
      V('gtm', 'tagmanager', { firstAt: 900 }),
      V('meta-pixel', 'pixel', { firstAt: 100 })
    ]);
    assert.deepEqual(a.independent.map(v => v.id), ['meta-pixel']);
    assert.deepEqual(a.after, []);
  });

  test('a stamped tag is proven even if it somehow loaded first', () => {
    // The stamp outranks timing; timing is only the fallback.
    const a = tagsAttribution([
      V('gtm', 'tagmanager', { firstAt: 900 }),
      V('google-ads', 'pixel', { firstAt: 100, loadedByTagManager: true })
    ]);
    assert.deepEqual(a.fired.map(v => v.id), ['google-ads']);
  });

  test('two containers make attribution ambiguous', () => {
    // The stamp is a version, not a container id — it cannot say which one.
    const a = tagsAttribution([
      V('gtm', 'tagmanager', { firstAt: 400 }),
      V('tealium', 'tagmanager', { firstAt: 450 }),
      V('meta-pixel', 'pixel', { firstAt: 900 })
    ]);
    assert.equal(a.ambiguous, true);
  });

  test('one container is unambiguous', () => {
    assert.equal(tagsAttribution([V('gtm', 'tagmanager', { firstAt: 1 })]).ambiguous, false);
  });

  test('no container at all yields nothing to attribute', () => {
    const a = tagsAttribution([V('ga4', 'analytics', { firstAt: 100 })]);
    assert.deepEqual(a.containers, []);
    assert.deepEqual(a.fired, []);
    assert.deepEqual(a.independent.map(v => v.id), ['ga4']);
  });

  test('groups are ordered by when each tag loaded', () => {
    const a = tagsAttribution([
      V('gtm', 'tagmanager', { firstAt: 100 }),
      V('meta-pixel', 'pixel', { firstAt: 900 }),
      V('tiktok', 'pixel', { firstAt: 300 })
    ]);
    assert.deepEqual(a.after.map(v => v.id), ['tiktok', 'meta-pixel']);
  });
});

describe('the panel keeps the two claims apart', () => {
  test('proven and inferred are separate groups, worded differently', () => {
    assert.match(tagsUi, /Proven: the request carries the container/);
    assert.match(tagsUi, /Inferred from timing only/);
  });

  test('the page-loaded-but-container-measured case has its own group', () => {
    assert.match(tagsUi, /Measured by it, loaded by the page/);
  });

  test('the stamp is shown as evidence, not hidden', () => {
    assert.match(tagsUi, /gtm=\$\{v\.tagManagerStamp\}/);
  });

  test('the library-vs-beacon split is its own group, not a footnote', () => {
    // It moved from a per-row note to a heading: it is a distinct arrangement,
    // not an exception to one of the others.
    assert.match(tagsUi, /else if \(v\.beaconsViaTagManager\) measured\.push\(v\)/);
    assert.match(tagsUi, /The library is on the page directly, but its beacons carry the container/);
  });

  test('the heading names the container only when there is one', () => {
    assert.match(tagsUi, /names\.length === 1 \? `FIRED BY \$\{names\[0\]\}` : 'FIRED BY TAG MANAGER'/);
  });

  test('the section is skipped when there is nothing to attribute', () => {
    assert.match(tagsUi, /attr\.containers\.length && \(attr\.fired\.length \|\| attr\.measured\.length \|\| attr\.after\.length\)/);
  });
});
