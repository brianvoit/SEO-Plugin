// ─── AI Action Plan: synthesize demand (GSC / Ads / Web CEO / GA4) vs. supply ──
// (page content) into evidence-backed recommendations. Lives on the Overview as
// a nav row that opens its own detail panel (like Open Graph / Structured Data).
// A single, heavier Claude call — click-to-run, cached per URL with a short TTL.

// Reasoning-heavy synthesis → the most capable model, distinct from the Haiku
// used for the lightweight page insights. Change here to trade cost for depth.
const ACTION_PLAN_MODEL = MODEL_HEAVY;
const ACTION_PLAN_TTL_MS = 60 * 60 * 1000;     // 1h — GSC data shifts; stale plans mislead
const ACTION_PLAN_RANGE = '90';                // 90-day demand window (impressions/terms)

// Tier metadata: effort label → section heading + accent class
const ACTION_PLAN_TIERS = [
  { effort: 'surgical', key: 'quick',  title: 'Quick wins' },
  { effort: 'moderate', key: 'mod',    title: 'Recommended' },
  { effort: 'rewrite',  key: 'heavy',  title: 'Heavy lift' }
];

let _actionPlan = null;          // normalized { recommendations, contentGaps }
let _actionPlanSources = null;   // { gsc, ads, webceo, ga } booleans
let _actionPlanFetchedAt = 0;
let _actionPlanLoading = false;
let _actionPlanError = '';

// ─── Data gathering (best-effort; any source may be absent) ───────────────────

async function gatherActionPlanData(tab) {
  const send = (msg) => sendMessageWithTimeout(msg).catch(() => null);
  const measurementId = (typeof gaDetectedId === 'function') ? gaDetectedId() : undefined;

  const [gsc, ads, webceo, tracked, ga] = await Promise.all([
    send({ action: 'gscGetPageData',          pageUrl: tab.url, range: ACTION_PLAN_RANGE }),
    send({ action: 'adsGetPageData',          pageUrl: tab.url, range: ACTION_PLAN_RANGE }),
    send({ action: 'webceoGetRankings',       pageUrl: tab.url, historyDepth: 2 }),
    send({ action: 'webceoGetTrackedKeywords', pageUrl: tab.url }),
    send({ action: 'gaGetPageData',           pageUrl: tab.url, range: ACTION_PLAN_RANGE, measurementId })
  ]);

  // Per-ad RSA asset ratings (Low/Good/Best) — flags weak ad copy. Best-effort;
  // batched server-side into 2 queries regardless of ad count.
  let adAssets = null;
  if (ads && ads.connected && Array.isArray(ads.ads) && ads.ads.length) {
    adAssets = await send({ action: 'adsGetAdsDetail', pageUrl: tab.url, adIds: ads.ads.map(a => a.adId) });
  }
  return { gsc, ads, webceo, tracked, ga, adAssets };
}

// GSC queries split into the two bands that drive surgical wins.
function actionPlanGscBands(gsc) {
  const queries = (gsc && gsc.connected && Array.isArray(gsc.queries)) ? gsc.queries : [];
  // Page-2 trap: already relevant (position 5–20) but stranded — sorted by reach
  const pageTwo = queries
    .filter(q => q.position >= 5 && q.position <= 20 && q.impressions >= 50)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 12);
  // Title/meta problem: lots of impressions, poor click-through
  const lowCtr = queries
    .filter(q => q.impressions >= 200 && q.ctr < 0.02 && q.position <= 15)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 8);
  return { pageTwo, lowCtr, count: queries.length };
}

// GA4 → plain behavioral facts (read-time gap, bounce, exits, channel split).
function actionPlanGaSignals(ga, wordCount) {
  if (!ga || !ga.connected || ga.error || !ga.totals) return null;
  const t = ga.totals;
  const out = {};
  if (wordCount && t.avgEngagement != null) {
    out.estReadSeconds = Math.round((wordCount / 200) * 60);   // ~200 wpm
    out.avgEngagementSeconds = Math.round(t.avgEngagement);
  }
  if (t.bounceRate != null) out.bounceRatePct = Math.round(t.bounceRate * 100);
  if (t.sessions != null) out.sessions = t.sessions;
  if (Array.isArray(ga.nextPages) && ga.nextPages.length) {
    out.nextPages = ga.nextPages.slice(0, 4).map(p => ({ path: p.path, pageviews: p.pageviews }));
  }
  if (Array.isArray(ga.channels) && ga.channels.length) {
    out.channels = ga.channels.slice(0, 5)
      .map(c => ({ channel: c.channel, sessions: c.sessions, bounceRatePct: Math.round((c.bounceRate || 0) * 100) }));
  }
  return out;
}

// Which integrations actually contributed signal (drives the Sources badges).
function actionPlanSources(g) {
  return {
    gsc:    !!(g.gsc && g.gsc.connected && Array.isArray(g.gsc.queries) && g.gsc.queries.length),
    ads:    !!(g.ads && g.ads.connected && ((g.ads.keywords && g.ads.keywords.length) || (g.ads.searchTerms && g.ads.searchTerms.length))),
    webceo: !!(g.webceo && g.webceo.connected && Array.isArray(g.webceo.rows) && g.webceo.rows.length),
    ga:     !!(g.ga && g.ga.connected && g.ga.totals && g.ga.totals.sessions)
  };
}

// ─── Intent distribution ──────────────────────────────────────────────────────

