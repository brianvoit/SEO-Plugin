// ─── Keyword Phrases ──────────────────────────────────────────────────────────
// The chevron beside HEADINGS on Overview, and the four-table panel behind it:
// the top 1-, 2-, 3- and 4-word phrases this page actually uses.
//
// Extraction lives in content.js (detectKeywordPhrases) and runs ON DEMAND when
// this panel opens — unlike the Tags row, it does NOT ride along on getPageData,
// because the n-gram walk is real work and most page reads never open this
// screen. Everything layered on top (Brand, GSC metrics, search volume, the Ad
// chip, the content-gap list) is fetched here and merged in, each independently
// optional: the tables render immediately from page data alone and fill in as
// the slower sources land.

let _phrasesData = null;          // { scannedAt, totalWords, tables: {1..4} }
let _phrasesScanning = false;
let _phrasesSearch = '';
let _phrasesSearchExclude = false;
// Off by default: a brand name is usually a page's most-repeated word by a
// wide margin, and leaving it in buries the content words this screen exists
// to surface. The toggle is there for when you specifically want it back.
let _phrasesShowBrand = false;
let _phrasesGsc = {};             // phrase(lower) → { clicks, impressions, position }
let _phrasesGscState = 'idle';    // idle | loading | available | unavailable
let _phrasesVolume = {};          // phrase(lower) → { avgMonthlySearches, … } | null
let _phrasesVolumeState = 'idle';
let _phrasesAdTexts = null;       // lowercased ad headline/description strings
let _phrasesGap = [];             // GSC queries with impressions that the copy never says
let _phrasesGapOpen = false;      // an aside, not the reason you opened this screen
let _phrasesPageUrl = '';

const PHRASES_PAGE_N = 10;        // rows shown per table at rest, and per "Request more"
const PHRASES_GAP_MAX = 8;
const PHRASE_SIZES = [1, 2, 3, 4];
const PHRASE_SIZE_LABEL = { 1: 'ONE WORD', 2: 'TWO WORDS', 3: 'THREE WORDS', 4: 'FOUR WORDS' };

// How many rows each table is currently showing. "Request more" bumps one
// table's own limit; every other table stays where it is.
let _phrasesLimit = { 1: PHRASES_PAGE_N, 2: PHRASES_PAGE_N, 3: PHRASES_PAGE_N, 4: PHRASES_PAGE_N };

function resetPhrasesLimits() {
  _phrasesLimit = { 1: PHRASES_PAGE_N, 2: PHRASES_PAGE_N, 3: PHRASES_PAGE_N, 4: PHRASES_PAGE_N };
}

