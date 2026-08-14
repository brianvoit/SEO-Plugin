// The Chrome build must load Mozilla's browser.* polyfill before any source
// file, in all three execution contexts. Firefox provides `browser` natively
// and must not receive the polyfill at all.
//
// If the polyfill ever stops loading first, Chrome fails with
// "ReferenceError: browser is not defined" on the first line of the first
// script — a total, silent failure of the whole extension.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DIST, readJson } from './helpers.mjs';
import { BACKGROUND_FILES } from '../scripts/build.mjs';

const POLYFILL = 'browser-polyfill.js';
const chromeDir = path.join(DIST, 'chrome');
const firefoxDir = path.join(DIST, 'firefox');

// Read the SHIPPED manifest, not buildManifest()'s merge result — the polyfill
// is injected into content_scripts during the copy step, so only the built
// artifact reflects what the browser actually loads.
const builtManifest = (browser) => readJson(path.join(DIST, browser, 'manifest.json'));

describe('chrome build', () => {
  test('ships the polyfill', () => {
    assert.ok(existsSync(path.join(chromeDir, POLYFILL)), `dist/chrome/${POLYFILL} missing`);
  });

  test('service worker imports the polyfill before any background file', async () => {
    const m = await builtManifest('chrome');
    const swPath = path.join(chromeDir, m.background.service_worker);
    assert.ok(existsSync(swPath), `service worker entry ${m.background.service_worker} missing`);

    // The background is several files now; the polyfill has to precede all of
    // them, since the very first line of bg-core.js already uses `browser.*`.
    // background-split.test.mjs owns the full list-agreement check.
    const sw = await readFile(swPath, 'utf8');
    const polyIdx = sw.indexOf(POLYFILL);
    assert.ok(polyIdx !== -1, 'service worker does not import the polyfill');
    for (const f of BACKGROUND_FILES) {
      const idx = sw.indexOf(f);
      assert.ok(idx !== -1, `service worker does not import ${f}`);
      assert.ok(polyIdx < idx, `polyfill must be imported before ${f}`);
    }
  });

  test('content scripts list the polyfill first', async () => {
    const m = await builtManifest('chrome');
    for (const cs of m.content_scripts) {
      assert.equal(cs.js[0], POLYFILL, 'polyfill must be the first content script');
    }
  });

  test('popup.html loads the polyfill before any source script', async () => {
    const html = await readFile(path.join(chromeDir, 'popup.html'), 'utf8');
    const srcs = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1]);
    assert.equal(srcs[0], POLYFILL, `expected ${POLYFILL} first, got ${srcs[0]}`);
    assert.equal(srcs.filter(s => s === POLYFILL).length, 1, 'polyfill injected more than once');
  });
});

describe('firefox build', () => {
  test('does not ship the polyfill', () => {
    assert.ok(!existsSync(path.join(firefoxDir, POLYFILL)), 'Firefox has browser.* natively — polyfill should not be bundled');
  });

  test('popup.html is untouched by the polyfill injection', async () => {
    const html = await readFile(path.join(firefoxDir, 'popup.html'), 'utf8');
    assert.ok(!html.includes(POLYFILL), 'Firefox popup.html should not reference the polyfill');
  });

  test('keeps plain background scripts, not a generated worker entry', async () => {
    const m = await builtManifest('firefox');
    assert.deepEqual(m.background.scripts, BACKGROUND_FILES);
    assert.ok(!existsSync(path.join(firefoxDir, 'sw.js')), 'sw.js is a Chrome-only build artifact');
  });
});
