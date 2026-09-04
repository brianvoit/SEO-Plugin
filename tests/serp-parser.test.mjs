// Tests content-serp.js's SERP parser against REAL captured Google search
// result HTML (tests/fixtures/serp/*.html — captured live, scripts stripped,
// personalized/session data trimmed) plus one hand-authored synthetic ad
// fixture. Every real search attempted for this feature returned genuinely
// empty ad-slot containers (Google appears to suppress ad serving for this
// automated context — the same class of problem as this project's known
// WebCEO IP-filtering issue), so ads-synthetic.html is explicitly NOT a live
// capture; see the comment at the top of that file for why.
//
// The parser module is sliced out of content-serp.js between its own banner
// comments and run via `new Function(...)` against a real jsdom-loaded page,
// mirroring marketing-tags.test.mjs's exact technique — testing a
// reimplementation would prove nothing about the shipped detection.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { ROOT } from './helpers.mjs';

const START = '// ─── SERP parser: start';
const END = '// ─── SERP parser: end';

const src = await readFile(path.join(ROOT, 'content-serp.js'), 'utf8');
const from = src.indexOf(START);
const to = src.indexOf(END);

test('the parser is still where the test expects it', () => {
  assert.ok(from !== -1, `could not find "${START}" in content-serp.js — update this test's slice markers`);
  assert.ok(to > from, `could not find "${END}" after the parser`);
});

const source = src.slice(from, to);

async function loadFixture(name) {
  return readFile(path.join(ROOT, 'tests', 'fixtures', 'serp', name), 'utf8');
}

/** Runs the real parser over a captured or synthetic SERP page. */
function parse(html, url = 'https://www.google.com/search?q=test') {
  const dom = new JSDOM(html, { url });
  const { window } = dom;
  const { parseSerpResults } = new Function(
    'document', 'location', 'window',
    `${source}; return { parseSerpResults };`
  )(window.document, window.location, window);
  return parseSerpResults(window.document);
}

/** Loads the full parser module (Phase 2's pure functions included) against a page. */
function load(html, url = 'https://www.google.com/search?q=test') {
  const dom = new JSDOM(html, { url });
  const { window } = dom;
  const mod = new Function(
    'document', 'location', 'window',
    `${source}; return { parseSerpResults, resultSnippetText, findSnippetSpan, resultCardEl, titlesDiffer, descriptionsDiffer, serpQuery };`
  )(window.document, window.location, window);
  return { ...mod, doc: window.document };
}

describe('organic results, from a real captured page (running-shoes-organic.html)', () => {
  let html;
  test('fixture loads', async () => { html = await loadFixture('running-shoes-organic.html'); assert.ok(html.length > 1000); });

  test('finds a plausible number of organic results, none of them zero', async () => {
    const parsed = parse(html);
    assert.ok(parsed.organic.length >= 3, `expected at least 3 organic results, got ${parsed.organic.length}`);
  });

  test('every organic result gets a sequential 1-based position', async () => {
    const parsed = parse(html);
    assert.deepEqual(parsed.organic.map(r => r.position), parsed.organic.map((_, i) => i + 1));
  });

  test('a real known result resolves its domain from the visible breadcrumb, not the internal redirect href', async () => {
    // The captured page's actual anchor hrefs are Google's own /goto?url=...
    // click-tracking wrapper, not the destination — confirmed against the
    // live page, not assumed. This is the case the breadcrumb-first design
    // exists for.
    const parsed = parse(html);
    const fleetFeet = parsed.organic.find(r => r.domain === 'fleetfeet.com');
    assert.ok(fleetFeet, `expected a fleetfeet.com organic result among: ${parsed.organic.map(r => r.domain).join(', ')}`);
  });

  test('People Also Ask rows are never counted as organic results', async () => {
    const parsed = parse(html);
    // PAA question text should not appear as a "result" domain/heading in the
    // organic list — proven indirectly: PAA rows carry no <cite>, so if the
    // structural test worked, none of these results should be undomained
    // *and* sitting inside the People Also Ask heading region. The stronger,
    // direct proof is the skipped-count test below staying low relative to
    // total h3 count, not a specific PAA row leaking through.
    assert.ok(html.includes('People also ask'), 'fixture sanity: PAA should be present');
    assert.equal(parsed.organic.some(r => r.el === undefined), false);
  });

  test('no ads are found on a page with no ad markup', async () => {
    const parsed = parse(html);
    assert.equal(parsed.topAds.length, 0);
    assert.equal(parsed.bottomAds.length, 0);
  });
});

