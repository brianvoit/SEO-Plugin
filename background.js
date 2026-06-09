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
