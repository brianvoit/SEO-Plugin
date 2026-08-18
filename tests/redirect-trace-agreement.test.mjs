// Tests that the Redirect Trace and the Link Health overlay agree, and that
// the export never silently drops the chain you opened the panel to see.
//
// The bug this pins, from a real report: the overlay flagged
//   https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11330818/
// as a redirect (it is — a 301 to pmc.ncbi.nlm.nih.gov), but clicking through
// and exporting the trace produced "Redirects: 0".
//
// Cause: the active trace re-requests tab.url, which after following the
// redirect is the DESTINATION — a URL that by definition has no redirects.
// The passively-recorded chain DID hold the real hop, and the export threw it
// away, because displayChain() prefers the active chain whenever one exists.
//
// Two fixes are pinned here: the active trace now seeds from where the
// navigation actually started, and the export emits BOTH chains.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

const src = await readFile(path.join(ROOT, 'popup-redirects.js'), 'utf8');

/**
 * Runs the real chain/export functions against controllable module state.
 * They are pure over `_redirectInfo`, `_redirectMeta`, `_activeTrace` and
 * `_activeTraceUrl`, so no DOM is needed.
 */
function boot({ passive = [], meta = null, active = null, tabUrl = null, totalMs = null } = {}) {
  // `end` is searched for AFTER `start`, or a generic marker like a blank line
  // matches the first one in the whole file instead of the next one.
  const grab = (start, end) => {
    const a = src.indexOf(start);
    assert.ok(a !== -1, `slice marker moved: "${start}"`);
    const b = src.indexOf(end, a + start.length);
    assert.ok(b > a, `slice end marker moved: "${start}" → "${end}"`);
    return src.slice(a, b);
  };
  const body = [
    grab('function redirectTypeLabel(', 'function countRedirects('),
    grab('function countRedirects(', '\n\n'),
    grab('function hopExtras(', '\n}\n') + '\n}\n',
    grab('function tracedChain(', '// ─── Active trace lifecycle'),
    grab('function pad2(', 'async function exportRedirectTrace(')
  ].join('\n');

  return new Function('cfg', `
    const _redirectInfo = cfg.passive.length || cfg.totalMs != null
      ? { chain: cfg.passive, totalMs: cfg.totalMs } : null;
    const _redirectMeta = cfg.meta;
    const _activeTrace = cfg.active ? { hops: cfg.active } : null;
    const _activeTraceUrl = cfg.tabUrl;
    ${body}
    return {
      text: buildRedirectExportText(),
      seed: activeTraceSeedUrl(cfg.tabUrl),
      passiveStart: passiveStartUrl(),
      display: displayChain().map(h => h.url),
      same: sameUrl
    };
  `)({ passive, meta, active, tabUrl, totalMs });
}

// The real case from the report.
const WWW  = 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11330818/';
const PMC  = 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11330818/';
const REDIRECTED_PASSIVE = [
  { url: WWW, status: 301 },
  { url: PMC, status: 200 }
];

describe('the active trace starts where the navigation did', () => {
  test('after following a redirect, it seeds from the requested URL, not the destination', () => {
    // The whole bug: seeding from tab.url re-traces PMC, which has no
    // redirects, and reports "0" for a link that plainly redirects.
    assert.equal(boot({ passive: REDIRECTED_PASSIVE, tabUrl: PMC }).seed, WWW);
  });

  test('with no redirect, it still traces the page you are on', () => {
    const direct = [{ url: PMC, status: 200 }];
    assert.equal(boot({ passive: direct, tabUrl: PMC }).seed, PMC);
  });

  test('with no passive chain at all, it falls back to the tab URL', () => {
    // Opening the panel on a tab that loaded before the extension did.
    assert.equal(boot({ passive: [], tabUrl: PMC }).seed, PMC);
  });

  test('a non-http passive start is ignored rather than traced', () => {
    const odd = [{ url: 'about:blank', status: 200 }, { url: PMC, status: 200 }];
    assert.equal(boot({ passive: odd, tabUrl: PMC }).seed, PMC);
  });

  test('the trace identity includes the seed, so a late passive chain re-traces', () => {
    // The passive chain arrives from the background asynchronously. Keying on
    // the tab URL alone would leave the destination trace on screen forever.
    assert.match(src, /const key = `\$\{url\}::\$\{seed\}`/);
    assert.match(src, /if \(!force && _activeTraceKey === key\) return/);
  });

  test('the in-flight guard compares the seed-aware key, not just the URL', () => {
    assert.match(src, /if \(_activeTraceKey !== key\) return;\s*\/\/ navigated away/);
  });

  test('it is the seed that gets traced, not the tab URL', () => {
    assert.match(src, /action: 'traceUrl', pageUrl: seed/);
  });
});

