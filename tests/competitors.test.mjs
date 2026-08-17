// Tests the competitor list: the client-level store (clientRegistrySetCompetitors)
// and the Web CEO push (webceoGetCompetitors / webceoSetCompetitors).
//
// The push is the interesting half. Web CEO documents `set_competitors` but not
// the NAME of the parameter that carries the list, and its API answers 200 to a
// call whose payload it ignored — so a write that changed nothing is
// indistinguishable from one that worked unless you read the value back. The
// shipped code tries a list of candidate names and only reports success once a
// re-read shows the value actually took. These tests pin exactly that: no
// candidate name may be reported as successful on the strength of its HTTP
// status alone.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { backgroundSource } from './helpers.mjs';

const src = await backgroundSource();

/**
 * A fake Web CEO endpoint.
 *
 * `acceptParam` is the one parameter name this fake server understands; a
 * set_competitors call using any other name is answered 200 and silently
 * dropped, which is the real API behaviour this feature has to survive.
 * `acceptParam: null` models a server that understands none of them.
 */
function makeWebceo({ acceptParam = 'competitors', stored = [], failSet = null } = {}) {
  const calls = [];
  let list = [...stored];

  const fetchMock = async (url, opts = {}) => {
    const body = JSON.parse(opts.body || '{}');
    calls.push({ method: body.method, data: body.data });
    const reply = (data, result = 0) => ({
      ok: true, status: 200,
      json: async () => [{ id: body.method, result, data }],
      text: async () => ''
    });

    if (body.method === 'get_projects') {
      return reply([{ project: 'p1', name: 'Acme', domain: 'acme.com' }]);
    }
    if (body.method === 'get_competitors') {
      return reply({ competitors: list.map(d => ({ domain: d })) });
    }
    if (body.method === 'set_competitors') {
      if (failSet) return reply(null, failSet);
      const d = body.data || {};
      if (acceptParam && Array.isArray(d[acceptParam])) list = [...d[acceptParam]];
      return reply({});
    }
    return reply(null, 10);
  };

  return { fetchMock, calls, current: () => list };
}

/** Boots the real background against fake storage and a fake Web CEO. */
function boot({ local = {}, sync = {}, fetchImpl } = {}) {
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
    storage: { local: area(local), sync: area(sync), session: area({}), onChanged: { addListener() {} } },
    runtime: {
      onMessage: { addListener() {} }, onInstalled: { addListener() {} },
      getURL: () => 'moz-extension://test/', sendMessage: () => Promise.resolve({})
    }
  };

  const ctx = {
    console, URL, URLSearchParams, Date, Math, JSON, RegExp, String, Object, Array, Set,
    setTimeout, clearTimeout, setInterval, clearInterval,
    crypto: globalThis.crypto, TextEncoder, btoa: globalThis.btoa, atob: globalThis.atob,
    fetch: fetchImpl || (() => Promise.reject(new Error('network is not used here'))),
    browser: new Proxy(real, { get: (t, p) => (p in t ? t[p] : auto()) })
  };
  vm.createContext(ctx);
  vm.runInContext(`${src}
;globalThis.__x = {
  webceoGetCompetitors, webceoSetCompetitors, webceoNormalizeCompetitors,
  SET_PARAM_CANDIDATES, clientRegistrySetCompetitors, clientRegistryNew,
  clientRegistrySave, clientRegistryGet
};`, ctx);
  return { ...ctx.__x, local, sync };
}

/**
 * Copies a value out of the vm realm. Arrays and objects built inside the vm
 * have that realm's prototypes, so deepEqual against a literal declared here
 * fails on identity even when the contents match.
 */
const plain = (v) => JSON.parse(JSON.stringify(v));

/** A registry holding one client, so the handlers have something to edit. */
async function withClient(b) {
  const res = await b.clientRegistrySave({ client: { name: 'Acme' } });
  return res.client;
}

