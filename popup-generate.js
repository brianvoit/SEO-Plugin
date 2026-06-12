// ─── Generate title/meta with Claude ────────────────────────────────────────

const GEN_FIELD_LABELS = { title: 'title tag', meta: 'meta description' };
const genSuggestions = { title: '', meta: '' };

async function generateField(field) {
  const btn     = document.getElementById(`btn-generate-${field}`);
  const result  = document.getElementById(`${field}-gen-result`);
  const textEl  = document.getElementById(`${field}-gen-text`);
  const metaEl  = document.getElementById(`${field}-gen-meta`);

  if (!pageData || btn.disabled) return;

  btn.disabled = true;
  btn.querySelector('.icon-generate').classList.add('hidden');
  btn.querySelector('.icon-spinner').classList.remove('hidden');
  result.classList.remove('hidden', 'is-error');
  textEl.textContent = 'Generating…';
  metaEl.textContent = '';
  metaEl.className = 'gen-result-meta';

  try {
    const { claudeApiKey } = await browser.storage.local.get('claudeApiKey');
    if (!claudeApiKey) throw new Error('No Claude API key — add one in Settings (⚙).');

    const tab = await getActiveTab();
    const ranges = charRanges[field];
    const fieldLabel = GEN_FIELD_LABELS[field];
    const pageUrl = pageData.canonical || tab.url;

    let host = '';
    try { host = new URL(pageUrl, tab.url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
    const brandTerms = (allBrandedTerms[host] || '')
      .split('|')
      .map(s => s.trim())
      .filter(Boolean);

    const context = [
      `Page URL: ${pageUrl}`,
      `Current title tag: "${pageData.title.text}"`,
      pageData.metaDescription && `Current meta description: "${pageData.metaDescription.text}"`,
      pageData.headings.length && `Headings:\n${pageData.headings.map(h => `${h.tag.toUpperCase()}: ${h.text}`).join('\n')}`,
      pageData.bodyTextExcerpt && `Page content excerpt: "${pageData.bodyTextExcerpt}"`
    ].filter(Boolean).join('\n\n');

    const system = `You are an SEO copywriter. Write a single replacement ${fieldLabel} for the page described below.
- Do not include the site name, brand name, or company name${brandTerms.length ? ` (e.g., ${brandTerms.join(', ')})` : ''}.
- Be specific and relevant to the page's actual topic and primary keywords. Do not invent facts not supported by the page content.
- Target length: ${ranges.min}-${ranges.max} characters, ideally close to ${ranges.target} characters.
- Return only the ${fieldLabel} text, nothing else — no quotes, no labels, no explanation.`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeApiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        system,
        messages: [{ role: 'user', content: context }]
      })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message ?? `HTTP ${res.status}`);
    }

    const data = await res.json();
    const suggestion = data.content?.[0]?.text?.trim();
    if (!suggestion) throw new Error('Empty response from Claude');

    genSuggestions[field] = suggestion;
    textEl.textContent = suggestion;
    metaEl.textContent = `${suggestion.length} chars`;
    metaEl.className = 'gen-result-meta ' + countColorClass(suggestion.length, ranges);
  } catch (err) {
    result.classList.add('is-error');
    textEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.querySelector('.icon-generate').classList.remove('hidden');
    btn.querySelector('.icon-spinner').classList.add('hidden');
  }
}

document.querySelectorAll('.gen-btn').forEach(btn => {
  btn.addEventListener('click', () => generateField(btn.dataset.field));
});

// Regenerate buttons (left of copy) ask for fresh text
document.querySelectorAll('[id$="-gen-regen"]').forEach(btn => {
  btn.addEventListener('click', () => generateField(btn.dataset.field));
});

// Clear any suggestions — called when the page data is refreshed, so stale
// AI text doesn't linger over freshly-read page metadata.
function clearGenResults() {
  ['title', 'meta'].forEach(field => {
    genSuggestions[field] = '';
    document.getElementById(`${field}-gen-result`).classList.add('hidden');
  });
}

// ─── Page insights: sentiment / intent / readability / audience ──────────────
// One Claude call returns all four labels; results are cached per URL for a
// day so browsing back and forth doesn't re-bill.

const AI_INSIGHT_LABELS = {
  sentiment:   ['Positive', 'Negative', 'Neutral', 'Mixed'],
  intent:      ['Informational', 'Navigational', 'Commercial', 'Transactional'],
  readability: ['Easy', 'Medium', 'Hard'],
  audience:    ['Technical', 'General']
};

const AI_INSIGHTS_TTL_MS = 24 * 60 * 60 * 1000;