describe('the panel says why the trace starts elsewhere', () => {
  test('a differing start is reported in plain language', () => {
    assert.match(src, /You arrived here via a redirect from \$\{arrivedFrom\}/);
  });

  test('it is only shown when the start actually differs', () => {
    assert.match(src, /if \(arrivedFrom && !sameUrl\(arrivedFrom, currentTabUrl\(\)\)\)/);
  });

  test('a trailing slash alone is not treated as arriving via a redirect', () => {
    const { same } = boot({ tabUrl: PMC });
    assert.equal(same('https://a.com/x/', 'https://a.com/x'), true);
    assert.equal(same('https://a.com/x#frag', 'https://a.com/x'), true);
    assert.equal(same('https://a.com/x', 'https://a.com/y'), false);
  });

  test('passiveStartUrl is null when nothing redirected', () => {
    assert.equal(boot({ passive: [{ url: PMC, status: 200 }], tabUrl: PMC }).passiveStart, PMC);
    assert.equal(boot({ passive: [], tabUrl: PMC }).passiveStart, null);
  });
});

describe('the export carries both chains', () => {
  const both = () => boot({
    passive: REDIRECTED_PASSIVE,
    active: [{ url: WWW, status: 301 }, { url: PMC, status: 200 }],
    tabUrl: PMC,
    totalMs: 412
  }).text;

  test('both sections are present and labelled', () => {
    const t = both();
    assert.match(t, /=== LIVE TRACE \(re-requested now\) ===/);
    assert.match(t, /=== THIS SESSION \(what the browser actually did\) ===/);
  });

  test('the redirect is no longer missing from the file', () => {
    // The exact failure from the report: "Redirects: 0" for a 301.
    const t = both();
    assert.ok(!/Redirects: 0/.test(t), 'the export still reports zero redirects for a 301');
    assert.match(t, /Redirects: 1/);
  });

  test('the header names the page and where it was reached from', () => {
    const t = both();
    assert.match(t, new RegExp(`Page: ${PMC.replace(/[/.]/g, '\\$&')}`));
    assert.match(t, /Arrived via a redirect from: https:\/\/www\.ncbi\.nlm\.nih\.gov/);
  });

  test('no "arrived via" line when the navigation went straight through', () => {
    const t = boot({ passive: [{ url: PMC, status: 200 }], active: [{ url: PMC, status: 200 }], tabUrl: PMC }).text;
    assert.doesNotMatch(t, /Arrived via a redirect/);
  });

  test('a passive-only trace still exports fully', () => {
    // No active trace yet (still loading, or the trace failed).
    const t = boot({ passive: REDIRECTED_PASSIVE, tabUrl: PMC }).text;
    assert.doesNotMatch(t, /LIVE TRACE/);
    assert.match(t, /THIS SESSION/);
    assert.match(t, /Redirects: 1/);
  });

  test('an active-only trace still exports fully', () => {
    const t = boot({ active: [{ url: WWW, status: 301 }, { url: PMC, status: 200 }], tabUrl: WWW }).text;
    assert.match(t, /LIVE TRACE/);
    assert.doesNotMatch(t, /THIS SESSION/);
  });

  test('with neither, it says so instead of emitting an empty path', () => {
    assert.match(boot({ tabUrl: PMC }).text, /No redirect data for this page\./);
  });

  test('each hop keeps its status, kind and URL', () => {
    const t = both();
    assert.match(t, /1\. \[301\] Permanent https:\/\/www\.ncbi/);
    assert.match(t, /2\. \[200\] FINAL https:\/\/pmc\.ncbi/);
  });

  test('each chain reports its own total time', () => {
    // The session total comes from the passive record; the live trace sums its
    // own hops. Sharing one number between them would misattribute it.
    const t = both();
    assert.match(t, /Total time: 412 ms/);
  });

  test('a pending meta-refresh still appears in the session chain', () => {
    const t = boot({
      passive: [{ url: PMC, status: 200 }],
      meta: { url: 'https://elsewhere.example/', delay: 3 },
      tabUrl: PMC
    }).text;
    assert.match(t, /META REFRESH 3s https:\/\/elsewhere\.example/);
  });
});