describe('normalising whatever Web CEO hands back', () => {
  const b = boot();

  test('accepts a bare array of strings', () => {
    assert.deepEqual(plain(b.webceoNormalizeCompetitors(['a.com', 'b.com'])), ['a.com', 'b.com']);
  });

  test('accepts objects under any of the plausible keys', () => {
    assert.deepEqual(plain(b.webceoNormalizeCompetitors({ competitors: [{ domain: 'a.com' }] })), ['a.com']);
    assert.deepEqual(plain(b.webceoNormalizeCompetitors({ domains: [{ url: 'b.com' }] })), ['b.com']);
    assert.deepEqual(plain(b.webceoNormalizeCompetitors({ data: [{ site: 'c.com' }] })), ['c.com']);
  });

  test('strips protocol, www and path, and lowercases', () => {
    assert.deepEqual(plain(b.webceoNormalizeCompetitors(['https://WWW.Acme.com/pricing?x=1'])), ['acme.com']);
  });

  test('dedupes forms that normalise to the same domain', () => {
    assert.deepEqual(plain(b.webceoNormalizeCompetitors(['acme.com', 'https://www.acme.com/'])), ['acme.com']);
  });

  test('drops empties rather than emitting blank rows', () => {
    assert.deepEqual(plain(b.webceoNormalizeCompetitors(['', null, undefined, { }, 'a.com'])), ['a.com']);
  });

  test('an unrecognised shape is empty, not a throw', () => {
    assert.deepEqual(plain(b.webceoNormalizeCompetitors(42)), []);
    assert.deepEqual(plain(b.webceoNormalizeCompetitors(null)), []);
  });
});

describe('reading competitors from Web CEO', () => {
  test('returns the project\'s configured list', async () => {
    const wc = makeWebceo({ stored: ['rival.com', 'other.com'] });
    const b = boot({ local: { webceoApiKey: 'k' }, fetchImpl: wc.fetchMock });
    const res = await b.webceoGetCompetitors({ pageUrl: 'https://acme.com/x' });
    assert.deepEqual(plain(res.competitors), ['rival.com', 'other.com']);
  });

  test('reports NO_PROJECT rather than guessing when the domain is unmapped', async () => {
    const wc = makeWebceo();
    const b = boot({ local: { webceoApiKey: 'k' }, fetchImpl: wc.fetchMock });
    const res = await b.webceoGetCompetitors({ pageUrl: 'https://unknown.example/x' });
    assert.equal(res.error, 'NO_PROJECT');
  });

  test('an unconfigured Web CEO is "not connected", not an error', async () => {
    const b = boot({ local: {} });
    assert.deepEqual(plain(await b.webceoGetCompetitors({ pageUrl: 'https://acme.com/' })), { connected: false });
  });
});

