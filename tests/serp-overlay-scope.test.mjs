// Mirrors tests/overlay-scope.test.mjs's invariants for the SERP overlay:
// per-document state, never persisted, applySerpOverlay only reachable from
// the toggle — the same bug class that once made the link overlay reappear
// on every site forever, once switched on anywhere.
//
// Also pins the one real seam this overlay introduces: content-serp.js runs
// in a SEPARATE isolated world from content.js (its own content_scripts
// entry, matched only on www.google.com/search), so the two files cannot
// share a JS variable. The only channel they share is a DOM attribute on
// <html> — a literal string that has to match byte-for-byte in both files
// with no compiler to catch drift if one side is ever renamed.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

const serp    = await readFile(path.join(ROOT, 'content-serp.js'), 'utf8');
const content = await readFile(path.join(ROOT, 'content.js'), 'utf8');
const core    = await readFile(path.join(ROOT, 'bg-core.js'), 'utf8');
const popup   = await readFile(path.join(ROOT, 'popup-inspector.js'), 'utf8');
const nav     = await readFile(path.join(ROOT, 'popup-nav.js'), 'utf8');
const manifest = JSON.parse(await readFile(path.join(ROOT, 'manifest.base.json'), 'utf8'));

describe('no SERP overlay state survives a page load', () => {
  test('the overlay flag is never read from storage', () => {
    const reads = serp.match(/storage\.local\.get\([^)]*OverlayActive[^)]*\)/g) || [];
    assert.deepEqual(reads, [], 'content-serp.js reads an overlay flag from storage');
  });

  test('the overlay flag is never written to storage', () => {
    const writes = serp.match(/storage\.local\.set\([^)]*OverlayActive[^)]*\)/g) || [];
    assert.deepEqual(writes, [], 'content-serp.js persists overlay state');
  });

  test('the state lives in a per-document variable', () => {
    assert.match(serp, /^let _serpOverlayOn = false;$/m);
  });

  test('the toggle flips the local variable, not a stored value', () => {
    assert.match(serp, /_serpOverlayOn = !_serpOverlayOn;/);
  });

  test('applySerpOverlay is only reachable from the toggle', () => {
    const idxs = [...serp.matchAll(/applySerpOverlay\(\)/g)].map(m => m.index);
    assert.ok(idxs.length, 'applySerpOverlay() is never called — did it get renamed?');
    const callSites = idxs
      .map(i => serp.slice(serp.lastIndexOf('\n', i) + 1, serp.indexOf('\n', i)))
      .filter(line => !/^function /.test(line));
    assert.ok(callSites.length, 'applySerpOverlay() has no call sites — did it get renamed?');
    callSites.forEach(line => {
      assert.match(line, /^\s*if \(_serpOverlayOn\)/, `applySerpOverlay is invoked outside the toggle: "${line.trim()}"`);
    });
  });
});

describe('the toggle message contract', () => {
  test('toggleSerpOverlay is wired in content-serp.js\'s own message listener', () => {
    assert.match(serp, /message\.action === 'toggleSerpOverlay'/);
  });

  test('content-serp.js does not answer getOverlayState or getPageData', () => {
    // Those stay exclusively content.js's job — two listeners in the same
    // tab must never race to answer the same message.
    assert.doesNotMatch(serp, /message\.action === 'getOverlayState'/);
    assert.doesNotMatch(serp, /message\.action === 'getPageData'/);
  });

  test('a toggle announces its own state, separately from content.js\'s broadcast', () => {
    assert.match(serp, /action: 'overlayStateChanged', serpOverlayActive: _serpOverlayOn/);
  });
});

