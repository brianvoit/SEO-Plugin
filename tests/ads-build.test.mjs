// Tests "build ads for this page" — the write path that creates an ad group,
// a responsive search ad and keywords under an existing campaign.
//
// This is the only feature that CREATES spending structure in a live Google
// Ads account, so the tests are weighted toward the things that would be
// expensive to get wrong: that nothing is ever created enabled, that a
// half-written ad group is impossible, that assets Google would reject are
// caught before the request leaves, and that campaigns which cannot hold a
// keyword-targeted ad group are never offered.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { backgroundSource } from './helpers.mjs';

const src = await backgroundSource();

/** Values built inside the vm carry that realm's prototypes. */
const plain = (v) => JSON.parse(JSON.stringify(v));

/**
 * Boots the background with a fake Ads API.
 *
 * `searchRows` answers GAQL queries; `onMutate` receives every googleAds:mutate
 * body so a test can assert on exactly what would have been written.
 */
function boot({ searchRows = [], onMutate = null, mutateFails = null } = {}) {
  const mutateCalls = [];
  const store = {
    adsAuth: { accessToken: 't', expiresAt: Date.now() + 3600e3, refreshToken: 'r' },
    adsDeveloperToken: 'dev',
    adsAccountOverrides: { 'example.com': '123-456-7890' }
  };

  const area = (obj) => ({
    get: async (keys) => {
      if (keys == null) return { ...obj };
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.map(k => [k, obj[k]]));
    },
    set: async (patch) => { Object.assign(obj, patch); },
    remove: async () => {}
  });

  const fetchImpl = async (url, opts = {}) => {
    const body = JSON.parse(opts.body || '{}');
    if (String(url).includes('googleAds:mutate')) {
      mutateCalls.push(body);
      if (onMutate) onMutate(body);
      if (mutateFails) {
        return { ok: false, status: 400, json: async () => mutateFails, text: async () => '' };
      }
      return {
        ok: true, status: 200,
        json: async () => ({
          mutateOperationResponses: [
            { adGroupResult: { resourceName: 'customers/1234567890/adGroups/555' } },
            { adGroupAdResult: { resourceName: 'customers/1234567890/adGroupAds/555~1' } }
          ]
        })
      };
    }
    // searchStream
    return {
      ok: true, status: 200,
      json: async () => [{ results: searchRows }],
      text: async () => ''
    };
  };

  const real = {
    storage: { local: area(store), sync: area({}), session: area({}), onChanged: { addListener() {} } },
    runtime: {
      onMessage: { addListener() {} }, onInstalled: { addListener() {} },
      getURL: () => 'moz-extension://test/', sendMessage: () => Promise.resolve({})
    }
  };
  const auto = () => new Proxy(() => {}, { get: () => auto(), apply: () => Promise.resolve({}) });

  const ctx = {
    console, URL, URLSearchParams, Date, Math, JSON, RegExp, String, Object, Array, Set, Number,
    setTimeout, clearTimeout, setInterval, clearInterval, Promise, Boolean,
    crypto: globalThis.crypto, TextEncoder, btoa: globalThis.btoa, atob: globalThis.atob,
    fetch: fetchImpl,
    browser: new Proxy(real, { get: (t, p) => (p in t ? t[p] : auto()) })
  };
  vm.createContext(ctx);
  vm.runInContext(`${src}
;globalThis.__x = { adsCreateAdGroup, adsListCampaignsForBuild, rsaAssets, RSA_LIMITS };`, ctx);
  return { ...ctx.__x, mutateCalls };
}

/** A valid request, so each test can vary one thing. */
const validRequest = (over = {}) => ({
  pageUrl: 'https://example.com/services/roofing',
  campaignId: '99',
  adGroupName: 'Roofing — Services',
  headlines: ['Roof Repair Experts', 'Free Roofing Quote', 'Local Roofers Near You'],
  descriptions: ['Fast, tidy roof repairs from a local team.', 'Book a free roofing survey this week.'],
  keywords: [{ text: 'roof repair', matchType: 'PHRASE' }],
  ...over
});

const opsOf = (body) => body.mutateOperations;

describe('nothing starts spending', () => {
  test('the ad group is created paused', async () => {
    const b = boot();
    await b.adsCreateAdGroup(validRequest());
    const create = opsOf(b.mutateCalls[0])[0].adGroupOperation.create;
    assert.equal(create.status, 'PAUSED', 'a new ad group must never be created enabled');
  });

  test('the ad is created paused', async () => {
    const b = boot();
    await b.adsCreateAdGroup(validRequest());
    const ad = opsOf(b.mutateCalls[0])[1].adGroupAdOperation.create;
    assert.equal(ad.status, 'PAUSED', 'a new ad must never be created enabled');
  });
});

