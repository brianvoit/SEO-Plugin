// Tests popup-phrases.js — the four-table Keyword Phrases panel.
//
// content.js does the counting (covered in keyword-phrases.test.mjs); this
// file owns everything layered on top, and that's where the subtler mistakes
// live: the regex filter has to run BEFORE the top-10 slice or it can only
// ever narrow ten rows, the Brand toggle has to remove rows rather than just
// hide a chip, and the "Primary" badge has to pick one phrase across four
// tables. Each of those is a wrong answer rather than a crash, so the real
// file is loaded into jsdom and driven with detector-shaped payloads.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { ROOT } from './helpers.mjs';

const src = await readFile(path.join(ROOT, 'popup-phrases.js'), 'utf8');

/** An extractor-shaped phrase record. */
const p = (phrase, count, over = {}) => ({
  phrase, count, density: count / 100, prominence: 50, chips: [], ...over
});

/** Builds the {1,2,3,4} table payload, defaulting the tables not given. */
const tables = (t = {}) => ({ 1: [], 2: [], 3: [], 4: [], ...t });

function boot({ scan = null, branded = {}, gsc = null, adCopy = null } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>
    <button id="btn-phrases" disabled></button>
    <span id="phrases-summary"></span>
    <span id="phrases-header-meta"></span>
    <input id="phrases-search" />
    <button id="btn-phrases-search-mode">Match</button>
    <input type="checkbox" id="phrases-brand-toggle" checked />
    <div id="phrases-gap" class="hidden"></div>
    <div id="phrases-tables"></div>
    <button id="btn-phrases-export-csv"></button>
    <button id="btn-phrases-export-sheet"></button>
  </body></html>`, { url: 'https://ext.test/popup.html', runScripts: 'outside-only' });
  const w = dom.window;

  const realGet = w.document.getElementById.bind(w.document);
  w.document.getElementById = (id) => realGet(id) || (() => {
    const el = w.document.createElement('div'); el.id = id; w.document.body.appendChild(el); return el;
  })();

  const sent = [];
  w.TOP_FRAME = { frameId: 0 };
  w.getActiveTab = () => Promise.resolve({ id: 1, url: 'https://site.test/page' });
  w.allBrandedTerms = branded;
  w.isValidRegex = (s) => { try { new RegExp(s); return true; } catch { return false; } };
  w.gscCsvCell = (v) => `"${String(v).replace(/"/g, '""')}"`;
  w.gscSelectedRange = 30;
  w.maybeOfferExportFolder = () => {};
  w.sendMessageWithTimeout = (msg) => {
    sent.push(msg);
    if (msg.action === 'adsGetPageAdCopy') return Promise.resolve(adCopy || { connected: true, texts: [] });
    if (msg.action === 'gscGetMoreQueries') return Promise.resolve(gsc || { connected: true, error: 'NO_PROPERTY' });
    if (msg.action === 'adsGetKeywordIdeas') return Promise.resolve({ error: 'NO_ACCOUNT', byKeyword: {} });
    return Promise.resolve({});
  };
  w.browser = {
    tabs: {
      create: () => {},
      sendMessage: (tabId, msg) => {
        sent.push(msg);
        if (msg.action === 'getKeywordPhrases') {
          return scan ? Promise.resolve(scan) : Promise.reject(new Error('no content script'));
        }
        if (msg.action === 'checkPhrasePresence') return Promise.resolve({ present: [] });
        return Promise.resolve({});
      }
    }
  };

  w.eval(`${src}
;window.__p = {
  renderPhrasesEntry, renderPhrasesPanel, rescanPhrases, openPhrasesPanel,
  visiblePhrases, phrasesPrimary, phrasesExportValues,
  setData: (d) => { _phrasesData = d; },
  setUrl: (u) => { _phrasesPageUrl = u; },
  setSearch: (s, excl) => { _phrasesSearch = s; _phrasesSearchExclude = !!excl; },
  setBrand: (on) => { _phrasesShowBrand = on; },
  setGsc: (m) => { _phrasesGsc = m; _phrasesGscState = 'available'; },
  setAdTexts: (t) => { _phrasesAdTexts = t; },
  setGap: (g) => { _phrasesGap = g; }
};`);

  w.__p.setUrl('https://site.test/page');
  return { w, d: w.document, sent, api: w.__p };
}

const rowTexts = (b, n) =>
  [...b.d.querySelectorAll('#phrases-tables section')][n - 1]
    .querySelectorAll('.phrases-row:not(.ranking-row--header) .ranking-keyword');

const rowPhrases = (b, n) => [...rowTexts(b, n)].map(el => el.textContent);

