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
// Why the last read produced nothing: 'unreadable' when the page could not be
// asked at all, 'navigated' when the answer came back describing a different
// page. Both used to leave the PREVIOUS page's tags on screen, which is how a
// GTM container from another client ended up attributed to this one.
let _tagsError = null;

// A reading is only valid for the page it was taken from. Compared without the
// hash, since a fragment change is the same document and the same tags.
function tagsSameUrl(a, b) {
  const norm = (u) => String(u || '').split('#')[0];
  return !!a && !!b && norm(a) === norm(b);
}

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
  _tagsError = null;
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
    if (!res || !res.vendors) {
      _tagsData = null;
      _tagsError = 'unreadable';
    } else if (res.pageUrl && tab.url && !tagsSameUrl(res.pageUrl, tab.url)) {
      // The tab navigated while the read was in flight. Its answer describes a
      // page nobody is looking at any more.
      _tagsData = null;
      _tagsError = 'navigated';
    } else {
      _tagsData = res;
      _tagsError = null;
    }
  } catch {
    // The page cannot be read — about:, the PDF viewer, AMO, a tab still
    // loading. Previously this KEPT the last reading, so the tags of whatever
    // you looked at before were shown as if they belonged to this page.
    _tagsData = null;
    _tagsError = 'unreadable';
  }
  _tagsScanning = false;
  renderTagsPanel();
  renderTagsChips();     // a late-loading tag should show up on Overview too
}

// ─── Attribution: what the tag manager fired ─────────────────────────────────
//
// Two evidence levels, kept apart on purpose. A tag whose LIBRARY carries the
// container's `gtm=` stamp was demonstrably loaded by it. A tag that merely
// appeared after the container loaded is a guess — usually a good one, since
// that is how Meta and TikTok pixels are normally deployed, but nothing in the
// request proves it. Presenting the guess as the fact is exactly the failure
// this panel just got fixed for.
function tagsAttribution(vendors) {
  const containers = vendors.filter(v => v.cat === 'tagmanager');
  const others = vendors.filter(v => v.cat !== 'tagmanager');

  // Earliest container load. Anything before it cannot have been fired by it.
  const containerAt = containers.reduce((min, c) =>
    (c.firstAt != null && (min == null || c.firstAt < min)) ? c.firstAt : min, null);

  const fired = [], measured = [], after = [], independent = [];
  others.forEach(v => {
    // Proven: the container loaded the library itself.
    if (v.loadedByTagManager) fired.push(v);
    // Also proven, but a different arrangement: the page loaded the library
    // and the container drives its measurement. Common, and neither "fired by
    // the container" nor "nothing to do with it" describes it.
    else if (v.beaconsViaTagManager) measured.push(v);
    else if (containerAt != null && v.firstAt != null && v.firstAt >= containerAt) after.push(v);
    else independent.push(v);
  });

  const byTime = (a, b) => (a.firstAt ?? 1e9) - (b.firstAt ?? 1e9);
  return {
    containers,
    // The stamp names no container, so a page with several of them can only be
    // told that "a container" fired the tag.
    ambiguous: containers.length > 1,
    fired: fired.sort(byTime),
    measured: measured.sort(byTime),
    after: after.sort(byTime),
    independent: independent.sort(byTime)
  };
}

// The container view: what it fired, what merely followed it, and what it had
// nothing to do with.
function tagsAttributionSection(attr, events) {
  const sec = document.createElement('section');
  sec.className = 'field-section';

  const head = document.createElement('div');
  head.className = 'field-header';
  const lbl = document.createElement('span');
  lbl.className = 'field-label';
  const names = attr.containers.map(c => (c.ids && c.ids[0]) || c.label);
  lbl.textContent = names.length === 1 ? `FIRED BY ${names[0]}` : 'FIRED BY TAG MANAGER';
  head.appendChild(lbl);
  sec.appendChild(head);

  const group = (title, list, note, level) => {
    if (!list.length) return;
    const h = document.createElement('div');
    h.className = `tags-attr-group tags-attr-group--${level}`;
    h.textContent = title;
    if (note) h.title = note;
    sec.appendChild(h);
    if (note) {
      const n = document.createElement('div');
      n.className = 'field-hint hint-muted tags-attr-note';
      n.textContent = note;
      sec.appendChild(n);
    }
    list.forEach(v => sec.appendChild(tagsAttrRow(v, events)));
  };

  group(
    attr.ambiguous ? 'Fired by a tag manager' : 'Fired by this container',
    attr.fired,
    'Proven: the request carries the container\u2019s own gtm= stamp.',
    'proven'
  );
  group(
    'Measured by it, loaded by the page',
    attr.measured,
    'The library is on the page directly, but its beacons carry the container\u2019s stamp.',
    'proven'
  );
  group(
    'Loaded after it',
    attr.after,
    'Inferred from timing only \u2014 these carry no container stamp, so this is likely but unproven.',
    'inferred'
  );
  group(
    'Independent of it',
    attr.independent,
    'Loaded before the container, so it cannot have fired them.',
    'independent'
  );

  return sec;
}

function tagsAttrRow(v, events) {
  const row = document.createElement('div');
  row.className = 'tags-attr-row';

  const line = document.createElement('div');
  line.className = 'tags-attr-line';
  const name = document.createElement('span');
  name.className = 'tags-attr-name';
  name.textContent = v.label + (v.ids && v.ids.length ? `  ${v.ids.join(', ')}` : '');
  line.appendChild(name);

  if (v.firstAt != null) {
    const at = document.createElement('span');
    at.className = 'tags-attr-at';
    at.textContent = `${v.firstAt} ms`;
    line.appendChild(at);
  }
  if (v.tagManagerStamp) {
    const st = document.createElement('span');
    st.className = 'tags-attr-stamp';
    st.textContent = `gtm=${v.tagManagerStamp}`;
    st.title = 'The container version stamp carried by this request';
    line.appendChild(st);
  }
  row.appendChild(line);

  // A tag whose library the page loaded but whose beacons the container
  // drives is a real and common arrangement, and neither half of it alone
  // describes the setup.
  events.filter(e => e.vendorId === v.id).slice(0, 6).forEach(e => {
    const ev = document.createElement('div');
    ev.className = 'tags-attr-event';
    ev.textContent = `\u2192 ${e.name}`;
    const at = document.createElement('span');
    at.className = 'tags-attr-at';
    at.textContent = `${e.at} ms`;
    ev.appendChild(at);
    row.appendChild(ev);
  });

  return row;
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
    hint.className = 'field-section field-hint ' + (_tagsError && !_tagsScanning ? 'hint-amber' : 'hint-muted');
    // "Could not read" and "read it, found nothing" are different findings —
    // an audit that conflates them is how you conclude a site has no
    // analytics when you simply never looked.
    hint.textContent = _tagsScanning ? 'Scanning the page…'
      : _tagsError === 'unreadable' ? 'Could not read this page — open the panel on a regular web page and refresh.'
      : _tagsError === 'navigated'  ? 'The page changed while scanning — refresh to read it again.'
      : 'No marketing or analytics tags detected on this page.';
    root.appendChild(hint);
    return;
  }

  if (flags.length) root.appendChild(tagsFlagsSection(flags));

  const attr = tagsAttribution(vendors);
  if (attr.containers.length && (attr.fired.length || attr.measured.length || attr.after.length)) {
    root.appendChild(tagsAttributionSection(attr, (_tagsData && _tagsData.events) || []));
  }

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