// Chip order — where a phrase sits matters more than how often, so the
// strongest placements read first.
const PHRASE_CHIP_ORDER = ['title', 'description', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
const PHRASE_CHIP_LABEL = {
  title: 'Title', description: 'Desc',
  h1: 'H1', h2: 'H2', h3: 'H3', h4: 'H4', h5: 'H5', h6: 'H6'
};

// ─── Overview entry ───────────────────────────────────────────────────────────

function renderPhrasesEntry(data) {
  const btn = document.getElementById('btn-phrases');
  const summary = document.getElementById('phrases-summary');
  if (!btn || !summary) return;

  const words = (data && data.bodyWordCount) || 0;
  // Nothing to count means nothing to show — the panel would be four empty
  // tables, so the chevron stays inert rather than opening a dead end.
  btn.disabled = words === 0;
  summary.textContent = words ? `${words.toLocaleString()} words` : '';
}

// ─── Panel ────────────────────────────────────────────────────────────────────

function openPhrasesPanel() {
  renderPhrasesPanel();
  rescanPhrases();
}

async function rescanPhrases() {
  if (_phrasesScanning) return;
  _phrasesScanning = true;
  renderPhrasesPanel();

  try {
    const tab = await getActiveTab();
    _phrasesPageUrl = tab.url || '';
    // Top frame only, same as every other page read — an embedded iframe's
    // copy is not this page's copy.
    const res = await browser.tabs.sendMessage(tab.id, { action: 'getKeywordPhrases' }, TOP_FRAME);
    if (res && res.tables) _phrasesData = res;
  } catch { /* no content script here — leave whatever we had */ }

  _phrasesScanning = false;
  renderPhrasesPanel();

  // Each of these re-renders on its own when it lands; none blocks the others,
  // and any one failing just leaves its column/chip absent.
  ensurePhrasesAdTexts();
  ensurePhrasesGsc();
}

// ─── Enrichment ───────────────────────────────────────────────────────────────

// Ad copy running on THIS page's URL, for the "Ad" chip. Silent no-op whenever
// Ads isn't connected or no ads point here.
async function ensurePhrasesAdTexts() {
  if (_phrasesAdTexts !== null) return;
  _phrasesAdTexts = [];
  try {
    const res = await sendMessageWithTimeout({ action: 'adsGetPageAdCopy', pageUrl: _phrasesPageUrl });
    if (res && Array.isArray(res.texts)) {
      _phrasesAdTexts = res.texts.map(t => String(t || '').toLowerCase());
      if (_phrasesAdTexts.length) renderPhrasesPanel();
    }
  } catch { /* leave empty — the chip simply never appears */ }
}

// This page's Search Console queries, used two ways: exact-match metric
// columns on phrases the page uses, and the content-gap list for queries it
// gets impressions for but never actually says.
async function ensurePhrasesGsc() {
  if (_phrasesGscState === 'loading' || _phrasesGscState === 'available' || _phrasesGscState === 'unavailable') return;
  _phrasesGscState = 'loading';
  let queries = [];
  try {
    const res = await sendMessageWithTimeout({
      action: 'gscGetMoreQueries', pageUrl: _phrasesPageUrl,
      range: (typeof gscSelectedRange === 'number' ? gscSelectedRange : 30), startRow: 0
    });
    if (!res || res.connected === false || res.error) { _phrasesGscState = 'unavailable'; renderPhrasesPanel(); return; }
    queries = res.queries || [];
  } catch { _phrasesGscState = 'unavailable'; renderPhrasesPanel(); return; }

  _phrasesGsc = {};
  queries.forEach(q => {
    const lc = (q.query || '').toLowerCase().trim();
    if (lc) _phrasesGsc[lc] = { clicks: q.clicks, impressions: q.impressions, position: q.position };
  });
  _phrasesGscState = 'available';
  renderPhrasesPanel();

  loadPhrasesGap(queries);
  ensurePhrasesVolume();
}

// The gap: queries Google already shows this page for, whose words appear
// nowhere in its copy. Asks content.js rather than testing against the top-N
// tables — a phrase ranked 41st is still ON the page, and calling that a gap
// would be wrong.
async function loadPhrasesGap(queries) {
  const ranked = queries
    .filter(q => q.impressions > 0)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 40);
  if (!ranked.length) return;

  try {
    const tab = await getActiveTab();
    const res = await browser.tabs.sendMessage(
      tab.id, { action: 'checkPhrasePresence', terms: ranked.map(q => q.query) }, TOP_FRAME
    );
    if (!res || !Array.isArray(res.present)) return;
    const present = new Set(res.present.map(t => String(t).toLowerCase()));
    _phrasesGap = ranked.filter(q => !present.has((q.query || '').toLowerCase())).slice(0, PHRASES_GAP_MAX);
    renderPhrasesPanel();
  } catch { /* no content script — skip the gap section entirely */ }
}

