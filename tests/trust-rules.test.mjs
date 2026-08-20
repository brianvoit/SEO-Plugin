// The E-E-A-T rule engine — phase 2 of the module spec.
//
// Pure functions over the phase-1 signals plus the client's trust profile. The
// acceptance criteria are the spec's own roster table: each client's config,
// the rules expected to fire, and the rules expected to be suppressed.
//
// The engine exists because three of the spec's constraints cannot be met by a
// prompt — you cannot hard-suppress an LLM, and a model cannot be relied on to
// cite the condition that triggered it. So gating is decided here and only the
// phrasing is delegated.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

const src = await readFile(path.join(ROOT, 'popup-trust.js'), 'utf8');
const plan = await readFile(path.join(ROOT, 'popup-actionplan.js'), 'utf8');

const { evaluateTrustRules, trustRulesPromptBlock } =
  new Function(`${src}; return { evaluateTrustRules, trustRulesPromptBlock };`)();

/** A page with every signal satisfied — start here and break one thing at a time. */
const clean = (over = {}) => ({
  pageType: 'service', pageTypeVia: 'url', schemaTypes: ['Organization'],
  hasOrganizationSchema: true, hasOrganizationSameAs: true, hasPersonSchema: false,
  hasAggregateRatingOnOrg: false,
  hasByline: false, bylineName: null, bylineHref: null,
  hasNamedPeople: true, hasVisibleAddress: true, hasCredentials: true,
  hasThirdPartyProof: true, unquantifiedClaims: [],
  ...over
});

const client = (trust = {}) => ({ trust: { businessModel: 'local_service', ymyl: 'none', hasGbp: false, authoredContent: false, ...trust } });

const firedIds = (s, c) => evaluateTrustRules(s, c).fired.map(f => f.ruleId);
const suppressedIds = (s, c) => evaluateTrustRules(s, c).suppressed.map(f => f.ruleId);

// ─── the spec's roster table ──────────────────────────────────────────────────

describe('roster acceptance cases', () => {
  test('TreHus — local_service, no bylines', () => {
    const s = clean({
      pageType: 'home', hasNamedPeople: false, hasThirdPartyProof: false,
      unquantifiedClaims: [{ claim: '44 years', context: '44 years of craftsmanship.', tag: 'p' }]
    });
    const c = client({ businessModel: 'local_service', ymyl: 'none', authoredContent: false, hasGbp: true });
    const fired = firedIds(s, c);
    ['R-NAMED', 'R-PROOF', 'R-REVIEW-DISPLAY-NOSTARS', 'R-THIRDPARTY'].forEach(id =>
      assert.ok(fired.includes(id), `expected ${id} to fire, got ${fired.join(', ')}`));
    ['R-PERSON-SCHEMA', 'R-REVIEW-DISPLAY-STARS', 'R-CREDENTIALS'].forEach(id =>
      assert.ok(!fired.includes(id), `${id} must not fire`));
  });

  test('MSA Magnetics — ecommerce product page', () => {
    const s = clean({ pageType: 'product', hasOrganizationSameAs: false });
    const c = client({ businessModel: 'ecommerce', ymyl: 'none' });
    const fired = firedIds(s, c);
    assert.ok(fired.includes('R-REVIEW-DISPLAY-STARS'));
    assert.ok(fired.includes('R-ORG'));
    ['R-ADDRESS', 'R-CREDENTIALS', 'R-PERSON-SCHEMA'].forEach(id =>
      assert.ok(!fired.includes(id), `${id} must not fire`));
  });

  test('Matrix Engineering — b2b_technical article with a byline', () => {
    const s = clean({
      pageType: 'article', hasByline: true, bylineName: 'Dana Whitfield', bylineHref: null,
      hasPersonSchema: false, hasThirdPartyProof: false
    });
    const c = client({ businessModel: 'b2b_technical', ymyl: 'none', authoredContent: true });
    const fired = firedIds(s, c);
    ['R-PERSON-SCHEMA', 'R-AUTHOR-PAGE', 'R-THIRDPARTY'].forEach(id =>
      assert.ok(fired.includes(id), `expected ${id}, got ${fired.join(', ')}`));
    ['R-REVIEW-DISPLAY-STARS', 'R-CREDENTIALS'].forEach(id =>
      assert.ok(!fired.includes(id), `${id} must not fire`));
  });

  test('MN Neuropsychology — local_service, health', () => {
    const s = clean({
      pageType: 'service', hasNamedPeople: false, hasVisibleAddress: false,
      hasCredentials: false, hasThirdPartyProof: false
    });
    const c = client({ businessModel: 'local_service', ymyl: 'health', hasGbp: true });
    const fired = firedIds(s, c);
    ['R-CREDENTIALS', 'R-NAMED', 'R-ADDRESS', 'R-REVIEW-DISPLAY-NOSTARS'].forEach(id =>
      assert.ok(fired.includes(id), `expected ${id}, got ${fired.join(', ')}`));
    ['R-REVIEW-DISPLAY-STARS', 'R-PERSON-SCHEMA'].forEach(id =>
      assert.ok(!fired.includes(id), `${id} must not fire`));
  });

  test('the health vertical alone adds the reviewer line', () => {
    const s = clean({ hasCredentials: false });
    const health = evaluateTrustRules(s, client({ ymyl: 'health' })).fired.find(f => f.ruleId === 'R-CREDENTIALS');
    const legal  = evaluateTrustRules(s, client({ ymyl: 'legal'  })).fired.find(f => f.ruleId === 'R-CREDENTIALS');
    // It lives in the detail now — the title is a task name, identical for
    // every regulated vertical.
    assert.match(health.detail, /named reviewer line/);
    assert.doesNotMatch(legal.detail, /named reviewer line/);
    assert.equal(health.recommendation, legal.recommendation);
  });

  test('regression: no case produces a toxic-link or authority-metric rule', () => {
    // Tier 0. Neither exists in the rule set at all, so neither can be emitted.
    assert.doesNotMatch(src, /R-TOXIC|R-AUTHORITY-LINKS/);
  });
});

