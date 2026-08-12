// Validates the merged manifest for each browser.
//
// The two failure modes this guards against are symmetric and both silent:
// shipping a Firefox-only key to Chrome (Chrome refuses to load the extension)
// or a Chrome-only key to Firefox (web-ext lint errors, AMO rejects the build).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildManifest, BROWSERS } from '../scripts/build.mjs';

const REQUIRED = ['manifest_version', 'name', 'version', 'description', 'icons', 'action', 'content_scripts'];

// Keys/permissions that must never reach the other browser's build.
const FORBIDDEN = {
  chrome: {
    keys: ['sidebar_action', 'browser_specific_settings'],
    permissions: ['webRequestBlocking', 'menus'],
    commands: ['_execute_sidebar_action']
  },
  firefox: {
    keys: ['side_panel', 'minimum_chrome_version', 'key'],
    permissions: ['sidePanel'],
    commands: []
  }
};

for (const browser of BROWSERS) {
  describe(`${browser} manifest`, () => {
    test('has every required key', async () => {
      const m = await buildManifest(browser);
      for (const key of REQUIRED) {
        assert.ok(key in m, `missing required key "${key}"`);
      }
      assert.equal(m.manifest_version, 3);
    });

    test('declares exactly one background form', async () => {
      const m = await buildManifest(browser);
      assert.ok(m.background, 'no background declared');
      const expected = browser === 'chrome' ? 'service_worker' : 'scripts';
      const forbidden = browser === 'chrome' ? 'scripts' : 'service_worker';
      assert.ok(m.background[expected], `background.${expected} missing`);
      assert.ok(
        !(forbidden in m.background),
        `background.${forbidden} must not be present in the ${browser} build — declaring both breaks both browsers`
      );
    });

    test('carries no keys the other browser owns', async () => {
      const m = await buildManifest(browser);
      for (const key of FORBIDDEN[browser].keys) {
        assert.ok(!(key in m), `"${key}" must not appear in the ${browser} build`);
      }
    });

    test('carries no foreign permissions', async () => {
      const m = await buildManifest(browser);
      for (const perm of FORBIDDEN[browser].permissions) {
        assert.ok(
          !(m.permissions || []).includes(perm),
          `permission "${perm}" must not appear in the ${browser} build`
        );
      }
    });

    test('carries no foreign commands', async () => {
      const m = await buildManifest(browser);
      for (const cmd of FORBIDDEN[browser].commands) {
        assert.ok(
          !(cmd in (m.commands || {})),
          `command "${cmd}" is not recognised by ${browser}`
        );
      }
    });

    test('permissions and host_permissions are deduped', async () => {
      const m = await buildManifest(browser);
      for (const field of ['permissions', 'host_permissions']) {
        const list = m[field] || [];
        assert.equal(new Set(list).size, list.length, `${field} contains duplicates`);
      }
    });
  });
}

describe('firefox manifest specifics', () => {
  test('keeps the gecko id required for unlisted AMO signing', async () => {
    const m = await buildManifest('firefox');
    assert.ok(
      m.browser_specific_settings?.gecko?.id,
      'AMO cannot sign an unlisted build without browser_specific_settings.gecko.id'
    );
  });
});

describe('chrome manifest specifics', () => {
  test('side panel points at a real path', async () => {
    const m = await buildManifest('chrome');
    assert.ok(m.side_panel?.default_path, 'side_panel.default_path missing');
    // The ?view= marker is how popup.js will detect side-panel mode on Chrome;
    // extension.getViews({type:'sidebar'}) is Firefox-only.
    assert.match(m.side_panel.default_path, /^popup\.html/);
  });
});
