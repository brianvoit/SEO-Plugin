// Panel navigation: settings panel, schema detail panel, and the main
// Overview/Search tabs. Calls into popup-inspector.js, popup-gsc.js, and
// popup-settings.js (loaded earlier in popup.html).

// ─── Panel navigation ────────────────────────────────────────────────────────

const settingsPanel   = document.getElementById('settings-panel');
const schemaPanel     = document.getElementById('schema-panel');
const ogPanel         = document.getElementById('og-panel');
const twPanel         = document.getElementById('tw-panel');
const actionPlanPanel = document.getElementById('actionplan-panel');
const hreflangPanel   = document.getElementById('hreflang-panel');
const faviconPanel    = document.getElementById('favicon-panel');
const adcopyPanel     = document.getElementById('adcopy-panel');
const negativesPanel  = document.getElementById('negatives-panel');
const addkwPanel      = document.getElementById('addkw-panel');
const adgroupPanel    = document.getElementById('adgroup-panel');
const backlinksPanel  = document.getElementById('backlinks-panel');
const siteauditPanel  = document.getElementById('siteaudit-panel');
const utmPanel        = document.getElementById('utm-panel');
const searchTab     = document.getElementById('search-tab');
const analyticsTab  = document.getElementById('analytics-tab');
const adsTab        = document.getElementById('ads-tab');
const rankingTab    = document.getElementById('ranking-tab');
const dnsTab        = document.getElementById('dns-tab');
const redirectTab   = document.getElementById('redirect-tab');
const statusBadge   = document.getElementById('btn-status');
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
  actionPlanPanel.classList.add('hidden');
  hreflangPanel.classList.add('hidden');
  faviconPanel.classList.add('hidden');
  adcopyPanel.classList.add('hidden');
  negativesPanel.classList.add('hidden');
  addkwPanel.classList.add('hidden');
  adgroupPanel.classList.add('hidden');
  backlinksPanel.classList.add('hidden');
  siteauditPanel.classList.add('hidden');
  utmPanel.classList.add('hidden');
}

function showActiveTab() {
  hideDetailPanels();
  // The "Cannot read this page" banner is an Overview-only state; clear it
  // whenever we (re)render a tab so it doesn't linger over another tab's
  // content after the user navigates away from a failed page read.
  errorBanner.classList.add('hidden');
  document.body.classList.remove('settings-open');
  document.getElementById('btn-settings').classList.remove('is-active');
  // The update checker lives only on the Setup screen
  updateFooter.classList.add('hidden');
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('is-active', b.dataset.tab === activeTab));
  // The status pill doubles as the redirect-trace tab; mark it active there
  statusBadge.classList.toggle('status-badge--tab-active', activeTab === 'redirect');
  tabGroup.classList.remove('hidden');
  mainContent.classList.toggle('hidden', activeTab !== 'overview');
  searchTab.classList.toggle('hidden', activeTab !== 'search');
  analyticsTab.classList.toggle('hidden', activeTab !== 'analytics');
  adsTab.classList.toggle('hidden', activeTab !== 'ads');
  rankingTab.classList.toggle('hidden', activeTab !== 'ranking');
  dnsTab.classList.toggle('hidden', activeTab !== 'dns');
  redirectTab.classList.toggle('hidden', activeTab !== 'redirect');
  if (activeTab === 'redirect') renderRedirectPanel();
}

