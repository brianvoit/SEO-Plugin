// Accessibility floor for the popup markup.
//
// These are the checks that a regression would otherwise pass silently: an
// icon button reads as "button" with no name, or a decorative SVG leaks its
// shapes into the accessibility tree. Nothing here is subjective — each test
// pins a rule the markup either follows or doesn't, so new UI is caught at
// review time rather than by whoever eventually tries to use this with a
// screen reader.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { ROOT } from './helpers.mjs';

const html = await readFile(path.join(ROOT, 'popup.html'), 'utf8');
const doc = new JSDOM(html).window.document;

/** Text a screen reader would announce for an element, roughly. */
const visibleText = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();

describe('icon-only buttons have an accessible name', () => {
  const iconOnly = [...doc.querySelectorAll('button')]
    .filter(b => b.querySelector('svg') && !visibleText(b));

  test('there are icon-only buttons to check', () => {
    assert.ok(iconOnly.length > 20, `only found ${iconOnly.length} — has the markup changed shape?`);
  });

  test('every one of them carries aria-label', () => {
    const nameless = iconOnly
      .filter(b => !b.getAttribute('aria-label'))
      .map(b => b.id || b.className || b.outerHTML.slice(0, 60));
    assert.deepEqual(nameless, [], 'icon buttons with no accessible name');
  });

  test('no aria-label is left empty', () => {
    // An empty label is worse than none: it suppresses the title fallback and
    // the button announces as nothing at all.
    const empty = iconOnly
      .filter(b => b.hasAttribute('aria-label') && !b.getAttribute('aria-label').trim())
      .map(b => b.id || b.outerHTML.slice(0, 60));
    assert.deepEqual(empty, []);
  });
});

describe('decorative SVGs are hidden from the accessibility tree', () => {
  test('every inline svg is aria-hidden', () => {
    const exposed = [...doc.querySelectorAll('svg')]
      .filter(s => s.getAttribute('aria-hidden') !== 'true')
      .map(s => (s.closest('button') || s.parentElement)?.id || s.outerHTML.slice(0, 50));
    assert.deepEqual(exposed, [], 'these SVGs would be announced as graphics');
  });

  test('and out of the tab order', () => {
    // Inline SVG is focusable by default in some engines, which puts a dead
    // stop between a button and the next real control.
    const focusable = [...doc.querySelectorAll('svg')]
      .filter(s => s.getAttribute('focusable') !== 'false').length;
    assert.equal(focusable, 0);
  });
});

describe('the tab bar', () => {
  const tabs = [...doc.querySelectorAll('.tab-btn')];

  test('marks the active tab with aria-current', () => {
    const current = tabs.filter(b => b.getAttribute('aria-current'));
    assert.equal(current.length, 1, 'exactly one tab should be current in the initial markup');
    assert.equal(current[0].dataset.tab, 'overview');
  });

  test('does NOT claim to be a tablist', () => {
    // A tablist role promises arrow-key navigation and a single tab stop.
    // These are plain buttons and behave like it; claiming otherwise would
    // hand a screen-reader user keys that do nothing. If the role is ever
    // added, the keyboard behaviour has to come with it — this test is the
    // reminder, not an objection to doing it properly later.
    const group = doc.getElementById('main-tabs');
    assert.equal(group.getAttribute('role'), null);
    assert.deepEqual(tabs.filter(b => b.getAttribute('role') === 'tab'), []);
  });

  test('every tab has a visible text label', () => {
    for (const b of tabs) assert.ok(visibleText(b), `tab ${b.dataset.tab} has no text`);
  });
});

describe('the generated Redirect URI field', () => {
  const input = () => doc.getElementById('gsc-redirect-uri');

  test('is marked read-only both ways', () => {
    // It is derived from the extension ID and cannot be chosen by the user.
    // aria-readonly states that to a screen reader; the readonly attribute
    // states it to the browser.
    assert.ok(input().hasAttribute('readonly'));
    assert.equal(input().getAttribute('aria-readonly'), 'true');
  });

  test('is visually distinguishable from the editable fields above it', () => {
    // Without this it is pixel-identical to the Client ID / Secret inputs and
    // reads as a broken input — which is how it was reported.
    assert.match(input().className, /api-key-input--readonly/);
  });

  test('stays reachable by keyboard so it can still be copied', () => {
    assert.equal(input().getAttribute('tabindex'), null, 'removing it from the tab order would hurt keyboard users');
  });

  test('says what it is', () => {
    assert.ok((input().getAttribute('title') || '').length > 20, 'needs an explanation of why it is not editable');
  });
});

describe('form inputs are labelled', () => {
  test('every text/password input is inside a label or has one pointing at it', () => {
    const inputs = [...doc.querySelectorAll('input[type="text"], input[type="password"], input[type="date"], textarea')];
    const unlabelled = inputs.filter(el => {
      if (el.closest('label')) return false;
      if (el.getAttribute('aria-label')) return false;
      if (el.id && doc.querySelector(`label[for="${el.id}"]`)) return false;
      if (el.getAttribute('placeholder')) return false;   // weak, but a name
      return true;
    }).map(el => el.id || el.outerHTML.slice(0, 60));
    assert.deepEqual(unlabelled, []);
  });
});
