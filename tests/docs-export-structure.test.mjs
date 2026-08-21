// The Google Doc export's document structure.
//
// Drive converts uploaded HTML to a native Doc, mapping tags onto Docs' named
// styles. That mapping is the whole point of the markup choices here: get it
// right and the document inherits the reader's own heading and body styles;
// get it wrong — chiefly by setting inline font sizes — and every paragraph
// carries a hardcoded size that overrides them.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

const src = await readFile(path.join(ROOT, 'bg-export.js'), 'utf8');

const build = new Function(`
  ${src.slice(src.indexOf('function htmlEsc('), src.indexOf('// Derive a "host/path" label'))}
  return { buildActionPlanHtml, trustRuleDisplay };
`)();

const plan = {
  recommendations: [
    { change: 'Rewrite the title tag', detail: 'Lead with the head terms.', evidence: '0.5% CTR at position 2.4.',
      effort: 'surgical', impact: 'high', channel: 'seo' },
    { change: 'Add an ADHD testing H2', detail: 'Name the city.', evidence: 'Position 12.3.',
      effort: 'moderate', impact: 'high', channel: 'both' }
  ],
  contentGaps: ['Fees and pricing'],
  trust: {
    checklist: [
      { id: 'org', label: 'Organization schema present and complete', state: 'met' },
      { id: 'author', label: 'Author byline with Person schema', state: 'na', reason: 'this client does not publish bylined content' }
    ],
    recommendations: [
      { ruleId: 'R-THIRDPARTY', change: 'Link to independent verification', detail: 'Point at the NARI directory.',
        evidence: 'No outbound link to a registry.', trigger: 'no outbound links', effort: 'surgical', impact: 'medium' },
      { ruleId: 'R-REVIEW-DISPLAY-NOSTARS', change: 'Display reviews for conversion', detail: 'Surface them near the CTA.',
        evidence: 'GBP client on a home page', trigger: 'gbp', effort: 'moderate', impact: 'medium',
        ceiling: 'Star rich results are NOT achievable here.' }
    ],
    findings: [],
    caveat: 'On-page analysis cannot observe off-site reputation.'
  }
};

const html = build.buildActionPlanHtml(plan, { title: 'SEO Action Plan for trehus.biz', subtitle: 'https://trehus.biz/services/' }, Date.UTC(2026, 7, 21));

describe('title and subtitle', () => {
  test('the document opens with a Title paragraph, not a heading', () => {
    assert.match(html, /<p class="title">SEO Action Plan for trehus\.biz<\/p>/);
  });

  test('the page URL is the Subtitle', () => {
    assert.match(html, /<p class="subtitle">https:\/\/trehus\.biz\/services\/<\/p>/);
  });

  test('the title carries no date — "Generated" already does', () => {
    const title = /<p class="title">([^<]*)<\/p>/.exec(html)[1];
    assert.doesNotMatch(title, /\d{4}/);
    // Not pinned to an exact day: toLocaleDateString renders in the machine's
    // timezone, so a UTC midnight fixture is the previous date west of GMT.
    assert.match(html, /Generated \w+ \d{1,2}, 2026/);
  });

  test('the Drive filename keeps its date, so exports sort and never collide', () => {
    // Deliberately different from the in-document title.
    assert.match(src, /const docTitle = `\$\{date\}: \$\{planTitle \|\| 'Action Plan'\} For/);
    assert.match(src, /title: `\$\{planTitle \|\| 'Action Plan'\} for \$\{domain\}`/);
  });

  test('the domain drops www', () => {
    assert.match(src, /hostname\.replace\(\/\^www\\\.\/, ''\)/);
  });
});

describe('heading levels', () => {
  test('sections are h1', () => {
    ['Quick wins', 'Recommended', 'Content gaps', 'Trust Signals'].forEach(t =>
      assert.match(html, new RegExp(`<h1>${t}</h1>`), t));
  });

  test('task names are h2', () => {
    assert.match(html, /<h2>Rewrite the title tag<\/h2>/);
    assert.match(html, /<h2>Link to independent verification<\/h2>/);
  });

  test('a trust recommendation is a task name too, not a bold paragraph', () => {
    assert.doesNotMatch(html, /<p><b>Link to independent verification<\/b>/);
  });
});

describe('inheriting the reader\'s styles', () => {
  test('no inline font-size anywhere', () => {
    // An inline size overrides the named style it lands on, which is what
    // stopped the document picking up the reader's own heading and body styles.
    assert.doesNotMatch(html, /font-size/);
  });

  test('colour survives only where it carries meaning', () => {
    // Effort banding and muted evidence — nothing in a named style conveys
    // either.
    assert.match(html, /color:#15803d/);   // surgical
    assert.match(html, /color:#999999/);   // evidence / caveat
  });
});

describe('the trust meta line', () => {
  test('is its own paragraph, not tacked onto the title', () => {
    assert.match(html, /<h2>Link to independent verification<\/h2><p style="color:#15803d">/);
  });

  test('matches a recommendation\'s order: tier, impact, kind', () => {
    assert.match(html, /Quick wins · medium impact · THIRD PARTY/);
    // The same shape as the recommendations above it.
    assert.match(html, /Quick wins · high impact · SEO/);
  });

  test('is banded by effort, like the recommendations', () => {
    assert.match(html, /<p style="color:#b45309">Recommended · medium impact · REVIEW DISPLAY NO STARS/);
  });

  test('THIRDPARTY reads as two words', () => {
    assert.equal(build.trustRuleDisplay('R-THIRDPARTY'), 'THIRD PARTY');
  });

  test('other ids are humanised without inventing spaces', () => {
    assert.equal(build.trustRuleDisplay('R-ADDRESS'), 'ADDRESS');
    assert.equal(build.trustRuleDisplay('R-PERSON-SCHEMA'), 'PERSON SCHEMA');
    assert.equal(build.trustRuleDisplay('R-REVIEW-DISPLAY-NOSTARS'), 'REVIEW DISPLAY NO STARS');
  });
});

describe('spacing and completeness', () => {
  test('a blank paragraph follows the trust checklist', () => {
    // A truly empty <p> is dropped by Drive, so the spacer needs a character.
    assert.match(html, /<\/ul><p>&nbsp;<\/p>/);
  });

  test('n/a rows still carry their reason', () => {
    assert.match(html, /Author byline with Person schema <i>\(this client does not publish bylined content\)<\/i>/);
  });

  test('detail, evidence, ceiling and caveat all survive', () => {
    assert.match(html, /Lead with the head terms\./);
    assert.match(html, /0\.5% CTR at position 2\.4\./);
    assert.match(html, /Star rich results are NOT achievable here\./);
    assert.match(html, /cannot observe off-site reputation/);
  });

  test('a plan with no trust section still builds', () => {
    const bare = build.buildActionPlanHtml({ recommendations: [], contentGaps: [] }, { title: 'Action Plan for x.com', subtitle: '' }, Date.now());
    assert.match(bare, /<p class="title">Action Plan for x\.com<\/p>/);
    assert.doesNotMatch(bare, /subtitle/);
  });
});
