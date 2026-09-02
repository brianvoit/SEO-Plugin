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
  if (!info && tab) info = await getPageDataFromTab(tab.id).catch(() => null);
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
  const h1 = (info.headings || []).find(h => h.level === 1 && h.text && h.text.trim());
  if (h1) return h1.text.trim().slice(0, 60);
  if (info.title) return String(info.title).split(/[|\-—]/)[0].trim().slice(0, 60);
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
    const chosen = _abKeywords.filter(k => k.include).length;
    s.appendChild(abHint(chosen
      ? `15 headlines and 4 descriptions, written from this page's intent and sentiment and the ${chosen} keyword${chosen === 1 ? '' : 's'} selected above.`
      : 'Select some keywords first — the copy is written to match them.'));
    const btn = document.createElement('button');
    btn.className = 'save-key-btn';
    btn.textContent = 'Generate ad copy';
    btn.disabled = !chosen;
    btn.addEventListener('click', () => abGenerateCopy(btn));
    s.appendChild(btn);
    return s;
  }

  s.appendChild(abAssetList('Headlines', 'headlines', 30));
  s.appendChild(abAssetList('Descriptions', 'descriptions', 90));

  const regen = document.createElement('button');
  regen.className = 'save-key-btn';
  regen.textContent = 'Regenerate';
  regen.addEventListener('click', () => { _abCopy = null; renderAdsBuild(); });
  s.appendChild(regen);
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

  const head = document.createElement('div');
  head.className = 'field-hint';
  head.textContent = `${label} (${items.length})`;
  wrap.appendChild(head);

  items.forEach((text, i) => {
    const row = document.createElement('div');
    row.className = 'adsbuild-asset-row';
    row.dataset.assetText = text;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'wp-input adsbuild-asset-input';
    input.value = text;

    const count = document.createElement('span');
    count.className = 'adsbuild-count';

    const chips = document.createElement('span');
    chips.className = 'asset-insight-chips adsbuild-chips';

    const paintCount = () => {
      count.textContent = `${input.value.length}/${max}`;
      count.classList.toggle('is-over', input.value.length > max);
    };
    paintCount();
    abPaintChips(chips, input.value);

    input.addEventListener('input', () => {
      _abCopy[key][i] = input.value;
      paintCount();
      abSyncCommit();
    });
    // Classification costs an API call, so it waits for the edit to settle
    // rather than firing on every keystroke.
    input.addEventListener('change', () => {
      row.dataset.assetText = input.value;
      abClassify([input.value], () => abPaintChips(chips, input.value));
    });

    row.appendChild(input);
    row.appendChild(count);
    row.appendChild(chips);
    wrap.appendChild(row);
  });

  return wrap;
}

