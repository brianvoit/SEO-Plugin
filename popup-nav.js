// Panel navigation: settings panel, schema detail panel, and the main
// Overview/Search tabs. Calls into popup-inspector.js, popup-gsc.js, and
// popup-settings.js (loaded earlier in popup.html).

// ─── Panel navigation ────────────────────────────────────────────────────────

const settingsPanel = document.getElementById('settings-panel');
const schemaPanel   = document.getElementById('schema-panel');
const ogPanel       = document.getElementById('og-panel');
const twPanel       = document.getElementById('tw-panel');
const redirectPanel = document.getElementById('redirect-panel');
const searchTab     = document.getElementById('search-tab');
const mainContent   = document.getElementById('content');
const tabGroup      = document.getElementById('main-tabs');
const updateFooter  = document.getElementById('update-footer');
const errorBanner   = document.getElementById('error-state');

let activeTab = 'overview';

// Every full-screen detail panel reachable from the Overview tab
function hideDetailPanels() {
  settingsPanel.classList.add('hidden');
  schemaPanel.classList.add('hidden');
  ogPanel.classList.add('hidden');
  twPanel.classList.add('hidden');
  redirectPanel.classList.add('hidden');
}

function showActiveTab() {
  hideDetailPanels();
  document.body.classList.remove('settings-open');
  document.getElementById('btn-settings').classList.remove('is-active');
  // The update checker lives only on the Setup screen
  updateFooter.classList.add('hidden');
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('is-active', b.dataset.tab === activeTab));
  tabGroup.classList.remove('hidden');
  mainContent.classList.toggle('hidden', activeTab !== 'overview');
  searchTab.classList.toggle('hidden', activeTab !== 'search');
}

// Shared setup for opening a detail panel: hide the tabs' content + other panels
function enterDetailPanel() {
  mainContent.classList.add('hidden');
  searchTab.classList.add('hidden');
  updateFooter.classList.add('hidden');
  errorBanner.classList.add('hidden');
  hideDetailPanels();
}

function showSchemaPanel() {
  if (!_schemas.length) return;
  enterDetailPanel();
  schemaPanel.classList.remove('hidden');
  renderSchemaDetail();
}

function showOgPanel() {
  enterDetailPanel();
  ogPanel.classList.remove('hidden');
}

function showTwPanel() {
  enterDetailPanel();
  twPanel.classList.remove('hidden');
}

function showRedirectPanel() {
  enterDetailPanel();
  redirectPanel.classList.remove('hidden');
  renderRedirectPanel();
}

function hideDetailPanelToTab() {
  showActiveTab();
}

function showSettings() {
  enterDetailPanel();
  settingsPanel.classList.remove('hidden');
  // The update checker lives only on the settings page now, pinned to the bottom
  updateFooter.classList.remove('hidden');
  document.body.classList.add('settings-open');
  // Settings reads as the active "tab": light up the wrench, dim the tabs
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('is-active'));
  document.getElementById('btn-settings').classList.add('is-active');

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
  refreshGscSettingsStatus().then(status => {
    if (status && status.connected) refreshGscPropertyInfo();
  });
  loadBrandedTerms();
}

function hideSettings() {
  hideDetailPanelToTab();
  loadData(metaExpanded);
}

document.getElementById('btn-settings').addEventListener('click', showSettings);
document.getElementById('btn-schema').addEventListener('click', showSchemaPanel);
document.getElementById('btn-schema-back').addEventListener('click', hideDetailPanelToTab);
document.getElementById('btn-og').addEventListener('click', showOgPanel);
document.getElementById('btn-og-back').addEventListener('click', hideDetailPanelToTab);
document.getElementById('btn-tw').addEventListener('click', showTwPanel);
document.getElementById('btn-tw-back').addEventListener('click', hideDetailPanelToTab);
document.getElementById('btn-status').addEventListener('click', showRedirectPanel);
document.getElementById('btn-redirect-back').addEventListener('click', hideDetailPanelToTab);

// ─── Main tabs (Overview / Search) ──────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    const inSettings = !settingsPanel.classList.contains('hidden');
    const inPanel = inSettings
      || !schemaPanel.classList.contains('hidden')
      || !ogPanel.classList.contains('hidden')
      || !twPanel.classList.contains('hidden')
      || !redirectPanel.classList.contains('hidden');
    if (tab === activeTab && !inPanel) return;
    activeTab = tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('is-active', b.dataset.tab === tab));
    // Settings reloads page data on exit; other panels just return to the tab
    if (inSettings) hideSettings();
    else showActiveTab();
  });
});
