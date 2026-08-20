// Page-level trust signals — the deterministic inputs to the E-E-A-T rule set.
//
// Phase 1 of the E-E-A-T module spec: detection only. No rule fires here, and
// nothing is user-facing yet. The point of doing detection first is that
// hasNamedPeople and unquantifiedClaims are the only genuinely uncertain parts
// of the design, and every rule that consumes them fires on ABSENCE — so a
// false negative produces a recommendation the client has already done, which
// the spec's first constraint says is worse than silence.
//
// Fixtures are modelled on the four roster clients in the spec's test table.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { ROOT } from './helpers.mjs';

const content = await readFile(path.join(ROOT, 'content.js'), 'utf8');
const clients = await readFile(path.join(ROOT, 'bg-clients.js'), 'utf8');

const SLICE = content.slice(
  content.indexOf('// ─── Trust signals (E-E-A-T rule engine inputs)'),
  content.indexOf('// ─── robots.txt: make the URLs clickable')
);

/** Runs the real detector against a document. */
function detect(html, url = 'https://example.com/') {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url, runScripts: 'outside-only' });
  const w = dom.window;
  // getCleanBodyText is defined earlier in content.js; the byline fallback uses it.
  w.eval(content.slice(content.indexOf('function getCleanBodyText()'), content.indexOf('function getBodyWordCount(')));
  w.eval(`${SLICE}\n;window.__detect = detectTrustSignals;`);
  return w.__detect();
}

const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;

// ─── page type ────────────────────────────────────────────────────────────────

describe('page type resolves schema → URL → DOM, and says which', () => {
  test('schema wins over the URL', () => {
    const r = detect(ld({ '@type': 'Article', headline: 'x' }), 'https://example.com/services/roofing/');
    assert.equal(r.pageType, 'article');
    assert.equal(r.pageTypeVia, 'schema');
  });

  test('Organization and LocalBusiness do NOT type the page', () => {
    // They appear site-wide, so letting them decide would type every page the
    // same and make every rule that gates on page_type useless.
    const r = detect(ld({ '@type': 'LocalBusiness', name: 'Acme' }), 'https://example.com/services/roofing/');
    assert.equal(r.pageType, 'service');
    assert.equal(r.pageTypeVia, 'url');
  });

  test('the root path is the homepage', () => {
    const r = detect('<p>hi</p>', 'https://example.com/');
    assert.equal(r.pageType, 'home');
  });

  test('URL patterns cover the spec\'s types', () => {
    const cases = [
      ['https://x.com/blog/post/', 'article'], ['https://x.com/products/widget/', 'product'],
      ['https://x.com/locations/edina/', 'location'], ['https://x.com/about/', 'about'],
      ['https://x.com/services/remodel/', 'service']
    ];
    cases.forEach(([u, want]) => assert.equal(detect('<p>x</p>', u).pageType, want, u));
  });

  test('an unrecognised page falls through, and admits it', () => {
    const r = detect('<p>x</p>', 'https://example.com/xyzzy/');
    assert.equal(r.pageType, 'other');
    assert.equal(r.pageTypeVia, 'default');
  });

  test('a real article element with a byline types by DOM', () => {
    const r = detect('<article><span class="byline">By Jane Smith</span><p>x</p></article>', 'https://example.com/xyzzy/');
    assert.equal(r.pageType, 'article');
    assert.equal(r.pageTypeVia, 'dom');
  });
});

// ─── named people: biased toward detection ────────────────────────────────────

describe('named people', () => {
  test('Person schema counts', () => {
    assert.equal(detect(ld({ '@type': 'Person', name: 'Jane Smith' })).hasNamedPeople, true);
  });

  test('a link to a team page counts', () => {
    const r = detect('<a href="/our-team/">Meet the team</a>');
    assert.equal(r.hasNamedPeople, true);
    assert.match(r.namedPeopleVia, /team or bio/);
  });

  test('a name beside a role counts', () => {
    const r = detect('<li>Jane Smith, Founder</li>');
    assert.equal(r.hasNamedPeople, true);
    assert.match(r.namedPeopleVia, /role/);
  });

  test('"our team" with nobody named does not', () => {
    // This is the case R-NAMED exists for.
    assert.equal(detect('<p>Our team has decades of experience.</p>').hasNamedPeople, false);
  });

  test('a role word with no name does not', () => {
    assert.equal(detect('<p>Our founder started the company.</p>').hasNamedPeople, false);
  });

  test('a capitalised place name beside a role does not false-positive', () => {
    // "Saint Paul" is two capitalised words; without a real name this must not
    // read as a staff listing.
    assert.equal(detect('<p>Our director works across Saint Paul.</p>').hasNamedPeople, false);
  });
});