// ─── suppression beats observation ────────────────────────────────────────────

describe('client gating', () => {
  test('author rules are suppressed entirely when the client publishes no bylines', () => {
    // The spec's sharpest gate: a service business with a stray byline should
    // never be told to build author infrastructure.
    const s = clean({ pageType: 'article', hasByline: true, bylineName: 'Someone', bylineHref: null });
    const c = client({ authoredContent: false });
    assert.deepEqual(firedIds(s, c).filter(id => /AUTHOR|PERSON/.test(id)), []);
    assert.ok(suppressedIds(s, c).includes('R-PERSON-SCHEMA'));
    assert.ok(suppressedIds(s, c).includes('R-AUTHOR-PAGE'));
  });

  test('Person schema is suppressed on home, product and location pages', () => {
    ['home', 'product', 'location'].forEach(pageType => {
      const s = clean({ pageType, hasByline: true });
      assert.ok(suppressedIds(s, client({ authoredContent: true })).includes('R-PERSON-SCHEMA'), pageType);
    });
  });

  test('star advice is suppressed off ecommerce product pages', () => {
    assert.ok(suppressedIds(clean({ pageType: 'service' }), client({ businessModel: 'ecommerce' }))
      .includes('R-REVIEW-DISPLAY-STARS'));
    assert.ok(suppressedIds(clean({ pageType: 'product' }), client({ businessModel: 'local_service' }))
      .includes('R-REVIEW-DISPLAY-STARS'));
  });

  test('the two review rules are mutually exclusive', () => {
    // Both firing would tell the analyst stars are and are not achievable.
    const combos = [
      [clean({ pageType: 'product' }), client({ businessModel: 'ecommerce', hasGbp: true })],
      [clean({ pageType: 'home' }),    client({ businessModel: 'local_service', hasGbp: true })],
      [clean({ pageType: 'service' }), client({ businessModel: 'ecommerce', hasGbp: true })]
    ];
    combos.forEach(([s, c]) => {
      const f = firedIds(s, c).filter(id => id.startsWith('R-REVIEW'));
      assert.ok(f.length <= 1, `both review rules fired: ${f.join(', ')}`);
    });
  });

  test('credentials advice is suppressed outside YMYL and regulated verticals', () => {
    assert.ok(suppressedIds(clean({ hasCredentials: false }), client({ ymyl: 'none' })).includes('R-CREDENTIALS'));
  });

  test('every rule carries a short title and a separate detail', () => {
    // The fallback path — a fired rule the model did not phrase — must emit
    // the same shape as a phrased one, or it renders a paragraph in bold where
    // every other card has a task name.
    const seen = new Set();
    [
      [clean({ hasNamedPeople: false, pageType: 'home', hasVisibleAddress: false, hasThirdPartyProof: false,
               hasOrganizationSameAs: false, hasCredentials: false,
               unquantifiedClaims: [{ claim: 'trusted', context: 'x', tag: 'p' }] }), client({ ymyl: 'health', hasGbp: true })],
      [clean({ pageType: 'article', hasByline: true, bylineHref: null }), client({ authoredContent: true })],
      [clean({ pageType: 'product' }), client({ businessModel: 'ecommerce' })]
    ].forEach(([s2, c]) => evaluateTrustRules(s2, c).fired.forEach(f => {
      seen.add(f.ruleId);
      assert.ok(f.recommendation.length <= 60, `${f.ruleId} title too long: "${f.recommendation}"`);
      assert.ok(f.detail, `${f.ruleId} has no detail`);
    }));
    assert.ok(seen.size >= 8, `only exercised ${seen.size} rules`);
  });

  test('"regulated" fires credentials without being health', () => {
    // Open question 3: engineering and water treatment need licensure without
    // masquerading as a medical vertical.
    const fired = evaluateTrustRules(clean({ hasCredentials: false }), client({ ymyl: 'regulated' })).fired;
    const cred = fired.find(f => f.ruleId === 'R-CREDENTIALS');
    assert.ok(cred);
    assert.doesNotMatch(cred.recommendation, /reviewer/);
  });

  test('a page already surfacing credentials stays quiet', () => {
    // The spec fires this on vertical alone, which keeps recommending it to
    // clients who already complied — constraint 1 says that is worse than
    // silence, so it is gated on detection too.
    assert.ok(!firedIds(clean({ hasCredentials: true }), client({ ymyl: 'health' })).includes('R-CREDENTIALS'));
  });

  test('address advice follows the GBP, not only the business model', () => {
    // Open question 1: a mixed ecommerce/lead-gen client with a real location
    // still needs a visible address, without business_model holding two values.
    const s = clean({ hasVisibleAddress: false });
    assert.ok(!firedIds(s, client({ businessModel: 'ecommerce', hasGbp: false })).includes('R-ADDRESS'));
    assert.ok(firedIds(s, client({ businessModel: 'ecommerce', hasGbp: true })).includes('R-ADDRESS'));
  });

  test('third-party verification follows the GBP too, for mixed clients', () => {
    // A mixed ecommerce/lead-gen client is filed under one business_model, so
    // gating on that alone silently denied this rule to the lead-gen half.
    // R-ADDRESS and the review rule were already covered; this one was the
    // remaining gap.
    const s = clean({ hasThirdPartyProof: false });
    assert.ok(!firedIds(s, client({ businessModel: 'ecommerce', hasGbp: false })).includes('R-THIRDPARTY'));
    assert.ok(firedIds(s, client({ businessModel: 'ecommerce', hasGbp: true })).includes('R-THIRDPARTY'));
  });

  test('a publisher still never sees it', () => {
    // The gate has to keep excluding somebody, or it is not a gate.
    const s = clean({ hasThirdPartyProof: false });
    assert.ok(suppressedIds(s, client({ businessModel: 'publisher', hasGbp: false })).includes('R-THIRDPARTY'));
  });

  test('the two GBP-aware gates agree with each other', () => {
    // R-ADDRESS and R-THIRDPARTY answer the same question — "does this client
    // have a real-world footprint" — and must not diverge.
    const s = clean({ hasVisibleAddress: false, hasThirdPartyProof: false });
    [['ecommerce', true], ['ecommerce', false], ['b2b_technical', false], ['publisher', true]].forEach(([bm, gbp]) => {
      const fired = firedIds(s, client({ businessModel: bm, hasGbp: gbp }));
      if (bm === 'b2b_technical') return;   // third-party only, by design
      assert.equal(fired.includes('R-ADDRESS'), fired.includes('R-THIRDPARTY'), `${bm}/${gbp}`);
    });
  });

  test('suppression states its reason', () => {
    const [x] = evaluateTrustRules(clean(), client({ ymyl: 'none' })).suppressed.filter(r => r.ruleId === 'R-CREDENTIALS');
    assert.match(x.reason, /not a YMYL or regulated vertical/);
  });
});

