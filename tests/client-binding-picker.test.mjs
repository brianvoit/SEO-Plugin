// Tests popup-clients.js's per-domain binding picker — the dropdown that
// picks a GSC/GA4/Ads/Web CEO property for a Client's domain.
//
// Two behaviors are pinned here, both from user-reported friction:
//   1. The picker used to render every property/account up front (hundreds
//      of rows on an account with real history) and only ever HID rows once
//      you typed — meaning the messy full list was the default, unfiltered
//      state. It now shows nothing until there's a query.
//   2. When Tags & Pixels has already found a GA4 ID on the page being
//      inspected, the picker shouldn't make the user hunt for the matching
//      property by name — it's pinned above the search box as a suggestion.
//
// The real functions are sliced out of popup-clients.js and run against a
// jsdom document, same approach as the other popup-*.js test files.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { ROOT } from './helpers.mjs';

const START = '// ─── Per-domain binding pickers';
const END = 'function renderClientBindingRow(';

const src = await readFile(path.join(ROOT, 'popup-clients.js'), 'utf8');
const from = src.indexOf(START);
const to = src.indexOf(END);

test('the binding picker is still where the test expects it', () => {
  assert.ok(from !== -1, `could not find "${START}" in popup-clients.js — update this test's slice markers`);
  assert.ok(to > from, `could not find "${END}" after the picker code`);
});

const source = src.slice(from, to);

/**
 * Boots the real picker functions against a jsdom document.
 * @param currentHost   value for _currentClientHost (which domain "is" the active tab)
 * @param pageDataValue value for the global `pageData` (Tags & Pixels detection results)
 * @param sendMessage   stub for sendMessageWithTimeout, used by clientBindingFetch
 */
function boot({ currentHost = null, pageDataValue = null, sendMessage = async () => ({}) } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  const { window } = dom;

  const calls = [];
  window.sendMessageWithTimeout = (msg) => { calls.push(msg); return sendMessage(msg); };
  window.pageData = pageDataValue;
  window._currentClientHost = currentHost;

  const api = new Function(
    'document', 'sendMessageWithTimeout', 'pageData', '_currentClientHost',
    `${source}
    return { buildBindingOption, renderClientBindingOptions, detectedGaMeasurementId, clientBindingFetch, CLIENT_BINDING_RESULTS_CAP };`
  )(window.document, (...a) => window.sendMessageWithTimeout(...a), window.pageData, window._currentClientHost);

  return { window, document: window.document, calls, api };
}

describe('buildBindingOption', () => {
  test('marks the currently-selected item active', () => {
    const { document, api } = boot();
    const opt = api.buildBindingOption({ id: 'p1', label: 'Acme', sub: 'act' }, 'id', 'label', 'sub', true, () => {});
    assert.ok(opt.classList.contains('gsc-property-option--active'));
    assert.equal(document.createElement('div').tagName, 'DIV');   // sanity: real DOM
  });

  test('calls onSelect with the item id on click', () => {
    const { api } = boot();
    let picked = null;
    const opt = api.buildBindingOption({ id: 'p1', label: 'Acme' }, 'id', 'label', null, false, (id) => { picked = id; });
    opt.dispatchEvent(new (opt.ownerDocument.defaultView.Event)('click', { bubbles: true }));
    assert.equal(picked, 'p1');
  });
});

