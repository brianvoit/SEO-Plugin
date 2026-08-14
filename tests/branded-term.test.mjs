// Tests bg-clients.js's clientRegistryAddBrandedTerm — the "+" beside a query
// in the Search and Ads tables.
//
// This one carries a real behaviour change, not just a bug fix: the quick-add
// used to write the per-host brandedTerms map straight from the popup, so the
// term never reached the Client record and the Client panel's regex field
// stayed stale. It now appends to the CLIENT's pattern and projects that back
// across every domain the client owns — meaning branding a term on one domain
// of a multi-domain client now brands it on all of them. That blast radius is
// exactly what wants pinning down.
//
// The whole background is loaded into a vm rather than slicing one
// function out, because the interesting behaviour lives in how this function
// composes with the registry it reads and writes (migration, the sharded
// client records, the sync/local branded-terms fallback).

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { backgroundSource } from './helpers.mjs';

const src = await backgroundSource();

/**
 * Boots the real background (all bg-*.js, concatenated) against fake storage.
 * Anything the extension touches that isn't storage is absorbed by a
 * self-returning proxy — listener registration, alarms, menus and the like all
 * run at load time and none of them matter here.
 */
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
    storage: {
      local: area(local),
      sync: area(sync),
      session: area({}),
      onChanged: { addListener() {} }
    },
    runtime: {
      onMessage: { addListener() {} },
      onInstalled: { addListener() {} },
      // Keeps IS_CHROMIUM_BG false: this suite is about registry logic, not
      // the Chrome/Firefox split.
      getURL: () => 'moz-extension://test/',
      sendMessage: () => Promise.resolve({})
    }
  };

  const ctx = {
    console, URL, URLSearchParams, Date, Math, JSON, RegExp, String, Object, Array,
    setTimeout, clearTimeout, setInterval, clearInterval,
    crypto: globalThis.crypto, TextEncoder, btoa: globalThis.btoa, atob: globalThis.atob,
    fetch: () => Promise.reject(new Error('network is not used in this suite')),
    browser: new Proxy(real, { get: (t, p) => (p in t ? t[p] : auto()) })
  };
  vm.createContext(ctx);
  vm.runInContext(`${src}
;globalThis.__x = { clientRegistryAddBrandedTerm, clientRegistrySave, clientRegistryAddDomain,
                    clientRegistryGet, clientRegistrySetBrandedTerms };`, ctx);

  return {
    ...ctx.__x,
    local,
    sync,
    // The projected host→pattern map, wherever it actually landed. Spread into
    // a plain object: values crossing back out of the vm carry that realm's
    // prototypes, which strict deep-equality rejects.
    branded: () => ({ ...((Object.keys(sync.brandedTerms || {}).length ? sync.brandedTerms : local.brandedTerms) || {}) })
  };
}

/** A saved client owning `domains`, with an optional starting pattern. */
async function makeClient(b, name, domains, brandedTerms) {
  const { client } = await b.clientRegistrySave({ client: { name } });
  for (const d of domains) await b.clientRegistryAddDomain({ id: client.id, domain: d });
  // Branded terms deliberately don't go through clientRegistrySave — it only
  // handles fields with no projection to cascade.
  if (brandedTerms) await b.clientRegistrySetBrandedTerms({ id: client.id, pattern: brandedTerms });
  return client.id;
}

let b;
beforeEach(() => { b = boot(); });

describe('a host owned by a client', () => {
  test('writes the term onto the CLIENT record, not just the host map', async () => {
    // The actual bug: the Client panel's regex field stayed stale because the
    // term only ever reached brandedTerms[host].
    const id = await makeClient(b, 'Acme', ['acme.com']);
    await b.clientRegistryAddBrandedTerm({ host: 'acme.com', term: 'acme' });

    const { client } = await b.clientRegistryGet({ id });
    assert.equal(client.brandedTerms, 'acme', 'the client record did not receive the term');
  });

  test('projects the pattern across EVERY domain the client owns', async () => {
    // The behaviour change: branding on one domain now covers the siblings.
    const id = await makeClient(b, 'Acme', ['acme.com', 'acme.co.uk']);
    const res = await b.clientRegistryAddBrandedTerm({ host: 'acme.com', term: 'acme' });

    assert.equal(res.ok, true);
    assert.deepEqual(b.branded(), { 'acme.com': 'acme', 'acme.co.uk': 'acme' });
    const { client } = await b.clientRegistryGet({ id });
    assert.equal(client.brandedTerms, 'acme');
  });

  test('appends to an existing pattern with an alternation', async () => {
    // The second term must be one the existing pattern does NOT already
    // match, or the no-op path below is what's being exercised instead.
    await makeClient(b, 'Acme', ['acme.com'], 'acme');
    await b.clientRegistryAddBrandedTerm({ host: 'acme.com', term: 'widgetco' });
    assert.equal(b.branded()['acme.com'], 'acme|widgetco');
  });

  test('a term already matched by the pattern is a no-op', async () => {
    // "acme widgets" is already caught by /acme/i — appending it would grow
    // the regex forever as the user clicks + on related queries.
    await makeClient(b, 'Acme', ['acme.com'], 'acme');
    const res = await b.clientRegistryAddBrandedTerm({ host: 'acme.com', term: 'acme widgets' });

    assert.equal(res.ok, true, 'a covered term should still report success');
    assert.equal(res.pattern, 'acme');
    assert.equal(b.branded()['acme.com'], 'acme', 'the pattern was extended anyway');
  });

  test('the client\'s pattern wins over a stale host-map entry', async () => {
    // The two can legitimately disagree — the client record is authoritative.
    const id = await makeClient(b, 'Acme', ['acme.com'], 'fromclient');
    b.sync.brandedTerms = { 'acme.com': 'stalehostvalue' };

    await b.clientRegistryAddBrandedTerm({ host: 'acme.com', term: 'extra' });

    const { client } = await b.clientRegistryGet({ id });
    assert.equal(client.brandedTerms, 'fromclient|extra', 'appended onto the stale host value');
    assert.equal(b.branded()['acme.com'], 'fromclient|extra');
  });
});

