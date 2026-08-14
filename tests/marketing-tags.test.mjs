// Tests content.js's marketing-tag detection — the Tags & Pixels section.
//
// Detection is pure inspection of a document plus a resource-timing list, so
// the real TAG_VENDORS table and detectMarketingTags() are sliced out of
// content.js and run against a jsdom page with a stubbed
// performance.getEntriesByType. Testing a reimplementation would prove nothing
// about the shipped rules — and the rules are where the bugs live: 32 regexes
// against real vendor URLs, several of which share a host.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { ROOT } from './helpers.mjs';

const START = 'const TAG_VENDORS = [';
const END = 'function getPageData(';

const src = await readFile(path.join(ROOT, 'content.js'), 'utf8');
const from = src.indexOf(START);
const to = src.indexOf(END);

test('the detector is still where the test expects it', () => {
  assert.ok(from !== -1, `could not find "${START}" in content.js — update this test's slice markers`);
  assert.ok(to > from, `could not find "${END}" after the detector`);
});

const source = src.slice(from, to);

/**
 * Runs the real detector over a page.
 * @param html      body markup
 * @param resources resource-timing URLs (repeat a URL to model a second fetch)
 */
function scan(html, resources = []) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: 'https://site.test/' });
  const { window } = dom;
  // A plain string keeps the older load/duplicate tests terse (order/timing
  // doesn't matter to them); an {name, startTime} object lets the event tests
  // below control ordering explicitly.
  window.performance.getEntriesByType = (type) =>
    type === 'resource'
      ? resources.map((r, i) => typeof r === 'string' ? { name: r, startTime: (i + 1) * 100 } : { startTime: (i + 1) * 100, ...r })
      : [];

  const { detectMarketingTags, TAG_VENDORS } = new Function(
    'document', 'performance',
    `${source}; return { detectMarketingTags, TAG_VENDORS };`
  )(window.document, window.performance);

  return { ...detectMarketingTags(), TAG_VENDORS };
}

const vendor = (res, id) => res.vendors.find(v => v.id === id);
const codes = (res) => res.flags.map(f => f.code);

const script = (src) => `<script src="${src}"></script>`;

describe('the shared-host trap', () => {
  // Tag Manager and GA4 both live on googletagmanager.com and differ only by
  // path. A host-only rule would report both on any page carrying either —
  // the single most likely way this table goes wrong.
  test('GTM alone does not report GA4', () => {
    const res = scan(script('https://www.googletagmanager.com/gtm.js?id=GTM-ABC123'));
    assert.ok(vendor(res, 'gtm'), 'GTM not detected');
    assert.equal(vendor(res, 'ga4'), undefined, 'GA4 falsely reported from a GTM script');
  });

  test('GA4 alone does not report GTM', () => {
    const res = scan(script('https://www.googletagmanager.com/gtag/js?id=G-ABC123'));
    assert.ok(vendor(res, 'ga4'), 'GA4 not detected');
    assert.equal(vendor(res, 'gtm'), undefined, 'GTM falsely reported from a gtag script');
  });

  test('both on one page resolve to two distinct vendors', () => {
    const res = scan(
      script('https://www.googletagmanager.com/gtm.js?id=GTM-ABC123') +
      script('https://www.googletagmanager.com/gtag/js?id=G-ABC123')
    );
    assert.deepEqual(res.vendors.map(v => v.id).sort(), ['ga4', 'gtm']);
    assert.deepEqual(vendor(res, 'gtm').ids, ['GTM-ABC123']);
    assert.deepEqual(vendor(res, 'ga4').ids, ['G-ABC123']);
  });
});