describe('the write is atomic', () => {
  test('ad group, ad and keywords go in ONE request', async () => {
    const b = boot();
    await b.adsCreateAdGroup(validRequest({
      keywords: [{ text: 'roof repair', matchType: 'PHRASE' }, { text: 'roofers', matchType: 'PHRASE' }]
    }));
    assert.equal(b.mutateCalls.length, 1, 'split across requests — a partial failure could strand an ad group');
    const ops = opsOf(b.mutateCalls[0]);
    assert.equal(ops.length, 4, 'expected ad group + ad + 2 keywords');
  });

  test('partialFailure is off', async () => {
    // With partial failure on, a rejected keyword would leave the ad group
    // created and the caller believing the whole thing succeeded.
    const b = boot();
    await b.adsCreateAdGroup(validRequest());
    assert.equal(b.mutateCalls[0].partialFailure, false);
  });

  test('keywords reference the ad group by temporary id', async () => {
    const b = boot();
    await b.adsCreateAdGroup(validRequest());
    const ops = opsOf(b.mutateCalls[0]);
    const tempName = ops[0].adGroupOperation.create.resourceName;
    assert.match(tempName, /adGroups\/-\d+$/, 'expected a negative temp resource id');
    assert.equal(ops[1].adGroupAdOperation.create.adGroup, tempName);
    assert.equal(ops[3 - 1].adGroupCriterionOperation.create.adGroup, tempName);
  });
});

describe('dry run', () => {
  test('validateOnly is forwarded and reports without creating', async () => {
    const b = boot();
    const res = await b.adsCreateAdGroup(validRequest({ validateOnly: true }));
    assert.equal(b.mutateCalls[0].validateOnly, true);
    assert.equal(res.validated, true);
    assert.ok(!res.created, 'a dry run must not report a creation');
  });

  test('the dry run sends the same operations as the real write', async () => {
    // If these could differ, the preview would be a lie.
    const dry = boot();
    await dry.adsCreateAdGroup(validRequest({ validateOnly: true }));
    const real = boot();
    await real.adsCreateAdGroup(validRequest());
    assert.deepEqual(plain(opsOf(dry.mutateCalls[0])), plain(opsOf(real.mutateCalls[0])));
  });
});

describe('asset validation happens before the request', () => {
  const rejects = async (over, matching) => {
    const b = boot();
    const res = await b.adsCreateAdGroup(validRequest(over));
    assert.equal(res.error, 'INVALID', `expected rejection, got ${JSON.stringify(res)}`);
    assert.match(res.detail, matching);
    assert.equal(b.mutateCalls.length, 0, 'invalid input still reached the API');
  };

  test('a headline over 30 characters', () =>
    rejects({ headlines: ['ok one', 'ok two', 'x'.repeat(31)] }, /over 30 characters/));

  test('a description over 90 characters', () =>
    rejects({ descriptions: ['fine one', 'y'.repeat(91)] }, /over 90 characters/));

  test('fewer than 3 headlines', () =>
    rejects({ headlines: ['only one', 'only two'] }, /at least 3 headlines/));

  test('fewer than 2 descriptions', () =>
    rejects({ descriptions: ['just the one'] }, /at least 2 descriptions/));

  test('a non-http final URL', () =>
    rejects({ pageUrl: 'chrome://settings', finalUrl: '' }, /http\(s\) final URL/));

  test('a blank ad group name', () =>
    rejects({ adGroupName: '   ' }, /name is required/));
});

describe('asset hygiene', () => {
  test('duplicate headlines are dropped, not sent', async () => {
    // Google rejects an RSA carrying duplicate assets.
    const b = boot();
    await b.adsCreateAdGroup(validRequest({
      headlines: ['Roof Repair', 'roof repair', 'Free Quote', 'Local Roofers']
    }));
    const rsa = opsOf(b.mutateCalls[0])[1].adGroupAdOperation.create.ad.responsiveSearchAd;
    assert.equal(rsa.headlines.length, 3, 'case-insensitive duplicate survived');
  });

  test('headlines are capped at 15', () => {
    const b = boot();
    const many = Array.from({ length: 25 }, (_, i) => `Headline number ${i}`);
    const out = b.rsaAssets(many, 'headline');
    assert.equal(out.ok, true);
    assert.equal(out.assets.length, 15);
  });

  test('descriptions are capped at 4', () => {
    const b = boot();
    const many = Array.from({ length: 9 }, (_, i) => `Description number ${i}`);
    const out = b.rsaAssets(many, 'description');
    assert.equal(out.assets.length, 4);
  });

  test('duplicate keywords are collapsed', async () => {
    const b = boot();
    await b.adsCreateAdGroup(validRequest({
      keywords: [
        { text: 'roof repair', matchType: 'PHRASE' },
        { text: 'Roof Repair', matchType: 'PHRASE' },   // same term, same match type
        { text: 'roof repair', matchType: 'EXACT' }     // different match type — keep
      ]
    }));
    const kws = opsOf(b.mutateCalls[0]).filter(o => o.adGroupCriterionOperation);
    assert.equal(kws.length, 2);
  });
});

describe('bidding', () => {
  test('a CPC bid is sent when supplied', async () => {
    const b = boot();
    await b.adsCreateAdGroup(validRequest({ cpcBidMicros: 1500000 }));
    assert.equal(opsOf(b.mutateCalls[0])[0].adGroupOperation.create.cpcBidMicros, '1500000');
  });

  test('no bid field at all when none is supplied', async () => {
    // Sending a bid under an automated strategy is either ignored or rejected.
    const b = boot();
    await b.adsCreateAdGroup(validRequest());
    assert.ok(!('cpcBidMicros' in opsOf(b.mutateCalls[0])[0].adGroupOperation.create));
  });
});

