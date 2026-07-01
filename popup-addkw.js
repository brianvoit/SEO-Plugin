// "Add Keywords" — sibling to Refine Negatives (popup-ads.js), but inverted:
// suggests NEW positive keywords to add to Google Ads, sourced from real
// search queries for the current page. Launchable from both the Ads tab
// (paid search terms not yet their own keyword) and the Search tab (organic
// GSC queries not yet targeted by any paid keyword). One shared panel; the
// candidate-sourcing path differs by `source`.

const ADDKW_CANDIDATE_CAP = 120;
const ADDKW_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const ADDKW_CONF_HELP = {
  high:   'High confidence: clearly relevant, strong intent for this page. Good candidate to add.',
  medium: 'Medium confidence: plausibly worth it, but check budget/relevance before adding.',
  low:    'Low confidence: borderline. Only weak signals it is worth adding — review carefully.',
};

let _addkwSource = 'ads';     // 'ads' | 'gsc' — which tab launched the panel
let _addkwRecs = null;        // [{ text, reason, confidence, matchType, include, adGroupId, adGroupName, campaignName, volume, competition, metrics… }]
let _addkwRecsSource = null;  // source the current _addkwRecs were built for
let _addkwInsights = null;
let _addkwLoading = false;
let _addkwResultGroups = null;     // after commit: [{adGroupId, adGroupName, campaignName, terms:[{text,matchType}]}]
let _addkwAdGroupOptions = [];     // [{adGroupId, adGroupName, campaignName}] — ad groups serving this page (used as the default)
let _addkwAdsAvailable = true;     // false = Ads not connected/no ad groups for this page (gsc source, research-only)
let _addkwAlreadyTargetedCount = 0; // suggestions dropped because the generalized term already exists as a keyword
let _addkwAllAdGroups = [];        // [{adGroupId, adGroupName, campaignId, campaignName}] — EVERY ad group in the account
let _addkwAllAdGroupsHost = null;  // host _addkwAllAdGroups was fetched for (refetch if the page's account changes)
let _addkwAllKeywordTexts = null;  // Set of lowercased keyword text — EVERY keyword already targeted anywhere in the account
let _addkwAllKeywordTextsHost = null;

let _addkwBlindspotLoading = false;
let _addkwBlindspotGenerated = false;  // has a brainstorm run for the current _addkwRecs generation?
let _addkwBlindspotSkippedCount = 0;   // ideas dropped: already targeted, branded, or no measurable volume
let _addkwBlindspotError = null;

