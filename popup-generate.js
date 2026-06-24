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

// ─── Generate OG / Twitter text fields ───────────────────────────────────────

const OG_GEN_CONFIG = {
  'og:title':            { maxChars: 60,  platform: 'Open Graph (Facebook, LinkedIn, Slack)', type: 'title' },
  'og:description':      { maxChars: 125, platform: 'Open Graph (Facebook, LinkedIn, Slack)', type: 'description' },
  'twitter:title':       { maxChars: 60,  platform: 'X (Twitter)',                             type: 'title' },
  'twitter:description': { maxChars: 125, platform: 'X (Twitter)',                             type: 'description' },
};

async function generateOGField(key, bodyEl, btn) {
  if (!pageData || btn.disabled) return;

  const cfg = OG_GEN_CONFIG[key];
  const resultEl = bodyEl.querySelector('.gen-result');
  if (!resultEl) return;

  btn.disabled = true;
  btn.querySelector('.icon-generate').classList.add('hidden');
  btn.querySelector('.icon-spinner').classList.remove('hidden');
  resultEl.classList.remove('hidden', 'is-error');
  resultEl.replaceChildren();

  const loadingEl = document.createElement('div');
  loadingEl.className = 'gen-result-text';
  loadingEl.textContent = 'Generating…';
  resultEl.appendChild(loadingEl);

  try {
    const { claudeApiKey } = await browser.storage.local.get('claudeApiKey');
    if (!claudeApiKey) throw new Error('No Claude API key — add one in Settings (⚙).');

    const tab = await getActiveTab();
    const pageUrl = pageData.canonical || tab.url;
    const og = pageData.openGraph?.og || {};
    const tw = pageData.openGraph?.twitter || {};

    const context = [
      `Page URL: ${pageUrl}`,
      `Title tag: "${pageData.title?.text}"`,
      pageData.metaDescription?.text && `Meta description: "${pageData.metaDescription.text}"`,
      og['og:title']            && `Current og:title: "${og['og:title']}"`,
      og['og:description']      && `Current og:description: "${og['og:description']}"`,
      tw['twitter:title']       && `Current twitter:title: "${tw['twitter:title']}"`,
      tw['twitter:description'] && `Current twitter:description: "${tw['twitter:description']}"`,
      pageData.headings?.length && `Headings:\n${pageData.headings.map(h => `${h.tag.toUpperCase()}: ${h.text}`).join('\n')}`,
      pageData.bodyTextExcerpt  && `Page content excerpt: "${pageData.bodyTextExcerpt}"`
    ].filter(Boolean).join('\n\n');

    const system = cfg.type === 'title'
      ? `You are a social media copywriter. Write a single ${key} tag value for the page described below.
- Platform: ${cfg.platform}
- Maximum ${cfg.maxChars} characters — stay under this limit.
- Write a compelling, specific share headline. Do not pad with the site name. Do not invent facts not in the page.
- Return only the text, no quotes, no labels, no explanation.`
      : `You are a social media copywriter. Write a single ${key} tag value for the page described below.
- Platform: ${cfg.platform}
- Maximum ${cfg.maxChars} characters — stay under this limit.
- Write an engaging, specific description that makes people want to click. Do not invent facts not in the page.
- Return only the text, no quotes, no labels, no explanation.`;

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

    const resp = await res.json();
    const suggestion = (resp.content?.[0]?.text ?? '').trim();
    if (!suggestion) throw new Error('Empty response from Claude');

    resultEl.replaceChildren();

    const labelEl = document.createElement('div');
    labelEl.className = 'gen-result-label';
    labelEl.textContent = `SUGGESTED ${key.toUpperCase()}`;

    const textEl = document.createElement('div');
    textEl.className = 'gen-result-text';
    textEl.textContent = suggestion;

    const footer = document.createElement('div');
    footer.className = 'gen-result-footer';

    const metaEl = document.createElement('span');
    metaEl.className = 'gen-result-meta ' + (suggestion.length > cfg.maxChars ? 'is-count-amber' : 'is-count-green');
    metaEl.textContent = `${suggestion.length} chars`;

    const actions = document.createElement('div');
    actions.className = 'gen-result-actions';

    const regenBtn = document.createElement('button');
    regenBtn.className = 'gen-result-btn';
    regenBtn.title = 'Regenerate';
    regenBtn.appendChild(svgFromString(
      '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M13.5 8A5.5 5.5 0 1 1 8 2.5a5.5 5.5 0 0 1 3.9 1.6L13.5 5.6"/>' +
      '<polyline points="13.5 2 13.5 5.6 9.9 5.6"/>' +
      '</svg>'
    ));
    regenBtn.addEventListener('click', () => generateOGField(key, bodyEl, btn));

    const copyBtn = document.createElement('button');
    copyBtn.className = 'gen-result-btn';
    copyBtn.title = 'Copy suggestion';
    copyBtn.appendChild(svgFromString(
      '<svg class="icon-copy" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="5" y="4" width="9" height="11" rx="1.5"/>' +
      '<path d="M3 12H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v1"/>' +
      '</svg>'
    ));
    copyBtn.appendChild(svgFromString(
      '<svg class="icon-check hidden" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<polyline points="2 8 6 12 14 4"/>' +
      '</svg>'
    ));
    copyBtn.addEventListener('click', async () => {
      await copyToClipboard(suggestion);
      flashCopyBtn(copyBtn);
    });

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'gen-result-btn';
    dismissBtn.title = 'Dismiss';
    dismissBtn.appendChild(svgFromString(
      '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">' +
      '<line x1="3" y1="3" x2="13" y2="13"/>' +
      '<line x1="13" y1="3" x2="3" y2="13"/>' +
      '</svg>'
    ));
    dismissBtn.addEventListener('click', () => resultEl.classList.add('hidden'));

    actions.appendChild(regenBtn);
    actions.appendChild(copyBtn);
    actions.appendChild(dismissBtn);
    footer.appendChild(metaEl);
    footer.appendChild(actions);

    resultEl.appendChild(labelEl);
    resultEl.appendChild(textEl);
    resultEl.appendChild(footer);

  } catch (err) {
    resultEl.replaceChildren();
    resultEl.classList.add('is-error');
    const errEl = document.createElement('div');
    errEl.className = 'gen-result-text';
    errEl.textContent = err.message;
    resultEl.appendChild(errEl);
  } finally {
    btn.disabled = false;
    btn.querySelector('.icon-generate').classList.remove('hidden');
    btn.querySelector('.icon-spinner').classList.add('hidden');
  }
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

// Hover explainers for each AI-derived label (what the dimension represents)
const AI_HINTS = {
  sentiment:   'Sentiment — the overall emotional tone of the page text (Positive / Negative / Neutral / Mixed), judged by Claude from the page copy.',
  intent:      'Search intent — what a visitor is most likely trying to do here: Informational (learn), Navigational (find a specific site), Commercial (research a purchase), or Transactional (buy/act).',
  readability: 'Readability — how hard the text is to read (Easy / Medium / Hard). Audience — whether the writing targets a Technical or General reader.'
};

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
  sentimentEl.title = AI_HINTS.sentiment;

  const intentEl = document.getElementById('ai-intent');
  intentEl.textContent = v.intent;
  intentEl.className = 'field-meta';
  intentEl.title = AI_HINTS.intent;

  // "Easy, General" — readability colored, audience plain
  const readEl = document.getElementById('ai-readability');
  readEl.replaceChildren();
  const read = document.createElement('span');
  read.className = AI_READABILITY_CLASS[v.readability] || '';
  read.textContent = v.readability;
  readEl.appendChild(read);
  readEl.appendChild(document.createTextNode(`, ${v.audience}`));
  readEl.title = AI_HINTS.readability;
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
