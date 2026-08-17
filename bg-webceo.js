// Part of the extension background — see bg-core.js for how these files load.
// Web CEO: rankings, site audit, and the backlinks family.

// ─── WebCEO (rank tracking, whitelabel-friendly) ─────────────────────────────
// Single-endpoint JSON API: POST {method, key, id, data} to the configured base
// URL; the response is an array whose first element carries result/errormsg/data.
// Auth is a plain API key (Agency Unlimited). Base URL defaults to the user's
// whitelabel host but is overridable in Settings.

const WEBCEO_API_DEFAULT = 'https://seo.plaudit.com/api/';
const WEBCEO_PROJECTS_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const WEBCEO_STALE_MS = 6 * 60 * 60 * 1000;
const WEBCEO_BACKLINKS_STALE_MS = 24 * 60 * 60 * 1000;   // backlinks change slowly
const WEBCEO_AUDIT_STALE_MS = 24 * 60 * 60 * 1000;       // site audit changes slowly
const WEBCEO_LOST_BACKLINKS_STALE_MS = 24 * 60 * 60 * 1000;
const WEBCEO_LINKING_DOMAINS_STALE_MS = 24 * 60 * 60 * 1000;
const WEBCEO_COMPETITOR_METRICS_STALE_MS = 24 * 60 * 60 * 1000;
const WEBCEO_KEYWORD_TAGS_STALE_MS = 24 * 60 * 60 * 1000;

async function webceoConfig() {
  const { webceoApiKey, webceoBaseUrl } = await browser.storage.local.get(['webceoApiKey', 'webceoBaseUrl']);
  return { apiKey: webceoApiKey || '', baseUrl: (webceoBaseUrl || WEBCEO_API_DEFAULT).trim() };
}