describe('campaign eligibility', () => {
  const campaign = (id, name, channel, bidding = 'MANUAL_CPC') => ({
    campaign: { id, name, status: 'ENABLED', advertisingChannelType: channel, biddingStrategyType: bidding },
    campaignBudget: { amountMicros: '20000000', period: 'DAILY' }
  });

  test('only Search campaigns are offered', async () => {
    const b = boot({ searchRows: [
      campaign('1', 'Brand Search', 'SEARCH'),
      campaign('2', 'PMax Retail', 'PERFORMANCE_MAX'),
      campaign('3', 'Display Remarketing', 'DISPLAY'),
      campaign('4', 'Shopping Feed', 'SHOPPING')
    ] });
    const res = await b.adsListCampaignsForBuild({ pageUrl: 'https://example.com/x' });
    assert.deepEqual(plain(res.eligible.map(c => c.campaignName)), ['Brand Search']);
  });

  test('ineligible campaigns are returned with a readable reason', async () => {
    // An empty picker with no explanation reads as a bug; "your only campaign
    // is Performance Max" is actionable.
    const b = boot({ searchRows: [campaign('2', 'PMax Retail', 'PERFORMANCE_MAX')] });
    const res = await b.adsListCampaignsForBuild({ pageUrl: 'https://example.com/x' });
    assert.equal(res.eligible.length, 0);
    assert.equal(res.excluded.length, 1);
    assert.equal(res.excluded[0].channelLabel, 'Performance Max');
  });

  test('acceptsCpcBid tracks the bidding strategy', async () => {
    const b = boot({ searchRows: [
      campaign('1', 'Manual', 'SEARCH', 'MANUAL_CPC'),
      campaign('2', 'Automated', 'SEARCH', 'MAXIMIZE_CONVERSIONS')
    ] });
    const res = await b.adsListCampaignsForBuild({ pageUrl: 'https://example.com/x' });
    const byName = Object.fromEntries(res.eligible.map(c => [c.campaignName, c.acceptsCpcBid]));
    assert.equal(byName.Manual, true);
    assert.equal(byName.Automated, false, 'an ad-group CPC bid is ignored under an automated strategy');
  });
});

describe('failure reporting', () => {
  test('a rejected write surfaces Google\'s specific message, not the generic one', async () => {
    // error.message is always "Request contains an invalid argument."; the
    // useful text is in error.details[].
    const b = boot({ mutateFails: {
      error: {
        message: 'Request contains an invalid argument.',
        details: [{ errors: [{ errorCode: { adGroupError: 'DUPLICATE_ADGROUP_NAME' }, message: 'Ad group name already exists.' }] }]
      }
    } });
    const res = await b.adsCreateAdGroup(validRequest());
    assert.equal(res.error, 'API_ERROR');
    assert.match(res.detail, /DUPLICATE_ADGROUP_NAME|already exists/);
  });

  test('the new ad group id comes back for deep-linking', async () => {
    const b = boot();
    const res = await b.adsCreateAdGroup(validRequest());
    assert.equal(res.created, true);
    assert.equal(res.adGroupId, '555');
  });
});

// ─── Keyword ranking (popup-adsbuild.js) ─────────────────────────────────────
// Pure scoring, sliced out of the panel the same way the background tests
// slice bg-core. This decides what a user sees pre-checked against their own
// ad spend, so the ordering rules are worth pinning.

import { readFile } from 'node:fs/promises';
import { ROOT } from './helpers.mjs';

const panelSrc = await readFile(`${ROOT}/popup-adsbuild.js`, 'utf8');

function loadRanker() {
  // Spans abCoreTerms, abOnSubject and abRankKeywords — the subject gate is
  // part of ranking now, so slicing the ranker alone would leave it undefined.
  const from = panelSrc.indexOf('function abCoreTerms');
  const to = panelSrc.indexOf('async function abRefineKeywords');
  if (from === -1 || to <= from) throw new Error('ranker block not found — update the slice markers');
  const stop = panelSrc.slice(panelSrc.indexOf('const AB_STOPWORDS'), panelSrc.indexOf('/**\n * Candidate keyword phrases'));
  const ctx = {
    AB_CANDIDATE_CAP: 60, AB_MIN_KEYWORDS: 5, AB_MAX_KEYWORDS: 15,
    Math, Number, Object, Array, String, Set, Map
  };
  vm.createContext(ctx);
  vm.runInContext(`${stop}\n${panelSrc.slice(from, to)}
    ; globalThis.__r = abRankKeywords; globalThis.__core = abCoreTerms;`, ctx);
  return ctx.__r;
}

function loadCoreTerms() {
  const from = panelSrc.indexOf('function abCoreTerms');
  const to = panelSrc.indexOf('async function abRefineKeywords');
  const stop = panelSrc.slice(panelSrc.indexOf('const AB_STOPWORDS'), panelSrc.indexOf('/**\n * Candidate keyword phrases'));
  const ctx = {
    AB_CANDIDATE_CAP: 60, AB_MIN_KEYWORDS: 5, AB_MAX_KEYWORDS: 15,
    Math, Number, Object, Array, String, Set, Map
  };
  vm.createContext(ctx);
  vm.runInContext(`${stop}\n${panelSrc.slice(from, to)}
    ; globalThis.__c = { abCoreTerms, abOnSubject };`, ctx);
  return ctx.__c;
}

