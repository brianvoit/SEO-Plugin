// Panel navigation: settings panel, schema detail panel, and the main
// Overview/Search tabs. Calls into popup-inspector.js, popup-gsc.js, and
// popup-settings.js (loaded earlier in popup.html).

// ─── Panel navigation ────────────────────────────────────────────────────────

const settingsPanel = document.getElementById('settings-panel');
const schemaPanel   = document.getElementById('schema-panel');
const searchTab     = document.getElementById('search-tab');
const mainContent   = document.getElementById('content');
const tabGroup      = document.getElementById('main-tabs');
const updateFooter  = document.getElementById('update-footer');
const errorBanner   = document.getElementById('error-state');

let activeTab = 'overview';

function showActiveTab() {
  tabGroup.classList.remove('hidden');
  mainContent.classList.toggle('hidden', activeTab !== 'overview');
  searchTab.classList.toggle('hidden', activeTab !== 'search');
}

function showSchemaPanel() {
  if (!_schemas.length) return;
  mainContent.classList.add('hidden');
  searchTab.classList.add('hidden');
  updateFooter.classList.add('hidden');
  errorBanner.classList.add('hidden');
  settingsPanel.classList.add('hidden');
  schemaPanel.classList.remove('hidden');
  renderSchemaDetail();
}

function hideSchemaPanel() {
  schemaPanel.classList.add('hidden');
  updateFooter.classList.remove('hidden');
  showActiveTab();
}

function showSettings() {
  mainContent.classList.add('hidden');
  searchTab.classList.add('hidden');
  schemaPanel.classList.add('hidden');
  updateFooter.classList.add('hidden');
  errorBanner.classList.add('hidden');
  settingsPanel.classList.remove('hidden');

  browser.storage.local.get(['claudeApiKey', 'charRanges', 'displayMode', 'gscClientId', 'gscClientSecret']).then(({ claudeApiKey, charRanges: stored, displayMode, gscClientId, gscClientSecret }) => {
    document.getElementById('api-key-input').value = claudeApiKey ?? '';
    document.getElementById('key-saved-msg').classList.add('hidden');

    const ranges = stored ?? DEFAULT_RANGES;
    document.getElementById('title-min').value    = ranges.title.min;
    document.getElementById('title-target').value = ranges.title.target;
    document.getElementById('title-max').value    = ranges.title.max;
    document.getElementById('meta-min').value     = ranges.meta.min;
    document.getElementById('meta-target').value  = ranges.meta.target;
    document.getElementById('meta-max').value     = ranges.meta.max;

    document.getElementById('gsc-client-id').value     = gscClientId ?? '';
    document.getElementById('gsc-client-secret').value = gscClientSecret ?? '';

    setDisplayModeUI(displayMode || 'sidebar');
  });

  loadWpSites();
  refreshGscSettingsStatus();
  loadBrandedTerms();
}

function hideSettings() {
  settingsPanel.classList.add('hidden');
  updateFooter.classList.remove('hidden');
  showActiveTab();
  loadData(metaExpanded);
}

document.getElementById('btn-settings').addEventListener('click', showSettings);
document.getElementById('btn-schema').addEventListener('click', showSchemaPanel);
document.getElementById('btn-schema-back').addEventListener('click', hideSchemaPanel);

// ─── Main tabs (Overview / Search) ──────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    const inSettings = !settingsPanel.classList.contains('hidden');
    const inSchema   = !schemaPanel.classList.contains('hidden');
    if (tab === activeTab && !inSettings && !inSchema) return;
    activeTab = tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('is-active', b.dataset.tab === tab));
    if (inSettings) hideSettings();
    else if (inSchema) hideSchemaPanel();
    else showActiveTab();
  });
});
