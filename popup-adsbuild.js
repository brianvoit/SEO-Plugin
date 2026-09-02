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

const AB_KEYWORD_CAP = 40;

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

function openAdsBuildPanel() {
  const host = pageData && pageData.url ? new URL(pageData.url).hostname : null;
  // The campaign list and the account's existing keywords both go stale
  // quickly, so state is rebuilt whenever the page changes rather than cached.
  if (host !== _abHost) {
    _abHost = host;
    _abCampaigns = null; _abCampaignId = null; _abAdGroupName = '';
    _abCopy = null; _abKeywords = []; _abResult = null;
  }
  if (_abLoading) { abMessage('Loading…'); return; }
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
  if (!pageData || !pageData.url) { abMessage('Open this on a regular web page to build an ad group.', true); return; }
  _abLoading = true;
  abMessage('Loading campaigns…');

  try {
    const res = await sendMessageWithTimeout({ action: 'adsListCampaignsForBuild', pageUrl: pageData.url });
    if (!res || res.connected === false) {
      abMessage(res && res.reauthRequired
        ? 'Google Ads needs reconnecting — open Setup (⚙) and reconnect.'
        : 'Connect Google Ads in Setup (⚙) to build an ad group.', true);
      return;
    }
    if (res.error) { abMessage(adsErrorMessage(res.error, res.detail), true); return; }

    _abCampaigns = { eligible: res.eligible || [], excluded: res.excluded || [] };
    if (_abCampaigns.eligible.length === 1) _abCampaignId = _abCampaigns.eligible[0].campaignId;

    const resolved = await abResolveFinalUrl(pageData.url);
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
      action: 'adsGetCampaignAdGroupNames', pageUrl: pageData.url, campaignId: _abCampaignId
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
function abPageLabel() {
  const h1 = (pageData.headings || []).find(h => h.level === 1 && h.text && h.text.trim());
  if (h1) return h1.text.trim().slice(0, 60);
  if (pageData.title) return String(pageData.title).split(/[|\-—]/)[0].trim().slice(0, 60);
  try {
    const seg = new URL(pageData.url).pathname.split('/').filter(Boolean).pop();
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
  body.appendChild(abCopySection());
  body.appendChild(abKeywordSection());
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
  const eligible = _abCampaigns.eligible;

  if (!eligible.length) {
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
    const budget = c.budgetMicros != null ? ` — ${abMoney(c.budgetMicros)}/day` : '';
    o.textContent = `${c.campaignName}${c.status === 'PAUSED' ? ' (paused)' : ''}${budget}`;
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
    s.appendChild(abHint('15 headlines and 4 descriptions, written from this page\'s intent and sentiment.'));
    const btn = document.createElement('button');
    btn.className = 'save-key-btn';
    btn.textContent = 'Generate ad copy';
    btn.addEventListener('click', () => abGenerateCopy(btn));
    s.appendChild(btn);
    return s;
  }

  s.appendChild(abAssetList('Headlines', _abCopy.headlines, 30));
  s.appendChild(abAssetList('Descriptions', _abCopy.descriptions, 90));
  const regen = document.createElement('button');
  regen.className = 'save-key-btn';
  regen.textContent = 'Regenerate';
  regen.addEventListener('click', () => { _abCopy = null; renderAdsBuild(); });
  s.appendChild(regen);
  return s;
}

function abAssetList(label, items, max) {
  const wrap = document.createElement('div');
  const h = document.createElement('div');
  h.className = 'field-hint';
  h.textContent = `${label} (${items.length})`;
  wrap.appendChild(h);
  items.forEach(text => {
    const row = document.createElement('div');
    row.className = 'field-hint';
    row.style.display = 'flex';
    row.style.justifyContent = 'space-between';
    row.style.gap = '8px';
    const t = document.createElement('span');
    t.textContent = text;
    const c = document.createElement('span');
    c.textContent = `${text.length}/${max}`;
    if (text.length > max) c.style.color = 'var(--danger, #c00)';
    row.appendChild(t); row.appendChild(c);
    wrap.appendChild(row);
  });
  return wrap;
}

async function abGenerateCopy(btn) {
  btn.disabled = true;
  btn.textContent = 'Generating…';
  try {
    // generateAdCopy populates the shared _adCopy used by the Ad Copy panel.
    await generateAdCopy(true);
    const copy = typeof _adCopy !== 'undefined' ? _adCopy : null;
    if (!copy) throw new Error('Ad copy generation returned nothing.');
    _abCopy = {
      headlines: (copy.headlines || []).slice(0, 15),
      descriptions: (copy.descriptions || []).slice(0, 4)
    };
    renderAdsBuild();
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
    s.appendChild(abHint('Pulled from this page\'s Search Console queries and tracked keywords, with anything already targeted in the account removed.'));
    const btn = document.createElement('button');
    btn.className = 'save-key-btn';
    btn.textContent = 'Find keywords';
    btn.addEventListener('click', () => abLoadKeywords(btn));
    s.appendChild(btn);
    return s;
  }

  const chosen = _abKeywords.filter(k => k.include).length;
  s.appendChild(abHint(`${chosen} of ${_abKeywords.length} selected. Phrase match is the default: short enough to catch long-tail variants, tight enough to stay relevant.`));

  _abKeywords.forEach(k => {
    const row = document.createElement('label');
    row.className = 'field-hint';
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '8px';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!k.include;
    cb.addEventListener('change', () => { k.include = cb.checked; abSyncCommit(); });

    const text = document.createElement('span');
    text.style.flex = '1';
    text.textContent = k.text;

    const meta = document.createElement('span');
    meta.style.opacity = '0.75';
    meta.textContent = k.volume != null ? `${k.volume.toLocaleString()}/mo` : '—';

    row.appendChild(cb); row.appendChild(text); row.appendChild(meta);

    // Adding a term that already lives elsewhere creates internal competition,
    // so say where it is rather than silently dropping it.
    if (k.targetedIn) {
      const warn = document.createElement('span');
      warn.style.opacity = '0.75';
      warn.textContent = `already in ${k.targetedIn}`;
      row.appendChild(warn);
    }
    s.appendChild(row);
  });
  return s;
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
      const all = await sendMessageWithTimeout({ action: 'adsGetAllKeywords', pageUrl: pageData.url });
      const places = (all && all.placements) || {};
      ((all && all.texts) || []).forEach(t => targeted.set(t, places[t] || 'this account'));
    } catch { /* dedupe is best-effort */ }

    let volumes = {};
    try {
      const ideas = await sendMessageWithTimeout({ action: 'adsGetKeywordIdeas', pageUrl: pageData.url, keywords: seeds.slice(0, 60) });
      volumes = (ideas && ideas.byKeyword) || {};
    } catch { /* volume is enrichment only */ }

    _abKeywords = abRankKeywords(seeds, volumes, targeted);
    renderAdsBuild();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Find keywords';
    const msg = abHint(String((e && e.message) || e));
    msg.classList.add('is-error');
    btn.parentNode.appendChild(msg);
  }
}

// GSC queries for this page plus the client's tracked keywords.
async function abKeywordSeeds() {
  const out = new Set();
  try {
    const gsc = await sendMessageWithTimeout({ action: 'gscGetQueryData', pageUrl: pageData.url, range: '3m' });
    ((gsc && gsc.rows) || []).forEach(r => { if (r.query) out.add(String(r.query).toLowerCase()); });
  } catch { /* optional source */ }
  try {
    const wc = await sendMessageWithTimeout({ action: 'webceoGetTrackedKeywords', pageUrl: pageData.url });
    ((wc && wc.keywords) || []).forEach(k => out.add(String(k).toLowerCase()));
  } catch { /* optional source */ }
  return [...out].filter(Boolean);
}

/**
 * Order candidates the way a search campaign wants them.
 *
 * Preference goes to shorter terms with real volume: a two-word phrase-match
 * keyword catches the long-tail variants underneath it, whereas a five-word
 * one matches almost nothing on its own. Terms already targeted elsewhere sink
 * to the bottom and start unchecked, but stay visible so the user can decide
 * between moving and duplicating.
 */
function abRankKeywords(seeds, volumes, targeted) {
  const scored = seeds.map(text => {
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
      // Volume carries the ranking; brevity breaks the tie toward terms broad
      // enough to be worth their own keyword.
      _score: (volume || 0) / Math.max(1, words - 1)
    };
  });

  scored.sort((a, b) => {
    if (!!a.targetedIn !== !!b.targetedIn) return a.targetedIn ? 1 : -1;
    return b._score - a._score;
  });

  return scored.slice(0, AB_KEYWORD_CAP).map(k => ({
    ...k,
    // Default on only for untargeted terms with measurable volume — anything
    // else is a judgement call the user should make deliberately.
    include: !k.targetedIn && (k.volume == null || k.volume > 0)
  }));
}

// ─── Commit ──────────────────────────────────────────────────────────────────

function abCommitSection() {
  const s = abSection('CREATE');
  s.appendChild(abHint('The ad group and ad are created PAUSED. Nothing serves until you enable them in Google Ads.'));

  const preview = document.createElement('button');
  preview.className = 'save-key-btn';
  preview.id = 'adsbuild-preview';
  preview.textContent = 'Check with Google';
  preview.addEventListener('click', () => abCommit(true, preview));
  s.appendChild(preview);

  const create = document.createElement('button');
  create.className = 'save-key-btn';
  create.id = 'adsbuild-create';
  create.textContent = 'Create ad group';
  create.addEventListener('click', () => abCommit(false, create));
  s.appendChild(create);

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
      pageUrl: pageData.url,
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