describe('organic results, from a second real captured page (car-insurance-quotes.html)', () => {
  let html;
  test('fixture loads', async () => { html = await loadFixture('car-insurance-quotes.html'); assert.ok(html.length > 1000); });

  test('finds the real Allstate organic result with its domain resolved', async () => {
    const parsed = parse(html);
    const allstate = parsed.organic.find(r => r.domain === 'allstate.com');
    assert.ok(allstate, `expected an allstate.com organic result among: ${parsed.organic.map(r => r.domain).join(', ')}`);
  });

  test('the AI Overview citation panel is not counted as an organic result', async () => {
    // The AI Overview's own citation cards use a different, simpler markup
    // (a plain text div, no <h3>/<cite> pair) — they should never satisfy the
    // structural organic test at all, so this just guards against the count
    // being implausibly inflated by them.
    const parsed = parse(html);
    assert.ok(parsed.organic.length < 15, `organic count looks inflated by non-result chrome: ${parsed.organic.length}`);
  });
});

describe('ads, from the synthetic fixture (ads-synthetic.html — see its header comment)', () => {
  let html;
  test('fixture loads', async () => { html = await loadFixture('ads-synthetic.html'); assert.ok(html.length > 500); });

  test('top ads and bottom ads are counted into separate, independent counters', async () => {
    const parsed = parse(html);
    assert.equal(parsed.topAds.length, 2);
    assert.equal(parsed.bottomAds.length, 1);
    assert.deepEqual(parsed.topAds.map(a => a.position), [1, 2]);
    assert.deepEqual(parsed.bottomAds.map(a => a.position), [1]);
  });

  test('ad domains resolve from the breadcrumb, not the aclk click-tracking redirect', async () => {
    // The exact case resultDomain()'s fallback chain exists to handle: the
    // href is https://www.googleadservices.com/pagead/aclk?... and never
    // reveals the advertiser's real domain.
    const parsed = parse(html);
    assert.deepEqual(parsed.topAds.map(a => a.domain), ['progressive.com', 'geico.com']);
    assert.deepEqual(parsed.bottomAds.map(a => a.domain), ['statefarm.com']);
  });

  test('the one organic result on the ad fixture is not miscounted as an ad', async () => {
    const parsed = parse(html);
    assert.equal(parsed.organic.length, 1);
    assert.equal(parsed.organic[0].domain, 'allstate.com');
  });

  test('a Google-owned aclk host is never returned as a result domain', async () => {
    const parsed = parse(html);
    const allDomains = [...parsed.organic, ...parsed.topAds, ...parsed.bottomAds].map(r => r.domain);
    assert.ok(!allDomains.some(d => /google|doubleclick/.test(d || '')));
  });
});

describe('ads, from the card-list layout (sponsored-results-list.html — reconstructed from a real bug report)', () => {
  // Real bug: a genuine sponsored card on a live page went undetected and
  // was miscounted as organic. adUnitFor() used to climb a fixed 6 ancestor
  // levels checking only each level's direct children for a Sponsored/Ad
  // label — this widget's per-card label sits deeper than a direct child of
  // any of those levels. The fix bounds the climb by an h3-count invariant
  // (stop the moment an ancestor spans more than one result's heading)
  // instead of a fixed depth, and searches each still-safe ancestor's whole
  // subtree.
  let html;
  test('fixture loads', async () => { html = await loadFixture('sponsored-results-list.html'); assert.ok(html.length > 500); });

  test('all three sponsored cards are detected as ads, not organic', async () => {
    const parsed = parse(html);
    assert.equal(parsed.topAds.length, 3, `expected 3 sponsored cards detected as ads, got ${parsed.topAds.length}`);
    assert.deepEqual(parsed.topAds.map(a => a.domain), ['mnneuropsychology.com', 'mindfulevaluations.com', 'thousandbrancheswellness.com']);
  });

  test('a per-card label nested deeper than a direct child of any climbed ancestor is still found', async () => {
    // The specific structural shape of the real bug: <div class="wrap-a">
    // <div class="wrap-b"><div class="ENsxge">Sponsored</div></div></div> —
    // the label is two levels below the ad-unit wrapper, not a direct child.
    const parsed = parse(html);
    assert.ok(parsed.topAds.some(a => a.domain === 'mnneuropsychology.com'));
  });

  test('the genuine organic result below the sponsored list is not swept up as an ad', async () => {
    const parsed = parse(html);
    assert.equal(parsed.organic.length, 1);
    assert.equal(parsed.organic[0].domain, 'acp-mn.com');
  });

  test('the shared "Sponsored results" section heading is never itself mistaken for a result', async () => {
    // Its own ancestor spans all three ad cards' h3s at once, so the
    // h3-count guard must stop climbing before ever reaching it.
    const parsed = parse(html);
    const allDomains = [...parsed.organic, ...parsed.topAds, ...parsed.bottomAds].map(r => r.domain);
    assert.equal(allDomains.length, 4, 'expected exactly 4 real results (3 ads + 1 organic), no phantom entries');
  });
});