describe('the Overview entry', () => {
  test('shows the page word count and enables the chevron', () => {
    const b = boot();
    b.api.renderPhrasesEntry({ bodyWordCount: 1240 });
    assert.equal(b.d.getElementById('phrases-summary').textContent, '1,240 words');
    assert.equal(b.d.getElementById('btn-phrases').disabled, false);
  });

  test('stays disabled on a page with no body copy', () => {
    // Opening would give four empty tables — a dead end, so the chevron
    // shouldn't invite the click.
    const b = boot();
    b.api.renderPhrasesEntry({ bodyWordCount: 0 });
    assert.equal(b.d.getElementById('btn-phrases').disabled, true);
  });
});

describe('the four tables', () => {
  test('renders one section per phrase length, in order', () => {
    const b = boot();
    b.api.setData({ totalWords: 100, tables: tables({ 1: [p('telescope', 5)] }) });
    b.api.renderPhrasesPanel();
    const labels = [...b.d.querySelectorAll('#phrases-tables .field-label')].map(e => e.textContent);
    assert.deepEqual(labels, ['ONE WORD', 'TWO WORDS', 'THREE WORDS', 'FOUR WORDS']);
  });

  test('caps each table at ten rows', () => {
    const b = boot();
    const many = Array.from({ length: 25 }, (_, i) => p(`word${i}`, 25 - i));
    b.api.setData({ totalWords: 500, tables: tables({ 1: many }) });
    b.api.renderPhrasesPanel();
    assert.equal(rowPhrases(b, 1).length, 10);
  });

  test('a table with nothing in it says so rather than rendering bare', () => {
    const b = boot();
    b.api.setData({ totalWords: 10, tables: tables({ 1: [p('telescope', 2)] }) });
    b.api.renderPhrasesPanel();
    const sections = [...b.d.querySelectorAll('#phrases-tables section')];
    assert.match(sections[3].textContent, /No phrases of this length/);
  });
});

describe('the regex filter', () => {
  test('narrows the tables to matching phrases', () => {
    const b = boot();
    b.api.setData({ totalWords: 100, tables: tables({ 1: [p('telescope', 9), p('binoculars', 8), p('tripod', 7)] }) });
    b.api.setSearch('tele');
    b.api.renderPhrasesPanel();
    assert.deepEqual(rowPhrases(b, 1), ['telescope']);
  });

  test('exclude mode inverts the match', () => {
    const b = boot();
    b.api.setData({ totalWords: 100, tables: tables({ 1: [p('telescope', 9), p('binoculars', 8)] }) });
    b.api.setSearch('tele', true);
    b.api.renderPhrasesPanel();
    assert.deepEqual(rowPhrases(b, 1), ['binoculars']);
  });

  test('filters BEFORE the top-ten cut, so it can surface deeper rows', () => {
    // The bug this guards: filtering the already-sliced ten would mean a
    // phrase ranked 15th could never be found, which makes the filter
    // useless for exactly the digging it exists to support.
    const b = boot();
    const rows = Array.from({ length: 20 }, (_, i) => p(`word${i}`, 20 - i));
    rows.push(p('telescope', 1));                 // dead last by count
    b.api.setData({ totalWords: 500, tables: tables({ 1: rows }) });
    b.api.setSearch('telescope');
    b.api.renderPhrasesPanel();
    assert.deepEqual(rowPhrases(b, 1), ['telescope'], 'a phrase outside the top ten was unreachable');
  });

  test('an invalid regex leaves the tables unfiltered instead of blanking them', () => {
    const b = boot();
    b.api.setData({ totalWords: 100, tables: tables({ 1: [p('telescope', 9), p('binoculars', 8)] }) });
    b.api.setSearch('(unclosed');
    b.api.renderPhrasesPanel();
    assert.deepEqual(rowPhrases(b, 1), ['telescope', 'binoculars']);
  });

  test('filters every table at once, not just the first', () => {
    const b = boot();
    b.api.setData({ totalWords: 100, tables: tables({
      1: [p('telescope', 9), p('tripod', 8)],
      2: [p('best telescope', 4), p('camera tripod', 3)]
    }) });
    b.api.setSearch('telescope');
    b.api.renderPhrasesPanel();
    assert.deepEqual(rowPhrases(b, 1), ['telescope']);
    assert.deepEqual(rowPhrases(b, 2), ['best telescope']);
  });
});