// Est. monthly search volume for the phrases actually on screen. Uses the
// same account-independent Keyword Plan lookup (and 30-day cache) the Search
// tab's Vol column already runs on.
async function ensurePhrasesVolume() {
  if (_phrasesVolumeState === 'loading' || _phrasesVolumeState === 'unavailable') return;
  const want = [];
  const seen = new Set();
  PHRASE_SIZES.forEach(n => {
    visiblePhrases(n).forEach(p => {
      const lc = p.phrase.toLowerCase();
      if (!seen.has(lc) && !(lc in _phrasesVolume)) { seen.add(lc); want.push(p.phrase); }
    });
  });
  if (!want.length) return;

  _phrasesVolumeState = 'loading';
  try {
    const res = await sendMessageWithTimeout({ action: 'adsGetKeywordIdeas', pageUrl: _phrasesPageUrl, keywords: want });
    const NO_ADS = new Set(['NOT_CONNECTED', 'REAUTH_REQUIRED', 'NO_DEV_TOKEN', 'NO_ACCOUNT']);
    if (res && NO_ADS.has(res.error) && !Object.keys(res.byKeyword || {}).length) {
      _phrasesVolumeState = 'unavailable';
    } else if (res) {
      _phrasesVolumeState = 'available';
      // Mark every requested term resolved even when the API returned nothing
      // for it, so a persistent miss can't drive a render→fetch→render loop.
      want.forEach(t => { const lc = t.toLowerCase(); if (!(lc in _phrasesVolume)) _phrasesVolume[lc] = null; });
      Object.assign(_phrasesVolume, res.byKeyword || {});
    }
  } catch { _phrasesVolumeState = 'idle'; return; }
  renderPhrasesPanel();
}

// ─── Filtering ────────────────────────────────────────────────────────────────