// Intent and sentiment for one phrase, from the shared classifier cache that
// the Ad Copy panel already populates. Absent until classification resolves.
function abPaintChips(box, text) {
  if (!box) return;
  const ins = (typeof _adAssetInsights !== 'undefined')
    ? _adAssetInsights[String(text || '').toLowerCase()] : null;
  box.replaceChildren();
  if (!ins) return;
  const chips = typeof buildInsightChips === 'function' ? buildInsightChips(ins) : null;
  if (chips) box.appendChild(chips);
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
    // generateAdCopy populates the shared _adCopy used by the Ad Copy panel.
    await generateAdCopy(true);
    const copy = typeof _adCopy !== 'undefined' ? _adCopy : null;
    if (!copy) throw new Error('Ad copy generation returned nothing.');
    _abCopy = {
      headlines: (copy.headlines || []).slice(0, 15),
      descriptions: (copy.descriptions || []).slice(0, 4)
    };
    renderAdsBuild();
    abClassify([..._abCopy.headlines, ..._abCopy.descriptions], () => {
      document.querySelectorAll('.adsbuild-asset-row').forEach(row => {
        abPaintChips(row.querySelector('.adsbuild-chips'), row.dataset.assetText);
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
    s.appendChild(abHint('Mined from this page\'s own headings, title and meta description, then cross-checked against its Search Console queries and tracked keywords. Anything already targeted in the account is flagged.'));
    const btn = document.createElement('button');
    btn.className = 'save-key-btn';
    btn.textContent = 'Find keywords';
    btn.addEventListener('click', () => abLoadKeywords(btn));
    s.appendChild(btn);
    return s;
  }

  const chosen = _abKeywords.filter(k => k.include).length;
  const summary = abHint(`${chosen} of ${_abKeywords.length} selected.`);
  summary.id = 'adsbuild-kw-summary';
  s.appendChild(summary);

  _abKeywords.forEach(k => s.appendChild(abKeywordRow(k)));
  return s;
}

/**
 * One keyword row: include, term, match type, volume, and its classification.
 *
 * Match type is editable in place because the right choice is per term, not
 * per ad group — a broad head term wants phrase, a specific product name wants
 * exact, and forcing one setting across the list would be wrong for half of it.
 */
function abKeywordRow(k) {
  const row = document.createElement('div');
  row.className = 'adsbuild-kw-row';

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!k.include;
  cb.addEventListener('change', () => {
    k.include = cb.checked;
    abSyncKeywordSummary();
    abSyncCommit();
  });

  const text = document.createElement('span');
  text.className = 'adsbuild-kw-text';
  text.textContent = k.text;
  if (k.onPage) text.title = 'Appears in this page\'s own headings, title or meta description';

  const match = document.createElement('select');
  match.className = 'adsbuild-kw-match';
  [['PHRASE', 'Phrase'], ['EXACT', 'Exact'], ['BROAD', 'Broad']].forEach(([v, label]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    if (v === k.matchType) o.selected = true;
    match.appendChild(o);
  });
  match.addEventListener('change', () => { k.matchType = match.value; });

  const volume = document.createElement('span');
  volume.className = 'adsbuild-kw-vol';
  volume.textContent = k.volume != null ? `${k.volume.toLocaleString()}/mo` : '—';
  if (k.volume == null) volume.title = 'No Keyword Planner figure — not the same as no demand';

  const chips = document.createElement('span');
  chips.className = 'asset-insight-chips adsbuild-chips';
  abPaintChips(chips, k.text);

  row.appendChild(cb);
  row.appendChild(text);
  row.appendChild(match);
  row.appendChild(volume);
  row.appendChild(chips);

  // Adding a term that already lives elsewhere creates internal competition,
  // so name where it is rather than silently dropping it.
  if (k.targetedIn) {
    const warn = document.createElement('span');
    warn.className = 'adsbuild-kw-warn';
    warn.textContent = `already in ${k.targetedIn}`;
    row.appendChild(warn);
  }
  return row;
}

function abSyncKeywordSummary() {
  const el = document.getElementById('adsbuild-kw-summary');
  if (el) el.textContent = `${_abKeywords.filter(k => k.include).length} of ${_abKeywords.length} selected.`;
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
    } catch { /* dedupe is best-effort */ }

    let volumes = {};
    try {
      const ideas = await sendMessageWithTimeout({
        action: 'adsGetKeywordIdeas', pageUrl: _abPageUrl,
        keywords: seeds.slice(0, 60).map(s => s.text)   // the API takes plain strings
      });
      volumes = (ideas && ideas.byKeyword) || {};
    } catch { /* volume is enrichment only */ }

    _abKeywords = abRankKeywords(seeds, volumes, targeted);
    renderAdsBuild();
    // Intent and sentiment resolve after the list is on screen — the chips
    // fill in rather than holding up the whole section.
    abClassify(_abKeywords.map(k => k.text), () => {
      document.querySelectorAll('.adsbuild-kw-row').forEach(row => {
        const t = row.querySelector('.adsbuild-kw-text');
        abPaintChips(row.querySelector('.adsbuild-chips'), t && t.textContent);
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
  const sources = [
    { text: info && info.h1, weight: 5 },
    { text: info && info.title, weight: 4 },
    { text: (info && info.metaDescription) || (info && info.description), weight: 2 }
  ];
  ((info && info.headings) || []).forEach(h => {
    if (!h || !h.text) return;
    if (h.level === 1) sources.push({ text: h.text, weight: 5 });
    else if (h.level === 2) sources.push({ text: h.text, weight: 3 });
    else if (h.level === 3) sources.push({ text: h.text, weight: 2 });
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
function abRankKeywords(seeds, volumes, targeted) {
  const scored = seeds.map(seed => {
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

  scored.sort((a, b) => {
    if (!!a.targetedIn !== !!b.targetedIn) return a.targetedIn ? 1 : -1;
    return b._score - a._score;
  });

  return scored.slice(0, AB_KEYWORD_CAP).map(k => ({
    ...k,
    // Every candidate already comes from the page, from a query this page
    // earns, or from a tracked keyword — so the default is ON. Only two things
    // switch it off: the term is already targeted elsewhere (adding it would
    // compete with an existing ad group), or Keyword Planner explicitly
    // measured zero demand. A MISSING figure is not zero demand — plenty of
    // valid long-tail terms have none — so null stays included.
    include: !k.targetedIn && k.volume !== 0
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
