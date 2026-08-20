// Tests the three Action Plan variants: overview (Overview tab), seo (Search
// tab) and paid (Ads tab).
//
// Two things here are load-bearing and easy to break silently.
//
// The FIRST is that ACTION_PLAN_SYSTEM — the Overview prompt — was arrived at
// by a lot of trial and error, and the plan it produces today is the one it
// should keep producing. The two new prompts were written as siblings around
// it, not as a rewrite of it. Several tests below exist purely so that an edit
// to that string fails the suite instead of quietly degrading the output of a
// feature nobody thought they were touching.
//
// The SECOND is variant isolation: three plans share one panel, one cache
// object and one set of nav rows. A key collision or a shared global would
// mean opening the SEO plan wipes the Overview plan the user just generated —
// a bug that costs a real API call to reproduce and looks like a flake.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

const src = await readFile(path.join(ROOT, 'popup-actionplan.js'), 'utf8');
const html = await readFile(path.join(ROOT, 'popup.html'), 'utf8');
const nav = await readFile(path.join(ROOT, 'popup-nav.js'), 'utf8');
const webceo = await readFile(path.join(ROOT, 'bg-webceo.js'), 'utf8');
const exportSrc = await readFile(path.join(ROOT, 'bg-export.js'), 'utf8');
const ads       = await readFile(path.join(ROOT, 'bg-ads.js'), 'utf8');
const router    = await readFile(path.join(ROOT, 'bg-router.js'), 'utf8');

/** Evaluate the prompt/const declarations without needing the DOM or MODEL_HEAVY. */
function prompts() {
  const grab = (name) => {
    const i = src.indexOf(`const ${name} = `);
    assert.ok(i !== -1, `could not find ${name}`);
    // Template literals run to the closing backtick + semicolon at line start.
    const end = src.indexOf('`;', src.indexOf('`', i)) + 2;
    return src.slice(i, end);
  };
  const decls = [
    grab('ACTION_PLAN_JSON_CONTRACT'),
    grab('ACTION_PLAN_INTENT_CLAUSE'),
    grab('ACTION_PLAN_CRAFT_RULES'),
    grab('ACTION_PLAN_SYSTEM'),
    grab('ACTION_PLAN_SYSTEM_SEO'),
    grab('ACTION_PLAN_SYSTEM_PAID')
  ].join('\n');
  return new Function(`${decls}
    return { overview: ACTION_PLAN_SYSTEM, seo: ACTION_PLAN_SYSTEM_SEO, paid: ACTION_PLAN_SYSTEM_PAID };`)();
}

const P = prompts();

// ─── The Overview prompt must not have been touched ───────────────────────────

