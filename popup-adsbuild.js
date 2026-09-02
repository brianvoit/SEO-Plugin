// "Build an ad group for this page" — the Ads tab's answer to a page nothing
// currently advertises.
//
// Until now that page hit two dead ends at once: the Ads tab had nothing to
// render, and Add Keywords (popup-addkw.js) degraded to research-only because
// it had no ad group to write into. This panel supplies the missing structure —
// pick an existing Search campaign, name an ad group, take the ad copy the
// generator already produces, choose keywords, and write all three atomically.
//
// Creating a CAMPAIGN is deliberately out of scope: budget, bidding strategy,
// geo and schedule are a far larger surface and a far larger blast radius.
// See adsCreateAdGroup in bg-ads.js for the write itself.

let _abLoading = false;
let _abCampaigns = null;      // { eligible: [...], excluded: [...] }
let _abCampaignId = null;
let _abAdGroupName = '';
let _abCopy = null;           // { headlines: [...], descriptions: [...] }
let _abKeywords = [];         // [{ text, matchType, volume, competition, include, targetedIn }]
let _abFinalUrl = null;
let _abHost = null;           // host the current state was built for
let _abResult = null;         // after a successful create
let _abPageUrl = null;        // the page this panel is building for
let _abPageInfo = null;       // its parsed content, for naming (may be null)
let _abKwFilter = '';         // regex filter over the keyword list
let _abKwFilterExclude = false;
let _abTargeted = null;       // term -> where it is already targeted

// A new ad group wants a tight, coherent set — not everything the page
// mentions. Google's own guidance is 5–20 keywords per ad group; more than
// that and the ad copy can no longer speak to all of them.
const AB_MIN_KEYWORDS = 5;
const AB_MAX_KEYWORDS = 15;
const AB_CANDIDATE_CAP = 60;   // how many go to the relevance pass

function abBody() { return document.getElementById('adsbuild-body'); }

function abMessage(text, isError) {
  const body = abBody();
  body.innerHTML = '';
  const p = document.createElement('div');
  p.className = isError ? 'field-hint is-error' : 'field-hint';
  p.textContent = text;
  body.appendChild(p);
}

function abSection(label) {
  const section = document.createElement('section');
  section.className = 'field-section';
  const header = document.createElement('div');
  header.className = 'field-header';
  const span = document.createElement('span');
  span.className = 'field-label';
  span.textContent = label;
  header.appendChild(span);
  section.appendChild(header);
  return section;
}

