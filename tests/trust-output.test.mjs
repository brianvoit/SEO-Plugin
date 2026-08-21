// Phase 3 of the E-E-A-T module spec: the output format.
//
// The grade is gone, replaced by an observable checklist. The model now
// contributes phrasing only — mergeTrustPhrasing is the boundary that enforces
// it, and these tests exist because that boundary is the entire reason the
// output is defensible: an analyst has to be able to say "this fired because
// of that", and a model that could add, drop or re-grade a rule would make
// that untrue.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

const src    = await readFile(path.join(ROOT, 'popup-actionplan.js'), 'utf8');
const trust  = await readFile(path.join(ROOT, 'popup-trust.js'), 'utf8');
const exportSrc = await readFile(path.join(ROOT, 'bg-export.js'), 'utf8');

// splitLongChange lives up in the normalization section and is called by
// mergeTrustPhrasing, so it has to come along.
const mergeTrustPhrasing = new Function(
  `${src.slice(src.indexOf('const REC_TITLE_MAX'), src.indexOf('const _EFFORTS'))}
   ${src.slice(src.indexOf('function mergeTrustPhrasing('), src.indexOf('// ─── Main entry'))}
   return mergeTrustPhrasing;`
)();

const engineResult = (over = {}) => ({
  fired: [
    { ruleId: 'R-NAMED', tier: 1, trigger: 'no named individuals on a home page',
      recommendation: 'Replace collective references with named individuals.', impact: 'medium', effort: 'moderate' },
    { ruleId: 'R-REVIEW-DISPLAY-NOSTARS', tier: 2, trigger: 'GBP client on a home page',
      recommendation: 'Display reviews for conversion.', impact: 'medium', effort: 'moderate',
      ceiling: 'Star rich results are NOT achievable here.' }
  ],
  checklist: [{ id: 'named', label: 'Named individuals with roles', state: 'unmet' }],
  findings: [],
  caveat: 'On-page analysis cannot observe off-site reputation…',
  ...over
});

describe('the model phrases, the engine decides', () => {
  test('phrasing is used when supplied', () => {
    const out = mergeTrustPhrasing(
      { trust: { recommendations: [{ ruleId: 'R-NAMED', change: 'Name the three partners under "Our Team".', evidence: 'The H2 "Our Team" lists no one.' }] } },
      engineResult()
    );
    const r = out.recommendations.find(x => x.ruleId === 'R-NAMED');
    assert.equal(r.change, 'Name the three partners under "Our Team".');
    assert.equal(r.evidence, 'The H2 "Our Team" lists no one.');
  });

  test('a rule the model skipped still ships, with the engine\'s own words', () => {
    // Silence from the model must not become silence in the plan — the engine
    // already decided this is actionable.
    const out = mergeTrustPhrasing({ trust: { recommendations: [] } }, engineResult());
    assert.equal(out.recommendations.length, 2);
    assert.match(out.recommendations[0].change, /Replace collective references/);
  });

  test('a ruleId the model invented is dropped entirely', () => {
    const out = mergeTrustPhrasing(
      { trust: { recommendations: [{ ruleId: 'R-MADE-UP', change: 'Buy links.', evidence: 'x' }] } },
      engineResult()
    );
    assert.deepEqual(out.recommendations.map(r => r.ruleId).sort(), ['R-NAMED', 'R-REVIEW-DISPLAY-NOSTARS']);
  });

  test('the model cannot re-grade impact or effort', () => {
    const out = mergeTrustPhrasing(
      { trust: { recommendations: [{ ruleId: 'R-NAMED', change: 'x', evidence: 'y', impact: 'high', effort: 'rewrite' }] } },
      engineResult()
    );
    const r = out.recommendations.find(x => x.ruleId === 'R-NAMED');
    assert.equal(r.impact, 'medium');
    assert.equal(r.effort, 'moderate');
  });

  test('the engine\'s trigger is always preserved, whatever the model wrote', () => {
    // This is what the analyst defends the recommendation with.
    const out = mergeTrustPhrasing(
      { trust: { recommendations: [{ ruleId: 'R-NAMED', change: 'x', evidence: 'something made up' }] } },
      engineResult()
    );
    assert.equal(out.recommendations[0].trigger, 'no named individuals on a home page');
  });

  test('the ceiling survives and cannot be edited away', () => {
    const out = mergeTrustPhrasing(
      { trust: { recommendations: [{ ruleId: 'R-REVIEW-DISPLAY-NOSTARS', change: 'Add reviews and get stars!', evidence: 'x' }] } },
      engineResult()
    );
    const r = out.recommendations.find(x => x.ruleId === 'R-REVIEW-DISPLAY-NOSTARS');
    assert.match(r.ceiling, /NOT achievable/);
  });

  test('checklist, findings and caveat come from the engine untouched', () => {
    const out = mergeTrustPhrasing({ trust: { recommendations: [] } }, engineResult());
    assert.equal(out.checklist[0].id, 'named');
    assert.match(out.caveat, /cannot observe off-site reputation/);
  });

  test('no engine result means no trust output at all', () => {
    // A page that could not be read must produce no trust findings, rather
    // than findings derived from nothing.
    assert.equal(mergeTrustPhrasing({ trust: { recommendations: [] } }, null), null);
  });

  test('a malformed model response degrades to engine text', () => {
    [undefined, {}, { trust: null }, { trust: { recommendations: 'nope' } }].forEach(raw => {
      const out = mergeTrustPhrasing(raw, engineResult());
      assert.equal(out.recommendations.length, 2);
      assert.ok(out.recommendations.every(r => r.change));
    });
  });

  test('nothing fired yields an empty list, not an absent key', () => {
    const out = mergeTrustPhrasing({}, engineResult({ fired: [] }));
    assert.deepEqual([...out.recommendations], []);
  });
});