function phrasesBrandPattern() {
  if (typeof allBrandedTerms === 'undefined' || !_phrasesPageUrl) return '';
  let host = '';
  try { host = new URL(_phrasesPageUrl).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
  return allBrandedTerms[host] || '';
}

function phraseIsBranded(phrase) {
  const pattern = phrasesBrandPattern();
  if (!pattern) return false;
  try { return new RegExp(pattern, 'i').test(phrase); } catch { return false; }
}

// Every phrase of this length that survives the Brand toggle and the regex —
// no row limit. This is what an export writes and what "Request more" pages
// through; visiblePhrases() below is the on-screen slice of it.
function filteredPhrases(n) {
  const all = (_phrasesData && _phrasesData.tables && _phrasesData.tables[n]) || [];
  let rows = _phrasesShowBrand ? all : all.filter(p => !phraseIsBranded(p.phrase));

  if (_phrasesSearch) {
    try {
      const re = new RegExp(_phrasesSearch, 'i');
      rows = _phrasesSearchExclude ? rows.filter(p => !re.test(p.phrase)) : rows.filter(p => re.test(p.phrase));
    } catch { /* invalid regex — show the unfiltered set */ }
  }
  return rows;
}

// Filtering happens BEFORE this slice, so a regex surfaces phrases ranked
// deeper than the visible rows instead of only narrowing what's on screen.
function visiblePhrases(n) {
  return filteredPhrases(n).slice(0, _phrasesLimit[n]);
}

// The one phrase the page reads as targeting: strongest prominence among
// those carried by BOTH the title and an H1. Longer phrases win ties, since
// "wool running shoes" is a more specific claim than "shoes".
function phrasesPrimary() {
  let best = null;
  PHRASE_SIZES.forEach(n => {
    ((_phrasesData && _phrasesData.tables && _phrasesData.tables[n]) || []).forEach(p => {
      if (!p.chips.includes('title') || !p.chips.includes('h1')) return;
      if (!best || p.prominence > best.prominence ||
          (p.prominence === best.prominence && p.phrase.length > best.phrase.length)) best = p;
    });
  });
  return best;
}

// ─── Render ───────────────────────────────────────────────────────────────────

function renderPhrasesPanel() {
  const root = document.getElementById('phrases-tables');
  const meta = document.getElementById('phrases-header-meta');
  if (!root) return;
  root.replaceChildren();

  const words = (_phrasesData && _phrasesData.totalWords) || 0;
  meta.textContent = _phrasesScanning ? 'Scanning…' : (words ? `${words.toLocaleString()} words` : '');

  renderPhrasesGap();

  if (!_phrasesData) {
    const hint = document.createElement('div');
    hint.className = 'field-section field-hint hint-muted';
    hint.textContent = _phrasesScanning ? 'Reading the page…' : 'Could not read this page.';
    root.appendChild(hint);
    return;
  }

  const primary = phrasesPrimary();
  PHRASE_SIZES.forEach(n => root.appendChild(phrasesTable(n, primary)));
}

function phrasesGapRow(q) {
  const row = document.createElement('div');
  row.className = 'phrases-gap-row';

  const term = document.createElement('span');
  term.className = 'phrases-gap-term';
  term.textContent = q.query;
  row.appendChild(term);

  const impr = document.createElement('span');
  impr.className = 'phrases-gap-impr';
  impr.textContent = `${Number(q.impressions || 0).toLocaleString()} impr`;
  row.appendChild(impr);

  return row;
}

function renderPhrasesGap() {
  const wrap = document.getElementById('phrases-gap');
  if (!wrap) return;
  wrap.replaceChildren();
  wrap.classList.toggle('hidden', _phrasesGap.length === 0);
  if (!_phrasesGap.length) return;

  const title = document.createElement('button');
  title.type = 'button';
  title.className = 'phrases-gap-title';
  title.setAttribute('aria-expanded', String(_phrasesGapOpen));
  title.appendChild(svgFromString('<svg class="phrases-gap-caret" viewBox="0 0 16 16" width="9" height="9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 3 11 8 6 13"/></svg>'));
  title.appendChild(document.createTextNode('Ranking for words this page never says'));
  const count = document.createElement('span');
  count.className = 'phrases-gap-count';
  count.textContent = String(_phrasesGap.length);
  title.appendChild(count);
  title.addEventListener('click', () => { _phrasesGapOpen = !_phrasesGapOpen; renderPhrasesGap(); });
  wrap.appendChild(title);

  if (!_phrasesGapOpen) return;

  const body = document.createElement('div');
  body.className = 'phrases-gap-body';

  const hint = document.createElement('div');
  hint.className = 'phrases-gap-hint';
  hint.textContent = 'Search Console shows impressions for these, but they appear nowhere in the page copy.';
  body.appendChild(hint);

  _phrasesGap.forEach(q => body.appendChild(phrasesGapRow(q)));
  wrap.appendChild(body);
}

function phrasesColumns() {
  const cols = [
    { key: 'count',      label: '#',     width: '30px' },
    { key: 'density',    label: 'Dens',  width: '46px' },
    { key: 'prominence', label: 'Prom',  width: '40px' }
  ];
  if (_phrasesGscState === 'available') {
    cols.push({ key: 'clicks',      label: 'Clicks', width: '42px' });
    cols.push({ key: 'impressions', label: 'Impr',   width: '46px' });
    cols.push({ key: 'position',    label: 'Pos',    width: '38px' });
  }
  if (_phrasesVolumeState === 'available') cols.push({ key: 'volume', label: 'Vol', width: '46px' });
  return cols;
}

function phrasesCell(text, cls) {
  const el = document.createElement('span');
  el.className = 'ranking-cell-num' + (cls ? ' ' + cls : '');
  el.textContent = text;
  return el;
}

// Search volumes run to seven figures and the column is ~46px wide, so they're
// abbreviated rather than truncated: 301,000 → 301k, 4,100,000 → 4.1M. One
// decimal only below 10, where the difference between 4.1M and 4M is
// meaningful; above that it's noise.
function phrasesCompactNum(n) {
  if (n == null || n === '') return '—';
  const num = Number(n);
  if (!isFinite(num)) return '—';
  const scale = (v, suffix) =>
    (v >= 10 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '')) + suffix;
  if (num >= 1e6) return scale(num / 1e6, 'M');
  if (num >= 1000) return scale(num / 1000, 'k');
  return String(num);
}

