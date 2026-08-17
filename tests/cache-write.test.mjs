// Tests writeCache — the single path every background cache write now takes.
//
// It exists for a failure that only appears on somebody else's machine: the
// old unguarded `storage.local.set` sat between a successful API fetch and its
// return, so a full storage quota surfaced as "the fetch failed" for a fetch
// that had actually worked. That is unreproducible from a bug report, so the
// behaviour is pinned here instead.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './helpers.mjs';

const src = await readFile(path.join(ROOT, 'bg-core.js'), 'utf8');
const START = '// ─── Cache writes';

test('the helper is still where the test expects it', () => {
  assert.ok(src.indexOf(START) !== -1, `could not find "${START}" in bg-core.js`);
});

/**
 * Runs the real writeCache with a storage layer that can be made to fail.
 * `onSet` returning a rejected promise models a quota error.
 */
function boot({ onSet } = {}) {
  const written = {};
  const warnings = [];
  const ctx = {
    console: { ...console, warn: (m) => warnings.push(String(m)) },
    Object, Math, JSON, Date, String, Array, Promise,
    browser: {
      storage: {
        local: {
          set: (o) => onSet ? onSet(o) : (Object.assign(written, o), Promise.resolve())
        }
      }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(src.indexOf(START))}
;globalThis.__x = { writeCache, CACHE_CAP_GENEROUS };`, ctx);
  return { ...ctx.__x, written, warnings };
}

/** A cache of `n` entries, oldest first by fetchedAt. */
const makeCache = (n, stampField = 'fetchedAt') => {
  const c = {};
  for (let i = 0; i < n; i++) c[`k${i}`] = { [stampField]: 1000 + i, v: i };
  return c;
};

describe('surviving a failed write', () => {
  test('a quota error does not throw — the caller keeps its data', async () => {
    // The whole reason this helper exists.
    const b = boot({ onSet: () => Promise.reject(new Error('QUOTA_BYTES quota exceeded')) });
    const ok = await assert.doesNotReject(() => b.writeCache('webceoCache', { a: { fetchedAt: 1 } }));
    assert.equal(ok, undefined);
  });

  test('and reports false so a caller could tell', async () => {
    const b = boot({ onSet: () => Promise.reject(new Error('quota')) });
    assert.equal(await b.writeCache('webceoCache', { a: { fetchedAt: 1 } }), false);
  });

  test('a failed write is logged, not swallowed silently', async () => {
    // Silent failure is what makes this class of bug undiagnosable.
    const b = boot({ onSet: () => Promise.reject(new Error('quota exceeded')) });
    await b.writeCache('webceoCache', { a: { fetchedAt: 1 } });
    assert.equal(b.warnings.length, 1);
    assert.match(b.warnings[0], /webceoCache/);
    assert.match(b.warnings[0], /quota exceeded/);
  });

  test('a successful write reports true and persists under the given key', async () => {
    const b = boot();
    assert.equal(await b.writeCache('webceoCache', { a: { fetchedAt: 1 } }), true);
    assert.deepEqual(Object.keys(b.written), ['webceoCache']);
    assert.equal(b.warnings.length, 0, 'a normal write should be quiet');
  });
});

describe('the cap', () => {
  test('is generous enough never to bind on a realistic install', () => {
    // These caches hold one entry per client. If this number ever drops toward
    // a real working set, the FIFO note in bg-core.js starts to matter.
    const b = boot();
    assert.ok(b.CACHE_CAP_GENEROUS >= 200, 'the cap is meant to be a backstop, not a working-set limit');
  });

  test('does nothing at all below the limit', async () => {
    const b = boot();
    const cache = makeCache(50);
    await b.writeCache('webceoCache', cache, 200);
    assert.equal(Object.keys(cache).length, 50);
    assert.equal(b.warnings.length, 0);
  });

  test('evicts down to exactly the cap when exceeded', async () => {
    const b = boot();
    const cache = makeCache(25);
    await b.writeCache('webceoCache', cache, 20);
    assert.equal(Object.keys(cache).length, 20);
  });

  test('drops the OLDEST entries first', async () => {
    const b = boot();
    const cache = makeCache(25);
    await b.writeCache('webceoCache', cache, 20);
    assert.ok(!('k0' in cache), 'the oldest entry should have gone');
    assert.ok('k24' in cache, 'the newest entry should have stayed');
  });

  test('eviction is loud, because it means an assumption here is wrong', async () => {
    const b = boot();
    await b.writeCache('webceoCache', makeCache(25), 20);
    assert.equal(b.warnings.length, 1);
    assert.match(b.warnings[0], /webceoCache/);
    assert.match(b.warnings[0], /evicted 5/);
  });

  test('honours updatedAt for caches that stamp that instead', async () => {
    // sheetsSpreadsheetIds uses updatedAt. Reading only fetchedAt would make
    // every entry sort as 0 and turn its eviction order into arbitrary.
    const b = boot();
    const cache = makeCache(25, 'updatedAt');
    await b.writeCache('sheetsSpreadsheetIds', cache, 20);
    assert.ok(!('k0' in cache));
    assert.ok('k24' in cache);
  });

  test('an entry with no timestamp at all sorts oldest rather than throwing', async () => {
    const b = boot();
    const cache = { ...makeCache(20), orphan: { v: 1 } };
    await assert.doesNotReject(() => b.writeCache('webceoCache', cache, 20));
    assert.ok(!('orphan' in cache), 'the untimestamped entry should be evicted first');
  });
});

describe('every cache write goes through it', () => {
  test('no bare storage.local.set of a cache object is left in the background', async () => {
    // The guard is only worth anything if nothing bypasses it. A new cache
    // added with a raw set() would reintroduce exactly the bug this fixes.
    const files = (await readdir(ROOT)).filter(f => /^bg-.*\.js$/.test(f));
    const offenders = [];
    for (const f of files) {
      const text = await readFile(path.join(ROOT, f), 'utf8');
      text.split('\n').forEach((l, i) => {
        if (/storage\.local\.set\(\{\s*[a-zA-Z]*(Cache|SpreadsheetIds|FolderIds)\s*:/.test(l)) {
          offenders.push(`${f}:${i + 1}`);
        }
      });
    }
    assert.deepEqual(offenders, [], 'these cache writes bypass writeCache and are unguarded');
  });
});
