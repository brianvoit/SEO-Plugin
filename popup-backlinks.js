// Backlinks (Web CEO get_backlinks). An entry on the Overview tab — shown only
// once a Web CEO project resolves for the current domain — opens a full-screen
// detail panel. Data + aggregation come from the background webceoGetBacklinks
// handler; this file just gates the entry and renders.

let _backlinksData = null;
let _backlinksLoading = false;
let _blDomainSort = 'tf';                // 'tf' | 'count'
let _blThisPageOnly = true;              // default: only backlinks pointing at the current page
const _blExpanded = new Set();           // referring-domain rows currently expanded
let _blAnchorFilter = null;              // anchor text clicked in the Anchor Text section, or null

// "Extras" — three additional Web CEO backlink endpoints beyond get_backlinks,
// loaded lazily only once the panel is actually opened (not from the Overview
// entry teaser, which only needs the core get_backlinks summary).
let _blLostData = null;
let _blLinkingDomainsMap = null;         // domain(lowercased) -> get_linking_domains row, for enrichment
let _blCompetitorData = null;
let _blExtrasLoading = false;
let _blExtrasHost = null;
let _blLostExpanded = false;

function blNum(n) { return (n == null ? 0 : n).toLocaleString(); }

// Fetches Lost Backlinks / Linking Domains / Competitor Metrics in parallel.
// Independent of the core get_backlinks load — each is cache-backed 24h in the
// background, so this is cheap on repeat panel opens. Failures are silent
// (each section just stays empty) since these are enrichment, not core data.
async function loadBacklinksExtras(forceRefresh = false) {
  if (_blExtrasLoading) return;
  let pageUrl = '', host = null;
  try { const tab = await getActiveTab(); pageUrl = tab.url; host = new URL(tab.url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return; }
  if (!forceRefresh && _blExtrasHost === host && (_blLostData || _blLinkingDomainsMap || _blCompetitorData)) return;

  _blExtrasLoading = true;
  const [lostRes, domainsRes, compRes] = await Promise.allSettled([
    sendMessageWithTimeout({ action: 'webceoGetLostBacklinks', pageUrl, forceRefresh }),
    sendMessageWithTimeout({ action: 'webceoGetLinkingDomains', pageUrl, forceRefresh }),
    sendMessageWithTimeout({ action: 'webceoGetCompetitorMetrics', pageUrl, forceRefresh })
  ]);
  _blExtrasLoading = false;
  if (_blExtrasHost !== host) _blLostExpanded = false;
  _blExtrasHost = host;

  const lost = lostRes.status === 'fulfilled' ? lostRes.value : null;
  _blLostData = (lost && lost.connected && !lost.error) ? lost : null;

  const dom = domainsRes.status === 'fulfilled' ? domainsRes.value : null;
  if (dom && dom.connected && !dom.error && Array.isArray(dom.domains)) {
    const map = new Map();
    dom.domains.forEach(d => { if (d.domain) map.set(d.domain.toLowerCase(), d); });
    _blLinkingDomainsMap = map;
  } else {
    _blLinkingDomainsMap = null;
  }

  const comp = compRes.status === 'fulfilled' ? compRes.value : null;
  _blCompetitorData = (comp && comp.connected && !comp.error && Array.isArray(comp.competitors) && comp.competitors.length > 1) ? comp : null;

  if (!document.getElementById('backlinks-panel').classList.contains('hidden')) renderBacklinksPanel();
}

// Load for the current page; drives both the Overview entry and (if open) the
// panel. Cache-backed in the background, so repeat loads on the same domain are
// cheap. { connected:false } / NO_PROJECT keep the Overview entry hidden.
async function loadBacklinksData(forceRefresh = false) {
  const entry = document.getElementById('overview-backlinks');
  if (!entry || _backlinksLoading) return;
  _backlinksLoading = true;
  let res = null;
  try {
    const tab = await getActiveTab();
    res = await sendMessageWithTimeout({ action: 'webceoGetBacklinks', pageUrl: tab.url, forceRefresh });
    if (res) res.pageUrl = tab.url;
  } catch { res = null; }
  _backlinksLoading = false;

  const ok = res && res.connected && !res.error;
  entry.classList.toggle('hidden', !ok);
  if (!ok) { _backlinksData = null; return; }
  if (!_backlinksData || _backlinksData.host !== res.host) { _blExpanded.clear(); _blAnchorFilter = null; }   // fresh domain → drop stale expansions/filters
  _backlinksData = res;
  renderBacklinksEntry();
  if (!document.getElementById('backlinks-panel').classList.contains('hidden')) renderBacklinksPanel();
}

function renderBacklinksEntry() {
  const d = _backlinksData;
  const summary = document.getElementById('backlinks-summary');
  if (!d || !summary) return;
  const bits = [`${blNum(d.total)} links`, `${blNum(d.referringDomains)} domains`];
  if (d.toxic) bits.push(`${d.toxic} toxic`);
  summary.textContent = bits.join(' · ');
}

// ─── Detail panel ────────────────────────────────────────────────────────────

function blStat(label, value, sub, cls) {
  const box = document.createElement('div');
  box.className = 'ranking-stat' + (cls ? ' ' + cls : '');
  const v = document.createElement('div'); v.className = 'ranking-stat-val'; v.textContent = value;
  const l = document.createElement('div'); l.className = 'ranking-stat-label'; l.textContent = label;
  box.append(v, l);
  if (sub) { const s = document.createElement('div'); s.className = 'ranking-stat-sub'; s.textContent = sub; box.appendChild(s); }
  return box;
}

function blChip(text, cls, title) {
  const s = document.createElement('span');
  s.className = 'bl-chip' + (cls ? ' ' + cls : '');
  s.textContent = text;
  if (title) s.title = title;
  return s;
}

function blSectionLabel(text) {
  const h = document.createElement('div');
  h.className = 'field-header';
  const l = document.createElement('span');
  l.className = 'field-label';
  l.textContent = text;
  h.appendChild(l);
  return h;
}

function renderBacklinksPanel() {
  const el = document.getElementById('backlinks-content');
  const d = _backlinksData;
  if (!el) return;
  const headerMeta = document.getElementById('backlinks-header-meta');
  const toxicBtn = document.getElementById('btn-backlinks-toxic');
  el.replaceChildren();
  if (!d) {
    if (headerMeta) headerMeta.textContent = '';
    if (toxicBtn) toxicBtn.classList.add('hidden');
    const h = document.createElement('div'); h.className = 'field-hint'; h.textContent = 'No backlink data.'; el.appendChild(h); return;
  }

  // Header meta (in the panel header, between Back and the buttons): scan date + freshness only
  if (headerMeta) headerMeta.textContent = (d.scannedDate ? `scanned ${d.scannedDate}` : '') + (d.fetchedAt ? `${d.scannedDate ? ' · ' : ''}updated ${gscRelativeTime(d.fetchedAt)}` : '');

  // Toxic-export button lives in the header; visible whenever the project has
  // any toxic referring domains (project-wide, independent of the page filter).
  if (toxicBtn) {
    const n = (d.toxicDomains || []).length;
    toxicBtn.classList.toggle('hidden', !n);
    toxicBtn.textContent = `Export toxic (${n})`;
  }

  // "This page only" toggle — filters the whole view to backlinks pointing at
  // the current page (d.thisPage), on by default.
  const pageAgg = d.thisPage || null;
  const toggle = document.createElement('label');
  toggle.className = 'bl-scope-toggle';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = _blThisPageOnly;
  cb.addEventListener('change', () => { _blThisPageOnly = cb.checked; _blExpanded.clear(); _blLostExpanded = false; _blAnchorFilter = null; renderBacklinksPanel(); });
  const span = document.createElement('span');
  span.textContent = `This page only${pageAgg ? ` (${blNum(pageAgg.total)})` : ''}`;
  toggle.append(cb, span);
  el.appendChild(toggle);

  const view = (_blThisPageOnly && pageAgg) ? pageAgg : d;
  const pageEmpty = _blThisPageOnly && pageAgg && !pageAgg.total;

  if (pageEmpty) {
    const h = document.createElement('div');
    h.className = 'field-hint hint-muted';
    h.textContent = 'No backlinks point directly at this page. Uncheck “This page only” to see the whole domain.';
    el.appendChild(h);
  } else {
    // Scorecard
    const followPct = view.total ? Math.round((view.follow / view.total) * 100) : 0;
    const card = document.createElement('div');
    card.className = 'ranking-scorecard bl-scorecard';
    card.appendChild(blStat('Backlinks', blNum(view.total), view.newLinks ? `${blNum(view.newLinks)} new` : null, ''));
    card.appendChild(blStat('Ref. domains', blNum(view.referringDomains), (view.avgTF != null ? `TF avg ${view.avgTF}` : null), 'ranking-stat--primary'));
    card.appendChild(blStat('Follow', followPct + '%', `${blNum(view.nofollow)} nofollow`, ''));
    card.appendChild(blStat('Toxic', blNum(view.toxic), null, view.toxic ? 'bl-stat--warn' : ''));
    el.appendChild(card);

    renderBlReferringDomains(el, view);
    renderBlAnchors(el, view);
    renderBlTargets(el, view);
  }

  // Project-wide sections — independent of the "This page only" scope, since
  // Lost Backlinks respects the same "This page only" toggle as the sections
  // above (rendered even when pageEmpty — a page can have zero CURRENT
  // backlinks and still have lost ones worth surfacing). Competitor metrics
  // are domain-only in the API — no page dimension exists to scope by.
  renderBlLost(el);
  renderBlCompetitors(el);

  // Kick off (or pick up already-loaded) the extras; re-renders these two
  // sections once they arrive.
  if (typeof loadBacklinksExtras === 'function') loadBacklinksExtras(false);
  // "Tracked" pills in Anchor Text need the Web CEO tracked-keyword set —
  // no-ops once loaded, re-renders when it first arrives.
  if (typeof ensureWebceoTracked === 'function') ensureWebceoTracked(() => renderBacklinksPanel());
}

// Lost Backlinks (get_lost_backlinks) — links that pointed to the site last
// scan and don't anymore. Scoped by the same "This page only" toggle as the
// rest of the panel; shown collapsed to the top ~15 highest-authority losses
// with a "show more" affordance up to the 150 the background aggregates.
const BL_LOST_COLLAPSED = 15;
function renderBlLost(el) {
  const root = _blLostData;
  if (!root) return;   // not loaded or failed — no section
  const data = (_blThisPageOnly && root.thisPage) ? root.thisPage : root;
  if (!data.total) return;   // genuinely none in the selected scope
  const sec = document.createElement('section');
  sec.className = 'field-section';
  sec.appendChild(blSectionLabel(`LOST BACKLINKS (${blNum(data.total)})`));

  const list = document.createElement('div');
  list.className = 'bl-domain-detail bl-lost-list';
  const links = data.links || [];
  const shown = _blLostExpanded ? links : links.slice(0, BL_LOST_COLLAPSED);
  shown.forEach(lk => list.appendChild(blLinkRow({
    page_url: lk.page_url, title: lk.title, anchor: lk.anchor, target: lk.target,
    nofollow: lk.nofollow, status: lk.status, sitewide: false
  }, lk.lastCrawled ? `Last seen ${lk.lastCrawled}` : null)));
  sec.appendChild(list);

  if (links.length > BL_LOST_COLLAPSED) {
    const more = document.createElement('button');
    more.className = 'gsc-more-queries-btn';
    more.textContent = _blLostExpanded ? 'Show less' : `Show ${links.length - BL_LOST_COLLAPSED} more`;
    more.addEventListener('click', () => { _blLostExpanded = !_blLostExpanded; renderBacklinksPanel(); });
    sec.appendChild(more);
  }
  el.appendChild(sec);
}

function renderBlReferringDomains(el, d) {
  const sec = document.createElement('section');
  sec.className = 'field-section';

  // Anchor-text filter, set by clicking a term in the Anchor Text section below.
  if (_blAnchorFilter) {
    const bar = document.createElement('button');
    bar.className = 'bl-filter-bar';
    bar.title = 'Matches use each domain’s sampled links (up to 20 per domain) — a domain with many links may not show here even if the anchor exists among its un-sampled links.';
    bar.append('Anchor: “' + _blAnchorFilter.label + '” ', Object.assign(document.createElement('span'), { className: 'bl-filter-clear', textContent: '✕' }));
    bar.addEventListener('click', () => { _blAnchorFilter = null; renderBacklinksPanel(); });
    sec.appendChild(bar);
  }

  // Column headers — same fixed grid as each row below, so TF/Links line up
  // with their values instead of floating as free buttons. The section title
  // doubles as column A's header instead of sitting on its own line.
  const colHead = document.createElement('div');
  colHead.className = 'bl-domain-head bl-domain-colhead';
  const titleCell = document.createElement('span');
  titleCell.className = 'field-label';
  titleCell.textContent = 'REFERRING DOMAINS';
  colHead.appendChild(titleCell);
  colHead.appendChild(document.createElement('span'));   // nofollow column: no header needed
  const visitsHead = document.createElement('span');
  visitsHead.className = 'bl-domain-metric bl-domain-colhead-label';
  visitsHead.textContent = 'VISITS';
  colHead.appendChild(visitsHead);
  [['tf', 'TF'], ['count', 'LINKS']].forEach(([key, lbl]) => {
    const b = document.createElement('button');
    const active = _blDomainSort === key;
    b.className = 'bl-domain-metric bl-domain-sort' + (active ? ' is-active' : '');
    b.textContent = lbl;
    b.addEventListener('click', () => { _blDomainSort = key; renderBacklinksPanel(); });
    colHead.appendChild(b);
  });
  sec.appendChild(colHead);

  let domains = (d.domains || []).slice().sort((a, b) =>
    _blDomainSort === 'count' ? (b.count - a.count) : ((b.tf ?? -1) - (a.tf ?? -1) || b.count - a.count));
  if (_blAnchorFilter) {
    const norm = _blAnchorFilter.raw.toLowerCase().trim();
    domains = domains.filter(g => (g.links || []).some(lk => (lk.anchor || '').toLowerCase().trim() === norm));
  }
  if (_blAnchorFilter && !domains.length) {
    const h = document.createElement('div');
    h.className = 'field-hint hint-muted';
    h.textContent = 'No referring domains found with this anchor text.';
    sec.appendChild(h);
    el.appendChild(sec);
    return;
  }

  const list = document.createElement('div');
  list.className = 'bl-domain-list';
  domains.forEach(g => {
    const row = document.createElement('div');
    row.className = 'bl-domain';

    const head = document.createElement('button');
    head.className = 'bl-domain-head';

    // col 1: domain name + new/toxic chips immediately after it
    const nameGroup = document.createElement('span');
    nameGroup.className = 'bl-domain-name-group';
    const name = document.createElement('span');
    name.className = 'bl-domain-name';
    name.textContent = g.domain;
    nameGroup.appendChild(name);
    if (g.isNew) nameGroup.appendChild(blChip('new', 'bl-chip--new', 'Includes newly discovered links'));
    if (g.toxic) nameGroup.appendChild(blChip('toxic', 'bl-chip--toxic', `${g.toxic} toxic link(s)`));
    head.appendChild(nameGroup);

    // col 2: nofollow chip (only when the whole domain is nofollow) — stays a
    // chip, but in its own fixed column so it never shifts the metric columns
    // that follow it.
    const followCell = document.createElement('span');
    followCell.className = 'bl-domain-follow';
    if (g.nofollow === g.count && g.count) followCell.appendChild(blChip('nofollow', 'bl-chip--nofollow', 'All links from this domain are nofollow'));
    head.appendChild(followCell);

    // col 3: organic visits — plain metric column (get_linking_domains,
    // project-wide enrichment matched by domain name), not a chip, so its
    // absence/presence never moves the columns after it.
    const ld = _blLinkingDomainsMap && _blLinkingDomainsMap.get((g.domain || '').toLowerCase());
    const visitsCell = document.createElement('span');
    visitsCell.className = 'bl-domain-metric bl-domain-visits';
    if (ld && ld.organicVisits != null && ld.organicVisits > 0) {
      visitsCell.textContent = (typeof gscFormatVolume === 'function') ? gscFormatVolume(ld.organicVisits) : blNum(ld.organicVisits);
      visitsCell.title = `${blNum(ld.organicVisits)} estimated organic visits/mo to this domain`;
    } else {
      visitsCell.textContent = '—';
    }
    head.appendChild(visitsCell);

    // col 4: Trust Flow — plain metric column
    const tfCell = document.createElement('span');
    tfCell.className = 'bl-domain-metric bl-domain-tf';
    if (g.tf != null) {
      tfCell.textContent = String(g.tf);
      tfCell.title = `Trust Flow ${g.tf}` + (g.cf != null ? ` · Citation Flow ${g.cf}` : '');
    } else {
      tfCell.textContent = '—';
    }
    head.appendChild(tfCell);

    // col 5: link count — plain metric column
    const countCell = document.createElement('span');
    countCell.className = 'bl-domain-metric bl-domain-count';
    countCell.textContent = String(g.count);
    head.appendChild(countCell);

    row.appendChild(head);

    const detail = document.createElement('div');
    detail.className = 'bl-domain-detail' + (_blExpanded.has(g.domain) ? '' : ' hidden');
    (g.links || []).forEach(lk => detail.appendChild(blLinkRow(lk)));
    row.appendChild(detail);

    head.addEventListener('click', () => {
      if (_blExpanded.has(g.domain)) _blExpanded.delete(g.domain); else _blExpanded.add(g.domain);
      detail.classList.toggle('hidden', !_blExpanded.has(g.domain));
    });

    list.appendChild(row);
  });
  sec.appendChild(list);
  el.appendChild(sec);
}

function blLinkRow(lk, note) {
  const r = document.createElement('div');
  r.className = 'bl-link';

  const top = document.createElement('div');
  top.className = 'bl-link-top';
  const a = document.createElement('a');
  a.className = 'bl-link-url';
  a.textContent = lk.title || lk.page_url;
  a.title = lk.page_url;
  a.href = lk.page_url;
  a.addEventListener('click', (e) => { e.preventDefault(); browser.tabs.create({ url: lk.page_url }); });
  top.appendChild(a);
  if (lk.nofollow) top.appendChild(blChip('nofollow', 'bl-chip--nofollow'));
  if (lk.status === 'toxic') top.appendChild(blChip('toxic', 'bl-chip--toxic'));
  if (lk.sitewide) top.appendChild(blChip('sitewide', '', 'Appears site-wide (footer/nav)'));
  r.appendChild(top);

  const sub = document.createElement('div');
  sub.className = 'bl-link-sub';
  const anchor = document.createElement('span');
  anchor.className = 'bl-link-anchor';
  anchor.textContent = lk.anchor ? `“${lk.anchor}”` : '(no anchor text)';
  sub.appendChild(anchor);
  if (lk.target) {
    const arrow = document.createElement('span');
    arrow.className = 'bl-link-target';
    arrow.textContent = ' → ' + lk.target;
    arrow.title = 'Links to: ' + lk.target;
    sub.appendChild(arrow);
  }
  r.appendChild(sub);

  if (note) {
    const noteEl = document.createElement('div');
    noteEl.className = 'bl-link-note';
    noteEl.textContent = note;
    r.appendChild(noteEl);
  }
  return r;
}

function renderBlAnchors(el, d) {
  if (!d.anchors || !d.anchors.length) return;
  const sec = document.createElement('section');
  sec.className = 'field-section';
  sec.appendChild(blSectionLabel('ANCHOR TEXT'));
  const max = d.anchors[0].count || 1;
  const list = document.createElement('div');
  list.className = 'bl-anchor-list';
  d.anchors.forEach(a => {
    const row = document.createElement('div');
    row.className = 'bl-anchor';
    const bar = document.createElement('span');
    bar.className = 'bl-anchor-bar';
    bar.style.width = Math.max(4, Math.round((a.count / max) * 100)) + '%';
    const text = document.createElement('span');
    text.className = 'bl-anchor-text bl-anchor-text--clickable' + (_blAnchorFilter && _blAnchorFilter.label === a.text ? ' is-active' : '');
    text.textContent = a.text;
    text.title = 'Filter Referring Domains to this anchor text';
    text.addEventListener('click', (e) => {
      e.stopPropagation();
      const raw = a.text === '(empty anchor)' ? '' : a.text;
      _blAnchorFilter = (_blAnchorFilter && _blAnchorFilter.label === a.text) ? null : { label: a.text, raw };
      renderBacklinksPanel();
    });
    row.append(bar, text);
    // Anchor text that's also a keyword tracked in Web CEO — same "Tracked" signal used on the Search/Ads tabs.
    if (typeof webceoIsTracked === 'function' && webceoIsTracked(a.text)) {
      row.appendChild(blChip('Tracked', 'bl-chip--tracked', 'This anchor text is a keyword tracked in your Web CEO project'));
    }
    const n = document.createElement('span');
    n.className = 'bl-anchor-count';
    n.textContent = a.count;
    row.appendChild(n);
    list.appendChild(row);
  });
  sec.appendChild(list);
  el.appendChild(sec);
}

function renderBlTargets(el, d) {
  if (!d.targets || !d.targets.length) return;
  const sec = document.createElement('section');
  sec.className = 'field-section';
  sec.appendChild(blSectionLabel('MOST-LINKED PAGES'));
  const list = document.createElement('div');
  list.className = 'bl-target-list';
  d.targets.forEach(t => {
    const row = document.createElement('div');
    row.className = 'bl-target';
    const a = document.createElement('a');
    a.className = 'bl-target-url';
    let path = t.page;
    try { const u = new URL(t.page); path = u.pathname + u.search || '/'; } catch { /* keep raw */ }
    a.textContent = path;
    a.title = t.page;
    a.href = t.page;
    a.addEventListener('click', (e) => { e.preventDefault(); browser.tabs.create({ url: t.page }); });
    const n = document.createElement('span');
    n.className = 'bl-target-count';
    n.textContent = `${t.count} link${t.count === 1 ? '' : 's'}`;
    row.append(a, n);
    list.appendChild(row);
  });
  sec.appendChild(list);
  el.appendChild(sec);
}

// Competitor Metrics (get_competitor_metrics) — your domain vs whatever
// competitors are configured in Web CEO's Backlink Quality Check settings
// (configured there, not in this extension). Omitted entirely when no
// competitors are configured (the API returns just your own domain).
function renderBlCompetitors(el) {
  const data = _blCompetitorData;
  if (!data || !data.competitors || data.competitors.length < 2) return;
  const sec = document.createElement('section');
  sec.className = 'field-section';
  sec.appendChild(blSectionLabel('VS. COMPETITORS'));

  const list = document.createElement('div');
  list.className = 'bl-comp-list';
  data.competitors.forEach(c => {
    const row = document.createElement('div');
    row.className = 'bl-comp-row' + (c.isYou ? ' bl-comp-row--you' : '');

    const head = document.createElement('div');
    head.className = 'bl-comp-head';
    const name = document.createElement('span');
    name.className = 'bl-comp-domain';
    name.textContent = c.domain;
    head.appendChild(name);
    if (c.isYou) head.appendChild(blChip('You', 'bl-chip--you'));
    const stats = document.createElement('span');
    stats.className = 'bl-comp-stats';
    if (c.tf != null) stats.appendChild(blChip('TF ' + c.tf, 'bl-chip--tf', 'Trust Flow'));
    if (c.mozDA != null) stats.appendChild(blChip('DA ' + c.mozDA, '', 'Moz Domain Authority'));
    head.appendChild(stats);
    row.appendChild(head);

    const bits = [];
    if (c.total != null) bits.push(`${blNum(c.total)} backlinks`);
    if (c.referringDomains != null) bits.push(`${blNum(c.referringDomains)} ref. domains`);
    if (c.gov) bits.push(`${blNum(c.gov)} .gov`);
    if (c.edu) bits.push(`${blNum(c.edu)} .edu`);
    if (bits.length) {
      const sub = document.createElement('div');
      sub.className = 'bl-comp-sub';
      sub.textContent = bits.join(' · ');
      row.appendChild(sub);
    }
    list.appendChild(row);
  });
  sec.appendChild(list);
  el.appendChild(sec);
}

// Build + download a Google Search Console disavow file for the project's
// toxic referring domains. Domain-level (`domain:<host>`) entries are the
// recommended granularity for spammy/toxic links — one line disavows every
// URL from that domain. Format ref:
// https://support.google.com/webmasters/answer/2648487
function exportToxicDisavow() {
  const d = _backlinksData;
  const domains = (d && d.toxicDomains) || [];
  if (!domains.length) return;
  const stamp = new Date().toISOString().slice(0, 10);
  const lines = [
    `# Disavow file — toxic backlinks for ${d.domain || d.host || 'site'}`,
    `# Generated ${stamp} by SEO Inspector`,
    '# Upload at https://search.google.com/search-console/disavow-links',
    '',
    ...domains.map(dom => `domain:${dom}`)
  ];
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `disavow-${(d.domain || d.host || 'site').replace(/[^a-z0-9.-]/gi, '_')}-${stamp}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Panel header buttons
document.getElementById('btn-backlinks-toxic').addEventListener('click', exportToxicDisavow);
document.getElementById('btn-backlinks-refresh').addEventListener('click', () => {
  loadBacklinksData(true);
  loadBacklinksExtras(true);
});
// Search Console has no links API — open its native Links report for this property
document.getElementById('btn-backlinks-gsc').addEventListener('click', () => {
  const domain = (_backlinksData && _backlinksData.domain) || '';
  browser.tabs.create({ url: `https://search.google.com/search-console/links?resource_id=${encodeURIComponent('sc-domain:' + domain)}` });
});
