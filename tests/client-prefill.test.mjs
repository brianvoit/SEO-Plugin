// Tests popup-clients.js's "+ Client" name inference — the guesses that
// prefill the Client panel from whatever page the user is looking at.
//
// These are pure functions over the pageData shape content.js produces
// (openGraph.og / structuredData / title.text), so they're sliced out and run
// directly rather than driving the panel. The value here is the ORDER and the
// reject rules: a wrong guess is silently wrong — it lands in an input the
// user may well accept without reading — so each fallback step is pinned.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

const START = 'function brandFromTitle(';
const END = 'async function loadClientPrefill(';

const src = await readFile(path.join(ROOT, 'popup-clients.js'), 'utf8');
const from = src.indexOf(START);
const to = src.indexOf(END);

test('the inference helpers are still where the test expects them', () => {
  assert.ok(from !== -1, `could not find "${START}" in popup-clients.js — update this test's slice markers`);
  assert.ok(to > from, `could not find "${END}" after the helpers`);
});

const { brandFromTitle, brandFromHost, inferClientName } = new Function(
  `${src.slice(from, to)}; return { brandFromTitle, brandFromHost, inferClientName };`
)();

/** The subset of content.js's getPageData() these functions actually read. */
const pageData = ({ siteName, schemas, title } = {}) => ({
  openGraph: { og: siteName === undefined ? {} : { 'og:site_name': siteName }, twitter: {} },
  structuredData: schemas || [],
  title: title === undefined ? undefined : { text: title, charCount: title.length, wordCount: 1 }
});

describe('brandFromTitle', () => {
  test('takes the trailing segment after a separator', () => {
    assert.equal(brandFromTitle('Some Page | Acme Co'), 'Acme Co');
  });

  test('handles every separator site templates actually emit', () => {
    for (const sep of ['|', '–', '—', '·', '•', '-']) {
      assert.equal(brandFromTitle(`Some Page ${sep} Acme Co`), 'Acme Co', `separator ${sep} not handled`);
    }
  });

  test('takes the LAST segment when a title has several', () => {
    assert.equal(brandFromTitle('Blog | Category | Acme Co'), 'Acme Co');
  });

  test('needs whitespace around the separator, so hyphenated titles stay intact', () => {
    // "Acme-Corp Widgets" is one brand, not "Acme" split from "Corp Widgets".
    assert.equal(brandFromTitle('Widgets|Acme'), '');
    assert.equal(brandFromTitle('Acme-Corp Widgets'), '');
  });

  test('gives up on a title with no separator', () => {
    assert.equal(brandFromTitle('Just A Page Title'), '');
  });

  test('rejects a long tail segment as a tagline, not a brand', () => {
    assert.equal(brandFromTitle(`Page | ${'x'.repeat(41)}`), '');
  });

  test('rejects a wordy tail segment as a tagline', () => {
    assert.equal(brandFromTitle('Page | a b c d e f'), '');
  });

  test('accepts the boundary cases (40 chars, 5 words)', () => {
    assert.equal(brandFromTitle(`Page | ${'x'.repeat(40)}`), 'x'.repeat(40));
    assert.equal(brandFromTitle('Page | a b c d e'), 'a b c d e');
  });

  test('survives missing input', () => {
    assert.equal(brandFromTitle(undefined), '');
    assert.equal(brandFromTitle(''), '');
  });
});

describe('brandFromHost', () => {
  test('title-cases the first label', () => {
    assert.equal(brandFromHost('acme.com'), 'Acme');
  });

  test('turns separators in the label into spaces', () => {
    assert.equal(brandFromHost('acme-corp.co.uk'), 'Acme Corp');
    assert.equal(brandFromHost('acme_corp.com'), 'Acme Corp');
  });

  test('collapses runs of separators', () => {
    assert.equal(brandFromHost('acme--corp.com'), 'Acme Corp');
  });

  test('survives missing input', () => {
    assert.equal(brandFromHost(''), '');
    assert.equal(brandFromHost(undefined), '');
  });
});

describe('inferClientName priority order', () => {
  test('1. og:site_name beats everything below it', () => {
    const data = pageData({
      siteName: 'Acme From OG',
      schemas: [{ '@type': 'Organization', name: 'Acme From Schema' }],
      title: 'Page | Acme From Title'
    });
    assert.equal(inferClientName(data, 'acme.com'), 'Acme From OG');
  });

  test('2. schema.org name when there is no og:site_name', () => {
    const data = pageData({
      schemas: [{ '@type': 'Organization', name: 'Acme From Schema' }],
      title: 'Page | Acme From Title'
    });
    assert.equal(inferClientName(data, 'acme.com'), 'Acme From Schema');
  });

  test('   …accepting WebSite and LocalBusiness too', () => {
    for (const type of ['Organization', 'WebSite', 'LocalBusiness']) {
      const data = pageData({ schemas: [{ '@type': type, name: `Acme ${type}` }] });
      assert.equal(inferClientName(data, 'acme.com'), `Acme ${type}`);
    }
  });

  test('   …reading @type when it is an array', () => {
    const data = pageData({ schemas: [{ '@type': ['LocalBusiness', 'Organization'], name: 'Acme Both' }] });
    assert.equal(inferClientName(data, 'acme.com'), 'Acme Both');
  });

  test('   …skipping schema types that are not the business itself', () => {
    // A page's Article/Breadcrumb name is the PAGE's name; using it would name
    // the client after whatever article happened to be open.
    const data = pageData({
      schemas: [
        { '@type': 'BreadcrumbList', name: 'Breadcrumbs' },
        { '@type': 'Article', name: 'How To Fix A Sink' },
        { '@type': 'Organization', name: 'Acme Co' }
      ]
    });
    assert.equal(inferClientName(data, 'acme.com'), 'Acme Co');
  });

  test('   …skipping a matching type whose name is not a string', () => {
    // schema.org allows name to be an object/array; taking it raw would put
    // "[object Object]" in the field.
    const data = pageData({
      schemas: [
        { '@type': 'Organization', name: { '@value': 'Nested' } },
        { '@type': 'Organization', name: 'Acme Co' }
      ]
    });
    assert.equal(inferClientName(data, 'acme.com'), 'Acme Co');
  });

  test('3. the title\'s brand segment when there is no og or schema', () => {
    const data = pageData({ title: 'Some Page | Acme From Title' });
    assert.equal(inferClientName(data, 'acme.com'), 'Acme From Title');
  });

  test('4. the domain label as the last resort', () => {
    const data = pageData({ title: 'A Title With No Separator' });
    assert.equal(inferClientName(data, 'acme-corp.com'), 'Acme Corp');
  });

  test('a blank og:site_name falls through rather than naming the client ""', () => {
    const data = pageData({ siteName: '   ', title: 'Page | Acme From Title' });
    assert.equal(inferClientName(data, 'acme.com'), 'Acme From Title');
  });

  test('a restricted page (no pageData at all) still gets the domain name', () => {
    // loadClientPrefill's page read is best-effort — about:, PDFs and store
    // pages return nothing, and the panel must still open with a sane guess.
    assert.equal(inferClientName(null, 'acme-corp.com'), 'Acme Corp');
  });

  test('a page with none of the four signals yields an empty name, not a crash', () => {
    assert.equal(inferClientName(pageData({}), ''), '');
  });
});