function phraseChipEls(p, isPrimary) {
  const wrap = document.createElement('span');
  wrap.className = 'phrases-chips';

  if (isPrimary) {
    const chip = document.createElement('span');
    chip.className = 'gsc-chip phrases-chip-primary';
    chip.textContent = 'Primary';
    chip.title = 'Strongest phrase on the page — carried by both the title and an H1';
    wrap.appendChild(chip);
  }

  PHRASE_CHIP_ORDER.forEach(key => {
    if (!p.chips.includes(key)) return;
    const chip = document.createElement('span');
    chip.className = 'gsc-chip';
    chip.textContent = PHRASE_CHIP_LABEL[key];
    wrap.appendChild(chip);
  });

  if (_phrasesAdTexts && _phrasesAdTexts.some(t => t.includes(p.phrase))) {
    const chip = document.createElement('span');
    chip.className = 'gsc-chip gsc-ad-chip';
    chip.textContent = 'Ad';
    chip.title = 'This phrase also appears in ad copy running on this page';
    wrap.appendChild(chip);
  }

  if (phraseIsBranded(p.phrase)) {
    const chip = document.createElement('span');
    chip.className = 'gsc-chip phrases-chip-brand';
    chip.textContent = 'Brand';
    wrap.appendChild(chip);
  }

  if (p.chips.includes('linked')) {
    const chip = document.createElement('span');
    chip.className = 'gsc-chip phrases-chip-linked';
    chip.textContent = 'Linked';
    chip.title = 'Used as the anchor text of a link';
    wrap.appendChild(chip);
  }

  return wrap;
}

function phrasesRow(p, cols, isPrimary) {
  const row = document.createElement('div');
  row.className = 'ranking-row phrases-row';
  row.style.gridTemplateColumns = `1fr ${cols.map(c => c.width).join(' ')}`;

  const term = document.createElement('div');
  term.className = 'ranking-cell-term';
  const text = document.createElement('span');
  text.className = 'ranking-keyword phrases-term-link';
  text.textContent = p.phrase;
  text.title = `Search Google for "${p.phrase}"`;
  text.addEventListener('click', () => {
    browser.tabs.create({ url: `https://www.google.com/search?q=${encodeURIComponent(p.phrase)}` });
  });
  term.appendChild(text);
  term.appendChild(phraseChipEls(p, isPrimary));
  row.appendChild(term);

  const gsc = _phrasesGsc[p.phrase.toLowerCase()] || null;
  const vol = _phrasesVolume[p.phrase.toLowerCase()] || null;

  cols.forEach(col => {
    if (col.key === 'count')       return row.appendChild(phrasesCell(String(p.count)));
    if (col.key === 'density')     return row.appendChild(phrasesCell(`${(p.density * 100).toFixed(2)}%`));
    if (col.key === 'prominence')  return row.appendChild(phrasesCell(String(p.prominence)));
    if (col.key === 'clicks')      return row.appendChild(phrasesCell(gsc ? Number(gsc.clicks).toLocaleString() : '—'));
    if (col.key === 'impressions') return row.appendChild(phrasesCell(gsc ? Number(gsc.impressions).toLocaleString() : '—'));
    if (col.key === 'position')    return row.appendChild(phrasesCell(gsc ? gsc.position.toFixed(1) : '—'));
    if (col.key === 'volume') {
      const n = vol && vol.avgMonthlySearches;
      return row.appendChild(phrasesCell(n ? phrasesCompactNum(n) : '—'));
    }
  });

  return row;
}

function phrasesTable(n, primary) {
  const section = document.createElement('section');
  section.className = 'field-section';

  const header = document.createElement('div');
  header.className = 'field-header';
  const label = document.createElement('span');
  label.className = 'field-label';
  label.textContent = PHRASE_SIZE_LABEL[n];
  header.appendChild(label);
  section.appendChild(header);

  const rows = visiblePhrases(n);
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'field-hint hint-muted';
    empty.textContent = _phrasesSearch ? 'Nothing matches that filter.' : 'No phrases of this length.';
    section.appendChild(empty);
    return section;
  }

  const cols = phrasesColumns();

  const head = document.createElement('div');
  head.className = 'ranking-row ranking-row--header phrases-row';
  head.style.gridTemplateColumns = `1fr ${cols.map(c => c.width).join(' ')}`;
  const phraseHead = document.createElement('span');
  phraseHead.textContent = 'Phrase';
  head.appendChild(phraseHead);
  cols.forEach(c => {
    const el = document.createElement('span');
    el.className = 'ranking-cell-num';
    el.textContent = c.label;
    head.appendChild(el);
  });
  section.appendChild(head);

  rows.forEach(p => section.appendChild(phrasesRow(p, cols, primary && primary.phrase === p.phrase)));
  section.appendChild(phrasesTableFoot(n, rows.length));
  return section;
}

