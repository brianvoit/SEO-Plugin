// Syntax-checks every extension source file.
//
// Replaces the old habit of running `node --check` on a hand-picked handful of
// files — only 8 of the 24 had ever been checked, so a syntax error in any of
// the other 16 would only surface when the panel failed to load at runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

const run = promisify(execFile);

const files = (await readdir(ROOT)).filter(f => f.endsWith('.js')).sort();

test('there are extension source files to check', () => {
  assert.ok(files.length > 0, 'no root-level .js files found — has the layout changed?');
});

for (const file of files) {
  test(`${file} parses`, async () => {
    await run(process.execPath, ['--check', path.join(ROOT, file)]);
  });
}