// One API call. Returns { data } on success or { error, detail } on failure.
async function webceoCall(method, data, { apiKey, baseUrl } = {}) {
  if (apiKey === undefined) { const cfg = await webceoConfig(); apiKey = cfg.apiKey; baseUrl = cfg.baseUrl; }
  if (!apiKey) return { error: 'NO_API_KEY' };
  const body = { method, key: apiKey, id: method };
  if (data !== undefined) body.data = data;
  let res;
  try {
    res = await fetch(baseUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    return { error: 'NETWORK', detail: String(e && e.message || e) };
  }
  if (res.status === 401 || res.status === 403) return { error: 'BAD_KEY' };
  if (res.status === 429) return { error: 'RATE_LIMITED' };
  let json;
  try { json = await res.json(); } catch { return { error: 'API_ERROR', detail: `HTTP ${res.status}` }; }
  const entry = Array.isArray(json) ? json[0] : json;
  if (!entry) return { error: 'API_ERROR', detail: 'Empty response' };
  if (entry.result && entry.result !== 0) {
    if (entry.result === 10) return { error: 'BAD_KEY', detail: entry.errormsg };   // unknown command / bad auth
    return { error: 'API_ERROR', detail: entry.errormsg || `result ${entry.result}` };
  }
  return { data: entry.data };
}

function webceoGetStatus() {
  return webceoConfig().then(({ apiKey, baseUrl }) => ({ connected: !!apiKey, baseUrl }));
}

// Projects (get_projects), cached 7d. Returns [{ project, name, domain, suspended }].
async function webceoListProjects(forceRefresh = false) {
  const { webceoProjects } = await browser.storage.local.get('webceoProjects');
  if (!forceRefresh && webceoProjects && (Date.now() - webceoProjects.fetchedAt < WEBCEO_PROJECTS_STALE_MS)) {
    return { projects: webceoProjects.list };
  }
  const res = await webceoCall('get_projects');
  if (res.error) return { error: res.error, detail: res.detail };
  const list = (res.data || [])
    .filter(p => !p.suspended)
    .map(p => ({ project: p.project, name: p.name || p.domain, domain: (p.domain || '').replace(/^www\./i, '').toLowerCase() }));
  await browser.storage.local.set({ webceoProjects: { fetchedAt: Date.now(), list } });
  return { projects: list };
}

async function webceoGetProject(host) {
  if (!host) return null;
  const { webceoProjectOverrides } = await browser.storage.local.get('webceoProjectOverrides');
  return (webceoProjectOverrides && webceoProjectOverrides[host]) || null;
}

// Resolve the project for a page: an explicit per-domain override, else the
// project whose domain matches the page host.
async function webceoResolveProject({ pageUrl }) {
  const { apiKey } = await webceoConfig();
  if (!apiKey) return { connected: false };
  const listed = await webceoListProjects();
  if (listed.error) return { connected: true, error: listed.error, detail: listed.detail };

  const host = gscPageHost(pageUrl);
  const chosen = await webceoGetProject(host);
  let project = chosen && listed.projects.find(p => p.project === chosen) ? chosen : null;
  if (!project && host) {
    const match = listed.projects.find(p => p.domain === host);
    if (match) project = match.project;
  }
  return { connected: true, host, project, projects: listed.projects };
}

async function webceoSetProject({ host, project }) {
  if (!host) return { ok: false };
  const { webceoProjectOverrides } = await browser.storage.local.get('webceoProjectOverrides');
  const overrides = webceoProjectOverrides || {};
  if (project) overrides[host] = project; else delete overrides[host];
  await browser.storage.local.set({ webceoProjectOverrides: overrides });
  await browser.storage.local.remove('webceoCache');
  await clientRegistrySetBinding(host, 'webceoProject', project || null);
  return { ok: true };
}

// Flatten get_rankings (grouped=0) into one row per keyword × search engine, with
// the current position, the change vs the previous scan, volume and ranking URL.
function webceoFlattenRankings(rankingData) {
  const rows = [];
  (rankingData || []).forEach(kwEntry => {
    const volume = kwEntry.global_searches != null ? kwEntry.global_searches
      : (kwEntry.local_searches && kwEntry.local_searches[0] && kwEntry.local_searches[0].searches_number) || null;
    (kwEntry.positions || []).forEach(p => {
      // Most recent scanned entries first
      const scans = (p.scan_history || []).filter(s => s.scanned !== 0)
        .slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      const current = scans[0] || null;
      const previous = scans[1] || null;
      rows.push({
        keyword: kwEntry.kw,
        starred: kwEntry.starred === 1,
        volume,
        se: p.se || '',
        location: p.location || '',
        country: p.country || '',
        mobile: p.mobile || 0,
        position: current && current.pos != null ? current.pos : null,
        previous: previous && previous.pos != null ? previous.pos : null,
        date: current ? current.date : null,
        url: current ? current.url : null,
        history: scans.slice(0, 12).reverse().map(s => ({ date: s.date, pos: s.pos, url: s.url || null })) // oldest→newest for a sparkline + URL-drift detection
      });
    });
  });
  return rows;
}

async function webceoGetRankings({ pageUrl, historyDepth = 2, forceRefresh = false }) {
  const { apiKey } = await webceoConfig();
  if (!apiKey) return { connected: false };
  const host = gscPageHost(pageUrl);
  const project = await webceoResolveProject({ pageUrl });
  if (project.error) return { connected: true, error: project.error, detail: project.detail };
  if (!project.project) return { connected: true, error: 'NO_PROJECT', host, projects: project.projects };

  const depth = Math.max(2, Math.min(parseInt(historyDepth, 10) || 2, 60));
  const cacheKey = `${host}::${project.project}::${depth}`;
  const { webceoCache } = await browser.storage.local.get('webceoCache');
  const cache = webceoCache || {};
  const cached = cache[cacheKey];
  if (!forceRefresh && cached && (Date.now() - cached.fetchedAt < WEBCEO_STALE_MS)) {
    return { connected: true, ...cached, fromCache: true };
  }

  const res = await webceoCall('get_rankings', { project: project.project, grouped: 0, history_depth: depth });
  if (res.error) return { connected: true, error: res.error, detail: res.detail };

  const rows = webceoFlattenRankings(res.data && res.data.ranking_data);
  const projInfo = project.projects.find(p => p.project === project.project);
  const entry = {
    fetchedAt: Date.now(), host, project: project.project,
    projectName: projInfo ? projInfo.name : '', domain: res.data ? res.data.domain : (projInfo && projInfo.domain),
    rows, depth
  };
  cache[cacheKey] = entry;
  await writeCache('webceoCache', cache);
  return { connected: true, ...entry, fromCache: false };
}

// Add tracked keyword(s) to this domain's project (Search tab "+ Track" chip).
async function webceoAddKeywords({ pageUrl, keywords, tags }) {
  const list = (Array.isArray(keywords) ? keywords : [keywords]).map(k => String(k || '').trim()).filter(Boolean);
  if (!list.length) return { error: 'NO_KEYWORDS' };
  const resolved = await webceoResolveProject({ pageUrl });
  if (!resolved.connected) return { connected: false };
  if (resolved.error) return { connected: true, error: resolved.error, detail: resolved.detail };
  if (!resolved.project) return { connected: true, error: 'NO_PROJECT' };

  const payload = { project: resolved.project, keywords: list };
  if (Array.isArray(tags) && tags.length) payload.tags = tags;
  const res = await webceoCall('add_rankings_keywords', payload);
  if (res.error) return { connected: true, error: res.error, detail: res.detail };
  await browser.storage.local.remove('webceoCache');   // rankings now stale
  return { connected: true, ok: true, added: list, project: resolved.project };
}

// The project's tracked keyword list (get_rankings_keywords) — used to flag
// already-tracked terms on the Search/Ads tabs.
async function webceoGetTrackedKeywords({ pageUrl }) {
  const resolved = await webceoResolveProject({ pageUrl });
  if (!resolved.connected || resolved.error || !resolved.project) return { keywords: [] };
  const res = await webceoCall('get_rankings_keywords', { project: resolved.project });
  if (res.error) return { keywords: [], error: res.error };
  const kws = (res.data && res.data.keywords) || [];
  return { keywords: kws.map(k => (typeof k === 'string' ? k : (k.keyword || k.kw || k.text || ''))).filter(Boolean) };
}

// Keyword Tags (get_keywords_tags) — project-wide, no page dimension (tags are
// an attribute of the tracked keyword itself). Cached 24h; returns a plain
// { "<lowercased keyword>": ["tag1","tag2",...] } map for the popup to key off.
async function webceoGetKeywordTags({ pageUrl, forceRefresh = false }) {
  const { apiKey } = await webceoConfig();
  if (!apiKey) return { connected: false };
  const host = gscPageHost(pageUrl);
  const project = await webceoResolveProject({ pageUrl });
  if (project.error) return { connected: true, error: project.error, detail: project.detail };
  if (!project.project) return { connected: true, error: 'NO_PROJECT', host };

  const cacheKey = `${host}::${project.project}`;
  const { webceoKeywordTagsCache } = await browser.storage.local.get('webceoKeywordTagsCache');
  const cache = webceoKeywordTagsCache || {};
  const cached = cache[cacheKey];
  if (!forceRefresh && cached && (Date.now() - cached.fetchedAt < WEBCEO_KEYWORD_TAGS_STALE_MS)) {
    return { connected: true, tags: cached.tags, fetchedAt: cached.fetchedAt, fromCache: true };
  }

  const res = await webceoCall('get_keywords_tags', { project: project.project });
  if (res.error) return { connected: true, error: res.error, detail: res.detail };

  const raw = (res.data && res.data.keyword_tags) || {};
  const tags = {};
  Object.keys(raw).forEach(kw => {
    const list = (raw[kw] || []).filter(Boolean);
    if (list.length) tags[kw.toLowerCase().trim()] = list;
  });
  cache[cacheKey] = { fetchedAt: Date.now(), tags };
  await writeCache('webceoKeywordTagsCache', cache);
  return { connected: true, tags, fetchedAt: cache[cacheKey].fetchedAt, fromCache: false };
}

// Roll the flat get_backlinks list up into the shapes the panel renders:
// per-referring-domain groups (with a capped sample of their linking pages),
// an anchor-text distribution, top linked-to pages, and headline counts.
// Aggregating here keeps the message small even for large link sets.
function webceoBacklinkDomain(url) {
  try { return new URL(/^https?:\/\//.test(url) ? url : 'http://' + url).hostname.replace(/^www\./, ''); }
  catch { return String(url || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]; }
}

// Same on-site page? Compares host + path (www-insensitive, trailing-slash-
// insensitive, ignoring query/hash) so a backlink's target page can be
// matched against the page currently being inspected.
function webceoSamePage(a, b) {
  const norm = (u) => {
    if (!u) return '';
    try {
      const url = new URL(/^https?:\/\//.test(u) ? u : 'https://' + u);
      const host = url.hostname.replace(/^www\./i, '').toLowerCase();
      const path = url.pathname.replace(/\/+$/, '') || '/';
      return host + path;
    } catch { return String(u).trim().toLowerCase(); }
  };
  return !!a && !!b && norm(a) === norm(b);
}

// The raw get_backlinks list is large and only needed for client-side
// re-aggregation (all vs. this-page) and the toxic export — keep just the
// fields webceoAggregateBacklinks reads, capped so the cache stays well
// under the storage quota.
const WEBCEO_RAW_BACKLINK_CAP = 6000;
function webceoTrimBacklinks(list) {
  return (list || []).slice(0, WEBCEO_RAW_BACKLINK_CAP).map(l => ({
    page_url: l.page_url, title: l.title, link_text: l.link_text,
    link_target_page: l.link_target_page, link_nofollow: l.link_nofollow,
    link_status: l.link_status, link_sitewide: l.link_sitewide, is_new: l.is_new,
    domain_trusted_flow: l.domain_trusted_flow, domain_citation_flow: l.domain_citation_flow,
    domain_primary_topic: l.domain_primary_topic, url_trusted_flow: l.url_trusted_flow,
    first_discovered: l.first_discovered
  }));
}

// Builds the popup payload from a cached raw-link entry: the whole-project
// aggregate, a page-scoped aggregate (links whose target is the current
// page), and the full deduped list of toxic referring domains for the
// disavow export (uncapped, unlike the per-domain link samples).
function webceoBuildBacklinksView(entry, pageUrl) {
  const raw = entry.rawLinks || [];
  const all = webceoAggregateBacklinks(raw);
  const thisPage = webceoAggregateBacklinks(raw.filter(l => webceoSamePage(l.link_target_page, pageUrl)));
  const toxSet = new Set();
  raw.forEach(l => { if ((l.link_status || '') === 'toxic') { const d = webceoBacklinkDomain(l.page_url); if (d) toxSet.add(d); } });
  return {
    host: entry.host, project: entry.project, projectName: entry.projectName,
    domain: entry.domain, scannedDate: entry.scannedDate, fetchedAt: entry.fetchedAt,
    ...all, thisPage, toxicDomains: [...toxSet].sort()
  };
}
function webceoAggregateBacklinks(links) {
  const domMap = new Map(), anchorMap = new Map(), targetMap = new Map();
  let follow = 0, nofollow = 0, toxic = 0, disavowed = 0, newLinks = 0, sitewide = 0;
  (links || []).forEach(l => {
    const nf = !!l.link_nofollow;
    if (nf) nofollow++; else follow++;
    const st = l.link_status || 'OK';
    if (st === 'toxic') toxic++;
    if (st.indexOf('disavowed') === 0 || st.indexOf('reported') !== -1) disavowed++;
    if (l.is_new) newLinks++;
    if (l.link_sitewide) sitewide++;

    const d = webceoBacklinkDomain(l.page_url);
    if (!domMap.has(d)) domMap.set(d, { domain: d, count: 0, follow: 0, nofollow: 0, toxic: 0, isNew: false, tf: l.domain_trusted_flow ?? null, cf: l.domain_citation_flow ?? null, topic: l.domain_primary_topic || '', links: [] });
    const g = domMap.get(d);
    g.count++;
    if (nf) g.nofollow++; else g.follow++;
    if (st === 'toxic') g.toxic++;
    if (l.is_new) g.isNew = true;
    if (g.tf == null && l.domain_trusted_flow != null) g.tf = l.domain_trusted_flow;
    if (g.cf == null && l.domain_citation_flow != null) g.cf = l.domain_citation_flow;
    if (g.links.length < 20) g.links.push({ page_url: l.page_url, title: l.title || '', anchor: l.link_text || '', target: l.link_target_page || '', nofollow: nf, status: st, tf: l.url_trusted_flow ?? null, first: l.first_discovered || null, sitewide: !!l.link_sitewide });

    const a = (l.link_text || '').trim() || '(empty anchor)';
    anchorMap.set(a, (anchorMap.get(a) || 0) + 1);
    const t = l.link_target_page || '';
    if (t) targetMap.set(t, (targetMap.get(t) || 0) + 1);
  });

  const domains = [...domMap.values()].sort((a, b) => (b.tf ?? -1) - (a.tf ?? -1) || b.count - a.count).slice(0, 300);
  const anchors = [...anchorMap.entries()].map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count).slice(0, 40);
  const targets = [...targetMap.entries()].map(([page, count]) => ({ page, count })).sort((a, b) => b.count - a.count).slice(0, 25);
  const tfVals = [...domMap.values()].map(g => g.tf).filter(v => v != null);
  const maxTF = tfVals.length ? Math.max(...tfVals) : null;
  const avgTF = tfVals.length ? Math.round(tfVals.reduce((s, v) => s + v, 0) / tfVals.length) : null;

  return { total: (links || []).length, referringDomains: domMap.size, follow, nofollow, toxic, disavowed, newLinks, sitewide, maxTF, avgTF, domains, anchors, targets };
}

// Backlinks for the current domain's project (get_backlinks). Cached 24h in
// webceoBacklinksCache; returns the aggregate (not the raw list) so the popup
// just renders. { connected:false } / { error:'NO_PROJECT' } gate the Overview
// entry the same way the rankings handler does.
async function webceoGetBacklinks({ pageUrl, forceRefresh = false, cacheOnly = false }) {
  const { apiKey } = await webceoConfig();
  if (!apiKey) return { connected: false };
  const host = gscPageHost(pageUrl);
  const project = await webceoResolveProject({ pageUrl });
  if (project.error) return { connected: true, error: project.error, detail: project.detail };
  if (!project.project) return { connected: true, error: 'NO_PROJECT', host };

  const cacheKey = `${host}::${project.project}`;
  const { webceoBacklinksCache } = await browser.storage.local.get('webceoBacklinksCache');
  const cache = webceoBacklinksCache || {};
  const cached = cache[cacheKey];
  // `rawLinks` guard: entries cached by an older build hold only the
  // aggregate, so treat those as stale and re-fetch to populate rawLinks.
  if (!forceRefresh && cached && cached.rawLinks && (Date.now() - cached.fetchedAt < WEBCEO_BACKLINKS_STALE_MS)) {
    return { connected: true, ...webceoBuildBacklinksView(cached, pageUrl), fromCache: true };
  }
  // See webceoGetSiteAudit — the Action Plan reads this opportunistically and
  // must never trigger a live fetch of its own.
  if (cacheOnly) return { connected: true, notCached: true };

  const res = await webceoCall('get_backlinks', { project: project.project });
  if (res.error) return { connected: true, error: res.error, detail: res.detail };

  const projInfo = project.projects.find(p => p.project === project.project);
  const entry = {
    fetchedAt: Date.now(), host, project: project.project,
    projectName: projInfo ? projInfo.name : '',
    domain: (res.data && res.data.domain) || (projInfo && projInfo.domain) || host,
    scannedDate: (res.data && res.data.scanned_date) || null,
    rawLinks: webceoTrimBacklinks(res.data && res.data.data)
  };
  cache[cacheKey] = entry;
  await writeCache('webceoBacklinksCache', cache);
  return { connected: true, ...webceoBuildBacklinksView(entry, pageUrl), fromCache: false };
}

// ─── Lost Backlinks (get_lost_backlinks) ─────────────────────────────────────
// Links that pointed to the site on the previous scan and are gone on the
// latest one — the highest-signal "what did we just lose" view, so unlike the
// main backlinks list (dedup'd to referring domains) this stays a flat,
// TF-ranked list of the actual lost links.
function webceoTrimLostBacklinks(list) {
  return (list || []).slice(0, WEBCEO_RAW_BACKLINK_CAP).map(l => ({
    page_url: l.page_url, title: l.title, link_text: l.link_text,
    link_target_page: l.link_target_page, link_nofollow: l.link_nofollow,
    last_status: l.last_status, domain_trusted_flow: l.domain_trusted_flow,
    domain_citation_flow: l.domain_citation_flow, url_trusted_flow: l.url_trusted_flow,
    first_discovered: l.first_discovered, last_crawled: l.last_crawled
  }));
}
function webceoAggregateLostBacklinks(list) {
  const rows = (list || []).map(l => ({
    page_url: l.page_url, title: l.title || '', anchor: l.link_text || '',
    target: l.link_target_page || '', nofollow: !!l.link_nofollow,
    status: l.last_status || 'OK', tf: l.domain_trusted_flow ?? null,
    firstDiscovered: l.first_discovered || null, lastCrawled: l.last_crawled || null
  }));
  rows.sort((a, b) => (b.tf ?? -1) - (a.tf ?? -1));
  return { total: rows.length, links: rows.slice(0, 150) };
}
// Same "all" + page-scoped split as webceoBuildBacklinksView, so Lost
// Backlinks respects the same "This page only" toggle as the rest of the panel.
function webceoBuildLostBacklinksView(entry, pageUrl) {
  const raw = entry.rawLostLinks || [];
  const all = webceoAggregateLostBacklinks(raw);
  const thisPage = webceoAggregateLostBacklinks(raw.filter(l => webceoSamePage(l.link_target_page, pageUrl)));
  return { fetchedAt: entry.fetchedAt, ...all, thisPage };
}
async function webceoGetLostBacklinks({ pageUrl, forceRefresh = false }) {
  const { apiKey } = await webceoConfig();
  if (!apiKey) return { connected: false };
  const host = gscPageHost(pageUrl);
  const project = await webceoResolveProject({ pageUrl });
  if (project.error) return { connected: true, error: project.error, detail: project.detail };
  if (!project.project) return { connected: true, error: 'NO_PROJECT', host };

  const cacheKey = `${host}::${project.project}`;
  const { webceoLostBacklinksCache } = await browser.storage.local.get('webceoLostBacklinksCache');
  const cache = webceoLostBacklinksCache || {};
  const cached = cache[cacheKey];
  if (!forceRefresh && cached && cached.rawLostLinks && (Date.now() - cached.fetchedAt < WEBCEO_LOST_BACKLINKS_STALE_MS)) {
    return { connected: true, ...webceoBuildLostBacklinksView(cached, pageUrl), fromCache: true };
  }

  const res = await webceoCall('get_lost_backlinks', { project: project.project });
  if (res.error) return { connected: true, error: res.error, detail: res.detail };

  const entry = { fetchedAt: Date.now(), rawLostLinks: webceoTrimLostBacklinks(res.data && res.data.data) };
  cache[cacheKey] = entry;
  await writeCache('webceoLostBacklinksCache', cache);
  return { connected: true, ...webceoBuildLostBacklinksView(entry, pageUrl), fromCache: false };
}

// ─── Linking Domains (get_linking_domains) ───────────────────────────────────
// Per-domain rollup straight from Web CEO — richer than what we can derive
// client-side from get_backlinks alone: an authoritative nofollow/toxic % and,
// notably, organic_visits (a real traffic signal for each referring domain we
// have no other source for). Used to enrich the existing Referring Domains
// list (merged in by domain name), not to replace it.
function webceoAggregateLinkingDomains(list) {
  const rows = (list || []).map(l => ({
    domain: l.linking_domain, tf: l.domain_trusted_flow ?? null, cf: l.domain_citation_flow ?? null,
    topic: l.domain_primary_topic || '', totalLinks: l.total_links ?? null, juicyLinks: l.juicy_links ?? null,
    nofollowPct: l.nofollow ?? null, toxicPct: l.toxic ?? null, organicVisits: l.organic_visits ?? null,
    isNew: !!l.is_new
  }));
  rows.sort((a, b) => (b.tf ?? -1) - (a.tf ?? -1));
  return { domains: rows.slice(0, 300) };
}
async function webceoGetLinkingDomains({ pageUrl, forceRefresh = false }) {
  const { apiKey } = await webceoConfig();
  if (!apiKey) return { connected: false };
  const host = gscPageHost(pageUrl);
  const project = await webceoResolveProject({ pageUrl });
  if (project.error) return { connected: true, error: project.error, detail: project.detail };
  if (!project.project) return { connected: true, error: 'NO_PROJECT', host };

  const cacheKey = `${host}::${project.project}`;
  const { webceoLinkingDomainsCache } = await browser.storage.local.get('webceoLinkingDomainsCache');
  const cache = webceoLinkingDomainsCache || {};
  const cached = cache[cacheKey];
  if (!forceRefresh && cached && (Date.now() - cached.fetchedAt < WEBCEO_LINKING_DOMAINS_STALE_MS)) {
    return { connected: true, ...cached.aggregate, fetchedAt: cached.fetchedAt, fromCache: true };
  }

  const res = await webceoCall('get_linking_domains', { project: project.project });
  if (res.error) return { connected: true, error: res.error, detail: res.detail };

  const aggregate = webceoAggregateLinkingDomains(res.data && res.data.data);
  cache[cacheKey] = { fetchedAt: Date.now(), aggregate };
  await writeCache('webceoLinkingDomainsCache', cache);
  return { connected: true, ...aggregate, fetchedAt: cache[cacheKey].fetchedAt, fromCache: false };
}

// ─── Competitor Metrics (get_competitor_metrics) ─────────────────────────────
// Summarized backlink profile for the site AND whatever competitors are
// configured in Web CEO's Backlink Quality Check settings (added there, not
// in this extension — set_competitors is a bigger scope-add left for later).
// Field names ".gov"/".edu"/".gov_domains"/".edu_domains" are literal per the
// API, hence the bracket access below.
function webceoAggregateCompetitorMetrics(list, ownDomain) {
  const norm = h => String(h || '').replace(/^www\./, '').toLowerCase();
  const own = norm(ownDomain);
  const rows = (list || []).map(l => ({
    domain: l.domain, isYou: norm(l.domain) === own,
    tf: l.trusted_flow ?? null, cf: l.citation_flow ?? null, mozDA: l.moz_domain_authority ?? null,
    total: l.total ?? null, referringDomains: l.domains ?? null, subnets: l.subnets ?? null, ips: l.ips ?? null,
    gov: l['.gov'] ?? null, edu: l['.edu'] ?? null, govDomains: l['.gov_domains'] ?? null, eduDomains: l['.edu_domains'] ?? null,
    topic: l.primary_topic || ''
  }));
  // "You" first, then competitors ranked by referring-domain count (the
  // closest available proxy for overall backlink authority in this payload).
  rows.sort((a, b) => (b.isYou - a.isYou) || ((b.referringDomains ?? -1) - (a.referringDomains ?? -1)));
  return { competitors: rows };
}
async function webceoGetCompetitorMetrics({ pageUrl, forceRefresh = false }) {
  const { apiKey } = await webceoConfig();
  if (!apiKey) return { connected: false };
  const host = gscPageHost(pageUrl);
  const project = await webceoResolveProject({ pageUrl });
  if (project.error) return { connected: true, error: project.error, detail: project.detail };
  if (!project.project) return { connected: true, error: 'NO_PROJECT', host };

  const cacheKey = `${host}::${project.project}`;
  const { webceoCompetitorMetricsCache } = await browser.storage.local.get('webceoCompetitorMetricsCache');
  const cache = webceoCompetitorMetricsCache || {};
  const cached = cache[cacheKey];
  if (!forceRefresh && cached && (Date.now() - cached.fetchedAt < WEBCEO_COMPETITOR_METRICS_STALE_MS)) {
    return { connected: true, ...cached.aggregate, fetchedAt: cached.fetchedAt, fromCache: true };
  }

  const res = await webceoCall('get_competitor_metrics', { project: project.project });
  if (res.error) return { connected: true, error: res.error, detail: res.detail };

  const ownDomain = (res.data && res.data.domain) || host;
  const aggregate = webceoAggregateCompetitorMetrics(res.data && res.data.data, ownDomain);
  cache[cacheKey] = { fetchedAt: Date.now(), aggregate };
  await writeCache('webceoCompetitorMetricsCache', cache);
  return { connected: true, ...aggregate, fetchedAt: cache[cacheKey].fetchedAt, fromCache: false };
}

// Site Audit (get_site_audit_data). Trims the (potentially large) per-page
// payload to just what the panel shows: each page's Problem factors, a capped
// sample of its broken links, optimization %, and speed scores. Whole-site
// headline metrics + site-wide Problem factors ride alongside.
const SITE_AUDIT_BROKEN_KINDS = {
  ilinks: 'Internal broken link', elinks: 'External broken link',
  pictures: 'Broken image', anchors: 'Broken anchor',
  i_server: 'Internal server error', e_server: 'External server error',
  i_page: 'Internal page error', e_page: 'External page error',
  mixed_content: 'Mixed content', ijavascript: 'Broken JS (internal)',
  ejavascript: 'Broken JS (external)', icss: 'Broken CSS (internal)', ecss: 'Broken CSS (external)'
};
// Keys of a factor object whose value is { status: 'Problem' }.
function webceoAuditProblems(obj) {
  const out = [];
  Object.keys(obj || {}).forEach(k => {
    const v = obj[k];
    if (v && typeof v === 'object' && v.status === 'Problem') out.push(k);
  });
  return out;
}
function webceoAggregateSiteAudit(d) {
  const pages = (d.pages || []).map(p => {
    const broken = [];
    let brokenCount = 0;
    Object.keys(SITE_AUDIT_BROKEN_KINDS).forEach(kind => {
      const list = p[kind] || [];
      brokenCount += list.length;
      list.forEach(item => { if (broken.length < 60) broken.push({ kind, url: item.url, status: item.status, line: item.line ?? null }); });
    });
    const landing = p.landing || {};
    const speed = p.speed_optimization || {};
    return {
      url: p.url,
      unavailable: !!p.page_unavailable,
      optimization: (landing.page_optimization != null) ? landing.page_optimization : null,
      totalWords: landing.total_words ?? null,
      desktopSpeed: speed.desktop_speed_score ?? null,
      mobileSpeed: speed.mobile_speed_score ?? null,
      generalProblems: webceoAuditProblems(p.general),
      landingProblems: webceoAuditProblems(landing),
      broken,
      brokenCount
    };
  });
  return {
    siteOptimization: d.site_optimization ?? null,
    generalErrors: d.general_errors ?? null,
    optimizerErrors: d.optimizer_errors ?? null,
    brokenLinks: d.broken_links ?? null,
    brokenAnchors: d.broken_anchors ?? null,
    scannedPages: d.scanned_pages ?? null,
    scannedObjects: d.scanned_objects ?? null,
    domainAge: d.domain_age ?? null,
    summary: webceoAuditProblems(d.summary),
    pages
  };
}

// Cached 24h in webceoAuditCache; { connected:false } / NO_PROJECT gate the
// Overview entry the same way the backlinks handler does.
async function webceoGetSiteAudit({ pageUrl, forceRefresh = false, cacheOnly = false }) {
  const { apiKey } = await webceoConfig();
  if (!apiKey) return { connected: false };
  const host = gscPageHost(pageUrl);
  const project = await webceoResolveProject({ pageUrl });
  if (project.error) return { connected: true, error: project.error, detail: project.detail };
  if (!project.project) return { connected: true, error: 'NO_PROJECT', host };

  const cacheKey = `${host}::${project.project}`;
  const { webceoAuditCache } = await browser.storage.local.get('webceoAuditCache');
  const cache = webceoAuditCache || {};
  const cached = cache[cacheKey];
  if (!forceRefresh && cached && (Date.now() - cached.fetchedAt < WEBCEO_AUDIT_STALE_MS)) {
    return { connected: true, ...cached, fromCache: true };
  }
  // The Action Plan passes cacheOnly so opening a plan never spends a Web CEO
  // call — it enriches the prompt when the user has already looked at the audit
  // and stays silent otherwise. Mirrors psiGetPageSpeed's flag exactly.
  if (cacheOnly) return { connected: true, notCached: true };

  const res = await webceoCall('get_site_audit_data', { project: project.project });
  if (res.error) return { connected: true, error: res.error, detail: res.detail };

  const projInfo = project.projects.find(p => p.project === project.project);
  const agg = webceoAggregateSiteAudit(res.data || {});
  const entry = {
    fetchedAt: Date.now(), host, project: project.project,
    projectName: projInfo ? projInfo.name : '',
    domain: (res.data && res.data.domain) || (projInfo && projInfo.domain) || host,
    scannedDate: (res.data && res.data.d_scan) || null,
    ...agg
  };
  cache[cacheKey] = entry;
  await writeCache('webceoAuditCache', cache);
  return { connected: true, ...entry, fromCache: false };
}

// Add a WebCEO "event" (chart annotation) to the domain's project for a date.
// Events show as notes on the rank/traffic/backlink charts (tools list below).
async function webceoAddEvent({ pageUrl, date, text }) {
  const resolved = await webceoResolveProject({ pageUrl });
  if (!resolved.connected) return { connected: false };
  if (resolved.error) return { connected: true, error: resolved.error, detail: resolved.detail };
  if (!resolved.project) return { connected: true, error: 'NO_PROJECT' };

  // The API wants a singular `project` (an array yields "'project' parameter
  // is required") and a required, explicit `tools` list (omitting it yields
  // "'tools' parameter is required"). The full tool set below applies the
  // event to every tool — matching Web CEO's native "Create a new event"
  // dialog, which checks all tools by default.
  const res = await webceoCall('add_event', {
    project: resolved.project,
    date,
    text: String(text || '').slice(0, 500),
    visibility: 'public',
    tools: ['advisor', 'auditor', 'backlinks', 'business', 'competitorlinks', 'competitorstats', 'buzz', 'facebook', 'interlinks', 'links', 'partners', 'ranker', 'social', 'stats', 'submission', 'webmasters'],
    charts_visibility: 1
  });
  if (res.error) return { connected: true, error: res.error, detail: res.detail };
  return { connected: true, ok: true, project: resolved.project, event: (res.data && res.data.event) || null };
}

// List WebCEO events (chart annotations) for the domain's project. Skips
// auto-generated "system" events. Returns [{ date:'YYYY-MM-DD', text }].
// WebCEO event text can contain HTML markup; the chart tooltip renders it as
// plain text, so strip tags + decode the common entities to a clean note.
function webceoStripHtml(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
async function webceoGetEvents({ pageUrl }) {
  const resolved = await webceoResolveProject({ pageUrl });
  if (!resolved.connected) return { connected: false };
  if (resolved.error || !resolved.project) return { connected: true, error: resolved.error || 'NO_PROJECT' };
  const idsRes = await webceoCall('get_event_ids', { project: resolved.project });
  if (idsRes.error) return { connected: true, error: idsRes.error };
  const ids = (idsRes.data && idsRes.data.ids) || [];
  if (!ids.length) return { connected: true, events: [] };
  const evRes = await webceoCall('get_events', { project: resolved.project, ids });
  if (evRes.error) return { connected: true, error: evRes.error };
  const events = ((evRes.data && evRes.data.events) || [])
    .filter(e => e.visibility !== 'system')
    .map(e => ({ date: e.date, text: webceoStripHtml(e.text) }))
    .filter(e => e.date);
  return { connected: true, events };
}

// Merge GA4 + WebCEO annotations by date for the chart-star overlay. Same text
// on the same date across sources collapses into one entry whose `sources`
// lists every place it lives (so the UI can flag "in all").
async function getChartAnnotations({ pageUrl }) {
  const connectedSources = [];
  const all = [];
  const ga = await ga4ListAnnotations({ pageUrl });
  if (ga.connected && !ga.error) { connectedSources.push('ga4'); (ga.annotations || []).forEach(a => all.push({ ...a, source: 'ga4' })); }
  const wc = await webceoGetEvents({ pageUrl });
  if (wc.connected && !wc.error) { connectedSources.push('webceo'); (wc.events || []).forEach(a => all.push({ ...a, source: 'webceo' })); }

  const byDate = {};
  all.forEach(a => {
    if (!a.date) return;
    const norm = (a.text || '').trim().toLowerCase();
    const list = byDate[a.date] || (byDate[a.date] = []);
    const existing = norm && list.find(e => e._norm === norm);
    if (existing) { if (!existing.sources.includes(a.source)) existing.sources.push(a.source); }
    else list.push({ text: a.text, _norm: norm, sources: [a.source] });
  });
  Object.values(byDate).forEach(list => list.forEach(e => { delete e._norm; }));
  return { connectedSources, byDate };
}

function webceoSaveConfig({ apiKey, baseUrl }) {
  const update = {};
  if (apiKey !== undefined) update.webceoApiKey = apiKey;
  if (baseUrl !== undefined) update.webceoBaseUrl = baseUrl;
  return browser.storage.local.set(update)
    .then(() => browser.storage.local.remove(['webceoProjects', 'webceoCache', 'webceoBacklinksCache', 'webceoAuditCache', 'webceoLostBacklinksCache', 'webceoLinkingDomainsCache', 'webceoCompetitorMetricsCache', 'webceoKeywordTagsCache']))
    .then(() => ({ ok: true }));
}

function webceoDisconnect() {
  return browser.storage.local.remove(['webceoApiKey', 'webceoProjects', 'webceoCache', 'webceoBacklinksCache', 'webceoAuditCache', 'webceoLostBacklinksCache', 'webceoLinkingDomainsCache', 'webceoCompetitorMetricsCache', 'webceoKeywordTagsCache', 'webceoProjectOverrides'])
    .then(() => ({ ok: true }));
}

// ─── Competitors (get_competitors / set_competitors) ─────────────────────────
// The "VS. COMPETITORS" section in the Backlinks panel reads whatever
// competitors a Web CEO project has configured, and until now those could only
// be set in Web CEO's own UI — so for most installs that section was simply
// absent. These two handlers make it configurable from the Client panel, which
// is what turns an already-built feature on.
//
// ── An honesty note about the request shape ──────────────────────────────────
// Every other method in this file follows one rigid convention: the payload is
// `{ project: <id>, ...extras }`. That makes the READ a safe inference. The
// WRITE has exactly one genuine unknown — what Web CEO calls the parameter
// holding the list. Nothing in the API probe recorded it, and guessing wrong
// would look identical to success: the call returns 200 and silently changes
// nothing.
//
// So the write does not trust itself. It tries the plausible parameter names in
// turn and RE-READS after each attempt, returning only once the value it sent
// is actually there. If none of them take, it reports SHAPE_UNKNOWN with what
// it tried, rather than telling the user their competitors were saved. When the
// real name is confirmed, collapse SET_PARAM_CANDIDATES to that one entry.
const SET_PARAM_CANDIDATES = ['competitors', 'competitor_domains', 'domains', 'sites'];

// Web CEO could return the list as bare strings or as objects; normalise both
// and drop anything that isn't a usable domain.
function webceoNormalizeCompetitors(raw) {
  const arr = Array.isArray(raw) ? raw
    : (raw && (raw.competitors || raw.domains || raw.data)) || [];
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr
    .map(c => (typeof c === 'string' ? c : (c && (c.domain || c.url || c.site || c.name))) || '')
    .map(s => String(s).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''))
    .filter(Boolean))];
}

async function webceoGetCompetitors({ pageUrl }) {
  const { apiKey } = await webceoConfig();
  if (!apiKey) return { connected: false };
  const project = await webceoResolveProject({ pageUrl });
  if (project.error) return { connected: true, error: project.error, detail: project.detail };
  if (!project.project) return { connected: true, error: 'NO_PROJECT', host: gscPageHost(pageUrl) };

  const res = await webceoCall('get_competitors', { project: project.project });
  if (res.error) return { connected: true, error: res.error, detail: res.detail };
  return { connected: true, competitors: webceoNormalizeCompetitors(res.data) };
}

async function webceoSetCompetitors({ pageUrl, competitors }) {
  const { apiKey } = await webceoConfig();
  if (!apiKey) return { connected: false };
  const project = await webceoResolveProject({ pageUrl });
  if (project.error) return { connected: true, error: project.error, detail: project.detail };
  if (!project.project) return { connected: true, error: 'NO_PROJECT', host: gscPageHost(pageUrl) };

  const wanted = webceoNormalizeCompetitors(competitors);

  let lastError = null;
  for (const param of SET_PARAM_CANDIDATES) {
    const res = await webceoCall('set_competitors', { project: project.project, [param]: wanted });
    if (res.error) { lastError = res; continue; }

    // Verify rather than believe. A 200 with the wrong parameter name is
    // indistinguishable from a successful write until you look.
    const check = await webceoCall('get_competitors', { project: project.project });
    if (check.error) return { connected: true, error: check.error, detail: check.detail };
    const now = webceoNormalizeCompetitors(check.data);
    const took = wanted.every(w => now.includes(w)) && now.length === wanted.length;
    if (took) return { connected: true, ok: true, competitors: now, param };
  }

  return {
    connected: true,
    error: 'SHAPE_UNKNOWN',
    detail: `set_competitors accepted none of: ${SET_PARAM_CANDIDATES.join(', ')}` +
            (lastError ? ` (last API error: ${lastError.error}${lastError.detail ? ' — ' + lastError.detail : ''})` : ''),
    tried: SET_PARAM_CANDIDATES
  };
}