describe('where a tag was seen', () => {
  test('a script element is reported as dom', () => {
    const res = scan(script('https://www.googletagmanager.com/gtag/js?id=G-ABC123'));
    assert.deepEqual(vendor(res, 'ga4').where, ['dom']);
  });

  test('a resource with no element is reported as network only', () => {
    // A pixel that fired as a beacon leaves no element behind — resource
    // timing is the only way to see it at all.
    const res = scan('', ['https://analytics.tiktok.com/i18n/pixel/events.js']);
    assert.deepEqual(vendor(res, 'tiktok').where, ['network']);
  });

  test('an ordinary hardcoded script is both dom and network, and that is NOT a duplicate', () => {
    // The same fetch seen twice through two lenses. An earlier draft treated
    // this as "hardcoded AND injected" and would have warned on every normal
    // install — querySelectorAll reads the live DOM, so it cannot tell a
    // server-sent script from one a tag manager injected.
    const url = 'https://www.googletagmanager.com/gtag/js?id=G-ABC123';
    const res = scan(script(url), [url]);
    assert.deepEqual(vendor(res, 'ga4').where, ['dom', 'network']);
    assert.equal(vendor(res, 'ga4').loads, 1, 'one URL counted as two loads');
    assert.ok(!codes(res).includes('DUPLICATE_ID'), 'a normal single install was flagged as duplicate');
  });
});

describe('duplicate detection', () => {
  test('the same ID served by two different scripts is flagged', () => {
    // The real double-count: one property loaded by two different loaders.
    const res = scan(
      script('https://www.googletagmanager.com/gtag/js?id=G-ABC123') +
      script('https://www.googletagmanager.com/gtag/js?id=G-ABC123&l=dataLayer2')
    );
    const dup = res.flags.find(f => f.code === 'DUPLICATE_ID');
    assert.ok(dup, 'two loaders for one measurement ID were not flagged');
    assert.equal(dup.level, 'warning');
    assert.match(dup.text, /G-ABC123/);
  });

  test('it fires once per vendor, not once per sighting', () => {
    const res = scan(
      script('https://www.googletagmanager.com/gtag/js?id=G-ABC123') +
      script('https://www.googletagmanager.com/gtag/js?id=G-ABC123&x=1') +
      script('https://www.googletagmanager.com/gtag/js?id=G-ABC123&x=2')
    );
    assert.equal(codes(res).filter(c => c === 'DUPLICATE_ID').length, 1);
  });

  test('two DIFFERENT IDs are a normal multi-property setup, not a duplicate', () => {
    const res = scan(
      script('https://www.googletagmanager.com/gtag/js?id=G-AAAAAA') +
      script('https://www.googletagmanager.com/gtag/js?id=G-BBBBBB')
    );
    assert.ok(!codes(res).includes('DUPLICATE_ID'), 'two distinct properties flagged as a duplicate');
  });

  test('the same URL fetched twice is flagged', () => {
    const url = 'https://static.hotjar.com/c/hotjar-123456.js';
    const res = scan('', [url, url]);
    assert.ok(codes(res).includes('DUPLICATE_ID'), 'a doubly-fetched script was not flagged');
  });

  test('a beacon endpoint firing repeatedly is NOT flagged', () => {
    // Adobe's /b/ss/ and the ad pixels fire once per tracked event. Counting
    // those as duplicates would warn on every correctly-instrumented page.
    const beacon = 'https://metrics.site.test/b/ss/acmeprod/1/JS-2.22.0';
    const res = scan('', [beacon, beacon, beacon]);
    assert.ok(vendor(res, 'adobe-analytics'), 'Adobe beacon not detected at all');
    assert.ok(!codes(res).includes('DUPLICATE_ID'), 'per-event beacons flagged as duplicate loads');
  });
});

describe('other flags', () => {
  test('Universal Analytics is called out as dead', () => {
    const res = scan(script('https://www.google-analytics.com/analytics.js'));
    const ua = res.flags.find(f => f.code === 'LEGACY_UA');
    assert.ok(ua);
    assert.equal(ua.level, 'warning');
  });

  test('two analytics tools is info, never a warning', () => {
    const res = scan(
      script('https://www.googletagmanager.com/gtag/js?id=G-ABC123') +
      script('https://cdn.matomo.cloud/site/matomo.js')
    );
    const f = res.flags.find(x => x.code === 'MULTIPLE_ANALYTICS');
    assert.ok(f, 'two analytics tools not reported');
    assert.equal(f.level, 'info', 'a legitimate dual-analytics setup was raised as a warning');
  });

  test('consent tools do not count as tag managers', () => {
    // Both live in the tagmanager category, but OneTrust alongside GTM is the
    // normal arrangement, not a conflict.
    const res = scan(
      script('https://www.googletagmanager.com/gtm.js?id=GTM-ABC123') +
      script('https://cdn.cookielaw.org/consent/otSDKStub.js')
    );
    assert.ok(vendor(res, 'onetrust'), 'OneTrust not detected');
    assert.ok(!codes(res).includes('MULTIPLE_TAG_MANAGERS'), 'a consent tool was counted as a second tag manager');
  });

  test('two real tag managers is reported', () => {
    const res = scan(
      script('https://www.googletagmanager.com/gtm.js?id=GTM-ABC123') +
      script('https://tags.tiqcdn.com/utag/acme/main/prod/utag.js')
    );
    assert.ok(codes(res).includes('MULTIPLE_TAG_MANAGERS'));
  });

  test('a clean single-vendor page raises nothing', () => {
    const res = scan(script('https://www.googletagmanager.com/gtag/js?id=G-ABC123'));
    assert.deepEqual(res.flags, []);
  });
});