describe('keyword ranking', () => {
  const rank = loadRanker();

  test('shorter terms outrank longer ones at equal volume', () => {
    // A two-word phrase-match keyword catches the long tail beneath it; a
    // five-word one matches almost nothing on its own.
    const out = rank(
      ['roof repair', 'emergency roof repair near me today'],
      { 'roof repair': { avgMonthlySearches: 1000 },
        'emergency roof repair near me today': { avgMonthlySearches: 1000 } },
      new Map()
    );
    assert.equal(out[0].text, 'roof repair');
  });

  test('volume dominates the ordering', () => {
    const out = rank(
      ['tiny term', 'big term'],
      { 'tiny term': { avgMonthlySearches: 10 }, 'big term': { avgMonthlySearches: 9000 } },
      new Map()
    );
    assert.equal(out[0].text, 'big term');
  });

  test('already-targeted terms are removed entirely', () => {
    // These are dropped rather than listed: in practice they were most of the
    // list and drowned the candidates that were actually actionable.
    const out = rank(
      ['already used', 'brand new'],
      { 'already used': { avgMonthlySearches: 9000 }, 'brand new': { avgMonthlySearches: 5 } },
      new Map([['already used', 'Brand — Roofing']])
    );
    assert.deepEqual(plain(out.map(k => k.text)), ['brand new']);
  });

  test('a list of only already-targeted terms comes back empty', () => {
    const out = rank(['already used'], {}, new Map([['already used', 'Brand — Roofing']]));
    assert.equal(out.length, 0);
  });

  test('everything defaults to phrase match', () => {
    const out = rank(['roof repair', 'roofers near me'], {}, new Map());
    assert.ok(out.every(k => k.matchType === 'PHRASE'));
  });

  test('nothing is pre-selected', () => {
    // This writes keywords into a live account, so every one should be a
    // deliberate choice. The regex filter narrows the list; Select all acts on
    // what survives it.
    const out = rank(
      ['measured term', 'unmeasured term', 'dead term'],
      { 'measured term': { avgMonthlySearches: 5000 }, 'dead term': { avgMonthlySearches: 0 } },
      new Map()
    );
    assert.ok(out.length >= 3);
    assert.ok(out.every(k => k.include === false), 'a keyword started pre-selected');
  });

  test('zero-volume terms are still offered', () => {
    // Keyword Planner measuring zero is worth showing — the user may know
    // better than the tool does about a new or niche term.
    const out = rank(['dead term'], { 'dead term': { avgMonthlySearches: 0 } }, new Map());
    assert.equal(out.length, 1);
  });

  test('the candidate list is capped before refinement', () => {
    // The ranker feeds the relevance pass, which cuts it to at most 15.
    const many = Array.from({ length: 120 }, (_, i) => `term number ${i}`);
    assert.equal(rank(many, {}, new Map()).length, 60);
  });
});

// ─── Page resolution ─────────────────────────────────────────────────────────
// Regression cover for a shipped bug: the panel required the global `pageData`,
// which only the OVERVIEW tab populates. Opening the Ads tab directly — the
// exact path this feature exists for — left it null, so the button answered
// "Open this on a regular web page" on a perfectly ordinary page with a linked
// Ads account.

function loadResolver({ pageData = null, tab = null, fetched = null } = {}) {
  const from = panelSrc.indexOf('async function abResolvePage');
  const to = panelSrc.indexOf('async function openAdsBuildPanel');
  if (from === -1 || to <= from) throw new Error('abResolvePage not found — update the slice markers');
  const ctx = {
    pageData,
    getActiveTab: async () => { if (!tab) throw new Error('no tab'); return tab; },
    getPageDataFromTab: async () => fetched,
    URL, Promise, Boolean
  };
  vm.createContext(ctx);
  vm.runInContext(`${panelSrc.slice(from, to)}; globalThis.__p = abResolvePage;`, ctx);
  return ctx.__p;
}

describe('page resolution', () => {
  test('falls back to the active tab when pageData is null', async () => {
    // The bug: Ads tab opened directly, Overview never ran.
    const resolve = loadResolver({ pageData: null, tab: { id: 1, url: 'https://example.com/services' } });
    const { url } = await resolve();
    assert.equal(url, 'https://example.com/services');
  });

  test('prefers the canonical URL when the Overview has run', async () => {
    // Matches how the rest of popup-ads.js resolves a page, so the builder and
    // the reporting it sits next to agree on which URL they mean.
    const resolve = loadResolver({
      pageData: { url: 'https://example.com/p?utm=x', canonical: 'https://example.com/p' },
      tab: { id: 1, url: 'https://example.com/p?utm=x' }
    });
    const { url } = await resolve();
    assert.equal(url, 'https://example.com/p');
  });

  test('fetches page content for naming when pageData is absent', async () => {
    const resolve = loadResolver({
      pageData: null,
      tab: { id: 1, url: 'https://example.com/x' },
      fetched: { title: 'Roofing Services', headings: [] }
    });
    const { info } = await resolve();
    assert.equal(info.title, 'Roofing Services');
  });

  test('still resolves a URL when the page cannot be read', async () => {
    // A page the content script can't reach still deserves an ad group; the
    // name just comes from the URL instead.
    const resolve = loadResolver({ pageData: null, tab: { id: 1, url: 'https://example.com/x' }, fetched: null });
    const { url, info } = await resolve();
    assert.equal(url, 'https://example.com/x');
    assert.equal(info, null);
  });

  test('returns no URL when there is no tab at all', async () => {
    const resolve = loadResolver({ pageData: null, tab: null });
    const { url } = await resolve();
    assert.equal(url, null);
  });
});

