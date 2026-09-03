// The SERP overlay resolves "which client does this page belong to" by
// matching the domains found IN a Google search result against every
// client's own domains and tracked competitors — there is no "active
// client" selection anywhere in this extension, so serpClientIndex() is the
// whole answer. Pins its shape (an array of relations per domain, not a
// single winner) and the shared normalizeDomain() extraction it now shares
// with clientRegistryAddDomain/clientRegistrySetCompetitors.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { backgroundSource } from './helpers.mjs';

const src = await backgroundSource();

function boot({ local = {}, sync = {} } = {}) {
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
    fetch: () => Promise.reject(new Error('network is not used here')),
    browser: new Proxy(real, { get: (t, p) => (p in t ? t[p] : auto()) })
  };
  vm.createContext(ctx);
  vm.runInContext(`${src}
;globalThis.__x = {
  serpClientIndex, normalizeDomain, clientRegistrySave, clientRegistryAddDomain,
  clientRegistrySetCompetitors, clientRegistryGet
};`, ctx);
  return ctx.__x;
}

const plain = (v) => JSON.parse(JSON.stringify(v));

describe('normalizeDomain (shared across add-domain, set-competitors, and the SERP index)', () => {
  const b = boot();
  test('strips protocol, www, path, and lowercases', () => {
    assert.equal(b.normalizeDomain('https://WWW.Acme.com/pricing?x=1'), 'acme.com');
  });
  test('a bare hostname passes through unchanged', () => {
    assert.equal(b.normalizeDomain('acme.com'), 'acme.com');
  });
  test('empty/nullish input normalizes to empty string', () => {
    assert.equal(b.normalizeDomain(''), '');
    assert.equal(b.normalizeDomain(null), '');
    assert.equal(b.normalizeDomain(undefined), '');
  });
});

describe('serpClientIndex', () => {
  test('an empty registry returns an empty index', async () => {
    const b = boot();
    assert.deepEqual(plain(await b.serpClientIndex()), { domains: {} });
  });

  test('a client\'s own domain is indexed with role "own"', async () => {
    const b = boot();
    const { client } = await b.clientRegistrySave({ client: { name: 'Acme' } });
    await b.clientRegistryAddDomain({ id: client.id, domain: 'acme.com' });
    const { domains } = await b.serpClientIndex();
    assert.deepEqual(plain(domains['acme.com']), [{ clientId: client.id, clientName: 'Acme', role: 'own' }]);
  });

  test('a tracked competitor is indexed with role "competitor"', async () => {
    const b = boot();
    const { client } = await b.clientRegistrySave({ client: { name: 'Acme' } });
    await b.clientRegistrySetCompetitors({ id: client.id, competitors: ['rival.com'] });
    const { domains } = await b.serpClientIndex();
    assert.deepEqual(plain(domains['rival.com']), [{ clientId: client.id, clientName: 'Acme', role: 'competitor' }]);
  });

  test('a domain that is one client\'s own AND another client\'s competitor keeps both relations', async () => {
    // The reason the index maps to an ARRAY, not a single winner — collapsing
    // to one relation would silently drop a real fact.
    const b = boot();
    const { client: acme } = await b.clientRegistrySave({ client: { name: 'Acme' } });
    const { client: bravo } = await b.clientRegistrySave({ client: { name: 'Bravo' } });
    await b.clientRegistryAddDomain({ id: acme.id, domain: 'acme.com' });
    await b.clientRegistrySetCompetitors({ id: bravo.id, competitors: ['acme.com'] });
    const { domains } = await b.serpClientIndex();
    assert.deepEqual(plain(domains['acme.com']), [
      { clientId: acme.id, clientName: 'Acme', role: 'own' },
      { clientId: bravo.id, clientName: 'Bravo', role: 'competitor' }
    ]);
  });

  test('two clients sharing one tracked competitor both appear', async () => {
    const b = boot();
    const { client: acme } = await b.clientRegistrySave({ client: { name: 'Acme' } });
    const { client: bravo } = await b.clientRegistrySave({ client: { name: 'Bravo' } });
    await b.clientRegistrySetCompetitors({ id: acme.id, competitors: ['rival.com'] });
    await b.clientRegistrySetCompetitors({ id: bravo.id, competitors: ['rival.com'] });
    const { domains } = await b.serpClientIndex();
    assert.equal(domains['rival.com'].length, 2);
    assert.deepEqual(new Set(domains['rival.com'].map(r => r.clientName)), new Set(['Acme', 'Bravo']));
  });

  test('normalizes entered forms consistently with the other write paths', async () => {
    const b = boot();
    const { client } = await b.clientRegistrySave({ client: { name: 'Acme' } });
    await b.clientRegistrySetCompetitors({ id: client.id, competitors: ['https://WWW.Rival.com/pricing'] });
    const { domains } = await b.serpClientIndex();
    assert.ok(domains['rival.com'], 'expected the normalized bare-domain key to exist');
    assert.equal(Object.keys(domains).length, 1);
  });

  test('the response carries only clientId/clientName/role — no account ids, no trust profile', async () => {
    const b = boot();
    const { client } = await b.clientRegistrySave({ client: { name: 'Acme' } });
    await b.clientRegistryAddDomain({ id: client.id, domain: 'acme.com' });
    const { domains } = await b.serpClientIndex();
    const keys = Object.keys(domains['acme.com'][0]).sort();
    assert.deepEqual(keys, ['clientId', 'clientName', 'role']);
  });
});

describe('clientRegistryAddDomain regression (now routed through the shared normalizeDomain)', () => {
  test('a bare hostname is still added unchanged', async () => {
    const b = boot();
    const { client } = await b.clientRegistrySave({ client: { name: 'Acme' } });
    const res = await b.clientRegistryAddDomain({ id: client.id, domain: 'acme.com' });
    assert.equal(res.client.domains[0].domain, 'acme.com');
  });

  test('a domain entered with protocol and path is now normalized on add too', async () => {
    // clientRegistryAddDomain previously only stripped www, not protocol/path
    // — the shared helper closes that gap as a safe side effect.
    const b = boot();
    const { client } = await b.clientRegistrySave({ client: { name: 'Acme' } });
    const res = await b.clientRegistryAddDomain({ id: client.id, domain: 'https://www.acme.com/pricing' });
    assert.equal(res.client.domains[0].domain, 'acme.com');
  });
});
