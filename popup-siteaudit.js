// Site Audit (Web CEO get_site_audit_data). An Overview entry — shown only once
// a Web CEO project resolves for the domain — opens a full-screen panel that
// lists the site's issues, filtered to the current page by default ("This page
// only"); unchecking shows issues across the whole site. Each issue expands to
// explain what it is, how to fix it, and (for the current page) the specific
// cause pulled from our own on-page inspection.

let _siteAuditData = null;
let _siteAuditLoading = false;
let _siteAuditPageOnly = true;            // default: just the page you're on
const _saIssueOpen = new Set();           // expanded issue keys

function saNum(n) { return (n == null ? 0 : n).toLocaleString(); }

// Human labels for the Web CEO audit factor keys (Appendix A names condensed).
const SA_FACTOR_LABELS = {
  title: 'Title tag', title_length: 'Title length', title_uniq: 'Duplicate title', title_stuffing: 'Title keyword stuffing',
  description: 'Meta description', description_length: 'Description length', description_uniq: 'Duplicate description', description_stuffing: 'Description stuffing',
  h1: 'H1 tag', h1_presence: 'Missing H1', h1_stuffing: 'H1 keyword stuffing',
  links_count: 'Too many links', links_diversity: 'Low link diversity', redirect: 'Redirect', meta_redirect: 'Meta redirect',
  url_ansi: 'Non-ASCII URL', url_query: 'URL query string', url_dashes: 'URL dashes', url_one: 'Keyword in URL', multiple_urls: 'Multiple URLs',
  img_alt: 'Image alt text', img_name: 'Image file names',
  presence: 'Keyword presence', stuffing: 'Keyword stuffing', broken_links: 'Broken links',
  rel_canonical: 'Canonical tag', rel_canonical_stuffing: 'Canonical stuffing',
  schema: 'Schema markup', og: 'Open Graph', content_fresh: 'Content freshness',
  page_speed: 'Desktop speed', mobile_speed: 'Mobile speed', body: 'Keyword in body', body_persent: 'Keyword density',
  h2_h4: 'Keyword in H2–H4', inbound_links: 'Internal links'
};
function saNormKey(k) { return String(k || '').replace(/^kw_/, ''); }
function saLabel(key) {
  const k = saNormKey(key);
  return SA_FACTOR_LABELS[k] || k.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
}