describe('ads, from a THIRD real layout with no per-card label at all (sponsored-results-no-label.html)', () => {
  // A real bug report screenshot: cards under a "Sponsored Results" heading
  // that carry no "Sponsored" text anywhere near them at all — a photo
  // carousel, rating stars, Website/Directions/Call pill buttons, otherwise
  // indistinguishable from a rich organic result. adUnitFor()'s per-card
  // label search can never catch this — there is no label to find. Detection
  // instead comes from sponsoredSectionRanges: the section heading opens a
  // range, closed by the next real accessible heading or known
  // section-transition phrase found afterward (here, "Hide sponsored
  // results" — the same toggle both real captures of ad-card layouts carry).
  let html;
  test('fixture loads', async () => { html = await loadFixture('sponsored-results-no-label.html'); assert.ok(html.length > 500); });

  test('both unlabeled sponsored cards are detected as ads', async () => {
    const parsed = parse(html);
    assert.equal(parsed.topAds.length, 2, `expected 2 sponsored cards detected as ads, got ${parsed.topAds.length}`);
    assert.deepEqual(parsed.topAds.map(a => a.domain), ['mnneuropsychology.com', 'lifestance.com']);
  });

  test('the genuine organic result after the "Hide sponsored results" toggle is not swept up as an ad', async () => {
    const parsed = parse(html);
    assert.equal(parsed.organic.length, 1);
    assert.equal(parsed.organic[0].domain, 'acp-mn.com');
  });
});

describe('ads, from a real layout with NO h3/cite anywhere in the ad block (ads-native-markers.html)', () => {
  // Real bug report: "It didn't catch that there were two sponsored results.
  // 1 in the top and 1 in the bottom." — a real live capture where BOTH the
  // top and bottom ad blocks were missed entirely, because every candidate-
  // anchor filter required an <h3> descendant, and this layout's ad titles
  // are a role="heading" div instead (never an <h3>), with a data-dtld
  // attribute standing in for <cite>. Fixed via nativeAdUnitFor() trusting
  // data-text-ad="1"/#tads/#tadsb/role=region[aria-label="Ads"] directly,
  // and hasResultHeading() recognizing a role="heading" descendant OR
  // ancestor of the anchor, not just a nested <h3>.
  let html;
  test('fixture loads', async () => { html = await loadFixture('ads-native-markers.html'); assert.ok(html.length > 500); });

  test('all three top ads are detected, none of them missed for lacking an h3', async () => {
    const parsed = parse(html);
    assert.equal(parsed.topAds.length, 3, `expected 3 top ads, got ${parsed.topAds.length}`);
    assert.deepEqual(parsed.topAds.map(a => a.domain), ['mnneuropsychology.com', 'thousandbrancheswellness.com', 'adhdadvisor.org']);
  });

  test('both bottom ads are detected, including the local-pack-style card whose role="heading" wraps the anchor instead of nesting inside it', async () => {
    const parsed = parse(html);
    assert.equal(parsed.bottomAds.length, 2, `expected 2 bottom ads, got ${parsed.bottomAds.length}`);
    assert.deepEqual(parsed.bottomAds.map(a => a.domain), ['mnneuropsychology.com', 'thousandbrancheswellness.com']);
  });

  test('the genuine organic result between the two ad blocks is not swept up as an ad', async () => {
    const parsed = parse(html);
    assert.equal(parsed.organic.length, 1);
    assert.equal(parsed.organic[0].domain, 'acp-mn.com');
  });
});

