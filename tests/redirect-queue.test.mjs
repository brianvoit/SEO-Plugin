// Tests background.js's withRedirectEntry() — the per-tab queue that keeps
// redirect chains intact across a Chrome service-worker restart.
//
// This is the one piece of genuinely concurrent code in the extension, it
// guards correctness rather than polish, and it cannot be exercised without a
// browser — so it's tested here by slicing the real function text out of
// background.js and running it against fake storage. Testing a reimplementation
// would prove nothing; this runs the shipped code.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

const START = 'const _redirectQueue = new Map()';
const END = 'browser.webRequest.onBeforeRequest';

const src = await readFile(path.join(ROOT, 'background.js'), 'utf8');
const from = src.indexOf(START);
const to = src.indexOf(END);

test('the queue implementation is still where the test expects it', () => {
  assert.ok(from !== -1, `could not find "${START}" in background.js — update this test's slice markers`);
  assert.ok(to > from, `could not find "${END}" after the queue definition`);
});

const source = src.slice(from, to);

/** Fresh sandbox per test: real withRedirectEntry, fake Map + storage. */
function makeSandbox() {
  const redirectByTab = new Map();
  const storage = {};
  let loads = 0;

  async function loadRedirect(tabId) {
    if (redirectByTab.has(tabId)) return redirectByTab.get(tabId);
    loads++;
    await new Promise(r => setTimeout(r, 5));   // stand in for storage latency
    const stored = storage[`redirect:${tabId}`];
    // storage.session.get deserializes, handing back a FRESH object every
    // call — never a shared reference. Faithfully copying that here is what
    // makes the lost-update test meaningful: without serialization, two
    // concurrent misses each mutate their own copy and one set of hops is
    // silently discarded.
    const entry = stored ? structuredClone(stored) : null;
    if (entry) redirectByTab.set(tabId, entry);
    return entry;
  }

  const withRedirectEntry = new Function(
    'redirectByTab', 'loadRedirect', `${source}; return withRedirectEntry;`
  )(redirectByTab, loadRedirect);

  return { withRedirectEntry, redirectByTab, storage, loadCount: () => loads };
}

let s;
beforeEach(() => { s = makeSandbox(); });

describe('warm cache', () => {
  test('runs synchronously', () => {
    // Firefox's onHeadersReceived is a BLOCKING listener; deferring it onto a
    // promise chain would delay page loads. The warm path must not await.
    s.redirectByTab.set(1, { chain: [] });
    let ran = false;
    s.withRedirectEntry(1, () => { ran = true; });
    assert.equal(ran, true, 'warm lookup was deferred instead of running inline');
  });
});

describe('cold cache (after a service-worker restart)', () => {
  test('rehydrates the entry from session storage', async () => {
    s.storage['redirect:2'] = { requestId: 'r2', chain: ['a'] };
    let seen = null;
    await s.withRedirectEntry(2, e => { seen = e; });
    assert.equal(seen?.requestId, 'r2', 'entry was not restored from storage');
  });

  test('passes null through when nothing is stored', async () => {
    // Listeners do their own `if (!entry) return` — swallowing the call here
    // would silently change onBeforeRequest, which legitimately runs with none.
    let seen = 'never-called';
    await s.withRedirectEntry(99, e => { seen = e; });
    assert.equal(seen, null);
  });

  test('serializes concurrent events without losing updates', async () => {
    // The real failure this prevents: three webRequest events for one
    // navigation all miss the Map, all read-modify-write, and hops vanish.
    s.storage['redirect:3'] = { requestId: 'r3', chain: [] };
    await Promise.all([
      s.withRedirectEntry(3, e => { e.chain.push('hop1'); }),
      s.withRedirectEntry(3, e => { e.chain.push('hop2'); }),
      s.withRedirectEntry(3, e => { e.chain.push('hop3'); })
    ]);
    assert.deepEqual(s.redirectByTab.get(3).chain, ['hop1', 'hop2', 'hop3']);
  });

  test('rehydrates once for a burst, not once per event', async () => {
    s.storage['redirect:4'] = { chain: [] };
    await Promise.all([
      s.withRedirectEntry(4, () => {}),
      s.withRedirectEntry(4, () => {}),
      s.withRedirectEntry(4, () => {})
    ]);
    assert.equal(s.loadCount(), 1, 'each queued event hit storage separately');
  });
});

describe('resilience', () => {
  test('a throwing callback does not wedge the tab queue', async () => {
    s.storage['redirect:5'] = { chain: [] };
    await s.withRedirectEntry(5, () => { throw new Error('boom'); });
    let recovered = false;
    await s.withRedirectEntry(5, () => { recovered = true; });
    assert.equal(recovered, true, 'queue stalled after one handler threw');
  });

  test('an async callback is awaited before the next event runs', async () => {
    // onHeadersReceived's callback is async (it awaits getSecurityInfo).
    s.storage['redirect:6'] = { chain: [] };
    const order = [];
    await Promise.all([
      s.withRedirectEntry(6, async () => {
        order.push('slow-start');
        await new Promise(r => setTimeout(r, 15));
        order.push('slow-end');
      }),
      s.withRedirectEntry(6, () => { order.push('fast'); })
    ]);
    assert.deepEqual(order, ['slow-start', 'slow-end', 'fast'], 'second event overlapped the first');
  });
});