function phrasesIconBtn(title, svg, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'phrases-icon-btn';
  labelIconButton(btn, title);
  btn.appendChild(svgFromString(svg));
  btn.addEventListener('click', () => onClick(btn));
  return btn;
}

const PHRASES_CSV_GLYPH = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8"/><polyline points="5 7 8 10 11 7"/><path d="M3 12.5h10"/></svg>';
const PHRASES_SHEET_GLYPH = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="12" height="12" rx="1.5"/><line x1="2" y1="6.3" x2="14" y2="6.3"/><line x1="2" y1="10.7" x2="14" y2="10.7"/><line x1="6.3" y1="2" x2="6.3" y2="14"/></svg>';

// "Request more" centered, with this table's own export buttons to its right.
function phrasesTableFoot(n, shownCount) {
  const foot = document.createElement('div');
  foot.className = 'phrases-table-foot';

  const total = filteredPhrases(n).length;
  if (shownCount < total) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'phrases-more-btn';
    more.textContent = `Request more (${total - shownCount} left)`;
    more.addEventListener('click', () => {
      _phrasesLimit[n] += PHRASES_PAGE_N;
      renderPhrasesPanel();
      ensurePhrasesVolume();      // the newly revealed rows have no volume yet
    });
    foot.appendChild(more);
  }

  const actions = document.createElement('div');
  actions.className = 'phrases-table-actions';
  const label = PHRASE_SIZE_LABEL[n].toLowerCase();
  actions.appendChild(phrasesIconBtn(`Download the full ${label} table as a CSV`, PHRASES_CSV_GLYPH,
    (btn) => exportPhrasesCsv([n], btn)));
  actions.appendChild(phrasesIconBtn(`Add the full ${label} table to Google Sheets`, PHRASES_SHEET_GLYPH,
    (btn) => exportPhrasesSheet([n], btn)));
  foot.appendChild(actions);

  return foot;
}

// ─── Export ───────────────────────────────────────────────────────────────────

// The CSV keeps a Words column because it's a single flat file; the Sheets
// export drops it, since there each size gets its own tab.
const PHRASES_CSV_HEADER = [
  'Words', 'Phrase', 'Count', 'Density %', 'Prominence', 'Placement',
  'Clicks', 'Impressions', 'Position', 'Volume'
];

// One phrase's cells, WITHOUT the leading size column. Exports always run
// over filteredPhrases(), never the visible slice — what you export is the
// whole table you filtered down to, not the ten rows that happen to be drawn.
function phrasesExportRow(p) {
  const gsc = _phrasesGsc[p.phrase.toLowerCase()] || null;
  const vol = _phrasesVolume[p.phrase.toLowerCase()] || null;
  const placement = [];
  PHRASE_CHIP_ORDER.forEach(k => { if (p.chips.includes(k)) placement.push(PHRASE_CHIP_LABEL[k]); });
  if (_phrasesAdTexts && _phrasesAdTexts.some(t => t.includes(p.phrase))) placement.push('Ad');
  if (phraseIsBranded(p.phrase)) placement.push('Brand');
  if (p.chips.includes('linked')) placement.push('Linked');

  return [
    p.phrase, p.count, (p.density * 100).toFixed(2), p.prominence, placement.join(' '),
    gsc ? gsc.clicks : '', gsc ? gsc.impressions : '', gsc ? gsc.position.toFixed(1) : '',
    (vol && vol.avgMonthlySearches) || ''
  ];
}

/** [{ size, rows }] for the requested sizes, skipping any that filtered empty. */
function phrasesExportTables(sizes) {
  return (sizes || PHRASE_SIZES)
    .map(n => ({ size: n, rows: filteredPhrases(n).map(phrasesExportRow) }))
    .filter(t => t.rows.length);
}