// Fetches the full account ad-group list once per host, so the per-row picker
// can offer any ad group, not just the ones already serving this page.
async function ensureAddKwAllAdGroups(pageUrl) {
  let host = '';
  try { host = new URL(pageUrl).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
  if (_addkwAllAdGroupsHost === host && _addkwAllAdGroups.length) return;
  try {
    const res = await sendMessageWithTimeout({ action: 'adsGetAllAdGroups', pageUrl });
    if (res && res.adGroups) { _addkwAllAdGroups = res.adGroups; _addkwAllAdGroupsHost = host; }
  } catch { /* picker falls back to the page's own ad groups */ }
}

// Fetches every keyword text already targeted anywhere in the account (not
// just ad groups serving this page) — only needed for the blind-spot
// brainstorm's "not already targeting elsewhere" check, so it's fetched
// lazily on first use rather than on every panel open.
async function ensureAddKwAllKeywords(pageUrl) {
  let host = '';
  try { host = new URL(pageUrl).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
  if (_addkwAllKeywordTextsHost === host && _addkwAllKeywordTexts) return;
  try {
    const res = await sendMessageWithTimeout({ action: 'adsGetAllKeywords', pageUrl });
    if (res && res.texts) { _addkwAllKeywordTexts = new Set(res.texts); _addkwAllKeywordTextsHost = host; }
  } catch { /* dedup just no-ops if unavailable */ }
}

// The options the per-row picker should offer: every account ad group once
// loaded, falling back to just the page's own ad groups until then.
function addkwPickerAdGroups() {
  return _addkwAllAdGroups.length ? _addkwAllAdGroups : _addkwAdGroupOptions;
}

function setAddKwCommitVisible(show) {
  const btn = document.getElementById('btn-addkw-commit');
  if (btn) btn.classList.toggle('hidden', !show);
}

// The three header export icons (txt/copy/doc) — visible whenever there's a
// rendered list to act on, regardless of commit/connection state.
function setAddKwExportButtonsVisible(show) {
  ['btn-addkw-export-txt', 'btn-addkw-export-copy', 'btn-addkw-export-doc'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle('hidden', !show);
  });
}

function resetAddKw() {
  _addkwRecs = null;
  _addkwRecsSource = null;
  _addkwInsights = null;
  _addkwResultGroups = null;
  _addkwAdGroupOptions = [];
  _addkwAdsAvailable = true;
  _addkwAlreadyTargetedCount = 0;
  _addkwBlindspotLoading = false;
  _addkwBlindspotGenerated = false;
  _addkwBlindspotSkippedCount = 0;
  _addkwBlindspotError = null;
  setAddKwCommitVisible(false);
  setAddKwExportButtonsVisible(false);
  const tunedEl = document.getElementById('addkw-tuned');
  if (tunedEl) tunedEl.replaceChildren();
  const body = document.getElementById('addkw-body');
  if (body) body.replaceChildren();
}

function addKwBodyMessage(msg, isError) {
  setAddKwCommitVisible(false);
  setAddKwExportButtonsVisible(false);
  const tunedEl = document.getElementById('addkw-tuned');
  if (tunedEl) tunedEl.replaceChildren();
  const body = document.getElementById('addkw-body');
  if (!body) return;
  body.replaceChildren();
  const el = document.createElement('div');
  el.className = 'adcopy-message gen-result-text' + (isError ? ' is-error' : '');
  el.textContent = msg;
  body.appendChild(el);
}

function setAddKwBusy(busy) {
  _addkwLoading = busy;
  const regen = document.getElementById('btn-addkw-regen');
  if (regen) regen.disabled = busy;
}

// ─── Cache (survives popup close/reopen) — keyed by page URL + source ────────
// Ads-tab and Search-tab analyses of the same page are distinct runs.

async function addkwCacheKey() {
  const tab = await getActiveTab();
  return `${(tab.url || '').split('#')[0]}::${_addkwSource}`;
}

async function saveAddKwCache() {
  try {
    const key = await addkwCacheKey();
    const { addkwAnalysisCache } = await browser.storage.local.get('addkwAnalysisCache');
    const cache = addkwAnalysisCache || {};
    cache[key] = {
      recs: _addkwRecs,
      insights: _addkwInsights,
      adsAvailable: _addkwAdsAvailable,
      adGroupOptions: _addkwAdGroupOptions,
      blindspotGenerated: _addkwBlindspotGenerated,
      blindspotSkippedCount: _addkwBlindspotSkippedCount,
      fetchedAt: Date.now()
    };
    await browser.storage.local.set({ addkwAnalysisCache: cache });
  } catch { /* best-effort */ }
}

async function loadAddKwCache() {
  try {
    const key = await addkwCacheKey();
    const { addkwAnalysisCache } = await browser.storage.local.get('addkwAnalysisCache');
    const entry = addkwAnalysisCache && addkwAnalysisCache[key];
    if (!entry || !Array.isArray(entry.recs)) return false;
    if (Date.now() - entry.fetchedAt > ADDKW_CACHE_TTL_MS) return false;
    _addkwRecs = entry.recs;
    _addkwRecsSource = _addkwSource;
    _addkwInsights = entry.insights || null;
    _addkwAdsAvailable = entry.adsAvailable !== false;
    _addkwAdGroupOptions = entry.adGroupOptions || [];
    _addkwBlindspotGenerated = !!entry.blindspotGenerated;
    _addkwBlindspotSkippedCount = entry.blindspotSkippedCount || 0;
    _addkwBlindspotError = null;
    return true;
  } catch { return false; }
}

async function clearAddKwCache() {
  try {
    const key = await addkwCacheKey();
    const { addkwAnalysisCache } = await browser.storage.local.get('addkwAnalysisCache');
    if (addkwAnalysisCache && addkwAnalysisCache[key]) {
      delete addkwAnalysisCache[key];
      await browser.storage.local.set({ addkwAnalysisCache });
    }
  } catch { /* best-effort */ }
}

// Opening the panel: show cached recs (for this source) or analyze fresh.
async function openAddKwPanel(source) {
  _addkwSource = source === 'gsc' ? 'gsc' : 'ads';
  if (_addkwLoading) { addKwBodyMessage(_addkwSource === 'gsc' ? 'Analyzing queries…' : 'Analyzing search terms…'); return; }
  try { const tab = await getActiveTab(); await ensureAddKwAllAdGroups(tab.url); } catch { /* picker falls back gracefully */ }
  if (_addkwRecs && _addkwRecsSource === _addkwSource) { renderAddKw(); return; }
  const restored = await loadAddKwCache();
  if (restored) { renderAddKw(); return; }
  generateAddKw(false);
}

// ─── Candidate sourcing ────────────────────────────────────────────────────

// adGroupId → { campaignId, campaignName, adGroupName } from the loaded ads
function addkwAdGroupMap() {
  const m = new Map();
  (_adsData?.ads || []).forEach(a => {
    if (a.adGroupId && !m.has(a.adGroupId)) m.set(a.adGroupId, { campaignId: a.campaignId, campaignName: a.campaign, adGroupName: a.adGroup });
  });
  return m;
}

// adGroupId → Set(lowercased existing keyword text in that ad group). Used
// both to build candidates (pre-Claude) and to re-check Claude's generalized
// terms (post-Claude) — a generalized term can collide with an existing
// keyword even when the literal candidate query never did.
function addkwExistingByGroup() {
  const m = new Map();
  (_adsData?.keywords || []).forEach(k => {
    if (!k.adGroupId) return;
    if (!m.has(k.adGroupId)) m.set(k.adGroupId, new Set());
    m.get(k.adGroupId).add((k.text || '').toLowerCase().trim());
  });
  return m;
}

// All existing keyword text across every ad group serving this page, used for
// the gsc-source path where the destination ad group isn't fixed up front.
function addkwAllExistingTexts() {
  return new Set((_adsData?.keywords || []).map(k => (k.text || '').toLowerCase().trim()).filter(Boolean));
}

// Ads-tab source: search terms that already triggered ads (via broad/phrase
// match on an existing keyword) but aren't an explicit keyword in that ad
// group yet, and have real performance signal. Grouped per ad group, since a
// term might already be a keyword in one ad group but a good add in another.
function addkwCandidatesFromAds(host) {
  const pattern = allBrandedTerms[host] || '';
  const existingByGroup = addkwExistingByGroup();

  const byKey = new Map();
  (_adsData.searchTerms || []).forEach(t => {
    const text = (t.text || '').trim();
    if (!text || !t.adGroupId) return;
    if (isQueryBranded(text, pattern)) return;
    const lc = text.toLowerCase();
    const have = existingByGroup.get(t.adGroupId);
    if (have && have.has(lc)) return; // already a keyword in this ad group
    const key = `${t.adGroupId}::${lc}`;
    if (!byKey.has(key)) byKey.set(key, { text, adGroupId: t.adGroupId, impressions: 0, clicks: 0, cost: 0, conversions: 0 });
    const agg = byKey.get(key);
    agg.impressions += t.impressions || 0;
    agg.clicks += t.clicks || 0;
    agg.cost += t.cost || 0;
    agg.conversions += t.conversions || 0;
  });

  const candidates = [...byKey.values()].filter(c => c.clicks > 0 || c.conversions > 0);
  candidates.sort((a, b) => (b.conversions - a.conversions) || (b.clicks - a.clicks));
  return candidates.slice(0, ADDKW_CANDIDATE_CAP);
}

// Search-tab source: organic queries not already targeted by a paid keyword
// anywhere in the account's ad groups serving this page. No inherent ad-group
// anchor — destination is resolved per-row in the UI (defaults to the first
// ad group serving the page).
function addkwCandidatesFromGsc() {
  const pattern = gscBrandedPattern();
  const allKeywordTexts = addkwAllExistingTexts();
  const candidates = [];
  (_gscQueries || []).forEach(q => {
    const text = (q.query || '').trim();
    if (!text) return;
    if (isQueryBranded(text, pattern)) return;
    if (allKeywordTexts.has(text.toLowerCase())) return;
    candidates.push({ text, impressions: q.impressions || 0, clicks: q.clicks || 0, position: q.position ?? null });
  });
  candidates.sort((a, b) => (b.clicks - a.clicks) || (b.impressions - a.impressions));
  return candidates.slice(0, ADDKW_CANDIDATE_CAP);
}

function addkwCandidateLine(c, i) {
  if (_addkwSource === 'gsc') {
    return `${i}. "${c.text}" — impr ${adsNum(c.impressions)}, clicks ${adsNum(c.clicks)}, avg position ${c.position != null ? c.position.toFixed(1) : 'n/a'}`;
  }
  return `${i}. "${c.text}" — impr ${adsNum(c.impressions)}, clicks ${adsNum(c.clicks)}, cost ${adsCost(c.cost, _adsData.currency)}, conv ${adsConv(c.conversions)}`;
}

function addkwFormatVolume(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M/mo';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K/mo';
  return `${n}/mo`;
}

// ─── Claude prompt (mirrors NEGATIVES_SYSTEM_BASE's structure, inverted intent) ─

const ADDKW_SYSTEM_BASE = [
  'You are a Google Ads keyword strategist. From the candidate search terms/queries below, identify the ones that would make GOOD NEW KEYWORDS to add to this advertiser\'s account for this landing page.',
  '',
  'Return ONLY a JSON array (no prose, no code fences). Each element is exactly:',
  '{"index": <number from the candidate list>, "term": "<the keyword text to add>", "reason": "<short reason, 12 words max>", "matchType": "BROAD|PHRASE|EXACT", "confidence": "high|medium|low"}',
  '',
  '"index" must point at the candidate that inspired this keyword (used to attribute its performance metrics) — but "term" does NOT have to be the candidate\'s literal text. For a long or question-style candidate (e.g. "how much is a dormer addition", "where can i get a sunroom built near me"), extract the core 2-4 word commercial phrase (e.g. "dormer addition", "sunroom builder near me") and use PHRASE or BROAD match instead — phrase/broad match still catches the original query and its close variants, so the keyword stays useful long after this specific wording. Only keep the literal candidate text when proposing EXACT match on a genuinely concise, high-intent query, or when the candidate is already a short core phrase.',
  '',
  'Only include terms genuinely worth bidding on for this page: clear commercial or informational relevance, not a near-duplicate of another strong candidate, not so generic it would waste spend.',
  'Match type guidance:',
  '- EXACT: a specific, high-intent term you want tightly controlled — usually the candidate\'s own text, since exact match requires close wording.',
  '- PHRASE: the most common choice — extract the core phrase from the candidate; close phrase-match variants (including longer/shorter wordings of the same query) should still be relevant.',
  '- BROAD: only for a short, well-understood theme you are confident about controlling without wasting spend.',
  'Be conservative: adding an irrelevant or wasteful keyword is worse than missing a good one.',
  'confidence = how sure you are this keyword is worth bidding on for THIS page:',
  '- high: clearly relevant, strong commercial/informational intent for this page.',
  '- medium: plausibly worth it, but a human should sanity-check budget/relevance first.',
  '- low: borderline; only weak signals it is worth adding.',
  'Never use em dashes or en dashes in the reason text.',
].join('\n');

// Returns only the page-specific suffix (intent + brand terms + source note).
function buildAddKwSystem(insights, brandTerms, source) {
  const lines = [];
  if (insights?.intent && typeof OG_INTENT_GUIDANCE !== 'undefined' && OG_INTENT_GUIDANCE[insights.intent]) {
    lines.push(`The page's search intent is ${insights.intent}. Favor terms that match this intent.`);
  }
  if (brandTerms.length) {
    lines.push(`Brand terms for this site: ${brandTerms.join(', ')}. These have already been filtered out of the candidates — never suggest a brand term.`);
  }
  lines.push(source === 'gsc'
    ? 'These candidates are organic Search Console queries with no paid history yet — only recommend ones with realistic paid/commercial intent, not purely informational queries this page already ranks well for.'
    : 'These candidates are Google Ads search terms that already triggered ads for this page (via broad/phrase match on an existing keyword) but are not yet their own keyword.');
  return lines.join('\n');
}

// Tolerant parse of Claude's recommendation list — same salvage logic as
// parseNegativesJson (code fences, object wrapper, truncation).
function parseAddKwJson(text) {
  const raw = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };

  let v = tryParse(raw);
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.keywords)) return v.keywords;
  if (v && Array.isArray(v.terms)) return v.terms;

  const s = raw.indexOf('['), e = raw.lastIndexOf(']');
  if (s !== -1 && e > s) {
    v = tryParse(raw.slice(s, e + 1));
    if (Array.isArray(v)) return v;
  }

  const objs = raw.match(/\{[^{}]*\}/g);
  if (objs) {
    const out = [];
    objs.forEach(o => { const p = tryParse(o); if (p && (p.term || p.index != null)) out.push(p); });
    if (out.length) return out;
  }
  return null;
}