describe('renderClientBindingOptions — hidden until typed', () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, label: `Property ${i}` }));

  test('nothing is shown before typing', () => {
    const { document, api } = boot();
    const box = document.createElement('div');
    api.renderClientBindingOptions(box, items, null, { idKey: 'id', labelKey: 'label' }, () => {});
    const visible = [...box.querySelectorAll('.gsc-property-option')].filter(el => !el.classList.contains('hidden'));
    assert.equal(visible.length, 0, 'a row was visible with no query typed — this is the reported "messy wall" bug');
  });

  test('the "type to search" hint is shown by default', () => {
    const { document, api } = boot();
    const box = document.createElement('div');
    api.renderClientBindingOptions(box, items, null, { idKey: 'id', labelKey: 'label' }, () => {});
    const hint = box.querySelector('.field-hint');
    assert.ok(hint && !hint.classList.contains('hidden'));
  });

  test('typing reveals only matching rows and hides the hint', () => {
    const { document, api } = boot();
    const box = document.createElement('div');
    api.renderClientBindingOptions(box, items, null, { idKey: 'id', labelKey: 'label' }, () => {});
    const search = box.querySelector('.ga-property-search');
    search.value = 'property 3';
    search.dispatchEvent(new box.ownerDocument.defaultView.Event('input', { bubbles: true }));

    const visible = [...box.querySelectorAll('.gsc-property-option')].filter(el => !el.classList.contains('hidden'));
    assert.equal(visible.length, 1);
    assert.match(visible[0].textContent, /Property 3/);
    assert.ok(box.querySelector('.field-hint').classList.contains('hidden'));
  });

  test('clearing the query re-hides everything', () => {
    const { document, api } = boot();
    const box = document.createElement('div');
    api.renderClientBindingOptions(box, items, null, { idKey: 'id', labelKey: 'label' }, () => {});
    const search = box.querySelector('.ga-property-search');
    const fire = () => search.dispatchEvent(new box.ownerDocument.defaultView.Event('input', { bubbles: true }));
    search.value = 'property'; fire();
    search.value = ''; fire();
    const visible = [...box.querySelectorAll('.gsc-property-option')].filter(el => !el.classList.contains('hidden'));
    assert.equal(visible.length, 0);
  });

  test('matches are capped, with a count of what is hidden', () => {
    const { document, api } = boot();
    const many = Array.from({ length: 45 }, (_, i) => ({ id: `p${i}`, label: `Widget Corp ${i}` }));
    const box = document.createElement('div');
    api.renderClientBindingOptions(box, many, null, { idKey: 'id', labelKey: 'label' }, () => {});
    const search = box.querySelector('.ga-property-search');
    search.value = 'widget';
    search.dispatchEvent(new box.ownerDocument.defaultView.Event('input', { bubbles: true }));

    const visible = [...box.querySelectorAll('.gsc-property-option')].filter(el => !el.classList.contains('hidden'));
    assert.equal(visible.length, api.CLIENT_BINDING_RESULTS_CAP, 'the cap did not apply');
    const more = [...box.querySelectorAll('.field-hint')].find(el => /more/.test(el.textContent));
    assert.match(more.textContent, /\+15 more/);
  });

  test('the list is wrapped in the house scrollable-list container, not bare in the box', () => {
    // Without this wrapper, rows had no gap between them (.gsc-property-box
    // sets no spacing of its own — only .gsc-property-all does).
    const { document, api } = boot();
    const box = document.createElement('div');
    api.renderClientBindingOptions(box, items, null, { idKey: 'id', labelKey: 'label' }, () => {});
    assert.ok(box.querySelector('.gsc-property-all.gsc-property-all--scroll'));
  });
});

describe('renderClientBindingOptions — the suggested match', () => {
  const items = [
    { id: 'p1', label: 'Acme Blog', sub: 'Acme Inc' },
    { id: 'p2', label: 'Acme Shop', sub: 'Acme Inc' }
  ];

  test('a suggested item is shown even with no query typed', () => {
    const { document, api } = boot();
    const box = document.createElement('div');
    api.renderClientBindingOptions(box, items, null,
      { idKey: 'id', labelKey: 'label', sublabelKey: 'sub', suggested: { id: 'p2', reason: 'G-ABC123 detected on this page' } },
      () => {});
    const sug = box.querySelector('.gsc-property-suggested');
    assert.ok(sug, 'no suggested row rendered');
    assert.match(sug.textContent, /Acme Shop/);
    assert.match(sug.textContent, /G-ABC123 detected on this page/);
  });

  test('clicking the suggested row selects it, same as a normal option', () => {
    const { document, api } = boot();
    const box = document.createElement('div');
    let picked = null;
    api.renderClientBindingOptions(box, items, null,
      { idKey: 'id', labelKey: 'label', sublabelKey: 'sub', suggested: { id: 'p2', reason: 'detected' } },
      (id) => { picked = id; });
    const opt = box.querySelector('.gsc-property-suggested .gsc-property-option');
    opt.dispatchEvent(new box.ownerDocument.defaultView.Event('click', { bubbles: true }));
    assert.equal(picked, 'p2');
  });

  test('an unmatched suggested id (stale/renamed property) is skipped, not shown broken', () => {
    const { document, api } = boot();
    const box = document.createElement('div');
    api.renderClientBindingOptions(box, items, null,
      { idKey: 'id', labelKey: 'label', suggested: { id: 'does-not-exist', reason: 'detected' } },
      () => {});
    assert.equal(box.querySelector('.gsc-property-suggested'), null);
  });

  test('no suggested option means no suggested row at all', () => {
    const { document, api } = boot();
    const box = document.createElement('div');
    api.renderClientBindingOptions(box, items, null, { idKey: 'id', labelKey: 'label' }, () => {});
    assert.equal(box.querySelector('.gsc-property-suggested'), null);
  });
});