// What each check is + how to fix it (shown when an issue is expanded).
const SA_FACTOR_INFO = {
  title: { what: 'The page has no <title> tag, or it isn’t aligned with the page topic. The title is the clickable headline in search results.', fix: 'Add a unique, descriptive title (~50–60 characters) with the primary keyword near the front.' },
  title_length: { what: 'The <title> is too short or too long, so Google may truncate or rewrite it in results.', fix: 'Keep the title ~50–60 characters (about 600px).' },
  title_uniq: { what: 'This title also appears on other pages, so search engines can’t tell them apart.', fix: 'Give every page a distinct title.' },
  title_stuffing: { what: 'The title repeats the keyword too many times (keyword stuffing).', fix: 'Use the keyword once, written naturally.' },
  description: { what: 'The page has no meta description, so Google writes its own snippet from the page text.', fix: 'Add a compelling meta description (~150–160 characters) that includes the keyword.' },
  description_length: { what: 'The meta description is too short or too long and may get truncated in results.', fix: 'Aim for ~150–160 characters.' },
  description_uniq: { what: 'This meta description is duplicated on other pages.', fix: 'Write a unique description per page.' },
  description_stuffing: { what: 'The description over-repeats the keyword.', fix: 'Mention the keyword once, naturally.' },
  h1: { what: 'The H1 heading is missing or doesn’t match the page topic. H1 is the main on-page headline.', fix: 'Add a single descriptive H1 that reflects the page’s primary keyword.' },
  h1_presence: { what: 'The page has no H1 heading at all.', fix: 'Add exactly one H1 describing the page.' },
  h1_stuffing: { what: 'The H1 repeats the keyword too many times.', fix: 'Use one clear H1 phrase.' },
  links_count: { what: 'The page has an unusually high number of links, which dilutes link equity and can look spammy.', fix: 'Trim to the links that genuinely help users.' },
  links_diversity: { what: 'Most links point to the same few destinations.', fix: 'Link to a wider, relevant set of pages.' },
  redirect: { what: 'This URL redirects elsewhere, wasting crawl budget and a little link equity.', fix: 'Link directly to the final destination URL where possible.' },
  meta_redirect: { what: 'The page uses a slow meta-refresh redirect instead of a proper server redirect.', fix: 'Replace meta-refresh with a 301 redirect.' },
  url_ansi: { what: 'The URL contains non-ASCII characters that can break sharing and indexing.', fix: 'Use lowercase ASCII letters, numbers and hyphens in URLs.' },
  url_query: { what: 'The URL relies on query-string parameters (?a=b), which are harder to index and share.', fix: 'Prefer clean, static-looking paths.' },
  url_dashes: { what: 'The URL has excessive or missing word separators.', fix: 'Separate words with single hyphens.' },
  url_one: { what: 'The target keyword doesn’t appear in the URL.', fix: 'Include the primary keyword in the URL slug.' },
  multiple_urls: { what: 'The same content is reachable at several URLs, splitting ranking signals.', fix: 'Pick one canonical URL and redirect or canonicalize the rest.' },
  img_alt: { what: 'One or more images are missing alt text, which hurts accessibility and image search.', fix: 'Add descriptive alt text to meaningful images (use the ALT overlay to spot them).' },
  img_name: { what: 'Image file names are non-descriptive (e.g. IMG_1234.jpg).', fix: 'Rename images to describe their content.' },
  presence: { what: 'The target keyword barely appears in the page content.', fix: 'Work the keyword naturally into the intro, body and headings.' },
  stuffing: { what: 'The keyword appears too densely (keyword stuffing).', fix: 'Reduce repetition and write for humans.' },
  broken_links: { what: 'The page links to URLs that return errors (see the list below).', fix: 'Fix or remove the broken links.' },
  rel_canonical: { what: 'The page is missing a rel=canonical tag, or it points at the wrong URL.', fix: 'Add a self-referencing canonical (or point to the preferred version).' },
  rel_canonical_stuffing: { what: 'Multiple or conflicting canonical tags are present.', fix: 'Keep exactly one canonical tag.' },
  schema: { what: 'The page has no structured-data (schema.org) markup, so it can’t earn rich results.', fix: 'Add relevant JSON-LD schema (Organization, Product, Article, etc.).' },
  og: { what: 'Open Graph tags are missing, so shared links look plain on social media.', fix: 'Add og:title, og:description and og:image.' },
  content_fresh: { what: 'The content hasn’t been updated in a long time.', fix: 'Refresh the content and its last-modified date.' },
  page_speed: { what: 'The desktop page-speed score is below Google’s recommended range.', fix: 'Compress images, defer unused JS/CSS, and enable caching.' },
  mobile_speed: { what: 'The mobile page-speed score is below Google’s recommended range — mobile speed is a Google ranking factor.', fix: 'Optimise images, reduce JavaScript, and improve mobile Largest Contentful Paint.' },
  body: { what: 'The keyword is missing from the main body text.', fix: 'Include the keyword naturally in the content.' },
  body_persent: { what: 'Keyword density in the body is too low or too high.', fix: 'Aim for natural usage across a normal-length page.' },
  h2_h4: { what: 'The keyword doesn’t appear in any subheading (H2–H4).', fix: 'Add the keyword to a relevant subheading.' },
  inbound_links: { what: 'Few internal links point to this page, so it gets little internal authority.', fix: 'Add internal links from related pages.' }
};

// The specific cause on the CURRENT page, using the audit data + our own on-page
// inspection (pageData). Only meaningful for the page you're viewing.
function saFactorSpecifics(key, page) {
  if (page) {
    if (key === 'mobile_speed' && page.mobileSpeed != null) return `Mobile PageSpeed score is ${page.mobileSpeed}/100 (aim for 80+).`;
    if (key === 'page_speed' && page.desktopSpeed != null) return `Desktop PageSpeed score is ${page.desktopSpeed}/100 (aim for 80+).`;
  }
  const pd = (typeof pageData !== 'undefined') ? pageData : null;
  if (!pd) return null;
  if (key === 'title' || key === 'title_length') {
    if (pd.title) return `Current title is ${pd.title.charCount} characters: “${pd.title.text || '(empty)'}”.`;
  }
  if (key === 'description' || key === 'description_length') {
    return pd.metaDescription ? `Current meta description is ${pd.metaDescription.charCount} characters: “${pd.metaDescription.text}”.` : 'This page has no meta description.';
  }
  if (key === 'h1' || key === 'h1_presence') {
    const h1s = (pd.headings || []).filter(h => (h.tag || '').toLowerCase() === 'h1');
    return h1s.length ? `Found ${h1s.length} H1: ${h1s.map(h => `“${h.text}”`).join(', ')}.` : 'No H1 heading found on this page.';
  }
  if (key === 'rel_canonical' && !pd.canonical) return 'No canonical tag detected on this page.';
  return null;
}

