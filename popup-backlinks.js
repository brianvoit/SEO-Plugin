// Backlinks (Web CEO get_backlinks). An entry on the Overview tab — shown only
// once a Web CEO project resolves for the current domain — opens a full-screen
// detail panel. Data + aggregation come from the background webceoGetBacklinks
// handler; this file just gates the entry and renders.

let _backlinksData = null;
let _backlinksLoading = false;
let _blDomainSort = 'tf';                // 'tf' | 'count'
const _blExpanded = new Set();           // referring-domain rows currently expanded

function blNum(n) { return (n == null ? 0 : n).toLocaleString(); }

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
  if (!_backlinksData || _backlinksData.host !== res.host) _blExpanded.clear();   // fresh domain → drop stale expansions
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
  el.replaceChildren();
  if (!d) {
    if (headerMeta) headerMeta.textContent = '';
    const h = document.createElement('div'); h.className = 'field-hint'; h.textContent = 'No backlink data.'; el.appendChild(h); return;
  }

  // Header meta (in the panel header, between Back and the buttons): scan date + freshness only
  if (headerMeta) headerMeta.textContent = (d.scannedDate ? `scanned ${d.scannedDate}` : '') + (d.fetchedAt ? `${d.scannedDate ? ' · ' : ''}updated ${gscRelativeTime(d.fetchedAt)}` : '');

  // Scorecard
  const followPct = d.total ? Math.round((d.follow / d.total) * 100) : 0;
  const card = document.createElement('div');
  card.className = 'ranking-scorecard bl-scorecard';
  card.appendChild(blStat('Backlinks', blNum(d.total), d.newLinks ? `${blNum(d.newLinks)} new` : null, ''));
  card.appendChild(blStat('Ref. domains', blNum(d.referringDomains), (d.avgTF != null ? `TF avg ${d.avgTF}` : null), 'ranking-stat--primary'));
  card.appendChild(blStat('Follow', followPct + '%', `${blNum(d.nofollow)} nofollow`, ''));
  card.appendChild(blStat('Toxic', blNum(d.toxic), null, d.toxic ? 'bl-stat--warn' : ''));
  el.appendChild(card);

  renderBlReferringDomains(el, d);
  renderBlAnchors(el, d);
  renderBlTargets(el, d);
}

function renderBlReferringDomains(el, d) {
  const sec = document.createElement('section');
  sec.className = 'field-section';
  const header = blSectionLabel('REFERRING DOMAINS');
  // Sort toggle
  const sort = document.createElement('span');
  sort.className = 'bl-sort';
  [['tf', 'Trust Flow'], ['count', 'Links']].forEach(([key, lbl]) => {
    const b = document.createElement('button');
    b.className = 'bl-sort-btn' + (_blDomainSort === key ? ' is-active' : '');
    b.textContent = lbl;
    b.addEventListener('click', () => { _blDomainSort = key; renderBacklinksPanel(); });
    sort.appendChild(b);
  });
  header.appendChild(sort);
  sec.appendChild(header);

  const domains = (d.domains || []).slice().sort((a, b) =>
    _blDomainSort === 'count' ? (b.count - a.count) : ((b.tf ?? -1) - (a.tf ?? -1) || b.count - a.count));

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

    // col 2: nofollow (only when the whole domain is nofollow)
    const followCell = document.createElement('span');
    followCell.className = 'bl-domain-follow';
    if (g.nofollow === g.count && g.count) followCell.appendChild(blChip('nofollow', 'bl-chip--nofollow', 'All links from this domain are nofollow'));
    head.appendChild(followCell);

    // col 3: Trust Flow
    const tfCell = document.createElement('span');
    tfCell.className = 'bl-domain-tf';
    if (g.tf != null) tfCell.appendChild(blChip('TF ' + g.tf, 'bl-chip--tf', `Trust Flow ${g.tf}` + (g.cf != null ? ` · Citation Flow ${g.cf}` : '')));
    head.appendChild(tfCell);

    // col 4: link count
    const countCell = document.createElement('span');
    countCell.className = 'bl-domain-count';
    countCell.textContent = `${g.count} link${g.count === 1 ? '' : 's'}`;
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

function blLinkRow(lk) {
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
    text.className = 'bl-anchor-text';
    text.textContent = a.text;
    const n = document.createElement('span');
    n.className = 'bl-anchor-count';
    n.textContent = a.count;
    row.append(bar, text, n);
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

// Panel header buttons
document.getElementById('btn-backlinks-refresh').addEventListener('click', () => loadBacklinksData(true));
// Search Console has no links API — open its native Links report for this property
document.getElementById('btn-backlinks-gsc').addEventListener('click', () => {
  const domain = (_backlinksData && _backlinksData.domain) || '';
  browser.tabs.create({ url: `https://search.google.com/search-console/links?resource_id=${encodeURIComponent('sc-domain:' + domain)}` });
});
