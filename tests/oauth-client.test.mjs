// Tests the bundled OAuth client — the shipped default that makes connecting
// work without every user first building a Google Cloud project.
//
// Two things here are worth guarding hard. First, a user-entered client must
// always win, because that is both the escape hatch for anyone with their own
// Cloud project AND the migration path off the shared client once it hits
// Google's 100-user cap. Second, the credentials must never reach the repo:
// this project is public, so the build injects them and the source carries
// empty strings. A test is the only thing standing between that rule and an
// afternoon where someone "just hardcodes it to check something".

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, DIST, readJson, backgroundSource } from './helpers.mjs';

/** Boots the real background with the given stored credentials. */
function boot({ local = {} } = {}) {
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
    storage: { local: area(local), sync: area({}), session: area({}), onChanged: { addListener() {} } },
    runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} }, getURL: () => 'moz-extension://test/' }
  };
  const ctx = {
    console, URL, URLSearchParams, Date, Math, JSON, RegExp, String, Object, Array,
    setTimeout, clearTimeout, setInterval, clearInterval,
    crypto: globalThis.crypto, TextEncoder, btoa: globalThis.btoa, atob: globalThis.atob,
    fetch: () => Promise.reject(new Error('no network in this suite')),
    browser: new Proxy(real, { get: (t, p) => (p in t ? t[p] : auto()) })
  };
  vm.createContext(ctx);
  return { ctx, local };
}

/** Runs the background with the bundled constants forced to given values. */
async function bootWithBundled(id, secret, local = {}) {
  const src = (await backgroundSource())
    .replace(/^const BUNDLED_GOOGLE_CLIENT_ID = .*$/m,     `const BUNDLED_GOOGLE_CLIENT_ID = ${JSON.stringify(id)};`)
    .replace(/^const BUNDLED_GOOGLE_CLIENT_SECRET = .*$/m, `const BUNDLED_GOOGLE_CLIENT_SECRET = ${JSON.stringify(secret)};`);
  const b = boot({ local });
  vm.runInContext(`${src}
;globalThis.__x = { googleOAuthCredentials, hasBundledOAuthClient };`, b.ctx);
  return b.ctx.__x;
}

describe('choosing which OAuth client to authenticate as', () => {
  test('falls back to the bundled client when the user has entered none', async () => {
    const x = await bootWithBundled('bundled-id.apps.googleusercontent.com', 'bundled-secret');
    const c = await x.googleOAuthCredentials();
    assert.equal(c.clientId, 'bundled-id.apps.googleusercontent.com');
    assert.equal(c.clientSecret, 'bundled-secret');
    assert.equal(c.bundled, true);
  });

  test("a user's own client always wins", async () => {
    const x = await bootWithBundled('bundled-id', 'bundled-secret', {
      gscClientId: 'mine.apps.googleusercontent.com', gscClientSecret: 'my-secret'
    });
    const c = await x.googleOAuthCredentials();
    assert.equal(c.clientId, 'mine.apps.googleusercontent.com');
    assert.equal(c.clientSecret, 'my-secret');
    assert.equal(c.bundled, false);
  });

  test('never crosses a user id with the bundled secret', async () => {
    // Mixing halves of two clients fails at the token exchange with an opaque
    // invalid_client. If the user supplied an id, their (possibly empty)
    // secret is what goes with it.
    const x = await bootWithBundled('bundled-id', 'bundled-secret', { gscClientId: 'mine' });
    const c = await x.googleOAuthCredentials();
    assert.equal(c.clientId, 'mine');
    assert.equal(c.clientSecret, '', 'the bundled secret leaked onto a user-supplied client id');
  });

  test('with no bundled client and no user client, there is nothing to connect with', async () => {
    // The pre-bundling behaviour, still the shape on a build with no secrets.
    const x = await bootWithBundled('', '');
    const c = await x.googleOAuthCredentials();
    assert.equal(c.clientId, '');
    assert.equal(x.hasBundledOAuthClient(), false);
  });

  test('hasBundledOAuthClient reports what the build shipped', async () => {
    assert.equal((await bootWithBundled('some-id', 's')).hasBundledOAuthClient(), true);
    assert.equal((await bootWithBundled('', '')).hasBundledOAuthClient(), false);
  });
});

describe('the extension id is pinned', () => {
  // Chromium derives the extension id from this key, and the id is what the
  // OAuth redirect URI is built from. Without it the id comes from the install
  // path, so every user has a different redirect URI and the shared client
  // can't work — each person would have to register their own.
  test('manifest.chrome.json carries a key', async () => {
    const m = await readJson(path.join(ROOT, 'manifest.chrome.json'));
    assert.ok(m.key, 'no key — Chromium ids fall back to being per-install');
    assert.ok(m.key.length > 300, 'key looks too short to be a 2048-bit public key');
    assert.match(m.key, /^[A-Za-z0-9+/]+=*$/, 'key must be base64, no whitespace');
  });

  test('the built Chrome manifest keeps it', async () => {
    const m = await readJson(path.join(DIST, 'chrome', 'manifest.json'));
    assert.ok(m.key);
  });

  test('Firefox does NOT get it', async () => {
    // Firefox pins its id through browser_specific_settings.gecko.id instead;
    // a stray Chromium key in that manifest is at best noise.
    const m = await readJson(path.join(DIST, 'firefox', 'manifest.json'));
    assert.equal(m.key, undefined);
    assert.ok(m.browser_specific_settings?.gecko?.id, 'Firefox still needs its own pinned id');
  });
});

describe('the credentials never enter the repo', () => {
  test('oauth-config.js ships empty values in source', async () => {
    // This repo is public. The build injects the real values from CI secrets;
    // if this test ever fails, a credential has been committed.
    const src = await readFile(path.join(ROOT, 'oauth-config.js'), 'utf8');
    assert.match(src, /^const BUNDLED_GOOGLE_CLIENT_ID = '';$/m,     'a client id is committed to a public repo');
    assert.match(src, /^const BUNDLED_GOOGLE_CLIENT_SECRET = '';$/m, 'a client secret is committed to a public repo');
  });

  test('no Google client id is hardcoded anywhere else in the source', async () => {
    const files = ['bg-auth.js', 'bg-gsc.js', 'bg-ga.js', 'bg-ads.js', 'bg-export.js', 'popup-settings.js', 'popup-gsc.js'];
    for (const f of files) {
      const src = await readFile(path.join(ROOT, f), 'utf8');
      const hits = src.split('\n').filter(l => /\.apps\.googleusercontent\.com/.test(l) && !l.trim().startsWith('//') && !l.includes('placeholder'));
      assert.deepEqual(hits, [], `${f} looks like it contains a real client id`);
    }
  });

  test('the build substitutes both constants when the environment supplies them', async () => {
    // Mirrors injectOAuthClient's replacement so a rename of either constant
    // breaks here rather than silently shipping an unconfigured build.
    const src = await readFile(path.join(ROOT, 'oauth-config.js'), 'utf8');
    const out = src
      .replace(/^const BUNDLED_GOOGLE_CLIENT_ID = .*$/m,     `const BUNDLED_GOOGLE_CLIENT_ID = ${JSON.stringify('injected-id')};`)
      .replace(/^const BUNDLED_GOOGLE_CLIENT_SECRET = .*$/m, `const BUNDLED_GOOGLE_CLIENT_SECRET = ${JSON.stringify('injected-secret')};`);
    assert.match(out, /BUNDLED_GOOGLE_CLIENT_ID = "injected-id"/);
    assert.match(out, /BUNDLED_GOOGLE_CLIENT_SECRET = "injected-secret"/);
  });
});