const AI_SENTIMENT_CLASS   = { Positive: 'hint-green', Negative: 'hint-red', Mixed: 'hint-amber', Neutral: '' };
const AI_READABILITY_CLASS = { Easy: 'hint-green', Medium: 'hint-amber', Hard: 'hint-red' };

function setAiInsightFields(text, hint) {
  ['ai-sentiment', 'ai-intent', 'ai-readability'].forEach(id => {
    const el = document.getElementById(id);
    el.textContent = text;
    el.className = 'field-meta';
    el.title = hint || '';
  });
}

function renderAiInsights(v) {
  const sentimentEl = document.getElementById('ai-sentiment');
  sentimentEl.textContent = v.sentiment;
  sentimentEl.className = 'field-meta ' + (AI_SENTIMENT_CLASS[v.sentiment] || '');
  sentimentEl.title = '';

  const intentEl = document.getElementById('ai-intent');
  intentEl.textContent = v.intent;
  intentEl.className = 'field-meta';
  intentEl.title = '';

  // "Easy, General" — readability colored, audience plain
  const readEl = document.getElementById('ai-readability');
  readEl.replaceChildren();
  const read = document.createElement('span');
  read.className = AI_READABILITY_CLASS[v.readability] || '';
  read.textContent = v.readability;
  readEl.appendChild(read);
  readEl.appendChild(document.createTextNode(`, ${v.audience}`));
  readEl.title = 'Readability · Audience';
}

// Accept the model's answer only if every label is from its allowed set
function normalizeAiInsights(raw) {
  const out = {};
  for (const [key, labels] of Object.entries(AI_INSIGHT_LABELS)) {
    const value = String(raw?.[key] ?? '').trim().toLowerCase();
    const match = labels.find(l => l.toLowerCase() === value);
    if (!match) return null;
    out[key] = match;
  }
  return out;
}

async function loadAiInsights(forceRefresh = false) {
  if (!pageData || !pageData.bodyTextExcerpt) {
    setAiInsightFields('—');
    return;
  }

  const { claudeApiKey } = await browser.storage.local.get('claudeApiKey');
  if (!claudeApiKey) {
    setAiInsightFields('—', 'Add a Claude API key in Settings to analyze the page');
    return;
  }

  const tab = await getActiveTab();
  const cacheKey = (tab.url || '').split('#')[0];

  const { aiInsightsCache } = await browser.storage.local.get('aiInsightsCache');
  const cache = aiInsightsCache || {};
  const cached = cache[cacheKey];
  if (!forceRefresh && cached && (Date.now() - cached.fetchedAt < AI_INSIGHTS_TTL_MS)) {
    renderAiInsights(cached);
    return;
  }

  setAiInsightFields('…');

  const system = `You analyze webpage content. Respond with ONLY a compact JSON object — no prose, no code fences — exactly of the form {"sentiment":"…","intent":"…","readability":"…","audience":"…"}.
- sentiment: the sentiment of the text — Positive, Negative, Neutral or Mixed
- intent: the search intent of the page — Informational, Navigational, Commercial or Transactional
- readability: rate the readability of the content — Easy, Medium, or Hard
- audience: is the content written for a Technical or General audience`;

  const content = [
    `Title: ${pageData.title.text}`,
    pageData.metaDescription && `Meta description: ${pageData.metaDescription.text}`,
    `Content: ${pageData.bodyTextExcerpt}`
  ].filter(Boolean).join('\n\n');

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeApiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 120,
        system,
        messages: [{ role: 'user', content }]
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message ?? `HTTP ${res.status}`);
    }
    const data = await res.json();
    const text = (data.content?.[0]?.text ?? '').replace(/^```(?:json)?|```$/g, '').trim();
    const values = normalizeAiInsights(JSON.parse(text));
    if (!values) throw new Error('Unexpected labels in response');

    cache[cacheKey] = { ...values, fetchedAt: Date.now() };
    const keys = Object.keys(cache);
    if (keys.length > 20) {
      keys.sort((a, b) => cache[a].fetchedAt - cache[b].fetchedAt);
      keys.slice(0, keys.length - 20).forEach(k => delete cache[k]);
    }
    browser.storage.local.set({ aiInsightsCache: cache });

    renderAiInsights(values);
  } catch (err) {
    setAiInsightFields('—', `Analysis failed: ${err.message}`);
  }
}

document.querySelectorAll('[id$="-gen-copy"]').forEach(btn => {
  btn.addEventListener('click', async () => {
    await copyToClipboard(genSuggestions[btn.dataset.field] ?? '');
    flashCopyBtn(btn);
  });
});

document.querySelectorAll('[id$="-gen-dismiss"]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.getElementById(`${btn.dataset.field}-gen-result`).classList.add('hidden');
  });
});