// ─── Page-text phrase mining ─────────────────────────────────────────────────
// The whole point of this feature is an ad group scoped to ONE page, so the
// page's own language is the primary keyword source. These pin the shape of
// what it will and will not offer.

function loadPhraser() {
  const from = panelSrc.indexOf('const AB_STOPWORDS');
  const to = panelSrc.indexOf('// Candidates come from the page itself first');
  if (from === -1 || to <= from) throw new Error('abPagePhrases not found — update the slice markers');
  const ctx = { Map, Set, String, Array, Math, Object };
  vm.createContext(ctx);
  vm.runInContext(`${panelSrc.slice(from, to)}; globalThis.__f = abPagePhrases;`, ctx);
  return ctx.__f;
}

describe('page phrase mining', () => {
  const phrases = loadPhraser();
  const textsOf = (out) => out.map(p => p.text);

  const page = {
    h1: 'Dead Tree Removal Services',
    title: 'Dead Tree Removal Minneapolis | Tree Top Climbers',
    metaDescription: 'We handle the safe removal of dead trees for homeowners.',
    headings: [{ level: 2, text: 'Emergency Tree Removal' }]
  };

  test('pulls multi-word phrases out of the page', () => {
    const out = textsOf(phrases(page));
    assert.ok(out.includes('dead tree removal'), out.slice(0, 10).join(' | '));
    assert.ok(out.includes('emergency tree removal'));
  });

  test('offers only two- and three-word phrases', () => {
    // One word is too broad to earn its own keyword; four or more matches
    // almost nothing under phrase match.
    for (const p of phrases(page)) {
      const n = p.text.split(' ').length;
      assert.ok(n >= 2 && n <= 3, `"${p.text}" has ${n} words`);
    }
  });

  test('the H1 outranks the meta description', () => {
    // An H1 states what the page is; a meta description is supporting prose.
    const out = phrases(page);
    const h1Phrase = out.find(p => p.text === 'dead tree removal');
    const metaPhrase = out.find(p => p.text === 'safe removal');
    if (metaPhrase) assert.ok(h1Phrase.pageScore > metaPhrase.pageScore);
    assert.ok(h1Phrase, 'expected the H1 phrase to be present');
  });

  test('phrases never start or end on a stopword', () => {
    for (const p of phrases({ h1: 'The removal of the dead trees' })) {
      const w = p.text.split(' ');
      assert.ok(!['the', 'of', 'and', 'for'].includes(w[0]), `"${p.text}" starts on a stopword`);
      assert.ok(!['the', 'of', 'and', 'for'].includes(w[w.length - 1]), `"${p.text}" ends on a stopword`);
    }
  });

  test('phrases do not run across punctuation', () => {
    // "minneapolis tree" would span the pipe in a title like
    // "… Minneapolis | Tree Top Climbers" and mean nothing.
    const out = textsOf(phrases({ title: 'Dead Tree Removal Minneapolis | Tree Top Climbers' }));
    assert.ok(!out.includes('minneapolis tree'), out.join(' | '));
  });

  test('a repeated phrase scores higher than a one-off', () => {
    const out = phrases({
      h1: 'Tree Removal',
      title: 'Tree Removal Services',
      headings: [{ level: 2, text: 'Tree Removal Costs' }]
    });
    const repeated = out.find(p => p.text === 'tree removal');
    const once = out.find(p => p.text === 'removal costs');
    assert.ok(repeated.pageScore > once.pageScore);
  });

  test('an empty page yields nothing rather than throwing', () => {
    assert.deepEqual(plain(phrases(null)), []);
    assert.deepEqual(plain(phrases({})), []);
  });
});

describe('page phrases feed the ranking', () => {
  const rank = loadRanker();

  test('a page phrase outranks an unrelated term with similar volume', () => {
    const out = rank(
      [{ text: 'dead tree removal', pageScore: 10, onPage: true },
       { text: 'lawn care', pageScore: 0, onPage: false }],
      { 'dead tree removal': { avgMonthlySearches: 500 }, 'lawn care': { avgMonthlySearches: 500 } },
      new Map()
    );
    assert.equal(out[0].text, 'dead tree removal');
  });

  test('page-derived terms are offered regardless of measured volume', () => {
    // A phrase the page itself leads with is worth showing even when Keyword
    // Planner has no figure, or a zero, for it.
    const out = rank(
      [{ text: 'measured dead', pageScore: 5, onPage: true },
       { text: 'unmeasured term', pageScore: 5, onPage: true }],
      { 'measured dead': { avgMonthlySearches: 0 } },
      new Map()
    );
    assert.equal(out.length, 2);
    assert.ok(out.every(k => k.include === false));
  });

  test('match type still defaults to phrase for page-derived terms', () => {
    const out = rank([{ text: 'dead tree removal', pageScore: 9, onPage: true }], {}, new Map());
    assert.equal(out[0].matchType, 'PHRASE');
  });
});

