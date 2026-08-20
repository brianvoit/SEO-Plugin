// ─── AI Action Plan: synthesize demand (GSC / Ads / Web CEO / GA4) vs. supply ──
// (page content) into evidence-backed recommendations. Three variants, one per
// tab, each its own detail panel entry and its own heavier Claude call —
// click-to-run, cached per (variant, URL) with a short TTL.
//
//   overview — the master plan: organic AND paid, best of both
//   seo      — on-page/organic only (Search tab)
//   paid     — Google Ads only (Ads tab)
//
// All three receive the IDENTICAL context. Only the system prompt differs.
// That is deliberate: organic queries inform paid targeting, and page speed is
// a real Ads landing-page-experience factor, so no source is dead weight on any
// variant. It also means there is exactly one context builder to maintain.

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

const ACTION_PLAN_VARIANTS = ['overview', 'seo', 'paid'];
const ACTION_PLAN_META = {
  overview: { title: 'Action Plan',      navId: 'actionplan-status',     slug: 'full' },
  seo:      { title: 'SEO Action Plan',  navId: 'gsc-actionplan-status', slug: 'seo'  },
  paid:     { title: 'Paid Action Plan', navId: 'ads-actionplan-status', slug: 'paid' }
};

// Per-variant state. Keyed by variant so opening the SEO plan can never
// overwrite the Overview plan already on screen behind it.
const _apState = {};
ACTION_PLAN_VARIANTS.forEach(v => {
  _apState[v] = { plan: null, sources: null, fetchedAt: 0, loading: false, error: '' };
});

// Which variant the shared panel is currently showing.
let _apVariant = 'overview';
const apCur = () => _apState[_apVariant];

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
  let negatives = null;
  if (ads && ads.connected && Array.isArray(ads.ads) && ads.ads.length) {
    // The negatives read is what stops the Paid plan recommending an exclusion
    // that is already in place. Scoped to the campaigns and ad groups actually
    // serving this page — the same set every other Ads figure in the prompt is
    // drawn from — so it stays one small query set rather than an account dump.
    [adAssets, negatives] = await Promise.all([
      send({ action: 'adsGetAdsDetail', pageUrl: tab.url, adIds: ads.ads.map(a => a.adId) }),
      send({
        action: 'adsGetNegatives', pageUrl: tab.url,
        campaignIds: [...new Set(ads.ads.map(a => a.campaignId).filter(Boolean))],
        adGroupIds:  [...new Set(ads.ads.map(a => a.adGroupId).filter(Boolean))]
      })
    ]);
  }

  // What the copy actually says, as n-gram counts. Read straight from the
  // content script rather than from the Keyword Phrases panel's state, so the
  // plan gets this whether or not the user has ever opened that panel.
  let phrases = null;
  try { phrases = await browser.tabs.sendMessage(tab.id, { action: 'getKeywordPhrases' }, TOP_FRAME); }
  catch { phrases = null; }

  // Technical / authority signals, CACHE-ONLY on purpose. A PSI run takes many
  // seconds and the two Web CEO calls cost quota, so generating a plan must
  // never trigger any of them. If the user has already opened PageSpeed, Site
  // Audit or Backlinks for this page, the plan is richer for free; if not, it
  // simply goes without and says nothing about them.
  const [psi, audit, backlinks] = await Promise.all([
    send({ action: 'psiGetPageSpeed',    url: tab.url, strategy: 'mobile', cacheOnly: true }),
    send({ action: 'webceoGetSiteAudit', pageUrl: tab.url, cacheOnly: true }),
    send({ action: 'webceoGetBacklinks', pageUrl: tab.url, cacheOnly: true })
  ]);

  // Trust signals + the client's gating profile, run through the E-E-A-T rule
  // engine here rather than in the prompt: the engine decides what is
  // actionable, and the model only phrases what it allowed.
  let trustSignals = null;
  try { trustSignals = await browser.tabs.sendMessage(tab.id, { action: 'getTrustSignals' }, TOP_FRAME); }
  catch { trustSignals = null; }

  let trustClient = null;
  try {
    const host = new URL(tab.url).hostname.replace(/^www\./, '').toLowerCase();
    const found = await send({ action: 'clientRegistryFindByDomain', domain: host });
    trustClient = (found && found.client) || null;
  } catch { trustClient = null; }

  // No signals means no engine run — a page we could not read must produce no
  // trust findings at all rather than a set derived from nothing.
  const trust = (trustSignals && !trustSignals._readError && typeof evaluateTrustRules === 'function')
    ? evaluateTrustRules(trustSignals, trustClient)
    : null;

  return { gsc, ads, webceo, tracked, ga, adAssets, negatives, phrases, psi, audit, backlinks, trust };
}

// GSC queries split into the two bands that drive surgical wins.
// What CTR a position should earn, from the same curve the Web CEO visibility
// score uses. Two things matter here:
//   * GSC positions are fractional averages (6.9) and the curve is integer
//     indexed, so an unrounded lookup silently returns undefined.
//   * typeof-guarded, per the house rule for calling across popup files.
function actionPlanExpectedCtr(position) {
  if (typeof webceoCtrForPosition !== 'function') return 0;
  if (position == null || position <= 0) return 0;
  return webceoCtrForPosition(Math.round(position)) || 0;
}

// A query is a snippet problem only if it earns materially less than its
// POSITION would predict. A flat threshold cannot tell those apart: at
// position 7 a 0.4% CTR is a tenth of par and genuinely broken, while at
// position 13 a 1.2% CTR is slightly ABOVE par and has nothing wrong with its
// snippet at all — it has a ranking problem. The old `ctr < 0.02` rule flagged
// both, so every page-two keyword read as a title/meta failure.
const LOW_CTR_PAR_RATIO = 0.5;      // "less than half the clicks its position should earn"
const LOW_CTR_MAX_POS = 20;         // past page two, CTR is too small to reason about