describe('IDs from inline snippets', () => {
  test('Meta Pixel ID is read from fbq init', () => {
    const res = scan(`<script>!function(f,b,e){}(window);fbq('init', '1234567890123');fbq('track','PageView');</script>`);
    assert.deepEqual(vendor(res, 'meta-pixel').ids, ['1234567890123']);
  });

  test('Hotjar ID is read from hjid', () => {
    const res = scan(`<script>window.hj=window.hj||function(){};h._hjSettings={hjid:2345678,hjsv:6};</script>`);
    assert.deepEqual(vendor(res, 'hotjar').ids, ['2345678']);
  });

  test('an inline-only sighting contributes no load count', () => {
    // The GTM snippet is inline and injects gtm.js. Counting the snippet as a
    // load would make every standard GTM install look like it fired twice.
    const res = scan(`<script>(function(w,d,s,l,i){})(window,document,'script','dataLayer','GTM-ABC123');</script>`);
    const v = vendor(res, 'gtm');
    assert.deepEqual(v.ids, ['GTM-ABC123']);
    assert.equal(v.loads, 0, 'an inline snippet was counted as a script load');
    assert.ok(!codes(res).includes('DUPLICATE_ID'));
  });

  test('the standard GTM install — inline snippet plus injected script — is not a duplicate', () => {
    const url = 'https://www.googletagmanager.com/gtm.js?id=GTM-ABC123';
    const res = scan(
      `<script>(function(w,d,s,l,i){})(window,document,'script','dataLayer','GTM-ABC123');</script>` + script(url),
      [url]
    );
    assert.deepEqual(res.flags, [], 'a textbook GTM install produced a warning');
  });
});

describe('pixel fallbacks', () => {
  test('a noscript <img> pixel is detected', () => {
    const res = scan('<noscript><img height="1" width="1" src="https://www.facebook.com/tr?id=1234567890123&ev=PageView"/></noscript>');
    assert.ok(vendor(res, 'meta-pixel'), 'noscript pixel fallback missed');
    assert.deepEqual(vendor(res, 'meta-pixel').ids, ['1234567890123']);
  });
});

describe('the payload contract', () => {
  test('survives structured cloning', () => {
    // It crosses tabs.sendMessage, so a Set/Map/RegExp leaking out of the
    // accumulators would throw at the boundary rather than here.
    const url = 'https://www.googletagmanager.com/gtag/js?id=G-ABC123';
    const res = scan(script(url), [url]);
    const { TAG_VENDORS, ...payload } = res;
    assert.doesNotThrow(() => structuredClone(payload));
  });

  test('evidence is capped per vendor', () => {
    const many = Array.from({ length: 12 }, (_, i) => `https://static.hotjar.com/c/hotjar-${i}.js`);
    const res = scan('', many);
    assert.ok(vendor(res, 'hotjar').evidence.length <= 5, 'evidence list is unbounded');
  });

  test('nothing detected yields empty arrays, not undefined', () => {
    const res = scan('<p>no tags here</p>');
    assert.deepEqual(res.vendors, []);
    assert.deepEqual(res.flags, []);
  });

  test('an empty resource buffer is survivable', () => {
    const res = scan(script('https://www.googletagmanager.com/gtag/js?id=G-ABC123'), []);
    assert.ok(vendor(res, 'ga4'));
  });
});

