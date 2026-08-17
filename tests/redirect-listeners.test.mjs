// Drives the real webRequest listeners through the event sequence a browser
// actually emits, which nothing else in the suite does — redirect-queue.test.mjs
// stops at `browser.webRequest.onBeforeRequest` and only covers the queue
// helper beneath them.
//
// The bug this was written for: a plain click on a link that 301s recorded a
// ONE-hop chain ending at the destination, so the panel and the export both
// reported "Redirects: 0" for a link the Link Health overlay had correctly
// flagged as redirecting.
//
// Cause: a server redirect fires onBeforeRequest a SECOND time, for the
// redirect target, carrying the same requestId. The listener reset
// `chain: []` unconditionally, wiping the hop onBeforeRedirect had just
// recorded a moment earlier. The surviving chain then looked like a direct
// navigation to the destination.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { backgroundSource } from './helpers.mjs';

const src = await backgroundSource();

/** Boots the background and hands back its captured webRequest listeners. */
function boot() {
  const listeners = {};
  const capture = (name) => ({
    addListener: (fn) => { (listeners[name] = listeners[name] || []).push(fn); },
    removeListener: (fn) => {
      listeners[name] = (listeners[name] || []).filter(f => f !== fn);
    }
  });

  const auto = () => new Proxy(function () {}, {
    get: (t, p) => (p === 'then' || typeof p === 'symbol') ? undefined : auto(),
    apply: () => auto()
  });

  const session = {};
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
    webRequest: {
      onBeforeRequest:   capture('onBeforeRequest'),
      onBeforeRedirect:  capture('onBeforeRedirect'),
      onCompleted:       capture('onCompleted'),
      onErrorOccurred:   capture('onErrorOccurred'),
      onHeadersReceived: capture('onHeadersReceived')
    },
    storage: { local: area({}), sync: area({}), session: area(session), onChanged: { addListener() {} } },
    runtime: {
      onMessage: { addListener() {} }, onInstalled: { addListener() {} },
      getURL: () => 'moz-extension://test/', sendMessage: () => Promise.resolve({}),
      lastError: null
    }
  };

  const ctx = {
    console, URL, URLSearchParams, Date, Math, JSON, RegExp, String, Object, Array, Set, Map, Promise,
    setTimeout, clearTimeout, setInterval, clearInterval,
    crypto: globalThis.crypto, TextEncoder, btoa: globalThis.btoa, atob: globalThis.atob,
    fetch: () => Promise.reject(new Error('no network in this suite')),
    browser: new Proxy(real, { get: (t, p) => (p in t ? t[p] : auto()) })
  };
  vm.createContext(ctx);
  vm.runInContext(`${src}
;globalThis.__x = { redirectByTab };`, ctx);

  const fire = async (name, details) => {
    for (const fn of listeners[name] || []) await fn(details);
    // The listeners route writes through a per-tab promise queue; let it drain.
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
  };

  // Copy out of the vm realm — arrays built inside it fail deepEqual on
  // identity even when the contents match.
  const entry = (tabId) => {
    const e = ctx.__x.redirectByTab.get(tabId);
    return e ? JSON.parse(JSON.stringify(e)) : undefined;
  };
  return { fire, entry };
}

const WWW = 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11330818/';
const PMC = 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11330818/';
const TAB = 7;

/** The exact event order a browser emits for a single 301 on a main-frame click. */
async function playRedirectNavigation(b, { requestId = 'R1', tabId = TAB } = {}) {
  const base = { tabId, frameId: 0, requestId, type: 'main_frame' };
  await b.fire('onBeforeRequest',  { ...base, url: WWW, timeStamp: 1000 });
  await b.fire('onBeforeRedirect', { ...base, url: WWW, statusCode: 301, redirectUrl: PMC, timeStamp: 1100 });
  // The part that was missing from every test: the SECOND onBeforeRequest,
  // for the redirect target, with the SAME requestId.
  await b.fire('onBeforeRequest',  { ...base, url: PMC, timeStamp: 1105 });
  await b.fire('onCompleted',      { ...base, url: PMC, statusCode: 200, timeStamp: 1300 });
}