// ─── visible address: must see the footer ─────────────────────────────────────

describe('visible address', () => {
  test('an <address> element counts', () => {
    const r = detect('<footer><address>123 Main St, Minneapolis, MN 55401</address></footer>');
    assert.equal(r.hasVisibleAddress, true);
  });

  test('a NAP block in the footer counts even though getCleanBodyText strips footers', () => {
    // The detector deliberately reads the whole document — a footer is where a
    // NAP block almost always lives.
    const r = detect('<main><p>Welcome</p></main><footer><div>2001 Broadway St NE, Minneapolis, MN 55413</div></footer>');
    assert.equal(r.hasVisibleAddress, true);
    assert.match(r.visibleAddressVia, /rendered text/);
  });

  test('schema alone does not count as visible', () => {
    // R-ADDRESS asks for something a human can see.
    const r = detect(ld({ '@type': 'LocalBusiness', address: { '@type': 'PostalAddress', streetAddress: '123 Main St' } }));
    assert.equal(r.hasVisibleAddress, false);
  });

  test('a bare city and state is not an address', () => {
    assert.equal(detect('<p>Serving Minneapolis, MN and the metro.</p>').hasVisibleAddress, false);
  });
});

// ─── third-party proof ────────────────────────────────────────────────────────

describe('third-party verification', () => {
  test('a review platform link counts, with its category', () => {
    const r = detect('<a href="https://www.houzz.com/pro/acme">Houzz</a>');
    assert.equal(r.hasThirdPartyProof, true);
    assert.equal(r.thirdPartyProof[0].category, 'review platform');
  });

  test('a .gov link counts as licensing', () => {
    const r = detect('<a href="https://mn.gov/licensing/lookup">License</a>');
    assert.match(r.thirdPartyProof[0].category, /government/);
  });

  test('links to the site\'s own domain never count', () => {
    const r = detect('<a href="https://example.com/reviews/">Our reviews</a><a href="/testimonials/">More</a>');
    assert.equal(r.hasThirdPartyProof, false);
  });

  test('a subdomain of the site is still the site', () => {
    const r = detect('<a href="https://blog.example.com/x">Blog</a>', 'https://example.com/');
    assert.equal(r.hasThirdPartyProof, false);
  });

  test('an arbitrary outbound link is not verification', () => {
    assert.equal(detect('<a href="https://somepartner.com/">Partner</a>').hasThirdPartyProof, false);
  });
});

// ─── unquantified claims ──────────────────────────────────────────────────────

describe('claims of standing', () => {
  test('"44 years" with nothing to check it against fires', () => {
    // From the spec's TreHus case. It is specific but unverified — the rule
    // that consumes this asks for it to be anchored, not made more precise.
    const r = detect('<p>44 years of craftsmanship.</p>');
    assert.equal(r.unquantifiedClaims.length, 1);
    assert.match(r.unquantifiedClaims[0].claim, /44 years/i);
  });

  test('a claim does NOT prove itself with its own number', () => {
    // The failure mode the adjacency rule exists to avoid: "44 years" contains
    // a numeral, so counting the whole block would mark it proven and the rule
    // would never fire on anything.
    assert.equal(detect('<p>44 years of craftsmanship.</p>').unquantifiedClaims.length, 1);
  });

  test('a separate figure in the same block proves it', () => {
    assert.equal(detect('<p>44 years and 1,200 completed projects.</p>').unquantifiedClaims.length, 0);
  });

  test('a year proves it', () => {
    assert.equal(detect('<p>Trusted since 1981.</p>').unquantifiedClaims.length, 0);
  });

  test('a certifying body proves it', () => {
    assert.equal(detect('<p>An award-winning firm, NARI certified.</p>').unquantifiedClaims.length, 0);
  });

  test('a link in the block proves it', () => {
    assert.equal(detect('<p>Award-winning <a href="/awards">work</a>.</p>').unquantifiedClaims.length, 0);
  });

  test('the matched string is emitted so the analyst sees the trigger', () => {
    const [c] = detect('<p>The leading choice for homeowners.</p>').unquantifiedClaims;
    assert.equal(c.claim.toLowerCase(), 'leading');
    assert.match(c.context, /leading choice/);
  });

  test('findings are capped', () => {
    const many = Array.from({ length: 40 }, (_, i) => `<p>Trusted choice number ${'x'.repeat(i % 5)}</p>`).join('');
    assert.ok(detect(many).unquantifiedClaims.length <= 12);
  });
});