async function generateAddKw(force) {
  if (_addkwLoading) return;
  if (!force && _addkwRecs && _addkwRecsSource === _addkwSource) { renderAddKw(); return; }

  setAddKwBusy(true);
  _addkwBlindspotGenerated = false;
  _addkwBlindspotSkippedCount = 0;
  _addkwBlindspotError = null;
  addKwBodyMessage(_addkwSource === 'gsc' ? 'Analyzing queries…' : 'Analyzing search terms…');

  try {
    const { claudeApiKey } = await browser.storage.local.get('claudeApiKey');
    if (!claudeApiKey) throw new Error('No Claude API key — add one in Settings (⚙).');

    const tab = await getActiveTab();
    const pageUrl = pageData?.canonical || tab.url;
    let host = '';
    try { host = new URL(pageUrl, tab.url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
    const brandTerms = (allBrandedTerms[host] || '').split('|').map(s => s.trim()).filter(Boolean);
    await ensureAddKwAllAdGroups(tab.url);

    const cacheKey = (tab.url || '').split('#')[0];
    const { aiInsightsCache } = await browser.storage.local.get('aiInsightsCache');
    const insights = (aiInsightsCache || {})[cacheKey] || null;
    const pageIntent = insights?.intent || null;

    let candidates = [];

    if (_addkwSource === 'ads') {
      if (!_adsData || !(_adsData.searchTerms || []).length) {
        addKwBodyMessage('No search terms for this page yet. Open the Ads tab on a page with paid traffic first.', true);
        return;
      }
      // Good adds live in the long tail too — pull the full search-term list first.
      if (_adsData.searchTermsLimited) {
        try {
          const more = await sendMessageWithTimeout({ action: 'adsGetMoreSearchTerms', pageUrl: tab.url, range: adsSelectedRange });
          if (more && more.searchTerms) { _adsData.searchTerms = more.searchTerms; _adsData.searchTermsLimited = more.searchTermsLimited; }
        } catch { /* best effort — analyze what we have */ }
      }
      candidates = addkwCandidatesFromAds(host);
    } else {
      // Needs _adsData for "already targeted" suppression + ad-group destinations.
      try { await loadAdsData(false); } catch { /* degrade gracefully below */ }
      candidates = addkwCandidatesFromGsc();
    }

    _addkwAdsAvailable = !!(_adsData && (_adsData.ads || []).length);
    _addkwAdGroupOptions = (_adsData?.ads || []).reduce((arr, a) => {
      if (a.adGroupId && !arr.some(x => x.adGroupId === a.adGroupId)) arr.push({ adGroupId: a.adGroupId, adGroupName: a.adGroup, campaignName: a.campaign });
      return arr;
    }, []);

    if (!candidates.length) {
      _addkwRecs = []; _addkwRecsSource = _addkwSource; _addkwInsights = insights; _addkwResultGroups = null; _addkwAlreadyTargetedCount = 0;
      renderAddKw();
      return;
    }

    const ranked = candidates;
    const candidateLines = ranked.map((c, i) => addkwCandidateLine(c, i)).join('\n');

    const context = [
      `Landing page URL: ${pageUrl}`,
      `Page title: "${pageData?.title?.text || ''}"`,
      pageData?.metaDescription?.text && `Meta description: "${pageData.metaDescription.text}"`,
      pageIntent          && `Page search intent: ${pageIntent}`,
      insights?.sentiment && `Page sentiment: ${insights.sentiment}`,
      brandTerms.length   && `Brand terms (already excluded from candidates): ${brandTerms.join(', ')}`,
      pageData?.headings?.length && `Headings:\n${pageData.headings.map(h => `${h.tag.toUpperCase()}: ${h.text}`).join('\n')}`,
      pageData?.bodyTextExcerpt  && `Page content excerpt: "${pageData.bodyTextExcerpt}"`,
      `Candidate ${_addkwSource === 'gsc' ? 'organic queries' : 'search terms'} (already filtered to drop branded and already-targeted terms):\n` + candidateLines,
    ].filter(v => v !== undefined && v !== false && v !== null && v !== '').join('\n\n');

    const addkwSystemDynamic = buildAddKwSystem(insights, brandTerms, _addkwSource);
    const addkwSystemBlocks = [{ type: 'text', text: ADDKW_SYSTEM_BASE, cache_control: { type: 'ephemeral' } }];
    if (addkwSystemDynamic) addkwSystemBlocks.push({ type: 'text', text: addkwSystemDynamic });

    const data = await claudeFetch({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeApiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: MODEL_MID,
        max_tokens: 4096,
        system: addkwSystemBlocks,
        messages: [{ role: 'user', content: context }]
      })
    }, 120000);
    const parsed = parseAddKwJson(data.content?.[0]?.text ?? '');
    if (!parsed) throw new Error('Could not parse the analysis response');

    const agMap = _addkwSource === 'ads' ? addkwAdGroupMap() : null;
    const defaultGroup = _addkwAdGroupOptions[0] || null;
    const recs = [];
    parsed.forEach(p => {
      const idx = Number(p.index);
      const cand = Number.isInteger(idx) ? ranked[idx]
        : ranked.find(c => c.text.toLowerCase() === String(p.term || '').toLowerCase());
      if (!cand) return;
      const matchType  = negNormMatch(p.matchType);
      const reason     = String(p.reason || '').trim();
      const confidence = ['high', 'medium', 'low'].includes(String(p.confidence || '').toLowerCase()) ? p.confidence.toLowerCase() : '';

      let adGroupId = null, adGroupName = null, campaignName = null;
      if (_addkwSource === 'ads') {
        const g = agMap.get(cand.adGroupId);
        adGroupId = cand.adGroupId;
        adGroupName = g?.adGroupName || null;
        campaignName = g?.campaignName || null;
      } else if (defaultGroup) {
        adGroupId = defaultGroup.adGroupId;
        adGroupName = defaultGroup.adGroupName;
        campaignName = defaultGroup.campaignName;
      }

      // Claude may generalize a long/question-style candidate down to a core
      // phrase (see ADDKW_SYSTEM_BASE) — use its proposed term, not the raw
      // candidate text, falling back to the candidate only if it left it blank.
      const text = String(p.term || '').trim() || cand.text;

      recs.push({
        text, reason, confidence, matchType, include: true,
        adGroupId, adGroupName, campaignName,
        impressions: cand.impressions, clicks: cand.clicks,
        cost: cand.cost || 0, conversions: cand.conversions || 0, position: cand.position ?? null,
        volume: null, competition: null
      });
    });

    if (!recs.length) {
      _addkwRecs = []; _addkwRecsSource = _addkwSource; _addkwInsights = insights; _addkwResultGroups = null; _addkwAlreadyTargetedCount = 0;
      renderAddKw();
      return;
    }

    // Generalizing terms can collapse several candidates onto the same keyword
    // (e.g. "how much is a dormer addition" and "dormer addition cost" both
    // becoming "dormer addition") — merge those within the same ad group,
    // summing metrics and keeping the highest-confidence reason/match type.
    const CONF_RANK = { high: 3, medium: 2, low: 1, '': 0 };
    const merged = new Map();
    recs.forEach(r => {
      const key = `${r.adGroupId || ''}::${r.text.toLowerCase()}`;
      const existing = merged.get(key);
      if (!existing) { merged.set(key, r); return; }
      existing.impressions += r.impressions;
      existing.clicks += r.clicks;
      existing.cost += r.cost;
      existing.conversions += r.conversions;
      if (CONF_RANK[r.confidence] > CONF_RANK[existing.confidence]) {
        existing.confidence = r.confidence;
        existing.reason = r.reason;
        existing.matchType = r.matchType;
      }
    });
    // A generalized term can collide with a keyword that already exists even
    // when the literal candidate query never did (e.g. Claude proposes
    // "dormer addition" but that ad group already has "dormer addition" as a
    // keyword) — re-check post-generalization and drop any collision.
    const existingByGroupNow = _addkwSource === 'ads' ? addkwExistingByGroup() : null;
    const allExistingNow = _addkwSource === 'gsc' ? addkwAllExistingTexts() : null;
    let alreadyTargetedCount = 0;
    const deduped = [...merged.values()].filter(r => {
      const lc = r.text.toLowerCase();
      const already = _addkwSource === 'ads'
        ? !!(existingByGroupNow.get(r.adGroupId) && existingByGroupNow.get(r.adGroupId).has(lc))
        : allExistingNow.has(lc);
      if (already) alreadyTargetedCount++;
      return !already;
    });
    recs.length = 0;
    recs.push(...deduped);
    _addkwAlreadyTargetedCount = alreadyTargetedCount;

    if (!recs.length) {
      _addkwRecs = []; _addkwRecsSource = _addkwSource; _addkwInsights = insights; _addkwResultGroups = null;
      renderAddKw();
      return;
    }

    // Enrich only Claude's picks with volume (typically well under any seed-size
    // limit) — volume is enrichment, never a blocker if the call fails.
    addKwBodyMessage('Estimating search volume…');
    try {
      const idr = await sendMessageWithTimeout({ action: 'adsGetKeywordIdeas', pageUrl: tab.url, keywords: recs.map(r => r.text) });
      const byKeyword = (idr && idr.byKeyword) || {};
      recs.forEach(r => {
        const m = byKeyword[r.text.toLowerCase()];
        if (m) { r.volume = m.avgMonthlySearches ?? null; r.competition = m.competition ?? null; }
      });
    } catch { /* volume unavailable — rows render with "—" */ }

    _addkwRecs = recs;
    _addkwRecsSource = _addkwSource;
    _addkwInsights = insights;
    _addkwResultGroups = null;
    saveAddKwCache();

    renderAddKw();
  } catch (err) {
    addKwBodyMessage(err.message, true);
  } finally {
    setAddKwBusy(false);
  }
}

