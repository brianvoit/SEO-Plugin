// ─── Tags & Pixels ────────────────────────────────────────────────────────────
// The Overview row of detected vendor chips, and the panel behind it.
//
// Detection itself lives in content.js (detectMarketingTags) and rides along on
// getPageData, so the Overview row costs nothing extra. The panel re-scans when
// it opens: detection is a snapshot, and a tag manager can inject tags after the
// popup took its reading, so what Overview showed may already be stale by the
// time you go looking at it.

let _tagsData = null;
let _tagsScanning = false;

const TAG_CATEGORIES = [
  ['analytics',  'Analytics'],
  ['tagmanager', 'Tag managers & consent'],
  ['heatmap',    'Heatmap & session replay'],
  ['pixel',      'Ad & conversion pixels']
];

function tagsWarned(vendorId) {
  if (!_tagsData) return false;
  return _tagsData.flags.some(f => f.level === 'warning' && f.vendorId === vendorId);
}

// ─── Overview row ─────────────────────────────────────────────────────────────

function renderTagsEntry(data) {
  _tagsData = (data && data.marketingTags) || null;
  renderTagsChips();
}

function renderTagsChips() {
  const chips   = document.getElementById('tags-chips');
  const empty   = document.getElementById('tags-empty');
  const summary = document.getElementById('tags-summary');
  chips.replaceChildren();

  const vendors = (_tagsData && _tagsData.vendors) || [];
  // "No analytics at all" is itself a finding on a client audit, so the
  // section stays put and says so rather than vanishing.
  empty.classList.toggle('hidden', vendors.length > 0);

  const warnings = ((_tagsData && _tagsData.flags) || []).filter(f => f.level === 'warning').length;
  const bits = [];
  if (vendors.length) bits.push(`${vendors.length} detected`);
  if (warnings) bits.push(`${warnings} issue${warnings === 1 ? '' : 's'}`);
  summary.textContent = bits.join(' · ');
  summary.classList.toggle('tags-summary--warn', warnings > 0);

  // Category order, so the row reads analytics-first rather than in whatever
  // order the page happened to load things.
  const order = TAG_CATEGORIES.map(c => c[0]);
  vendors.slice()
    .sort((a, b) => (order.indexOf(a.cat) - order.indexOf(b.cat)) || a.label.localeCompare(b.label))
    .forEach(v => chips.appendChild(tagChip(v)));
}

function tagChip(v) {
  const warned = tagsWarned(v.id);
  const btn = document.createElement('button');
  btn.className = 'gsc-intent-chip tag-chip' + (warned ? ' tag-chip--warn' : '');
  btn.title = warned
    ? `${v.label} — something looks off, open for detail`
    : `${v.label}${v.ids.length ? ` (${v.ids.join(', ')})` : ''}`;

  const label = document.createElement('span');
  label.textContent = v.label;
  btn.appendChild(label);

  // The ID is the thing a marketer actually wants off this screen, so show it
  // on the chip when there's exactly one and it's short enough to fit.
  if (v.ids.length === 1 && v.ids[0].length <= 16) {
    const id = document.createElement('span');
    id.className = 'gsc-intent-count tag-chip-id';
    id.textContent = v.ids[0];
    btn.appendChild(id);
  } else if (v.ids.length > 1) {
    const n = document.createElement('span');
    n.className = 'gsc-intent-count';
    n.textContent = String(v.ids.length);
    btn.appendChild(n);
  }

  if (warned) {
    const warn = document.createElement('span');
    warn.className = 'tag-chip-warn';
    warn.textContent = '!';
    btn.appendChild(warn);
  }

  btn.addEventListener('click', () => showTagsPanel());
  return btn;
}

// ─── Panel ────────────────────────────────────────────────────────────────────

function openTagsPanel() {
  renderTagsPanel();
  rescanTags();          // the reading Overview took may already be stale
}

async function rescanTags() {
  if (_tagsScanning) return;
  _tagsScanning = true;
  renderTagsPanel();
  try {
    const tab = await getActiveTab();
    // Pinned to the top frame for the same reason page reads are: content.js
    // runs in every frame, and here the stakes are higher than usual — an ad
    // or embed iframe is full of ad pixels and would happily report them as
    // the page's own stack.
    const res = await browser.tabs.sendMessage(tab.id, { action: 'getMarketingTags' }, TOP_FRAME);
    if (res && res.vendors) _tagsData = res;
  } catch { /* no content script on this page — keep what Overview had */ }
  _tagsScanning = false;
  renderTagsPanel();
  renderTagsChips();     // a late-loading tag should show up on Overview too
}

function renderTagsPanel() {
  const root = document.getElementById('tags-content');
  const meta = document.getElementById('tags-header-meta');
  root.replaceChildren();

  const vendors = (_tagsData && _tagsData.vendors) || [];
  const flags   = (_tagsData && _tagsData.flags) || [];

  meta.textContent = _tagsScanning
    ? 'Scanning…'
    : `${vendors.length} tag${vendors.length === 1 ? '' : 's'}`;

  if (!vendors.length) {
    const hint = document.createElement('div');
    hint.className = 'field-section field-hint hint-muted';
    hint.textContent = _tagsScanning
      ? 'Scanning the page…'
      : 'No marketing or analytics tags detected on this page.';
    root.appendChild(hint);
    return;
  }

  if (flags.length) root.appendChild(tagsFlagsSection(flags));

  const events = (_tagsData && _tagsData.events) || [];
  if (events.length) root.appendChild(tagsEventsSection(events));

  TAG_CATEGORIES.forEach(([cat, label]) => {
    const inCat = vendors.filter(v => v.cat === cat);
    if (!inCat.length) return;

    const section = document.createElement('section');
    section.className = 'field-section';

    const header = document.createElement('div');
    header.className = 'field-label';
    header.textContent = label.toUpperCase();
    section.appendChild(header);

    inCat.sort((a, b) => a.label.localeCompare(b.label)).forEach(v => section.appendChild(tagVendorRow(v)));
    root.appendChild(section);
  });

  root.appendChild(tagsScanNote());
}