function abHint(text) {
  const d = document.createElement('div');
  d.className = 'field-hint';
  d.textContent = text;
  return d;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

// The Ads tab is reachable without the Overview tab ever having run, and
// `pageData` is populated only by the Overview's page read — so this panel
// cannot depend on it. The URL is resolved the way the rest of popup-ads.js
// does (canonical when known, otherwise the active tab), and the page's own
// text is fetched on demand purely to suggest an ad group name.
async function abResolvePage() {
  const tab = await getActiveTab().catch(() => null);
  const url = (pageData && pageData.canonical)
    || (pageData && pageData.url)
    || (tab && tab.url)
    || null;
  let info = (pageData && pageData.url) ? pageData : null;
  if (!info && tab) {
    info = await getPageDataFromTab(tab.id).catch(() => null);
    // Fill the shared global if the Overview tab has not run. It is the same
    // object render() assigns, so this is a fill-in rather than an override —
    // and generateAdCopy, which this panel reuses, refuses to run without it.
    if (info && !pageData) pageData = info;
  }
  return { url, info };
}

async function openAdsBuildPanel() {
  if (_abLoading) { abMessage('Loading…'); return; }
  abMessage('Loading…');

  const { url, info } = await abResolvePage();
  if (!url || !/^https?:\/\//i.test(url)) {
    abMessage('Open this on a regular web page to build an ad group.', true);
    return;
  }

  let host = null;
  try { host = new URL(url).hostname; } catch { /* leave null */ }

  // The campaign list and the account's existing keywords both go stale
  // quickly, so state is rebuilt whenever the page changes rather than cached.
  if (host !== _abHost) {
    _abHost = host;
    _abCampaigns = null; _abCampaignId = null; _abAdGroupName = '';
    _abCopy = null; _abKeywords = []; _abResult = null;
  }
  _abPageUrl = url;
  _abPageInfo = info;

  if (_abResult) { renderAdsBuildResult(); return; }
  if (_abCampaigns) { renderAdsBuild(); return; }
  loadAdsBuild();
}

// The ad must point where the page actually resolves. Sending traffic to a URL
// that redirects splits tracking and hurts the landing-page experience score,
// and the redirect trace already knows the resolved destination — so prefer it
// over the address bar.
async function abResolveFinalUrl(pageUrl) {
  try {
    const tab = await getActiveTab();
    if (!tab) return { url: pageUrl, redirected: false };
    // getRedirectInfo resolves to the entry itself, not a wrapper.
    const entry = await sendMessageWithTimeout({ action: 'getRedirectInfo', tabId: tab.id });
    const finalUrl = entry && entry.done && entry.finalUrl ? entry.finalUrl : null;
    if (!finalUrl) return { url: pageUrl, redirected: false };
    const hops = (entry.chain || []).length;
    return {
      url: finalUrl,
      redirected: hops > 1 && adsNormUrlSafe(finalUrl) !== adsNormUrlSafe(pageUrl),
      status: entry.finalStatus || null
    };
  } catch {
    return { url: pageUrl, redirected: false };
  }
}

function adsNormUrlSafe(u) {
  try { const x = new URL(u); return (x.origin + x.pathname).replace(/\/$/, ''); }
  catch { return String(u || ''); }
}

async function loadAdsBuild() {
  if (!_abPageUrl) { abMessage('Open this on a regular web page to build an ad group.', true); return; }
  _abLoading = true;
  abMessage('Loading campaigns…');

  try {
    const res = await sendMessageWithTimeout({ action: 'adsListCampaignsForBuild', pageUrl: _abPageUrl });
    if (!res || res.connected === false) {
      abMessage(res && res.reauthRequired
        ? 'Google Ads needs reconnecting — open Setup (⚙) and reconnect.'
        : 'Connect Google Ads in Setup (⚙) to build an ad group.', true);
      return;
    }
    if (res.error) { abMessage(adsErrorMessage(res.error, res.detail), true); return; }

    _abCampaigns = { eligible: res.eligible || [], excluded: res.excluded || [] };
    if (_abCampaigns.eligible.length === 1) _abCampaignId = _abCampaigns.eligible[0].campaignId;

    const resolved = await abResolveFinalUrl(_abPageUrl);
    _abFinalUrl = resolved.url;
    _abRedirected = resolved.redirected;
    _abFinalStatus = resolved.status;

    if (!_abAdGroupName) _abAdGroupName = await abSuggestName();
    renderAdsBuild();
  } catch (e) {
    abMessage(String((e && e.message) || e), true);
  } finally {
    _abLoading = false;
  }
}

// Name the ad group after the page, and disambiguate if that name is already
// taken in this campaign — Google rejects a duplicate ad group name outright,
// which is a miserable error to hit after generating copy and picking keywords.
async function abSuggestName() {
  const base = abPageLabel();
  if (!_abCampaignId) return base;
  try {
    const res = await sendMessageWithTimeout({
      action: 'adsGetCampaignAdGroupNames', pageUrl: _abPageUrl, campaignId: _abCampaignId
    });
    const taken = new Set(((res && res.names) || []).map(n => String(n).toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let i = 2; i < 50; i++) {
      const candidate = `${base} ${i}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return base;
  } catch { return base; }
}

// A human label for the page: H1, then title, then the last path segment.
// _abPageInfo is best-effort — a page the content script cannot read still
// gets a usable name from its URL.
function abPageLabel() {
  const info = _abPageInfo || {};
  const asText = (v) => (!v ? '' : (typeof v === 'string' ? v : (typeof v.text === 'string' ? v.text : '')));

  const h1 = ((info.headings || []).find(h => (h.tag || (h.level != null ? `h${h.level}` : '')) === 'h1'));
  const h1Text = asText(h1);
  if (h1Text) return h1Text.trim().slice(0, 60);

  const title = asText(info.title);
  if (title) return title.split(/[|\-—]/)[0].trim().slice(0, 60);

  try {
    const seg = new URL(_abPageUrl).pathname.split('/').filter(Boolean).pop();
    if (seg) return seg.replace(/[-_]+/g, ' ').replace(/\.\w+$/, '').trim().slice(0, 60);
  } catch { /* fall through */ }
  return 'New ad group';
}

let _abRedirected = false;
let _abFinalStatus = null;

// ─── Render ──────────────────────────────────────────────────────────────────

function renderAdsBuild() {
  const body = abBody();
  body.innerHTML = '';

  body.appendChild(abLandingSection());
  body.appendChild(abCampaignSection());

  if (!_abCampaignId) return;   // everything below depends on the campaign

  body.appendChild(abNameSection());
  // Keywords first: the ad copy is written to match the terms being targeted,
  // so choosing them second would mean generating against nothing.
  body.appendChild(abKeywordSection());
  body.appendChild(abCopySection());
  body.appendChild(abCommitSection());
}

// The landing page is the one thing this panel knows better than the Ads UI
// does, so it leads — a redirecting or erroring destination is worth seeing
// before any copy gets written for it.
function abLandingSection() {
  const s = abSection('LANDING PAGE');
  const url = document.createElement('div');
  url.className = 'field-hint';
  url.style.wordBreak = 'break-all';
  url.textContent = _abFinalUrl || '';
  s.appendChild(url);

  if (_abRedirected) {
    const warn = abHint('This page redirects. The ad will point at the resolved URL above so clicks do not pass through a redirect.');
    warn.classList.add('is-warn');
    s.appendChild(warn);
  }
  if (_abFinalStatus && Number(_abFinalStatus) >= 400) {
    const err = abHint(`This page returns ${_abFinalStatus}. Google will disapprove an ad pointing at it.`);
    err.classList.add('is-error');
    s.appendChild(err);
  }
  return s;
}

function abCampaignSection() {
  const s = abSection('CAMPAIGN');
  // Paused campaigns are hidden: an ad group built into one cannot serve until
  // the campaign itself is enabled, which is a trap rather than a choice.
  const eligible = _abCampaigns.eligible.filter(c => c.status !== 'PAUSED');
  const pausedCount = _abCampaigns.eligible.length - eligible.length;

  if (!eligible.length) {
    if (pausedCount && !_abCampaigns.excluded.length) {
      const paused = abHint(`The only Search campaign${pausedCount === 1 ? '' : 's'} in this account ${pausedCount === 1 ? 'is' : 'are'} paused. Enable one in Google Ads to build an ad group inside it.`);
      paused.classList.add('is-error');
      s.appendChild(paused);
      return s;
    }
    const msg = abHint(_abCampaigns.excluded.length
      ? `No Search campaigns in this account. An ad group with keywords can only live in a Search campaign — the ${_abCampaigns.excluded.length} campaign${_abCampaigns.excluded.length === 1 ? '' : 's'} here ${_abCampaigns.excluded.length === 1 ? 'is' : 'are'} ${[...new Set(_abCampaigns.excluded.map(c => c.channelLabel))].join(', ')}. Create a Search campaign in Google Ads first.`
      : 'No enabled or paused campaigns in this account.');
    msg.classList.add('is-error');
    s.appendChild(msg);
    return s;
  }

  const select = document.createElement('select');
  select.className = 'wp-input';
  select.id = 'adsbuild-campaign';
  const blank = document.createElement('option');
  blank.value = ''; blank.textContent = 'Choose a campaign…';
  select.appendChild(blank);
  eligible.forEach(c => {
    const o = document.createElement('option');
    o.value = c.campaignId;
    // Name first, budget last: the name is what is being chosen, and putting
    // the figure at the end keeps the names aligned and scannable.
    const budget = c.budgetMicros != null ? ` — ${abMoney(c.budgetMicros)}/day` : '';
    o.textContent = `${c.campaignName}${budget}`;
    if (c.campaignId === _abCampaignId) o.selected = true;
    select.appendChild(o);
  });
  select.addEventListener('change', async () => {
    _abCampaignId = select.value || null;
    _abAdGroupName = await abSuggestName();
    renderAdsBuild();
  });
  s.appendChild(select);

  if (_abCampaigns.excluded.length) {
    s.appendChild(abHint(`${_abCampaigns.excluded.length} campaign${_abCampaigns.excluded.length === 1 ? '' : 's'} hidden — ${[...new Set(_abCampaigns.excluded.map(c => c.channelLabel))].join(', ')} cannot hold keyword-targeted ad groups.`));
  }
  return s;
}

function abMoney(micros) {
  const n = Number(micros) / 1e6;
  return Number.isFinite(n) ? `$${n.toFixed(n < 10 ? 2 : 0)}` : '';
}

function abNameSection() {
  const s = abSection('AD GROUP NAME');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'wp-input';
  input.value = _abAdGroupName;
  input.addEventListener('input', () => { _abAdGroupName = input.value; abSyncCommit(); });
  s.appendChild(input);
  return s;
}

// ─── Ad copy ─────────────────────────────────────────────────────────────────
// Reuses the existing generator rather than a second prompt: it is already
// grounded in the page's intent and sentiment, its tracked keywords and its
// organic queries, and it already enforces Google's character limits.

function abCopySection() {
  const s = abSection('AD COPY');
  if (!_abCopy) {
    // Both of these are kept in sync by abSyncCopyGate as keywords are ticked.
    // Rendering them once left the button permanently disabled: the section is
    // built while nothing is selected, and selecting a keyword re-rendered only
    // the keyword list.
    const hint = abHint('');
    hint.id = 'adsbuild-copy-hint';
    s.appendChild(hint);

    const btn = document.createElement('button');
    btn.className = 'save-key-btn';
    btn.id = 'adsbuild-copy-btn';
    btn.textContent = 'Generate ad copy';
    btn.addEventListener('click', () => abGenerateCopy(btn));
    s.appendChild(btn);

    abSyncCopyGate(hint, btn);
    return s;
  }

  s.appendChild(abAssetList('Headlines', 'headlines', 30));
  s.appendChild(abAssetList('Descriptions', 'descriptions', 90));
  return s;
}

/**
 * Editable asset rows.
 *
 * Every line is a text input rather than static text: the generator gets the
 * wording close, but the person shipping the ad is the one who knows the
 * brand's voice. The count updates on each keystroke and turns red past the
 * limit, so an over-length edit is visible immediately instead of surfacing as
 * an API rejection at create time.
 */
function abAssetList(label, key, max) {
  const wrap = document.createElement('div');
  const items = _abCopy[key] || [];
  const singular = label.replace(/s$/, '');

  // One header per table — the count lives in it rather than on a separate
  // line above, which read as a competing heading at a different size.
  const cols = document.createElement('div');
  cols.className = 'adsbuild-asset-row adsbuild-head';
  [['adsbuild-asset-input', `${singular} (${items.length})`],
   ['adsbuild-count', `Chars/${max}`],
   ['adsbuild-col-intent', 'Intent'],
   ['adsbuild-col-sentiment', 'Sentiment'],
   ['adsbuild-col-regen', '']].forEach(([cls, text]) => {
    const c = document.createElement('span');
    c.className = `adsbuild-col ${cls}`;
    c.textContent = text;
    cols.appendChild(c);
  });
  wrap.appendChild(cols);

  items.forEach((text, i) => wrap.appendChild(abAssetRow(key, i, text, max)));
  return wrap;
}

function abAssetRow(key, i, text, max) {
  const row = document.createElement('div');
  row.className = 'adsbuild-asset-row';
  row.dataset.assetText = text;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'wp-input adsbuild-col adsbuild-asset-input';
  input.value = text;

  // Bare number — the limit is stated once in the header.
  const count = document.createElement('span');
  count.className = 'adsbuild-col adsbuild-count';

  const paintCount = () => {
    count.textContent = String(input.value.length);
    count.classList.toggle('is-over', input.value.length > max);
  };
  paintCount();

  input.addEventListener('input', () => {
    _abCopy[key][i] = input.value;
    paintCount();
    abSyncCommit();
  });
  // Classification costs an API call, so it waits for the edit to settle
  // rather than firing on every keystroke.
  input.addEventListener('change', () => {
    row.dataset.assetText = input.value;
    abClassify([input.value], () => abPaintChips(row, input.value));
  });

  const regen = document.createElement('button');
  regen.className = 'gen-result-btn adsbuild-col adsbuild-col-regen';
  regen.title = 'Rewrite this line';
  regen.appendChild(svgFromString(
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M13.5 8A5.5 5.5 0 1 1 8 2.5a5.5 5.5 0 0 1 3.9 1.6L13.5 5.6"/>' +
    '<polyline points="13.5 2 13.5 5.6 9.9 5.6"/></svg>'));
  regen.addEventListener('click', () => abRegenerateLine(key, i, input, paintCount, row, regen, max));

  row.appendChild(input);
  row.appendChild(count);
  row.appendChild(abChipCell('intent'));
  row.appendChild(abChipCell('sentiment'));
  row.appendChild(regen);
  abPaintChips(row, text);
  return row;
}

/**
 * Rewrite one headline or description.
 *
 * Reuses the Ad Copy panel's line prompt and its sanitising and hard-trim
 * helpers, but drives this row and this panel's own copy store —
 * regenerateAdCopyLine writes "25/30" into the count element and updates the
 * shared _adCopy, neither of which fits here.
 */
async function abRegenerateLine(key, index, input, paintCount, row, btn, max) {
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add('is-busy');
  try {
    const { claudeApiKey } = await browser.storage.local.get('claudeApiKey');
    if (!claudeApiKey) throw new Error('No Claude API key');

    const asset = (typeof ADS_GEN_ASSETS !== 'undefined')
      ? ADS_GEN_ASSETS.find(a => a.key === key) : null;
    if (!asset) throw new Error('unknown asset type');

    // The other lines in this table, so the rewrite does not repeat one.
    const existing = (_abCopy[key] || []).filter((t, i) => i !== index && t && t.trim());

    const system = buildAdLineSystem(asset, _adCopyInsights, _adCopyBrandTerms, existing);
    const data = await claudeFetch({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeApiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: MODEL_MID,
        max_tokens: 120,
        thinking: { type: 'disabled' },
        system,
        messages: [{ role: 'user', content: _adCopyContext || 'No additional context available.' }]
      })
    });

    let out = sanitizeAdText(claudeText(data).trim().replace(/^["']|["']$/g, ''));
    if (!out) throw new Error('empty');
    if (out.length > max) out = adcopyHardTrim(out, max);

    input.value = out;
    _abCopy[key][index] = out;
    row.dataset.assetText = out;
    paintCount();
    abSyncCommit();
    abClassify([out], () => abPaintChips(row, out));
  } catch {
    btn.title = 'Rewrite failed — try again';
    setTimeout(() => { btn.title = 'Rewrite this line'; }, 2500);
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-busy');
  }
}

// Intent and sentiment for one phrase, from the shared classifier cache that
// the Ad Copy panel already populates. Absent until classification resolves.
function abInsightsFor(text) {
  return (typeof _adAssetInsights !== 'undefined')
    ? _adAssetInsights[String(text || '').toLowerCase()] : null;
}

// One chip in its own cell. buildInsightChips emits intent and sentiment
// together in a single span, which cannot line up as two columns.
function abChipCell(kind) {
  const cell = document.createElement('span');
  cell.className = `adsbuild-col adsbuild-col-${kind}`;
  cell.dataset.kind = kind;
  return cell;
}

function abPaintChipCell(cell, text) {
  if (!cell) return;
  const ins = abInsightsFor(text);
  const value = ins ? ins[cell.dataset.kind] : null;
  cell.replaceChildren();
  if (!value) return;
  const cls = (typeof INSIGHT_CHIP_CLASS !== 'undefined' && INSIGHT_CHIP_CLASS[value]) || 'neutral';
  const chip = document.createElement('span');
  chip.className = `og-insight-chip og-insight-chip--${cls}`;
  chip.textContent = value;
  chip.title = value;
  cell.appendChild(chip);
}

// Repaint both chip columns of a row.
function abPaintChips(row, text) {
  if (!row) return;
  row.querySelectorAll('.adsbuild-col-intent, .adsbuild-col-sentiment')
    .forEach(cell => abPaintChipCell(cell, text));
}

// Classify a batch, then repaint. Everything is cached by text in
// _adAssetInsights, so re-running over already-known lines costs nothing.
function abClassify(texts, onReady) {
  if (typeof ensureAdAssetInsights !== 'function') return;
  ensureAdAssetInsights(texts, onReady);
}

async function abGenerateCopy(btn) {
  btn.disabled = true;
  btn.textContent = 'Generating…';
  try {
    const chosen = _abKeywords.filter(k => k.include);
    // The hint above promises the copy is written to match these, so they have
    // to actually reach the model — buildAdCopyGrounding only knows about
    // tracked keywords and organic queries, not this ad group's selection.
    const extra = chosen.length
      ? `This ad group targets these keywords. Work the important ones into the headlines naturally, without forcing every one in:\n${chosen.map(k => `- ${k.text}`).join('\n')}`
      : '';
    // generateAdCopy populates the shared _adCopy used by the Ad Copy panel.
    await generateAdCopy(true, extra);
    const copy = typeof _adCopy !== 'undefined' ? _adCopy : null;
    if (!copy) throw new Error('Ad copy generation returned nothing.');
    _abCopy = {
      headlines: (copy.headlines || []).slice(0, 15),
      descriptions: (copy.descriptions || []).slice(0, 4)
    };
    renderAdsBuild();
    abClassify([..._abCopy.headlines, ..._abCopy.descriptions], () => {
      document.querySelectorAll('.adsbuild-asset-row:not(.adsbuild-head)').forEach(row => {
        abPaintChips(row, row.dataset.assetText);
      });
    });
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Generate ad copy';
    const msg = abHint(String((e && e.message) || e));
    msg.classList.add('is-error');
    btn.parentNode.appendChild(msg);
  }
}

// ─── Keywords ────────────────────────────────────────────────────────────────

function abKeywordSection() {
  const s = abSection('KEYWORDS');
  if (!_abKeywords.length) {
    s.appendChild(abHint('Mined from this page\'s own headings, title and meta description, then cross-checked against its Search Console queries and tracked keywords. Terms already targeted elsewhere in the account are left out.'));
    const btn = document.createElement('button');
    btn.className = 'save-key-btn';
    btn.textContent = 'Find keywords';
    btn.addEventListener('click', () => abLoadKeywords(btn));
    s.appendChild(btn);
    return s;
  }

  s.appendChild(abKeywordFilterBar());
  s.appendChild(abKeywordAddBar());

  const summary = document.createElement('div');
  summary.className = 'field-hint';
  summary.id = 'adsbuild-kw-summary';
  s.appendChild(summary);

  const list = document.createElement('div');
  list.id = 'adsbuild-kw-list';
  s.appendChild(list);

  abRenderKeywordList(list);
  return s;
}

/**
 * Add a keyword by hand.
 *
 * The suggestions are mined and filtered, so they will sometimes miss a term
 * the person actually wants — a new service line, a competitor's phrasing, or
 * something they simply know converts. A manually added keyword goes to the
 * top, arrives already selected (typing it IS the deliberate choice), and is
 * checked against what is already in the list and already in the account.
 */
function abKeywordAddBar() {
  const bar = document.createElement('div');
  bar.className = 'gsc-query-search-bar';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'gsc-query-search-input';
  input.placeholder = 'Add your own keyword';
  input.autocomplete = 'off';
  input.spellcheck = false;

  const note = document.createElement('div');
  note.className = 'field-hint adsbuild-add-note';

  const add = () => {
    const text = input.value.trim().toLowerCase();
    if (!text) return;
    if (_abKeywords.some(k => k.text === text)) {
      note.textContent = `"${text}" is already in the list.`;
      return;
    }
    if (_abTargeted && _abTargeted.has(text)) {
      // Still allowed — the user may want it here deliberately — but say so.
      note.textContent = `Heads up: "${text}" is already targeted in ${_abTargeted.get(text)}.`;
    } else {
      note.textContent = '';
    }
    _abKeywords.unshift({
      text, matchType: 'PHRASE', volume: null, competition: null,
      onPage: false, targetedIn: null, include: true, manual: true
    });
    input.value = '';
    abRenderKeywordList(document.getElementById('adsbuild-kw-list'));
    abSyncCopyGate();
    abSyncCommit();
    // Classify it like any other so its chips match the rest of the list.
    abClassify([text], () => abRenderKeywordList(document.getElementById('adsbuild-kw-list')));
  };

  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });

  const btn = document.createElement('button');
  btn.className = 'gsc-query-search-mode-btn';
  btn.textContent = 'Add';
  btn.addEventListener('click', add);

  bar.appendChild(input);
  bar.appendChild(btn);

  const wrap = document.createElement('div');
  wrap.appendChild(bar);
  wrap.appendChild(note);
  return wrap;
}

/**
 * Regex filter + bulk select, matching the Search Terms and Keywords tables.
 *
 * Nothing starts selected, so the intended flow is: narrow with the filter,
 * then select what survives. "Select all" therefore acts on the FILTERED set,
 * not the whole list — selecting hidden rows would be invisible and dangerous
 * on something that writes to a live account.
 */
function abKeywordFilterBar() {
  const bar = document.createElement('div');
  bar.className = 'gsc-query-search-bar';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'gsc-query-search-input';
  input.placeholder = 'Filter keywords (regex: term|term2)';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.value = _abKwFilter;
  input.addEventListener('input', () => {
    _abKwFilter = input.value;
    abRenderKeywordList(document.getElementById('adsbuild-kw-list'));
  });

  const mode = document.createElement('button');
  mode.className = 'gsc-query-search-mode-btn';
  mode.title = 'Toggle include/exclude';
  mode.textContent = _abKwFilterExclude ? 'Exclude' : 'Match';
  mode.addEventListener('click', () => {
    _abKwFilterExclude = !_abKwFilterExclude;
    mode.textContent = _abKwFilterExclude ? 'Exclude' : 'Match';
    abRenderKeywordList(document.getElementById('adsbuild-kw-list'));
  });

  const all = document.createElement('button');
  all.className = 'gsc-query-search-mode-btn';
  all.textContent = 'Select all';
  all.title = 'Select every keyword currently shown';
  all.addEventListener('click', () => {
    const shown = _abKeywords.filter(abKwVisible);
    // If everything visible is already on, the button clears instead — one
    // control for both directions, since that is what people reach for.
    const turnOn = shown.some(k => !k.include);
    shown.forEach(k => { k.include = turnOn; });
    abRenderKeywordList(document.getElementById('adsbuild-kw-list'));
    abSyncCopyGate();
    abSyncCommit();
  });

  bar.appendChild(input);
  bar.appendChild(mode);
  bar.appendChild(all);
  return bar;
}

// Invalid regex filters nothing, matching the other tables — a half-typed
// pattern should not blank the list.
function abKwVisible(k) {
  if (!_abKwFilter) return true;
  let re;
  try { re = new RegExp(_abKwFilter, 'i'); } catch { return true; }
  const m = re.test(k.text || '');
  return _abKwFilterExclude ? !m : m;
}

function abRenderKeywordList(list) {
  if (!list) return;
  list.replaceChildren();
  const shown = _abKeywords.filter(abKwVisible);
  if (shown.length) list.appendChild(abKeywordHeader());
  shown.forEach(k => list.appendChild(abKeywordRow(k)));
  if (!shown.length) list.appendChild(abHint('No keywords match that filter.'));
  abSyncKeywordSummary();
}

/**
 * One keyword row: match type, include, term, volume, classification.
 *
 * Match type leads because it is the decision being made about each term —
 * a broad head term wants phrase, a specific product name wants exact — and
 * reading it before the term makes the list scannable as a set of choices
 * rather than a wall of text.
 */
function abKeywordRow(k) {
  const row = document.createElement('div');
  row.className = 'adsbuild-kw-row';

  const match = document.createElement('select');
  match.className = `adsbuild-kw-match is-${k.matchType.toLowerCase()}`;
  [['PHRASE', 'Phrase'], ['EXACT', 'Exact'], ['BROAD', 'Broad']].forEach(([v, label]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    if (v === k.matchType) o.selected = true;
    match.appendChild(o);
  });
  match.addEventListener('change', () => {
    k.matchType = match.value;
    match.className = `adsbuild-kw-match is-${k.matchType.toLowerCase()}`;
  });

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'adsbuild-col adsbuild-col-check';
  cb.checked = !!k.include;
  cb.addEventListener('change', () => {
    k.include = cb.checked;
    abSyncKeywordSummary();
    abSyncCopyGate();
    abSyncCommit();
  });

  const text = document.createElement('span');
  text.className = 'adsbuild-col adsbuild-kw-text';
  text.textContent = k.text;
  if (k.onPage) text.title = 'Appears in this page\'s own headings, title or meta description';

  // Bare number — the unit lives in the column header rather than repeating on
  // every row.
  const volume = document.createElement('span');
  volume.className = 'adsbuild-col adsbuild-col-vol';
  volume.textContent = k.volume != null ? k.volume.toLocaleString() : '—';
  if (k.volume == null) volume.title = 'No Keyword Planner figure — not the same as no demand';

  row.appendChild(match);
  row.appendChild(cb);
  row.appendChild(text);
  row.appendChild(volume);
  row.appendChild(abChipCell('intent'));
  row.appendChild(abChipCell('sentiment'));
  abPaintChips(row, k.text);
  return row;
}

// Column headings for the keyword table. The volume unit sits here so the
// rows carry nothing but the figure.
function abKeywordHeader() {
  const row = document.createElement('div');
  row.className = 'adsbuild-kw-row adsbuild-head';
  ['Match', '', 'Keyword', 'Vol/mo', 'Intent', 'Sentiment'].forEach((label, i) => {
    const cell = document.createElement('span');
    cell.className = 'adsbuild-col';
    if (i === 0) cell.classList.add('adsbuild-col-match');
    if (i === 1) cell.classList.add('adsbuild-col-check');
    if (i === 2) cell.classList.add('adsbuild-kw-text');
    if (i === 3) cell.classList.add('adsbuild-col-vol');
    if (i === 4) cell.classList.add('adsbuild-col-intent');
    if (i === 5) cell.classList.add('adsbuild-col-sentiment');
    cell.textContent = label;
    row.appendChild(cell);
  });
  return row;
}

function abSyncCopyGate(hintEl, btnEl) {
  const hint = hintEl || document.getElementById('adsbuild-copy-hint');
  const btn = btnEl || document.getElementById('adsbuild-copy-btn');
  if (!hint && !btn) return;   // copy already generated — nothing to gate
  const chosen = _abKeywords.filter(k => k.include).length;
  if (btn) btn.disabled = !chosen;
  if (hint) {
    hint.textContent = chosen
      ? `15 headlines and 4 descriptions, written from this page's intent and sentiment and the ${chosen} keyword${chosen === 1 ? '' : 's'} selected above.`
      : 'Select some keywords first — the copy is written to match them.';
  }
}

function abSyncKeywordSummary() {
  const el = document.getElementById('adsbuild-kw-summary');
  if (!el) return;
  const chosen = _abKeywords.filter(k => k.include).length;
  const shown = _abKeywords.filter(abKwVisible).length;
  el.textContent = shown === _abKeywords.length
    ? `${chosen} of ${_abKeywords.length} selected.`
    : `${chosen} selected · showing ${shown} of ${_abKeywords.length}.`;
}

async function abLoadKeywords(btn) {
  btn.disabled = true;
  btn.textContent = 'Finding…';
  try {
    const seeds = await abKeywordSeeds();
    if (!seeds.length) throw new Error('No Search Console queries or tracked keywords for this page yet.');

    // Everything already targeted anywhere in the account, so a new ad group
    // never silently competes with an existing one.
    const targeted = new Map();
    try {
      const all = await sendMessageWithTimeout({ action: 'adsGetAllKeywords', pageUrl: _abPageUrl });
      const places = (all && all.placements) || {};
      ((all && all.texts) || []).forEach(t => targeted.set(t, places[t] || 'this account'));
      _abTargeted = targeted;   // kept so a manual add can warn about a clash
    } catch { /* dedupe is best-effort */ }

    let volumes = {};
    try {
      const ideas = await sendMessageWithTimeout({
        action: 'adsGetKeywordIdeas', pageUrl: _abPageUrl,
        keywords: seeds.slice(0, 60).map(s => s.text)   // the API takes plain strings
      });
      volumes = (ideas && ideas.byKeyword) || {};
    } catch { /* volume is enrichment only */ }

    const mined = abRankKeywords(seeds, volumes, targeted, abCoreTerms(_abPageInfo));
    btn.textContent = 'Choosing…';
    _abKeywords = await abRefineKeywords(mined, _abPageInfo);
    renderAdsBuild();
    // Intent and sentiment resolve after the list is on screen — the chips
    // fill in rather than holding up the whole section.
    abClassify(_abKeywords.map(k => k.text), () => {
      document.querySelectorAll('.adsbuild-kw-row:not(.adsbuild-head)').forEach(row => {
        const t = row.querySelector('.adsbuild-kw-text');
        abPaintChips(row, t && t.textContent);
      });
    });
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Find keywords';
    const msg = abHint(String((e && e.message) || e));
    msg.classList.add('is-error');
    btn.parentNode.appendChild(msg);
  }
}

// Words that carry no targeting value on their own. A candidate phrase that
// starts or ends on one of these reads as a fragment ("of tree removal"), so
// those are trimmed rather than offered.
const AB_STOPWORDS = new Set([
  'a','an','the','and','or','but','if','of','to','in','on','for','with','at','by','from',
  'is','are','was','were','be','been','being','it','its','this','that','these','those',
  'we','our','you','your','us','they','their','as','can','will','our','has','have','had',
  'about','into','over','more','most','other','than','then','so','such','no','not','all',
  'your','you','get','how','why','what','when','where','who','which'
]);

/**
 * Candidate keyword phrases mined from the page's own text.
 *
 * The point of this feature is an ad group tightly scoped to ONE page, so the
 * page's own language is the strongest signal available — stronger than
 * account-wide history. Weighting follows how much intent each element
 * carries: an H1 states what the page is, a title is written for search, an H2
 * names a sub-topic, and a meta description is supporting prose.
 *
 * Two- and three-word phrases only. One word is too broad to be worth its own
 * keyword, and four or more matches almost nothing under phrase match.
 */
function abPagePhrases(info) {
  // getPageData returns title and metaDescription as OBJECTS ({text, charCount,
  // wordCount}) and tags headings with `tag: 'h1'` rather than a numeric level.
  // Reading them as plain strings yields "[object Object]" and silently skips
  // every heading — which is exactly what an earlier version of this did.
  const asText = (v) => {
    if (!v) return '';
    if (typeof v === 'string') return v;
    return typeof v.text === 'string' ? v.text : '';
  };
  const HEADING_WEIGHT = { h1: 5, h2: 3, h3: 2 };

  const sources = [
    { text: asText(info && info.title), weight: 4 },
    { text: asText(info && info.metaDescription) || asText(info && info.description), weight: 2 }
  ];
  ((info && info.headings) || []).forEach(h => {
    const text = asText(h);
    if (!text) return;
    // Accept either shape: `tag` is what getPageData emits, `level` is what a
    // caller assembling its own page object might use.
    const tag = h.tag || (h.level != null ? `h${h.level}` : null);
    const weight = HEADING_WEIGHT[tag];
    if (weight) sources.push({ text, weight });
  });

  const scores = new Map();
  for (const { text, weight } of sources) {
    if (!text) continue;
    // Split on punctuation as well as whitespace: a phrase should never run
    // across a comma or a dash into an unrelated clause.
    const clauses = String(text).toLowerCase().split(/[.,;:!?|/()\[\]—–-]+/);
    for (const clause of clauses) {
      const words = clause.split(/\s+/).map(w => w.replace(/[^a-z0-9']/gi, '')).filter(Boolean);
      for (let n = 2; n <= 3; n++) {
        for (let i = 0; i + n <= words.length; i++) {
          const gram = words.slice(i, i + n);
          if (AB_STOPWORDS.has(gram[0]) || AB_STOPWORDS.has(gram[gram.length - 1])) continue;
          if (gram.some(w => w.length < 2)) continue;
          const phrase = gram.join(' ');
          scores.set(phrase, (scores.get(phrase) || 0) + weight);
        }
      }
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .map(([text, pageScore]) => ({ text, pageScore }));
}

// The client's own brand terms, lowercased. A services ad group should not bid
// on the brand name that happens to sit in the page title — brand traffic
// belongs in its own campaign, and including it here quietly competes with it.
async function abBrandTerms() {
  try {
    let host = '';
    try { host = new URL(_abPageUrl).hostname.replace(/^www\./, ''); } catch { return []; }
    const all = (typeof loadBrandedTermsStore === 'function') ? await loadBrandedTermsStore() : null;
    return String((all && all[host]) || '')
      .split('|').map(t => t.trim().toLowerCase()).filter(Boolean);
  } catch { return []; }
}

// Candidates come from the page itself first, then the queries this page
// already earns organically and the keywords the client tracks.
async function abKeywordSeeds() {
  const brand = await abBrandTerms();
  const isBrand = (phrase) => brand.some(b => phrase.includes(b) || b.includes(phrase));
  const fromPage = abPagePhrases(_abPageInfo).filter(p => !isBrand(p.text));
  const pageScores = new Map(fromPage.map(p => [p.text, p.pageScore]));
  const out = new Map(fromPage.map(p => [p.text, p.pageScore]));

  try {
    const gsc = await sendMessageWithTimeout({ action: 'gscGetQueryData', pageUrl: _abPageUrl, range: '3m' });
    ((gsc && gsc.rows) || []).forEach(r => {
      const q = String(r.query || '').toLowerCase().trim();
      if (q) out.set(q, (out.get(q) || 0) + 3);   // real demand, already earned
    });
  } catch { /* optional source */ }

  try {
    const wc = await sendMessageWithTimeout({ action: 'webceoGetTrackedKeywords', pageUrl: _abPageUrl });
    ((wc && wc.keywords) || []).forEach(k => {
      const t = String(k || '').toLowerCase().trim();
      if (t) out.set(t, (out.get(t) || 0) + 3);   // deliberately tracked
    });
  } catch { /* optional source */ }

  return [...out.entries()].map(([text, pageScore]) => ({ text, pageScore, onPage: pageScores.has(text) }));
}

/**
 * The words that state what this page is actually about.
 *
 * Taken from the H1 and title only — those name the product or service, while
 * body headings wander ("Don't just take our word for it"). Used to reject
 * candidates with no subject overlap at all, which is what let fragments like
 * "just take" and "dont just" through.
 */
function abCoreTerms(info) {
  const asText = (v) => (!v ? '' : (typeof v === 'string' ? v : (typeof v.text === 'string' ? v.text : '')));
  const h1 = (((info || {}).headings) || []).find(h => (h.tag || (h.level != null ? `h${h.level}` : '')) === 'h1');
  const text = `${asText(h1)} ${asText((info || {}).title)}`.toLowerCase();
  return new Set(
    text.split(/[^a-z0-9]+/)
      .filter(w => w.length > 2 && !AB_STOPWORDS.has(w))
      // Singular/plural collapse so "services" matches "service".
      .map(w => w.replace(/s$/, ''))
  );
}

// A candidate has to share at least one subject word with the page. This is a
// blunt gate on purpose: it removes obvious noise cheaply, and the relevance
// pass afterwards makes the finer judgements.
function abOnSubject(text, core) {
  if (!core.size) return true;   // no usable H1/title — do not filter blind
  return text.split(/\s+/).some(w => core.has(w.replace(/s$/, '')));
}

/**
 * Order candidates the way a search campaign wants them.
 *
 * Three signals, in order of weight:
 *   pageScore — how prominently the phrase appears in the page's own text.
 *               This is what keeps the ad group scoped to ONE page.
 *   volume    — real demand, when Keyword Planner has a figure.
 *   brevity   — a two-word phrase-match keyword catches the long tail beneath
 *               it; a five-word one matches almost nothing on its own.
 *
 * Terms already targeted elsewhere sink to the bottom and start unchecked, but
 * stay visible: silently dropping them hides the internal competition the user
 * is about to create, and the choice between moving and duplicating is theirs.
 */
function abRankKeywords(seeds, volumes, targeted, core) {
  const subject = core || new Set();
  const onSubject = (t) => (subject.size ? abOnSubject(t, subject) : true);

  const scored = seeds
    // Fragments with no overlap with the page's subject never belong here.
    // Terms sourced from Search Console or a tracked list are exempt: those
    // are real queries for this page, however oddly they read.
    .filter(seed => (typeof seed === 'object' && !seed.onPage) || onSubject(typeof seed === 'string' ? seed : seed.text))
    .map(seed => {
    const text = typeof seed === 'string' ? seed : seed.text;
    const pageScore = (typeof seed === 'object' && seed.pageScore) || 0;
    const onPage = typeof seed === 'object' ? !!seed.onPage : false;
    const v = volumes[text] || {};
    const volume = v.avgMonthlySearches != null ? Number(v.avgMonthlySearches) : null;
    const words = text.trim().split(/\s+/).length;
    const targetedIn = targeted.get(text) || null;
    return {
      text,
      matchType: 'PHRASE',
      volume,
      competition: v.competition || null,
      targetedIn,
      onPage,
      pageScore,
      // Volume is scaled to sit in the same range as pageScore so neither
      // signal can swamp the other; brevity breaks the remaining ties.
      _score: (pageScore * 2) + Math.log10((volume || 0) + 1) * 3 - (words - 2)
    };
  });

  // Terms already targeted elsewhere are REMOVED, not listed. An earlier
  // version showed them greyed out so the user could choose between moving and
  // duplicating, but in practice they were most of the list and drowned the
  // candidates that were actually actionable.
  const available = scored.filter(k => !k.targetedIn);

  available.sort((a, b) => b._score - a._score);

  // Nothing is pre-selected: this writes keywords into a live account, so each
  // one should be a deliberate choice.
  return available.slice(0, AB_CANDIDATE_CAP).map(k => ({ ...k, include: false }));
}

/**
 * Narrow the mined candidates to the ones worth paying for.
 *
 * The deterministic pass is good at finding phrases and bad at judging them:
 * it cannot tell that "removal by tree" is broken word order, that "emergency
 * services" is far too broad for a dead-tree-removal page, or that "twin
 * cities" on its own buys traffic for everything in Minneapolis. This asks for
 * that judgement, and keeps the result to a set one ad's copy can actually
 * speak to.
 *
 * Best effort: with no API key, or on any failure, the deterministic list is
 * used as-is. A keyword list is still useful unrefined.
 */
async function abRefineKeywords(candidates, info) {
  if (candidates.length <= AB_MIN_KEYWORDS) return candidates;
  const { claudeApiKey } = await browser.storage.local.get('claudeApiKey');
  if (!claudeApiKey) return candidates.slice(0, AB_MAX_KEYWORDS);

  const asText = (v) => (!v ? '' : (typeof v === 'string' ? v : (typeof v.text === 'string' ? v.text : '')));
  const h1 = ((info || {}).headings || []).find(h => (h.tag || (h.level != null ? `h${h.level}` : '')) === 'h1');

  const system = [
    'You are a Google Ads strategist choosing keywords for ONE landing page.',
    '',
    `Return between ${AB_MIN_KEYWORDS} and ${AB_MAX_KEYWORDS} keywords, best first, as ONLY a JSON array:`,
    '[{"text":"dead tree removal","matchType":"PHRASE"}, ...]. No prose, no code fences.',
    '',
    'Choose from the candidates given. You may fix word order or pluralisation',
    '("removal by tree" -> "tree removal"), but do not invent a topic the page',
    'does not cover.',
    '',
    'Keep a keyword only if someone searching it wants exactly what this page',
    'sells. Drop:',
    '- sentence fragments and non-noun phrases ("just take", "dont just")',
    '- terms so broad they buy unrelated traffic ("emergency services")',
    '- bare place names with no service word ("twin cities")',
    '- anything describing the company rather than the service',
    '',
    'matchType: PHRASE for most; EXACT for a tight high-intent term where a',
    'variant would be wasteful; BROAD only for a term that is already specific.'
  ].join('\n');

  const content = [
    `Page: ${asText(h1) || asText((info || {}).title) || _abPageUrl}`,
    asText((info || {}).metaDescription) ? `Summary: ${asText((info || {}).metaDescription)}` : '',
    '',
    'Candidates (volume/mo where known):',
    ...candidates.map(k => `- ${k.text}${k.volume != null ? ` (${k.volume}/mo)` : ''}`)
  ].filter(Boolean).join('\n');

  try {
    const data = await claudeFetch({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeApiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: MODEL_MID,
        max_tokens: 700,
        system,
        messages: [{ role: 'user', content }]
      })
    });

    let raw = claudeText(data).trim().replace(/```json/gi, '').replace(/```/g, '').trim();
    const a = raw.indexOf('['), b = raw.lastIndexOf(']');
    if (a !== -1 && b > a) raw = raw.slice(a, b + 1);
    const picked = JSON.parse(raw);
    if (!Array.isArray(picked) || !picked.length) return candidates.slice(0, AB_MAX_KEYWORDS);

    // Carry the mined metadata across where the text still matches, so volume
    // and the on-page flag survive a rewording.
    const byText = new Map(candidates.map(k => [k.text.toLowerCase(), k]));
    const out = [];
    const seen = new Set();
    for (const p of picked) {
      const text = String((p && p.text) || '').toLowerCase().trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      const base = byText.get(text) || {};
      out.push({
        text,
        matchType: ['PHRASE', 'EXACT', 'BROAD'].includes(String(p.matchType || '').toUpperCase())
          ? String(p.matchType).toUpperCase() : 'PHRASE',
        volume: base.volume != null ? base.volume : null,
        competition: base.competition || null,
        onPage: !!base.onPage,
        targetedIn: null,
        include: false
      });
      if (out.length >= AB_MAX_KEYWORDS) break;
    }
    // A refusal or a mangled reply should not leave the user with two
    // keywords when the deterministic list had thirty.
    return out.length >= AB_MIN_KEYWORDS ? out : candidates.slice(0, AB_MAX_KEYWORDS);
  } catch {
    return candidates.slice(0, AB_MAX_KEYWORDS);
  }
}

// ─── Commit ──────────────────────────────────────────────────────────────────

function abCommitSection() {
  const s = abSection('CREATE');
  s.appendChild(abHint('The ad group and ad are created PAUSED. Nothing serves until you enable them in Google Ads.'));

  const actions = document.createElement('div');
  actions.className = 'adsbuild-actions';

  const preview = document.createElement('button');
  preview.className = 'save-key-btn';
  preview.id = 'adsbuild-preview';
  preview.textContent = 'Check with Google';
  preview.addEventListener('click', () => abCommit(true, preview));
  actions.appendChild(preview);

  const create = document.createElement('button');
  create.className = 'save-key-btn';
  create.id = 'adsbuild-create';
  create.textContent = 'Create Ad Group';
  create.addEventListener('click', () => abCommit(false, create));
  actions.appendChild(create);

  s.appendChild(actions);

  const status = document.createElement('div');
  status.className = 'field-hint';
  status.id = 'adsbuild-status';
  s.appendChild(status);
  return s;
}

function abReady() {
  return !!(_abCampaignId && String(_abAdGroupName || '').trim() && _abCopy
    && (_abCopy.headlines || []).length >= 3 && (_abCopy.descriptions || []).length >= 2);
}

function abSyncCommit() {
  const ready = abReady();
  ['adsbuild-preview', 'adsbuild-create'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.disabled = !ready;
  });
}

async function abCommit(validateOnly, btn) {
  if (!abReady()) {
    abSetStatus('Choose a campaign, name the ad group, and generate ad copy first.', true);
    return;
  }
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = validateOnly ? 'Checking…' : 'Creating…';
  abSetStatus('');

  try {
    const res = await sendMessageWithTimeout({
      action: 'adsCreateAdGroup',
      pageUrl: _abPageUrl,
      campaignId: _abCampaignId,
      adGroupName: String(_abAdGroupName).trim(),
      finalUrl: _abFinalUrl,
      headlines: _abCopy.headlines,
      descriptions: _abCopy.descriptions,
      keywords: _abKeywords.filter(k => k.include).map(k => ({ text: k.text, matchType: k.matchType })),
      validateOnly
    }, 60000);

    if (!res || res.connected === false) { abSetStatus('Google Ads is not connected.', true); return; }
    if (res.error) { abSetStatus(adsErrorMessage(res.error, res.detail), true); return; }

    if (validateOnly) {
      abSetStatus(`Google accepted this: ${res.headlines.length} headlines, ${res.descriptions.length} descriptions, ${res.keywords.length} keyword${res.keywords.length === 1 ? '' : 's'}. Nothing was created.`);
      return;
    }
    _abResult = res;
    renderAdsBuildResult();
  } catch (e) {
    abSetStatus(String((e && e.message) || e), true);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
    abSyncCommit();
  }
}

function abSetStatus(text, isError) {
  const el = document.getElementById('adsbuild-status');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('is-error', !!isError);
}

function renderAdsBuildResult() {
  const body = abBody();
  body.innerHTML = '';
  const s = abSection('CREATED');
  s.appendChild(abHint(`"${_abResult.adGroupName}" was created with ${_abResult.headlines.length} headlines, ${_abResult.descriptions.length} descriptions and ${_abResult.keywords.length} keyword${_abResult.keywords.length === 1 ? '' : 's'}.`));
  s.appendChild(abHint('It is PAUSED. Enable it in Google Ads when you are ready for it to serve.'));

  const again = document.createElement('button');
  again.className = 'save-key-btn';
  again.textContent = 'Build another';
  again.addEventListener('click', () => {
    _abResult = null; _abCopy = null; _abKeywords = []; _abAdGroupName = '';
    renderAdsBuild();
  });
  s.appendChild(again);
  body.appendChild(s);
}

// ─── Wiring ──────────────────────────────────────────────────────────────────

document.getElementById('btn-adsbuild-back').addEventListener('click', showActiveTab);
document.getElementById('btn-ads-build').addEventListener('click', () => {
  if (typeof showAdsBuildPanel === 'function') showAdsBuildPanel();
});