function actionPlanGscBands(gsc) {
  const queries = (gsc && gsc.connected && Array.isArray(gsc.queries)) ? gsc.queries : [];
  // Page-2 trap: already relevant (position 5–20) but stranded — sorted by reach
  const pageTwo = queries
    .filter(q => q.position >= 5 && q.position <= 20 && q.impressions >= 50)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 12);
  // Genuine snippet problem: enough impressions to be meaningful, and well
  // under the CTR its position predicts. The expectation travels with the row
  // so the prompt can state the gap instead of the model inferring one.
  const lowCtr = queries
    .map(q => ({ ...q, expectedCtr: actionPlanExpectedCtr(q.position) }))
    .filter(q => q.impressions >= 200
      && q.position <= LOW_CTR_MAX_POS
      && q.expectedCtr > 0
      && q.ctr < q.expectedCtr * LOW_CTR_PAR_RATIO)
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

// The top phrases per n-gram length, compacted to one line each. Capped hard:
// this is supporting evidence in an already-long prompt, not the main event.
function actionPlanPhraseLines(phrases) {
  const tables = phrases && phrases.tables;
  if (!tables) return [];
  const out = [];
  [1, 2, 3, 4].forEach(n => {
    const top = (tables[n] || []).slice(0, 8);
    if (!top.length) return;
    const parts = top.map(p => {
      const where = (p.chips || []).length ? ` [${p.chips.join(',')}]` : '';
      return `"${p.phrase}" ×${p.count}${where}`;
    });
    out.push(`  ${n}-word: ${parts.join('; ')}`);
  });
  return out;
}

