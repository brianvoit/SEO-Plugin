// "Could not parse a plan from the response."
//
// Four distinct failures shared that one message, and nothing on screen let a
// user tell them apart:
//   1. the model wrote prose instead of JSON        — transient, retry works
//   2. the response hit max_tokens and was cut off  — recurs forever
//   3. valid JSON with no recommendations array
//   4. every recommendation dropped in normalization
//
// Only (2) is permanent for a given page, and it is the one the API reports —
// stop_reason was never read anywhere in the codebase. Meanwhile the response
// grew twice (trust phrasing, then a `detail` on every recommendation) while
// max_tokens stayed at 4096, so (2) got likelier without anyone noticing.
//
// The error branch also returns before the panel header renders, so its
// refresh control was off screen: there was no way to retry except to leave
// the panel and come back, which nothing told you.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

const src = await readFile(path.join(ROOT, 'popup-actionplan.js'), 'utf8');

describe('headroom', () => {
  test('max_tokens is raised well clear of a full plan', () => {
    const n = Number(/ACTION_PLAN_MAX_TOKENS = (\d+)/.exec(src)[1]);
    assert.ok(n >= 8192, `max_tokens is ${n}, which the trust module and detail fields have outgrown`);
  });

  test('the literal is gone from the request body', () => {
    assert.doesNotMatch(src, /max_tokens: 4096/);
    assert.match(src, /max_tokens: ACTION_PLAN_MAX_TOKENS/);
  });
});

describe('a truncated response says so', () => {
  test('stop_reason is actually read', () => {
    // It was never read anywhere in the codebase, so truncation and a
    // malformed reply were indistinguishable.
    assert.match(src, /data\.stop_reason === 'max_tokens'/);
  });

  test('the truncation message names the cause and a way out', () => {
    assert.match(src, /The response was cut off before it finished/);
    assert.match(src, /Try the SEO or Paid plan on its own/);
  });

  test('any other parse failure is called transient, and invites a retry', () => {
    assert.match(src, /This is usually transient — try again\./);
  });

  test('the two messages are different strings', () => {
    const branch = src.slice(src.indexOf('if (!plan) {'), src.indexOf('// Attached after the variant contract'));
    const cut = /'([^']*cut off[^']*)'/.exec(branch);
    const other = /'(Could not parse[^']*)'/.exec(branch);
    assert.ok(cut && other && cut[1] !== other[1]);
  });
});

describe('the error state can be acted on', () => {
  const branch = src.slice(src.indexOf('if (st.error) {'), src.indexOf("if (!_actionPlan) return;"));

  test('a Try again button exists', () => {
    assert.match(branch, /retry\.textContent = 'Try again'/);
  });

  test('it forces a regeneration of the variant on screen', () => {
    // loadActionPlan(false) would return the cached failure state.
    assert.match(branch, /loadActionPlan\(true, _apVariant\)/);
  });

  test('the API-key case still offers Settings instead of a pointless retry', () => {
    assert.match(branch, /\/Claude API key\/\.test\(st\.error\)/);
    assert.match(branch, /Open Settings/);
  });

  test('the two are exclusive — a missing key never shows Try again', () => {
    assert.match(branch, /\} else \{/);
  });

  test('only the Overview plan is told the other plans ask for less', () => {
    // Suggesting it on the SEO plan would be advice to nowhere.
    assert.match(branch, /_apVariant === 'overview'/);
    assert.match(branch, /The SEO and Paid plans each ask for less/);
  });
});