// ─── hard blocks ──────────────────────────────────────────────────────────────

describe('policy blocks', () => {
  test('no rule can ever recommend aggregateRating on an Organization', () => {
    // B-SELFSERVING. Enforced structurally: no rule text mentions it.
    const all = [];
    [
      [clean({ pageType: 'product' }), client({ businessModel: 'ecommerce' })],
      [clean({ pageType: 'home' }), client({ hasGbp: true })],
      [clean({ pageType: 'location' }), client({ businessModel: 'multi_location', hasGbp: true })]
    ].forEach(([s, c]) => evaluateTrustRules(s, c).fired.forEach(f => all.push(f.recommendation)));
    all.forEach(r => assert.doesNotMatch(r, /aggregateRating.*(LocalBusiness|Organization)/i));
  });

  test('the no-stars rule carries its ceiling', () => {
    const f = evaluateTrustRules(clean({ pageType: 'home' }), client({ hasGbp: true })).fired
      .find(x => x.ruleId === 'R-REVIEW-DISPLAY-NOSTARS');
    assert.match(f.ceiling, /NOT achievable/);
    assert.match(f.ceiling, /2019/);
  });

  test('existing self-serving markup is an informational finding, not an error', () => {
    const r = evaluateTrustRules(clean({ hasAggregateRatingOnOrg: true }), client());
    const [f] = r.findings;
    assert.equal(f.id, 'B-SELFSERVING-AUDIT');
    assert.equal(f.level, 'info');
    assert.match(f.text, /Removal is optional/);
  });

  test('no finding when the markup is absent', () => {
    assert.deepEqual([...evaluateTrustRules(clean(), client()).findings], []);
  });

  test('the model half is bound too', () => {
    // The engine cannot stop a model-authored recommendation elsewhere in the
    // plan from suggesting the same thing, so the prompt forbids it.
    assert.match(plan, /NEVER recommend adding aggregateRating or Review markup to a LocalBusiness or Organization/);
  });
});