// Mirror of the background SITE_AUDIT_BROKEN_KINDS labels for display.
const SA_BROKEN_LABELS = {
  ilinks: 'Internal link', elinks: 'External link', pictures: 'Image', anchors: 'Anchor',
  i_server: 'Internal server', e_server: 'External server', i_page: 'Internal page', e_page: 'External page',
  mixed_content: 'Mixed content', ijavascript: 'JS (internal)', ejavascript: 'JS (external)', icss: 'CSS (internal)', ecss: 'CSS (external)'
};

function saNormalizeUrl(url) {
  try { const u = new URL(url); return u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, ''); }
  catch { return String(url || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, ''); }
}

// Deduped, normalized on-page issue keys for a page (general + landing).
function saPageIssueKeys(page) {
  const seen = new Set(), out = [];
  [...(page.generalProblems || []), ...(page.landingProblems || [])].forEach(k => {
    const nk = saNormKey(k);
    if (!seen.has(nk)) { seen.add(nk); out.push(nk); }
  });
  return out;
}
function saPageIssueCount(page) { return saPageIssueKeys(page).length + (page.brokenCount || 0); }

async function loadSiteAuditData(forceRefresh = false) {
  const entry = document.getElementById('overview-siteaudit');
  if (!entry || _siteAuditLoading) return;
  _siteAuditLoading = true;
  let res = null;
  try {
    const tab = await getActiveTab();
    res = await sendMessageWithTimeout({ action: 'webceoGetSiteAudit', pageUrl: tab.url, forceRefresh });
    if (res) res.pageUrl = tab.url;
  } catch { res = null; }
  _siteAuditLoading = false;

  const ok = res && res.connected && !res.error;
  entry.classList.toggle('hidden', !ok);
  if (!ok) { _siteAuditData = null; return; }
  _siteAuditData = res;
  renderSiteAuditEntry();
  if (!document.getElementById('siteaudit-panel').classList.contains('hidden')) renderSiteAuditPanel();
}

function renderSiteAuditEntry() {
  const d = _siteAuditData;
  const summary = document.getElementById('siteaudit-summary');
  if (!d || !summary) return;
  const bits = [];
  if (d.siteOptimization != null) bits.push(`opt ${d.siteOptimization}%`);
  bits.push(`${saNum(d.generalErrors)} issue${d.generalErrors === 1 ? '' : 's'}`);
  if (d.brokenLinks) bits.push(`${saNum(d.brokenLinks)} broken`);
  summary.textContent = bits.join(' · ');
}

// ─── Detail panel ────────────────────────────────────────────────────────────

function saCurrentPage(d) {
  const target = saNormalizeUrl(d.pageUrl || '');
  return (d.pages || []).find(p => saNormalizeUrl(p.url) === target) || null;
}

function saStat(label, value, cls) {
  const box = document.createElement('div');
  box.className = 'ranking-stat' + (cls ? ' ' + cls : '');
  const v = document.createElement('div'); v.className = 'ranking-stat-val'; v.textContent = value;
  const l = document.createElement('div'); l.className = 'ranking-stat-label'; l.textContent = label;
  box.append(v, l);
  return box;
}
function saOptClass(v) { if (v == null) return ''; if (v >= 80) return 'sa-stat-good'; if (v >= 50) return 'sa-stat-mid'; return 'sa-stat-bad'; }