describe('a host with no client', () => {
  test('falls back to a bare per-host entry, as before', async () => {
    const res = await b.clientRegistryAddBrandedTerm({ host: 'unbound.com', term: 'unbound' });
    assert.equal(res.ok, true);
    assert.equal(res.client, null);
    assert.equal(b.branded()['unbound.com'], 'unbound');
  });

  test('does not invent a client for the domain', async () => {
    await b.clientRegistryAddBrandedTerm({ host: 'unbound.com', term: 'unbound' });
    const index = b.sync.clientIndex || [];
    assert.equal(index.length, 0, 'quick-add created a client as a side effect');
  });

  test('appends to an existing per-host pattern', async () => {
    b.sync.brandedTerms = { 'unbound.com': 'first' };
    await b.clientRegistryAddBrandedTerm({ host: 'unbound.com', term: 'second' });
    assert.equal(b.branded()['unbound.com'], 'first|second');
  });
});

describe('the term itself', () => {
  test('regex metacharacters are escaped, keeping the pattern valid', async () => {
    // An unescaped "c++ tutorials" is an invalid regex; every later
    // isQueryBranded() call would throw or silently stop matching.
    await b.clientRegistryAddBrandedTerm({ host: 'acme.com', term: 'c++ tutorials' });
    const pattern = b.branded()['acme.com'];
    assert.doesNotThrow(() => new RegExp(pattern, 'i'), `"${pattern}" is not a valid regex`);
    assert.ok(new RegExp(pattern, 'i').test('c++ tutorials'), 'the escaped pattern no longer matches its own term');
  });

  test('an escaped term does not over-match', async () => {
    // "." must not become "any character".
    await b.clientRegistryAddBrandedTerm({ host: 'acme.com', term: 'acme.co' });
    assert.ok(!new RegExp(b.branded()['acme.com'], 'i').test('acmexco'));
  });

  test('is trimmed', async () => {
    await b.clientRegistryAddBrandedTerm({ host: 'acme.com', term: '  acme  ' });
    assert.equal(b.branded()['acme.com'], 'acme');
  });

  test('an empty term is rejected', async () => {
    const res = await b.clientRegistryAddBrandedTerm({ host: 'acme.com', term: '   ' });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'BAD_INPUT');
  });

  test('an empty host is rejected', async () => {
    const res = await b.clientRegistryAddBrandedTerm({ host: '', term: 'acme' });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'BAD_INPUT');
  });
});

describe('host normalisation', () => {
  test('www. and case are stripped so the entry matches the rest of the app', async () => {
    // Every other host-keyed lookup uses the apex, lowercased. A "WWW." entry
    // here would be written but never read.
    const id = await makeClient(b, 'Acme', ['acme.com']);
    await b.clientRegistryAddBrandedTerm({ host: 'WWW.Acme.com', term: 'acme' });

    assert.deepEqual(Object.keys(b.branded()), ['acme.com']);
    const { client } = await b.clientRegistryGet({ id });
    assert.equal(client.brandedTerms, 'acme', 'the normalised host did not resolve to its client');
  });
});

describe('resilience', () => {
  test('an existing pattern that is not a valid regex does not throw', async () => {
    // Patterns are user-entered in the Client panel; a stray "(" is possible
    // and must not make the + button dead.
    await makeClient(b, 'Acme', ['acme.com'], '(unclosed');
    const res = await b.clientRegistryAddBrandedTerm({ host: 'acme.com', term: 'acme' });
    assert.equal(res.ok, true);
    assert.equal(b.branded()['acme.com'], '(unclosed|acme');
  });
});