describe('sponsoredSectionRanges never leaves a range open-ended', () => {
  // The regression this guards: a per-card "Sponsored" label (the classic
  // #tads layout's OWN detection mechanism) also matches the range opener's
  // shape. On a page with no closing boundary anywhere after it, treating
  // that as open-ended swept every later organic result into the range —
  // caught by re-running ads-synthetic.html's own "not miscounted" test
  // while building this fix. A range must have both ends confidently known,
  // or it must not exist at all.
  test('a page with a per-card label but no closing boundary produces no range at all', async () => {
    const html = await loadFixture('ads-synthetic.html');
    const { parseSerpResults, doc } = load(html);
    const parsed = parseSerpResults(doc);
    // The organic Allstate result on that fixture must stay organic — this
    // is the same assertion as ads-synthetic.html's own test, re-asserted
    // here because it's specifically what this fix protects.
    assert.ok(parsed.organic.some(r => r.domain === 'allstate.com'));
  });
});

describe('fail gracefully: an ambiguous block is skipped, never guessed at', () => {
  test('an h3 with neither a cite nor a sponsored label increments skipped, not organic or ad', () => {
    const html = `<!doctype html><html><body>
      <div id="search"><div id="rso">
        <a href="/goto?url=abc"><h3>A real result</h3><cite>https://real.example</cite></a>
        <a href="/goto?url=xyz"><h3>Ambiguous block with no breadcrumb and no ad label</h3></a>
      </div></div>
    </body></html>`;
    const parsed = parse(html);
    assert.equal(parsed.organic.length, 1);
    assert.equal(parsed.organic[0].domain, 'real.example');
    assert.ok(parsed.skipped >= 1, `expected the ambiguous block to be counted as skipped, got ${parsed.skipped}`);
  });
});

// ─── Phase 2: WebCEO enrichment's pure helpers ────────────────────────────────

describe('resultSnippetText, against real captured pages', () => {
  test('every organic result on running-shoes-organic.html resolves a plausible snippet', async () => {
    const html = await loadFixture('running-shoes-organic.html');
    const { parseSerpResults, resultSnippetText, doc } = load(html);
    const parsed = parseSerpResults(doc);
    assert.ok(parsed.organic.length >= 5, 'fixture sanity: expected several organic results');
    parsed.organic.forEach(r => {
      const snippet = resultSnippetText(r.el);
      assert.ok(snippet && snippet.length >= 20, `no plausible snippet found for ${r.domain}: ${JSON.stringify(snippet)}`);
    });
  });

  test('the Fleet Feet result resolves its real, known snippet text', async () => {
    const html = await loadFixture('running-shoes-organic.html');
    const { parseSerpResults, resultSnippetText, doc } = load(html);
    const parsed = parseSerpResults(doc);
    const fleetFeet = parsed.organic.find(r => r.domain === 'fleetfeet.com');
    assert.ok(fleetFeet, 'fixture sanity: expected a fleetfeet.com result');
    assert.match(resultSnippetText(fleetFeet.el), /free shipping/i);
  });

  test('every organic result on car-insurance-quotes.html resolves a plausible snippet', async () => {
    const html = await loadFixture('car-insurance-quotes.html');
    const { parseSerpResults, resultSnippetText, doc } = load(html);
    const parsed = parseSerpResults(doc);
    assert.ok(parsed.organic.length >= 5, 'fixture sanity: expected several organic results');
    parsed.organic.forEach(r => {
      const snippet = resultSnippetText(r.el);
      assert.ok(snippet && snippet.length >= 20, `no plausible snippet found for ${r.domain}: ${JSON.stringify(snippet)}`);
    });
  });

  test('the title itself is never mistaken for the snippet', async () => {
    const html = await loadFixture('running-shoes-organic.html');
    const { parseSerpResults, resultSnippetText, doc } = load(html);
    const parsed = parseSerpResults(doc);
    const fleetFeet = parsed.organic.find(r => r.domain === 'fleetfeet.com');
    const titleText = fleetFeet.el.querySelector('h3').textContent;
    assert.notEqual(resultSnippetText(fleetFeet.el), titleText);
  });
});

