// The overlays must be per-page, and nothing may switch one on at load time.
//
// Reported: link-health boxes appearing on pages the user never enabled them
// on. Cause: `altOverlayActive` / `linkOverlayActive` were global
// storage.local flags, and every top-frame content script re-applied them at
// load — on every site, forever, once either had been switched on anywhere.
//
// That was not only visual noise. applyLinkOverlay probes up to LINK_CHECK_MAX
// URLs through the background, so the restore meant silently firing hundreds
// of requests at third-party links on every page load. It looked intermittent
// only because outlines are drawn solely for links that redirect or break.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

const content = await readFile(path.join(ROOT, 'content.js'), 'utf8');
const core    = await readFile(path.join(ROOT, 'bg-core.js'), 'utf8');
const popup   = await readFile(path.join(ROOT, 'popup-inspector.js'), 'utf8');

describe('no overlay survives a page load', () => {
  test('neither overlay flag is read from storage anywhere in the content script', () => {
    // The single most important assertion here: if this string comes back,
    // some load path can switch an overlay on without the user asking.
    const reads = content.match(/storage\.local\.get\([^)]*OverlayActive[^)]*\)/g) || [];
    assert.deepEqual(reads, [], 'the content script reads an overlay flag from storage again');
  });

  test('neither overlay flag is written to storage either', () => {
    const writes = content.match(/storage\.local\.set\([^)]*OverlayActive[^)]*\)/g) || [];
    assert.deepEqual(writes, [], 'overlay state is persisting again');
  });

  test('applyLinkOverlay and applyOverlay are only reachable from a toggle', () => {
    // Every call site must be inside a toggle function. A call from any
    // load-time block is the bug returning.
    ['applyLinkOverlay()', 'applyOverlay()'].forEach(call => {
      const idxs = [...content.matchAll(new RegExp(call.replace('(', '\\(').replace(')', '\\)'), 'g'))]
        .map(m => m.index);
      assert.ok(idxs.length, `${call} is never called — did it get renamed?`);
      const callSites = idxs
        .map(i => content.slice(content.lastIndexOf('\n', i) + 1, content.indexOf('\n', i)))
        .filter(line => !/^function /.test(line));   // the declaration itself
      assert.ok(callSites.length, `${call} has no call sites — did it get renamed?`);
      callSites.forEach(line => {
        assert.match(line, /^\s*if \(_(alt|link)OverlayOn\)/,
          `${call} is invoked outside a toggle: "${line.trim()}"`);
      });
    });
  });

  test('the state lives in per-document variables', () => {
    assert.match(content, /^let _altOverlayOn = false;$/m);
    assert.match(content, /^let _linkOverlayOn = false;$/m);
  });

  test('both toggles start from the local variable, not a stored value', () => {
    assert.match(content, /_altOverlayOn = !_altOverlayOn;/);
    assert.match(content, /_linkOverlayOn = !_linkOverlayOn;/);
  });

  test('getPageData reports the live per-page state', () => {
    assert.match(content, /altOverlayActive: _altOverlayOn, linkOverlayActive: _linkOverlayOn/);
  });
});

describe('everything that displayed the old flag was rewired', () => {
  test('the panel no longer watches storage for overlay changes', () => {
    assert.doesNotMatch(popup, /changes\.(alt|link)OverlayActive/);
  });

  test('the panel listens for the content script announcement instead', () => {
    assert.match(popup, /msg\.action !== 'overlayStateChanged'/);
    assert.match(popup, /renderLinkOverlayToggle\(!!msg\.linkOverlayActive\)/);
  });

  test('a toggle from the page side announces itself', () => {
    // Alt+I / Alt+L and the toolbar menu all route through the toggles, so
    // announcing there covers every path that isn't the panel's own button.
    const fn = content.slice(content.indexOf('function announceOverlayState'));
    assert.match(fn.slice(0, 400), /action: 'overlayStateChanged'/);
    assert.match(content, /function toggleAltOverlayState\(\)[\s\S]{0,220}announceOverlayState\(\)/);
    assert.match(content, /function toggleLinkOverlayState\(\)[\s\S]{0,220}announceOverlayState\(\)/);
  });

  test('the content script can report its state for the menu checkmarks', () => {
    assert.match(content, /message\.action === 'getOverlayState'/);
  });

  test('the menu marks the two overlays as per-page, not stored', () => {
    assert.match(core, /key: 'altOverlayActive',\s+fallback: false, perPage: true/);
    assert.match(core, /key: 'linkOverlayActive', fallback: false, perPage: true/);
  });

  test('followActiveTab stays a genuine global preference', () => {
    // It is not per-page and must keep persisting; only the overlays moved.
    const line = core.split('\n').find(l => l.includes("key: 'followActiveTab'"));
    assert.ok(line && !line.includes('perPage'), 'followActiveTab should not be per-page');
  });

  test('checkmarks for the overlays are read from the tab', () => {
    assert.match(core, /const checked = item\.perPage \? !!live\[item\.key\] : seoToggleChecked\(item, stored\)/);
    assert.match(core, /action: 'getOverlayState'/);
  });

  test('an unreachable tab reports no overlay rather than throwing', () => {
    // about:, the PDF viewer and AMO have no content script; they cannot have
    // an overlay, so empty is the right answer.
    const fn = core.slice(core.indexOf('async function activeTabOverlayState'), core.indexOf('// Firefox\'s richer'));
    assert.match(fn, /catch \{\s*return \{\};/);
  });

  test('stale flags from older installs are cleared once on update', () => {
    assert.match(core, /storage\.local\.remove\(\['altOverlayActive', 'linkOverlayActive'\]\)/);
  });
});