/** Flat CSV rows, size prepended so one file can carry all four tables. */
function phrasesExportValues(sizes) {
  const out = [];
  phrasesExportTables(sizes).forEach(t => t.rows.forEach(r => out.push([t.size, ...r])));
  return out;
}

function phrasesHost() {
  try { return new URL(_phrasesPageUrl).hostname.replace(/^www\./, ''); } catch { return 'site'; }
}

// Icon buttons have no label to overwrite, so success/failure is a brief
// color flash on the glyph instead — same 3s beat as the text buttons.
function phrasesFlash(btn, ok, title) {
  const cls = ok ? 'is-success' : 'is-error';
  const origTitle = btn.title;
  btn.classList.add(cls);
  if (title) btn.title = title;
  setTimeout(() => { btn.classList.remove(cls); btn.title = origTitle; }, 3000);
}

function exportPhrasesCsv(sizes, btn) {
  const rows = phrasesExportValues(sizes);
  if (!rows.length) return;

  const csv = [PHRASES_CSV_HEADER, ...rows].map(r => r.map(gscCsvCell).join(',')).join('\r\n');
  const scope = (sizes && sizes.length === 1) ? `${sizes[0]}word-` : '';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `phrases-${scope}${phrasesHost()}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  phrasesFlash(btn, true, 'Downloaded');
}

// Mirrors the connect-retry flow every other Sheets export uses.
async function exportPhrasesSheet(sizes, btn) {
  if (btn.disabled) return;
  const tables = phrasesExportTables(sizes);
  if (!tables.length) return;

  btn.disabled = true;
  async function attempt() {
    return sendMessageWithTimeout({ action: 'sheetsExportPhrases', tables, pageUrl: _phrasesPageUrl });
  }
  let res = await attempt();
  if (res && res.notConnected) {
    const auth = await sendMessageWithTimeout({ action: 'docsConnect' });
    if (!auth || auth.error) { btn.disabled = false; phrasesFlash(btn, false, 'Google Sheets auth failed — try again'); return; }
    res = await attempt();
  }
  btn.disabled = false;
  if (res && res.url) {
    browser.tabs.create({ url: res.url });
    phrasesFlash(btn, true, 'Added');
    maybeOfferExportFolder(_phrasesPageUrl);
  } else {
    phrasesFlash(btn, false, `Export failed: ${(res && res.error) || 'unknown error'}`);
  }
}

document.getElementById('btn-phrases-refresh').addEventListener('click', () => {
  // A re-scan should re-ask every source, not replay the first answer.
  _phrasesGscState = 'idle';
  _phrasesVolumeState = 'idle';
  _phrasesAdTexts = null;
  _phrasesGap = [];
  resetPhrasesLimits();
  rescanPhrases();
});

document.getElementById('phrases-search').addEventListener('input', e => {
  _phrasesSearch = e.target.value;
  e.target.classList.toggle('is-invalid', !!_phrasesSearch && !isValidRegex(_phrasesSearch));
  // A new filter is a new result set — paging back through it should start
  // from the top rather than inheriting the last filter's expanded tables.
  resetPhrasesLimits();
  renderPhrasesPanel();
});

document.getElementById('btn-phrases-search-mode').addEventListener('click', () => {
  _phrasesSearchExclude = !_phrasesSearchExclude;
  document.getElementById('btn-phrases-search-mode').textContent = _phrasesSearchExclude ? 'Excl.' : 'Match';
  resetPhrasesLimits();
  renderPhrasesPanel();
});

document.getElementById('phrases-brand-toggle').addEventListener('change', e => {
  _phrasesShowBrand = e.target.checked;
  resetPhrasesLimits();
  renderPhrasesPanel();
  ensurePhrasesVolume();   // showing brand can surface phrases with no volume fetched yet
});

document.getElementById('btn-phrases-export-csv')
  .addEventListener('click', (e) => exportPhrasesCsv(PHRASE_SIZES, e.currentTarget));
document.getElementById('btn-phrases-export-sheet')
  .addEventListener('click', (e) => exportPhrasesSheet(PHRASE_SIZES, e.currentTarget));