// Compute intent breakdown of all terms classified across tabs (best-effort).
// Returns { pct: {Informational:N,...}, total:N } or null if < 5 terms classified.
function computeIntentDistribution(gathered) {
  const terms = [];
  (gathered.gsc?.queries || []).forEach(q => { if (q.query) terms.push(String(q.query)); });
  (gathered.webceo?.rows || []).forEach(r => { if (r.keyword) terms.push(String(r.keyword)); });
  (gathered.ads?.searchTerms || []).forEach(t => {
    const txt = t.text || t.term;
    if (txt) terms.push(String(txt));
  });

  const counts = { Informational: 0, Navigational: 0, Commercial: 0, Transactional: 0 };
  let total = 0;
  terms.forEach(t => {
    const intent = intentOf(t);
    if (intent && Object.prototype.hasOwnProperty.call(counts, intent)) {
      counts[intent]++;
      total++;
    }
  });
  if (total < 5) return null;
  const pct = {};
  for (const [k, v] of Object.entries(counts)) pct[k] = Math.round((v / total) * 100);
  return { pct, total };
}

// ─── Prompt assembly ──────────────────────────────────────────────────────────

function actionPlanContext(g) {
  const lines = [];
  const pd = pageData || {};

  // Supply side — what's on the page
  lines.push('## PAGE (supply)');
  let pageUrl = pd.canonical || '';
  lines.push(`URL: ${pageUrl || '(unknown)'}`);
  if (pd.title) lines.push(`Title: "${pd.title.text}"`);
  if (pd.metaDescription) lines.push(`Meta description: "${pd.metaDescription.text}"`);
  if (Array.isArray(pd.headings) && pd.headings.length) {
    lines.push('Heading outline:');
    pd.headings.slice(0, 40).forEach(h => lines.push(`  ${h.tag.toUpperCase()}: ${h.text}`));
  }
  if (pd.bodyWordCount != null) lines.push(`Body word count: ${pd.bodyWordCount}`);
  const schemaTypes = (pd.structuredData || []).map(s => [].concat(s['@type'])[0]).filter(Boolean);
  lines.push(`Schema types: ${schemaTypes.length ? schemaTypes.join(', ') : 'none'}`);

  // Page insights, if Claude already labelled them (cached by loadAiInsights)
  if (g.insights) {
    lines.push(`Intent: ${g.insights.intent}; Sentiment: ${g.insights.sentiment}; Readability: ${g.insights.readability}; Audience: ${g.insights.audience}`);
  }
  if (pd.bodyTextExcerpt) lines.push(`Content excerpt: "${pd.bodyTextExcerpt}"`);

  // Demand side — what the market is asking for
  const bands = actionPlanGscBands(g.gsc);
  if (bands.pageTwo.length || bands.lowCtr.length) {
    lines.push('\n## GSC (demand — what people search; the highest-value input)');
    if (bands.pageTwo.length) {
      lines.push('Page-2 band (position 5–20, Google already finds you relevant — stranded just off page 1):');
      bands.pageTwo.forEach(q => lines.push(`  "${q.query}" — ${q.impressions} impr/period, position ${q.position.toFixed(1)}, CTR ${(q.ctr * 100).toFixed(1)}%`));
    }
    if (bands.lowCtr.length) {
      lines.push('High-impressions / low-CTR (title or meta problem, not content):');
      bands.lowCtr.forEach(q => lines.push(`  "${q.query}" — ${q.impressions} impr, position ${q.position.toFixed(1)}, CTR ${(q.ctr * 100).toFixed(1)}%`));
    }
  }

  if (g.ads && g.ads.connected) {
    const terms = (g.ads.searchTerms || []).filter(t => (t.conversions || 0) > 0)
      .sort((a, b) => b.conversions - a.conversions).slice(0, 10);
    const kws = (g.ads.keywords || []).slice(0, 10);
    // Wasted spend: paid clicks that cost money but never converted
    const wasted = (g.ads.searchTerms || [])
      .filter(t => (t.cost || 0) > 0 && (t.conversions || 0) === 0)
      .sort((a, b) => b.cost - a.cost).slice(0, 10);
    // Low quality score → usually an ad↔landing-page relevance gap
    const lowQs = (g.ads.keywords || [])
      .filter(k => k.qualityScore != null && k.qualityScore <= 4)
      .sort((a, b) => a.qualityScore - b.qualityScore).slice(0, 8);
    // Campaigns bleeding impression share to budget or rank
    const isLost = (g.ads.campaigns || [])
      .filter(c => (c.lostBudget || 0) >= 0.1 || (c.lostRank || 0) >= 0.1)
      .slice(0, 6);
    // Ad groups serving this specific page, bleeding impression share — more
    // actionable than campaign-wide IS since it's scoped to this page's traffic.
    const agIsLost = Object.entries(g.ads.adGroupImpressionShare || {})
      .filter(([, v]) => (v.lostBudget || 0) >= 0.1 || (v.lostRank || 0) >= 0.1)
      .slice(0, 6);
    // Weak ad creative: LOW-rated RSA assets
    const weakAds = [];
    const adsById = (g.adAssets && g.adAssets.ads) || {};
    (g.ads.ads || []).forEach(a => {
      const d = adsById[a.adId];
      if (!d) return;
      const lowH = (d.headlines || []).filter(h => h.label === 'LOW');
      const lowD = (d.descriptions || []).filter(x => x.label === 'LOW');
      if (lowH.length || lowD.length) weakAds.push({ ad: a, lowH, lowD });
    });

    if (terms.length || kws.length || wasted.length || lowQs.length || isLost.length || agIsLost.length || weakAds.length) {
      lines.push('\n## ADS (what you pay for — money-backed intent; paid fixes often also lift organic relevance and Quality Score)');
      const cur = g.ads.currency || '';
      const money = (n) => `${cur ? cur + ' ' : '$'}${Math.ceil(n || 0)}`;
      if (terms.length) {
        lines.push('Converting search terms (protect these):');
        terms.forEach(t => lines.push(`  "${t.text}" — ${(+t.conversions).toFixed(1)} conv, ${t.clicks} clicks`));
      }
      if (kws.length) {
        lines.push('Bid keywords:');
        kws.forEach(k => lines.push(`  "${k.text}"${k.qualityScore != null ? ` (QS ${k.qualityScore})` : ''}`));
      }
      if (wasted.length) {
        lines.push('Wasted spend — cost, zero conversions (negative-keyword / relevance candidates):');
        wasted.forEach(t => lines.push(`  "${t.text}" — ${money(t.cost)}, ${t.clicks} clicks, 0 conv`));
      }
      if (lowQs.length) {
        lines.push('Low quality-score keywords (page relevance / ad-copy gap):');
        lowQs.forEach(k => lines.push(`  "${k.text}" — QS ${k.qualityScore}`));
      }
      if (isLost.length) {
        lines.push('Campaigns losing impression share:');
        isLost.forEach(c => {
          const parts = [];
          if (c.lostBudget != null) parts.push(`${Math.round(c.lostBudget * 100)}% to budget`);
          if (c.lostRank != null) parts.push(`${Math.round(c.lostRank * 100)}% to rank`);
          lines.push(`  "${c.name}" — IS ${c.impressionShare != null ? Math.round(c.impressionShare * 100) + '%' : 'n/a'}${parts.length ? ' (lost ' + parts.join(', ') + ')' : ''}`);
        });
      }
      if (agIsLost.length) {
        lines.push('Ad groups (serving this page) losing impression share:');
        agIsLost.forEach(([adGroupId, v]) => {
          const parts = [];
          if (v.lostBudget != null) parts.push(`${Math.round(v.lostBudget * 100)}% to budget`);
          if (v.lostRank != null) parts.push(`${Math.round(v.lostRank * 100)}% to rank`);
          lines.push(`  ad group ${adGroupId} — IS ${v.impressionShare != null ? Math.round(v.impressionShare * 100) + '%' : 'n/a'}${parts.length ? ' (lost ' + parts.join(', ') + ')' : ''}`);
        });
      }
      if (weakAds.length) {
        lines.push('Weak ad creative — LOW-rated assets (rewrite candidates):');
        weakAds.slice(0, 5).forEach(w => {
          const ex = [...w.lowH.slice(0, 2).map(h => `"${h.text}"`), ...w.lowD.slice(0, 1).map(d => `"${d.text}"`)];
          lines.push(`  ${w.ad.adName || 'Ad ' + w.ad.adId}: ${w.lowH.length} headline(s), ${w.lowD.length} description(s) rated LOW — e.g. ${ex.join(', ')}`);
        });
      }
    }
  }

  if (g.webceo && g.webceo.connected && Array.isArray(g.webceo.rows) && g.webceo.rows.length) {
    lines.push('\n## WEB CEO (keywords you deliberately track)');
    // Best row per keyword (lowest current position), with trajectory
    const byKw = {};
    g.webceo.rows.forEach(r => {
      if (r.position == null || r.position <= 0) return;
      if (!byKw[r.keyword] || r.position < byKw[r.keyword].position) byKw[r.keyword] = r;
    });
    Object.values(byKw).slice(0, 15).forEach(r => {
      let traj = '';
      if (r.previous != null && r.previous > 0) {
        const delta = r.previous - r.position;     // positive = improved (lower is better)
        traj = delta === 0 ? ' (flat)' : delta > 0 ? ` (up ${delta})` : ` (down ${-delta})`;
      }
      lines.push(`  "${r.keyword}" — position ${r.position}${traj}`);
    });
  }

  const gaSig = actionPlanGaSignals(g.ga, pd.bodyWordCount);
  if (gaSig) {
    lines.push('\n## GA4 (behavior — what happens after the click)');
    if (gaSig.estReadSeconds != null) lines.push(`  Est. read time: ${gaSig.estReadSeconds}s; actual avg engagement: ${gaSig.avgEngagementSeconds}s`);
    if (gaSig.bounceRatePct != null) lines.push(`  Bounce rate: ${gaSig.bounceRatePct}%${gaSig.sessions ? ` over ${gaSig.sessions} sessions` : ''}`);
    if (gaSig.nextPages) lines.push(`  Top exits to: ${gaSig.nextPages.map(p => `${p.path} (${p.pageviews})`).join(', ')}`);
    if (gaSig.channels) lines.push(`  Channels: ${gaSig.channels.map(c => `${c.channel} ${c.sessions}s/${c.bounceRatePct}% bounce`).join(', ')}`);
  }

  // Intent distribution — only present if user has run Search/Rankings/Ads tabs first
  const intentDist = computeIntentDistribution(g);
  if (intentDist) {
    lines.push(`\n## TRAFFIC INTENT DISTRIBUTION (${intentDist.total} classified terms)`);
    ['Navigational', 'Informational', 'Commercial', 'Transactional'].forEach(intent => {
      lines.push(`- ${intent}: ${intentDist.pct[intent] || 0}%`);
    });
  }

  // E-E-A-T signals derived from page structure (always included)
  const hasAuthorSchema = (pd.structuredData || []).some(s => {
    const types = [].concat(s['@type'] || []);
    if (types.some(t => ['Person','Author'].includes(t))) return true;
    if (s.author && (s.author.name || [].concat(s.author['@type'] || []).some(t => t === 'Person'))) return true;
    return false;
  });
  lines.push('\n## E-E-A-T SIGNALS (from page structure)');
  lines.push(`- Author schema present: ${hasAuthorSchema ? 'yes' : 'no'}`);
  lines.push(`- Published date: ${pd.dates?.published || 'not found'}`);
  lines.push(`- Modified date: ${pd.dates?.modified || 'not found'}`);
  if (pd.externalLinkCount != null) lines.push(`- External links in body: ${pd.externalLinkCount}`);
  const urlPath = (pd.canonical || '').toLowerCase();
  const pathType = urlPath.includes('/blog/') || urlPath.includes('/article') ? 'blog/article'
    : urlPath.includes('/product') ? 'product'
    : urlPath.includes('/about')   ? 'about'
    : urlPath.includes('/contact') ? 'contact'
    : 'general';
  lines.push(`- URL pattern: ${pathType}`);

  return lines.join('\n');
}