function renderSiteAuditPanel() {
  const el = document.getElementById('siteaudit-content');
  const d = _siteAuditData;
  if (!el) return;
  const headerMeta = document.getElementById('siteaudit-header-meta');
  el.replaceChildren();
  if (!d) {
    if (headerMeta) headerMeta.textContent = '';
    const h = document.createElement('div'); h.className = 'field-hint'; h.textContent = 'No audit data.'; el.appendChild(h); return;
  }
  if (headerMeta) headerMeta.textContent = (d.scannedDate ? `scanned ${d.scannedDate}` : '') + (d.fetchedAt ? `${d.scannedDate ? ' · ' : ''}updated ${gscRelativeTime(d.fetchedAt)}` : '');

  const page = saCurrentPage(d);

  const card = document.createElement('div');
  card.className = 'ranking-scorecard bl-scorecard';
  if (_siteAuditPageOnly && page) {
    card.appendChild(saStat('Optimization', page.optimization != null ? page.optimization + '%' : '—', 'ranking-stat--primary ' + saOptClass(page.optimization)));
    card.appendChild(saStat('Desktop', page.desktopSpeed != null ? String(page.desktopSpeed) : '—', saOptClass(page.desktopSpeed)));
    card.appendChild(saStat('Mobile', page.mobileSpeed != null ? String(page.mobileSpeed) : '—', saOptClass(page.mobileSpeed)));
    card.appendChild(saStat('Issues', saNum(saPageIssueCount(page)), saPageIssueCount(page) ? 'bl-stat--warn' : ''));
  } else {
    card.appendChild(saStat('Optimization', d.siteOptimization != null ? d.siteOptimization + '%' : '—', 'ranking-stat--primary ' + saOptClass(d.siteOptimization)));
    card.appendChild(saStat('Issues', saNum(d.generalErrors), d.generalErrors ? 'bl-stat--warn' : ''));
    card.appendChild(saStat('Broken', saNum(d.brokenLinks), d.brokenLinks ? 'bl-stat--warn' : ''));
    card.appendChild(saStat('Pages', saNum(d.scannedPages), ''));
  }
  el.appendChild(card);

  // Keep the header toggle in sync with state
  const cbEl = document.getElementById('siteaudit-pageonly');
  if (cbEl) cbEl.checked = _siteAuditPageOnly;

  if (_siteAuditPageOnly) renderSaPageIssues(el, d, page);
  else renderSaSiteIssues(el, d);
}

function saSectionLabel(text) {
  const h = document.createElement('div');
  h.className = 'field-header';
  const l = document.createElement('span');
  l.className = 'field-label';
  l.textContent = text;
  h.appendChild(l);
  return h;
}

function saIssueDetailBody(key, page) {
  const wrap = document.createElement('div');
  const info = SA_FACTOR_INFO[saNormKey(key)];
  const what = document.createElement('div');
  what.className = 'sa-detail-what';
  what.textContent = (info && info.what) || 'This on-page factor was flagged by the audit.';
  wrap.appendChild(what);
  const spec = saFactorSpecifics(saNormKey(key), page);
  if (spec) { const s = document.createElement('div'); s.className = 'sa-detail-spec'; s.textContent = spec; wrap.appendChild(s); }
  if (info && info.fix) { const f = document.createElement('div'); f.className = 'sa-detail-fix'; const b = document.createElement('strong'); b.textContent = 'Fix: '; f.append(b, document.createTextNode(info.fix)); wrap.appendChild(f); }
  return wrap;
}

// An expandable issue row: dot + label (+ optional right count) + caret; click
// reveals the explanation / cause / fix.
function saIssueItem(key, page, rightText) {
  const item = document.createElement('div');
  item.className = 'sa-issue-item';

  const head = document.createElement('button');
  head.className = 'sa-issue sa-issue--warn sa-issue-btn';
  const dot = document.createElement('span'); dot.className = 'sa-issue-dot';
  const label = document.createElement('span'); label.className = 'sa-issue-label'; label.textContent = saLabel(key);
  const right = document.createElement('span'); right.className = 'sa-issue-right';
  if (rightText != null) { const c = document.createElement('span'); c.className = 'sa-issue-count'; c.textContent = rightText; right.appendChild(c); }
  const caret = document.createElement('span'); caret.className = 'sa-issue-caret'; caret.textContent = _saIssueOpen.has(key) ? '▾' : '▸';
  right.appendChild(caret);
  head.append(dot, label, right);

  const detail = document.createElement('div');
  detail.className = 'sa-issue-detail' + (_saIssueOpen.has(key) ? '' : ' hidden');
  if (_saIssueOpen.has(key)) detail.appendChild(saIssueDetailBody(key, page));

  head.addEventListener('click', () => {
    if (_saIssueOpen.has(key)) { _saIssueOpen.delete(key); detail.classList.add('hidden'); detail.replaceChildren(); caret.textContent = '▸'; }
    else { _saIssueOpen.add(key); detail.replaceChildren(saIssueDetailBody(key, page)); detail.classList.remove('hidden'); caret.textContent = '▾'; }
  });
  item.append(head, detail);
  return item;
}