// ─── Potential Blindspots: brainstorm-from-content (not from search history) ─

const ADDKW_BLINDSPOT_SYSTEM = [
  'You are a Google Ads keyword strategist doing a keyword-gap ("blind spot") analysis. Based ONLY on this landing page\'s own content and apparent search intent — NOT any existing search-term or query history — brainstorm NEW keyword ideas a potential customer might search for that this page could realistically compete for, but that the advertiser may not have thought to target yet.',
  '',
  'Return ONLY a JSON array (no prose, no code fences). Each element is exactly:',
  '{"term": "<the keyword text to add>", "reason": "<short reason, 12 words max>", "matchType": "BROAD|PHRASE|EXACT", "confidence": "high|medium|low"}',
  '',
  'Return 15 to 30 ideas. Favor realistic, specific 2-5 word commercial or informational phrases directly tied to what this page actually offers — not generic industry buzzwords, and never a brand name.',
  'Match type guidance:',
  '- EXACT: a specific, high-intent phrase you want tightly controlled.',
  '- PHRASE: the most common choice — a core phrase where close variants are still relevant.',
  '- BROAD: only for a short, well-understood theme you are confident about controlling without wasting spend.',
  'confidence = how sure you are this is a real, worthwhile gap for THIS page:',
  '- high: obviously relevant, strong intent match, this page clearly serves that need.',
  '- medium: plausible fit, would want a quick sanity check before spending real budget.',
  '- low: speculative — a stretch, but not unreasonable.',
  'Never use em dashes or en dashes in the reason text.',
].join('\n');