// Shared setup for opening a detail panel: hide the tabs' content + other panels
function enterDetailPanel() {
  mainContent.classList.add('hidden');
  searchTab.classList.add('hidden');
  analyticsTab.classList.add('hidden');
  adsTab.classList.add('hidden');
  rankingTab.classList.add('hidden');
  dnsTab.classList.add('hidden');
  redirectTab.classList.add('hidden');
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

function showActionPlanPanel() {
  enterDetailPanel();
  actionPlanPanel.classList.remove('hidden');
  // Render whatever we have (cached plan, or nothing), then generate on first open
  if (typeof renderActionPlanPanel === 'function') renderActionPlanPanel();
  if (typeof loadActionPlan === 'function') loadActionPlan(false);
}

function showHreflangPanel() {
  enterDetailPanel();
  hreflangPanel.classList.remove('hidden');
  if (typeof renderHreflangDetail === 'function') renderHreflangDetail();
}

function showFaviconPanel() {
  enterDetailPanel();
  faviconPanel.classList.remove('hidden');
  if (typeof renderFaviconDetail === 'function') renderFaviconDetail();
}

function showAdCopyPanel() {
  enterDetailPanel();
  adcopyPanel.classList.remove('hidden');
  // Show cached copy for this page if present, otherwise generate on first open
  if (typeof openAdCopyPanel === 'function') openAdCopyPanel();
}

function showNegativesPanel() {
  enterDetailPanel();
  negativesPanel.classList.remove('hidden');
  // Show cached recommendations for this page if present, else analyze on first open
  if (typeof openNegativesPanel === 'function') openNegativesPanel();
}

function showAddKwPanel(source) {
  enterDetailPanel();
  addkwPanel.classList.remove('hidden');
  if (typeof openAddKwPanel === 'function') openAddKwPanel(source);
}

function showAdGroupPanel() {
  enterDetailPanel();
  adgroupPanel.classList.remove('hidden');
  if (typeof openAdGroupPanel === 'function') openAdGroupPanel();
}

function showBacklinksPanel() {
  enterDetailPanel();
  backlinksPanel.classList.remove('hidden');
  // Render whatever we already have, then (re)load — cache-backed, so instant on repeat
  if (typeof renderBacklinksPanel === 'function') renderBacklinksPanel();
  if (typeof loadBacklinksData === 'function') loadBacklinksData(false);
}

function showSiteAuditPanel() {
  enterDetailPanel();
  siteauditPanel.classList.remove('hidden');
  if (typeof renderSiteAuditPanel === 'function') renderSiteAuditPanel();
  if (typeof loadSiteAuditData === 'function') loadSiteAuditData(false);
}

function showUtmPanel() {
  enterDetailPanel();
  utmPanel.classList.remove('hidden');
  if (typeof openUtmPanel === 'function') openUtmPanel();
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

  browser.storage.local.get(['claudeApiKey', 'charRanges', 'displayMode', 'followActiveTab', 'gscClientId', 'gscClientSecret']).then(({ claudeApiKey, charRanges: stored, displayMode, followActiveTab, gscClientId, gscClientSecret }) => {
    document.getElementById('btn-follow-tab').setAttribute('aria-pressed', String(followActiveTab !== false));
    setKeyState(!!claudeApiKey);
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

  if (typeof refreshPageAccessSection === 'function') refreshPageAccessSection();
  if (typeof setOauthDrawer === 'function') setOauthDrawer(false);   // always start collapsed
  loadWpSites();
  refreshGscSettingsStatus().then(status => {
    if (status && status.connected) refreshGscPropertyInfo();
  });
  refreshGaSettingsStatus();
  refreshAdsSettingsStatus();
  refreshDocsSettingsStatus();
  refreshWebceoSettingsStatus();
  loadBrandedTerms();
}

function hideSettings() {
  hideDetailPanelToTab();
  loadData(metaExpanded);
}

document.getElementById('btn-settings').addEventListener('click', showSettings);
document.getElementById('btn-schema').addEventListener('click', showSchemaPanel);
document.getElementById('btn-schema-back').addEventListener('click', hideDetailPanelToTab);
document.getElementById('btn-schema-rich-results').addEventListener('click', async () => {
  let url = '';
  try { url = (pageData && pageData.canonical) || (await getActiveTab()).url; } catch { /* keep default */ }
  if (!url) return;
  browser.tabs.create({ url: 'https://search.google.com/test/rich-results?url=' + encodeURIComponent(url) });
});
document.getElementById('btn-og').addEventListener('click', showOgPanel);
document.getElementById('btn-og-back').addEventListener('click', hideDetailPanelToTab);
document.getElementById('btn-tw').addEventListener('click', showTwPanel);
document.getElementById('btn-tw-back').addEventListener('click', hideDetailPanelToTab);
document.getElementById('btn-actionplan').addEventListener('click', showActionPlanPanel);
document.getElementById('btn-ads-actionplan').addEventListener('click', showActionPlanPanel);
document.getElementById('btn-actionplan-back').addEventListener('click', hideDetailPanelToTab);
document.getElementById('btn-hreflang').addEventListener('click', showHreflangPanel);
document.getElementById('btn-hreflang-back').addEventListener('click', hideDetailPanelToTab);
document.getElementById('btn-favicon').addEventListener('click', showFaviconPanel);
document.getElementById('btn-favicon-back').addEventListener('click', hideDetailPanelToTab);
document.getElementById('btn-gen-adcopy').addEventListener('click', showAdCopyPanel);
document.getElementById('btn-adcopy-back').addEventListener('click', hideDetailPanelToTab);
document.getElementById('btn-adcopy-regen').addEventListener('click', () => { if (typeof generateAdCopy === 'function') generateAdCopy(true); });
document.getElementById('btn-gen-negatives').addEventListener('click', showNegativesPanel);
document.getElementById('btn-negatives-back').addEventListener('click', hideDetailPanelToTab);
document.getElementById('btn-negatives-regen').addEventListener('click', () => { if (typeof generateNegatives === 'function') generateNegatives(true); });
document.getElementById('btn-negatives-commit').addEventListener('click', () => { if (typeof commitNegatives === 'function') commitNegatives(document.getElementById('btn-negatives-commit')); });
document.getElementById('btn-gen-addkw').addEventListener('click', () => showAddKwPanel('ads'));
document.getElementById('btn-gen-addkw-gsc').addEventListener('click', () => showAddKwPanel('gsc'));
document.getElementById('btn-addkw-back').addEventListener('click', hideDetailPanelToTab);
document.getElementById('btn-addkw-regen').addEventListener('click', () => { if (typeof generateAddKw === 'function') generateAddKw(true); });
document.getElementById('btn-addkw-commit').addEventListener('click', () => { if (typeof commitAddKw === 'function') commitAddKw(document.getElementById('btn-addkw-commit')); });
document.getElementById('btn-addkw-export-txt').addEventListener('click', () => { if (typeof handleAddKwExportTxt === 'function') handleAddKwExportTxt(document.getElementById('btn-addkw-export-txt')); });
document.getElementById('btn-addkw-export-copy').addEventListener('click', () => { if (typeof handleAddKwExportCopy === 'function') handleAddKwExportCopy(document.getElementById('btn-addkw-export-copy')); });
document.getElementById('btn-addkw-export-doc').addEventListener('click', () => { if (typeof handleAddKwExportDoc === 'function') handleAddKwExportDoc(document.getElementById('btn-addkw-export-doc')); });
document.getElementById('btn-adgroup-back').addEventListener('click', hideDetailPanelToTab);
document.getElementById('btn-backlinks').addEventListener('click', showBacklinksPanel);
document.getElementById('btn-backlinks-back').addEventListener('click', hideDetailPanelToTab);
document.getElementById('btn-siteaudit').addEventListener('click', showSiteAuditPanel);
document.getElementById('btn-siteaudit-back').addEventListener('click', hideDetailPanelToTab);
document.getElementById('btn-utm').addEventListener('click', showUtmPanel);
document.getElementById('btn-utm-back').addEventListener('click', hideDetailPanelToTab);

// ─── Main tabs (Overview / Search / Analytics / DNS / Redirect) ──────────────
// The status pill is also a tab trigger (data-tab="redirect"), so the handler
// targets every [data-tab] in the tab group, not just .tab-btn.

document.querySelectorAll('#main-tabs [data-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    const inSettings = !settingsPanel.classList.contains('hidden');
    const inPanel = inSettings
      || !schemaPanel.classList.contains('hidden')
      || !ogPanel.classList.contains('hidden')
      || !twPanel.classList.contains('hidden')
      || !hreflangPanel.classList.contains('hidden')
      || !faviconPanel.classList.contains('hidden')
      || !adcopyPanel.classList.contains('hidden')
      || !negativesPanel.classList.contains('hidden')
      || !addkwPanel.classList.contains('hidden')
      || !adgroupPanel.classList.contains('hidden')
      || !backlinksPanel.classList.contains('hidden')
      || !siteauditPanel.classList.contains('hidden')
      || !utmPanel.classList.contains('hidden');
    if (tab === activeTab && !inPanel) return;
    activeTab = tab;
    // Settings reloads page data on exit; other panels just return to the tab
    if (inSettings) hideSettings();
    else showActiveTab();
    // GA and DNS data load lazily, on first look at the tab (caches keep it cheap)
    if (tab === 'analytics' && typeof loadGaData === 'function') loadGaData(false);
    if (tab === 'ads' && typeof loadAdsData === 'function') loadAdsData(false);
    if (tab === 'ranking' && typeof loadWebceoData === 'function') loadWebceoData(false);
    if (tab === 'dns' && typeof loadDnsData === 'function') loadDnsData();
  });
});