describe('the rule table itself', () => {
  // One representative real URL per vendor. This is the table's regression
  // net: a regex tightened for one vendor can silently stop matching another.
  const FIXTURES = {
    'ga4': 'https://www.googletagmanager.com/gtag/js?id=G-ABC123',
    'ua': 'https://www.google-analytics.com/analytics.js',
    'adobe-analytics': 'https://assets.site.test/AppMeasurement.js',
    'matomo': 'https://cdn.matomo.cloud/site/matomo.js',
    'plausible': 'https://plausible.io/js/script.js',
    'fathom': 'https://cdn.usefathom.com/script.js',
    'mixpanel': 'https://cdn.mxpnl.com/libs/mixpanel-2-latest.min.js',
    'amplitude': 'https://cdn.amplitude.com/libs/amplitude-8.5.0-min.gz.js',
    'heap': 'https://cdn.heapanalytics.com/js/heap-123456.js',
    'gtm': 'https://www.googletagmanager.com/gtm.js?id=GTM-ABC123',
    'adobe-launch': 'https://assets.adobedtm.com/launch-EN123.min.js',
    'tealium': 'https://tags.tiqcdn.com/utag/acme/main/prod/utag.js',
    'segment': 'https://cdn.segment.com/analytics.js/v1/abc123/analytics.min.js',
    'onetrust': 'https://cdn.cookielaw.org/consent/otSDKStub.js',
    'cookiebot': 'https://consent.cookiebot.com/uc.js',
    'osano': 'https://cmp.osano.com/abc/osano.js',
    'klaro': 'https://site.test/js/klaro.min.js',
    'crazyegg': 'https://script.crazyegg.com/pages/scripts/0123/4567.js',
    'hotjar': 'https://static.hotjar.com/c/hotjar-2345678.js',
    'fullstory': 'https://edge.fullstory.com/s/fs.js',
    'clarity': 'https://www.clarity.ms/tag/abcd1234',
    'mouseflow': 'https://cdn.mouseflow.com/projects/abc.js',
    'luckyorange': 'https://tools.luckyorange.com/core/lo.js',
    'smartlook': 'https://web-sdk.smartlook.com/recorder.js',
    'google-ads': 'https://www.googleadservices.com/pagead/conversion/123456789/',
    'floodlight': 'https://fls.doubleclick.net/activityi;src=123;',
    'meta-pixel': 'https://connect.facebook.net/en_US/fbevents.js',
    'linkedin': 'https://snap.licdn.com/li.lms-analytics/insight.min.js',
    'twitter': 'https://static.ads-twitter.com/uwt.js',
    'tiktok': 'https://analytics.tiktok.com/i18n/pixel/events.js',
    'pinterest': 'https://s.pinimg.com/ct/core.js',
    'reddit': 'https://www.redditstatic.com/ads/pixel.js',
    'bing-uet': 'https://bat.bing.com/bat.js'
  };

  const { TAG_VENDORS } = scan('');

  test('every vendor in the table has a fixture', () => {
    const missing = TAG_VENDORS.map(v => v.id).filter(id => !FIXTURES[id]);
    assert.deepEqual(missing, [], 'add a representative URL for these vendors');
  });

  for (const [id, url] of Object.entries(FIXTURES)) {
    test(`${id} matches its representative URL`, () => {
      const res = scan('', [url]);
      assert.ok(vendor(res, id), `${url} did not match ${id}`);
    });
  }

  test('no fixture matches more than one vendor', () => {
    // Catches an over-broad regex reaching into another vendor's territory.
    const overlaps = [];
    for (const [id, url] of Object.entries(FIXTURES)) {
      const hit = scan('', [url]).vendors.map(v => v.id);
      if (hit.length > 1) overlaps.push(`${id} → ${hit.join(', ')}`);
    }
    assert.deepEqual(overlaps, []);
  });
});