// ─── schema-derived inputs ────────────────────────────────────────────────────

describe('schema inputs the rules need', () => {
  test('Organization is found inside an @graph', () => {
    const r = detect(ld({ '@graph': [{ '@type': 'WebSite' }, { '@type': 'Organization', name: 'Acme', sameAs: ['https://x.com/acme'] }] }));
    assert.equal(r.hasOrganizationSchema, true);
    assert.equal(r.hasOrganizationSameAs, true);
  });

  test('Organization without sameAs is incomplete — R-ORG fires on this', () => {
    const r = detect(ld({ '@type': 'Organization', name: 'Acme' }));
    assert.equal(r.hasOrganizationSchema, true);
    assert.equal(r.hasOrganizationSameAs, false);
  });

  test('an empty sameAs array does not count as complete', () => {
    assert.equal(detect(ld({ '@type': 'Organization', sameAs: [] })).hasOrganizationSameAs, false);
  });

  test('aggregateRating on LocalBusiness is detected for the B-SELFSERVING audit', () => {
    // Informational only: it will not produce stars, but the client may
    // believe it is working.
    const r = detect(ld({ '@type': 'LocalBusiness', aggregateRating: { '@type': 'AggregateRating', ratingValue: 4.9 } }));
    assert.equal(r.hasAggregateRatingOnOrg, true);
  });

  test('aggregateRating on a Product is NOT flagged — that one is legitimate', () => {
    const r = detect(ld({ '@type': 'Product', aggregateRating: { '@type': 'AggregateRating', ratingValue: 4.5 } }));
    assert.equal(r.hasAggregateRatingOnOrg, false);
  });

  test('malformed JSON-LD is skipped, not thrown on', () => {
    const r = detect('<script type="application/ld+json">{ not json </script><p>x</p>');
    assert.deepEqual([...r.schemaTypes], []);
  });
});

// ─── the spec's roster fixtures ───────────────────────────────────────────────