// ─── Real getPageData shapes ─────────────────────────────────────────────────
// Regression cover for a shipped bug: getPageData returns `title` and
// `metaDescription` as OBJECTS ({text, charCount, wordCount}) and tags headings
// with `tag: 'h1'`, not `level: 1`. Reading them as plain strings produced a
// literal "[object Object]" keyword — it reached the user's screen as
// "object object" at 9,900/mo — and skipped every heading.

describe('page mining against the real getPageData shape', () => {
  const phrases = loadPhraser();
  const realPage = {
    title: { text: 'Dead Tree Removal Services | Tree Top Climbers', charCount: 46, wordCount: 7 },
    metaDescription: { text: 'Expert dead tree removal in Minneapolis.', charCount: 39, wordCount: 6 },
    headings: [
      { tag: 'h1', text: 'Dead Tree Removal Services' },
      { tag: 'h2', text: 'Emergency Tree Removal' }
    ]
  };

  test('never emits a stringified object', () => {
    const out = phrases(realPage).map(p => p.text);
    assert.ok(!out.some(t => t.includes('object')), `leaked: ${out.filter(t => t.includes('object')).join(', ')}`);
  });

  test('reads the object-wrapped title', () => {
    const out = phrases({ title: { text: 'Dead Tree Removal Services' } }).map(p => p.text);
    assert.ok(out.includes('dead tree removal'), out.join(' | '));
  });

  test('reads the object-wrapped meta description', () => {
    const out = phrases({ metaDescription: { text: 'Emergency stump grinding available' } }).map(p => p.text);
    assert.ok(out.includes('emergency stump grinding'), out.join(' | '));
  });

  test('reads headings tagged h1/h2, not level 1/2', () => {
    const out = phrases({ headings: [{ tag: 'h2', text: 'Emergency Tree Removal' }] }).map(p => p.text);
    assert.ok(out.includes('emergency tree removal'), out.join(' | '));
  });

  test('an h1 still outweighs an h2', () => {
    const out = phrases({
      headings: [{ tag: 'h1', text: 'Dead Tree Removal' }, { tag: 'h2', text: 'Stump Grinding Service' }]
    });
    const h1 = out.find(p => p.text === 'dead tree removal');
    const h2 = out.find(p => p.text === 'stump grinding');
    assert.ok(h1.pageScore > h2.pageScore);
  });

  test('a plain-string page object still works', () => {
    // A caller assembling its own object should not have to mimic the wrapper.
    const out = phrases({ title: 'Dead Tree Removal', headings: [{ level: 2, text: 'Stump Grinding Service' }] })
      .map(p => p.text);
    assert.ok(out.includes('dead tree removal'));
    assert.ok(out.includes('stump grinding'));
  });
});

// ─── Keyword regex filter ────────────────────────────────────────────────────

function loadFilter() {
  const from = panelSrc.indexOf('function abKwVisible');
  const to = panelSrc.indexOf('function abRenderKeywordList');
  if (from === -1 || to <= from) throw new Error('abKwVisible not found — update the slice markers');
  return (filter, exclude) => {
    const ctx = { _abKwFilter: filter, _abKwFilterExclude: exclude, RegExp, String };
    vm.createContext(ctx);
    vm.runInContext(`${panelSrc.slice(from, to)}; globalThis.__v = abKwVisible;`, ctx);
    return ctx.__v;
  };
}

describe('keyword filter', () => {
  const make = loadFilter();
  const kws = [{ text: 'tree removal' }, { text: 'stump grinding' }, { text: 'tree trimming' }];
  const shown = (filter, exclude = false) => kws.filter(make(filter, exclude)).map(k => k.text);

  test('an empty filter shows everything', () => {
    assert.equal(shown('').length, 3);
  });

  test('matches as a regex, not a literal', () => {
    assert.deepEqual(plain(shown('removal|trimming')), ['tree removal', 'tree trimming']);
  });

  test('is case-insensitive', () => {
    assert.deepEqual(plain(shown('TREE')), ['tree removal', 'tree trimming']);
  });

  test('exclude mode inverts the match', () => {
    assert.deepEqual(plain(shown('tree', true)), ['stump grinding']);
  });

  test('an invalid regex filters nothing rather than blanking the list', () => {
    // Half-typed patterns are normal while someone is still typing.
    assert.equal(shown('tree(').length, 3);
  });
});

// ─── Subject relevance gate ──────────────────────────────────────────────────
// Regression cover for keywords that reached a user's screen: "just take" and
// "dont just" (mined from a "Don't just take our word for it" testimonials
// heading), "twin cities", and "take our word". None share a subject word with
// the page, and none describe the service being sold.