describe('fired events — what a tag actually SENT, not just what loaded', () => {
  const ev = (res, i = 0) => res.events[i];

  test('GA4: event name comes from the en= param on the /g/collect hit', () => {
    const res = scan('', ['https://www.google-analytics.com/g/collect?v=2&tid=G-ABC123&en=page_view']);
    assert.equal(res.events.length, 1);
    assert.equal(ev(res).vendorId, 'ga4');
    assert.equal(ev(res).name, 'page_view');
  });

  test('GA4: the gtag.js library load itself is not an event', () => {
    const res = scan('', ['https://www.googletagmanager.com/gtag/js?id=G-ABC123']);
    assert.deepEqual(res.events, []);
  });

  test('GA4: a regional collect subdomain still counts', () => {
    const res = scan('', ['https://region1.google-analytics.com/g/collect?en=purchase']);
    assert.equal(ev(res).name, 'purchase');
  });

  test('Universal Analytics: t=event uses the event action (ea), not the literal word "event"', () => {
    const res = scan('', ['https://www.google-analytics.com/collect?v=1&t=event&ec=video&ea=play&el=intro']);
    assert.equal(ev(res).name, 'play');
  });

  test('Universal Analytics: t=pageview uses the hit type itself', () => {
    const res = scan('', ['https://www.google-analytics.com/collect?v=1&t=pageview']);
    assert.equal(ev(res).name, 'pageview');
  });

  test('Meta Pixel: event name comes from ev=, and the library load is not itself an event', () => {
    const res = scan('', [
      'https://connect.facebook.net/en_US/fbevents.js',
      'https://www.facebook.com/tr?id=123&ev=Purchase&noscript=1'
    ]);
    assert.equal(res.events.length, 1, 'the library load was counted as an event');
    assert.equal(ev(res).name, 'Purchase');
  });

  test('TikTok: event name comes from the track endpoint, not the pixel library', () => {
    const res = scan('', [
      'https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=ABC',
      'https://analytics.tiktok.com/api/v2/pixel/track?event=CompletePayment'
    ]);
    assert.equal(res.events.length, 1);
    assert.equal(ev(res).name, 'CompletePayment');
  });

  test('Pinterest: event name comes from event=', () => {
    const res = scan('', ['https://ct.pinterest.com/v3/?event=checkout&ad_account_id=123']);
    assert.equal(ev(res).name, 'checkout');
  });

  test('Bing UET: a custom event carries evt=', () => {
    const res = scan('', ['https://bat.bing.com/action/0?ti=12345678&evt=custom&ec=signup']);
    assert.equal(ev(res).name, 'custom');
  });

  test('Bing UET: a plain page-view hit has no evt= at all, and still gets a sensible label', () => {
    const res = scan('', ['https://bat.bing.com/action/0?ti=12345678']);
    assert.equal(ev(res).name, 'page view');
  });

  test('Adobe: pageName gives a readable label', () => {
    const res = scan('', ['https://metrics.site.test/b/ss/acmeprod/1/JS-2.22.0/s?pageName=Homepage']);
    assert.equal(ev(res).name, 'Homepage');
  });

  test('Adobe: a beacon with no pageName still counts, with a generic label', () => {
    const res = scan('', ['https://metrics.site.test/b/ss/acmeprod/1/JS-2.22.0/s?events=event1']);
    assert.equal(ev(res).name, 'beacon');
  });

  test('a vendor with no hit matcher (e.g. Hotjar) never produces an event', () => {
    const res = scan('', ['https://static.hotjar.com/c/hotjar-2345678.js']);
    assert.deepEqual(res.events, []);
  });

  test('events sort newest first', () => {
    const res = scan('', [
      { name: 'https://www.google-analytics.com/g/collect?en=first', startTime: 100 },
      { name: 'https://www.google-analytics.com/g/collect?en=second', startTime: 300 },
      { name: 'https://www.google-analytics.com/g/collect?en=third', startTime: 200 }
    ]);
    assert.deepEqual(res.events.map(e => e.name), ['second', 'third', 'first']);
  });

  test('events are capped even when many fired', () => {
    const many = Array.from({ length: 40 }, (_, i) => `https://www.google-analytics.com/g/collect?en=e${i}`);
    const res = scan('', many);
    assert.ok(res.events.length <= 30, `expected the 30-event cap, got ${res.events.length}`);
  });

  test('the same URL query values are percent-decoded and length-capped', () => {
    const long = 'x'.repeat(200);
    const res = scan('', [`https://www.google-analytics.com/g/collect?en=${encodeURIComponent('some event ' + long)}`]);
    assert.ok(ev(res).name.length <= 60, 'event name was not capped');
  });
});
