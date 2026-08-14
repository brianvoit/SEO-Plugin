// Tests content.js's keyword-phrase extraction — the panel behind the chevron
// on the HEADINGS section.
//
// The whole point of this screen is telling a marketer what a page is ACTUALLY
// about, so the failure modes that matter are all "it counted the wrong words":
// navigation and footer boilerplate leaking in, function words dominating the
// tables, phrases glued together across unrelated blocks. Each of those is a
// silent wrong answer rather than a crash, so the real detectKeywordPhrases()
// is sliced out of content.js and run against jsdom pages built to trip it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { ROOT } from './helpers.mjs';

const START = 'const PHRASE_STOPWORDS = new Set([';
const END = '// ─── Tooltip';

const src = await readFile(path.join(ROOT, 'content.js'), 'utf8');
const from = src.indexOf(START);
const to = src.indexOf(END);

test('the extractor is still where the test expects it', () => {
  assert.ok(from !== -1, `could not find "${START}" in content.js — update this test's slice markers`);
  assert.ok(to > from, `could not find "${END}" after the extractor`);
});

// isBodyContent lives further up content.js (shared with the link readers), so
// it's pulled in separately rather than duplicated here — the nav/footer
// exclusion is exactly what several tests below are checking.
const IS_BODY_START = 'function isBodyContent(el)';
const IS_BODY_END = 'function getHreflang()';
const isBodySrc = src.slice(src.indexOf(IS_BODY_START), src.indexOf(IS_BODY_END));

const source = isBodySrc + '\n' + src.slice(from, to);

/** Runs the real extractor over a page. `head` markup lets tests set title/meta. */
function scan(bodyHtml, headHtml = '') {
  const dom = new JSDOM(
    `<!doctype html><html><head>${headHtml}</head><body>${bodyHtml}</body></html>`,
    { url: 'https://site.test/' }
  );
  const { detectKeywordPhrases, phrasesPresence } = new Function(
    'document',
    `${source}; return { detectKeywordPhrases, phrasesPresence };`
  )(dom.window.document);
  return { ...detectKeywordPhrases(), phrasesPresence };
}

/** The row for `phrase` in the n-word table, or undefined. */
const row = (res, n, phrase) => res.tables[n].find(p => p.phrase === phrase);
const phrases = (res, n) => res.tables[n].map(p => p.phrase);

describe('what counts as page content', () => {
  test('navigation, header, footer and aside copy is excluded', () => {
    // The headline requirement: boilerplate repeated on every page of a site
    // would otherwise dominate every table and drown the actual content.
    const res = scan(`
      <nav><p>widget widget widget</p></nav>
      <header><p>widget widget</p></header>
      <footer><p>widget widget widget</p></footer>
      <aside><p>widget</p></aside>
      <p>telescope</p>
    `);
    assert.equal(row(res, 1, 'widget'), undefined, 'boilerplate copy leaked into the tables');
    assert.ok(row(res, 1, 'telescope'), 'real body copy was not counted');
  });

  test('ARIA landmark roles are excluded too, not just the tags', () => {
    // A div[role=navigation] is just as much nav as a <nav> is.
    const res = scan(`
      <div role="navigation"><p>widget widget</p></div>
      <div role="contentinfo"><p>widget</p></div>
      <p>telescope</p>
    `);
    assert.equal(row(res, 1, 'widget'), undefined);
  });

  test('cookie-consent banners are excluded structurally', () => {
    // These sit in <body>, outside nav/header/footer, so the landmark rules
    // above never catch them — and on a site with a persistent banner they
    // can outrank the actual copy.
    const res = scan(`
      <div id="cookie-banner"><p>manage your widget preferences</p></div>
      <div class="cc-consent-modal"><p>widget widget widget</p></div>
      <div aria-label="Cookie notice"><p>widget</p></div>
      <p>telescope</p>
    `);
    assert.equal(row(res, 1, 'widget'), undefined, 'consent-banner copy leaked into the tables');
    assert.ok(row(res, 1, 'telescope'));
  });

  test('a legitimate word is not excluded just for sitting near one', () => {
    // The selector matches containers, not text — a paragraph mentioning
    // cookies in real content still counts.
    const res = scan('<p>our chocolate biscuits and shortbread</p>');
    assert.ok(row(res, 1, 'biscuits'));
    assert.ok(row(res, 1, 'shortbread'));
  });

  test('phrases never bridge two blocks', () => {
    // "shoes running" only exists if the last word of one paragraph is glued
    // to the first of the next — a phrase the page never actually says.
    const res = scan('<p>leather shoes</p><p>running track</p>');
    assert.equal(row(res, 2, 'shoes running'), undefined, 'an n-gram straddled two blocks');
    assert.ok(row(res, 2, 'leather shoes'));
    assert.ok(row(res, 2, 'running track'));
  });

  test('a block nested in another block is counted once, not twice', () => {
    const res = scan('<li><p>telescope</p></li>');
    assert.equal(row(res, 1, 'telescope').count, 1, 'nested blocks double-counted the same words');
  });
});

