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
// Searches container's WHOLE subtree for a Sponsored/Ad label — safe only
// because adUnitFor (below) never lets `container` grow past a boundary that
// still contains just one result heading. A real per-item label (confirmed
// against a live "Sponsored Results" list widget, a card-based ad layout
// distinct from the classic #tads block) can sit more than one level below
// its own ad's anchor — a direct-children-only search missed it there.
function hasSponsoredLabel(container) {
  const els = container.querySelectorAll('[aria-label], span, div');
  for (const el of els) {
    const aria = (el.getAttribute('aria-label') || '').trim();
    if (/^(ad|sponsored)$/i.test(aria)) return true;
    let ownText = '';
    for (const n of el.childNodes) if (n.nodeType === 3) ownText += n.textContent;
    if (/^(ad|sponsored)$/i.test(ownText.trim())) return true;
  }
  return false;
}

// Climbs from an h3-bearing anchor looking for the ad-unit container — the
// nearest ancestor that carries a Sponsored/Ad label. The climb stops the
// moment an ancestor contains more than one result heading — that's the real
// safety boundary (a shared ancestor spanning multiple results, like <body>,
// is exactly what previously caused a distant, unrelated ad's label to be
// found and misattribute an organic result as an ad), not an arbitrary level
// count. Bounded to 10 climbs as a sane outer limit, not the load-bearing
// guard. Returns null if the anchor is not inside an ad unit at all.
function adUnitFor(anchor) {
  let el = anchor;
  for (let i = 0; i < 10 && el; i++, el = el.parentElement) {
    if (el.querySelectorAll('h3').length > 1) return null;
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

// Second, independent ad signal, for a layout with no per-card label at all
// — only a single "Sponsored Results" section heading above a list of cards
// that otherwise look exactly like organic results (confirmed live: a card
// with a photo carousel, rating stars, and Website/Directions/Call pill
// buttons, no "Sponsored" text anywhere near the card itself). adUnitFor()
// finds nothing here, since there IS no per-card label to find.
//
// A heading-shaped leaf element (short, no child elements) whose text starts
// "Sponsored" opens a range; it closes at the next heading-shaped element
// found afterward, whatever it says — in practice that's usually the "Hide
// sponsored results" toggle both real captures of this layout carry, but the
// rule doesn't depend on that exact wording, just on SOME other heading
// eventually marking the run's end. An anchor whose document position falls
// inside any such range is treated as an ad even with no label of its own.
function isHeadingLike(el) {
  if (el.children.length > 0) return false;
  const t = el.textContent.trim();
  return t.length > 0 && t.length <= 60;
}
// Deliberately stricter than isHeadingLike, and used ONLY to find where a
// sponsored range ENDS — a real accessible heading (explicit role="heading",
// the same attribute confirmed live on Google's own "People also ask"
// label) or a known section-transition phrase. isHeadingLike alone is too
// broad for this: a rating ("4.2 (20)"), an address, or "Closed" are all
// short leaf text too, and would close the range right after the FIRST ad
// card — before ever reaching the second one.
function isSectionBoundaryLike(el) {
  if (el.getAttribute && el.getAttribute('role') === 'heading') return true;
  const t = el.textContent.trim().toLowerCase();
  return /^(hide|show) sponsored|^people also ask|^related searches/.test(t);
}
function sponsoredSectionRanges(doc) {
  const all = Array.from(doc.querySelectorAll('*'));
  // A per-card "Sponsored" label (the classic #tads layout already handles
  // via adUnitFor) also matches this opener shape — harmless on its own, but
  // an unbounded range is not: with no closing boundary nearby, it would
  // otherwise extend to the end of the document and sweep up every genuine
  // organic result after it. Discard rather than leave it open-ended; a
  // range only exists where both ends are confidently known.
  const openers = all.filter(el => isHeadingLike(el) && /^sponsored\b/i.test(el.textContent.trim()));
  const boundaries = all.filter(isSectionBoundaryLike);
  const F = window.Node.DOCUMENT_POSITION_FOLLOWING;
  return openers
    .map(opener => [opener, boundaries.find(b => opener.compareDocumentPosition(b) & F) || null])
    .filter(([, end]) => end !== null);
}
function inSponsoredRange(el, ranges) {
  const F = window.Node.DOCUMENT_POSITION_FOLLOWING;
  // Every range here has a real, known end (sponsoredSectionRanges discards
  // any that don't), so both bounds are always checked.
  return ranges.some(([start, end]) =>
    (start.compareDocumentPosition(el) & F) && (el.compareDocumentPosition(end) & F));
}
// Union of both ad signals — a per-card label (adUnitFor) OR falling inside
// a sponsored section range. `unit` prefers adUnitFor's more precise
// boundary when a per-card label exists; otherwise the anchor itself stands
// in (its own cite/breadcrumb structure is organic-shaped for this layout,
// confirmed live, so resultDomain() still resolves correctly against it).
function adInfoFor(anchor, ranges) {
  const unit = adUnitFor(anchor);
  if (unit) return { isAd: true, unit };
  if (inSponsoredRange(anchor, ranges)) return { isAd: true, unit: anchor };
  return { isAd: false, unit: null };
}

function extractOrganicResults(root, ranges) {
  const anchors = Array.from(root.querySelectorAll('a[href]')).filter(isOrganicAnchor);
  const candidates = [];
  for (const a of anchors) {
    if (adInfoFor(a, ranges).isAd) continue;   // structurally organic-shaped ad, still excluded
    if (isNonResultChrome(a)) continue;
    candidates.push({ el: a, domain: resultDomain(a, a.getAttribute('href')) });
  }
  candidates.sort((x, y) => visualTop(x.el) - visualTop(y.el));
  return candidates.map((c, i) => ({ ...c, position: i + 1 }));
}

function extractAdResults(root, ranges) {
  const anchors = Array.from(root.querySelectorAll('a[href]')).filter(a => a.querySelector('h3'));
  const top = [], bottom = [];
  const seenUnits = new Set();
  for (const a of anchors) {
    const { isAd, unit } = adInfoFor(a, ranges);
    if (!isAd || seenUnits.has(unit)) continue;   // one badge per ad unit, not per anchor inside it
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
function countSkipped(root, organic, topAds, bottomAds, ranges) {
  const claimed = new Set([...organic, ...topAds, ...bottomAds].map(c => c.el));
  const anchors = Array.from(root.querySelectorAll('a[href]')).filter(a => a.querySelector('h3'));
  const claimedUnits = new Set();
  let skipped = 0;
  for (const a of anchors) {
    if (claimed.has(a)) continue;
    const { isAd, unit } = adInfoFor(a, ranges);
    if (isAd) {
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
  const ranges = sponsoredSectionRanges(doc);   // computed once — reused by both extractors and countSkipped
  const organic = extractOrganicResults(root, ranges);
  const { topAds, bottomAds } = extractAdResults(doc.body, ranges);
  return { organic, topAds, bottomAds, skipped: countSkipped(root, organic, topAds, bottomAds, ranges) };
}

// The on-screen query — the one thing that lets a WebCEO tracked-keyword row
// be matched to what the user is actually looking at right now.
function serpQuery() {
  try { return new URLSearchParams(location.search).get('q') || ''; } catch { return ''; }
}

// A <span> whose only element children are <em> (Google boldfaces
// query-matched terms this way inside the snippet) — the structural shape of
// a real snippet text run, not a wrapping layout div. Climbing from the
// anchor mirrors adUnitFor's bounded-ancestor approach; searching for the
// LONGEST such span within that scope (rather than the first) avoids picking
// up short incidental UI labels that happen to share the shape.
function isLeafyTextSpan(el) {
  if (el.tagName !== 'SPAN') return false;
  for (const child of el.children) if (child.tagName !== 'EM') return false;
  return true;
}
function findSnippetSpan(anchor) {
  let container = anchor;
  for (let i = 0; i < 6 && container.parentElement; i++) container = container.parentElement;
  const candidates = Array.from(container.querySelectorAll('span')).filter(isLeafyTextSpan);
  let best = null, bestLen = 0;
  for (const el of candidates) {
    if (anchor.contains(el)) continue;   // the title itself, not the snippet
    if (el.closest('cite')) continue;
    const len = el.textContent.trim().length;
    if (len > bestLen) { best = el; bestLen = len; }
  }
  return bestLen >= 20 ? best : null;
}
function resultSnippetText(anchor) {
  const span = findSnippetSpan(anchor);
  return span ? span.textContent.trim() : null;
}

// The smallest ancestor containing BOTH the title link and its snippet text
// — the true visual result card, derived structurally (no hardcoded depth or
// class name) rather than guessed. This is the hover-reveal target: the
// snippet text sits outside the anchor entirely (a sibling, not nested
// inside it, confirmed against the real fixtures), so hovering only the
// anchor left most of the visible card dead to the badge.
function commonAncestor(a, b) {
  const ancestors = new Set();
  for (let el = a; el; el = el.parentElement) ancestors.add(el);
  for (let el = b; el; el = el.parentElement) if (ancestors.has(el)) return el;
  return a;
}
function resultCardEl(anchor) {
  const span = findSnippetSpan(anchor);
  return span ? commonAncestor(anchor, span) : anchor;
}

function normalizeCompareText(s) {
  return String(s || '').toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
}

// Google routinely truncates a long title with an ellipsis rather than
// rewriting it — that's not a mismatch. Only flag when the displayed text
// isn't a prefix-consistent match of the real title either way.
function titlesDiffer(displayed, real) {
  if (!displayed || !real) return false;
  const d = normalizeCompareText(displayed).replace(/[.…]+$/, '');
  const r = normalizeCompareText(real);
  if (!d || !r || r === d) return false;
  return !r.startsWith(d) && !d.startsWith(r);
}

function wordOverlapRatio(a, b) {
  const words = (s) => new Set(normalizeCompareText(s).split(/\W+/).filter(w => w.length > 2));
  const wa = words(a), wb = words(b);
  if (!wa.size || !wb.size) return 0;
  let shared = 0;
  wa.forEach(w => { if (wb.has(w)) shared++; });
  return shared / Math.min(wa.size, wb.size);
}

// Google frequently rewrites the snippet from page content even when the meta
// tag is perfectly fine — expected behavior, not a mismatch. Only flag when
// overlap is low enough to suggest the meta tag isn't being used at all.
const DESCRIPTION_OVERLAP_THRESHOLD = 0.35;
function descriptionsDiffer(displayed, real) {
  if (!displayed || !real) return false;
  return wordOverlapRatio(displayed, real) < DESCRIPTION_OVERLAP_THRESHOLD;
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

// No visible name — the URL and favicon already say which site this is; the
// dot's color is the at-a-glance signal (own vs. competitor). The name still
// reaches the user, just on demand: title + aria-label carry it for anyone
// who hovers or uses a screen reader.
function serpBadgeAccent(entry) {
  if (entry.role === 'own') return { color: SERP_COLORS.own, detail: `Client · ${entry.clientName}` };
  if (entry.role === 'competitor') return { color: SERP_COLORS.competitor, detail: `Competitor · ${entry.clientName}` };
  return null;
}

// A row per line, not one long flex row — a badge wide enough to reach the
// actual result text (a long client name, or the mismatch flag's text) used
// to render right over the result it's describing. max-width bounds it
// further so an unusually long single line still wraps rather than growing
// past the result column.
function badgeRow() {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:6px';
  return row;
}

function makeSerpBadge(entry, kind, soleId) {
  const badge = document.createElement('div');
  badge.style.cssText = [
    'position:fixed', 'opacity:0', 'pointer-events:none', 'transition:opacity 120ms ease',
    'background:rgba(15,23,42,0.94)', 'color:#fff', 'padding:4px 8px', 'border-radius:6px',
    'font:600 11px/1.4 -apple-system,system-ui,sans-serif', 'box-shadow:0 2px 8px rgba(0,0,0,0.3)',
    'z-index:2147483646', 'display:flex', 'flex-direction:column', 'align-items:flex-start', 'gap:3px',
    'white-space:nowrap', 'max-width:220px'
  ].join(';');

  const posRow = badgeRow();
  const posColor = kind === 'organic' ? SERP_COLORS.organic : SERP_COLORS.ad;
  const posSpan = document.createElement('span');
  posSpan.textContent = serpBadgeLabel(entry, kind);
  posSpan.style.cssText = `color:${posColor === SERP_COLORS.organic ? '#cbd5e1' : '#fcd34d'}`;
  posRow.appendChild(posSpan);

  const accent = serpBadgeAccent(entry);
  if (accent) {
    const dot = document.createElement('span');
    dot.style.cssText = `width:7px;height:7px;border-radius:50%;background:${accent.color};flex:none;pointer-events:auto`;
    dot.title = accent.detail;
    dot.setAttribute('aria-label', accent.detail);
    posRow.appendChild(dot);
  }
  badge.appendChild(posRow);

  if (!accent && entry.domain && soleId) {
    const chipRow = badgeRow();
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.textContent = '+ Competitor';
    chip.style.cssText = [
      `background:${SERP_COLORS.competitor}`, 'color:#fff', 'border:none', 'border-radius:4px',
      'padding:2px 6px', 'font:600 10px/1.4 -apple-system,system-ui,sans-serif', 'cursor:pointer', 'pointer-events:auto'
    ].join(';');
    chip.addEventListener('click', (e) => addCompetitorFromChip(e, chip, entry.domain, soleId));
    chipRow.appendChild(chip);
    badge.appendChild(chipRow);
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
    const dot = document.createElement('span');
    dot.style.cssText = `width:7px;height:7px;border-radius:50%;background:${SERP_COLORS.competitor};flex:none`;
    dot.title = `Competitor · ${client.name}`;
    dot.setAttribute('aria-label', `Competitor · ${client.name}`);
    chip.replaceWith(dot);
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
    enrichOwnResults(container, matched);
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
    // Hovering only the anchor left most of the visible card dead to the
    // badge — the description text sits outside the anchor entirely, a
    // sibling rather than nested inside it. hoverEl is the true result card
    // (organic: the common ancestor of the title and its snippet; ads: the
    // ad unit adUnitFor() already establishes) — everything visible in that
    // card reveals the badge, not just the title/URL line. Positioning still
    // reads from e.el (unchanged; the anchor's own top edge is a fine anchor
    // point for the badge regardless of the wider hover zone).
    const hoverEl = kind === 'organic' ? resultCardEl(e.el) : (adUnitFor(e.el) || e.el);
    // The badge sits physically apart from the result (to its left, with a
    // gap), not overlapping it, so hovering only the result and hiding the
    // instant the cursor leaves it means the badge disappears mid-transit,
    // before a click on "+Competitor" can land. Both the result AND the
    // badge itself keep it shown; a short grace delay on hide covers the gap
    // between them, so crossing it doesn't flicker the badge away.
    let hideTimer = null;
    const show = () => { clearTimeout(hideTimer); badge.style.opacity = '1'; badge.style.pointerEvents = 'auto'; };
    const hide = () => { hideTimer = setTimeout(() => { badge.style.opacity = '0'; badge.style.pointerEvents = 'none'; }, 150); };
    hoverEl.addEventListener('mouseenter', show);
    hoverEl.addEventListener('mouseleave', hide);
    badge.addEventListener('mouseenter', show);
    badge.addEventListener('mouseleave', hide);
    pairs.push({ el: e.el, hoverEl, badge, show, hide });
  });
  container._hoverPairs = pairs;

  function updatePositions() {
    pairs.forEach(({ el, badge }) => {
      const r = el.getBoundingClientRect();
      const offscreen = r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth;
      if (offscreen) { badge.style.display = 'none'; return; }
      badge.style.display = 'flex';
      // Always to the left of the result, never above it (sitting above
      // collided with the previous/next result's own title row), and never a
      // different layout for a wider badge (a client's own result, carrying
      // extra WebCEO enrichment content, is wider than a plain competitor
      // chip) — every badge behaves identically. offsetWidth reads real
      // layout even at opacity:0 (only paint is suppressed). Clamped to
      // never go off-screen left; a badge wider than the available margin
      // may edge under the result rather than relocate, which reads better
      // than jumping to an inconsistent position.
      const bw = badge.offsetWidth || 140;
      badge.style.left = `${Math.max(4, r.left - bw - 8)}px`;
      badge.style.top = `${Math.max(4, r.top)}px`;
    });
  }
  updatePositions();
  container._update = () => requestAnimationFrame(updatePositions);
  window.addEventListener('scroll', container._update, { passive: true });
  window.addEventListener('resize', container._update, { passive: true });
}

// ─── WebCEO enrichment (position-change + title/meta diff) ───────────────────
// Fires automatically for the client's own result(s) only — unlike ad copy
// capture (deliberately on-demand, since that's a competitor's content), this
// reads the client's OWN site, squarely within the tool's normal scope.
// Patches the already-rendered badge in place rather than re-rendering, so it
// arrives as a small addition once the lookups resolve, never a flicker.
//
// Gated on a WebCEO tracked-keyword match for the on-screen query — there is
// no other reliable source of the result's real destination URL (see the
// parser's resultDomain() comment: every real href is Google's own
// click-tracking redirect). No match, no WebCEO, or a fetch failure all mean
// the same thing here: stay silent, leave the plain Phase 1 badge as-is.

function enrichOwnResults(container, matched) {
  const query = serpQuery();
  if (!query) return;
  matched.organic
    .filter(e => e.role === 'own' && e.domain)
    .forEach(entry => enrichOneOwnResult(container, entry, query));
}

async function enrichOneOwnResult(container, entry, query) {
  let rankings;
  try {
    rankings = await browser.runtime.sendMessage({ action: 'webceoGetRankings', pageUrl: `https://${entry.domain}/` });
  } catch { return; }
  if (!rankings || !rankings.connected || rankings.error || !Array.isArray(rankings.rows)) return;
  const row = rankings.rows.find(r => (r.keyword || '').trim().toLowerCase() === query.trim().toLowerCase());
  if (!row) return;

  const badge = findLiveBadge(container, entry);
  if (!badge) return;   // toggled off, or this entry's badge no longer exists

  if (row.position != null && row.previous != null) {
    const delta = row.previous - row.position;   // positive = improved (moved to a lower/better position number)
    if (delta) appendDeltaToBadge(badge, delta);
  }

  if (!row.url) return;
  let dest;
  try { dest = new URL(row.url); } catch { return; }
  // WebCEO's last scan can be stale — if its ranked URL isn't even on the
  // domain the live page just showed, comparing against it would be
  // comparing against the wrong page entirely. Skip rather than mislead.
  if (normalizeDomainSerp(dest.hostname) !== entry.domain) return;

  let meta;
  try { meta = await browser.runtime.sendMessage({ action: 'fetchPageMeta', url: row.url }); } catch { return; }
  if (!meta || !meta.ok) return;

  const liveBadge = findLiveBadge(container, entry);
  if (!liveBadge) return;

  const displayedTitle = entry.el.querySelector('h3')?.textContent || '';
  const displayedSnippet = resultSnippetText(entry.el) || '';
  const mismatches = [];
  if (titlesDiffer(displayedTitle, meta.title)) mismatches.push({ kind: 'Title', shown: displayedTitle, real: meta.title });
  if (descriptionsDiffer(displayedSnippet, meta.description)) mismatches.push({ kind: 'Description', shown: displayedSnippet, real: meta.description });
  if (mismatches.length) appendMismatchFlagToBadge(liveBadge, mismatches);
}

function findLiveBadge(container, entry) {
  const live = document.getElementById(SERP_CONTAINER_ID);
  if (!live || live !== container) return null;
  const pair = (container._hoverPairs || []).find(p => p.el === entry.el);
  return pair ? pair.badge : null;
}

// Both land on the position row (delta) or their own new row (the mismatch
// flag) — badge's children are rows now (see badgeRow()), not flat spans, so
// this has to reach into the first row rather than badge itself.
function appendDeltaToBadge(badge, delta) {
  const span = document.createElement('span');
  span.textContent = delta > 0 ? `▲${delta}` : `▼${Math.abs(delta)}`;
  span.style.cssText = `color:${delta > 0 ? '#4ade80' : '#f87171'};font-weight:700`;
  const posRow = badge.firstChild;
  posRow.insertBefore(span, posRow.firstChild.nextSibling);
}

// A kind label per block only when there's more than one (Title AND
// Description both differing) — with just one, the visible flag text
// ("Description differs") already says which, so repeating it would be
// redundant clutter in the tooltip.
function mismatchDetail(m, labelKind) {
  return `${labelKind ? `${m.kind}\n` : ''}Displayed:\n"${m.shown}"\n\nOn page:\n"${m.real}"`;
}

function appendMismatchFlagToBadge(badge, mismatches) {
  const row = badgeRow();
  const flag = document.createElement('span');
  flag.textContent = `${mismatches.map(m => m.kind).join('/')} differs`;
  flag.title = mismatches.map(m => mismatchDetail(m, mismatches.length > 1)).join('\n\n\n');
  // Underline-dotted alone is the hover affordance — cursor:help renders a
  // large OS-level "?" cursor on top of it, which read as heavier than
  // intended for a small inline flag.
  flag.style.cssText = 'color:#fcd34d;text-decoration:underline dotted;pointer-events:auto';
  row.appendChild(flag);
  badge.appendChild(row);
}
// ─── WebCEO enrichment: end ───────────────────────────────────────────────────

function removeSerpOverlay() {
  const container = document.getElementById(SERP_CONTAINER_ID);
  if (container) {
    if (container._update) {
      window.removeEventListener('scroll', container._update);
      window.removeEventListener('resize', container._update);
    }
    (container._hoverPairs || []).forEach(({ hoverEl, badge, show, hide }) => {
      hoverEl.removeEventListener('mouseenter', show);
      hoverEl.removeEventListener('mouseleave', hide);
      badge.removeEventListener('mouseenter', show);
      badge.removeEventListener('mouseleave', hide);
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
// rounded, box-shadow), placed bottom-left rather than linkIndicator's
// bottom-right, out of the way of Google's own UI chrome. Unlike
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
      // 40px, not 12 — most browsers show their own bottom-left link-preview
      // status bar over a hovered link, which would otherwise cover this.
      'position:fixed', 'bottom:40px', 'left:12px', 'z-index:2147483647',
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

// ─── Keyboard shortcut: Option/Alt + O ───────────────────────────────────────
// content.js has its own Alt+F/I/L listener, but this is a separate content
// script (a different isolated world) and can't reuse it. Matches e.code —
// the physical key — since macOS rewrites Option+O's e.key to "ø". Skipped
// while an editable element has focus, most importantly Google's own search
// box, so that glyph can still be typed there. No IS_TOP_FRAME guard needed
// the way content.js's listener needs one — this script only ever loads in
// the top frame (manifest.base.json: all_frames:false).
function serpEditableHasFocus() {
  const el = document.activeElement;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

window.addEventListener('keydown', (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat) return;
  if (e.code !== 'KeyO') return;
  if (serpEditableHasFocus()) return;
  e.preventDefault();
  toggleSerpOverlayState();
}, true);   // capture, so the page can't swallow it first

}
