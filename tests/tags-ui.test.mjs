// Tests popup-tags.js — the Overview chip row and the panel behind it.
//
// The real file is loaded into a jsdom window with the handful of popup
// globals it reads (getActiveTab, TOP_FRAME, copyToClipboard) stubbed, and
// driven with detector-shaped payloads. Any element the file asks for that
// isn't hand-authored below is auto-created, so unrelated wiring can't throw
// at load time — the same harness shape the other popup tests use.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { ROOT } from './helpers.mjs';

const src = await readFile(path.join(ROOT, 'popup-tags.js'), 'utf8');

/** A detector-shaped vendor record. */
const v = (id, label, cat, over = {}) => ({
  id, label, cat, ids: [], where: ['dom'], loads: 1, fetches: 1, evidence: [], ...over
});

function boot({ tags = null, rescan = null } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>
    <span id="tags-summary"></span>
    <div id="tags-chips"></div>
    <div id="tags-empty" class="hidden"></div>
    <span id="tags-header-meta"></span>
    <div id="tags-content"></div>
    <button id="btn-tags-refresh"></button>
  </body></html>`, { url: 'https://ext.test/popup.html', runScripts: 'outside-only' });
  const w = dom.window;

  const realGet = w.document.getElementById.bind(w.document);
  w.document.getElementById = (id) => realGet(id) || (() => {
    const el = w.document.createElement('div'); el.id = id; w.document.body.appendChild(el); return el;
  })();

  const sent = [];
  w.TOP_FRAME = { frameId: 0 };
  w.getActiveTab = () => Promise.resolve({ id: 1, url: 'https://site.test/' });
  w.copyToClipboard = () => {};
  w.showTagsPanel = () => {};
  w.browser = {
    tabs: {
      sendMessage: (tabId, msg, frame) => {
        sent.push({ tabId, msg, frame });
        return rescan ? Promise.resolve(rescan) : Promise.reject(new Error('no content script'));
      }
    }
  };

  w.eval(`${src}\n;window.__t = { renderTagsEntry, renderTagsPanel, rescanTags, openTagsPanel };`);
  if (tags !== undefined) w.__t.renderTagsEntry({ marketingTags: tags });
  return { w, d: w.document, sent, api: w.__t };
}

const chips = (b) => [...b.d.querySelectorAll('#tags-chips .tag-chip')];

describe('the Overview row', () => {
  test('renders one chip per detected vendor', () => {
    const b = boot({ tags: { scannedAt: 1200, flags: [], vendors: [
      v('ga4', 'Google Analytics 4', 'analytics'),
      v('gtm', 'Google Tag Manager', 'tagmanager'),
      v('hotjar', 'Hotjar', 'heatmap')
    ] } });
    assert.equal(chips(b).length, 3);
  });

  test('orders chips by category, analytics first', () => {
    // The page loads things in whatever order it likes; the row shouldn't
    // inherit that.
    const b = boot({ tags: { scannedAt: 1, flags: [], vendors: [
      v('meta-pixel', 'Meta Pixel', 'pixel'),
      v('hotjar', 'Hotjar', 'heatmap'),
      v('ga4', 'Google Analytics 4', 'analytics'),
      v('gtm', 'Google Tag Manager', 'tagmanager')
    ] } });
    // The label is the chip's first span; reading textContent would also pick
    // up the ID/count badge.
    assert.deepEqual(
      chips(b).map(c => c.querySelector('span').textContent),
      ['Google Analytics 4', 'Google Tag Manager', 'Hotjar', 'Meta Pixel']
    );
  });

  test('shows a single short ID right on the chip', () => {
    const b = boot({ tags: { scannedAt: 1, flags: [], vendors: [
      v('ga4', 'Google Analytics 4', 'analytics', { ids: ['G-ABC123'] })
    ] } });
    assert.match(chips(b)[0].textContent, /G-ABC123/);
  });

  test('collapses several IDs to a count rather than a wall of text', () => {
    const b = boot({ tags: { scannedAt: 1, flags: [], vendors: [
      v('ga4', 'Google Analytics 4', 'analytics', { ids: ['G-AAAAAA', 'G-BBBBBB', 'G-CCCCCC'] })
    ] } });
    const txt = chips(b)[0].textContent;
    assert.match(txt, /3$/);
    assert.ok(!txt.includes('G-AAAAAA'), 'expanded every ID onto the chip');
  });

  test('a warned vendor is visibly marked', () => {
    const b = boot({ tags: {
      scannedAt: 1,
      vendors: [v('ga4', 'Google Analytics 4', 'analytics', { ids: ['G-ABC123'] })],
      flags: [{ level: 'warning', vendorId: 'ga4', code: 'DUPLICATE_ID', text: 'twice' }]
    } });
    assert.ok(chips(b)[0].classList.contains('tag-chip--warn'));
  });

  test('summary counts tags and issues', () => {
    const b = boot({ tags: {
      scannedAt: 1,
      vendors: [v('ga4', 'GA4', 'analytics'), v('ua', 'UA', 'analytics')],
      flags: [{ level: 'warning', vendorId: 'ua', code: 'LEGACY_UA', text: 'dead' }]
    } });
    assert.equal(b.d.getElementById('tags-summary').textContent, '2 detected · 1 issue');
  });

  test('info-level flags do not inflate the issue count', () => {
    const b = boot({ tags: {
      scannedAt: 1,
      vendors: [v('ga4', 'GA4', 'analytics'), v('matomo', 'Matomo', 'analytics')],
      flags: [{ level: 'info', vendorId: null, code: 'MULTIPLE_ANALYTICS', text: 'two tools' }]
    } });
    assert.equal(b.d.getElementById('tags-summary').textContent, '2 detected');
  });

  test('a page with nothing detected says so rather than vanishing', () => {
    // "No analytics at all" is a finding on a client audit, not an empty state.
    const b = boot({ tags: { scannedAt: 1, vendors: [], flags: [] } });
    assert.equal(chips(b).length, 0);
    assert.ok(!b.d.getElementById('tags-empty').classList.contains('hidden'));
  });

  test('survives a page read that returned no tag data at all', () => {
    const b = boot({ tags: null });
    assert.equal(chips(b).length, 0);
    assert.ok(!b.d.getElementById('tags-empty').classList.contains('hidden'));
  });
});

describe('the panel', () => {
  let b;
  beforeEach(() => {
    b = boot({ tags: {
      scannedAt: 2400,
      vendors: [
        v('ga4', 'Google Analytics 4', 'analytics', { ids: ['G-ABC123'], where: ['dom', 'network'], fetches: 2 }),
        v('gtm', 'Google Tag Manager', 'tagmanager', { ids: ['GTM-ABC123'] }),
        v('meta-pixel', 'Meta Pixel', 'pixel', { where: ['network'], evidence: [{ url: 'https://connect.facebook.net/en_US/fbevents.js', where: 'network' }] })
      ],
      flags: [
        { level: 'info', vendorId: null, code: 'MULTIPLE_ANALYTICS', text: 'Two analytics tools present.' },
        { level: 'warning', vendorId: 'ga4', code: 'DUPLICATE_ID', text: 'GA4 loads G-ABC123 from 2 different scripts.' }
      ]
    } });
    b.api.renderTagsPanel();
  });

  test('groups vendors under their category headings', () => {
    const labels = [...b.d.querySelectorAll('#tags-content .field-label')].map(e => e.textContent);
    assert.deepEqual(labels, ['WHAT TO LOOK AT', 'ANALYTICS', 'TAG MANAGERS & CONSENT', 'AD & CONVERSION PIXELS']);
  });

  test('puts warnings above info notes', () => {
    const flags = [...b.d.querySelectorAll('.tag-flag')];
    assert.ok(flags[0].classList.contains('tag-flag--warning'),
      'an info note outranked a property being counted twice');
  });

  test('renders each vendor row with its ID', () => {
    const ids = [...b.d.querySelectorAll('.tag-row-id')].map(e => e.textContent);
    assert.deepEqual(ids, ['G-ABC123', 'GTM-ABC123']);
  });

  test('describes where a tag was seen without claiming how it got there', () => {
    // "dom" cannot distinguish hardcoded from tag-manager-injected, so the
    // copy must not imply it does.
    const rows = [...b.d.querySelectorAll('.tag-row')];
    const meta = rows.map(r => r.querySelector('.tag-row-meta').textContent).join(' | ');
    assert.match(meta, /in the page/);
    assert.match(meta, /loaded/);
    assert.ok(!/hardcoded|injected/i.test(meta), `copy over-claims provenance: ${meta}`);
  });

  test('notes when the scan happened, since late tags are invisible to it', () => {
    assert.match(b.d.getElementById('tags-content').textContent, /2\.4s after the page started loading/);
  });

  test('an empty page gets a plain message, not an empty panel', () => {
    const empty = boot({ tags: { scannedAt: 1, vendors: [], flags: [] } });
    empty.api.renderTagsPanel();
    assert.match(empty.d.getElementById('tags-content').textContent, /No marketing or analytics tags/);
  });
});

describe('re-scanning', () => {
  test('asks the content script, pinned to the top frame', async () => {
    // An ad or embed iframe is full of ad pixels; letting one answer would
    // report them as the page's own stack.
    const b = boot({ tags: { scannedAt: 1, vendors: [], flags: [] }, rescan: { scannedAt: 9, vendors: [], flags: [] } });
    await b.api.rescanTags();
    assert.equal(b.sent.length, 1);
    assert.equal(b.sent[0].msg.action, 'getMarketingTags');
    assert.deepEqual(b.sent[0].frame, { frameId: 0 });
  });

  test('a late-arriving tag reaches the Overview row too, not just the panel', async () => {
    const b = boot({
      tags: { scannedAt: 1, vendors: [], flags: [] },
      rescan: { scannedAt: 9, flags: [], vendors: [v('hotjar', 'Hotjar', 'heatmap')] }
    });
    await b.api.rescanTags();
    assert.equal(chips(b).length, 1, 'the chip row still showed the stale reading');
  });

  test('a page with no content script keeps the previous reading instead of blanking', async () => {
    const b = boot({ tags: { scannedAt: 1, flags: [], vendors: [v('ga4', 'GA4', 'analytics')] } });
    await b.api.rescanTags();   // harness rejects the sendMessage
    assert.equal(chips(b).length, 1, 'a failed re-scan wiped out what was already known');
  });
});
