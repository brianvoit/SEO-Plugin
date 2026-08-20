// Ad Text Review: only real performance ratings get a chip.
//
// Reported: every headline and description row showed a NOT_APPLICABLE badge.
// That is Google's enum for "this asset has no performance rating" — the
// absence of a rating, not a rating. It reached the UI because the background
// stored whatever the API sent (`v.performanceLabel || null`, which only
// catches a literal null) and the popup title-cased any unmapped value, which
// .asset-perf then uppercased back into NOT_APPLICABLE.
//
// PENDING and LEARNING must keep showing — they are real states.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

const ads   = await readFile(path.join(ROOT, 'bg-ads.js'), 'utf8');
const popup = await readFile(path.join(ROOT, 'popup-ads.js'), 'utf8');

const slice = (src, start, end) => {
  const a = src.indexOf(start);
  assert.ok(a !== -1, `slice marker moved: "${start}"`);
  const b = src.indexOf(end, a + start.length);
  assert.ok(b > a, `slice end marker moved: "${end}"`);
  return src.slice(a, b);
};

describe('the background normalises non-ratings to null', () => {
  const adsPerfLabelOrNull = new Function(
    `${slice(ads, 'const ADS_NO_PERF_LABEL', 'async function adsGetAdsDetail(')}
     return adsPerfLabelOrNull;`
  )();

  test('NOT_APPLICABLE becomes null — the reported case', () => {
    assert.equal(adsPerfLabelOrNull('NOT_APPLICABLE'), null);
  });

  test('UNSPECIFIED and UNKNOWN become null too', () => {
    assert.equal(adsPerfLabelOrNull('UNSPECIFIED'), null);
    assert.equal(adsPerfLabelOrNull('UNKNOWN'), null);
  });

  test('a genuinely absent label stays null', () => {
    assert.equal(adsPerfLabelOrNull(null), null);
    assert.equal(adsPerfLabelOrNull(undefined), null);
    assert.equal(adsPerfLabelOrNull(''), null);
  });

  test('real ratings pass through untouched', () => {
    ['BEST', 'GOOD', 'LOW'].forEach(v => assert.equal(adsPerfLabelOrNull(v), v));
  });

  test('PENDING and LEARNING survive — they are states, not absences', () => {
    // Dropping these would hide "Google is still gathering data on this asset",
    // which is genuinely useful and different from "no rating exists".
    assert.equal(adsPerfLabelOrNull('PENDING'), 'PENDING');
    assert.equal(adsPerfLabelOrNull('LEARNING'), 'LEARNING');
  });

  test('it is applied where the label enters our data', () => {
    assert.match(ads, /label: adsPerfLabelOrNull\(v\.performanceLabel\)/);
    assert.doesNotMatch(ads, /label: v\.performanceLabel \|\| null/);
  });
});

describe('the panel only chips a known rating', () => {
  const adsPerfLabel = new Function(
    `${slice(popup, 'const ADS_PERF_LABELS', 'function adsPerfClass(')}
     return adsPerfLabel;`
  )();

  test('an unmapped enum renders nothing at all', () => {
    // Second line of defence: the old fallback title-cased anything it did not
    // recognise, and CSS uppercased it back into a raw-looking enum.
    ['NOT_APPLICABLE', 'UNSPECIFIED', 'SOMETHING_GOOGLE_ADDS_LATER'].forEach(v =>
      assert.equal(adsPerfLabel(v), '', `${v} should not produce chip text`));
  });

  test('the five known ratings render their friendly names', () => {
    assert.equal(adsPerfLabel('BEST'), 'Best');
    assert.equal(adsPerfLabel('GOOD'), 'Good');
    assert.equal(adsPerfLabel('LOW'), 'Low');
    assert.equal(adsPerfLabel('PENDING'), 'Pending');
    assert.equal(adsPerfLabel('LEARNING'), 'Learning');
  });

  test('an empty label means no element, not an empty chip', () => {
    // Guarding on item.label alone would still append a blank pill.
    assert.match(popup, /const perf = adsPerfLabel\(item\.label\);\s*\n\s*if \(perf\) \{/);
  });
});