// ─── the checklist replaces the grade ─────────────────────────────────────────

describe('observable-signal checklist', () => {
  test('every signal from the spec has a row', () => {
    const ids = evaluateTrustRules(clean(), client()).checklist.map(c => c.id);
    ['org', 'address', 'named', 'credentials', 'thirdparty', 'claims', 'author'].forEach(id =>
      assert.ok(ids.includes(id), `missing checklist row: ${id}`));
  });

  test('rows are met/unmet/na — never a grade', () => {
    const r = evaluateTrustRules(clean(), client());
    r.checklist.forEach(c => assert.ok(['met', 'unmet', 'na'].includes(c.state), c.state));
    assert.ok(!('score' in r), 'the engine must not emit a score');
  });

  test('a satisfied signal reads met', () => {
    const r = evaluateTrustRules(clean(), client());
    assert.equal(r.checklist.find(c => c.id === 'org').state, 'met');
    assert.equal(r.checklist.find(c => c.id === 'address').state, 'met');
  });

  test('a missing signal reads unmet', () => {
    const r = evaluateTrustRules(clean({ hasVisibleAddress: false }), client());
    assert.equal(r.checklist.find(c => c.id === 'address').state, 'unmet');
  });

  test('a client-suppressed signal reads n/a with its reason, not unmet', () => {
    // The point of n/a: the analyst can tell "not applicable here" from
    // "missing", instead of the gating being invisible.
    const r = evaluateTrustRules(clean({ hasByline: false, hasPersonSchema: false }), client({ authoredContent: false }));
    const author = r.checklist.find(c => c.id === 'author');
    assert.equal(author.state, 'na');
    assert.match(author.reason, /bylined content/);
  });

  test('credentials read n/a outside a regulated vertical', () => {
    const r = evaluateTrustRules(clean({ hasCredentials: false }), client({ ymyl: 'none' }));
    assert.equal(r.checklist.find(c => c.id === 'credentials').state, 'na');
  });
});

// ─── caveat + prompt block ────────────────────────────────────────────────────

describe('the standing caveat', () => {
  test('applies to every business model except publisher', () => {
    ['local_service', 'ecommerce', 'b2b_technical', 'multi_location'].forEach(businessModel =>
      assert.ok(evaluateTrustRules(clean(), client({ businessModel })).caveat, businessModel));
    assert.equal(evaluateTrustRules(clean(), client({ businessModel: 'publisher' })).caveat, null);
  });

  test('it says what on-page analysis cannot see', () => {
    assert.match(evaluateTrustRules(clean(), client()).caveat, /cannot observe off-site reputation/);
  });
});

describe('what the model is handed', () => {
  const block = (s, c) => trustRulesPromptBlock(evaluateTrustRules(s, c)).join('\n');

  test('fired rules arrive with their trigger and grades', () => {
    const t = block(clean({ hasNamedPeople: false, pageType: 'home' }), client());
    assert.match(t, /R-NAMED \[moderate\/medium\]/);
    assert.match(t, /triggered by: no named individuals detected on a home page/);
  });

  test('the model is told to phrase, not to decide', () => {
    const t = block(clean({ hasNamedPeople: false, pageType: 'home' }), client());
    assert.match(t, /Phrase ONLY the rules listed under FIRED/);
    assert.match(t, /Do not add trust recommendations of your own/);
  });

  test('suppressed rules are listed as forbidden', () => {
    const t = block(clean(), client({ ymyl: 'none' }));
    assert.match(t, /SUPPRESSED \(must not appear in any form\)/);
    assert.match(t, /R-CREDENTIALS/);
  });

  test('a ceiling is passed through for the model to state', () => {
    const t = block(clean({ pageType: 'home' }), client({ hasGbp: true }));
    assert.match(t, /ceiling \(state this plainly\)/);
  });

  test('nothing firing is stated explicitly rather than left blank', () => {
    // A blank section invites the model to fill it.
    const t = block(clean(), client({ businessModel: 'publisher' }));
    assert.match(t, /FIRED: none/);
    assert.match(t, /rather than inventing something/);
  });

  test('the matched claim string reaches the prompt', () => {
    const t = block(clean({ unquantifiedClaims: [{ claim: '44 years', context: 'x', tag: 'p' }] }), client());
    assert.match(t, /"44 years"/);
  });
});