async function generateAddKwBlindspots(force) {
  if (_addkwBlindspotLoading) return;
  if (!force && _addkwBlindspotGenerated) { renderAddKw(); return; }

  _addkwBlindspotLoading = true;
  _addkwBlindspotError = null;
  renderAddKw();

  try {
    const { claudeApiKey } = await browser.storage.local.get('claudeApiKey');
    if (!claudeApiKey) throw new Error('No Claude API key — add one in Settings (⚙).');

    const tab = await getActiveTab();
    const pageUrl = pageData?.canonical || tab.url;
    let host = '';
    try { host = new URL(pageUrl, tab.url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
    const brandPattern = allBrandedTerms[host] || '';
    const brandTerms = brandPattern.split('|').map(s => s.trim()).filter(Boolean);

    const cacheKey = (tab.url || '').split('#')[0];
    const { aiInsightsCache } = await browser.storage.local.get('aiInsightsCache');
    const insights = (aiInsightsCache || {})[cacheKey] || null;
    const pageIntent = insights?.intent || null;

    await Promise.all([ensureAddKwAllAdGroups(tab.url), ensureAddKwAllKeywords(tab.url)]);

    const context = [
      `Landing page URL: ${pageUrl}`,
      `Page title: "${pageData?.title?.text || ''}"`,
      pageData?.metaDescription?.text && `Meta description: "${pageData.metaDescription.text}"`,
      pageIntent          && `Page search intent: ${pageIntent}`,
      insights?.sentiment && `Page sentiment: ${insights.sentiment}`,
      brandTerms.length   && `Brand terms (never suggest these): ${brandTerms.join(', ')}`,
      pageData?.headings?.length && `Headings:\n${pageData.headings.map(h => `${h.tag.toUpperCase()}: ${h.text}`).join('\n')}`,
      pageData?.bodyTextExcerpt  && `Page content excerpt: "${pageData.bodyTextExcerpt}"`,
    ].filter(v => v !== undefined && v !== false && v !== null && v !== '').join('\n\n');

    const data = await claudeFetch({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeApiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: MODEL_MID,
        max_tokens: 4096,
        system: [{ type: 'text', text: ADDKW_BLINDSPOT_SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: context }]
      })
    }, 120000);
    const parsed = parseAddKwJson(data.content?.[0]?.text ?? '');
    if (!parsed) throw new Error('Could not parse the brainstorm response');

    // Dedup against main (search-history) recs only — exclude any prior
    // blindspot batch so a regenerate can freely re-suggest the same idea
    // instead of spuriously treating it as "already present".
    const existingTexts = new Set((_addkwRecs || []).filter(r => !r.isBlindspot).map(r => r.text.toLowerCase()));
    const defaultGroup = _addkwAdGroupOptions[0] || null;
    let skipped = 0;

    const ideas = [];
    parsed.forEach(p => {
      const text = String(p.term || '').trim();
      if (!text) return;
      const lc = text.toLowerCase();
      if (existingTexts.has(lc)) { skipped++; return; }
      if (isQueryBranded(text, brandPattern)) { skipped++; return; }
      if (_addkwAllKeywordTexts && _addkwAllKeywordTexts.has(lc)) { skipped++; return; }
      existingTexts.add(lc);
      const matchType  = negNormMatch(p.matchType);
      const reason     = String(p.reason || '').trim();
      const confidence = ['high', 'medium', 'low'].includes(String(p.confidence || '').toLowerCase()) ? p.confidence.toLowerCase() : '';
      ideas.push({
        text, reason, confidence, matchType, include: true,
        adGroupId: defaultGroup ? defaultGroup.adGroupId : null,
        adGroupName: defaultGroup ? defaultGroup.adGroupName : null,
        campaignName: defaultGroup ? defaultGroup.campaignName : null,
        impressions: 0, clicks: 0, cost: 0, conversions: 0, position: null,
        volume: null, competition: null, isBlindspot: true
      });
    });

    if (ideas.length) {
      const idr = await sendMessageWithTimeout({ action: 'adsGetKeywordIdeas', pageUrl: tab.url, keywords: ideas.map(r => r.text) });
      const byKeyword = (idr && idr.byKeyword) || {};
      ideas.forEach(r => {
        const m = byKeyword[r.text.toLowerCase()];
        if (m) { r.volume = m.avgMonthlySearches ?? null; r.competition = m.competition ?? null; }
      });
    }

    // Only keep ideas with real, measurable volume — a blind spot with no
    // provable demand is speculation, not a lead worth surfacing.
    const withVolume = ideas.filter(r => r.volume != null && r.volume > 0);
    skipped += ideas.length - withVolume.length;

    // Drop any blind-spot recs from a previous run before appending the fresh
    // set, so "Regenerate" replaces them instead of accumulating duplicates.
    _addkwRecs = [...(_addkwRecs || []).filter(r => !r.isBlindspot), ...withVolume];
    _addkwBlindspotGenerated = true;
    _addkwBlindspotSkippedCount = skipped;
    saveAddKwCache();
    renderAddKw();
  } catch (err) {
    _addkwBlindspotGenerated = true;
    _addkwBlindspotError = err.message;
    renderAddKw();
  } finally {
    _addkwBlindspotLoading = false;
  }
}

// ─── Rendering ─────────────────────────────────────────────────────────────

function makeAddKwTableHead() {
  const head = document.createElement('div');
  head.className = 'addkw-table-head';
  const hMatch = document.createElement('span'); hMatch.className = 'neg-h-match';  hMatch.textContent = 'Match';
  const hVol   = document.createElement('span'); hVol.className  = 'addkw-h-vol';   hVol.textContent  = 'Vol/mo';
  const hImpr  = document.createElement('span'); hImpr.className = 'neg-h-impr';    hImpr.textContent  = 'Impr';
  const hClk   = document.createElement('span'); hClk.className  = 'neg-h-clk';     hClk.textContent   = 'Clicks';
  const hLast  = document.createElement('span'); hLast.className = 'addkw-h-last';  hLast.textContent  = _addkwSource === 'gsc' ? 'Pos' : 'Cost';
  head.append(hMatch, hVol, hImpr, hClk, hLast);
  return head;
}