const ACTION_PLAN_SYSTEM = `You are an elite SEO and answer-engine-optimization strategist. You are given a single web page's CONTENT (supply) and its DEMAND data (Google Search Console queries, Google Ads search terms/keywords, Web CEO tracked rankings, GA4 behavior). Your job is to find the gap between what the market asks for and what the page actually says, and return surgical, evidence-backed recommendations.

Rules:
- Every recommendation MUST cite specific evidence from the data provided (a query and its impressions/position, a converting term, a tracked keyword's position, a behavioral number). Never give generic advice.
- Prioritize the page-2 band (queries ranking 5–20 with real impressions) and high-impression/low-CTR queries — those are the highest-ROI fixes.
- Name content the page is missing because the market asks for it (queries, converting ad terms) but it appears nowhere in the headings.
- Use GA4 behavioral signals (read-time gap, bounce, exits) for experience/structure fixes.
- When ADS data is present, also act on it: recommend negative keywords for high-cost zero-conversion search terms; flag low quality-score keywords and tie them to landing-page relevance; flag LOW-rated ad assets as ad-copy rewrites; address campaigns losing impression share.
- effort is one of: "surgical" (minutes — tweak a title/heading/sentence), "moderate" (an hour — add a section/FAQ/schema), "rewrite" (major — reposition intent or restructure the page).
- impact is one of: "high", "medium", "low".
- channel is one of: "seo" (organic-only change), "paid" (a bid, negative-keyword, or ad-copy change), "both" (one change that helps organic relevance AND paid Quality Score — e.g. adding page content the converting paid terms demand). Prefer "both" when a single page change does double duty.
- Return 3–8 recommendations total. Order by impact within each effort tier.

Respond with ONLY a compact JSON object, no prose, no code fences, exactly:
{"recommendations":[{"change":"…","evidence":"…","effort":"surgical|moderate|rewrite","impact":"high|medium|low","channel":"seo|paid|both"}],"contentGaps":["…","…"],"intentGap":{"pageIntent":"…","trafficIntent":"…","divergence":true,"summary":"…","suggestions":["…","…","…","…","…","…","…","…"]}}
- "change": the action to take (imperative, specific).
- "evidence": the data behind it, citing the actual numbers.
- "contentGaps": short topic labels (2–4 words) the page should cover but doesn't. 0–8 items.
- "intentGap": include ONLY when TRAFFIC INTENT DISTRIBUTION is present in the input. If the page's evident purpose (from its title, headings, and content) diverges significantly from the dominant traffic intent, set "divergence":true, "pageIntent" to the intent the page targets (one of: Informational, Navigational, Commercial, Transactional), "trafficIntent" to the dominant incoming intent, "summary" to one sentence explaining the mismatch and opportunity, and "suggestions" to exactly 8 diverse keyword phrases — range from head to long-tail, no brand terms — that the page should be visible for given its actual purpose. If no significant divergence exists, omit "intentGap" entirely.
- "eeat": using the E-E-A-T SIGNALS block, assess the page's Experience/Expertise/Authoritativeness/Trustworthiness and include: "score" ("strong", "moderate", or "weak"), "signals" (array of up to 4 objects with "dimension" (one of: Experience, Expertise, Authoritativeness, Trustworthiness) and "observation" (one sentence on what you found or inferred)), and "gaps" (array of 2–4 specific actionable improvements, e.g. "Add an author bio with credentials above the fold").`;

