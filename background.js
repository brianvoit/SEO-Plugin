browser.runtime.onInstalled.addListener(() => {
  browser.menus.removeAll(() => {
    browser.menus.create({
      id: 'seo-generate-alt',
      title: 'Generate Alt Text',
      contexts: ['image']
    });
  });
});

browser.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'seo-generate-alt') {
    browser.tabs.sendMessage(tab.id, {
      action: 'generateAltText',
      srcUrl: info.srcUrl
    });
  }
});

// ─── Display mode: popup vs. sidebar ────────────────────────────────────────
// In sidebar mode the toolbar button has no popup, so a click falls through to
// onClicked, which toggles Firefox's native sidebar (a real viewport resize).

async function applyDisplayMode() {
  const { displayMode } = await browser.storage.local.get('displayMode');
  const useSidebar = displayMode === 'sidebar';
  await browser.action.setPopup({ popup: useSidebar ? '' : 'popup.html' });
}

applyDisplayMode();

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.displayMode) applyDisplayMode();
});

browser.action.onClicked.addListener(() => {
  browser.sidebarAction.toggle();
});