describe('the filename still resolves', () => {
  test('displayChain survives for the export filename', () => {
    // It no longer drives the body, but the filename still uses it.
    assert.deepEqual(boot({ passive: REDIRECTED_PASSIVE, tabUrl: PMC }).display, [WWW, PMC]);
    assert.deepEqual(
      boot({ passive: REDIRECTED_PASSIVE, active: [{ url: PMC, status: 200 }], tabUrl: PMC }).display,
      [PMC]
    );
  });
});

// ─── Auto-opening the session chain ───────────────────────────────────────────

describe('the session chain opens itself when it disagrees', () => {
  const fns = new Function(`
    ${src.slice(src.indexOf('function chainSignature('), src.indexOf('// The URL the browser was originally asked for'))}
    return { chainSignature, chainsDiffer };
  `)();

  const ACTIVE_REDIRECT = [{ url: WWW, status: 301 }, { url: PMC, status: 200 }];
  const DIRECT = [{ url: PMC, status: 200 }];

  test('a live trace with a redirect against a session record without one differs', () => {
    // The exact case that hid the bug: the two panels told different stories
    // and the one holding the evidence was folded shut.
    assert.equal(fns.chainsDiffer(ACTIVE_REDIRECT, DIRECT), true);
  });

  test('identical chains do not differ, so it stays collapsed', () => {
    assert.equal(fns.chainsDiffer(ACTIVE_REDIRECT, [...ACTIVE_REDIRECT]), false);
  });

  test('a status change alone counts as different', () => {
    assert.equal(fns.chainsDiffer([{ url: PMC, status: 200 }], [{ url: PMC, status: 500 }]), true);
  });

  test('a trailing slash or fragment is not a difference', () => {
    assert.equal(fns.chainsDiffer(
      [{ url: 'https://a.com/x/', status: 200 }],
      [{ url: 'https://a.com/x#top', status: 200 }]
    ), false);
  });

  test('an empty live trace is not a disagreement', () => {
    // Still loading, or the trace failed — there is nothing to disagree with,
    // and popping the section open mid-load would be noise.
    assert.equal(fns.chainsDiffer([], DIRECT), false);
    assert.equal(fns.chainsDiffer(ACTIVE_REDIRECT, []), false);
  });

  test('the decision is keyed, so a manual collapse survives a re-render', () => {
    assert.match(src, /if \(_passiveAutoOpenKey !== key\) \{/);
    assert.match(src, /passive\.open = chainsDiffer\(activeChain\(\), pChain\)/);
  });

  test('the key resets when the section goes away', () => {
    const block = src.slice(src.indexOf("passive.classList.add('hidden')"));
    assert.match(block.slice(0, 120), /_passiveAutoOpenKey = null/);
  });
});