describe('the Brand toggle', () => {
  test('off removes branded phrases from the tables entirely', () => {
    // Not merely hiding the chip: a brand name usually dominates the counts,
    // and burying the real content words is the whole problem.
    const b = boot({ branded: { 'site.test': 'acme' } });
    b.api.setData({ totalWords: 100, tables: tables({ 1: [p('acme', 20), p('telescope', 9)] }) });
    b.api.setBrand(false);
    b.api.renderPhrasesPanel();
    assert.deepEqual(rowPhrases(b, 1), ['telescope']);
  });

  test('on keeps them, chipped as Brand', () => {
    const b = boot({ branded: { 'site.test': 'acme' } });
    b.api.setData({ totalWords: 100, tables: tables({ 1: [p('acme', 20)] }) });
    b.api.renderPhrasesPanel();
    assert.deepEqual(rowPhrases(b, 1), ['acme']);
    assert.match(b.d.querySelector('.phrases-chip-brand').textContent, /Brand/);
  });

  test('a domain with no branded pattern is unaffected either way', () => {
    const b = boot({ branded: {} });
    b.api.setData({ totalWords: 100, tables: tables({ 1: [p('acme', 20), p('telescope', 9)] }) });
    b.api.setBrand(false);
    b.api.renderPhrasesPanel();
    assert.deepEqual(rowPhrases(b, 1), ['acme', 'telescope']);
  });

  test('an unparseable branded pattern does not wipe the tables', () => {
    // Patterns are hand-entered in the Client panel; a stray "(" must not
    // make every phrase read as branded (or as un-branded-able).
    const b = boot({ branded: { 'site.test': '(unclosed' } });
    b.api.setData({ totalWords: 100, tables: tables({ 1: [p('telescope', 9)] }) });
    b.api.setBrand(false);
    b.api.renderPhrasesPanel();
    assert.deepEqual(rowPhrases(b, 1), ['telescope']);
  });
});

describe('placement chips', () => {
  test('renders title/heading chips from the extractor payload', () => {
    const b = boot();
    b.api.setData({ totalWords: 100, tables: tables({ 1: [p('telescope', 9, { chips: ['title', 'h1'] })] }) });
    b.api.renderPhrasesPanel();
    const chips = [...b.d.querySelectorAll('.phrases-chips .gsc-chip')].map(c => c.textContent);
    assert.ok(chips.includes('Title'));
    assert.ok(chips.includes('H1'));
  });

  test('a Linked chip appears for anchor-text phrases', () => {
    const b = boot();
    b.api.setData({ totalWords: 100, tables: tables({ 1: [p('telescope', 9, { chips: ['linked'] })] }) });
    b.api.renderPhrasesPanel();
    assert.ok(b.d.querySelector('.phrases-chip-linked'));
  });

  test('an Ad chip appears only when the phrase is in this page\'s ad copy', () => {
    const b = boot();
    b.api.setData({ totalWords: 100, tables: tables({ 1: [p('telescope', 9), p('tripod', 8)] }) });
    b.api.setAdTexts(['shop our telescope range']);
    b.api.renderPhrasesPanel();
    const rows = [...b.d.querySelectorAll('.phrases-row:not(.ranking-row--header)')];
    assert.ok(rows[0].querySelector('.gsc-ad-chip'), 'no Ad chip on the phrase that IS in ad copy');
    assert.ok(!rows[1].querySelector('.gsc-ad-chip'), 'Ad chip on a phrase absent from ad copy');
  });
});

describe('the Primary badge', () => {
  test('marks the strongest phrase carried by both the title and an H1', () => {
    const b = boot();
    b.api.setData({ totalWords: 100, tables: tables({
      1: [p('telescope', 9, { chips: ['title', 'h1'], prominence: 90 })],
      2: [p('best telescope', 4, { chips: ['title'], prominence: 95 })]
    }) });
    assert.equal(b.api.phrasesPrimary().phrase, 'telescope');
  });

  test('is awarded across tables, not per table', () => {
    const b = boot();
    b.api.setData({ totalWords: 100, tables: tables({
      1: [p('shoes', 9, { chips: ['title', 'h1'], prominence: 60 })],
      3: [p('wool running shoes', 4, { chips: ['title', 'h1'], prominence: 88 })]
    }) });
    assert.equal(b.api.phrasesPrimary().phrase, 'wool running shoes');
    b.api.renderPhrasesPanel();
    const badges = [...b.d.querySelectorAll('.phrases-chip-primary')];
    assert.equal(badges.length, 1, 'more than one phrase was badged Primary');
  });

  test('the longer phrase wins a prominence tie', () => {
    const b = boot();
    b.api.setData({ totalWords: 100, tables: tables({
      1: [p('shoes', 9, { chips: ['title', 'h1'], prominence: 80 })],
      3: [p('wool running shoes', 4, { chips: ['title', 'h1'], prominence: 80 })]
    }) });
    assert.equal(b.api.phrasesPrimary().phrase, 'wool running shoes');
  });

  test('no badge at all when nothing sits in both the title and an H1', () => {
    const b = boot();
    b.api.setData({ totalWords: 100, tables: tables({ 1: [p('telescope', 9, { chips: ['title'] })] }) });
    assert.equal(b.api.phrasesPrimary(), null);
    b.api.renderPhrasesPanel();
    assert.equal(b.d.querySelector('.phrases-chip-primary'), null);
  });
});

