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
