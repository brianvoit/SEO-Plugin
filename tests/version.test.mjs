// Version consistency.
//
// manifest.base.json is the single source of truth. CI used to `jq` the version
// out of the git tag and overwrite the manifest in place, which meant a
// mismatch between the tag and the committed manifest was silently papered
// over at release time and never surfaced in review.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildManifest, BROWSERS } from '../scripts/build.mjs';
import { baseVersion } from './helpers.mjs';

const run = promisify(execFile);

test('version is a valid extension version string', async () => {
  const version = await baseVersion();
  // Both stores accept 1–4 dot-separated integers.
  assert.match(version, /^\d+(\.\d+){0,3}$/, `"${version}" is not a valid version`);
});

test('every browser build reports the same version', async () => {
  const version = await baseVersion();
  for (const browser of BROWSERS) {
    const m = await buildManifest(browser);
    assert.equal(m.version, version, `${browser} build version drifted from manifest.base.json`);
  }
});

test('version matches the git tag when building a tagged commit', async (t) => {
  // GITHUB_REF_NAME is set by Actions; fall back to asking git directly so the
  // check also works locally. Untagged commits skip — this only gates releases.
  let tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : null;
  if (!tag) {
    try {
      const { stdout } = await run('git', ['describe', '--exact-match', '--tags', 'HEAD']);
      tag = stdout.trim();
    } catch {
      return t.skip('HEAD is not tagged — version/tag check only applies to releases');
    }
  }
  const version = await baseVersion();
  assert.equal(
    tag.replace(/^v/, ''),
    version,
    `git tag ${tag} does not match manifest.base.json version ${version} — bump the manifest before tagging`
  );
});
