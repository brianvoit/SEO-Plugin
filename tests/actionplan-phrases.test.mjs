// Tests the page-vocabulary block popup-actionplan.js adds to its prompt.
//
// The Action Plan prompt is long and expensive, and everything in it competes
// for the model's attention — so this block has to be compact, has to degrade
// silently on a page that couldn't be read, and must never be the thing that
// throws and takes the whole plan down with it. The real function is sliced
// out of popup-actionplan.js rather than reimplemented; it's pure, so it needs
// no DOM.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

const START = 'function actionPlanPhraseLines(';
const END = 'function actionPlanContext(';

const src = await readFile(path.join(ROOT, 'popup-actionplan.js'), 'utf8');
const from = src.indexOf(START);
const to = src.indexOf(END);

test('the prompt builder is still where the test expects it', () => {
  assert.ok(from !== -1, `could not find "${START}" — update this test's slice markers`);
  assert.ok(to > from, `could not find "${END}" after it`);
});

const actionPlanPhraseLines = new Function(
  `${src.slice(from, to)}; return actionPlanPhraseLines;`
)();

const p = (phrase, count, chips = []) => ({ phrase, count, chips });
const tables = (t = {}) => ({ 1: [], 2: [], 3: [], 4: [], ...t });

describe('the page-vocabulary prompt block', () => {
  test('emits one line per n-gram length that has phrases', () => {
    const lines = actionPlanPhraseLines({ tables: tables({
      1: [p('telescope', 34)],
      3: [p('best telescope for', 6)]
    }) });
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^\s+1-word:/);
    assert.match(lines[1], /^\s+3-word:/);
  });

  test('carries the count and where the phrase appears', () => {
    // The counts are the whole point — "you say this twice" versus "thirty
    // times" is what separates a real recommendation from a guess.
    const [line] = actionPlanPhraseLines({ tables: tables({ 1: [p('telescope', 34, ['title', 'h1'])] }) });
    assert.match(line, /"telescope" ×34 \[title,h1\]/);
  });

  test('a phrase that appears nowhere special carries no bracket', () => {
    const [line] = actionPlanPhraseLines({ tables: tables({ 1: [p('mirror', 14)] }) });
    assert.match(line, /"mirror" ×14/);
    assert.ok(!line.includes('['), 'an empty placement list still emitted brackets');
  });

  test('caps each length at eight phrases', () => {
    // Supporting evidence in an already-long prompt, not the main event.
    const many = Array.from({ length: 40 }, (_, i) => p(`word${i}`, 40 - i));
    const [line] = actionPlanPhraseLines({ tables: tables({ 1: many }) });
    assert.equal((line.match(/×/g) || []).length, 8);
  });

  test('an empty length is skipped rather than emitting a bare label', () => {
    const lines = actionPlanPhraseLines({ tables: tables({ 1: [p('telescope', 3)] }) });
    assert.equal(lines.length, 1);
  });
});

describe('degrading safely', () => {
  // The plan gathers this from the content script, which fails on
  // chrome://, PDFs, and any page the extension can't inject into. None of
  // those should cost the user their action plan.
  test('a page that could not be read yields no lines', () => {
    assert.deepEqual(actionPlanPhraseLines(null), []);
    assert.deepEqual(actionPlanPhraseLines(undefined), []);
  });

  test('a malformed payload yields no lines rather than throwing', () => {
    assert.deepEqual(actionPlanPhraseLines({}), []);
    assert.deepEqual(actionPlanPhraseLines({ tables: null }), []);
  });

  test('a table missing its chips array does not throw', () => {
    const lines = actionPlanPhraseLines({ tables: { 1: [{ phrase: 'telescope', count: 3 }] } });
    assert.match(lines[0], /"telescope" ×3/);
  });
});
