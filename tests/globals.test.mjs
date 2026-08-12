// Detects top-level declaration collisions across the popup's shared scope.
//
// popup.html loads 22 classic (non-module) scripts. Their top-level `const`,
// `let`, `class` and `function` declarations all land in ONE shared script
// scope, so two files declaring the same name is a hard SyntaxError at load —
// the whole panel goes blank. `node --check` cannot see this because each file
// is individually valid; the collision only exists once they're combined.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, popupScripts } from './helpers.mjs';

// Only column-0 declarations are top-level; anything indented is inside a
// function or block and therefore scoped.
const DECL = /^(?:const|let|var|class|(?:async\s+)?function)\s+([A-Za-z_$][\w$]*)/;

/** Lexically-scoped top-level names in one file. */
async function topLevelNames(file) {
  const src = await readFile(path.join(ROOT, file), 'utf8');
  const names = [];
  for (const line of src.split('\n')) {
    const m = line.match(DECL);
    if (m) names.push(m[1]);
  }
  return names;
}

test('no duplicate top-level declarations across popup scripts', async () => {
  const owners = new Map();   // name -> [files]
  for (const file of await popupScripts()) {
    for (const name of await topLevelNames(file)) {
      if (!owners.has(name)) owners.set(name, []);
      owners.get(name).push(file);
    }
  }

  const clashes = [...owners.entries()]
    .filter(([, files]) => new Set(files).size > 1)
    .map(([name, files]) => `  ${name} — declared in ${[...new Set(files)].join(', ')}`);

  assert.equal(
    clashes.length, 0,
    `top-level name collisions would throw SyntaxError at panel load:\n${clashes.join('\n')}`
  );
});

test('no file declares the same top-level name twice', async () => {
  const problems = [];
  for (const file of await popupScripts()) {
    const names = await topLevelNames(file);
    const seen = new Set();
    for (const n of names) {
      if (seen.has(n)) problems.push(`  ${file}: ${n}`);
      seen.add(n);
    }
  }
  assert.equal(problems.length, 0, `duplicate top-level declarations within a file:\n${problems.join('\n')}`);
});