describe('subject gate', () => {
  const { abCoreTerms, abOnSubject } = loadCoreTerms();

  const page = {
    title: { text: 'Dead Tree Removal Services | Tree Top Climbers' },
    headings: [
      { tag: 'h1', text: 'Dead Tree Removal Services' },
      { tag: 'h2', text: "Don't just take our word for it" }
    ]
  };
  const core = abCoreTerms(page);
  const keeps = (t) => abOnSubject(t, core);

  test('the core terms come from the H1 and title only', () => {
    // A testimonials heading must not widen what counts as on-subject.
    assert.ok(core.has('tree'));
    assert.ok(core.has('removal'));
    assert.ok(!core.has('word'), [...core].join(', '));
    assert.ok(!core.has('take'), [...core].join(', '));
  });

  test('rejects the fragments that actually shipped', () => {
    for (const bad of ['just take', 'dont just', 'take our word', 'twin cities']) {
      assert.equal(keeps(bad), false, `"${bad}" should not be on-subject`);
    }
  });

  test('keeps genuine service phrases', () => {
    for (const good of ['dead tree removal', 'tree removal cost', 'emergency tree service']) {
      assert.equal(keeps(good), true, `"${good}" should be on-subject`);
    }
  });

  test('matches across singular and plural', () => {
    // The H1 says "Services"; a searcher types "service".
    assert.equal(keeps('tree service'), true);
    assert.equal(keeps('removal service'), true);
  });

  test('filters nothing when the page has no usable H1 or title', () => {
    // Better to show an unfiltered list than an empty one.
    const empty = abCoreTerms({});
    assert.equal(abOnSubject('anything at all', empty), true);
  });
});

describe('subject gate inside ranking', () => {
  const rank = loadRanker();
  const core = new Set(['dead', 'tree', 'removal', 'service']);

  test('off-subject page phrases are dropped', () => {
    const out = rank(
      [{ text: 'dead tree removal', pageScore: 9, onPage: true },
       { text: 'just take', pageScore: 4, onPage: true }],
      {}, new Map(), core
    );
    assert.deepEqual(plain(out.map(k => k.text)), ['dead tree removal']);
  });

  test('Search Console and tracked terms bypass the gate', () => {
    // These are real queries this page already earns. However oddly they read,
    // they are evidence rather than a guess.
    const out = rank(
      [{ text: 'stump grinding quote', pageScore: 3, onPage: false }],
      { 'stump grinding quote': { avgMonthlySearches: 200 } },
      new Map(), core
    );
    assert.equal(out.length, 1, 'a proven query was filtered out by the subject gate');
  });
});

// ─── Copy gate ───────────────────────────────────────────────────────────────
// Regression cover for a shipped bug: "Generate ad copy" stayed disabled after
// keywords were ticked. The section is built while nothing is selected, and
// ticking a keyword re-rendered only the keyword list — so the button kept the
// disabled state it was born with, and the hint kept telling the user to
// select keywords they had already selected.

function loadCopyGate() {
  const from = panelSrc.indexOf('function abSyncCopyGate');
  const to = panelSrc.indexOf('function abSyncKeywordSummary');
  if (from === -1 || to <= from) throw new Error('abSyncCopyGate not found — update the slice markers');
  return (keywords, els) => {
    const ctx = {
      _abKeywords: keywords,
      document: { getElementById: (id) => els[id] || null },
      String, Object, Array
    };
    vm.createContext(ctx);
    vm.runInContext(`${panelSrc.slice(from, to)}; globalThis.__g = abSyncCopyGate;`, ctx);
    ctx.__g();
    return els;
  };
}

describe('generate-copy gate', () => {
  const gate = loadCopyGate();
  const els = () => ({ 'adsbuild-copy-btn': { disabled: true, title: '' } });

  test('enables the button once a keyword is selected', () => {
    const out = gate([{ text: 'a', include: true }, { text: 'b', include: false }], els());
    assert.equal(out['adsbuild-copy-btn'].disabled, false);
  });

  test('stays disabled while nothing is selected', () => {
    const out = gate([{ text: 'a', include: false }], els());
    assert.equal(out['adsbuild-copy-btn'].disabled, true);
  });

  test('a disabled button still explains itself', () => {
    // The permanent hint is gone, so the reason has to live somewhere — a
    // disabled control with no explanation reads as broken.
    const out = gate([{ text: 'a', include: false }], els());
    assert.match(out['adsbuild-copy-btn'].title, /Select some keywords first/);
  });

  test('re-disables when the last keyword is unticked', () => {
    // The bug ran in both directions: the gate has to close again too.
    const out = gate([{ text: 'a', include: false }], els());
    assert.equal(out['adsbuild-copy-btn'].disabled, true);
  });

  test('the tooltip counts the selection and agrees with the button', () => {
    const out = gate([{ text: 'a', include: true }, { text: 'b', include: true }], els());
    assert.match(out['adsbuild-copy-btn'].title, /2 keywords selected above/);
    assert.equal(out['adsbuild-copy-btn'].disabled, false);
  });

  test('says "keyword" not "keywords" for one', () => {
    const out = gate([{ text: 'a', include: true }], els());
    assert.match(out['adsbuild-copy-btn'].title, /1 keyword selected above/);
  });

  test('does nothing once the copy exists and the gate is gone', () => {
    // After generation the hint and button no longer exist; the gate must not
    // throw when called from a later selection change.
    assert.doesNotThrow(() => gate([{ text: 'a', include: true }], {}));
  });
});

// ─── Dynamic insertions and ad group status ──────────────────────────────────

