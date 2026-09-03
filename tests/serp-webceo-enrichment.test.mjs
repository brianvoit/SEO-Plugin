// Tests bg-page.js's fetchPageMeta — the background half of the SERP
// overlay's title/meta diff. It fetches the client's own ranked page (the
// URL comes from WebCEO's rankings data elsewhere, never from the SERP DOM
// itself — every real Google organic href is Google's own click-tracking
// redirect, confirmed in tests/serp-parser.test.mjs) and reads its real
// <title>/meta description via regex, since Chrome's MV3 service worker has
// no DOM at all and this has to stay portable across both backgrounds.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { backgroundSource } from './helpers.mjs';

const src = await backgroundSource();

/** Boots the real background against a fake HTTP layer. */
function boot({ fetchImpl } = {}) {
  const auto = () => new Proxy(function () {}, {
    get: (t, p) => (p === 'then' || typeof p === 'symbol') ? undefined : auto(),
    apply: () => auto()
  });
  const area = (backing) => ({
    get: (k) => {
      if (k == null) return Promise.resolve({ ...backing });
      const keys = Array.isArray(k) ? k : [k];
      return Promise.resolve(Object.fromEntries(keys.map(x => [x, backing[x]])));
    },
    set: (o) => { Object.assign(backing, o); return Promise.resolve(); },
    remove: (k) => { (Array.isArray(k) ? k : [k]).forEach(x => delete backing[x]); return Promise.resolve(); }
  });
  const real = {
    storage: { local: area({}), sync: area({}), session: area({}), onChanged: { addListener() {} } },
    runtime: {
      onMessage: { addListener() {} }, onInstalled: { addListener() {} },
      getURL: () => 'moz-extension://test/', sendMessage: () => Promise.resolve({})
    }
  };
  const ctx = {
    console, URL, URLSearchParams, Date, Math, JSON, RegExp, String, Object, Array, Set, Map, Promise,
    setTimeout, clearTimeout, setInterval, clearInterval, AbortController,
    crypto: globalThis.crypto, TextEncoder, btoa: globalThis.btoa, atob: globalThis.atob,
    fetch: fetchImpl || (() => Promise.reject(new Error('no network in this suite'))),
    browser: new Proxy(real, { get: (t, p) => (p in t ? t[p] : auto()) })
  };
  vm.createContext(ctx);
  vm.runInContext(`${src}
;globalThis.__x = { fetchPageMeta, extractTitle, extractMetaDescription, decodeHtmlEntitiesBasic };`, ctx);
  return ctx.__x;
}

function htmlResponse(html, { status = 200, contentType = 'text/html; charset=utf-8' } = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) }, text: async () => html };
}

describe('extractTitle / extractMetaDescription', () => {
  const b = boot();

  test('reads a plain title and a name=description meta tag', () => {
    const html = '<html><head><title>Fleet Feet Running Shoes</title><meta name="description" content="Shop running shoes online."></head></html>';
    assert.equal(b.extractTitle(html), 'Fleet Feet Running Shoes');
    assert.equal(b.extractMetaDescription(html), 'Shop running shoes online.');
  });

  test('decodes HTML entities and collapses whitespace', () => {
    const html = '<title>Running   Shoes &amp; Gear —   Fleet Feet</title>';
    assert.equal(b.extractTitle(html), 'Running Shoes & Gear — Fleet Feet');
  });

  test('finds the meta tag regardless of attribute order', () => {
    const html = '<meta content="Content comes first here" name="description">';
    assert.equal(b.extractMetaDescription(html), 'Content comes first here');
  });

  test('single-quoted attributes work too', () => {
    const html = "<meta name='description' content='Single quoted content'>";
    assert.equal(b.extractMetaDescription(html), 'Single quoted content');
  });

  test('a page with neither returns null, not an empty string or a throw', () => {
    const html = '<html><body>no head tags here</body></html>';
    assert.equal(b.extractTitle(html), null);
    assert.equal(b.extractMetaDescription(html), null);
  });

  test('og:description is not mistaken for the meta description', () => {
    const html = '<meta property="og:description" content="wrong one"><meta name="description" content="right one">';
    assert.equal(b.extractMetaDescription(html), 'right one');
  });
});

describe('fetchPageMeta', () => {
  test('rejects a non-http(s) or malformed URL without ever calling fetch', async () => {
    let called = false;
    const b = boot({ fetchImpl: () => { called = true; return Promise.reject(new Error('should not be called')); } });
    const res = await b.fetchPageMeta({ url: 'not-a-url' });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'BAD_URL');
    assert.equal(called, false);
  });

  test('a successful fetch returns the real title and description', async () => {
    const html = '<html><head><title>Real Title From The Page</title><meta name="description" content="Real description from the page."></head></html>';
    const b = boot({ fetchImpl: async () => htmlResponse(html) });
    const res = await b.fetchPageMeta({ url: 'https://fleetfeet.com/' });
    assert.equal(res.ok, true);
    assert.equal(res.title, 'Real Title From The Page');
    assert.equal(res.description, 'Real description from the page.');
  });

  test('a non-2xx status reports an error, not a throw', async () => {
    const b = boot({ fetchImpl: async () => htmlResponse('', { status: 404 }) });
    const res = await b.fetchPageMeta({ url: 'https://fleetfeet.com/gone' });
    assert.equal(res.ok, false);
    assert.match(res.error, /404/);
  });

  test('a non-HTML response is reported rather than parsed', async () => {
    const b = boot({ fetchImpl: async () => htmlResponse('{"not":"html"}', { contentType: 'application/json' }) });
    const res = await b.fetchPageMeta({ url: 'https://fleetfeet.com/api' });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'NOT_HTML');
  });

  test('a network failure reports an error, not a throw', async () => {
    const b = boot({ fetchImpl: async () => { throw new Error('network down'); } });
    const res = await b.fetchPageMeta({ url: 'https://fleetfeet.com/' });
    assert.equal(res.ok, false);
    assert.match(res.error, /network down/);
  });

  test('a second call within the cache TTL does not re-fetch', async () => {
    let calls = 0;
    const html = '<title>Cached Title</title>';
    const b = boot({ fetchImpl: async () => { calls++; return htmlResponse(html); } });
    const first = await b.fetchPageMeta({ url: 'https://fleetfeet.com/' });
    const second = await b.fetchPageMeta({ url: 'https://fleetfeet.com/' });
    assert.equal(calls, 1, 'the second call should have been served from cache');
    assert.deepEqual(first.title, second.title);
  });

  test('different URLs are cached independently', async () => {
    let calls = 0;
    const b = boot({ fetchImpl: async (url) => { calls++; return htmlResponse(`<title>${url}</title>`); } });
    await b.fetchPageMeta({ url: 'https://fleetfeet.com/a' });
    await b.fetchPageMeta({ url: 'https://fleetfeet.com/b' });
    assert.equal(calls, 2);
  });
});
