// SERP overlay — badges Google search results with position (Organic vs Ads),
// flags client/competitor domains, and offers a one-click way to track a new
// competitor. Registered as its OWN content_scripts entry in manifest.base.json
// (matches: www.google.com/search only, all_frames:false), so this runs in a
// SEPARATE isolated world from content.js — no shared JS state, no shared
// tooltip. The only coupling with content.js is one-way: content.js's
// getPageData/getOverlayState read this file's toggle state off a DOM
// attribute on <html>, the one channel two isolated worlds share (see
// seoSerpOverlayActive() in content.js and announceSerpOverlayState() below).
//
// Design constraint carried through every piece of this file: thin, minimal,
// disappears gracefully. Nothing sits on the page as permanent clutter —
// badges are hover-reveal only, and the summary pill shrinks rather than
// nagging.

if (!window.__seoInspectorSerpLoaded) {
window.__seoInspectorSerpLoaded = true;

const SERP_BRIDGE_ATTR   = 'seoSerpOverlayActive';
const SERP_CONTAINER_ID  = 'seo-inspector-serp-overlay';
const SERP_SUMMARY_ID    = 'seo-inspector-serp-summary';

// Colors are hardcoded inline — popup.css never loads into the host page.
// Reused from the extension's own existing palette rather than invented:
// amber = "flagged/paid" (same tone as redirect/empty-alt warnings elsewhere
// in this codebase), green = "good/owned" (same tone as good-alt-text),
// indigo = the extension's own brand accent (icons/icon.svg), used here for
// "tracked competitor" / the actionable "+Competitor" chip since no other
// overlay in this codebase needed a third, distinct accent before now.
const SERP_COLORS = {
  organic: 'rgba(51,65,85,0.92)',      // neutral slate
  ad: 'rgba(180,95,6,0.92)',           // amber — matches LINK_COLORS.redirect
  own: 'rgba(22,163,74,0.92)',         // green — matches "good alt text"
  competitor: 'rgba(67,56,202,0.92)'   // indigo — the extension's brand accent
};

// ─── SERP parser: start ───────────────────────────────────────────────────────
// Pure, DOM-read-only. Kept free of any DOM-mutation code and bounded by these
// banner comments so tests/serp-parser.test.mjs can slice it out with the same
// `src.slice(from, to)` + `new Function(...)` technique marketing-tags.test.mjs
// already uses against content.js.

const SERP_NON_RESULT_HEADINGS = [
  'people also ask', 'related searches', 'people also search for', 'things to know'
];

// A deliberate duplicate of bg-clients.js's normalizeDomain() — a content
// script can't import a background file, and round-tripping every result
// through messaging just to normalize a string is wasteful for a function
// this cheap. Pinned identical to the background copy by a cross-file test.
function normalizeDomainSerp(x) {
  return String(x || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
}

// Google's own infrastructure domains never represent an advertiser or a
// result's actual destination — a raw href pointing here is not a fallback
// candidate, it's the click-tracking wrapper itself.
function isGoogleOwnedHost(host) {
  return /(^|\.)google(\.[a-z.]+)?$|(^|\.)googleadservices\.com$|(^|\.)doubleclick\.net$|(^|\.)gstatic\.com$/i.test(host || '');
}

// A block sits under a heading this codebase knows isn't a real result list
// (PAA, Related Searches, ...). In practice the structural test below (an
// anchor needs both an h3 AND a cite descendant) already excludes these —
// PAA rows in particular carry no h3 at all — but this is a second,
// independent safety net rather than relying on that alone.
function isNonResultChrome(el) {
  let node = el;
  for (let i = 0; i < 8 && node; i++, node = node.parentElement) {
    const heading = node.getAttribute && (node.getAttribute('role') === 'heading' ? node.textContent : '');
    const text = (heading || '').trim().toLowerCase();
    if (text && SERP_NON_RESULT_HEADINGS.some(h => text.startsWith(h))) return true;
  }
  return false;
}

// The decisive ad signal: an explicit "Ad"/"Sponsored" label, matched either
// on an element's aria-label or its OWN direct text (not full subtree text,
// so a longer sentence that happens to contain the word doesn't false-match).
// Known container ids (#tvcap/#tads/#tadsb/#bottomads) are NOT required here
// — they are the least stable part of Google's markup and are treated only
// as a region hint once a label has already been found (see adRegionFor).
// Checks only `container`'s OWN direct children, not its whole subtree — a
// full-subtree search would falsely match once ancestor-climbing (below)
// reaches a container broad enough to also contain OTHER, unrelated ad units
// elsewhere on the page (e.g. a shared ancestor like <body>), misattributing
// an organic result several sections away as an ad. A real Sponsored/Ad
// label sits as a near-sibling of its own ad's anchor, not buried deep in a
// shared ancestor.
function hasSponsoredLabel(container) {
  for (const el of container.children) {
    const aria = (el.getAttribute('aria-label') || '').trim();
    if (/^(ad|sponsored)$/i.test(aria)) return true;
    let ownText = '';
    for (const n of el.childNodes) if (n.nodeType === 3) ownText += n.textContent;
    if (/^(ad|sponsored)$/i.test(ownText.trim())) return true;
  }
  return false;
}

// Climbs from an h3-bearing anchor looking for the ad-unit container — the
// nearest ancestor that carries a Sponsored/Ad label. Returns null if the
// anchor is not inside an ad unit at all (i.e. it's a plain organic result).
function adUnitFor(anchor) {
  let el = anchor;
  for (let i = 0; i < 6 && el; i++, el = el.parentElement) {
    if (hasSponsoredLabel(el)) return el;
  }
  return null;
}

// #bottomads is the one durable-enough signal worth trusting for region —
// everything else (top vs some other placement) defaults to "top", since
// that's the overwhelmingly common case and a wrong "top" label is a much
// smaller error than inventing a third bucket nothing asked for.
function adRegionFor(unitEl) {
  return unitEl.closest('#bottomads') ? 'bottom' : 'top';
}

// Domain extraction, in priority order. Both organic and ad hrefs are
// routinely Google's own click-tracking redirects (/goto?url=..., or
// https://www.googleadservices.com/pagead/aclk?...) that never reveal the
// real destination — confirmed against live captures, not assumed — so the
// visible breadcrumb (a <cite> element) is the PRIMARY signal, not a
// fallback. `unitEl` is the smallest element known to contain the whole
// result (the anchor itself for organic results, the ad-unit container for
// ads, since an ad's <cite> is typically a sibling of its anchor, not a
// descendant of it).
function resultDomain(unitEl, href) {
  const cite = unitEl.querySelector('cite');
  if (cite) {
    for (const n of cite.childNodes) {
      if (n.nodeType === 3 && n.textContent.trim()) {
        const d = normalizeDomainSerp(n.textContent);
        if (d) return d;
      }
    }
    const d = normalizeDomainSerp(cite.textContent);
    if (d) return d;
  }
  if (href) {
    try {
      const u = new URL(href, location.href);
      if (u.protocol.startsWith('http') && !isGoogleOwnedHost(u.hostname)) {
        const d = normalizeDomainSerp(u.hostname);
        if (d) return d;
      }
    } catch { /* relative Google-internal path, e.g. /goto?url=... — no usable host */ }
  }
  return null;
}

// A qualifying result anchor: has an h3 heading AND a cite breadcrumb as
// descendants. This is deliberately structural rather than class-name based
// (Google's classes are obfuscated and shift), and it doubles as the organic
// exclusion for ads in practice — an ad's cite is usually a sibling of its
// anchor, not nested inside it, so it fails this test on its own even before
// the ad-unit/label check runs.
function isOrganicAnchor(a) {
  return !!(a.querySelector('h3') && a.querySelector('cite'));
}

function visualTop(el) {
  const r = el.getBoundingClientRect();
  return r.top + (window.scrollY || window.pageYOffset || 0);
}

function extractOrganicResults(root) {
  const anchors = Array.from(root.querySelectorAll('a[href]')).filter(isOrganicAnchor);
  const candidates = [];
  for (const a of anchors) {
    if (adUnitFor(a)) continue;           // structurally organic-shaped ad, still excluded
    if (isNonResultChrome(a)) continue;
    candidates.push({ el: a, domain: resultDomain(a, a.getAttribute('href')) });
  }
  candidates.sort((x, y) => visualTop(x.el) - visualTop(y.el));
  return candidates.map((c, i) => ({ ...c, position: i + 1 }));
}

function extractAdResults(root) {
  const anchors = Array.from(root.querySelectorAll('a[href]')).filter(a => a.querySelector('h3'));
  const top = [], bottom = [];
  const seenUnits = new Set();
  for (const a of anchors) {
    const unit = adUnitFor(a);
    if (!unit || seenUnits.has(unit)) continue;   // one badge per ad unit, not per anchor inside it
    seenUnits.add(unit);
    const entry = { el: a, domain: resultDomain(unit, a.getAttribute('href')) };
    (adRegionFor(unit) === 'bottom' ? bottom : top).push(entry);
  }
  top.sort((x, y) => visualTop(x.el) - visualTop(y.el));
  bottom.sort((x, y) => visualTop(x.el) - visualTop(y.el));
  return {
    topAds: top.map((c, i) => ({ ...c, position: i + 1 })),
    bottomAds: bottom.map((c, i) => ({ ...c, position: i + 1 }))
  };
}

// Anything with an h3 that qualifies for neither organic nor ad extraction —
// not guessed at, just counted, so a parser miss is visible rather than
// silently mislabeled.
function countSkipped(root, organic, topAds, bottomAds) {
  const claimed = new Set([...organic, ...topAds, ...bottomAds].map(c => c.el));
  const anchors = Array.from(root.querySelectorAll('a[href]')).filter(a => a.querySelector('h3'));
  const claimedUnits = new Set();
  let skipped = 0;
  for (const a of anchors) {
    if (claimed.has(a)) continue;
    const unit = adUnitFor(a);
    if (unit) {
      if (!claimedUnits.has(unit)) { claimedUnits.add(unit); skipped++; }
    } else if (!isOrganicAnchor(a) || isNonResultChrome(a)) {
      // Has an h3 but either no cite (fails the organic test) or sits under
      // known non-result chrome — not confidently classifiable either way.
      skipped++;
    }
  }
  return skipped;
}

function parseSerpResults(doc = document) {
  const root = doc.getElementById('rso') || doc.getElementById('search') || doc.body;
  const organic = extractOrganicResults(root);
  const { topAds, bottomAds } = extractAdResults(doc.body);
  return { organic, topAds, bottomAds, skipped: countSkipped(root, organic, topAds, bottomAds) };
}
// ─── SERP parser: end ─────────────────────────────────────────────────────────

// ─── Client matching ──────────────────────────────────────────────────────────
// Depends on the parser's output plus one serpClientIndex() round trip. There
// is no "active client" concept anywhere in this extension (every other panel
// resolves by matching the ACTIVE TAB's own hostname, which is meaningless on
// google.com) — so this resolves client context from the SERP's OWN result
// domains, matching the user's own framing: "any client domain present on the
// page", not a persisted single selection.

function relationFor(domain, index) {
  if (!domain) return null;
  const rels = index.domains && index.domains[domain];
  if (!rels || !rels.length) return null;
  // "own" wins visually over "competitor" when a domain is somehow both.
  return rels.find(r => r.role === 'own') || rels[0];
}

function matchClients(parsed, index) {
  const distinctClientIds = new Set();
  const perClient = {};   // clientId -> { name, organic:[pos], topAds:[pos], bottomAds:[pos] }
  const annotate = (list, bucket) => list.map(entry => {
    const rel = relationFor(entry.domain, index);
    if (rel) {
      distinctClientIds.add(rel.clientId);
      const c = (perClient[rel.clientId] ||= { name: rel.clientName, organic: [], topAds: [], bottomAds: [] });
      c[bucket].push(entry.position);
    }
    return { ...entry, role: rel ? rel.role : null, clientId: rel ? rel.clientId : null, clientName: rel ? rel.clientName : null };
  });
  return {
    organic: annotate(parsed.organic, 'organic'),
    topAds: annotate(parsed.topAds, 'topAds'),
    bottomAds: annotate(parsed.bottomAds, 'bottomAds'),
    skipped: parsed.skipped,
    distinctClientIds,
    perClient
  };
}

// Gates the "+Competitor" chip: only offered when the page unambiguously
// belongs to one client. Zero or multiple matches means there's no single
// list to write a new competitor to, so the chip is simply omitted — no
// picker UI, per the explicit product decision behind this design.
function soleClientId(distinctClientIds) {
  return distinctClientIds.size === 1 ? [...distinctClientIds][0] : null;
}
// ─── Client matching: end ─────────────────────────────────────────────────────

// ─── Rendering ────────────────────────────────────────────────────────────────

function serpBadgeLabel(entry, kind) {
  const n = { organic: 'Organic', topAd: 'Top Ad', bottomAd: 'Bottom Ad' }[kind];
  return `${n} #${entry.position}`;
}

function serpBadgeAccent(entry) {
  if (entry.role === 'own') return { color: SERP_COLORS.own, text: `Client · ${entry.clientName}` };
  if (entry.role === 'competitor') return { color: SERP_COLORS.competitor, text: `Competitor · ${entry.clientName}` };
  return null;
}

function makeSerpBadge(entry, kind, soleId) {
  const badge = document.createElement('div');
  badge.style.cssText = [
    'position:fixed', 'opacity:0', 'pointer-events:none', 'transition:opacity 120ms ease',
    'background:rgba(15,23,42,0.94)', 'color:#fff', 'padding:4px 8px', 'border-radius:6px',
    'font:600 11px/1.4 -apple-system,system-ui,sans-serif', 'box-shadow:0 2px 8px rgba(0,0,0,0.3)',
    'z-index:2147483646', 'display:flex', 'align-items:center', 'gap:6px', 'white-space:nowrap'
  ].join(';');

  const posColor = kind === 'organic' ? SERP_COLORS.organic : SERP_COLORS.ad;
  const posSpan = document.createElement('span');
  posSpan.textContent = serpBadgeLabel(entry, kind);
  posSpan.style.cssText = `color:${posColor === SERP_COLORS.organic ? '#cbd5e1' : '#fcd34d'}`;
  badge.appendChild(posSpan);

  const accent = serpBadgeAccent(entry);
  if (accent) {
    const dot = document.createElement('span');
    dot.style.cssText = `width:7px;height:7px;border-radius:50%;background:${accent.color};flex:none`;
    const label = document.createElement('span');
    label.textContent = accent.text;
    badge.appendChild(dot);
    badge.appendChild(label);
  } else if (entry.domain && soleId) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.textContent = '+ Competitor';
    chip.style.cssText = [
      `background:${SERP_COLORS.competitor}`, 'color:#fff', 'border:none', 'border-radius:4px',
      'padding:2px 6px', 'font:600 10px/1.4 -apple-system,system-ui,sans-serif', 'cursor:pointer', 'pointer-events:auto'
    ].join(';');
    chip.addEventListener('click', (e) => addCompetitorFromChip(e, chip, entry.domain, soleId));
    badge.appendChild(chip);
  }
  return badge;
}

async function addCompetitorFromChip(e, chip, domain, clientId) {
  e.preventDefault();
  e.stopPropagation();
  chip.disabled = true;
  chip.style.opacity = '0.6';
  try {
    const { client } = await browser.runtime.sendMessage({ action: 'clientRegistryGet', id: clientId });
    if (!client) throw new Error('client not found');
    const merged = [...new Set([...(client.competitors || []), domain])];
    const res = await browser.runtime.sendMessage({
      action: 'clientRegistrySetCompetitors', id: clientId, competitors: merged, markPulled: false
    });
    if (!res || !res.ok) throw new Error('save failed');
    const label = document.createElement('span');
    label.textContent = `Competitor · ${client.name}`;
    label.style.cssText = `color:${SERP_COLORS.competitor}`;
    chip.replaceWith(label);
    patchSummaryOnCompetitorAdded(client.id, client.name);
  } catch {
    chip.disabled = false;
    chip.style.opacity = '';
  }
}

function applySerpOverlay() {
  removeSerpOverlay();

  const container = document.createElement('div');
  container.id = SERP_CONTAINER_ID;
  container.style.cssText = [
    'position:fixed', 'top:0', 'left:0', 'width:0', 'height:0',
    'overflow:visible', 'z-index:2147483646', 'pointer-events:none'
  ].join(';');
  document.body.appendChild(container);
  container._hoverPairs = [];

  const parsed = parseSerpResults();
  browser.runtime.sendMessage({ action: 'serpClientIndex' }).then(index => {
    const live = document.getElementById(SERP_CONTAINER_ID);
    if (!live || live !== container) return;   // toggled off before this resolved
    const matched = matchClients(parsed, index || { domains: {} });
    renderSerpResults(container, matched);
    renderSerpSummary(matched);
  }).catch(() => {
    // No background reply — still badge positions/types, just with no
    // client/competitor context.
    const empty = matchClients(parsed, { domains: {} });
    renderSerpResults(container, empty);
    renderSerpSummary(empty);
  });
}

function renderSerpResults(container, matched) {
  const soleId = soleClientId(matched.distinctClientIds);
  const entries = [
    ...matched.organic.map(e => ({ e, kind: 'organic' })),
    ...matched.topAds.map(e => ({ e, kind: 'topAd' })),
    ...matched.bottomAds.map(e => ({ e, kind: 'bottomAd' }))
  ];

  const pairs = [];
  entries.forEach(({ e, kind }) => {
    const badge = makeSerpBadge(e, kind, soleId);
    container.appendChild(badge);
    const enter = () => { badge.style.opacity = '1'; badge.style.pointerEvents = 'auto'; };
    const leave = () => { badge.style.opacity = '0'; badge.style.pointerEvents = 'none'; };
    e.el.addEventListener('mouseenter', enter);
    e.el.addEventListener('mouseleave', leave);
    pairs.push({ el: e.el, badge, enter, leave });
  });
  container._hoverPairs = pairs;

  function updatePositions() {
    pairs.forEach(({ el, badge }) => {
      const r = el.getBoundingClientRect();
      const offscreen = r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth;
      if (offscreen) { badge.style.display = 'none'; return; }
      badge.style.display = 'flex';
      badge.style.top = `${Math.max(4, r.top - 22)}px`;
      badge.style.left = `${r.left}px`;
    });
  }
  updatePositions();
  container._update = () => requestAnimationFrame(updatePositions);
  window.addEventListener('scroll', container._update, { passive: true });
  window.addEventListener('resize', container._update, { passive: true });
}

function removeSerpOverlay() {
  const container = document.getElementById(SERP_CONTAINER_ID);
  if (container) {
    if (container._update) {
      window.removeEventListener('scroll', container._update);
      window.removeEventListener('resize', container._update);
    }
    (container._hoverPairs || []).forEach(({ el, enter, leave }) => {
      el.removeEventListener('mouseenter', enter);
      el.removeEventListener('mouseleave', leave);
    });
    container.remove();
  }
  removeSerpSummary();
  // The bridge attribute is NOT cleared here — it's owned entirely by
  // toggleSerpOverlayState, set/cleared in lockstep with _serpOverlayOn. The
  // apply function above calls this one first as an idempotent re-apply, and
  // clearing the attribute here would wipe out what the toggle just set.
}
// ─── Rendering: end ───────────────────────────────────────────────────────────

// ─── Summary pill ─────────────────────────────────────────────────────────────
// Same visual family as content.js's linkIndicator() (dark translucent,
// rounded, box-shadow), mirrored to the top-left corner. Unlike
// removeLinkIndicator's delete-on-fade, the nonzero-match case shrinks the
// SAME element to a small persistent pill rather than removing it, so it
// stays re-openable without a reparse.

let _serpSummaryFullState = null;
let _serpSummaryPinned = false;
let _serpSummaryShrinkTimer = null;

function serpSummaryEl() {
  let el = document.getElementById(SERP_SUMMARY_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = SERP_SUMMARY_ID;
    el.style.cssText = [
      'position:fixed', 'top:12px', 'left:12px', 'z-index:2147483647',
      'background:rgba(15,15,15,0.9)', 'color:#fff', 'padding:6px 10px',
      'border-radius:6px', 'font:600 12px/1.4 -apple-system,system-ui,sans-serif',
      'box-shadow:0 2px 10px rgba(0,0,0,0.35)', 'max-width:280px', 'cursor:pointer'
    ].join(';');
    document.body.appendChild(el);
  }
  return el;
}

function removeSerpSummary() {
  clearTimeout(_serpSummaryShrinkTimer);
  document.getElementById(SERP_SUMMARY_ID)?.remove();
  _serpSummaryFullState = null;
  _serpSummaryPinned = false;
}

function summaryFullText(matched) {
  const clients = Object.values(matched.perClient);
  if (!clients.length) return null;
  return clients.map(c => {
    const parts = [];
    if (c.organic.length) parts.push(`Organic #${c.organic.join(', #')}`);
    if (c.topAds.length) parts.push(`Top Ad #${c.topAds.join(', #')}`);
    if (c.bottomAds.length) parts.push(`Bottom Ad #${c.bottomAds.join(', #')}`);
    return `${c.name}: ${parts.join(' · ') || 'present'}`;
  }).join('\n');
}

function expandSummary() {
  const el = serpSummaryEl();
  el.textContent = _serpSummaryFullState;
  el.style.whiteSpace = 'pre-line';
}

function shrinkSummary() {
  if (_serpSummaryPinned) return;
  const el = document.getElementById(SERP_SUMMARY_ID);
  if (!el) return;
  const count = (_serpSummaryFullState.match(/\n/g) || []).length + 1;
  el.textContent = `${count} client${count === 1 ? '' : 's'} on this SERP`;
  el.style.whiteSpace = 'nowrap';
}

function renderSerpSummary(matched) {
  removeSerpSummary();
  const text = summaryFullText(matched);
  const el = serpSummaryEl();

  if (!text) {
    el.textContent = 'No tracked client found on this SERP';
    setTimeout(() => document.getElementById(SERP_SUMMARY_ID)?.remove(), 2000);
    return;
  }

  _serpSummaryFullState = text;
  expandSummary();
  _serpSummaryShrinkTimer = setTimeout(shrinkSummary, 3500);

  el.addEventListener('mouseenter', () => { clearTimeout(_serpSummaryShrinkTimer); expandSummary(); });
  el.addEventListener('mouseleave', () => { if (!_serpSummaryPinned) _serpSummaryShrinkTimer = setTimeout(shrinkSummary, 800); });
  el.addEventListener('click', () => {
    _serpSummaryPinned = !_serpSummaryPinned;
    if (_serpSummaryPinned) { clearTimeout(_serpSummaryShrinkTimer); expandSummary(); }
    else _serpSummaryShrinkTimer = setTimeout(shrinkSummary, 800);
  });
}

// Patches the cached summary in place after a successful "+Competitor" click,
// so the pill reflects the addition without a reparse or a second
// serpClientIndex() round trip.
function patchSummaryOnCompetitorAdded(clientId, clientName) {
  if (!_serpSummaryFullState) return;
  if (_serpSummaryFullState.includes(`${clientName}:`)) return;   // already listed
  _serpSummaryFullState += `\n${clientName}: competitor added`;
  if (document.getElementById(SERP_SUMMARY_ID)) expandSummary();
}
// ─── Summary pill: end ────────────────────────────────────────────────────────

// ─── Toggle plumbing ──────────────────────────────────────────────────────────
// Per-document, never persisted — the same hard invariant content.js's own
// overlays follow (see the note above _altOverlayOn/_linkOverlayOn there):
// restoring from storage on every load is what previously made the link
// overlay silently reappear on every site forever, once switched on anywhere.

let _serpOverlayOn = false;

function announceSerpOverlayState() {
  browser.runtime.sendMessage({ action: 'overlayStateChanged', serpOverlayActive: _serpOverlayOn })
    .catch(() => { /* nothing listening — the panel is closed */ });
}

function toggleSerpOverlayState() {
  _serpOverlayOn = !_serpOverlayOn;
  // Set synchronously with the flag itself — content.js's getPageData/
  // getOverlayState read this bridge attribute, and the actual badge
  // rendering below is async (one serpClientIndex round trip), so setting it
  // only after that resolves would leave a brief window where a toolbar-menu
  // checkmark opened right after toggling on would wrongly read "off".
  if (_serpOverlayOn) document.documentElement.dataset[SERP_BRIDGE_ATTR] = 'true';
  else delete document.documentElement.dataset[SERP_BRIDGE_ATTR];
  if (_serpOverlayOn) applySerpOverlay(); else removeSerpOverlay();
  announceSerpOverlayState();
  return Promise.resolve(_serpOverlayOn);
}

// Only toggleSerpOverlay lives here — getOverlayState/getPageData stay
// exclusively content.js's job (reading the DOM bridge attribute above), so
// two listeners in the same tab never race to answer the same message.
browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'toggleSerpOverlay') {
    toggleSerpOverlayState().then(next => sendResponse({ serpOverlayActive: next }));
    return true;
  }
});

}