describe('dynamic insertions', () => {
  test('an insertion is measured by its default text, not its source', async () => {
    // 36 characters written, 26 served. Measuring the source would reject a
    // perfectly valid headline.
    const b = boot();
    const res = await b.adsCreateAdGroup(validRequest({
      headlines: ['Save on {KeyWord:Tree Removal} Today', 'Plain headline one', 'Plain headline two']
    }));
    assert.ok(!res.error, `rejected a valid insertion headline: ${res.detail}`);
  });

  test('an insertion whose DEFAULT overflows is still rejected', () => {
    // The point of measuring the served text is that it is measured, not
    // waved through: a 40-character default is over the limit however it is
    // written.
    const b = boot();
    const out = b.rsaAssets(
      ['{LOCATION(City):' + 'x'.repeat(40) + '}', 'Plain one', 'Plain two'], 'headline'
    );
    assert.equal(out.ok, false, 'an over-length default was accepted');
    assert.match(out.error, /over 30 characters/);
  });

  test('an insertion with NO default is left for Google to judge', () => {
    // The served length is whatever Google fills in, so guessing at it here
    // would reject valid ads.
    const b = boot();
    const out = b.rsaAssets(
      // Three plain headlines alongside, so this exercises the LENGTH rule
      // rather than the separate three-plain-headlines requirement.
      ['Tree Removal In {LOCATION(City)} Today Fast', 'Plain one', 'Plain two', 'Plain three'], 'headline'
    );
    assert.equal(out.ok, true, out.error);
  });

  test('a location insertion with a default is accepted', async () => {
    const b = boot();
    const res = await b.adsCreateAdGroup(validRequest({
      headlines: ['Tree Removal {LOCATION(City):Twin Cities}', 'Plain one', 'Plain two', 'Plain three']
    }));
    assert.ok(!res.error, res.detail);
  });

  test('plain text over the limit is still rejected', () => {
    // The relaxation must apply ONLY to lines carrying an insertion.
    const b = boot();
    const out = b.rsaAssets(['ok one', 'ok two', 'x'.repeat(31)], 'headline');
    assert.equal(out.ok, false);
    assert.match(out.error, /over 30 characters/);
  });

  test('Google needs three headlines free of location insertion', async () => {
    // Without them an ad cannot be assembled for a viewer whose location
    // Google cannot resolve, and the API rejects the whole thing.
    const b = boot();
    const res = await b.adsCreateAdGroup(validRequest({
      headlines: [
        'Tree Removal {LOCATION(City):Here}',
        'Stump Grinding {LOCATION(City):Here}',
        'Tree Care {LOCATION(City):Here}',
        'Plain headline'
      ]
    }));
    assert.equal(res.error, 'INVALID');
    assert.match(res.detail, /3 headlines without location insertion/);
    assert.equal(b.mutateCalls.length, 0, 'an ad Google would reject still reached the API');
  });

  test('keyword insertion does not count against the location rule', () => {
    // Only LOCATION insertion carries the three-plain-headlines requirement.
    const b = boot();
    const out = b.rsaAssets(
      ['{KeyWord:Tree Removal} Experts', 'Fast Tree Removal', 'Local Tree Team'], 'headline'
    );
    assert.equal(out.ok, true, out.error);
  });
});

describe('ad group status', () => {
  test('defaults to paused when nothing is asked for', async () => {
    const b = boot();
    await b.adsCreateAdGroup(validRequest());
    assert.equal(opsOf(b.mutateCalls[0])[0].adGroupOperation.create.status, 'PAUSED');
  });

  test('starts enabled only on an explicit ENABLED', async () => {
    const b = boot();
    await b.adsCreateAdGroup(validRequest({ status: 'ENABLED' }));
    const ops = opsOf(b.mutateCalls[0]);
    assert.equal(ops[0].adGroupOperation.create.status, 'ENABLED');
    assert.equal(ops[1].adGroupAdOperation.create.status, 'ENABLED', 'the ad must follow the ad group');
  });

  test('anything unrecognised falls back to paused', async () => {
    // A typo must never be the reason an ad group starts spending.
    for (const bad of ['enabeld', 'ACTIVE', 'on', true, 1, null]) {
      const b = boot();
      await b.adsCreateAdGroup(validRequest({ status: bad }));
      assert.equal(
        opsOf(b.mutateCalls[0])[0].adGroupOperation.create.status, 'PAUSED',
        `status ${JSON.stringify(bad)} was not treated as paused`
      );
    }
  });

  test('the chosen status is reported back', async () => {
    const b = boot();
    const res = await b.adsCreateAdGroup(validRequest({ status: 'ENABLED' }));
    assert.equal(res.status, 'ENABLED');
  });
});

describe('ad group status default', () => {
  test('the panel starts with the toggle on', () => {
    // A deliberate reversal: the builder used to default to paused. Pinned
    // here so flipping it back is a decision rather than a drive-by edit.
    assert.match(
      panelSrc,
      /let _abStartEnabled = true;/,
      'the builder should default to creating the ad group enabled'
    );
  });

  test('the backend still falls back to paused for anything unrecognised', async () => {
    // The UI default changing must NOT weaken the backend guard — a malformed
    // status has to stay non-spending.
    const b = boot();
    await b.adsCreateAdGroup(validRequest({ status: 'enabeld' }));
    assert.equal(opsOf(b.mutateCalls[0])[0].adGroupOperation.create.status, 'PAUSED');
  });
});