describe('a server redirect on a plain click', () => {
  test('records both hops, not just the destination', async () => {
    // The reported failure: this chain came back length 1, so the panel and the
    // export both said "Redirects: 0" for a link that plainly 301s.
    const b = boot();
    await playRedirectNavigation(b);
    const chain = b.entry(TAB).chain;
    assert.equal(chain.length, 2, `expected 2 hops, got ${JSON.stringify(chain)}`);
  });

  test('the chain starts at the URL that was requested', async () => {
    const b = boot();
    await playRedirectNavigation(b);
    assert.equal(b.entry(TAB).chain[0].url, WWW);
    assert.equal(b.entry(TAB).chain[0].status, 301);
  });

  test('and ends at the destination', async () => {
    const b = boot();
    await playRedirectNavigation(b);
    const chain = b.entry(TAB).chain;
    assert.equal(chain[chain.length - 1].url, PMC);
    assert.equal(chain[chain.length - 1].status, 200);
    assert.equal(b.entry(TAB).finalUrl, PMC);
  });

  test('the total time spans the whole navigation, not just the last hop', async () => {
    // startedAt must survive the second onBeforeRequest too, or the timing
    // silently reports only the post-redirect leg.
    const b = boot();
    await playRedirectNavigation(b);
    assert.equal(b.entry(TAB).totalMs, 300);
  });

  test('a two-hop chain still works', async () => {
    const b = boot();
    const base = { tabId: TAB, frameId: 0, requestId: 'R9', type: 'main_frame' };
    const MID = 'https://mid.example/';
    await b.fire('onBeforeRequest',  { ...base, url: WWW, timeStamp: 1000 });
    await b.fire('onBeforeRedirect', { ...base, url: WWW, statusCode: 301, timeStamp: 1050 });
    await b.fire('onBeforeRequest',  { ...base, url: MID, timeStamp: 1055 });
    await b.fire('onBeforeRedirect', { ...base, url: MID, statusCode: 302, timeStamp: 1100 });
    await b.fire('onBeforeRequest',  { ...base, url: PMC, timeStamp: 1105 });
    await b.fire('onCompleted',      { ...base, url: PMC, statusCode: 200, timeStamp: 1200 });
    assert.deepEqual(b.entry(TAB).chain.map(h => h.url), [WWW, MID, PMC]);
    assert.deepEqual(b.entry(TAB).chain.map(h => h.status), [301, 302, 200]);
  });
});

describe('a genuinely new navigation still resets', () => {
  test('a different requestId starts a fresh chain', async () => {
    // The reset has to keep working — this is what stops one page's chain
    // bleeding into the next.
    const b = boot();
    await playRedirectNavigation(b);
    const base = { tabId: TAB, frameId: 0, requestId: 'R2', type: 'main_frame' };
    await b.fire('onBeforeRequest', { ...base, url: 'https://elsewhere.example/', timeStamp: 2000 });
    await b.fire('onCompleted',     { ...base, url: 'https://elsewhere.example/', statusCode: 200, timeStamp: 2100 });
    assert.deepEqual(b.entry(TAB).chain.map(h => h.url), ['https://elsewhere.example/']);
  });

  test('the finished previous chain is kept for client-redirect stitching', async () => {
    const b = boot();
    await playRedirectNavigation(b);
    const base = { tabId: TAB, frameId: 0, requestId: 'R2', type: 'main_frame' };
    await b.fire('onBeforeRequest', { ...base, url: 'https://elsewhere.example/', timeStamp: 2000 });
    assert.deepEqual((b.entry(TAB).prevChain || []).map(h => h.url), [WWW, PMC]);
  });

  test('a direct navigation with no redirect is a single hop', async () => {
    const b = boot();
    const base = { tabId: TAB, frameId: 0, requestId: 'R3', type: 'main_frame' };
    await b.fire('onBeforeRequest', { ...base, url: PMC, timeStamp: 1000 });
    await b.fire('onCompleted',     { ...base, url: PMC, statusCode: 200, timeStamp: 1100 });
    assert.deepEqual(b.entry(TAB).chain.map(h => h.url), [PMC]);
    assert.equal(b.entry(TAB).totalMs, 100);
  });

  test('a sub-frame navigation is ignored entirely', async () => {
    const b = boot();
    const base = { tabId: TAB, frameId: 3, requestId: 'R4', type: 'sub_frame' };
    await b.fire('onBeforeRequest', { ...base, url: 'https://iframe.example/', timeStamp: 1000 });
    assert.equal(b.entry(TAB), undefined);
  });

  test('two tabs redirect independently', async () => {
    const b = boot();
    await playRedirectNavigation(b, { requestId: 'A', tabId: 1 });
    await playRedirectNavigation(b, { requestId: 'B', tabId: 2 });
    assert.equal(b.entry(1).chain.length, 2);
    assert.equal(b.entry(2).chain.length, 2);
  });
});