describe('writing competitors to Web CEO', () => {
  test('the value actually lands on the server', async () => {
    const wc = makeWebceo({ acceptParam: 'competitors' });
    const b = boot({ local: { webceoApiKey: 'k' }, fetchImpl: wc.fetchMock });
    const res = await b.webceoSetCompetitors({ pageUrl: 'https://acme.com/', competitors: ['rival.com'] });
    assert.equal(res.ok, true);
    assert.deepEqual(wc.current(), ['rival.com']);
  });

  test('it finds the right parameter name even when it is not the first guess', async () => {
    // The whole point of the candidate list.
    const wc = makeWebceo({ acceptParam: 'domains' });
    const b = boot({ local: { webceoApiKey: 'k' }, fetchImpl: wc.fetchMock });
    const res = await b.webceoSetCompetitors({ pageUrl: 'https://acme.com/', competitors: ['rival.com'] });
    assert.equal(res.ok, true);
    assert.equal(res.param, 'domains');
  });

  test('it stops as soon as one name works — no pointless extra writes', async () => {
    const wc = makeWebceo({ acceptParam: 'competitors' });
    const b = boot({ local: { webceoApiKey: 'k' }, fetchImpl: wc.fetchMock });
    await b.webceoSetCompetitors({ pageUrl: 'https://acme.com/', competitors: ['rival.com'] });
    assert.equal(wc.calls.filter(c => c.method === 'set_competitors').length, 1);
  });

  test('a 200 that changed nothing is NOT reported as success', async () => {
    // The failure this design exists for. Every candidate gets a 200; none of
    // them writes anything.
    const wc = makeWebceo({ acceptParam: null });
    const b = boot({ local: { webceoApiKey: 'k' }, fetchImpl: wc.fetchMock });
    const res = await b.webceoSetCompetitors({ pageUrl: 'https://acme.com/', competitors: ['rival.com'] });
    assert.ok(!res.ok, 'a silently-ignored write must not report ok');
    assert.equal(res.error, 'SHAPE_UNKNOWN');
  });

  test('and it says which names it tried, so the next fix is a one-liner', async () => {
    const wc = makeWebceo({ acceptParam: null });
    const b = boot({ local: { webceoApiKey: 'k' }, fetchImpl: wc.fetchMock });
    const res = await b.webceoSetCompetitors({ pageUrl: 'https://acme.com/', competitors: ['rival.com'] });
    assert.deepEqual(plain(res.tried), plain(b.SET_PARAM_CANDIDATES));
    b.SET_PARAM_CANDIDATES.forEach(p => assert.match(res.detail, new RegExp(p)));
  });

  test('every candidate is genuinely attempted before giving up', async () => {
    const wc = makeWebceo({ acceptParam: null });
    const b = boot({ local: { webceoApiKey: 'k' }, fetchImpl: wc.fetchMock });
    await b.webceoSetCompetitors({ pageUrl: 'https://acme.com/', competitors: ['rival.com'] });
    const sets = wc.calls.filter(c => c.method === 'set_competitors');
    assert.equal(sets.length, b.SET_PARAM_CANDIDATES.length);
    assert.deepEqual(sets.map(c => Object.keys(c.data).find(k => k !== 'project')), plain(b.SET_PARAM_CANDIDATES));
  });

  test('a real API error surfaces instead of being retried into SHAPE_UNKNOWN silence', async () => {
    const wc = makeWebceo({ failSet: 10 });   // result 10 = bad key / unknown command
    const b = boot({ local: { webceoApiKey: 'k' }, fetchImpl: wc.fetchMock });
    const res = await b.webceoSetCompetitors({ pageUrl: 'https://acme.com/', competitors: ['rival.com'] });
    assert.equal(res.error, 'SHAPE_UNKNOWN');
    assert.match(res.detail, /BAD_KEY/, 'the underlying API error should still be visible');
  });

  test('the domains sent are normalised, not whatever the user typed', async () => {
    const wc = makeWebceo({ acceptParam: 'competitors' });
    const b = boot({ local: { webceoApiKey: 'k' }, fetchImpl: wc.fetchMock });
    await b.webceoSetCompetitors({ pageUrl: 'https://acme.com/', competitors: ['HTTPS://WWW.Rival.com/blog'] });
    assert.deepEqual(wc.current(), ['rival.com']);
  });
});

describe('the client-level list', () => {
  test('a new client starts with an empty competitor list, not undefined', async () => {
    const b = boot();
    assert.deepEqual(plain(b.clientRegistryNew().competitors), []);
  });

  test('saves and reads back', async () => {
    const b = boot();
    const client = await withClient(b);
    const res = await b.clientRegistrySetCompetitors({ id: client.id, competitors: ['rival.com'] });
    assert.equal(res.ok, true);
    const back = (await b.clientRegistryGet({ id: client.id })).client;
    assert.deepEqual(plain(back.competitors), ['rival.com']);
  });

  test('normalises on the way in, so the stored list is comparable', async () => {
    const b = boot();
    const client = await withClient(b);
    const res = await b.clientRegistrySetCompetitors({
      id: client.id, competitors: [' HTTPS://WWW.Rival.com/x ', 'rival.com', '']
    });
    assert.deepEqual(plain(res.client.competitors), ['rival.com']);
  });

  test('clearing the list is allowed', async () => {
    const b = boot();
    const client = await withClient(b);
    await b.clientRegistrySetCompetitors({ id: client.id, competitors: ['rival.com'] });
    const res = await b.clientRegistrySetCompetitors({ id: client.id, competitors: [] });
    assert.deepEqual(plain(res.client.competitors), []);
  });

  test('a missing client is reported, not created', async () => {
    const b = boot();
    const res = await b.clientRegistrySetCompetitors({ id: 'nope', competitors: ['x.com'] });
    assert.deepEqual(plain(res), { ok: false, error: 'NOT_FOUND' });
  });

  test('it lives in sync storage, so it travels with the client', async () => {
    // Competitors are small client config — the same class of data as branded
    // terms, which has synced since well before the registry existed.
    const b = boot();
    const client = await withClient(b);
    await b.clientRegistrySetCompetitors({ id: client.id, competitors: ['rival.com'] });
    const shard = b.sync[`client:${client.id}`];
    assert.ok(shard, 'the client shard should be in storage.sync');
    assert.deepEqual(plain(shard.competitors), ['rival.com']);
  });
});