// ─── Normalization (accept only well-formed, enum-valid recs) ─────────────────

function actionPlanParse(text) {
  let s = (text || '').replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(s); } catch { /* try to salvage a JSON object */ }
  const first = s.indexOf('{'), last = s.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(s.slice(first, last + 1)); } catch { /* give up */ }
  }
  return null;
}

const _EFFORTS = ['surgical', 'moderate', 'rewrite'];
const _IMPACTS = ['high', 'medium', 'low'];
const _CHANNELS = ['seo', 'paid', 'both'];

function normalizeActionPlan(raw) {
  if (!raw || !Array.isArray(raw.recommendations)) return null;
  const recommendations = raw.recommendations.map(r => {
    const effort = _EFFORTS.includes(String(r.effort).toLowerCase()) ? String(r.effort).toLowerCase() : 'moderate';
    const impact = _IMPACTS.includes(String(r.impact).toLowerCase()) ? String(r.impact).toLowerCase() : 'medium';
    const channel = _CHANNELS.includes(String(r.channel).toLowerCase()) ? String(r.channel).toLowerCase() : 'seo';
    const change = String(r.change || '').trim();
    const evidence = String(r.evidence || '').trim();
    return change ? { change, evidence, effort, impact, channel } : null;
  }).filter(Boolean);
  if (!recommendations.length) return null;
  const contentGaps = Array.isArray(raw.contentGaps)
    ? raw.contentGaps.map(s => String(s || '').trim()).filter(Boolean).slice(0, 8)
    : [];
  const out = { recommendations, contentGaps };
  if (raw.intentGap && raw.intentGap.divergence === true && Array.isArray(raw.intentGap.suggestions)) {
    out.intentGap = {
      pageIntent:    String(raw.intentGap.pageIntent    || '').trim(),
      trafficIntent: String(raw.intentGap.trafficIntent || '').trim(),
      summary:       String(raw.intentGap.summary       || '').trim(),
      suggestions:   raw.intentGap.suggestions.slice(0, 8).map(s => String(s || '').trim()).filter(Boolean)
    };
  }
  if (raw.eeat && raw.eeat.score) {
    const EEAT_SCORES = ['strong', 'moderate', 'weak'];
    out.eeat = {
      score:   EEAT_SCORES.includes(String(raw.eeat.score).toLowerCase()) ? String(raw.eeat.score).toLowerCase() : 'moderate',
      signals: (Array.isArray(raw.eeat.signals) ? raw.eeat.signals : []).slice(0, 4).map(s => ({
        dimension:   String(s.dimension   || '').trim(),
        observation: String(s.observation || '').trim()
      })).filter(s => s.dimension && s.observation),
      gaps: (Array.isArray(raw.eeat.gaps) ? raw.eeat.gaps : []).slice(0, 4).map(s => String(s || '').trim()).filter(Boolean)
    };
  }
  return out;
}