describe('the original prompt is intact', () => {
  // Each of these clauses is a behaviour someone tuned deliberately. If one
  // disappears, the Overview plan changes and this test says so out loud.
  const invariants = [
    ['the JSON-only instruction',      /Respond with ONLY a compact JSON object, no prose, no code fences/],
    ['the effort enum',                /"surgical" \(minutes/],
    ['the impact enum',                /impact is one of: "high", "medium", "low"/],
    ['the channel enum',               /channel is one of: "seo"/],
    ['the prefer-both rule',           /Prefer "both" when a single page change does double duty/],
    ['the evidence requirement',       /Every recommendation MUST cite specific evidence/],
    ['the page-2 priority',            /Prioritize the page-2 band/],
    ['the 3-8 recommendation cap',     /Return 3–8 recommendations total/],
    ['the intentGap contract',         /"intentGap": include ONLY when TRAFFIC INTENT DISTRIBUTION is present/],
    ['the exactly-8-suggestions rule', /exactly 8 diverse keyword phrases/],
    // Phase 3 of the E-E-A-T module spec replaced the model-authored eeat
    // assessment with a deterministic rule engine, so this pin moved with it.
    // The prompt no longer asks the model to grade anything — only to phrase
    // the rules the engine already decided should fire.
    ['the trust-phrasing contract',    /"trust": phrasing for the E-E-A-T RULES block, and nothing else/],
    ['the no-inventing-rules rule',    /Do NOT invent a ruleId, do NOT include a suppressed rule/],
    ['the no-self-grading rule',       /do NOT assign an impact, effort or score/]
  ];
  invariants.forEach(([what, re]) => {
    test(`still contains ${what}`, () => {
      assert.match(P.overview, re, 'the Overview prompt was changed — was that intended?');
    });
  });

  test('is still what the overview variant actually sends', () => {
    assert.match(src, /ACTION_PLAN_SYSTEMS = \{\s*overview:\s*ACTION_PLAN_SYSTEM,/);
  });
});

// ─── The three prompts are genuinely different ────────────────────────────────

describe('three distinct prompts', () => {
  test('all three exist and none is a copy of another', () => {
    assert.notEqual(P.seo, P.overview);
    assert.notEqual(P.paid, P.overview);
    assert.notEqual(P.seo, P.paid);
  });

  test('each names its own discipline', () => {
    assert.match(P.seo, /on-page SEO strategist/i);
    assert.match(P.paid, /Google Ads strategist/i);
  });

  test('each pins its recommendations to one channel', () => {
    assert.match(P.seo,  /must use channel "seo"/);
    assert.match(P.paid, /must use channel "paid"/);
  });

  test('the SEO plan is forbidden from straying into paid actions', () => {
    assert.match(P.seo, /Never recommend a bid, budget, ad-copy or negative-keyword change/);
  });

  test('the Paid plan is forbidden from straying into organic actions', () => {
    assert.match(P.paid, /Do not recommend organic content or schema changes as ends in themselves/);
  });
});

// ─── The narrowing is in what they RECOMMEND, not what they KNOW ──────────────

describe('every variant still sees every source', () => {
  test('there is exactly one context builder', () => {
    assert.equal(src.match(/^function actionPlanContext\(/gm).length, 1);
  });

  test('the context is built once, with no variant argument', () => {
    // If this ever grows a variant parameter, the "all sources, one context"
    // decision has been quietly reversed.
    assert.match(src, /const context = actionPlanContext\(gathered\);/);
    assert.match(src, /^function actionPlanContext\(g\) \{/m);
  });

  test('each specialized prompt is explicitly told to use the other side as evidence', () => {
    // The whole reason both plans get the full context.
    assert.match(P.seo,  /Paid data is still evidence you should use/);
    assert.match(P.paid, /Organic data is evidence you should use/);
  });
});

// ─── Extras contract per variant ──────────────────────────────────────────────

describe('which extras each variant asks for', () => {
  test('the SEO plan asks for content gaps, intent gap and trust phrasing', () => {
    assert.match(P.seo, /"contentGaps"/);
    assert.match(P.seo, /"intentGap"/);
    assert.match(P.seo, /"trust": phrasing/);
  });

  test('the Paid plan asks for intent gap but explicitly refuses trust', () => {
    assert.match(P.paid, /"intentGap"/);
    assert.match(P.paid, /Do NOT include a "trust" key/);
  });

  test('no prompt asks the model to grade E-E-A-T any more', () => {
    // The grade implied a score Google does not assign, and was not comparable
    // between two clients. The engine emits an observable checklist instead.
    [P.overview, P.seo, P.paid].forEach(t => {
      assert.doesNotMatch(t, /"score" \("strong"/);
      assert.doesNotMatch(t, /Authoritativeness/);
    });
  });

  test('the Paid plan frames content gaps as a Quality Score problem, not an organic one', () => {
    assert.match(P.paid, /hurt Quality Score/);
  });
});

// ─── Variant isolation ────────────────────────────────────────────────────────

describe('the three plans cannot overwrite each other', () => {
  const cacheKey = new Function(
    `${src.slice(src.indexOf('const actionPlanCacheKey'), src.indexOf('\n', src.indexOf('const actionPlanCacheKey')))}
     return actionPlanCacheKey;`
  )();

  test('cache keys carry the variant', () => {
    assert.equal(cacheKey('seo', 'https://x.com/a'), 'seo::https://x.com/a');
  });

  test('the same URL yields three different keys', () => {
    const url = 'https://x.com/a';
    const keys = ['overview', 'seo', 'paid'].map(v => cacheKey(v, url));
    assert.equal(new Set(keys).size, 3, 'two variants would share a cache entry');
  });

  test('the fragment is still stripped, as it was before variants existed', () => {
    assert.equal(cacheKey('seo', 'https://x.com/a#top'), 'seo::https://x.com/a');
  });

  test('state is per-variant, not a single shared plan object', () => {
    assert.match(src, /_apState\[v\] = \{ plan: null/);
    // The old single globals must be gone, or something is still shared.
    assert.doesNotMatch(src, /^let _actionPlanLoading/m);
    assert.doesNotMatch(src, /^let _actionPlanError/m);
  });

  test('the cache is re-read before writing, so a concurrent variant is not clobbered', () => {
    // Two panels can be generating at once; the second writer must not persist
    // a snapshot taken before the first one finished.
    const write = src.slice(src.indexOf('const { actionPlanCache: fresh }'), src.indexOf('browser.storage.local.set({ actionPlanCache: out })'));
    assert.match(write, /storage\.local\.get\('actionPlanCache'\)/);
  });

  test('the cap scales with the number of variants', () => {
    const cap = Number(/ACTION_PLAN_CACHE_CAP = (\d+)/.exec(src)[1]);
    assert.equal(cap, 60, 'three variants × the 20 pages the old cap allowed');
  });
});

// ─── Cache-only enrichment must never spend anything ──────────────────────────

describe('the technical signals are opportunistic only', () => {
  test('all three extra reads pass cacheOnly', () => {
    const gather = src.slice(src.indexOf('const [psi, audit, backlinks]'), src.indexOf('return { gsc, ads, webceo'));
    ['psiGetPageSpeed', 'webceoGetSiteAudit', 'webceoGetBacklinks'].forEach(action => {
      const line = gather.split('\n').find(l => l.includes(action));
      assert.ok(line, `${action} is not in the gather`);
      assert.match(line, /cacheOnly: true/, `${action} could trigger a live fetch when a plan is generated`);
    });
  });

  test('the two Web CEO handlers actually honour the flag', () => {
    ['webceoGetSiteAudit', 'webceoGetBacklinks'].forEach(fn => {
      const body = webceo.slice(webceo.indexOf(`async function ${fn}(`));
      const sig = body.slice(0, body.indexOf(')'));
      assert.match(sig, /cacheOnly = false/, `${fn} does not accept cacheOnly`);
      const beforeCall = body.slice(0, body.indexOf('await webceoCall('));
      assert.match(beforeCall, /if \(cacheOnly\) return/, `${fn} checks cacheOnly too late to prevent the call`);
    });
  });

  test('a missing signal degrades to silence, never to a claim of zero', () => {
    // "not fetched" and "genuinely zero" are different facts; reporting the
    // wrong one produces a confidently wrong recommendation.
    const fn = src.slice(src.indexOf('function actionPlanTechLines'), src.indexOf('function actionPlanContext'));
    assert.match(fn, /!psi\.notCached/);
    assert.match(fn, /!audit\.notCached/);
    assert.match(fn, /!bl\.notCached/);
  });
});

// ─── UI wiring ────────────────────────────────────────────────────────────────

describe('the three nav rows', () => {
  test('each tab has its own row', () => {
    ['btn-actionplan', 'btn-gsc-actionplan', 'btn-ads-actionplan'].forEach(id => {
      assert.ok(html.includes(`id="${id}"`), `${id} is missing from popup.html`);
    });
  });

  test('each row has its own status element', () => {
    ['actionplan-status', 'gsc-actionplan-status', 'ads-actionplan-status'].forEach(id => {
      assert.ok(html.includes(`id="${id}"`), `${id} is missing from popup.html`);
    });
  });

  test('the labels distinguish the three', () => {
    assert.ok(html.includes('>SEO ACTION PLAN<'));
    assert.ok(html.includes('>PAID ACTION PLAN<'));
  });

  test('the Search row lives on the Search tab, not somewhere else', () => {
    const tab = html.slice(html.indexOf('<div id="search-tab"'), html.indexOf('<div id="analytics-tab"'));
    assert.ok(tab.includes('btn-gsc-actionplan'), 'the SEO row is outside #search-tab');
  });

  test('each row opens its own variant', () => {
    assert.match(nav, /btn-actionplan'\)\.addEventListener\('click', \(\) => showActionPlanPanel\('overview'\)\)/);
    assert.match(nav, /btn-gsc-actionplan'\)\.addEventListener\('click', \(\) => showActionPlanPanel\('seo'\)\)/);
    assert.match(nav, /btn-ads-actionplan'\)\.addEventListener\('click', \(\) => showActionPlanPanel\('paid'\)\)/);
  });

  test('a row lights up only for its own plan', () => {
    const fn = src.slice(src.indexOf('function refreshActionPlanNav'));
    assert.match(fn, /_apState\[v\]\.plan/, 'the counts are not read per-variant');
  });

  test('hydration restores all three independently', () => {
    const fn = src.slice(src.indexOf('async function hydrateActionPlanNav'), src.indexOf('// ─── Rendering'));
    assert.match(fn, /ACTION_PLAN_VARIANTS\.forEach/);
  });
});

describe('the shared panel', () => {
  test('the title element exists and is retitled per variant', () => {
    assert.ok(html.includes('id="actionplan-title"'));
    assert.match(src, /getElementById\('actionplan-title'\)/);
  });

  test('an unknown variant falls back to overview rather than blanking the panel', () => {
    const fn = src.slice(src.indexOf('function setActionPlanVariant'));
    assert.match(fn, /ACTION_PLAN_VARIANTS\.includes\(variant\) \? variant : 'overview'/);
  });

  test('refresh regenerates the variant on screen, not always the Overview one', () => {
    assert.match(src, /loadActionPlan\(true, _apVariant\)/);
  });

  test('the channel tag is hidden on the specialized plans', () => {
    // Every card on the SEO plan would read "SEO" — pure noise.
    assert.match(src, /actionPlanRecCard\(r, _apVariant === 'overview'\)/);
    assert.match(src, /function actionPlanRecCard\(rec, showChannel = true\)/);
  });
});

describe('exports are distinguishable', () => {
  test('the RTF filename carries the variant', () => {
    assert.match(src, /action-plan-\$\{meta\.slug\}-\$\{host\}\.rtf/);
  });

  test('the RTF heading names the variant', () => {
    assert.match(src, /rtfEscape\(meta\.title\)/);
  });

  test('the Google Doc title carries the variant', () => {
    assert.match(src, /planTitle: ACTION_PLAN_META\[_apVariant\]\.title/);
    assert.match(exportSrc, /\$\{planTitle \|\| 'Action Plan'\} For/);
  });

  test('an older caller with no planTitle still produces the original title', () => {
    // Guards the cached-plan path and anything that predates variants.
    const fn = exportSrc.slice(exportSrc.indexOf('async function docsExportActionPlan'));
    assert.match(fn, /planTitle \|\| 'Action Plan'/);
  });

  test('the three slugs are unique', () => {
    const slugs = [...src.matchAll(/slug: '(\w+)'/g)].map(m => m[1]);
    assert.equal(slugs.length, 3);
    assert.equal(new Set(slugs).size, 3);
  });
});

// ─── The contract is enforced, not merely requested ───────────────────────────

describe('a variant contract survives a prompt the model ignored', () => {
  // Models follow negative instructions ("do NOT include eeat") unreliably.
  // Both leaks below are user-visible — the E-E-A-T block renders, and the
  // channel is printed as text into the RTF and Google Doc exports.
  const applyVariantContract = new Function(
    `${src.slice(src.indexOf('function applyVariantContract'), src.indexOf('function normalizeActionPlan'))}
     return applyVariantContract;`
  )();

  const plan = () => ({
    recommendations: [
      { change: 'a', evidence: 'e', effort: 'surgical', impact: 'high', channel: 'paid' },
      { change: 'b', evidence: 'e', effort: 'moderate', impact: 'low', channel: 'both' }
    ],
    contentGaps: ['x'],
    eeat: { score: 'weak', signals: [], gaps: [] }
  });

  test('the SEO plan forces every recommendation to channel seo', () => {
    const out = applyVariantContract(plan(), 'seo');
    assert.deepEqual(out.recommendations.map(r => r.channel), ['seo', 'seo']);
  });

  test('the Paid plan forces every recommendation to channel paid', () => {
    const out = applyVariantContract(plan(), 'paid');
    assert.deepEqual(out.recommendations.map(r => r.channel), ['paid', 'paid']);
  });

  test('a stray E-E-A-T block is stripped from the Paid plan', () => {
    assert.ok(!('eeat' in applyVariantContract(plan(), 'paid')));
  });

  test('the SEO plan keeps its E-E-A-T block', () => {
    assert.ok(applyVariantContract(plan(), 'seo').eeat);
  });

  test('the Overview plan is passed through completely untouched', () => {
    // Its mixed seo/paid/both channels are the whole point of that variant.
    const out = applyVariantContract(plan(), 'overview');
    assert.deepEqual(out.recommendations.map(r => r.channel), ['paid', 'both']);
    assert.ok(out.eeat);
  });

  test('a null plan stays null rather than throwing', () => {
    assert.equal(applyVariantContract(null, 'paid'), null);
  });

  test('it runs before the plan is cached or exported', () => {
    // Enforcing at render time would leave the cache and the exports wrong.
    assert.match(src, /const plan = applyVariantContract\(normalizeActionPlan\(/);
  });
});

// ─── The existing-negatives read ──────────────────────────────────────────────

describe('the Paid plan knows which negatives already exist', () => {
  const fn = ads.slice(ads.indexOf('async function adsGetNegatives('), ads.indexOf('// Every enabled ad group in the resolved account'));

  test('all three places a negative can live are read', () => {
    // Reading only one resource would still produce wrong advice: a term
    // excluded via a shared list is invisible in campaign_criterion.
    ['campaign_criterion', 'ad_group_criterion', 'shared_criterion'].forEach(r =>
      assert.match(fn, new RegExp(`FROM ${r}\\b`), `${r} is not queried`));
  });

  test('only negative keyword criteria are pulled, not every criterion', () => {
    assert.match(fn, /campaign_criterion\.negative = TRUE AND campaign_criterion\.type = 'KEYWORD'/);
    assert.match(fn, /ad_group_criterion\.negative = TRUE AND ad_group_criterion\.type = 'KEYWORD'/);
  });

  test('shared sets are resolved from the page\'s campaigns, not the whole account', () => {
    assert.match(fn, /FROM campaign_shared_set[\s\S]*?WHERE campaign\.id IN/);
    assert.match(fn, /shared_set\.type = 'NEGATIVE_KEYWORDS'/);
  });

  test('identity is text + match type, matching the write path', () => {
    // The same term at a different match type is a different exclusion, so
    // collapsing on text alone would suppress a legitimate recommendation.
    assert.match(fn, /const key = `\$\{t\.toLowerCase\(\)\}::\$\{mt\}`/);
    const write = ads.slice(ads.indexOf('async function adsAddNegativesForCampaign('));
    assert.match(write.slice(0, 4000), /toLowerCase\(\)\}::\$\{/, 'the write path keys differently');
  });

  test('an account with nothing to look up costs no queries at all', () => {
    assert.match(fn, /if \(!camps\.length && !ags\.length\) return \{ connected: true, negatives: \[\] \}/);
  });

  test('a failed sub-query degrades to fewer negatives, never a failed plan', () => {
    // adsSearch never throws, so an unsupported field yields empty rows.
    assert.match(fn, /if \(!setsRes\.error\)/);
    assert.match(fn, /best-effort/i);
  });

  test('it is routed', () => {
    assert.match(router, /case 'adsGetNegatives':\s*return adsGetNegatives\(message\)/);
  });

  test('it is only fetched when Ads actually serves this page', () => {
    // No point spending queries on a page with no ads pointing at it.
    const gather = src.slice(src.indexOf('let adAssets = null;'), src.indexOf('// What the copy actually says'));
    assert.match(gather, /if \(ads && ads\.connected && Array\.isArray\(ads\.ads\) && ads\.ads\.length\)/);
    assert.match(gather, /action: 'adsGetNegatives'/);
  });

  test('it runs in parallel with the RSA asset read, not after it', () => {
    const gather = src.slice(src.indexOf('let adAssets = null;'), src.indexOf('// What the copy actually says'));
    assert.match(gather, /\[adAssets, negatives\] = await Promise\.all\(/);
  });

  test('it is scoped to this page\'s campaigns and ad groups', () => {
    const gather = src.slice(src.indexOf('let adAssets = null;'), src.indexOf('// What the copy actually says'));
    assert.match(gather, /campaignIds: \[\.\.\.new Set\(ads\.ads\.map\(a => a\.campaignId\)/);
    assert.match(gather, /adGroupIds:\s+\[\.\.\.new Set\(ads\.ads\.map\(a => a\.adGroupId\)/);
  });

  test('the prompt block names them and forbids duplicates', () => {
    const ctx = src.slice(src.indexOf('const negs = (g.negatives'), src.indexOf('if (lowQs.length) {'));
    assert.match(ctx, /ALREADY in place/);
    assert.match(ctx, /do NOT recommend adding any of these again/);
  });

  test('"none" is stated explicitly rather than left silent', () => {
    // Silence is indistinguishable from "could not read", and the model hedges.
    const ctx = src.slice(src.indexOf('const negs = (g.negatives'), src.indexOf('if (lowQs.length) {'));
    assert.match(ctx, /none\. Every negative below would be new/);
  });

  test('an unreadable negatives result says nothing at all', () => {
    // Neither a list nor a "none" claim — the plan must not assert either way.
    const ctx = src.slice(src.indexOf('const negs = (g.negatives'), src.indexOf('if (lowQs.length) {'));
    assert.match(ctx, /g\.negatives\.connected && !g\.negatives\.error/);
  });

  test('the list is capped, with the overflow counted rather than dropped silently', () => {
    const ctx = src.slice(src.indexOf('const negs = (g.negatives'), src.indexOf('if (lowQs.length) {'));
    assert.match(ctx, /negs\.slice\(0, 60\)/);
    assert.match(ctx, /more already excluded/);
  });

  test('the Paid prompt tells the model to check the list before proposing one', () => {
    assert.match(P.paid, /CHECK the "Negative keywords ALREADY in place" list first/);
  });

  test('an already-excluded term that still costs money is framed as the finding', () => {
    // Otherwise the model just goes quiet about a real problem.
    assert.match(P.paid, /that is itself the finding/);
  });

  test('the ADS block still renders when negatives are the only Ads signal', () => {
    assert.match(src, /weakAds\.length \|\| negCount\)/);
  });
});

// ─── Craft rules, from real output review ─────────────────────────────────────

describe('corrections drawn from a reviewed plan', () => {
  test('the meta description is stated not to be a ranking input', () => {
    // A shipped plan recommended putting "residential architects near me" in
    // the meta description to rank. It is a click-through lever only.
    [P.overview, P.seo].forEach(p => {
      assert.match(p, /meta description is NOT a ranking input/);
      assert.match(p, /keyword placement for RANKING in the title tag, an H1\/H2, or body copy/);
    });
  });

  test('city names are preferred over near-me phrasing in reader-facing text', () => {
    [P.overview, P.seo].forEach(p => assert.match(p, /Prefer a real city or place name over "near me"/));
  });

  test('"near you" is named as the correct form if proximity phrasing is used', () => {
    [P.overview, P.seo].forEach(p => assert.match(p, /"near you" reads correctly to a human/));
  });

  test('a homepage is told to link down rather than absorb services', () => {
    // The reviewed plan proposed covering basement finishing, sunrooms, ADUs
    // and extensions all on one homepage.
    [P.overview, P.seo].forEach(p => {
      assert.match(p, /A homepage should target its primary term and LINK DOWN to service pages/);
      assert.match(p, /Distinct services deserve their own pages/);
    });
  });

  test('the model is told the CTR comparison is already done for it', () => {
    [P.overview, P.seo].forEach(p => {
      assert.match(p, /Never infer a title\/meta problem from a raw CTR number/);
      assert.match(p, /at position 13 a 1% CTR is normal/);
    });
  });

  test('they are scoped to Overview and SEO, not Paid', () => {
    // Paid recommends ad copy, not snippets; these are organic craft rules.
    assert.doesNotMatch(P.paid, /meta description is NOT a ranking input/);
    assert.doesNotMatch(P.paid, /LINK DOWN to service pages/);
  });

  test('they live in one place, so the two prompts cannot drift', () => {
    assert.match(src, /const ACTION_PLAN_CRAFT_RULES = /);
    assert.equal((src.match(/\$\{ACTION_PLAN_CRAFT_RULES\}/g) || []).length, 2);
  });

  test('the shared JSON contract does not carry them', () => {
    // It is shared with the Paid prompt, and is declared before the rules.
    const jc = src.slice(src.indexOf('const ACTION_PLAN_JSON_CONTRACT = '));
    assert.doesNotMatch(jc.slice(0, 900), /ACTION_PLAN_CRAFT_RULES/);
  });
});