// Custom destination-ad-group picker, used on every row (both sources). A
// native <select> can't show a full "Campaign › Ad group" label when closed
// while grouping options by campaign with just the ad-group name when open,
// so this is a small button + dropdown menu instead: closed state shows the
// full path, open state shows one non-interactive campaign-name heading per
// group with its ad groups listed underneath — any ad group in the account,
// not just ones already serving this page.
function makeAddKwAdGroupPicker(r) {
  const wrap = document.createElement('div');
  wrap.className = 'addkw-ag-picker';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'addkw-ag-picker-btn';
  btn.title = 'Ad group this keyword will be added to';

  const menu = document.createElement('div');
  menu.className = 'addkw-ag-picker-menu hidden';

  const setLabel = () => {
    btn.textContent = r.adGroupId
      ? `${r.campaignName || 'Campaign'} › ${r.adGroupName || 'Ad group'}`
      : 'Choose an ad group…';
  };
  setLabel();

  const onDocClick = (e) => { if (!wrap.contains(e.target)) closeMenu(); };
  function closeMenu() {
    menu.classList.add('hidden');
    wrap.classList.remove('is-open');
    document.removeEventListener('click', onDocClick, true);
  }

  function buildMenu() {
    menu.replaceChildren();
    const groups = new Map();
    addkwPickerAdGroups().forEach(g => {
      const key = g.campaignId || g.campaignName || '__none__';
      if (!groups.has(key)) groups.set(key, { campaignName: g.campaignName, items: [] });
      groups.get(key).items.push(g);
    });
    if (!groups.size) {
      const empty = document.createElement('div');
      empty.className = 'addkw-ag-picker-empty';
      empty.textContent = 'No ad groups found.';
      menu.appendChild(empty);
      return;
    }
    groups.forEach(g => {
      const groupEl = document.createElement('div');
      groupEl.className = 'addkw-ag-picker-group';
      const label = document.createElement('div');
      label.className = 'addkw-ag-picker-group-label';
      label.textContent = g.campaignName || 'Campaign';
      groupEl.appendChild(label);
      g.items.forEach(item => {
        const opt = document.createElement('button');
        opt.type = 'button';
        opt.className = 'addkw-ag-picker-option' + (item.adGroupId === r.adGroupId ? ' is-active' : '');
        opt.textContent = item.adGroupName || 'Ad group';
        opt.addEventListener('click', () => {
          r.adGroupId = item.adGroupId;
          r.adGroupName = item.adGroupName;
          r.campaignName = item.campaignName;
          setLabel();
          closeMenu();
        });
        groupEl.appendChild(opt);
      });
      menu.appendChild(groupEl);
    });
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (wrap.classList.contains('is-open')) { closeMenu(); return; }
    buildMenu();
    menu.classList.remove('hidden');
    wrap.classList.add('is-open');
    document.addEventListener('click', onDocClick, true);
  });

  wrap.append(btn, menu);
  return wrap;
}

// One row: [✓] [Broad|Phrase|Exact] [term (+ ad-group select for gsc-source)]
// [vol] [impr] [clicks] [cost/pos]; confidence chip + reason on the line below.
function makeAddKwRow(r, showAdGroupSelect) {
  const row = document.createElement('div');
  row.className = 'addkw-row' + (r.include ? '' : ' addkw-row--off');

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'neg-row-check';
  cb.checked = r.include;
  cb.addEventListener('change', () => {
    r.include = cb.checked;
    row.classList.toggle('addkw-row--off', !cb.checked);
  });

  const seg = document.createElement('div');
  seg.className = 'neg-match-seg';
  NEG_MATCH_OPTS.forEach(opt => {
    const b = document.createElement('button');
    b.className = 'neg-match-opt' + (r.matchType === opt.value ? ' is-active' : '');
    b.textContent = opt.label;
    b.title = adsFormatKeyword(r.text, opt.value);
    b.addEventListener('click', () => {
      r.matchType = opt.value;
      seg.querySelectorAll('.neg-match-opt').forEach(el => el.classList.toggle('is-active', el === b));
    });
    seg.appendChild(b);
  });

  const termWrap = document.createElement('div');
  termWrap.className = 'addkw-term-wrap';
  const term = document.createElement('div');
  term.className = 'neg-row-term neg-term-link';
  term.textContent = r.text;
  term.title = `Search Google for "${r.text}"`;
  term.addEventListener('click', () => {
    browser.tabs.create({ url: `https://www.google.com/search?q=${encodeURIComponent(r.text)}` });
  });
  termWrap.appendChild(term);

  if (showAdGroupSelect) {
    termWrap.appendChild(makeAddKwAdGroupPicker(r));
  }

  const vol = document.createElement('span');
  vol.className = 'addkw-vol neg-m';
  vol.textContent = r.volume != null ? addkwFormatVolume(r.volume) : '—';
  vol.title = r.volume != null
    ? `Estimated avg monthly searches (global, English) — competition: ${(r.competition || 'unknown').toLowerCase()}`
    : 'Volume unavailable for this term';

  // Blindspot ideas have no observed-traffic history at all — show "—"
  // rather than a misleading "0" for impr/clicks/cost-or-position.
  const impr = document.createElement('span'); impr.className = 'neg-cell-impr neg-m';
  impr.textContent = r.isBlindspot ? '—' : adsNum(r.impressions);
  const clk  = document.createElement('span'); clk.className  = 'neg-cell-clk neg-m';
  clk.textContent  = r.isBlindspot ? '—' : adsNum(r.clicks);
  const last = document.createElement('span'); last.className = 'addkw-cell-last neg-m';
  last.textContent = r.isBlindspot ? '—'
    : _addkwSource === 'gsc'
      ? (r.position != null ? r.position.toFixed(1) : '—')
      : adsCost(r.cost, _adsData && _adsData.currency);

  const reason = document.createElement('div');
  reason.className = 'neg-row-reason';
  if (r.confidence) {
    const conf = document.createElement('span');
    conf.className = 'neg-conf neg-conf--' + r.confidence;
    conf.textContent = r.confidence;
    conf.title = ADDKW_CONF_HELP[r.confidence] || '';
    reason.appendChild(conf);
  }
  if (r.reason) {
    const txt = document.createElement('span');
    txt.className = 'neg-reason-text';
    txt.textContent = r.reason;
    reason.appendChild(txt);
  }

  row.append(cb, seg, termWrap, vol, impr, clk, last, reason);
  return row;
}