describe('detectedGaMeasurementId', () => {
  test('prefers the Tags & Pixels GA4 detection (catches GTM-mediated gtag)', () => {
    const { api } = boot({ pageDataValue: {
      marketingTags: { vendors: [{ id: 'ga4', ids: ['G-NEWSTYLE'] }] },
      gaMeasurementIds: ['G-OLDSTYLE']
    } });
    assert.equal(api.detectedGaMeasurementId(), 'G-NEWSTYLE');
  });

  test('falls back to the legacy field when Tags & Pixels found nothing', () => {
    const { api } = boot({ pageDataValue: { marketingTags: { vendors: [] }, gaMeasurementIds: ['G-OLDSTYLE'] } });
    assert.equal(api.detectedGaMeasurementId(), 'G-OLDSTYLE');
  });

  test('returns null when pageData has neither', () => {
    const { api } = boot({ pageDataValue: { marketingTags: { vendors: [] }, gaMeasurementIds: [] } });
    assert.equal(api.detectedGaMeasurementId(), null);
  });

  test('survives pageData being entirely absent (Client panel opened before Overview ever loaded)', () => {
    const { api } = boot({ pageDataValue: null });
    assert.equal(api.detectedGaMeasurementId(), null);
  });
});

describe('clientBindingFetch — GA4 detection is domain-scoped', () => {
  test('passes the detected measurement ID only for the domain matching the active tab', async () => {
    const { api, calls } = boot({
      currentHost: 'acme.com',
      pageDataValue: { marketingTags: { vendors: [{ id: 'ga4', ids: ['G-ABC123'] }] } },
      sendMessage: async (msg) => msg.action === 'gaResolveProperty' ? { connected: true, properties: [] } : {}
    });
    await api.clientBindingFetch('acme.com', 'ga');
    const call = calls.find(c => c.action === 'gaResolveProperty');
    assert.equal(call.measurementId, 'G-ABC123');
  });

  test('does NOT pass a measurement ID for a domain that is not the active tab', async () => {
    // A client can own several domains; only the one actually being viewed
    // has a live page to have detected anything from.
    const { api, calls } = boot({
      currentHost: 'acme.com',
      pageDataValue: { marketingTags: { vendors: [{ id: 'ga4', ids: ['G-ABC123'] }] } },
      sendMessage: async (msg) => msg.action === 'gaResolveProperty' ? { connected: true, properties: [] } : {}
    });
    await api.clientBindingFetch('acme.co.uk', 'ga');
    const call = calls.find(c => c.action === 'gaResolveProperty');
    assert.equal(call.measurementId, null);
  });

  test('a matched property becomes the suggested item, with the id in the reason text', async () => {
    const { api } = boot({
      currentHost: 'acme.com',
      pageDataValue: { marketingTags: { vendors: [{ id: 'ga4', ids: ['G-ABC123'] }] } },
      sendMessage: async () => ({ connected: true, properties: [], detectedProperty: 'properties/999' })
    });
    const res = await api.clientBindingFetch('acme.com', 'ga');
    assert.deepEqual(res.suggested, { id: 'properties/999', reason: 'G-ABC123 detected on this page' });
  });

  test('no detected measurement ID means no suggestion, even if the backend somehow returns one', async () => {
    const { api } = boot({
      currentHost: 'other.com',   // not the active tab — no measurementId will be sent
      pageDataValue: { marketingTags: { vendors: [{ id: 'ga4', ids: ['G-ABC123'] }] } },
      sendMessage: async () => ({ connected: true, properties: [], detectedProperty: 'properties/999' })
    });
    const res = await api.clientBindingFetch('acme.com', 'ga');
    assert.deepEqual(res.suggested, { id: 'properties/999', reason: 'Detected on this page' });
  });

  test('GSC, Ads and Web CEO bindings never carry a suggestion field', async () => {
    const { api } = boot({
      currentHost: 'acme.com',
      sendMessage: async (msg) => {
        if (msg.action === 'adsResolveAccount') return { connected: true, accounts: [] };
        return { connected: true, sites: [] };
      }
    });
    const ads = await api.clientBindingFetch('acme.com', 'ads');
    assert.equal(ads.suggested, undefined);
  });
});
