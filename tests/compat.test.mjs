// Cross-browser API linter.
//
// Flags constructs that work in Firefox but break on Chrome/Edge. Every
// violation that exists today is recorded in compat-baseline.json, so this
// starts green and acts as executable documentation of the port surface:
//
//   * a NEW violation in a file fails the build (no backsliding)
//   * a FIXED violation still listed in the baseline also fails, so the
//     baseline can't rot into a list of lies
//
// Milestone 2 deletes baseline entries as it ports each area.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, readJson } from './helpers.mjs';

const RULES = [
  {
    id: 'sidebarAction',
    pattern: /browser\.sidebarAction\b/,
    why: 'Firefox-only. Chrome uses chrome.sidePanel, which has no toggle() and needs a user gesture.'
  },
  {
    id: 'menus-namespace',
    pattern: /browser\.menus\b/,
    why: 'Firefox-only namespace. Chrome exposes chrome.contextMenus.'
  },
  {
    id: 'menus-onShown-refresh',
    pattern: /menus\.(onShown|refresh)\b/,
    why: 'No Chrome equivalent. Checkbox state must be synced eagerly via storage.onChanged instead.'
  },
  {
    id: 'getViews-sidebar',
    pattern: /getViews\(\s*\{\s*type:\s*['"]sidebar['"]/,
    why: "Chrome's getViews accepts only tab/popup/notification; returns [] so sidebar detection silently fails."
  },
  {
    id: 'getSecurityInfo',
    pattern: /webRequest\.getSecurityInfo\b/,
    why: 'Firefox-only. Chrome cannot read TLS details at all — the DNS tab must fall back to #tls-note.'
  },
  {
    id: 'webRequest-blocking',
    pattern: /\[\s*['"]blocking['"]/,
    why: 'Chrome MV3 removed blocking webRequest for non-policy extensions.'
  },
  {
    id: 'originUrl',
    pattern: /\.originUrl\b/,
    why: 'Firefox-only request property. Chrome calls it details.initiator.'
  },
  {
    id: 'moz-extension-scheme',
    pattern: /moz-extension:\/\//,
    why: 'Chrome extension pages are served from chrome-extension://.'
  },
  {
    id: 'onMessage-promise-return',
    // A listener that never mentions sendResponse is relying on Firefox's
    // promise-return behaviour, which Chrome ignores entirely.
    test: (src) => /runtime\.onMessage\.addListener/.test(src) && !/sendResponse/.test(src),
    why: 'Chrome ignores a Promise returned from onMessage; handlers must call sendResponse and return true.'
  }
];

const baseline = await readJson(path.join(ROOT, 'tests', 'compat-baseline.json'));
const files = (await readdir(ROOT)).filter(f => f.endsWith('.js')).sort();

/** Every rule violation currently present, as "file::ruleId" keys. */
async function findViolations() {
  const found = new Set();
  for (const file of files) {
    const src = await readFile(path.join(ROOT, file), 'utf8');
    for (const rule of RULES) {
      const hit = rule.test ? rule.test(src) : rule.pattern.test(src);
      if (hit) found.add(`${file}::${rule.id}`);
    }
  }
  return found;
}

const allowed = new Set(Object.keys(baseline.violations));

test('no new Chrome-incompatible constructs', async () => {
  const found = await findViolations();
  const added = [...found].filter(k => !allowed.has(k));

  const describe = (key) => {
    const [file, id] = key.split('::');
    return `  ${file} — ${RULES.find(r => r.id === id).why}`;
  };

  assert.equal(
    added.length, 0,
    `new Chrome-incompatible code introduced:\n${added.map(describe).join('\n')}\n\n` +
    'Either port it now, or add it to tests/compat-baseline.json with a reason.'
  );
});

test('baseline contains no stale entries', async () => {
  const found = await findViolations();
  const stale = [...allowed].filter(k => !found.has(k));
  assert.equal(
    stale.length, 0,
    `tests/compat-baseline.json lists violations that no longer exist — delete them:\n${stale.map(s => '  ' + s).join('\n')}`
  );
});

test('every baseline entry explains itself', () => {
  for (const [key, entry] of Object.entries(baseline.violations)) {
    assert.ok(entry.reason, `baseline entry ${key} needs a "reason"`);
    assert.ok(
      ['port-in-m2', 'intentional'].includes(entry.status),
      `baseline entry ${key} needs status "port-in-m2" or "intentional" (got ${entry.status})`
    );
  }
});