function renderAddKw() {
  const body = document.getElementById('addkw-body');
  if (!body) return;
  body.replaceChildren();

  const tunedEl = document.getElementById('addkw-tuned');
  if (tunedEl) {
    tunedEl.replaceChildren();
    const chips = typeof buildInsightChips === 'function' ? buildInsightChips(_addkwInsights) : null;
    if (chips) { tunedEl.appendChild(document.createTextNode('Tuned for ')); tunedEl.appendChild(chips); }
  }

  const mainRecs = (_addkwRecs || []).filter(r => !r.isBlindspot);
  const blindspotRecs = (_addkwRecs || []).filter(r => r.isBlindspot);
  const anyRecs = mainRecs.length > 0 || blindspotRecs.length > 0;

  setAddKwExportButtonsVisible(anyRecs);

  const degraded = _addkwSource === 'gsc' && !_addkwAdsAvailable;
  if (degraded) {
    setAddKwCommitVisible(false);
  } else {
    setAddKwCommitVisible(anyRecs);
    if (anyRecs) {
      const commitBtn = document.getElementById('btn-addkw-commit');
      if (commitBtn) { commitBtn.disabled = false; commitBtn.textContent = '+ to Ads'; }
    }
  }

  if (degraded) {
    const note = document.createElement('div');
    note.className = 'field-hint';
    note.textContent = 'Connect Google Ads in Settings to commit these directly — for now this is a research-only view.';
    body.appendChild(note);
  }

  // ─ From search history ─
  const mainSection = document.createElement('section');
  mainSection.className = 'field-section';
  const mainHeader = document.createElement('div');
  mainHeader.className = 'field-header';
  const mainLabel = document.createElement('span');
  mainLabel.className = 'field-label';
  mainLabel.textContent = 'FROM SEARCH HISTORY';
  mainHeader.appendChild(mainLabel);
  mainSection.appendChild(mainHeader);

  if (_addkwAlreadyTargetedCount) {
    const note = document.createElement('div');
    note.className = 'field-hint';
    note.textContent = `${_addkwAlreadyTargetedCount} suggestion${_addkwAlreadyTargetedCount === 1 ? '' : 's'} hidden — already exists as a keyword once generalized.`;
    mainSection.appendChild(note);
  }

  if (!mainRecs.length) {
    const msg = document.createElement('div');
    msg.className = 'field-hint';
    msg.textContent = 'No strong new-keyword candidates found from search history for this page right now.';
    mainSection.appendChild(msg);
  } else {
    // Flat list either way — every row gets the same ad-group picker,
    // defaulted to whichever ad group originally surfaced it (ads-source) or
    // the page's first ad group (gsc-source), but freely overridable to any
    // ad group in the account.
    const table = document.createElement('div');
    table.className = 'neg-table addkw-table';
    table.appendChild(makeAddKwTableHead());
    const showPicker = _addkwSource === 'ads' || _addkwAdsAvailable;
    mainRecs.forEach(r => table.appendChild(makeAddKwRow(r, showPicker)));
    mainSection.appendChild(table);
  }
  body.appendChild(mainSection);

  // ─ Potential Blindspots ─
  renderAddKwBlindspotSection(body, blindspotRecs);

  // Empty until a commit succeeds (renderAddKwResult fills in the summary) —
  // the export actions themselves live in the header icons now, not here.
  const exportWrap = document.createElement('div');
  exportWrap.id = 'addkw-export';
  exportWrap.className = 'field-section neg-export hidden';
  body.appendChild(exportWrap);
}

// "Potential Blindspots": keyword ideas Claude brainstorms from the page's
// own content/intent (not from any search-term or query history), kept only
// when they have real estimated volume and aren't already targeted anywhere
// in the account — i.e. gaps the advertiser hasn't reached yet.
function renderAddKwBlindspotSection(body, blindspotRecs) {
  const section = document.createElement('section');
  section.className = 'field-section';

  const header = document.createElement('div');
  header.className = 'field-header';
  const label = document.createElement('span');
  label.className = 'field-label';
  label.textContent = 'POTENTIAL BLINDSPOTS';
  header.appendChild(label);
  const info = document.createElement('button');
  info.className = 'info-tip';
  info.type = 'button';
  info.title = "Keyword ideas brainstormed from this page's content and intent, not from search history. Only kept when they have real estimated search volume and aren't already targeted anywhere in the account.";
  info.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.5"/><line x1="8" y1="7.5" x2="8" y2="11"/><circle cx="8" cy="5" r="0.55" fill="currentColor" stroke="none"/></svg>';
  header.appendChild(info);
  section.appendChild(header);
  body.appendChild(section);

  if (_addkwBlindspotLoading) {
    const msg = document.createElement('div');
    msg.className = 'field-hint';
    msg.textContent = 'Brainstorming…';
    section.appendChild(msg);
    return;
  }

  if (_addkwBlindspotError) {
    const msg = document.createElement('div');
    msg.className = 'gen-result-text is-error';
    msg.textContent = _addkwBlindspotError;
    section.appendChild(msg);
    const retry = document.createElement('button');
    retry.className = 'save-key-btn';
    retry.textContent = 'Try again';
    retry.addEventListener('click', () => generateAddKwBlindspots(true));
    section.appendChild(retry);
    return;
  }

  if (!_addkwBlindspotGenerated) {
    const btn = document.createElement('button');
    btn.className = 'adcopy-launch-btn';
    btn.textContent = 'Brainstorm Blindspots';
    btn.addEventListener('click', () => generateAddKwBlindspots(false));
    section.appendChild(btn);
    return;
  }

  if (!blindspotRecs.length) {
    const msg = document.createElement('div');
    msg.className = 'field-hint';
    msg.textContent = _addkwBlindspotSkippedCount
      ? `No blind spots found — ${_addkwBlindspotSkippedCount} idea${_addkwBlindspotSkippedCount === 1 ? '' : 's'} had no measurable search volume or ${_addkwBlindspotSkippedCount === 1 ? 'was' : 'were'} already targeted.`
      : 'No additional keyword opportunities found for this page.';
    section.appendChild(msg);
  } else {
    const table = document.createElement('div');
    table.className = 'neg-table addkw-table';
    table.appendChild(makeAddKwTableHead());
    blindspotRecs.forEach(r => table.appendChild(makeAddKwRow(r, true)));
    section.appendChild(table);
    if (_addkwBlindspotSkippedCount) {
      const note = document.createElement('div');
      note.className = 'field-hint';
      note.textContent = `${_addkwBlindspotSkippedCount} other idea${_addkwBlindspotSkippedCount === 1 ? '' : 's'} dropped — no measurable volume or already targeted.`;
      section.appendChild(note);
    }
  }

  const retry = document.createElement('button');
  retry.className = 'save-key-btn';
  retry.style.marginTop = '6px';
  retry.textContent = 'Regenerate';
  retry.addEventListener('click', () => generateAddKwBlindspots(true));
  section.appendChild(retry);
}

// Groups the currently checked rows by ad group — used for both the
// pre-commit export (any checked row, even one with no ad group resolved
// yet) and commit itself (which then filters to rows with a real adGroupId).
function addkwCurrentExportGroups() {
  const byGroup = new Map();
  (_addkwRecs || []).filter(r => r.include).forEach(r => {
    const key = r.adGroupId || '__none__';
    if (!byGroup.has(key)) byGroup.set(key, { adGroupId: r.adGroupId, adGroupName: r.adGroupName, campaignName: r.campaignName, terms: [] });
    byGroup.get(key).terms.push({ text: r.text, matchType: r.matchType });
  });
  return [...byGroup.values()];
}