// Technical + authority signals, all read from cache only (see
// gatherActionPlanData). Any of the three may legitimately be absent — the
// block simply shrinks or disappears rather than claiming "no data", because
// "not fetched" and "genuinely zero" are very different things and telling the
// model the wrong one produces confident nonsense.
function actionPlanTechLines(g) {
  const lines = [];

  const psi = g.psi;
  if (psi && !psi.error && !psi.notCached && psi.performanceScore != null) {
    const bits = [`Performance score: ${psi.performanceScore}/100 (mobile)`];
    if (psi.field && psi.field.metrics) {
      const f = Object.entries(psi.field.metrics)
        .filter(([, m]) => m && m.category)
        .map(([name, m]) => `${name} ${m.category}`);
      if (f.length) bits.push(`Field (CrUX${psi.field.origin ? ', origin-level' : ''}): ${f.join(', ')}`);
    }
    lines.push('\n## CORE WEB VITALS (PageSpeed Insights)');
    bits.forEach(b => lines.push(`  ${b}`));
    (psi.opportunities || []).slice(0, 4).forEach(o => {
      if (o.ms > 0) lines.push(`  Opportunity: ${o.title} — est. ${o.ms}ms`);
    });
  }

  const audit = g.audit;
  if (audit && audit.connected && !audit.error && !audit.notCached) {
    const canonical = (pageData && pageData.canonical) || '';
    const norm = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '').toLowerCase();
    const page = (audit.pages || []).find(p => norm(p.url) === norm(canonical));
    const out = [];
    if (audit.siteOptimization != null) out.push(`  Site optimization: ${audit.siteOptimization}%`);
    if (audit.brokenLinks) out.push(`  Broken links site-wide: ${audit.brokenLinks}`);
    if (page) {
      if (page.optimization != null) out.push(`  This page's optimization: ${page.optimization}%`);
      const probs = [...(page.generalProblems || []), ...(page.landingProblems || [])];
      if (probs.length) out.push(`  This page's flagged problems: ${probs.slice(0, 12).join(', ')}`);
      if (page.brokenCount) out.push(`  Broken links on this page: ${page.brokenCount}`);
    }
    if (out.length) {
      lines.push('\n## SITE AUDIT (Web CEO crawl — technical SEO)');
      lines.push(...out);
    }
  }

  const bl = g.backlinks;
  if (bl && bl.connected && !bl.error && !bl.notCached && bl.referringDomains != null) {
    lines.push('\n## BACKLINKS (authority)');
    lines.push(`  Site: ${bl.referringDomains} referring domains, ${bl.total} links (${bl.nofollow} nofollow), max Trust Flow ${bl.maxTF ?? 'n/a'}`);
    // Toxic-link counts are deliberately NOT passed. Google states it ignores
    // the overwhelming majority of spam links, disavow-first advice is long out
    // of date, and pruning them is expensive work — so a count in the prompt
    // reliably bought a confident "disavow 876 links" recommendation that was
    // not worth anyone's time. The Backlinks panel still shows the number.
    const tp = bl.thisPage;
    if (tp) {
      lines.push(`  THIS PAGE specifically: ${tp.referringDomains} referring domains, ${tp.total} links`);
      // A page with no links of its own is an internal-linking problem before
      // it is an outreach problem — worth the model knowing the difference.
      if (!tp.total) lines.push('  (this page has no inbound links of its own)');
    }
  }

  return lines;
}

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

  // The page's own vocabulary, counted. The excerpt above shows how the page
  // opens; this shows what it actually dwells on across the whole body, which
  // is what a "you rank for X but barely say it" recommendation needs.
  const phraseLines = actionPlanPhraseLines(g.phrases);
  if (phraseLines.length) {
    lines.push('\nPage vocabulary (n-gram counts over body copy, nav/footer excluded; [] marks where it also appears):');
    lines.push(...phraseLines);
  }

  // Demand side — what the market is asking for
  const bands = actionPlanGscBands(g.gsc);
  if (bands.pageTwo.length || bands.lowCtr.length) {
    lines.push('\n## GSC (demand — what people search; the highest-value input)');
    if (bands.pageTwo.length) {
      lines.push('Page-2 band (position 5–20, Google already finds you relevant — stranded just off page 1):');
      bands.pageTwo.forEach(q => lines.push(`  "${q.query}" — ${q.impressions} impr/period, position ${q.position.toFixed(1)}, CTR ${(q.ctr * 100).toFixed(1)}%`));
    }
    if (bands.lowCtr.length) {
      lines.push('Underperforming the CTR their POSITION predicts (a snippet problem — title/meta, not content).');
      lines.push('Every row here is already position-adjusted: a query is only listed if it earns less than half what its position should.');
      bands.lowCtr.forEach(q => lines.push(
        `  "${q.query}" — ${q.impressions} impr, position ${q.position.toFixed(1)}, ` +
        `CTR ${(q.ctr * 100).toFixed(1)}% vs ~${(q.expectedCtr * 100).toFixed(1)}% typical at that position`));
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

    const negCount = ((g.negatives && g.negatives.negatives) || []).length;
    if (terms.length || kws.length || wasted.length || lowQs.length || isLost.length || agIsLost.length || weakAds.length || negCount) {
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
      // Immediately after wasted spend, because that is the list the model is
      // about to propose negatives from, and this is what it must check first.
      const negs = (g.negatives && g.negatives.negatives) || [];
      if (negs.length) {
        lines.push(`Negative keywords ALREADY in place (${negs.length}) — do NOT recommend adding any of these again:`);
        negs.slice(0, 60).forEach(n => {
          const where = n.where && n.where.length ? ` — ${n.scope}: ${n.where.slice(0, 2).join(', ')}` : ` — ${n.scope}`;
          lines.push(`  "${n.text}" [${n.matchType}]${where}`);
        });
        if (negs.length > 60) lines.push(`  …and ${negs.length - 60} more already excluded.`);
      } else if (g.negatives && g.negatives.connected && !g.negatives.error) {
        // Saying so explicitly matters: silence here would be indistinguishable
        // from "we could not read them", and the model would hedge.
        lines.push('Negative keywords already in place: none. Every negative below would be new.');
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

  lines.push(...actionPlanTechLines(g));

  // Intent distribution — only present if user has run Search/Rankings/Ads tabs first
  const intentDist = computeIntentDistribution(g);
  if (intentDist) {
    lines.push(`\n## TRAFFIC INTENT DISTRIBUTION (${intentDist.total} classified terms)`);
    ['Navigational', 'Informational', 'Commercial', 'Transactional'].forEach(intent => {
      lines.push(`- ${intent}: ${intentDist.pct[intent] || 0}%`);
    });
  }

  // Page role and freshness. Trust assessment used to live here as a set of
  // raw structural facts the model graded for itself; that is now the rule
  // engine's job, and what remains is evidence other recommendations use.
  lines.push('\n## PAGE ROLE & FRESHNESS');
  lines.push(`- Published date: ${pd.dates?.published || 'not found'}`);
  lines.push(`- Modified date: ${pd.dates?.modified || 'not found'}`);
  if (pd.externalLinkCount != null) lines.push(`- External links in body: ${pd.externalLinkCount}`);
  const urlPath = (pd.canonical || '').toLowerCase();
  // Homepage detection is its own case: without it every homepage classified as
  // "general", and the model happily recommended absorbing four separate
  // services into it. A homepage's job is its primary term plus links down.
  let pathname = '';
  try { pathname = new URL(pd.canonical).pathname; } catch { pathname = ''; }
  const pathType = (pathname === '/' || pathname === '') ? 'homepage'
    : urlPath.includes('/blog/') || urlPath.includes('/article') ? 'blog/article'
    : urlPath.includes('/product') ? 'product'
    : urlPath.includes('/about')   ? 'about'
    : urlPath.includes('/contact') ? 'contact'
    : 'general';
  lines.push(`- URL pattern: ${pathType}`);

  // The rule engine's decisions. Everything organic-trust related is decided
  // before the model sees the prompt — see popup-trust.js for why.
  if (g.trust && typeof trustRulesPromptBlock === 'function') {
    lines.push(...trustRulesPromptBlock(g.trust));
  }

  return lines.join('\n');
}

// Craft rules shared by the Overview and SEO prompts. Written once because
// they are corrections to real, observed output — duplicating them across two
// prompts would guarantee they drift.
//
// Every line here exists because a shipped plan got it wrong:
//   * it recommended putting a keyword in the meta description "for ranking";
//   * it pushed near-me phrasing into a snippet a human reads;
//   * it proposed absorbing four separate services into a homepage.
const ACTION_PLAN_CRAFT_RULES = `
- The meta description is NOT a ranking input. Never recommend adding a keyword to it in order to rank. It is a click-through lever only: recommend meta changes to win the click, and put keyword placement for RANKING in the title tag, an H1/H2, or body copy.
- Prefer a real city or place name over "near me" phrasing in anything a searcher reads. "Minneapolis" converts better in a snippet or headline than "near me"; if proximity phrasing is genuinely wanted, "near you" reads correctly to a human, "near me" does not.
- Respect the page's role, given by URL pattern in the E-E-A-T block. A homepage should target its primary term and LINK DOWN to service pages; do not recommend absorbing several distinct services into it. Distinct services deserve their own pages, and recommending one page cover them all is a worse plan than recommending the pages be built.
- NEVER recommend adding aggregateRating or Review markup to a LocalBusiness or Organization entity on the client's own site, and never promise star rich results from one. Google excluded self-serving reviews on those types from star eligibility in 2019. This applies equally to embedded third-party review widgets. Reviews on those entity types are a conversion lever, not a rich-result one — say so rather than implying stars are reachable.
- A low CTR is only a snippet problem when it is below what the position predicts, and the GSC block has already done that comparison for you. Never infer a title/meta problem from a raw CTR number, and never call a page-two ranking a CTR failure — at position 13 a 1% CTR is normal, and the fix is rank, not the snippet.`;

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
- Return 3–8 recommendations total. Order by impact within each effort tier.${ACTION_PLAN_CRAFT_RULES}

Respond with ONLY a compact JSON object, no prose, no code fences, exactly:
{"recommendations":[{"change":"…","detail":"…","evidence":"…","effort":"surgical|moderate|rewrite","impact":"high|medium|low","channel":"seo|paid|both"}],"contentGaps":["…","…"],"intentGap":{"pageIntent":"…","trafficIntent":"…","divergence":true,"summary":"…","suggestions":["…","…","…","…","…","…","…","…"]},"trust":{"recommendations":[{"ruleId":"…","change":"…","evidence":"…"}]}}
- "change": a SHORT task title, imperative, at most 80 characters. This is pasted straight into a task manager, so it must read as a task on its own: "Rewrite the title tag to lead with the head terms". No examples, no numbers, no justification, no em-dash clauses — those go in "detail".
- "detail": what to actually do, including any specific wording, examples, or placement you are proposing.
- "evidence": the data behind it, citing the actual numbers.
- "contentGaps": short topic labels (2–4 words) the page should cover but doesn't. 0–8 items.
- "intentGap": include ONLY when TRAFFIC INTENT DISTRIBUTION is present in the input. If the page's evident purpose (from its title, headings, and content) diverges significantly from the dominant traffic intent, set "divergence":true, "pageIntent" to the intent the page targets (one of: Informational, Navigational, Commercial, Transactional), "trafficIntent" to the dominant incoming intent, "summary" to one sentence explaining the mismatch and opportunity, and "suggestions" to exactly 8 diverse keyword phrases — range from head to long-tail, no brand terms — that the page should be visible for given its actual purpose. If no significant divergence exists, omit "intentGap" entirely.
- "trust": phrasing for the E-E-A-T RULES block, and nothing else. One entry per FIRED rule, each with "ruleId" (copied exactly), "change" (a SHORT task title, imperative, at most 80 characters, pasteable into a task manager), "detail" (that rule's recommendation rewritten against THIS page's actual copy — quote the real sentence or heading you mean) and "evidence" (what on the page triggered it). Do NOT invent a ruleId, do NOT include a suppressed rule, and do NOT assign an impact, effort or score — those are decided already. Omit "trust" entirely if no rule fired.`;

// ─── The two specialized prompts ──────────────────────────────────────────────
//
// ACTION_PLAN_SYSTEM above is the Overview prompt and is deliberately UNCHANGED
// — its exact wording, schema and enum lists were arrived at by trial and error
// and the plan it produces today is the one it should keep producing. These two
// are siblings, not rewrites: they reuse its output contract verbatim (same
// JSON shape, same effort/impact/channel enums, same normalizeActionPlan on the
// way back) and vary only the strategist framing and the emphasis rules.
//
// Both receive the identical context the Overview plan gets. The narrowing is
// in what they're asked to RECOMMEND, never in what they're allowed to KNOW —
// organic queries are legitimate evidence for a paid recommendation and vice
// versa, and cutting either side off would make both plans worse.

const ACTION_PLAN_JSON_CONTRACT = `Respond with ONLY a compact JSON object, no prose, no code fences, exactly:
{"recommendations":[{"change":"…","detail":"…","evidence":"…","effort":"surgical|moderate|rewrite","impact":"high|medium|low","channel":"seo|paid|both"}],"contentGaps":["…","…"]REPLACE_EXTRAS}
- "change": a SHORT task title, imperative, at most 80 characters. This is pasted straight into a task manager, so it must read as a task on its own: "Rewrite the title tag to lead with the head terms". No examples, no numbers, no justification, no em-dash clauses — those go in "detail".
- "detail": what to actually do, including any specific wording, examples, or placement you are proposing.
- "evidence": the data behind it, citing the actual numbers.
- effort is one of: "surgical" (minutes), "moderate" (an hour), "rewrite" (major restructuring).
- impact is one of: "high", "medium", "low".
- Return 3–8 recommendations total. Order by impact within each effort tier.
- Every recommendation MUST cite specific evidence from the data provided. Never give generic advice.`;

const ACTION_PLAN_INTENT_CLAUSE = `
- "intentGap": include ONLY when TRAFFIC INTENT DISTRIBUTION is present in the input. If the page's evident purpose diverges significantly from the dominant traffic intent, set "divergence":true, "pageIntent" and "trafficIntent" (each one of: Informational, Navigational, Commercial, Transactional), "summary" to one sentence on the mismatch, and "suggestions" to exactly 8 diverse keyword phrases — head to long-tail, no brand terms. If no significant divergence exists, omit "intentGap" entirely.`;

const ACTION_PLAN_SYSTEM_SEO = `You are an elite on-page SEO strategist. You are given a single web page's CONTENT and every demand and diagnostic signal available for it: Search Console queries, Google Ads data, Web CEO tracked rankings and site-audit findings, GA4 behaviour, Core Web Vitals, and backlink authority.

Your ONLY job is organic search performance for THIS page. Every recommendation must be an on-page or organic change: content, structure, headings, internal linking, metadata, schema, technical fixes, page experience, or authority. Never recommend a bid, budget, ad-copy or negative-keyword change — those belong to a separate paid plan and must not appear here.

Paid data is still evidence you should use: a search term that converts in Ads is proof of commercial demand this page should rank for organically, and a low Quality Score usually means a landing-page relevance problem that is an ORGANIC content fix. Cite paid numbers freely; just make the recommended action an organic one.

Emphasis, in order:
- The page-2 band (queries at position 5–20 with real impressions) — the highest-ROI organic fixes that exist.
- High-impression / low-CTR queries — a title and meta description problem, not a content problem. Say which.
- Content the market demands (queries, converting paid terms) that appears nowhere in the headings or body vocabulary. The PAGE VOCABULARY block shows what the page actually dwells on; a term with heavy impressions and a near-zero count there is a real gap, not a stylistic one.
- Technical and experience issues from SITE AUDIT and CORE WEB VITALS when present — tie each to its measured number.
- Authority: if BACKLINKS shows this page has few or no inbound links of its own, treat that as an internal-linking problem first.

Every recommendation must use channel "seo".

${ACTION_PLAN_JSON_CONTRACT.replace('REPLACE_EXTRAS', `,"intentGap":{…},"trust":{…}`)}
- "contentGaps": short topic labels (2–4 words) the page should cover but doesn't. 0–8 items.${ACTION_PLAN_INTENT_CLAUSE}
- "trust": phrasing for the E-E-A-T RULES block, and nothing else. One entry per FIRED rule, each with "ruleId" (copied exactly), "change" (a SHORT task title, imperative, at most 80 characters, pasteable into a task manager), "detail" (that rule's recommendation rewritten against THIS page's actual copy — quote the real sentence or heading you mean) and "evidence" (what on the page triggered it). Do NOT invent a ruleId, do NOT include a suppressed rule, and do NOT assign an impact, effort or score — those are decided already. Omit "trust" entirely if no rule fired.
${ACTION_PLAN_CRAFT_RULES}`;

const ACTION_PLAN_SYSTEM_PAID = `You are an elite Google Ads strategist. You are given a landing page's CONTENT and every signal available for it: its Google Ads campaigns, ad groups, ads, keywords and search terms, plus Search Console organic queries, Web CEO rankings, GA4 behaviour and Core Web Vitals.

Your ONLY job is paid search performance for the campaigns, ad groups and ads that point at THIS page. Every recommendation must be a paid change: keywords, match types, negative keywords, ad copy and assets, bids, budgets, bid strategy, or ad group structure. Do not recommend organic content or schema changes as ends in themselves — those belong to a separate SEO plan.

Campaign-level recommendations ARE in scope. If a campaign this page's ad groups sit in is losing impression share to budget or to rank, say so and recommend the budget or bid-strategy change, even though it affects more than this page. Note plainly when a recommendation reaches beyond this page.

Organic data is evidence you should use: a query with strong impressions but a poor organic position is a candidate to buy; a query the page already ranks #1 for organically may be wasted paid spend. Cite organic numbers to justify paid decisions.

Emphasis, in order:
- Wasted spend: search terms with real cost and zero conversions. Recommend specific negative keywords and the match type to use. CHECK the "Negative keywords ALREADY in place" list first and never propose one that is already there at the same match type — if a wasteful term is already excluded and still costing money, that is itself the finding, and the fix is a broader match type or a different level, not a duplicate.
- Converting search terms not present as bid keywords — the cheapest wins available.
- Low Quality Score keywords: name the likely cause (ad relevance, expected CTR, or landing page experience) using the page content and Core Web Vitals as evidence, and give the paid fix.
- LOW-rated RSA headlines and descriptions — quote the weak asset and say what to replace it with.
- Impression share lost to budget or rank, at ad group and campaign level.
- Ad group structure: search terms that deserve their own tightly-themed ad group.

Every recommendation must use channel "paid".

${ACTION_PLAN_JSON_CONTRACT.replace('REPLACE_EXTRAS', `,"intentGap":{…}`)}
- "contentGaps": short labels (2–4 words) for topics the paid traffic wants that this landing page never addresses — these hurt Quality Score and conversion rate. 0–8 items.${ACTION_PLAN_INTENT_CLAUSE}
- Do NOT include a "trust" key. E-E-A-T is an organic concept and has no place in a paid plan.`;

const ACTION_PLAN_SYSTEMS = {
  overview: ACTION_PLAN_SYSTEM,
  seo:      ACTION_PLAN_SYSTEM_SEO,
  paid:     ACTION_PLAN_SYSTEM_PAID
};

// Rule ids are internal taxonomy. The "R-" prefix distinguishes rules from the
// "B-" hard blocks in the spec, which is meaningless to anyone reading a plan,
// so it is stripped for display. The full id stays on the data and in tooltips.
function trustRuleLabel(ruleId) { return String(ruleId || '').replace(/^R-/, ''); }

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

// The title is meant to be pasteable into a task manager, so a model that
// ignores the length cap has to degrade into something usable rather than a
// paragraph in bold. Split at the first clause break and demote the rest into
// detail; if there is no clean break, leave it alone rather than cut a
// sentence in half.
const REC_TITLE_MAX = 90;

function splitLongChange(change, detail) {
  if (detail || change.length <= REC_TITLE_MAX) return { change, detail };
  const brk = /\s—\s|\s–\s|\s-\s|\.\s|;\s/.exec(change);
  if (!brk || brk.index < 20) return { change, detail };
  return {
    change: change.slice(0, brk.index).trim(),
    detail: change.slice(brk.index + brk[0].length).trim()
  };
}

const _EFFORTS = ['surgical', 'moderate', 'rewrite'];
const _IMPACTS = ['high', 'medium', 'low'];
const _CHANNELS = ['seo', 'paid', 'both'];

// Enforce a variant's contract on the parsed result, rather than trusting the
// prompt to have been obeyed. Models follow negative instructions ("do NOT
// include trust") unreliably, and both leaks are user-visible: a stray trust
// block appears in a paid plan, and a mislabelled channel is printed into the
// RTF and Google Doc exports, where the tag is text rather than a hidden chip.
// Cheap to enforce, so enforce it.
function applyVariantContract(plan, variant) {
  if (!plan || variant === 'overview') return plan;
  const channel = variant === 'paid' ? 'paid' : 'seo';
  plan.recommendations.forEach(r => { r.channel = channel; });
  // `eeat` is gone from the contract; the delete remains for a plan restored
  // from a cache entry written by the previous build, whose TTL has not expired.
  if (variant === 'paid') { delete plan.eeat; delete plan.trust; }
  return plan;
}

function normalizeActionPlan(raw) {
  if (!raw || !Array.isArray(raw.recommendations)) return null;
  const recommendations = raw.recommendations.map(r => {
    const effort = _EFFORTS.includes(String(r.effort).toLowerCase()) ? String(r.effort).toLowerCase() : 'moderate';
    const impact = _IMPACTS.includes(String(r.impact).toLowerCase()) ? String(r.impact).toLowerCase() : 'medium';
    const channel = _CHANNELS.includes(String(r.channel).toLowerCase()) ? String(r.channel).toLowerCase() : 'seo';
    const split = splitLongChange(String(r.change || '').trim(), String(r.detail || '').trim());
    const evidence = String(r.evidence || '').trim();
    return split.change ? { ...split, evidence, effort, impact, channel } : null;
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
  return out;
}

/**
 * Merge the model's phrasing onto the engine's decisions.
 *
 * The engine is authoritative about WHICH rules fired and what they are worth;
 * the model contributes only wording. So a ruleId the model invented is
 * dropped, and a fired rule the model skipped still ships, using the engine's
 * own text. Nothing the model returns can add, remove, or re-grade a rule —
 * which is what makes the output comparable across clients and defensible in
 * front of one.
 */
function mergeTrustPhrasing(raw, trust) {
  if (!trust) return null;
  const phrased = new Map();
  const list = raw && raw.trust && Array.isArray(raw.trust.recommendations) ? raw.trust.recommendations : [];
  list.forEach(r => {
    const id = String((r && r.ruleId) || '').trim();
    if (id) phrased.set(id, {
      ...splitLongChange(String(r.change || '').trim(), String(r.detail || '').trim()),
      evidence: String(r.evidence || '').trim()
    });
  });

  const recommendations = trust.fired.map(f => {
    const p = phrased.get(f.ruleId) || {};
    return {
      ruleId: f.ruleId,
      tier: f.tier,
      change: p.change || f.recommendation,       // engine text is the fallback, never a gap
      detail: p.detail || f.detail || '',   // the engine's own brief when the model skipped it
      evidence: p.evidence || f.trigger,
      trigger: f.trigger,                          // always the engine's, so it can be defended
      impact: f.impact,
      effort: f.effort,
      ...(f.ceiling ? { ceiling: f.ceiling } : {})
    };
  });

  return {
    checklist: trust.checklist,
    recommendations,
    findings: trust.findings,
    caveat: trust.caveat
  };
}

// ─── Main entry: generate (or render from cache) ──────────────────────────────

// Cache entries are keyed by VARIANT and URL. Entries written before the three
// variants existed used the bare URL, so they simply never match now and are
// regenerated — old and new keys coexist harmlessly in the same object, and
// rolling back to a single-plan build leaves its keys still valid.
const actionPlanCacheKey = (variant, url) => `${variant}::${(url || '').split('#')[0]}`;

// 3 variants × the 20 pages the old cap allowed.
const ACTION_PLAN_CACHE_CAP = 60;

async function loadActionPlan(forceRefresh = false, variant = _apVariant) {
  const st = _apState[variant];
  if (!st || st.loading) return;

  const done = () => { if (variant === _apVariant) renderActionPlanPanel(); refreshActionPlanNav(); };

  if (!pageData) { st.error = 'No page data — open this on a regular web page.'; done(); return; }

  const { claudeApiKey } = await browser.storage.local.get('claudeApiKey');
  if (!claudeApiKey) { st.error = 'Add a Claude API key in Settings to generate an action plan.'; done(); return; }

  const tab = await getActiveTab();
  const urlKey = (tab.url || '').split('#')[0];
  const cacheKey = actionPlanCacheKey(variant, tab.url);

  const { actionPlanCache } = await browser.storage.local.get('actionPlanCache');
  const cache = actionPlanCache || {};
  const cached = cache[cacheKey];
  if (!forceRefresh && cached && (Date.now() - cached.fetchedAt < ACTION_PLAN_TTL_MS)) {
    st.plan = cached.plan;
    st.sources = cached.sources;
    st.fetchedAt = cached.fetchedAt;
    st.error = '';
    done();
    return;
  }

  st.loading = true;
  st.error = '';
  done();

  try {
    const gathered = await gatherActionPlanData(tab);

    // Pull the four page insights from the same cache loadAiInsights writes to
    try {
      const { aiInsightsCache } = await browser.storage.local.get('aiInsightsCache');
      const ins = aiInsightsCache && aiInsightsCache[urlKey];
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
        system: [{ type: 'text', text: ACTION_PLAN_SYSTEMS[variant] || ACTION_PLAN_SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: context }]
      })
    });
    const parsed = actionPlanParse(claudeText(data));
    const plan = applyVariantContract(normalizeActionPlan(parsed), variant);
    if (!plan) throw new Error('Could not parse a plan from the response.');
    // Attached after the variant contract, which strips trust from the Paid
    // plan — an organic concept has no place there.
    if (variant !== 'paid') {
      const merged = mergeTrustPhrasing(parsed, gathered.trust);
      if (merged && (merged.recommendations.length || merged.checklist.length)) plan.trust = merged;
    }

    st.plan = plan;
    st.sources = sources;
    st.fetchedAt = Date.now();

    // Re-read rather than reusing the copy from above: a sibling variant may
    // have finished writing while this call was in flight, and clobbering it
    // would silently throw away a plan the user just paid for.
    const { actionPlanCache: fresh } = await browser.storage.local.get('actionPlanCache');
    const out = fresh || {};
    out[cacheKey] = { plan, sources, fetchedAt: st.fetchedAt };
    const keys = Object.keys(out);
    if (keys.length > ACTION_PLAN_CACHE_CAP) {
      keys.sort((a, b) => out[a].fetchedAt - out[b].fetchedAt);
      keys.slice(0, keys.length - ACTION_PLAN_CACHE_CAP).forEach(k => delete out[k]);
    }
    browser.storage.local.set({ actionPlanCache: out });
  } catch (err) {
    st.error = err.message;
  } finally {
    st.loading = false;
    done();
  }
}

// Hydrate every variant's nav-row status from cache without generating
// (called on page load). Each row reflects only its own plan.
async function hydrateActionPlanNav() {
  try {
    const tab = await getActiveTab();
    const { actionPlanCache } = await browser.storage.local.get('actionPlanCache');
    const cache = actionPlanCache || {};
    ACTION_PLAN_VARIANTS.forEach(v => {
      const st = _apState[v];
      const cached = cache[actionPlanCacheKey(v, tab.url)];
      if (cached && (Date.now() - cached.fetchedAt < ACTION_PLAN_TTL_MS)) {
        st.plan = cached.plan;
        st.sources = cached.sources;
        st.fetchedAt = cached.fetchedAt;
      } else {
        st.plan = null;
      }
    });
  } catch {
    ACTION_PLAN_VARIANTS.forEach(v => { _apState[v].plan = null; });
  }
  refreshActionPlanNav();
}

// Point the shared panel at a variant, then generate/restore that variant's
// plan. popup-nav.js calls this from all three nav rows.
function setActionPlanVariant(variant) {
  _apVariant = ACTION_PLAN_VARIANTS.includes(variant) ? variant : 'overview';
  const heading = document.getElementById('actionplan-title');
  if (heading) heading.textContent = ACTION_PLAN_META[_apVariant].title;
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

// `showChannel` is false on the SEO and Paid plans: every card there carries
// the same channel, so the tag conveys nothing and just crowds the row.
function actionPlanRecCard(rec, showChannel = true) {
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
  if (showChannel) {
    const channel = rec.channel || 'seo';
    const chTag = document.createElement('span');
    chTag.className = `ap-tag ap-channel--${channel}`;
    chTag.textContent = channel === 'both' ? 'SEO + Paid' : channel === 'paid' ? 'Paid' : 'SEO';
    tags.appendChild(chTag);
  }
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

  // Detail and evidence share one type size: the title is the task, everything
  // below it is the brief. Keeping them the same size is what makes the title
  // liftable into a task manager on its own.
  if (rec.detail) {
    const d = document.createElement('div');
    d.className = 'ap-rec-evidence ap-rec-detail';
    d.textContent = rec.detail;
    card.appendChild(d);
  }
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

  const st = apCur();
  const _actionPlan = st.plan;
  const _actionPlanSources = st.sources;
  const _actionPlanFetchedAt = st.fetchedAt;

  // Loading
  if (st.loading) {
    const sec = document.createElement('section');
    sec.className = 'field-section ap-center';
    sec.appendChild(svgFromString('<svg class="ap-spinner" viewBox="0 0 16 16" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M14 8A6 6 0 1 1 8 2"/></svg>'));
    root.appendChild(sec);
    return;
  }

  // Error
  if (st.error) {
    const sec = document.createElement('section');
    sec.className = 'field-section';
    const msg = document.createElement('div');
    msg.className = 'field-hint hint-red';
    msg.textContent = st.error;
    sec.appendChild(msg);
    if (/Claude API key/.test(st.error)) {
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
  refresh.addEventListener('click', () => loadActionPlan(true, _apVariant));
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
    recs.forEach(r => list.appendChild(actionPlanRecCard(r, _apVariant === 'overview')));
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

  // Trust signals — the rule engine's checklist and whatever fired, with the
  // model's phrasing merged on. Deliberately not a grade: the old
  // strong/moderate/weak badge implied a score Google does not assign and was
  // not comparable between two clients.
  const trust = _actionPlan.trust;
  if (trust && (trust.checklist.length || trust.recommendations.length)) {
    const sec = document.createElement('section');
    sec.className = 'field-section';
    const h = document.createElement('div');
    h.className = 'field-header';
    const lbl = document.createElement('span');
    lbl.className = 'field-label';
    lbl.textContent = 'TRUST SIGNALS';
    h.appendChild(lbl);
    sec.appendChild(h);

    if (trust.checklist.length) {
      const list = document.createElement('div');
      list.className = 'ap-trust-checklist';
      trust.checklist.forEach(c => {
        const row = document.createElement('div');
        row.className = `ap-trust-row ap-trust-row--${c.state}`;
        const box = document.createElement('span');
        box.className = 'ap-trust-box';
        box.textContent = c.state === 'met' ? '✓' : c.state === 'na' ? '–' : '✗';
        const label = document.createElement('span');
        label.className = 'ap-trust-label';
        label.textContent = c.label;
        row.append(box, label);
        if (c.state === 'na') {
          // The reason is the whole point of n/a: it separates "does not apply
          // to this client" from "missing", so the gating is visible.
          const why = document.createElement('span');
          why.className = 'ap-trust-na';
          why.textContent = c.reason || 'not applicable';
          why.title = c.reason || '';
          row.appendChild(why);
        }
        list.appendChild(row);
      });
      sec.appendChild(list);
    }

    trust.recommendations.forEach(r => {
      const card = document.createElement('div');
      card.className = 'ap-rec ap-rec--moderate ap-trust-rec';

      const top = document.createElement('div');
      top.className = 'ap-rec-top';
      const change = document.createElement('div');
      change.className = 'ap-rec-change';
      change.textContent = r.change;
      top.appendChild(change);

      const tags = document.createElement('div');
      tags.className = 'ap-rec-tags';
      const eff = document.createElement('span');
      eff.className = `ap-tag ap-tag--${r.effort}`;
      eff.textContent = r.effort;
      tags.appendChild(eff);
      const imp = document.createElement('span');
      imp.className = `ap-tag ap-tag-impact--${r.impact}`;
      imp.textContent = r.impact;
      tags.appendChild(imp);
      top.appendChild(tags);
      card.appendChild(top);

      if (r.detail) {
        const d = document.createElement('div');
        d.className = 'ap-rec-evidence ap-rec-detail';
        d.textContent = r.detail;
        card.appendChild(d);
      }

      const ev = document.createElement('div');
      ev.className = 'ap-rec-evidence';
      // The rule id sits with the evidence rather than in the chip row: it is
      // provenance, not a grade, and a long one (REVIEW-DISPLAY-NOSTARS) shoved
      // the effort and impact chips out of line with every other card.
      const idTag = document.createElement('span');
      idTag.className = 'ap-trust-rule';
      idTag.textContent = trustRuleLabel(r.ruleId);
      idTag.title = `${r.ruleId} — triggered by: ${r.trigger}`;
      ev.append(idTag, document.createTextNode(r.evidence));
      card.appendChild(ev);

      if (r.ceiling) {
        // What the recommendation cannot achieve. Stated so nobody spends a
        // sprint chasing a rich result the entity type cannot produce.
        const c = document.createElement('div');
        c.className = 'ap-trust-ceiling';
        c.textContent = r.ceiling;
        card.appendChild(c);
      }
      sec.appendChild(card);
    });

    (trust.findings || []).forEach(f => {
      const el = document.createElement('div');
      el.className = 'field-hint hint-muted ap-trust-finding';
      el.textContent = f.text;
      sec.appendChild(el);
    });

    if (trust.caveat) {
      const cav = document.createElement('div');
      cav.className = 'field-hint hint-muted ap-trust-caveat';
      cav.textContent = trust.caveat;
      sec.appendChild(cav);
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
  const _actionPlan = apCur().plan;
  const _actionPlanFetchedAt = apCur().fetchedAt;
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
      fetchedAt: _actionPlanFetchedAt,
      planTitle: ACTION_PLAN_META[_apVariant].title
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
    maybeOfferExportFolder(pageUrl);
  } else {
    btn.title = `Export failed: ${(res && res.error) || 'unknown error'}`;
  }
}

async function exportActionPlanRtf() {
  const _actionPlan = apCur().plan;
  const _actionPlanFetchedAt = apCur().fetchedAt;
  if (!_actionPlan) return;
  const meta = ACTION_PLAN_META[_apVariant];

  let host = 'page';
  try { host = new URL((pageData && pageData.canonical) || (await getActiveTab()).url).hostname.replace(/^www\./, ''); } catch { /* keep default */ }

  const parts = [];
  parts.push(`{\\b\\fs32 ${rtfEscape(meta.title)}}\\par {\\fs18 ${rtfEscape(host)} \\u8212? generated ${rtfEscape(new Date(_actionPlanFetchedAt || Date.now()).toLocaleString())}}\\par\\par`);

  ACTION_PLAN_TIERS.forEach(tier => {
    const recs = _actionPlan.recommendations.filter(r => r.effort === tier.effort);
    if (!recs.length) return;
    parts.push(`{\\b\\fs26 ${rtfEscape(tier.title)}}\\par`);
    recs.forEach(r => {
      const ch = r.channel === 'both' ? 'SEO + Paid' : r.channel === 'paid' ? 'Paid' : 'SEO';
      parts.push(`{\\b ${rtfEscape(r.change)}}  {\\i [${rtfEscape(r.effort)} \\u183? ${rtfEscape(r.impact)} impact \\u183? ${rtfEscape(ch)}]}\\par`);
      if (r.detail) parts.push(`${rtfEscape(r.detail)}\\par`);
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

  const trust = _actionPlan.trust;
  if (trust && (trust.checklist.length || trust.recommendations.length)) {
    parts.push(`\\par{\\b\\fs26 Trust Signals}\\par`);
    trust.checklist.forEach(c => {
      const mark = c.state === 'met' ? '[x]' : c.state === 'na' ? '[n/a]' : '[ ]';
      parts.push(`${rtfEscape(mark)} ${rtfEscape(c.label)}${c.state === 'na' && c.reason ? ` \\u8212? ${rtfEscape(c.reason)}` : ''}\\par`);
    });
    if (trust.recommendations.length) parts.push('\\par');
    trust.recommendations.forEach(r => {
      parts.push(`{\\b ${rtfEscape(r.change)}}  {\\i [${rtfEscape(trustRuleLabel(r.ruleId))} \\u183? ${rtfEscape(r.effort)} \\u183? ${rtfEscape(r.impact)} impact]}\\par`);
      if (r.detail) parts.push(`${rtfEscape(r.detail)}\\par`);
      parts.push(`${rtfEscape(r.evidence)}\\par`);
      if (r.ceiling) parts.push(`{\\i ${rtfEscape(r.ceiling)}}\\par`);
      parts.push('\\par');
    });
    (trust.findings || []).forEach(f => parts.push(`${rtfEscape(f.text)}\\par`));
    if (trust.caveat) parts.push(`\\par{\\i ${rtfEscape(trust.caveat)}}\\par`);
  }

  const rtf = `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Helvetica;}}\\f0\\fs22 ${parts.join('')}}`;
  const blob = new Blob([rtf], { type: 'application/rtf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `action-plan-${meta.slug}-${host}.rtf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Each tab's nav row shows the count for ITS OWN plan — the Search row must
// never light up because the Overview plan happens to be cached.
function refreshActionPlanNav() {
  ACTION_PLAN_VARIANTS.forEach(v => {
    const status = document.getElementById(ACTION_PLAN_META[v].navId);
    if (!status) return;
    const plan = _apState[v].plan;
    const n = (plan && plan.recommendations.length) || 0;
    status.textContent = n ? `${n} recs` : '';
    status.classList.toggle('hidden', !n);
  });
}