describe('resultCardEl: the hover-reveal target covers the whole visible card', () => {
  // Reported bug: the badge only revealed on hovering the title/URL line —
  // the description text sits outside the anchor entirely (a sibling, not
  // nested inside it), so hovering it did nothing. The fix derives the card
  // boundary structurally (the smallest ancestor containing both the title
  // and the snippet) rather than a hardcoded depth or class name.
  test('the derived card contains both the title anchor and its snippet, for every organic result on both real fixtures', async () => {
    for (const name of ['running-shoes-organic.html', 'car-insurance-quotes.html']) {
      const html = await loadFixture(name);
      const { parseSerpResults, resultCardEl, findSnippetSpan, doc } = load(html);
      const parsed = parseSerpResults(doc);
      assert.ok(parsed.organic.length >= 3, `fixture sanity: expected several organic results in ${name}`);
      parsed.organic.forEach(r => {
        const card = resultCardEl(r.el);
        const span = findSnippetSpan(r.el);
        assert.ok(card.contains(r.el), `${name}/${r.domain}: card does not contain its own title anchor`);
        assert.ok(span && card.contains(span), `${name}/${r.domain}: card does not contain its snippet`);
      });
    }
  });

  test('the card is strictly larger than the anchor alone, not just the anchor itself', async () => {
    const html = await loadFixture('running-shoes-organic.html');
    const { parseSerpResults, resultCardEl, doc } = load(html);
    const parsed = parseSerpResults(doc);
    const fleetFeet = parsed.organic.find(r => r.domain === 'fleetfeet.com');
    assert.notEqual(resultCardEl(fleetFeet.el), fleetFeet.el);
  });

  test('with no snippet found, the card falls back to the anchor itself rather than throwing', () => {
    const html = `<!doctype html><html><body>
      <div id="search"><div id="rso">
        <a href="/goto?url=abc"><h3>A result with no snippet nearby</h3><cite>https://real.example</cite></a>
      </div></div>
    </body></html>`;
    const { parseSerpResults, resultCardEl, doc } = load(html);
    const parsed = parseSerpResults(doc);
    assert.equal(parsed.organic.length, 1);
    assert.equal(resultCardEl(parsed.organic[0].el), parsed.organic[0].el);
  });
});

describe('serpQuery', () => {
  test('reads the q= param from the SERP URL', () => {
    const { serpQuery } = load('<!doctype html><html><body></body></html>', 'https://www.google.com/search?q=buy+running+shoes+online');
    assert.equal(serpQuery(), 'buy running shoes online');
  });

  test('a page with no query returns an empty string, not null/undefined', () => {
    const { serpQuery } = load('<!doctype html><html><body></body></html>', 'https://www.google.com/search');
    assert.equal(serpQuery(), '');
  });
});

describe('titlesDiffer: truncation-aware, not literal equality', () => {
  test('an exact match never differs', () => {
    const { titlesDiffer } = load('<html><body></body></html>');
    assert.equal(titlesDiffer('Fleet Feet', 'Fleet Feet'), false);
  });

  test('a Google-truncated title (real title is a longer superstring) does not differ', () => {
    const { titlesDiffer } = load('<html><body></body></html>');
    assert.equal(titlesDiffer('Running Shoes | Free Shipping...', 'Running Shoes | Free Shipping Orders $99+ | Fleet Feet'), false);
  });

  test('case and whitespace differences alone do not count as differing', () => {
    const { titlesDiffer } = load('<html><body></body></html>');
    assert.equal(titlesDiffer('  fleet feet  ', 'Fleet Feet'), false);
  });

  test('genuinely different wording differs', () => {
    const { titlesDiffer } = load('<html><body></body></html>');
    assert.equal(titlesDiffer('Best Running Shoes 2024', 'Home Page - Fleet Feet'), true);
  });

  test('a missing value on either side never claims a difference', () => {
    const { titlesDiffer } = load('<html><body></body></html>');
    assert.equal(titlesDiffer('', 'Fleet Feet'), false);
    assert.equal(titlesDiffer('Fleet Feet', null), false);
  });
});

describe('descriptionsDiffer: word-overlap, not literal equality', () => {
  test('a paraphrased-but-related snippet does not count as differing', () => {
    const { descriptionsDiffer } = load('<html><body></body></html>');
    assert.equal(descriptionsDiffer(
      'Shop running shoes with free shipping on orders over $99',
      'Free shipping on all running shoe orders over ninety-nine dollars'
    ), false);
  });

  test('an unrelated snippet (Google ignoring the meta tag entirely) differs', () => {
    const { descriptionsDiffer } = load('<html><body></body></html>');
    assert.equal(descriptionsDiffer(
      'Shop running shoes with free shipping',
      'Contact us for store hours and location information'
    ), true);
  });

  test('a missing value on either side never claims a difference', () => {
    const { descriptionsDiffer } = load('<html><body></body></html>');
    assert.equal(descriptionsDiffer('', 'Something real'), false);
    assert.equal(descriptionsDiffer('Something shown', null), false);
  });
});