describe('Search Console columns', () => {
  test('metric columns only exist once GSC data has landed', () => {
    const b = boot();
    b.api.setData({ totalWords: 100, tables: tables({ 1: [p('telescope', 9)] }) });
    b.api.renderPhrasesPanel();
    let heads = [...b.d.querySelectorAll('.ranking-row--header .ranking-cell-num')].map(e => e.textContent);
    assert.deepEqual(heads, ['#', 'Dens', 'Prom']);

    b.api.setGsc({ telescope: { clicks: 12, impressions: 400, position: 4.2 } });
    b.api.renderPhrasesPanel();
    heads = [...b.d.querySelectorAll('.ranking-row--header .ranking-cell-num')].map(e => e.textContent);
    assert.deepEqual(heads, ['#', 'Dens', 'Prom', 'Clicks', 'Impr', 'Pos']);
  });

  test('a phrase with no GSC row shows a dash, not a zero', () => {
    // Zero clicks and "we have no data for this" are different claims.
    const b = boot();
    b.api.setData({ totalWords: 100, tables: tables({ 1: [p('telescope', 9), p('tripod', 8)] }) });
    b.api.setGsc({ telescope: { clicks: 12, impressions: 400, position: 4.2 } });
    b.api.renderPhrasesPanel();
    const rows = [...b.d.querySelectorAll('.phrases-row:not(.ranking-row--header)')];
    assert.match(rows[0].textContent, /12/);
    assert.match(rows[1].textContent, /—/);
  });
});

describe('the content-gap list', () => {
  test('stays hidden when there is no gap', () => {
    const b = boot();
    b.api.setData({ totalWords: 100, tables: tables({ 1: [p('telescope', 9)] }) });
    b.api.renderPhrasesPanel();
    assert.ok(b.d.getElementById('phrases-gap').classList.contains('hidden'));
  });

  test('lists the queries the copy never says, with their impressions', () => {
    const b = boot();
    b.api.setData({ totalWords: 100, tables: tables({ 1: [p('telescope', 9)] }) });
    b.api.setGap([{ query: 'cheap binoculars', impressions: 820 }]);
    b.api.renderPhrasesPanel();
    const gap = b.d.getElementById('phrases-gap');
    assert.ok(!gap.classList.contains('hidden'));
    assert.match(gap.textContent, /cheap binoculars/);
    assert.match(gap.textContent, /820/);
  });
});

describe('export', () => {
  test('emits one row per visible phrase across all four tables', () => {
    const b = boot();
    b.api.setData({ totalWords: 100, tables: tables({
      1: [p('telescope', 9)],
      2: [p('best telescope', 4)]
    }) });
    const rows = b.api.phrasesExportValues();
    assert.equal(rows.length, 2);
    assert.equal(rows[0][0], 1, 'the n-gram size column is wrong');
    assert.equal(rows[0][1], 'telescope');
    assert.equal(rows[1][0], 2);
  });

  test('respects the active filter — you export what you are looking at', () => {
    const b = boot();
    b.api.setData({ totalWords: 100, tables: tables({ 1: [p('telescope', 9), p('binoculars', 8)] }) });
    b.api.setSearch('tele');
    // Spread out of the jsdom realm — its Array prototype fails strict
    // deep-equality against this realm's.
    assert.deepEqual([...b.api.phrasesExportValues()].map(r => r[1]), ['telescope']);
  });

  test('flattens the placement chips into one readable column', () => {
    const b = boot({ branded: { 'site.test': 'acme' } });
    b.api.setData({ totalWords: 100, tables: tables({ 1: [p('acme', 9, { chips: ['title', 'h1', 'linked'] })] }) });
    const placement = b.api.phrasesExportValues()[0][5];
    assert.match(placement, /Title/);
    assert.match(placement, /H1/);
    assert.match(placement, /Brand/);
    assert.match(placement, /Linked/);
  });
});

describe('reading the page', () => {
  test('asks the content script, pinned to the top frame', async () => {
    const b = boot({ scan: { scannedAt: 1, totalWords: 50, tables: tables({ 1: [p('telescope', 3)] }) } });
    await b.api.rescanPhrases();
    assert.ok(b.sent.some(m => m.action === 'getKeywordPhrases'), 'never asked for phrases');
  });

  test('a page with no content script reports that rather than blanking silently', async () => {
    const b = boot({ scan: null });
    await b.api.rescanPhrases();
    assert.match(b.d.getElementById('phrases-tables').textContent, /Could not read this page/);
  });
});
