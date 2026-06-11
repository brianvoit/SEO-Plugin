// Loaded as a classic (non-module) script — declarations below are shared
// globals across all popup-*.js files via the script order in popup.html.

const DEFAULT_RANGES = {
  title: { min: 30, target: 55, max: 70 },
  meta:  { min: 70, target: 155, max: 160 }
};

// Cached after load; used in every render
let charRanges = DEFAULT_RANGES;

let metaExpanded = false;

// Most recently loaded page data, used as context for AI generation and GSC query chips
let pageData = null;

// Per-domain branded-query regex patterns, keyed by hostname
let allBrandedTerms = {};

// Structured data found on the page, used by the schema detail panel
let _schemas = [];

// ─── Helpers ────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

function flashCopyBtn(btn) {
  const iconCopy  = btn.querySelector('.icon-copy');
  const iconCheck = btn.querySelector('.icon-check');
  iconCopy.classList.add('hidden');
  iconCheck.classList.remove('hidden');
  setTimeout(() => {
    iconCopy.classList.remove('hidden');
    iconCheck.classList.add('hidden');
  }, 900);
}

function countColorClass(count, ranges) {
  const { min, target, max } = ranges;
  if (count < min || count > max) return 'is-count-red';
  if (count < target) return 'is-count-amber';
  return 'is-count-green';
}

function formatDate(str) {
  if (!str) return null;
  try {
    const d = new Date(str);
    if (isNaN(d.getTime())) return str;
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  } catch { return str; }
}

function appendIndexRow(list, level, text) {
  const row  = document.createElement('div');
  row.className = `index-row index-row--${level}`;
  const dot  = document.createElement('span');
  dot.className = 'index-dot';
  const label = document.createElement('span');
  label.className = 'index-text';
  label.textContent = text;
  row.appendChild(dot);
  row.appendChild(label);
  list.appendChild(row);
}

async function getActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}
