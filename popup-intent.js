// Shared search-intent classification + filter chips, used by the Search,
// Ranking, and Ads tabs. A term's intent is page-independent, so one global
// term→intent cache is classified once (Haiku) and reused everywhere.

const INTENTS = ['Informational', 'Navigational', 'Commercial', 'Transactional'];
const INTENT_CLASS = {
  Informational: 'info', Commercial: 'commercial', Transactional: 'transactional', Navigational: 'navigational'
};
const INTENT_HINT = {
  Informational: 'Informational — seeking knowledge/answers',
  Navigational: 'Navigational — looking for a specific site/brand/page',
  Commercial: 'Commercial — researching/comparing before a purchase decision',
  Transactional: 'Transactional — ready to act: buy, book, sign up, contact'
};

const INTENT_BATCH = 100;          // classify at most this many new terms per call
const INTENT_CACHE_CAP = 1000;     // LRU-ish cap on the persisted term→intent map

let _intentMap = {};               // term(lower) → intent, shared across tabs
let _intentCacheLoaded = false;
let _intentLoading = false;
let _intentEnabled = false;        // false when no Claude key (chip rows hidden)

function intentOf(term) { return _intentMap[String(term || '').trim().toLowerCase()] || null; }
function intentEnabled() { return _intentEnabled; }

const INTENT_CLASSIFY_SYSTEM = `You classify search queries by search intent. For each numbered query choose exactly one label:
- Informational: seeking knowledge or answers.
- Navigational: looking for a specific site, brand, or page.
- Commercial: researching or comparing options before a purchase decision.
- Transactional: ready to act — buy, book, sign up, or contact.
Respond with ONLY a compact JSON object mapping each query's number (as a string) to its label, e.g. {"0":"Commercial","1":"Informational"}. No prose, no code fences.`;

async function classifyIntents(terms, claudeApiKey) {
  const content = terms.map((t, i) => `${i}: ${t}`).join('\n');

  const data = await claudeFetch({
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': claudeApiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: MODEL_LIGHT,
      max_tokens: 2000,
      system: [{ type: 'text', text: INTENT_CLASSIFY_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content }]
    })
  });
  const text = (data.content?.[0]?.text ?? '').replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const map = JSON.parse(text);
  return terms.map((t, i) => INTENTS.find(l => l.toLowerCase() === String(map[i] ?? map[String(i)] ?? '').trim().toLowerCase()) || null);
}

function persistIntentCache() {
  const keys = Object.keys(_intentMap);
  if (keys.length > INTENT_CACHE_CAP) {
    const trimmed = {};
    keys.slice(keys.length - INTENT_CACHE_CAP).forEach(k => { trimmed[k] = _intentMap[k]; });
    _intentMap = trimmed;
  }
  browser.storage.local.set({ intentCache: { map: _intentMap } });
}

// Classify any not-yet-known terms, then fire onReady ONCE — but only when work
// was actually done (a classification, or the first cache load). A fully-cached
// call returns without onReady, so a re-render in onReady can't loop. Large lists
// classify in batches: each onReady re-render tops up the next batch until done.
async function ensureIntents(terms, onReady) {
  const { claudeApiKey } = await browser.storage.local.get('claudeApiKey');
  if (!claudeApiKey) { _intentEnabled = false; return; }
  _intentEnabled = true;

  let didLoad = false;
  if (!_intentCacheLoaded) {
    const { intentCache } = await browser.storage.local.get('intentCache');
    if (intentCache && intentCache.map) Object.assign(_intentMap, intentCache.map);
    _intentCacheLoaded = true;
    didLoad = true;
  }

  // De-dupe by lowercase; keep original casing for the prompt
  const seen = new Set();
  const need = [];
  (terms || []).forEach(t => {
    const s = String(t || '').trim();
    if (!s) return;
    const lc = s.toLowerCase();
    if (_intentMap[lc] || seen.has(lc)) return;
    seen.add(lc);
    need.push(s);
  });

  if (need.length && !_intentLoading) {
    _intentLoading = true;
    try {
      const batch = need.slice(0, INTENT_BATCH);
      const labels = await classifyIntents(batch, claudeApiKey);
      batch.forEach((t, i) => { if (labels[i]) _intentMap[t.toLowerCase()] = labels[i]; });
      persistIntentCache();
    } catch {
      // best-effort; leave the map as-is
    } finally {
      _intentLoading = false;
    }
    if (onReady) onReady();
    return;
  }

  if (didLoad && onReady) onReady();
}

// Generic intent filter-chip row. Renders "All" + the four intents with live
// counts over `items`; a zero-count intent is greyed/disabled (so an absent
// category reads as a signal). Hidden until a key exists and something's
// classified. onSelect(intentOrNull) is called on click.
function renderIntentChips(rowEl, items, getText, activeIntent, onSelect) {
  if (!rowEl) return;
  rowEl.replaceChildren();

  const texts = items.map(getText);
  if (!_intentEnabled || !texts.some(t => intentOf(t))) {
    rowEl.classList.add('hidden');
    return;
  }

  const counts = { Informational: 0, Navigational: 0, Commercial: 0, Transactional: 0 };
  texts.forEach(t => { const it = intentOf(t); if (counts[it] != null) counts[it]++; });

  const mkChip = (label, count, active, intent, disabled, title, onClick) => {
    const chip = document.createElement('button');
    chip.className = 'gsc-intent-chip'
      + (intent ? ` gsc-intent-chip--${INTENT_CLASS[intent]}` : '')
      + (active ? ' is-active' : '')
      + (disabled ? ' is-disabled' : '');
    if (title) chip.title = title;
    if (disabled) chip.disabled = true;
    const name = document.createElement('span');
    name.textContent = label;
    chip.appendChild(name);
    const n = document.createElement('span');
    n.className = 'gsc-intent-count';
    n.textContent = count;
    chip.appendChild(n);
    if (!disabled) chip.addEventListener('click', onClick);
    return chip;
  };

  rowEl.classList.remove('hidden');
  rowEl.appendChild(mkChip('All', items.length, activeIntent === null, null, false,
    'All, regardless of intent', () => onSelect(null)));
  INTENTS.forEach(intent => {
    rowEl.appendChild(mkChip(intent, counts[intent], activeIntent === intent, intent,
      counts[intent] === 0, INTENT_HINT[intent], () => onSelect(activeIntent === intent ? null : intent)));
  });
}