// ─── Main entry: generate (or render from cache) ──────────────────────────────

async function loadActionPlan(forceRefresh = false) {
  if (_actionPlanLoading) return;

  if (!pageData) { _actionPlanError = 'No page data — open this on a regular web page.'; renderActionPlanPanel(); return; }

  const { claudeApiKey } = await browser.storage.local.get('claudeApiKey');
  if (!claudeApiKey) { _actionPlanError = 'Add a Claude API key in Settings to generate an action plan.'; renderActionPlanPanel(); return; }

  const tab = await getActiveTab();
  const cacheKey = (tab.url || '').split('#')[0];

  const { actionPlanCache } = await browser.storage.local.get('actionPlanCache');
  const cache = actionPlanCache || {};
  const cached = cache[cacheKey];
  if (!forceRefresh && cached && (Date.now() - cached.fetchedAt < ACTION_PLAN_TTL_MS)) {
    _actionPlan = cached.plan;
    _actionPlanSources = cached.sources;
    _actionPlanFetchedAt = cached.fetchedAt;
    _actionPlanError = '';
    renderActionPlanPanel();
    refreshActionPlanNav();
    return;
  }

  _actionPlanLoading = true;
  _actionPlanError = '';
  renderActionPlanPanel();

  try {
    const gathered = await gatherActionPlanData(tab);

    // Pull the four page insights from the same cache loadAiInsights writes to
    try {
      const { aiInsightsCache } = await browser.storage.local.get('aiInsightsCache');
      const ins = aiInsightsCache && aiInsightsCache[cacheKey];
      if (ins && ins.intent) gathered.insights = ins;
    } catch { /* insights are optional */ }

    const sources = actionPlanSources(gathered);
    const context = actionPlanContext(gathered);

    const data = await claudeFetch({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeApiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: ACTION_PLAN_MODEL,
        max_tokens: 4096,
        system: [{ type: 'text', text: ACTION_PLAN_SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: context }]
      })
    });
    const plan = normalizeActionPlan(actionPlanParse(data.content?.[0]?.text));
    if (!plan) throw new Error('Could not parse a plan from the response.');

    _actionPlan = plan;
    _actionPlanSources = sources;
    _actionPlanFetchedAt = Date.now();

    cache[cacheKey] = { plan, sources, fetchedAt: _actionPlanFetchedAt };
    const keys = Object.keys(cache);
    if (keys.length > 20) {
      keys.sort((a, b) => cache[a].fetchedAt - cache[b].fetchedAt);
      keys.slice(0, keys.length - 20).forEach(k => delete cache[k]);
    }
    browser.storage.local.set({ actionPlanCache: cache });
  } catch (err) {
    _actionPlanError = err.message;
  } finally {
    _actionPlanLoading = false;
    renderActionPlanPanel();
    refreshActionPlanNav();
  }
}

