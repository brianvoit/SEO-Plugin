// The low-CTR band must be position-adjusted.
//
// From a reviewed plan on trehus.biz, two queries got the same diagnosis:
//   "design build firms minneapolis" — 501 impr, pos 6.9, 0.4% CTR
//   "architects near me"            — 335 impr, pos 13.2, 1.2% CTR
//
// The first is ~11% of what position 7 should earn: a real snippet problem.
// The second is slightly ABOVE what position 13 earns: nothing wrong with the
// snippet at all, it has a ranking problem. The old rule was a flat
// `ctr < 0.02 && position <= 15`, so it called both a title/meta failure —
// and would keep doing that to every page-two keyword.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

const src   = await readFile(path.join(ROOT, 'popup-actionplan.js'), 'utf8');
const webceo = await readFile(path.join(ROOT, 'popup-webceo.js'), 'utf8');

// The real curve from popup-webceo.js plus the real band logic, wired the way
// the popup wires them (webceo loads first).
const boot = new Function(`
  ${webceo.slice(webceo.indexOf('function webceoRanked('), webceo.indexOf('function webceoPos('))}
  ${webceo.slice(webceo.indexOf('const WEBCEO_CTR_CURVE'), webceo.indexOf('// Striking distance'))}
  ${src.slice(src.indexOf('function actionPlanExpectedCtr('), src.indexOf('// GA4 → plain behavioral facts'))}
  return { actionPlanGscBands, actionPlanExpectedCtr };
`)();

const q = (query, impressions, position, ctr) => ({ query, impressions, position, ctr });
const bands = (queries) => boot.actionPlanGscBands({ connected: true, queries });
const flagged = (queries) => bands(queries).lowCtr.map(r => r.query);

describe('the expected-CTR lookup', () => {
  test('rounds fractional GSC positions', () => {
    // The curve is integer-indexed and GSC reports averages like 6.9, so an
    // unrounded lookup returns undefined and every comparison silently fails.
    assert.equal(boot.actionPlanExpectedCtr(6.9), boot.actionPlanExpectedCtr(7));
    assert.ok(boot.actionPlanExpectedCtr(6.9) > 0);
  });

  test('a page-two position still has an expectation', () => {
    assert.ok(boot.actionPlanExpectedCtr(13.2) > 0);
  });

  test('position 7 expects far more than position 13', () => {
    assert.ok(boot.actionPlanExpectedCtr(7) > boot.actionPlanExpectedCtr(13) * 3);
  });

  test('an unranked or missing position has no expectation', () => {
    [0, null, undefined, -1].forEach(p => assert.equal(boot.actionPlanExpectedCtr(p), 0));
  });
});

describe('the two queries from the report', () => {
  const REAL = q('design build firms minneapolis', 501, 6.9, 0.004);
  const PAR  = q('architects near me', 335, 13.2, 0.012);

  test('the genuine anomaly is still flagged', () => {
    assert.deepEqual(flagged([REAL]), ['design build firms minneapolis']);
  });

  test('the at-par page-two query is NOT flagged', () => {
    // The whole point. Under the old flat rule this was a "title/meta problem".
    assert.deepEqual(flagged([PAR]), []);
  });

  test('given both, only the anomaly comes back', () => {
    assert.deepEqual(flagged([REAL, PAR]), ['design build firms minneapolis']);
  });
});

describe('the band generally', () => {
  test('a position-1 query at 5% CTR is flagged — far under par for #1', () => {
    assert.deepEqual(flagged([q('brand name', 5000, 1.0, 0.05)]), ['brand name']);
  });

  test('a position-1 query at 30% CTR is not', () => {
    assert.deepEqual(flagged([q('brand name', 5000, 1.0, 0.30)]), []);
  });

  test('low-impression queries stay out — CTR is noise there', () => {
    assert.deepEqual(flagged([q('rare', 30, 7, 0.0)]), []);
  });

  test('anything past page two is out, where CTR cannot be reasoned about', () => {
    assert.deepEqual(flagged([q('deep', 4000, 34, 0.0)]), []);
  });

  test('the expectation travels with the row so the prompt can cite it', () => {
    const [row] = bands([q('design build firms minneapolis', 501, 6.9, 0.004)]).lowCtr;
    assert.ok(row.expectedCtr > 0);
    assert.equal(row.expectedCtr, boot.actionPlanExpectedCtr(6.9));
  });

  test('the flat threshold is gone', () => {
    assert.doesNotMatch(src, /q\.ctr < 0\.02/);
    assert.match(src, /q\.ctr < q\.expectedCtr \* LOW_CTR_PAR_RATIO/);
  });

  test('the prompt line states the comparison instead of asserting a cause', () => {
    assert.match(src, /vs ~\$\{\(q\.expectedCtr \* 100\)\.toFixed\(1\)\}% typical at that position/);
    assert.match(src, /already position-adjusted/);
  });

  test('the cross-file curve call is typeof-guarded, per house rule', () => {
    const fn = src.slice(src.indexOf('function actionPlanExpectedCtr('), src.indexOf('// A query is a snippet problem'));
    assert.match(fn, /typeof webceoCtrForPosition !== 'function'/);
  });
});

describe('the other corrections to the context', () => {
  test('toxic-link counts are no longer passed to any plan', () => {
    assert.doesNotMatch(src, /Toxic links flagged/);
  });

  test('the model is no longer asked to reason about schema for trust at all', () => {
    // The schema contradiction ("schema is absent" beside a Trustworthiness
    // note saying LocalBusiness was present) is now structurally impossible:
    // the E-E-A-T SIGNALS block is gone, and schema completeness is decided by
    // the rule engine's hasOrganizationSchema / hasOrganizationSameAs.
    assert.doesNotMatch(src, /## E-E-A-T SIGNALS \(from page structure\)/);
    assert.doesNotMatch(src, /Author\/Person schema present/);
    assert.match(src, /## PAGE ROLE & FRESHNESS/);
  });

  test('a homepage is identified as one', () => {
    assert.match(src, /\(pathname === '\/' \|\| pathname === ''\) \? 'homepage'/);
  });
});