function saBrokenRow(b) {
  const r = document.createElement('div');
  r.className = 'sa-issue sa-issue--broken';
  const dot = document.createElement('span'); dot.className = 'sa-issue-dot';
  const kind = document.createElement('span'); kind.className = 'sa-broken-kind'; kind.textContent = SA_BROKEN_LABELS[b.kind] || b.kind;
  const url = document.createElement('a'); url.className = 'sa-broken-url'; url.textContent = b.url || ''; url.title = b.url || '';
  if (b.url) { url.href = b.url; url.addEventListener('click', e => { e.preventDefault(); browser.tabs.create({ url: b.url }); }); }
  const code = document.createElement('span'); code.className = 'sa-broken-code'; code.textContent = b.status != null ? b.status : '';
  r.append(dot, kind, url, code);
  return r;
}

function renderSaPageIssues(el, d, page) {
  const sec = document.createElement('section');
  sec.className = 'field-section';
  sec.appendChild(saSectionLabel('ISSUES ON THIS PAGE'));

  if (!page) {
    const hint = document.createElement('div');
    hint.className = 'field-hint';
    hint.textContent = `This page wasn't in the last audit scan (it covers ${saNum(d.scannedPages)} pages). Uncheck “This page only” to see the site's issues.`;
    sec.appendChild(hint);
    el.appendChild(sec);
    return;
  }

  const list = document.createElement('div');
  list.className = 'sa-issue-list';
  saPageIssueKeys(page).forEach(k => list.appendChild(saIssueItem(k, page)));
  (page.broken || []).forEach(b => list.appendChild(saBrokenRow(b)));
  if (page.brokenCount > (page.broken || []).length) {
    const more = document.createElement('div');
    more.className = 'field-hint sa-broken-more';
    more.textContent = `+${saNum(page.brokenCount - page.broken.length)} more broken links`;
    list.appendChild(more);
  }

  if (!list.childNodes.length) {
    const ok = document.createElement('div'); ok.className = 'field-hint sa-clean'; ok.textContent = 'No issues found on this page ✓';
    sec.appendChild(ok);
  } else {
    sec.appendChild(list);
  }
  el.appendChild(sec);
}

function renderSaSiteIssues(el, d) {
  if (d.summary && d.summary.length) {
    const sec = document.createElement('section');
    sec.className = 'field-section';
    sec.appendChild(saSectionLabel('SITE-WIDE'));
    const list = document.createElement('div');
    list.className = 'sa-issue-list';
    d.summary.forEach(k => list.appendChild(saIssueItem(saNormKey(k), null)));
    sec.appendChild(list);
    el.appendChild(sec);
  }

  const counts = new Map();
  (d.pages || []).forEach(p => saPageIssueKeys(p).forEach(k => counts.set(k, (counts.get(k) || 0) + 1)));
  const pagesWithBroken = (d.pages || []).filter(p => p.brokenCount > 0).length;

  const sec = document.createElement('section');
  sec.className = 'field-section';
  sec.appendChild(saSectionLabel('ISSUES BY PAGES AFFECTED'));
  const list = document.createElement('div');
  list.className = 'sa-issue-list';
  [...counts.entries()].sort((a, b) => b[1] - a[1]).forEach(([key, n]) => list.appendChild(saIssueItem(key, null, `${saNum(n)} page${n === 1 ? '' : 's'}`)));
  if (d.brokenLinks) list.appendChild(saIssueItem('broken_links', null, `${saNum(d.brokenLinks)} on ${saNum(pagesWithBroken)} page${pagesWithBroken === 1 ? '' : 's'}`));

  if (!list.childNodes.length) {
    const ok = document.createElement('div'); ok.className = 'field-hint sa-clean'; ok.textContent = 'No issues found ✓';
    sec.appendChild(ok);
  } else {
    sec.appendChild(list);
  }
  el.appendChild(sec);
}

// Panel wiring
document.getElementById('btn-siteaudit-refresh').addEventListener('click', () => loadSiteAuditData(true));
document.getElementById('siteaudit-pageonly').addEventListener('change', (e) => {
  _siteAuditPageOnly = e.target.checked;
  renderSiteAuditPanel();
});
