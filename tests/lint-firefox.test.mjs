// Runs web-ext lint against the built Firefox extension.
//
// Only the Firefox build: web-ext lint is Mozilla's addons-linter and flags
// Chrome-only manifest keys (side_panel, service_worker, minimum_chrome_version)
// as errors, so pointing it at dist/chrome would fail on correct code.
//
// The bar is the one the README has always stated: 0 errors, 0 warnings, 0 notices.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT, DIST } from './helpers.mjs';

const run = promisify(execFile);
const binary = path.join(ROOT, 'node_modules', '.bin', 'web-ext');

test('dist/firefox passes web-ext lint with 0 errors, warnings and notices', async (t) => {
  if (!existsSync(binary)) {
    return t.skip('web-ext not installed — run `npm ci` (CI always has it)');
  }

  let stdout = '';
  try {
    ({ stdout } = await run(binary, [
      'lint',
      '--source-dir', path.join(DIST, 'firefox'),
      '--output', 'json',
      '--no-config-discovery'
    ], { maxBuffer: 10 * 1024 * 1024 }));
  } catch (err) {
    // web-ext exits non-zero when it finds problems; the JSON report is still
    // on stdout, so parse it rather than surfacing a bare exit code.
    stdout = err.stdout || '';
    if (!stdout) throw err;
  }

  const report = JSON.parse(stdout);
  const summary = ['errors', 'warnings', 'notices']
    .map(k => `${(report[k] || []).length} ${k}`)
    .join(', ');

  const detail = ['errors', 'warnings', 'notices']
    .flatMap(k => (report[k] || []).map(m => `  [${k.slice(0, -1)}] ${m.code}: ${m.message}${m.file ? ` (${m.file})` : ''}`))
    .join('\n');

  const total = (report.errors || []).length + (report.warnings || []).length + (report.notices || []).length;
  assert.equal(total, 0, `web-ext lint reported ${summary}:\n${detail}`);
});