describe('stopwords', () => {
  test('a phrase starting or ending on a function word is dropped', () => {
    const res = scan('<p>the best telescope for the money</p>');
    assert.equal(row(res, 1, 'the'), undefined, 'an article was counted as a keyword');
    assert.equal(row(res, 2, 'the best'), undefined, 'a phrase led with a stopword');
    assert.equal(row(res, 2, 'for the'), undefined);
  });

  test('but function words INSIDE a phrase are kept', () => {
    // "best time to visit" is a real search phrase; trimming interior
    // stopwords would destroy exactly the phrases this screen exists to find.
    const res = scan('<p>the best time to visit japan today</p>');
    assert.ok(row(res, 4, 'best time to visit'), 'an interior stopword broke a real phrase');
  });

  test('consent and legal boilerplate is dropped', () => {
    // The backstop for banners whose markup gives nothing away for the
    // structural rule to match on.
    const res = scan('<p>we use cookies and consent tracking under our privacy policy telescope</p>');
    ['cookies', 'consent', 'privacy', 'policy'].forEach(w =>
      assert.equal(row(res, 1, w), undefined, `"${w}" should not rank as a keyword`));
    assert.ok(row(res, 1, 'telescope'), 'real content alongside it still counts');
  });

  test('the boilerplate list is a known trade-off, not an oversight', () => {
    // A page genuinely ABOUT privacy policy under-reports its own subject.
    // Pinned so the behaviour is a decision on record rather than a surprise.
    const res = scan('<h1>Privacy Policy</h1><p>our privacy policy explains cookies</p>');
    assert.equal(row(res, 2, 'privacy policy'), undefined);
  });

  test('single letters are dropped, but numbers survive', () => {
    const res = scan('<p>a b telescope 8 inch</p>');
    assert.equal(row(res, 1, 'b'), undefined);
    assert.ok(row(res, 1, '8'), 'a numeric spec was discarded');
  });
});

describe('counting and density', () => {
  test('repeats accumulate into one row', () => {
    const res = scan('<p>telescope</p><p>telescope</p><p>telescope</p>');
    assert.equal(row(res, 1, 'telescope').count, 3);
  });

  test('matching is case-insensitive', () => {
    const res = scan('<p>Telescope</p><p>TELESCOPE</p><p>telescope</p>');
    assert.equal(row(res, 1, 'telescope').count, 3, 'case variants were counted as separate phrases');
  });

  test('no stemming — singular and plural stay distinct', () => {
    // A deliberate choice: "shoe" and "shoes" are different search terms and
    // merging them would misreport what the page says.
    const res = scan('<p>shoe</p><p>shoes</p>');
    assert.equal(row(res, 1, 'shoe').count, 1);
    assert.equal(row(res, 1, 'shoes').count, 1);
  });

  test('density is the share of all counted words', () => {
    const res = scan('<p>telescope mirror telescope lens</p>');
    assert.equal(res.totalWords, 4);
    assert.equal(row(res, 1, 'telescope').density, 2 / 4);
  });

  test('tables are ordered by count, most-used first', () => {
    const res = scan('<p>lens telescope telescope telescope mirror mirror</p>');
    assert.deepEqual(phrases(res, 1).slice(0, 3), ['telescope', 'mirror', 'lens']);
  });

  test('an empty page yields empty tables rather than throwing', () => {
    const res = scan('');
    assert.equal(res.totalWords, 0);
    PHRASE_SIZES.forEach(n => assert.deepEqual(res.tables[n], []));
  });
});

const PHRASE_SIZES = [1, 2, 3, 4];

describe('n-gram lengths', () => {
  test('each table holds only phrases of its own length', () => {
    const res = scan('<p>premium wool running shoes for winter</p>');
    PHRASE_SIZES.forEach(n => {
      res.tables[n].forEach(p => {
        assert.equal(p.phrase.split(' ').length, n, `"${p.phrase}" landed in the ${n}-word table`);
      });
    });
  });

  test('a four-word phrase is found', () => {
    const res = scan('<p>premium wool running shoes</p>');
    assert.ok(row(res, 4, 'premium wool running shoes'));
  });

  test('nothing longer than four words is produced', () => {
    const res = scan('<p>premium wool running shoes for winter hiking trips</p>');
    assert.equal(res.tables[5], undefined);
  });
});