function tagsFlagsSection(flags) {
  const section = document.createElement('section');
  section.className = 'field-section';

  const header = document.createElement('div');
  header.className = 'field-label';
  header.textContent = 'WHAT TO LOOK AT';
  section.appendChild(header);

  // Warnings first — an info note about two analytics tools shouldn't sit
  // above a property being counted twice.
  flags.slice()
    .sort((a, b) => (a.level === b.level ? 0 : a.level === 'warning' ? -1 : 1))
    .forEach(f => {
      const row = document.createElement('div');
      row.className = 'tag-flag tag-flag--' + f.level;
      const dot = document.createElement('span');
      dot.className = 'tag-flag-dot';
      dot.textContent = f.level === 'warning' ? '!' : 'i';
      const text = document.createElement('span');
      text.textContent = f.text;
      row.append(dot, text);
      section.appendChild(row);
    });

  return section;
}

// Seconds since the page started loading, on the same performance.now() basis
// as scannedAt — so an event's time and the scan-note footer always agree,
// with no wall-clock/timezone math needed on either side.
function fmtTagTime(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function tagsEventsSection(events) {
  const section = document.createElement('section');
  section.className = 'field-section';

  const header = document.createElement('div');
  header.className = 'field-label';
  header.textContent = 'RECENT EVENTS';
  section.appendChild(header);

  const hint = document.createElement('div');
  hint.className = 'field-hint hint-muted tag-events-hint';
  hint.textContent = 'What these tags have actually sent, most recent first — not just what loaded.';
  section.appendChild(hint);

  const list = document.createElement('div');
  list.className = 'tag-events-list';
  events.forEach(ev => {
    const row = document.createElement('div');
    row.className = 'tag-event-row' + (tagsWarned(ev.vendorId) ? ' tag-event-row--warn' : '');

    const name = document.createElement('span');
    name.className = 'tag-event-name';
    name.textContent = ev.name;
    row.appendChild(name);

    const vendor = document.createElement('span');
    vendor.className = 'tag-event-vendor';
    vendor.textContent = ev.label;
    row.appendChild(vendor);

    const at = document.createElement('span');
    at.className = 'tag-event-at';
    at.textContent = fmtTagTime(ev.at);
    at.title = 'Time since the page started loading';
    row.appendChild(at);

    list.appendChild(row);
  });
  section.appendChild(list);

  return section;
}

function tagVendorRow(v) {
  const row = document.createElement('div');
  row.className = 'tag-row' + (tagsWarned(v.id) ? ' tag-row--warn' : '');

  const head = document.createElement('div');
  head.className = 'tag-row-head';

  const name = document.createElement('span');
  name.className = 'tag-row-name';
  name.textContent = v.label;
  head.appendChild(name);

  v.ids.forEach(id => {
    const chip = document.createElement('span');
    chip.className = 'tag-row-id';
    chip.textContent = id;
    chip.title = 'Click to copy';
    chip.addEventListener('click', () => {
      copyToClipboard(id);
      // The copy itself was already silent-but-working — nothing confirmed
      // it happened, so a click here looked like it did nothing.
      if (chip.dataset.flashing) return;
      chip.dataset.flashing = '1';
      const original = id;
      chip.textContent = 'Copied';
      chip.classList.add('tag-row-id--copied');
      setTimeout(() => {
        chip.textContent = original;
        chip.classList.remove('tag-row-id--copied');
        delete chip.dataset.flashing;
      }, 900);
    });
    head.appendChild(chip);
  });

  row.appendChild(head);

  // Where it was seen. `dom` means an element for it is in the page right
  // now; it does NOT distinguish a hardcoded tag from one a tag manager
  // injected, so the wording stays factual.
  const meta = document.createElement('div');
  meta.className = 'tag-row-meta';
  const where = [];
  if (v.where.includes('dom')) where.push('in the page');
  if (v.where.includes('network')) where.push(`loaded${v.fetches > 1 ? ` ${v.fetches}×` : ''}`);
  if (!v.where.includes('network') && v.loads === 0) where.push('inline snippet only');
  meta.textContent = where.join(' · ');
  row.appendChild(meta);

  if (v.evidence.length) {
    const list = document.createElement('div');
    list.className = 'tag-row-urls';
    v.evidence.forEach(e => {
      const u = document.createElement('div');
      u.className = 'tag-row-url';
      u.textContent = e.url;
      u.title = e.url;
      list.appendChild(u);
    });
    row.appendChild(list);
  }

  return row;
}

function tagsScanNote() {
  const note = document.createElement('div');
  note.className = 'field-section field-hint hint-muted';
  const at = (_tagsData && _tagsData.scannedAt) || 0;
  note.textContent = at
    ? `Scanned ${(at / 1000).toFixed(1)}s after the page started loading. Tags that fire later won't appear until you refresh.`
    : 'Tags that fire after this scan won\'t appear until you refresh.';
  return note;
}

document.getElementById('btn-tags-refresh').addEventListener('click', rescanTags);