describe('the DOM bridge between the two isolated worlds', () => {
  test('content-serp.js sets and clears the same dataset key it defines', () => {
    assert.match(serp, /const SERP_BRIDGE_ATTR\s*=\s*'([^']+)'/);
    const key = serp.match(/const SERP_BRIDGE_ATTR\s*=\s*'([^']+)'/)[1];
    assert.match(serp, new RegExp(`dataset\\[SERP_BRIDGE_ATTR\\]\\s*=\\s*'true'`));
    assert.match(serp, new RegExp(`delete document\\.documentElement\\.dataset\\[SERP_BRIDGE_ATTR\\]`));
    // content.js's readers use the literal dataset property name, not the
    // constant (separate isolated world, can't import it) — this is the
    // exact string that must match byte-for-byte.
    assert.equal(key, 'seoSerpOverlayActive', 'the bridge key changed — update content.js\'s readers too');
  });

  test('content.js reads the bridge through one shared helper, using the same literal key', () => {
    assert.match(content, /function seoSerpOverlayActive\(\)/);
    assert.match(content, /dataset\.seoSerpOverlayActive === 'true'/);
  });

  test('getPageData and getOverlayState both report serpOverlayActive', () => {
    assert.match(content, /serpOverlayActive: seoSerpOverlayActive\(\)/g);
    const count = (content.match(/serpOverlayActive: seoSerpOverlayActive\(\)/g) || []).length;
    assert.equal(count, 2, 'expected exactly getPageData and getOverlayState to report it');
  });
});

describe('everything that displays the toggle was wired up', () => {
  test('the toolbar menu carries the new entry as per-page', () => {
    assert.match(core, /key: 'serpOverlayActive', fallback: false, perPage: true, action: 'toggleSerpOverlay'/);
  });

  test('the panel guards each field on presence, so one script\'s broadcast cannot stomp another\'s button', () => {
    assert.match(popup, /'altOverlayActive' in msg/);
    assert.match(popup, /'linkOverlayActive' in msg/);
    assert.match(popup, /'serpOverlayActive' in msg/);
  });

  test('the panel has a render function and a click handler for the SERP toggle', () => {
    assert.match(popup, /function renderSerpOverlayToggle\(active\)/);
    assert.match(popup, /btn-serp-overlay/);
    assert.match(popup, /action: 'toggleSerpOverlay'/);
  });
});

describe('the Option/Alt+O keyboard shortcut', () => {
  test('the page-side listener matches the physical O key, not e.key', () => {
    // e.code, not e.key — macOS rewrites Option+O's e.key to "ø".
    assert.match(serp, /e\.code !== 'KeyO'/);
  });

  test('it is skipped while an editable element has focus, so Google\'s own search box still works', () => {
    assert.match(serp, /function serpEditableHasFocus\(\)/);
    assert.match(serp, /if \(serpEditableHasFocus\(\)\) return;/);
  });

  test('it calls the same toggle function the popup button and message handler use', () => {
    assert.match(serp, /if \(e\.code !== 'KeyO'\) return;[\s\S]{0,120}toggleSerpOverlayState\(\);/);
  });

  test('the panel-side shortcut table maps Alt+O to the SERP toggle button', () => {
    assert.match(nav, /KeyO: 'btn-serp-overlay'/);
  });
});

describe('the manifest registers content-serp.js as its own, narrowly-scoped entry', () => {
  test('it is a separate content_scripts entry, not merged into <all_urls>', () => {
    const entries = manifest.content_scripts;
    const serpEntry = entries.find(e => (e.js || []).includes('content-serp.js'));
    assert.ok(serpEntry, 'no content_scripts entry ships content-serp.js');
    assert.ok(!serpEntry.matches.includes('<all_urls>'), 'content-serp.js must not run on every page');
    const allUrlsEntry = entries.find(e => (e.matches || []).includes('<all_urls>'));
    assert.ok(allUrlsEntry && !(allUrlsEntry.js || []).includes('content-serp.js'),
      'content-serp.js must not be bundled into the <all_urls> entry');
  });

  test('it only loads on a Google search results page', () => {
    const serpEntry = manifest.content_scripts.find(e => (e.js || []).includes('content-serp.js'));
    assert.deepEqual(serpEntry.matches, ['*://www.google.com/search*']);
  });

  test('it does not run in every frame — a SERP result is never in an iframe', () => {
    const serpEntry = manifest.content_scripts.find(e => (e.js || []).includes('content-serp.js'));
    assert.equal(serpEntry.all_frames, false);
  });
});
