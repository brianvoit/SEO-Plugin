// Tests bg-core.js's commands.onCommand handler — the Alt+M shortcut that
// opens Chrome's side panel.
//
// Chrome rejects sidePanel.open() unless it is called while the user-gesture
// context is still live, and that context does NOT survive an await. The bug
// this guards was exactly that: the handler awaited windows.getCurrent() to
// read a window id, so by the time it called open() the gesture was gone and
// Chrome could refuse the shortcut. It can't be caught by a browser-free
// smoke test and it can't be caught by reading the code — "did it await?" is
// a runtime property. So the real handler is sliced out of bg-core.js and
// run against fakes that record WHEN each call happens, not just whether.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

const START = 'if (browser.commands?.onCommand)';
const END = '// ─── Pop-out window';

const src = await readFile(path.join(ROOT, 'bg-core.js'), 'utf8');
const from = src.indexOf(START);
const to = src.indexOf(END);

test('the command handler is still where the test expects it', () => {
  assert.ok(from !== -1, `could not find "${START}" in bg-core.js — update this test's slice markers`);
  assert.ok(to > from, `could not find "${END}" after the command handler`);
});

const source = src.slice(from, to);

/** Fresh sandbox per test: the real listener, fakes that record call order. */
function makeSandbox({ hasSidePanel = true, openRejects = false } = {}) {
  const calls = [];
  let listener = null;

  const browser = {
    commands: { onCommand: { addListener: (fn) => { listener = fn; } } },
    windows: {
      getCurrent: async () => {
        calls.push('windows.getCurrent');
        return { id: 77 };
      }
    }
  };

  const sidePanel = {
    open: ({ windowId }) => {
      calls.push(`sidePanel.open(${windowId})`);
      return openRejects ? Promise.reject(new Error('no active gesture')) : Promise.resolve();
    }
  };

  new Function('browser', 'HAS_SIDE_PANEL', 'sidePanel', source)(browser, hasSidePanel, sidePanel);

  return { fire: (...args) => listener(...args), calls, registered: () => listener !== null };
}

describe('with the active tab supplied (the normal Chrome path)', () => {
  let s;
  beforeEach(() => { s = makeSandbox(); });

  test('opens the panel SYNCHRONOUSLY, keeping the user gesture', () => {
    // The regression: any await before open() loses the gesture and Chrome
    // rejects the call. Asserting before yielding to the microtask queue is
    // what makes this a gesture test rather than a "did it open" test.
    s.fire('toggle-side-panel', { windowId: 12 });
    assert.deepEqual(s.calls, ['sidePanel.open(12)'],
      'open() did not run inline — the handler deferred and the gesture is lost');
  });

  test('never consults windows.getCurrent when the tab already carries a window id', async () => {
    s.fire('toggle-side-panel', { windowId: 12 });
    await new Promise(r => setTimeout(r, 0));
    assert.ok(!s.calls.includes('windows.getCurrent'),
      'took the awaiting fallback path even though tab.windowId was available');
  });

  test('a windowId of 0 is still used, not treated as missing', async () => {
    // Guards a `tab.windowId ||` style regression: 0 is falsy but valid.
    s.fire('toggle-side-panel', { windowId: 0 });
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(s.calls, ['sidePanel.open(0)']);
  });
});

describe('without a tab (documented as optional)', () => {
  let s;
  beforeEach(() => { s = makeSandbox(); });

  test('falls back to looking the window up', async () => {
    s.fire('toggle-side-panel', undefined);
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(s.calls, ['windows.getCurrent', 'sidePanel.open(77)'],
      'the shortcut did nothing at all when the tab was absent');
  });

  test('also falls back when the tab carries no window id', async () => {
    s.fire('toggle-side-panel', {});
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(s.calls, ['windows.getCurrent', 'sidePanel.open(77)']);
  });
});

describe('guards', () => {
  test('ignores other commands', async () => {
    const s = makeSandbox();
    s.fire('some-other-command', { windowId: 12 });
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(s.calls, []);
  });

  test('does nothing where there is no side panel (Firefox uses _execute_sidebar_action)', async () => {
    const s = makeSandbox({ hasSidePanel: false });
    s.fire('toggle-side-panel', { windowId: 12 });
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(s.calls, []);
  });

  test('a rejected open() is swallowed, not left unhandled', async () => {
    // An unhandled rejection in a service worker is noisy and can be fatal;
    // open() legitimately rejects (no gesture, panel already open).
    const s = makeSandbox({ openRejects: true });
    let unhandled = null;
    const onUnhandled = (err) => { unhandled = err; };
    process.on('unhandledRejection', onUnhandled);
    s.fire('toggle-side-panel', { windowId: 12 });
    await new Promise(r => setTimeout(r, 10));
    process.off('unhandledRejection', onUnhandled);
    assert.equal(unhandled, null, 'open()\'s rejection escaped the handler');
  });

  test('the fallback path also swallows a rejection', async () => {
    const s = makeSandbox({ openRejects: true });
    let unhandled = null;
    const onUnhandled = (err) => { unhandled = err; };
    process.on('unhandledRejection', onUnhandled);
    s.fire('toggle-side-panel', undefined);
    await new Promise(r => setTimeout(r, 10));
    process.off('unhandledRejection', onUnhandled);
    assert.equal(unhandled, null);
  });
});
