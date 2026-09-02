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
  const from = panelSrc.indexOf('function abRankKeywords');
  const to = panelSrc.indexOf('// ─── Commit');
  if (from === -1 || to <= from) throw new Error('abRankKeywords not found — update the slice markers');
  const ctx = { AB_KEYWORD_CAP: 40, Math, Number, Object, Array, String };
  vm.createContext(ctx);
  vm.runInContext(`${panelSrc.slice(from, to)}; globalThis.__r = abRankKeywords;`, ctx);
  return ctx.__r;
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

  test('already-targeted terms sink and start unchecked', () => {
    const out = rank(
      ['already used', 'brand new'],
      { 'already used': { avgMonthlySearches: 9000 }, 'brand new': { avgMonthlySearches: 5 } },
      new Map([['already used', 'Brand — Roofing']])
    );
    // Even with far more volume it goes last, because adding it would compete
    // with an existing ad group.
    assert.equal(out[out.length - 1].text, 'already used');
    assert.equal(out.find(k => k.text === 'already used').include, false);
  });

  test('an already-targeted term is still shown, with where it lives', () => {
    // Silently dropping it reads as a weak suggestion engine; naming the ad
    // group lets the user choose between moving and duplicating.
    const out = rank(['already used'], {}, new Map([['already used', 'Brand — Roofing']]));
    assert.equal(out.length, 1);
    assert.equal(out[0].targetedIn, 'Brand — Roofing');
  });

  test('everything defaults to phrase match', () => {
    const out = rank(['roof repair', 'roofers near me'], {}, new Map());
    assert.ok(out.every(k => k.matchType === 'PHRASE'));
  });

  test('terms with zero measured volume are listed but unchecked', () => {
    const out = rank(['dead term'], { 'dead term': { avgMonthlySearches: 0 } }, new Map());
    assert.equal(out[0].include, false);
  });

  test('unknown volume still defaults to included', () => {
    // No data is not the same as no demand — Keyword Planner returns nothing
    // for plenty of valid long-tail terms.
    const out = rank(['unmeasured term'], {}, new Map());
    assert.equal(out[0].include, true);
  });

  test('the list is capped', () => {
    const many = Array.from({ length: 120 }, (_, i) => `term number ${i}`);
    assert.equal(rank(many, {}, new Map()).length, 40);
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