describe('roster fixtures from the spec', () => {
  test('TreHus home: no named people, an unanchored 44-years claim', () => {
    const r = detect(`
      ${ld({ '@type': 'LocalBusiness', name: 'TreHus' })}
      <h1>Design-Build in Minneapolis</h1>
      <p>44 years of craftsmanship.</p>
      <p>Our team brings your project to life.</p>
      <footer><div>2001 Broadway St NE, Minneapolis, MN 55413</div></footer>`,
      'https://trehus.biz/');
    assert.equal(r.pageType, 'home');
    assert.equal(r.hasNamedPeople, false);              // R-NAMED fires
    assert.ok(r.unquantifiedClaims.length >= 1);         // R-PROOF fires
    assert.equal(r.hasVisibleAddress, true);             // R-ADDRESS does not
    assert.equal(r.hasThirdPartyProof, false);           // R-THIRDPARTY fires
    assert.equal(r.hasByline, false);                    // R-PERSON-SCHEMA cannot fire
  });

  test('Matrix Engineering article: byline present, author page missing', () => {
    const r = detect(`
      ${ld({ '@type': 'Article', headline: 'Load paths' })}
      <article><span class="byline">By Dana Whitfield</span><p>Structural notes.</p></article>`,
      'https://matrix.example/insights/load-paths/');
    assert.equal(r.pageType, 'article');
    assert.equal(r.hasByline, true);
    assert.equal(r.bylineName, 'Dana Whitfield');
    assert.equal(r.bylineHref, null);                    // R-AUTHOR-PAGE fires
    assert.equal(r.hasPersonSchema, false);              // R-PERSON-SCHEMA fires
    assert.equal(r.hasNamedPeople, true);
  });

  test('a byline that already links to a bio suppresses R-AUTHOR-PAGE', () => {
    const r = detect('<article><a rel="author" href="/team/dana/">Dana Whitfield</a><p>x</p></article>',
      'https://matrix.example/insights/load-paths/');
    assert.equal(r.hasByline, true);
    assert.match(r.bylineHref, /\/team\/dana\//);
  });

  test('MSA Magnetics product: Product typed from schema, org incomplete', () => {
    const r = detect(`${ld({ '@type': 'Product', name: 'Magnet' })}${ld({ '@type': 'Organization', name: 'MSA' })}<p>x</p>`,
      'https://msa.example/catalog/magnet/');
    assert.equal(r.pageType, 'product');                 // R-REVIEW-DISPLAY-STARS eligible
    assert.equal(r.hasOrganizationSameAs, false);         // R-ORG fires
  });

  test('MN Neuropsychology service: named clinicians, address, no third-party proof', () => {
    const r = detect(`
      ${ld({ '@type': 'LocalBusiness', name: 'MN Neuropsychology' })}
      <h1>Pediatric evaluations</h1>
      <li>Dr. Karen Lidstrom, Psychologist</li>
      <address>1234 Cedar Ave, Minneapolis, MN 55407</address>`,
      'https://mnneuropsychology.com/services/evaluations/');
    assert.equal(r.pageType, 'service');
    assert.equal(r.hasNamedPeople, true);                 // R-NAMED suppressed
    assert.equal(r.hasVisibleAddress, true);              // R-ADDRESS suppressed
    assert.equal(r.hasThirdPartyProof, false);            // R-THIRDPARTY fires
  });

  test('the payload is structured-cloneable', () => {
    // It crosses the content-script → popup message boundary.
    const r = detect('<p>44 years.</p><a href="https://yelp.com/biz/x">Yelp</a>');
    assert.doesNotThrow(() => structuredClone(r));
  });
});

// ─── client-level gating config ───────────────────────────────────────────────

describe('the client trust profile', () => {
  const norm = new Function(
    `${clients.slice(clients.indexOf('const CLIENT_BUSINESS_MODELS'), clients.indexOf('function clientRegistryNew('))}
     return clientRegistryNormalizeTrust;`
  )();

  test('defaults are the conservative ones', () => {
    // authoredContent false suppresses all author advice; most service
    // businesses should never see it.
    const d = norm(undefined);
    assert.equal(d.authoredContent, false);
    assert.equal(d.hasGbp, false);
    assert.equal(d.ymyl, 'none');
  });

  test('"regulated" is a valid YMYL level', () => {
    // Open question 3: engineering and water treatment need licensure
    // surfaced without masquerading as health.
    assert.equal(norm({ ymyl: 'regulated' }).ymyl, 'regulated');
  });

  test('all five business models from the spec are accepted', () => {
    ['local_service', 'ecommerce', 'b2b_technical', 'multi_location', 'publisher']
      .forEach(v => assert.equal(norm({ businessModel: v }).businessModel, v));
  });

  test('an unknown value is coerced, never carried through', () => {
    // A shard from a newer build must not put the rule engine in a state no
    // rule accounts for.
    assert.equal(norm({ businessModel: 'nonsense', ymyl: 'nope' }).businessModel, 'local_service');
    assert.equal(norm({ ymyl: 'nope' }).ymyl, 'none');
  });

  test('booleans are coerced rather than trusted', () => {
    assert.equal(norm({ hasGbp: 'yes' }).hasGbp, true);
    assert.equal(norm({ authoredContent: 0 }).authoredContent, false);
  });

  test('a new client starts with a trust profile', () => {
    assert.match(clients, /trust: clientRegistryTrustDefaults\(\)/);
  });
});