// What the header export icons act on: the last committed result once one
// exists (so export reflects what's actually in Google Ads), otherwise
// whatever's currently checked (so it works pre-commit, and in degraded mode
// where there's nothing to commit at all).
function addkwExportLists() {
  return (_addkwResultGroups && _addkwResultGroups.length) ? _addkwResultGroups : addkwCurrentExportGroups();
}

async function handleAddKwExportTxt(btn) {
  const groups = addkwExportLists();
  if (!groups.length) { btn.title = 'Check at least one keyword first'; return; }
  downloadAddKwTxt(groups);
}

async function handleAddKwExportCopy(btn) {
  const groups = addkwExportLists();
  if (!groups.length) { btn.title = 'Check at least one keyword first'; return; }
  copyToClipboard(buildAddKwOutline(groups));
  btn.classList.add('is-success');
  const orig = btn.title;
  btn.title = 'Copied ✓';
  setTimeout(() => { btn.classList.remove('is-success'); btn.title = orig; }, 1500);
}

async function handleAddKwExportDoc(btn) {
  const groups = addkwExportLists();
  if (!groups.length) { btn.title = 'Check at least one keyword first'; return; }
  await exportAddKwToDoc(btn, groups);
}

// ─── Commit ────────────────────────────────────────────────────────────────

async function commitAddKw(btn) {
  if (!btn || btn.disabled) return;
  const groups = addkwCurrentExportGroups().filter(g => g.adGroupId);
  if (!groups.length) { btn.title = 'Check at least one term first (and pick an ad group, if shown)'; return; }

  btn.disabled = true;
  btn.textContent = 'Adding…';
  const exportWrap = document.getElementById('addkw-export');
  try {
    const tab = await getActiveTab();
    const res = await sendMessageWithTimeout({ action: 'adsAddKeywords', pageUrl: tab.url, groups });
    if (!res || res.connected === false) {
      throw new Error(res?.reauthRequired ? 'Google Ads connection expired — reconnect in Settings.' : 'Not connected to Google Ads.');
    }
    if (res.error) throw new Error(adsErrorMessage(res.error, res.detail));
    renderAddKwResult(res.results || [], btn);
    const anyError = (res.results || []).some(r => r.error);
    if (!anyError) clearAddKwCache();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '+ to Ads';
    btn.title = err.message;
    if (exportWrap) {
      exportWrap.classList.remove('hidden');
      exportWrap.replaceChildren();
      const e = document.createElement('div');
      e.className = 'gen-result-text is-error';
      e.textContent = err.message;
      exportWrap.appendChild(e);
    }
  }
}

// ─── Result / export ───────────────────────────────────────────────────────

// Outline format: bullet for the ad group, indented sub-bullet per keyword
// (term punctuation: term (broad) / "term" (phrase) / [term] (exact)).
// Campaign/ad-group path uses "|" here (export only — the on-screen picker
// still shows "›").
function buildAddKwOutline(groups) {
  const out = [];
  groups.forEach(g => {
    const label = g.campaignName ? `${g.campaignName} | ${g.adGroupName || 'Ad Group'}` : (g.adGroupName || 'Ad Group');
    out.push(`• Added Keywords to ${label}`);
    g.terms.forEach(t => out.push(`  ◦ ${adsFormatKeyword(t.text, t.matchType)}`));
  });
  return out.join('\n');
}

function downloadAddKwTxt(groups) {
  if (!groups.length) return;
  const now = new Date();
  const pad2 = n => String(n).padStart(2, '0');
  const fileStamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  const blob = new Blob([buildAddKwOutline(groups)], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Added-Keywords-${fileStamp}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderAddKwResult(results, commitBtn) {
  const groups = [];
  const summaryLines = [];
  let totalAdded = 0, hadError = false;
  results.forEach(r => {
    const label = r.campaignName ? `${r.campaignName} — ${r.adGroupName || 'Ad group'}` : (r.adGroupName || 'Ad group');
    if (r.error) { hadError = true; summaryLines.push(`${label}: error — ${r.error}`); return; }
    const added = r.added || [], skipped = r.skipped || [];
    totalAdded += added.length;
    if (added.length) groups.push({ adGroupId: r.adGroupId, adGroupName: r.adGroupName, campaignName: r.campaignName, terms: added });
    summaryLines.push(`${label}: ${added.length} added${skipped.length ? `, ${skipped.length} already present` : ''}`);
  });
  _addkwResultGroups = groups;
  downloadAddKwTxt(groups);

  const exportWrap = document.getElementById('addkw-export');
  if (exportWrap) {
    exportWrap.classList.remove('hidden');
    exportWrap.replaceChildren();

    const head = document.createElement('div');
    head.className = 'field-label';
    head.textContent = hadError ? 'Done (with errors)' : 'Added to Google Ads';
    exportWrap.appendChild(head);

    summaryLines.forEach(line => {
      const el = document.createElement('div');
      el.className = 'field-hint';
      el.textContent = line;
      exportWrap.appendChild(el);
    });
    // Copy/Doc/txt now live in the header icons (always visible) — they pick
    // up _addkwResultGroups automatically via addkwExportLists() above.
  }

  if (commitBtn) {
    commitBtn.textContent = totalAdded ? 'Added ✓' : (hadError ? '+ to Ads' : 'Nothing new to add');
    commitBtn.disabled = hadError ? false : true;
    setTimeout(() => { commitBtn.textContent = '+ to Ads'; commitBtn.disabled = false; }, 4000);
  }
}

// `groups` defaults to the last committed result (_addkwResultGroups) when
// called from the post-commit export row; the pre-commit export row passes
// the currently checked groups explicitly instead.
async function exportAddKwToDoc(btn, groups) {
  const useGroups = groups || _addkwResultGroups;
  if (!useGroups || !useGroups.length) return;
  let pageUrl = '';
  try { pageUrl = (pageData && pageData.canonical) || (await getActiveTab()).url; } catch { /* keep default */ }

  // Icon-only button — feedback is via title/class, not textContent (which
  // would clobber the SVG glyph).
  btn.disabled = true;
  const origTitle = btn.title;
  btn.title = 'Creating Google Doc…';

  async function attempt() {
    return sendMessageWithTimeout({ action: 'docsExportAddKeywords', groups: useGroups, pageUrl });
  }
  let res = await attempt();
  if (res && res.notConnected) {
    const auth = await sendMessageWithTimeout({ action: 'docsConnect' });
    if (!auth || auth.error) { btn.disabled = false; btn.title = 'Google Docs auth failed — try again'; setTimeout(() => { btn.title = origTitle; }, 3000); return; }
    res = await attempt();
  }
  btn.disabled = false;
  if (res && res.url) {
    browser.tabs.create({ url: res.url });
    btn.classList.add('is-success');
    btn.title = 'Opened ✓';
    setTimeout(() => { btn.classList.remove('is-success'); btn.title = origTitle; }, 3000);
  } else {
    btn.classList.add('is-error');
    btn.title = `Export failed: ${(res && res.error) || 'unknown error'}`;
    setTimeout(() => { btn.classList.remove('is-error'); btn.title = origTitle; }, 3000);
  }
}
