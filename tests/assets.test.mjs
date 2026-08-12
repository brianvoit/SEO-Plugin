// Every file the extension references must actually exist — in the repo and
// in each built output.
//
// popup.html loads 22 classic <script src> tags. Renaming or deleting one is
// invisible to a syntax checker and only shows up as a runtime ReferenceError
// when some other file calls into the missing one.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { buildManifest, BROWSERS } from '../scripts/build.mjs';
import { ROOT, DIST, popupScripts } from './helpers.mjs';

test('popup.html references scripts that exist', async () => {
  const scripts = await popupScripts();
  assert.ok(scripts.length > 0, 'no <script src> tags found in popup.html');
  for (const src of scripts) {
    assert.ok(existsSync(path.join(ROOT, src)), `popup.html loads "${src}" but it is not in the repo`);
  }
});

test('popup.html loads popup-shared.js first and popup.js last', async () => {
  // The files share one global scope and depend on load order: popup-shared.js
  // defines helpers everything else calls, popup.js is the entry point.
  const scripts = await popupScripts();
  assert.equal(scripts[0], 'popup-shared.js', 'popup-shared.js must load first');
  assert.equal(scripts.at(-1), 'popup.js', 'popup.js must load last');
});

for (const browser of BROWSERS) {
  describe(`${browser} build contents`, () => {
    test('contains every file its manifest references', async () => {
      const m = await buildManifest(browser);
      const out = path.join(DIST, browser);

      const referenced = [
        ...Object.values(m.icons || {}),
        ...Object.values(m.action?.default_icon || {}),
        m.action?.default_popup,
        ...(m.content_scripts || []).flatMap(cs => cs.js || []),
        ...(m.background?.scripts || []),
        m.background?.service_worker,
        m.sidebar_action?.default_panel,
        ...Object.values(m.sidebar_action?.default_icon || {}),
        // side_panel paths carry a query string the filesystem doesn't have
        m.side_panel?.default_path?.split('?')[0]
      ].filter(Boolean);

      for (const rel of new Set(referenced)) {
        assert.ok(existsSync(path.join(out, rel)), `${browser} manifest references "${rel}" but it is not in dist/${browser}/`);
      }
    });

    test('contains every script popup.html loads', async () => {
      const out = path.join(DIST, browser);
      for (const src of await popupScripts()) {
        assert.ok(existsSync(path.join(out, src)), `dist/${browser}/ is missing "${src}"`);
      }
    });

    test('does not ship dev-only files', async () => {
      // The old web-ext --ignore-files approach packaged anything it wasn't
      // told to exclude; the build now uses an explicit allowlist instead.
      const out = path.join(DIST, browser);
      for (const leaked of ['README.md', 'LICENSE', 'package.json', 'node_modules', 'tests', 'scripts', '.git', '.claude', 'manifest.base.json']) {
        assert.ok(!existsSync(path.join(out, leaked)), `dist/${browser}/ should not contain ${leaked}`);
      }
    });
  });
}