describe('the grade is gone', () => {
  test('no score is emitted anywhere', () => {
    // Matched against code, not prose — the comment in popup-trust.js that
    // explains why the strong/moderate/weak grade was dropped should stay.
    assert.doesNotMatch(trust, /^\s*score:/m);
    assert.doesNotMatch(src, /EEAT_SCORES/);
    assert.doesNotMatch(src, /ap-eeat-score/);
  });

  test('normalizeActionPlan no longer builds an eeat object', () => {
    assert.doesNotMatch(src, /out\.eeat = \{/);
  });

  test('the Paid variant strips trust', () => {
    assert.match(src, /if \(variant === 'paid'\) \{ delete plan\.eeat; delete plan\.trust; \}/);
  });

  test('trust is attached only after the variant contract runs', () => {
    // Attaching first would let it survive on the Paid plan.
    const i = src.indexOf('applyVariantContract(normalizeActionPlan(');
    const j = src.indexOf('plan.trust = merged');
    assert.ok(i !== -1 && j > i, 'trust must be attached after the contract');
    assert.match(src, /if \(variant !== 'paid'\) \{/);
  });
});

describe('all three render paths carry the new shape', () => {
  test('the panel renders the checklist with its n/a reasons', () => {
    assert.match(src, /ap-trust-row--\$\{c\.state\}/);
    assert.match(src, /why\.textContent = c\.reason/);
  });

  test('the panel shows each rule id, with its trigger on hover', () => {
    // The id sits with the evidence now, not in the chip row, and displays
    // without the internal "R-" prefix.
    assert.match(src, /idTag\.textContent = trustRuleLabel\(r\.ruleId\)/);
    assert.match(src, /idTag\.title = `\$\{r\.ruleId\} — triggered by: \$\{r\.trigger\}`/);
  });

  test('the "R-" prefix is stripped for display but kept in the data', () => {
    const label = new Function(`${src.slice(src.indexOf('function trustRuleLabel('), src.indexOf('// ─── Normalization'))}
      return trustRuleLabel;`)();
    assert.equal(label('R-REVIEW-DISPLAY-NOSTARS'), 'REVIEW-DISPLAY-NOSTARS');
    assert.equal(label('R-ADDRESS'), 'ADDRESS');
    const out = mergeTrustPhrasing({}, engineResult());
    assert.equal(out.recommendations[0].ruleId, 'R-NAMED', 'the data keeps the real id');
  });

  test('effort and impact are the only chips in the row, as elsewhere in the plan', () => {
    // A long rule id knocked them out of line with every other card.
    const card = src.slice(src.indexOf("card.className = 'ap-rec ap-rec--moderate ap-trust-rec'"), src.indexOf('sec.appendChild(card)'));
    assert.doesNotMatch(card, /tags\.appendChild\(idTag\)/);
    assert.match(card, /tags\.appendChild\(eff\)/);
    assert.match(card, /tags\.appendChild\(imp\)/);
  });

  test('the RTF export uses [x] / [ ] / [n/a]', () => {
    const rtf = src.slice(src.indexOf('async function exportActionPlanRtf'));
    assert.match(rtf, /'\[x\]' : c\.state === 'na' \? '\[n\/a\]' : '\[ \]'/);
  });

  test('the RTF export carries the ceiling', () => {
    const rtf = src.slice(src.indexOf('async function exportActionPlanRtf'));
    assert.match(rtf, /r\.ceiling/);
  });

  test('the Google Doc export renders the checklist and drops the score', () => {
    assert.match(exportSrc, /<h1>Trust Signals<\/h1>/);
    assert.doesNotMatch(exportSrc, /E-E-A-T Signals/);
    assert.doesNotMatch(exportSrc, /Score: \$\{htmlEsc\(scoreLabel\)\}/);
  });

  test('the Google Doc export states n/a reasons and the ceiling', () => {
    assert.match(exportSrc, /c\.state === 'na' && c\.reason/);
    assert.match(exportSrc, /r\.ceiling/);
  });

  test('every render path emits the standing caveat', () => {
    assert.match(src, /trust\.caveat/);
    assert.match(exportSrc, /trust\.caveat/);
  });
});

describe('the engine reaches the prompt', () => {
  test('signals are gathered from the page and the client', () => {
    assert.match(src, /action: 'getTrustSignals'/);
    assert.match(src, /action: 'clientRegistryFindByDomain'/);
  });

  test('the engine runs before the prompt is built, not inside it', () => {
    assert.match(src, /evaluateTrustRules\(trustSignals, trustClient\)/);
    assert.match(src, /trustRulesPromptBlock\(g\.trust\)/);
  });

  test('an unreadable page produces no engine run', () => {
    assert.match(src, /trustSignals && !trustSignals\._readError/);
  });

  test('the cross-file calls are typeof-guarded, per house rule', () => {
    assert.match(src, /typeof evaluateTrustRules === 'function'/);
    assert.match(src, /typeof trustRulesPromptBlock === 'function'/);
  });
});
