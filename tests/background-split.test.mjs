// Guards the background's multi-file arrangement.
//
// The background is several files sharing ONE global scope — Chrome loads them
// through importScripts() in the generated sw.js, Firefox through
// manifest background.scripts. That means the load order is declared twice, in
// two different formats, and a mismatch is not a build error: the extension
// would install fine and then throw ReferenceError the first time it touched a
// function from the file nobody loaded. These tests make that drift impossible.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, DIST, readJson, backgroundSource } from './helpers.mjs';
import { BACKGROUND_FILES } from '../scripts/build.mjs';

describe('the file list', () => {
  test('every listed file exists', () => {
    for (const f of BACKGROUND_FILES) {
      assert.ok(existsSync(path.join(ROOT, f)), `${f} is in BACKGROUND_FILES but not on disk`);
    }
  });

  test('every bg-*.js on disk is listed', async () => {
    // The reverse direction: a new file that nobody wired up would otherwise
    // sit there silently, never loaded, its handlers permanently missing.
    const found = (await readdir(ROOT)).filter(f => /^bg-.*\.js$/.test(f)).sort();
    assert.deepEqual(found, [...BACKGROUND_FILES].sort(), 'a bg-*.js file is not in BACKGROUND_FILES');
  });

  test('bg-core.js loads first', () => {
    // It is the only file that executes anything at load time, and it defines
    // the capability flags and shared helpers the rest read.
    assert.equal(BACKGROUND_FILES[0], 'bg-core.js');
  });
});

describe('the two declarations agree', () => {
  test('manifest.firefox.json matches BACKGROUND_FILES exactly, in order', async () => {
    const m = await readJson(path.join(ROOT, 'manifest.firefox.json'));
    assert.deepEqual(m.background.scripts, BACKGROUND_FILES);
  });

  test("the built Chrome sw.js importScripts the same files, after the polyfill", async () => {
    const sw = await readFile(path.join(DIST, 'chrome', 'sw.js'), 'utf8');
    const args = [...sw.matchAll(/'([^']+)'/g)].map(m => m[1]);
    assert.equal(args[0], 'browser-polyfill.js', 'the polyfill must load before any background file');
    assert.deepEqual(args.slice(1), BACKGROUND_FILES);
  });

  test('the built Firefox manifest carries the same list', async () => {
    const m = await readJson(path.join(DIST, 'firefox', 'manifest.json'));
    assert.deepEqual(m.background.scripts, BACKGROUND_FILES);
  });
});

describe('load-order safety', () => {
  test('no file outside bg-core.js reads a value at load time', async () => {
    // The hazard is a top-level statement that *reads* a binding from a file
    // that hasn't loaded yet — a temporal-dead-zone crash at startup.
    //
    // Registering an event listener is exempt and safe at any position: it
    // hands over a callback whose body doesn't run until the event fires, long
    // after every file has loaded. bg-router.js relies on exactly that to
    // register the onMessage router ahead of the handlers it dispatches to.
    const REGISTRATION = /^browser\.[A-Za-z.?]+\.(addListener|removeListener)\(/;
    for (const f of BACKGROUND_FILES.filter(x => x !== 'bg-core.js')) {
      const src = await readFile(path.join(ROOT, f), 'utf8');
      const offenders = src.split('\n')
        .map((l, i) => [i + 1, l])
        .filter(([, l]) =>
          /^[A-Za-z_$]/.test(l) &&                             // starts at column 0
          !/^(?:async\s+)?function\s/.test(l) &&               // not a declaration
          !/^(?:const|let|var)\s/.test(l) &&
          !REGISTRATION.test(l))
        .map(([n, l]) => `${n}: ${l.trim().slice(0, 60)}`);
      assert.deepEqual(offenders, [], `${f} executes something at load time`);
    }
  });

  test('the whole background still parses when concatenated in order', async () => {
    // The browser evaluates these into one scope; a duplicate top-level const
    // across two files parses fine alone and throws only once joined.
    const src = await backgroundSource();
    assert.doesNotThrow(() => new Function(src));
  });

  test('it evaluates in load order and registers its listeners', async () => {
    // The closest thing to actually starting the extension. Parsing proves the
    // syntax survived the split; only evaluating proves the ORDER did — a
    // top-level read of a not-yet-declared const throws here and nowhere else.
    const registered = [];
    const listenerSlot = (name) => ({ addListener: () => registered.push(name) });
    const auto = () => new Proxy(function () {}, {
      get: (t, p) => (p === 'then' || typeof p === 'symbol') ? undefined
        : (typeof p === 'string' && p.startsWith('on')) ? listenerSlot(p) : auto(),
      apply: () => auto()
    });
    const area = () => ({
      get: () => Promise.resolve({}), set: () => Promise.resolve(),
      remove: () => Promise.resolve()
    });

    const ctx = {
      console, URL, URLSearchParams, Date, Math, JSON, RegExp, String, Object, Array,
      setTimeout, clearTimeout, setInterval, clearInterval,
      crypto: globalThis.crypto, TextEncoder, btoa: globalThis.btoa, atob: globalThis.atob,
      fetch: () => Promise.reject(new Error('no network at load time')),
      browser: new Proxy({
        storage: { local: area(), sync: area(), session: area(), onChanged: listenerSlot('storage.onChanged') },
        runtime: { onMessage: listenerSlot('runtime.onMessage'), onInstalled: listenerSlot('runtime.onInstalled'), getURL: () => 'moz-extension://test/' }
      }, { get: (t, p) => (p in t ? t[p] : auto()) })
    };
    vm.createContext(ctx);
    const src = await backgroundSource();
    assert.doesNotThrow(
      () => vm.runInContext(src, ctx),
      'the background threw while loading — check for a top-level read of a later file'
    );

    // The router is the last file; if it registered, everything before it ran.
    assert.ok(registered.includes('runtime.onMessage'), 'the message router never registered');
    assert.ok(registered.includes('storage.onChanged'), 'bg-core never registered its storage listener');
  });
});