// Hydrate the nav-row status from cache without generating (called on page load).
async function hydrateActionPlanNav() {
  try {
    const tab = await getActiveTab();
    const cacheKey = (tab.url || '').split('#')[0];
    const { actionPlanCache } = await browser.storage.local.get('actionPlanCache');
    const cached = actionPlanCache && actionPlanCache[cacheKey];
    if (cached && (Date.now() - cached.fetchedAt < ACTION_PLAN_TTL_MS)) {
      _actionPlan = cached.plan;
      _actionPlanSources = cached.sources;
      _actionPlanFetchedAt = cached.fetchedAt;
    } else {
      _actionPlan = null;
    }
  } catch { _actionPlan = null; }
  refreshActionPlanNav();
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function actionPlanAgo(ts) {
  if (!ts) return '';
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function actionPlanRecCard(rec) {
  const card = document.createElement('div');
  card.className = `ap-rec ap-rec--${rec.effort}`;

  const top = document.createElement('div');
  top.className = 'ap-rec-top';
  const change = document.createElement('div');
  change.className = 'ap-rec-change';
  change.textContent = rec.change;
  top.appendChild(change);

  const tags = document.createElement('div');
  tags.className = 'ap-rec-tags';
  const channel = rec.channel || 'seo';
  const chTag = document.createElement('span');
  chTag.className = `ap-tag ap-channel--${channel}`;
  chTag.textContent = channel === 'both' ? 'SEO + Paid' : channel === 'paid' ? 'Paid' : 'SEO';
  tags.appendChild(chTag);
  const effortTag = document.createElement('span');
  effortTag.className = `ap-tag ap-tag--${rec.effort}`;
  effortTag.textContent = rec.effort;
  tags.appendChild(effortTag);
  const impactTag = document.createElement('span');
  impactTag.className = `ap-tag ap-tag-impact--${rec.impact}`;
  impactTag.textContent = rec.impact;
  tags.appendChild(impactTag);
  top.appendChild(tags);
  card.appendChild(top);

  if (rec.evidence) {
    const ev = document.createElement('div');
    ev.className = 'ap-rec-evidence';
    ev.textContent = rec.evidence;
    card.appendChild(ev);
  }
  return card;
}

function renderActionPlanPanel() {
  const root = document.getElementById('actionplan-content');
  if (!root) return;
  root.replaceChildren();

  // Loading
  if (_actionPlanLoading) {
    const sec = document.createElement('section');
    sec.className = 'field-section ap-center';
    sec.appendChild(svgFromString('<svg class="ap-spinner" viewBox="0 0 16 16" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M14 8A6 6 0 1 1 8 2"/></svg>'));
    root.appendChild(sec);
    return;
  }

  // Error
  if (_actionPlanError) {
    const sec = document.createElement('section');
    sec.className = 'field-section';
    const msg = document.createElement('div');
    msg.className = 'field-hint hint-red';
    msg.textContent = _actionPlanError;
    sec.appendChild(msg);
    if (/Claude API key/.test(_actionPlanError)) {
      const btn = document.createElement('button');
      btn.className = 'save-key-btn';
      btn.style.marginTop = '8px';
      btn.textContent = 'Open Settings';
      btn.addEventListener('click', showSettings);
      sec.appendChild(btn);
    }
    root.appendChild(sec);
    return;
  }

  if (!_actionPlan) return;   // panel opened but generation hasn't happened yet

  // Sources + refresh + timestamp
  const head = document.createElement('section');
  head.className = 'field-section';
  const headRow = document.createElement('div');
  headRow.className = 'field-header';
  const label = document.createElement('span');
  label.className = 'field-label';
  label.textContent = 'Sources';
  headRow.appendChild(label);

  const right = document.createElement('div');
  right.className = 'ap-head-right';
  const stamp = document.createElement('span');
  stamp.className = 'ap-stamp';
  stamp.textContent = `generated ${actionPlanAgo(_actionPlanFetchedAt)}`;
  right.appendChild(stamp);

  // Refresh — same glyph as the app-header refresh (next to the wrench)
  const refresh = document.createElement('button');
  refresh.className = 'icon-btn';
  refresh.title = 'Regenerate the plan';
  refresh.appendChild(svgFromString('<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8A5.5 5.5 0 1 1 8 2.5a5.5 5.5 0 0 1 3.9 1.6L13.5 5.6"/><polyline points="13.5 2 13.5 5.6 9.9 5.6"/></svg>'));
  refresh.addEventListener('click', () => loadActionPlan(true));
  right.appendChild(refresh);

  // Export the recommendations to an RTF file
  const exportBtn = document.createElement('button');
  exportBtn.className = 'icon-btn';
  exportBtn.title = 'Export recommendations (.rtf)';
  exportBtn.appendChild(svgFromString('<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8"/><polyline points="5 7 8 10 11 7"/><path d="M3 12.5h10"/></svg>'));
  exportBtn.addEventListener('click', exportActionPlanRtf);
  right.appendChild(exportBtn);

  // Export the recommendations to a Google Doc
  const docsBtn = document.createElement('button');
  docsBtn.className = 'icon-btn';
  docsBtn.title = 'Export to Google Doc';
  docsBtn.appendChild(svgFromString('<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="1.5" width="10" height="13" rx="1.5"/><line x1="5.5" y1="5.5" x2="10.5" y2="5.5"/><line x1="5.5" y1="8" x2="10.5" y2="8"/><line x1="5.5" y1="10.5" x2="8.5" y2="10.5"/></svg>'));
  docsBtn.addEventListener('click', () => exportToGoogleDocs(docsBtn));
  right.appendChild(docsBtn);

  headRow.appendChild(right);
  head.appendChild(headRow);

  const badges = document.createElement('div');
  badges.className = 'ap-sources';
  [['gsc', 'GSC'], ['ads', 'Ads'], ['webceo', 'Ranking'], ['ga', 'GA4']].forEach(([k, lbl]) => {
    const b = document.createElement('span');
    const on = _actionPlanSources && _actionPlanSources[k];
    b.className = 'ap-src' + (on ? ' ap-src--on' : ' ap-src--off');
    b.textContent = on ? lbl : `${lbl} not used`;
    badges.appendChild(b);
  });
  head.appendChild(badges);
  root.appendChild(head);

  // Three tiers
  ACTION_PLAN_TIERS.forEach(tier => {
    const recs = _actionPlan.recommendations.filter(r => r.effort === tier.effort);
    if (!recs.length) return;
    const sec = document.createElement('section');
    sec.className = 'field-section';
    const h = document.createElement('div');
    h.className = 'field-header';
    const lbl = document.createElement('span');
    lbl.className = 'field-label';
    lbl.textContent = tier.title;
    h.appendChild(lbl);
    sec.appendChild(h);
    const list = document.createElement('div');
    list.className = 'ap-rec-list';
    recs.forEach(r => list.appendChild(actionPlanRecCard(r)));
    sec.appendChild(list);
    root.appendChild(sec);
  });

  // Content gaps (inert chips)
  if (_actionPlan.contentGaps.length) {
    const sec = document.createElement('section');
    sec.className = 'field-section';
    const h = document.createElement('div');
    h.className = 'field-header';
    const lbl = document.createElement('span');
    lbl.className = 'field-label';
    lbl.textContent = 'Content gaps';
    h.appendChild(lbl);
    sec.appendChild(h);
    const chips = document.createElement('div');
    chips.className = 'ap-gaps';
    _actionPlan.contentGaps.forEach(g => {
      const c = document.createElement('span');
      c.className = 'ap-gap';
      c.textContent = g;
      chips.appendChild(c);
    });
    sec.appendChild(chips);
    root.appendChild(sec);
  }

  // Intent gap — phrase suggestions when page purpose ≠ dominant traffic intent
  const gap = _actionPlan.intentGap;
  if (gap && gap.suggestions && gap.suggestions.length) {
    const intentClassMap = { Informational: 'info', Commercial: 'commercial', Transactional: 'transactional', Navigational: 'navigational' };
    const sec = document.createElement('section');
    sec.className = 'field-section';

    const h = document.createElement('div');
    h.className = 'field-header';
    const lbl = document.createElement('span');
    lbl.className = 'field-label';
    lbl.textContent = 'Intent gap';
    h.appendChild(lbl);
    sec.appendChild(h);

    const match = document.createElement('div');
    match.className = 'ap-intent-match';
    if (gap.pageIntent) {
      const b = document.createElement('span');
      b.className = `ap-intent-badge ap-intent-badge--${intentClassMap[gap.pageIntent] || ''}`;
      b.textContent = `Page: ${gap.pageIntent}`;
      match.appendChild(b);
    }
    const arrow = document.createElement('span');
    arrow.className = 'ap-intent-arrow';
    arrow.textContent = '→';
    match.appendChild(arrow);
    if (gap.trafficIntent) {
      const b = document.createElement('span');
      b.className = `ap-intent-badge ap-intent-badge--${intentClassMap[gap.trafficIntent] || ''}`;
      b.textContent = `Traffic: ${gap.trafficIntent}`;
      match.appendChild(b);
    }
    sec.appendChild(match);

    if (gap.summary) {
      const summary = document.createElement('p');
      summary.className = 'ap-intent-summary';
      summary.textContent = gap.summary;
      sec.appendChild(summary);
    }

    const suggChips = document.createElement('div');
    suggChips.className = 'ap-suggestion-chips';
    gap.suggestions.forEach(kw => {
      const chip = document.createElement('button');
      chip.className = 'ap-suggestion-chip';
      chip.textContent = kw;
      chip.addEventListener('click', () => {
        window.open('https://www.google.com/search?q=' + encodeURIComponent(kw), '_blank');
      });
      suggChips.appendChild(chip);
    });
    sec.appendChild(suggChips);
    root.appendChild(sec);
  }

  // E-E-A-T signals
  const eeat = _actionPlan.eeat;
  if (eeat && eeat.score) {
    const sec = document.createElement('section');
    sec.className = 'field-section';
    const h = document.createElement('div');
    h.className = 'field-header';
    const lbl = document.createElement('span');
    lbl.className = 'field-label';
    lbl.textContent = 'E-E-A-T SIGNALS';
    const scoreBadge = document.createElement('span');
    scoreBadge.className = `ap-eeat-score ap-eeat-score--${eeat.score}`;
    scoreBadge.textContent = eeat.score.charAt(0).toUpperCase() + eeat.score.slice(1);
    h.appendChild(lbl);
    h.appendChild(scoreBadge);
    sec.appendChild(h);

    if (eeat.signals && eeat.signals.length) {
      const grid = document.createElement('div');
      grid.className = 'ap-eeat-signals';
      eeat.signals.forEach(s => {
        const row = document.createElement('div');
        row.className = 'ap-eeat-signal-row';
        const dim = document.createElement('span');
        dim.className = 'ap-eeat-dimension';
        dim.textContent = s.dimension;
        const obs = document.createElement('span');
        obs.className = 'ap-eeat-observation';
        obs.textContent = s.observation;
        row.append(dim, obs);
        grid.appendChild(row);
      });
      sec.appendChild(grid);
    }

    if (eeat.gaps && eeat.gaps.length) {
      const gapsHeader = document.createElement('div');
      gapsHeader.className = 'ap-eeat-gaps-label';
      gapsHeader.textContent = 'Improvements';
      sec.appendChild(gapsHeader);
      const gapsList = document.createElement('ul');
      gapsList.className = 'ap-eeat-gaps';
      eeat.gaps.forEach(g => {
        const li = document.createElement('li');
        li.textContent = g;
        gapsList.appendChild(li);
      });
      sec.appendChild(gapsList);
    }

    root.appendChild(sec);
  }
}

// ─── Export to RTF ────────────────────────────────────────────────────────────

// RTF is 7-bit ASCII: escape control chars and emit non-ASCII as \uN escapes.
function rtfEscape(s) {
  let out = '';
  for (const ch of String(s)) {
    if (ch === '\\') out += '\\\\';
    else if (ch === '{') out += '\\{';
    else if (ch === '}') out += '\\}';
    else if (ch === '\n') out += '\\par ';
    else {
      const code = ch.codePointAt(0);
      out += code > 127 ? `\\u${code > 32767 ? code - 65536 : code}?` : ch;
    }
  }
  return out;
}

async function exportToGoogleDocs(btn) {
  if (!_actionPlan) return;
  let pageUrl = '';
  try { pageUrl = (pageData && pageData.canonical) || (await getActiveTab()).url; } catch { /* keep default */ }

  const originalLabel = btn.innerHTML;
  btn.disabled = true;
  btn.title = 'Creating Google Doc…';

  async function attempt() {
    return sendMessageWithTimeout({
      action: 'docsExportActionPlan',
      plan: _actionPlan,
      pageUrl,
      fetchedAt: _actionPlanFetchedAt
    });
  }

  let res = await attempt();

  if (res && res.notConnected) {
    const auth = await sendMessageWithTimeout({ action: 'docsConnect' });
    if (!auth || auth.error) {
      btn.disabled = false;
      btn.title = 'Google Docs auth failed — try again';
      return;
    }
    res = await attempt();
  }

  btn.disabled = false;

  if (res && res.url) {
    browser.tabs.create({ url: res.url });
    btn.innerHTML = '';
    btn.appendChild(svgFromString('<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 8 6 12 14 4"/></svg>'));
    btn.classList.add('is-success');
    btn.title = 'Opened in Google Docs';
    setTimeout(() => {
      btn.innerHTML = '';
      btn.appendChild(svgFromString('<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="1.5" width="10" height="13" rx="1.5"/><line x1="5.5" y1="5.5" x2="10.5" y2="5.5"/><line x1="5.5" y1="8" x2="10.5" y2="8"/><line x1="5.5" y1="10.5" x2="8.5" y2="10.5"/></svg>'));
      btn.classList.remove('is-success');
      btn.title = 'Export to Google Doc';
    }, 3000);
  } else {
    btn.title = `Export failed: ${(res && res.error) || 'unknown error'}`;
  }
}

async function exportActionPlanRtf() {
  if (!_actionPlan) return;

  let host = 'page';
  try { host = new URL((pageData && pageData.canonical) || (await getActiveTab()).url).hostname.replace(/^www\./, ''); } catch { /* keep default */ }

  const parts = [];
  parts.push(`{\\b\\fs32 Action Plan}\\par {\\fs18 ${rtfEscape(host)} \\u8212? generated ${rtfEscape(new Date(_actionPlanFetchedAt || Date.now()).toLocaleString())}}\\par\\par`);

  ACTION_PLAN_TIERS.forEach(tier => {
    const recs = _actionPlan.recommendations.filter(r => r.effort === tier.effort);
    if (!recs.length) return;
    parts.push(`{\\b\\fs26 ${rtfEscape(tier.title)}}\\par`);
    recs.forEach(r => {
      const ch = r.channel === 'both' ? 'SEO + Paid' : r.channel === 'paid' ? 'Paid' : 'SEO';
      parts.push(`{\\b ${rtfEscape(r.change)}}  {\\i [${rtfEscape(r.effort)} \\u183? ${rtfEscape(r.impact)} impact \\u183? ${rtfEscape(ch)}]}\\par`);
      if (r.evidence) parts.push(`${rtfEscape(r.evidence)}\\par`);
      parts.push('\\par');
    });
  });

  if (_actionPlan.contentGaps.length) {
    parts.push(`{\\b\\fs26 Content gaps}\\par`);
    parts.push(`${rtfEscape(_actionPlan.contentGaps.join(', '))}\\par`);
  }

  const gap = _actionPlan.intentGap;
  if (gap && gap.suggestions && gap.suggestions.length) {
    parts.push(`\\par{\\b\\fs26 Intent gap}\\par`);
    parts.push(`Page: ${rtfEscape(gap.pageIntent)}  \\u8594?  Traffic: ${rtfEscape(gap.trafficIntent)}\\par`);
    if (gap.summary) parts.push(`${rtfEscape(gap.summary)}\\par`);
    parts.push(`\\par Phrase suggestions:\\par ${rtfEscape(gap.suggestions.join(' / '))}\\par`);
  }

  const eeat = _actionPlan.eeat;
  if (eeat && eeat.score) {
    parts.push(`\\par{\\b\\fs26 E-E-A-T Signals}\\par`);
    parts.push(`Score: ${rtfEscape(eeat.score.charAt(0).toUpperCase() + eeat.score.slice(1))}\\par`);
    (eeat.signals || []).forEach(s => {
      parts.push(`{\\b ${rtfEscape(s.dimension)}:} ${rtfEscape(s.observation)}\\par`);
    });
    if (eeat.gaps && eeat.gaps.length) {
      parts.push(`\\par Improvements:\\par`);
      eeat.gaps.forEach(g => parts.push(`\\u8226? ${rtfEscape(g)}\\par`));
    }
  }

  const rtf = `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Helvetica;}}\\f0\\fs22 ${parts.join('')}}`;
  const blob = new Blob([rtf], { type: 'application/rtf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `action-plan-${host}.rtf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Set the nav-row state on the Overview + Ads tabs ("N recs" once generated)
function refreshActionPlanNav() {
  const n = (_actionPlan && _actionPlan.recommendations.length) || 0;
  ['actionplan-status', 'ads-actionplan-status'].forEach(id => {
    const status = document.getElementById(id);
    if (!status) return;
    status.textContent = n ? `${n} recs` : '';
    status.classList.toggle('hidden', !n);
  });
}