describe('placement chips', () => {
  test('title and meta description are detected', () => {
    const res = scan('<p>telescope</p>', '<title>Best telescope</title><meta name="description" content="A telescope guide">');
    assert.ok(row(res, 1, 'telescope').chips.includes('title'));
    assert.ok(row(res, 1, 'telescope').chips.includes('description'));
  });

  test('each heading level that carries the phrase is chipped', () => {
    const res = scan('<h1>telescope</h1><h3>telescope</h3><p>telescope</p>');
    const chips = row(res, 1, 'telescope').chips;
    assert.ok(chips.includes('h1'));
    assert.ok(chips.includes('h3'));
    assert.ok(!chips.includes('h2'), 'chipped a heading level the phrase is not in');
  });

  test('anchor text earns a "linked" chip — internal and external alike', () => {
    const res = scan(`
      <p><a href="/guides">telescope</a></p>
      <p><a href="https://elsewhere.test/x">binoculars</a></p>
    `);
    assert.ok(row(res, 1, 'telescope').chips.includes('linked'));
    assert.ok(row(res, 1, 'binoculars').chips.includes('linked'), 'external anchor text was not counted as linked');
  });

  test('a nav link does not earn a "linked" chip', () => {
    // Same exclusion as the copy itself — site-wide nav links say nothing
    // about this page's own internal linking.
    const res = scan('<nav><a href="/shop">telescope</a></nav><p>telescope</p>');
    assert.ok(!row(res, 1, 'telescope').chips.includes('linked'));
  });
});

describe('prominence', () => {
  test('an earlier phrase outscores a later one, all else equal', () => {
    const res = scan('<p>alpha</p>' + '<p>filler filler filler filler filler</p>'.repeat(20) + '<p>omega</p>');
    assert.ok(row(res, 1, 'alpha').prominence > row(res, 1, 'omega').prominence);
  });

  test('a phrase in the title outranks an equally-placed one that is not', () => {
    const res = scan('<p>alpha omega</p>', '<title>alpha</title>');
    assert.ok(row(res, 1, 'alpha').prominence > row(res, 1, 'omega').prominence,
      'the title bonus did not lift the phrase above its neighbour');
  });

  test('an H1 outranks an H2', () => {
    const res = scan('<h1>alpha</h1><h2>omega</h2><p>alpha omega</p>');
    assert.ok(row(res, 1, 'alpha').prominence > row(res, 1, 'omega').prominence);
  });

  test('stays within 0–100', () => {
    // Position and tag bonuses are summed, so the very first word of a page
    // that is also in the title is the case most likely to overflow.
    const res = scan('<h1>alpha</h1><p>alpha</p>', '<title>alpha</title>');
    const p = row(res, 1, 'alpha');
    assert.ok(p.prominence >= 0 && p.prominence <= 100, `prominence out of range: ${p.prominence}`);
  });
});

describe('the payload', () => {
  test('is structured-cloneable — no Set, Map or RegExp survives', () => {
    const res = scan('<p>telescope mirror</p>');
    const { phrasesPresence, ...payload } = res;
    assert.doesNotThrow(() => structuredClone(payload));
  });

  test('each table is capped so a long page cannot flood the message', () => {
    // The cap sits well above the ten a table shows at rest — the panel pages
    // through these and an export writes them all — but a 5,000-word page
    // still must not put every distinct phrase on the wire.
    const words = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ');
    const res = scan(`<p>${words}</p>`);
    assert.equal(res.tables[1].length, 100, 'the 1-word table is not capped at PHRASE_CANDIDATE_CAP');
  });
});

describe('content-gap presence check', () => {
  test('reports a term the copy actually contains', () => {
    const res = scan('<p>the best telescope for beginners</p>');
    assert.deepEqual(res.phrasesPresence(['best telescope']).present, ['best telescope']);
  });

  test('reports nothing for a term the copy never says', () => {
    const res = scan('<p>the best telescope for beginners</p>');
    assert.deepEqual(res.phrasesPresence(['cheap binoculars']).present, []);
  });

  test('nav and footer text does not count as present', () => {
    // The gap list's whole claim is "this page never says it" — matching
    // against site-wide chrome would quietly make that claim false.
    const res = scan('<footer><p>cheap binoculars</p></footer><p>telescope</p>');
    assert.deepEqual(res.phrasesPresence(['cheap binoculars']).present, []);
  });

  test('is case-insensitive and tolerates ragged whitespace', () => {
    const res = scan('<p>Best   Telescope for beginners</p>');
    assert.deepEqual(res.phrasesPresence(['BEST telescope']).present, ['BEST telescope']);
  });
});
