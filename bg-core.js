// The extension background, split across several files that share ONE global
// scope — Chrome loads them via importScripts() in the generated sw.js, Firefox
// via manifest background.scripts. There is no module system here: every
// top-level function and const is a global, exactly as when this was one file.
//
// Load order lives in scripts/build.mjs (BACKGROUND_FILES) and is mirrored in
// manifest.firefox.json; tests/background-split.test.mjs fails if the two drift.
// Order only matters for THIS file: bg-core.js is the only one that executes
// anything at load time. Every other file is pure declarations, so they may be
// reordered freely.

// Registered at top level rather than only in onInstalled: this is an MV3 event
// page, so the script re-runs whenever the background wakes, and removeAll →
// create is self-healing if the item ever goes missing. onInstalled alone fires
// only on install/update.
// Right-clicking the toolbar button exposes the three global toggles, so they
// can be flipped without opening the panel. All three are plain storage.local
// flags, which is what lets the menu, the popup and the content script stay in
// agreement (each observes storage rather than owning the state).
const SEO_TOGGLE_MENUS = [
  { id: 'seo-toggle-alt',    title: 'Alt Text Overlay',    key: 'altOverlayActive',  fallback: false },
  { id: 'seo-toggle-links',  title: 'Link Health Overlay', key: 'linkOverlayActive', fallback: false },
  { id: 'seo-toggle-follow', title: 'Follow Active Tab',   key: 'followActiveTab',   fallback: true }
];

// followActiveTab defaults ON when unset, the overlays default OFF — so an
// absent value must fall back per-item rather than to a single default.
function seoToggleChecked(item, stored) {
  const value = stored[item.key];
  return value === undefined ? item.fallback : !!value;
}

// Firefox's richer `menus` namespace where available (it alone has onShown /
// refresh), otherwise the `contextMenus` namespace both browsers implement.
const menus = browser.menus || browser.contextMenus;

function registerSeoMenus() {
  if (!menus) return;
  menus.removeAll(() => {
    menus.create({
      id: 'seo-generate-alt',
      title: 'Generate Alt Text',
      contexts: ['image']
    });
    SEO_TOGGLE_MENUS.forEach(item => {
      menus.create({
        id: item.id,
        title: item.title,
        type: 'checkbox',
        checked: item.fallback,
        contexts: ['action']
      });
    });
  });
}
registerSeoMenus();
browser.runtime.onInstalled.addListener(registerSeoMenus);

// Push current storage state onto the checkmarks. Safe to call at any time —
// menus.update on a missing id just rejects, which is why it's swallowed.
async function syncToggleCheckmarks() {
  if (!menus) return;
  const stored = await browser.storage.local.get(SEO_TOGGLE_MENUS.map(m => m.key));
  await Promise.all(SEO_TOGGLE_MENUS.map(item =>
    Promise.resolve(menus.update(item.id, { checked: seoToggleChecked(item, stored) })).catch(() => {})
  ));
}

if (menus && menus.onShown) {
  // Firefox: sync lazily, just before the menu paints. Cheapest and always
  // correct, since it reads storage at the moment of display.
  menus.onShown.addListener(async (info) => {
    if (!info.contexts || !info.contexts.includes('action')) return;
    await syncToggleCheckmarks();
    menus.refresh();
  });
} else if (menus) {
  // Chrome has neither onShown nor refresh, so the lazy approach is impossible
  // — the checkmarks have to be pushed eagerly instead. All three toggles are
  // storage.local flags written by four different places (this menu, the
  // content script, the panel's header button, and the Alt+I/L/F shortcuts),
  // so observing storage catches every one of them.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (SEO_TOGGLE_MENUS.some(m => m.key in changes)) syncToggleCheckmarks();
  });
  syncToggleCheckmarks();   // and once on wake, since the worker restarts often
}

menus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'seo-generate-alt') {
    // Target the exact frame that was right-clicked. The block editor renders
    // its canvas in an iframe, so a tab-wide send would reach the top document
    // — which doesn't contain the image — and silently do nothing.
    const opts = (info.frameId != null) ? { frameId: info.frameId } : undefined;
    browser.tabs.sendMessage(tab.id, {
      action: 'generateAltText',
      srcUrl: info.srcUrl
    }, opts);
    return;
  }

  const item = SEO_TOGGLE_MENUS.find(m => m.id === info.menuItemId);
  if (!item) return;

  if (item.key === 'followActiveTab') {
    const { followActiveTab } = await browser.storage.local.get('followActiveTab');
    await browser.storage.local.set({ followActiveTab: followActiveTab === false });
    return;
  }

  // The overlays are owned by the content script — it flips storage AND
  // applies/removes the on-page chips. Top frame only, matching every other
  // page read (see TOP_FRAME in popup-shared.js).
  const action = item.key === 'altOverlayActive' ? 'toggleAltOverlay' : 'toggleLinkOverlay';
  try {
    await browser.tabs.sendMessage(tab.id, { action }, { frameId: 0 });
  } catch {
    // No content script here (about:, PDF viewer, AMO), so storage was never
    // flipped — but the browser has already ticked the checkbox optimistically.
    // Firefox self-corrects via onShown on next open; Chrome has no such hook,
    // so put the checkmark back explicitly or it stays wrong indefinitely.
    syncToggleCheckmarks();
  }
});

// ─── Display mode: popup / sidebar / pop-out window ──────────────────────────
// In sidebar and window modes the toolbar button has no popup, so a click
// falls through to onClicked, which either toggles Firefox's native sidebar or
// opens (or focuses) the dedicated pop-out window.

// Firefox exposes a sidebar the extension can toggle itself; Chrome exposes a
// side panel it will only open in direct response to a user gesture. That
// difference drives the whole branch below.
const HAS_SIDEBAR_ACTION = typeof browser.sidebarAction !== 'undefined';
// Reached by bracket notation on purpose. AMO's addons-linter reports any
// static `browser.sidePanel.*` reference as UNSUPPORTED_API even inside a
// capability check, and the Firefox build has to stay at zero warnings to be
// signed. Resolving the namespace once here keeps the call sites readable.
const sidePanel = browser['sidePanel'];
const HAS_SIDE_PANEL = typeof sidePanel !== 'undefined';

async function applyDisplayMode() {
  const { displayMode } = await browser.storage.local.get('displayMode');
  const mode = displayMode || 'sidebar';   // default to sidebar when unset
  await browser.action.setPopup({ popup: mode === 'popup' ? 'popup.html' : '' });

  // Chrome can't open the panel from onClicked: the gesture context is lost
  // across the awaited storage read, and there is no toggle() either. Instead
  // hand the behaviour to Chrome — with this set, clicking the toolbar icon
  // opens and closes the panel natively, no listener involved.
  if (HAS_SIDE_PANEL) {
    await sidePanel
      .setPanelBehavior({ openPanelOnActionClick: mode === 'sidebar' })
      .catch(() => {});
  }
}

applyDisplayMode();

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.displayMode) applyDisplayMode();
});

browser.action.onClicked.addListener(async () => {
  const { displayMode } = await browser.storage.local.get('displayMode');
  const mode = displayMode || 'sidebar';
  if (mode === 'window') { openPopoutWindow(); return; }
  // Firefox only. Its user-input context survives the promise chain above, so
  // toggling here still counts as gesture-driven. On Chrome this listener
  // doesn't even fire for sidebar mode — setPanelBehavior already handled it.
  if (HAS_SIDEBAR_ACTION) browser.sidebarAction.toggle();
});

// Chrome's Alt+M can't be a reserved _execute_sidebar_action command the way
// Firefox's is, so it arrives here as a named command instead. open() must be
// called synchronously off the event to keep the gesture, which is why the
// window id is read first and no storage lookup happens in between.
if (browser.commands?.onCommand) {
  browser.commands.onCommand.addListener((command, tab) => {
    if (command !== 'toggle-side-panel' || !HAS_SIDE_PANEL) return;
    // sidePanel.open() must be called while the user gesture is still in
    // scope, and Chrome drops that context across an await — the same reason
    // the panel can't be opened from action.onClicked. onCommand hands us the
    // active tab, so the window id is available without one.
    if (tab?.windowId != null) {
      sidePanel.open({ windowId: tab.windowId }).catch(() => {});
      return;
    }
    // tab is documented as optional. Falling back to a lookup may lose the
    // gesture and be rejected, but that beats not responding to the shortcut.
    browser.windows.getCurrent()
      .then(win => sidePanel.open({ windowId: win.id }))
      .catch(() => {});
  });
}

// ─── Pop-out window ───────────────────────────────────────────────────────────

const POPOUT_KEY = 'popoutWindowId';

async function openPopoutWindow() {
  try {
    const stored = await browser.storage.session.get(POPOUT_KEY);
    const existingId = stored[POPOUT_KEY];
    if (existingId != null) {
      const win = await browser.windows.get(existingId).catch(() => null);
      if (win) { await browser.windows.update(existingId, { focused: true }); return; }
    }
  } catch { /* fall through to create */ }

  const win = await browser.windows.create({
    url: browser.runtime.getURL('popup.html?view=window'),
    type: 'popup',
    width: 460,
    height: 720
  });
  browser.storage.session.set({ [POPOUT_KEY]: win.id }).catch(() => {});
}

browser.windows.onRemoved.addListener(async windowId => {
  try {
    const stored = await browser.storage.session.get(POPOUT_KEY);
    if (stored[POPOUT_KEY] === windowId) await browser.storage.session.remove(POPOUT_KEY);
  } catch { /* ignore */ }
});

// ─── Target tab for the pop-out window ───────────────────────────────────────
// Inside a pop-out, tabs.query({currentWindow:true}) returns the pop-out's own
// extension page, so the background tracks the active tab of the last focused
// *normal* window and hands it to the popup via getTargetTab.

browser.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const win = await browser.windows.get(windowId).catch(() => null);
  if (win && win.type === 'normal') {
    browser.storage.session.set({ lastNormalTab: tabId }).catch(() => {});
  }
});

browser.windows.onFocusChanged.addListener(async windowId => {
  if (windowId === browser.windows.WINDOW_ID_NONE) return;
  const win = await browser.windows.get(windowId, { populate: true }).catch(() => null);
  if (win && win.type === 'normal') {
    const active = (win.tabs || []).find(t => t.active);
    if (active) browser.storage.session.set({ lastNormalTab: active.id }).catch(() => {});
  }
});

// Inject content.js into a tab on demand. Runs from the background, where
// browser.scripting is reliably available (unlike the sidebar/popup context,
// where the same call can silently fail). Used by getPageDataFromTab when the
// content script isn't answering — a tab that was already open before the
// extension loaded never got the manifest's auto-injection. content.js guards
// itself against double-load, so injecting when it's already present is a
// harmless no-op rather than a redeclaration error.
async function injectContentScript({ tabId }) {
  if (tabId == null) return { ok: false, error: 'NO_TAB' };
  try {
    await browser.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function getTargetTab() {
  try {
    const { lastNormalTab } = await browser.storage.session.get('lastNormalTab');
    if (lastNormalTab != null) {
      const tab = await browser.tabs.get(lastNormalTab).catch(() => null);
      if (tab) return tab;
    }
  } catch { /* storage.session unavailable */ }
  // Fallback: the focused (or first) normal window's active tab
  const wins = await browser.windows.getAll({ populate: true });
  const normals = wins.filter(w => w.type === 'normal');
  const target = normals.find(w => w.focused) || normals[0];
  return target ? (target.tabs || []).find(t => t.active) || null : null;
}

// ─── Redirect trace: status code + redirect chain per tab ───────────────────
// Observe-only webRequest on top-level navigations, so the popup can show how
// you arrived at the current page (direct vs. via redirects) and the full chain.
//
// The background is an MV3 event page, so the in-memory Map is only a
// write-through cache: every update is mirrored to storage.session (which
// survives event-page suspension and clears on browser exit), and reads fall
// back to it after a restart of the event page.

const redirectByTab = new Map();   // tabId -> { requestId, chain:[{url,status,kind?}], finalUrl, finalStatus, error, done, prevChain }

const REDIRECT_FILTER = { urls: ['*://*/*'], types: ['main_frame'] };
const REDIRECT_MAX_HOPS = 12;      // cap stitched chains (JS redirect loops)

function redirectKey(tabId) { return `redirect:${tabId}`; }

function saveRedirect(tabId, entry) {
  redirectByTab.set(tabId, entry);
  browser.storage.session.set({ [redirectKey(tabId)]: entry }).catch(() => {});
}

async function loadRedirect(tabId) {
  if (redirectByTab.has(tabId)) return redirectByTab.get(tabId);
  try {
    const stored = await browser.storage.session.get(redirectKey(tabId));
    const entry = stored[redirectKey(tabId)] || null;
    if (entry) redirectByTab.set(tabId, entry);
    return entry;
  } catch {
    return null;
  }
}

// Runs `fn` against a tab's redirect entry, rehydrating from storage.session
// when the in-memory Map has lost it.
//
// Chrome terminates the service worker after ~30s idle, which empties the Map.
// Rehydrating at top level doesn't help: Chrome runs module code BEFORE
// dispatching the event that woke the worker, so an async restore is still in
// flight when the first listener fires. The listeners below used to read the
// Map synchronously and bail on a miss, silently dropping the redirect chain
// for any navigation that straddled a restart.
//
// Two properties matter here:
//   * the warm case stays fully SYNCHRONOUS, so Firefox's blocking
//     onHeadersReceived listener isn't made to wait on a promise chain during
//     page load — that path behaves exactly as it did before
//   * cold reads are serialized per tab, so two events that both miss can't
//     read-modify-write over each other and lose a hop
const _redirectQueue = new Map();   // tabId -> tail promise of that tab's work

function withRedirectEntry(tabId, fn) {
  // Warm and idle: no awaits, no queue — the original code path.
  if (!_redirectQueue.has(tabId) && redirectByTab.has(tabId)) {
    return fn(redirectByTab.get(tabId));
  }

  const prev = _redirectQueue.get(tabId) || Promise.resolve();
  const next = prev
    .then(async () => {
      // `entry` may legitimately be null (no navigation recorded yet) —
      // callers decide, exactly as they did with the bare Map lookup.
      const entry = redirectByTab.has(tabId) ? redirectByTab.get(tabId) : await loadRedirect(tabId);
      return fn(entry);
    })
    .catch(() => { /* one failed hop must not wedge the tab's queue */ });

  _redirectQueue.set(tabId, next);
  // Keep the queue from growing per tab for the life of the worker.
  next.then(() => { if (_redirectQueue.get(tabId) === next) _redirectQueue.delete(tabId); });
  return next;
}

// Toolbar/sidebar icon badge: the page's final status code, colour-coded the
// same way the popup's status badge is (a 2xx reached via redirects reads amber).
const BADGE_COLORS = { ok: '#16a34a', redirect: '#d97706', error: '#dc2626', server: '#6b7280' };

function badgeLevelFor(status, redirectCount) {
  let base;
  if (status >= 200 && status < 300) base = 'ok';
  else if (status >= 300 && status < 400) base = 'redirect';
  else if (status >= 400 && status < 500) base = 'error';
  else base = 'server';
  return (base === 'ok' && redirectCount > 0) ? 'redirect' : base;
}

// The badge shows the FIRST status on the path, not the last. The point of the
// badge is to flag that a redirect happened at all — a page that 301s to a 200
// should read as "301", because a plain "200" hides the hop entirely. When
// nothing redirected, the first hop IS the last, so it shows the final code.
function firstStatusOf(entry) {
  if (entry && entry.chain && entry.chain.length && entry.chain[0].status != null) {
    return entry.chain[0].status;
  }
  return entry ? entry.finalStatus : null;
}

function countChainRedirects(chain) {
  return (chain || []).filter(h => (h.status >= 300 && h.status < 400) || h.kind === 'client').length;
}

// "{first status}:{redirect count}" — e.g. 301:1, 307:3. A page that didn't
// redirect shows the bare code (200), since ":0" is noise on the common case.
function badgeTextFor(status, redirectCount) {
  return redirectCount > 0 ? `${status}:${redirectCount}` : String(status);
}

// Paint the badge from a finished entry. Safe to call repeatedly — the client
// redirect stitch re-runs it once the previous chain is prepended.
function paintBadgeFromEntry(tabId, entry) {
  if (!entry || entry.finalStatus == null) return;
  const first = firstStatusOf(entry);
  if (first == null) return;
  const redirectCount = countChainRedirects(entry.chain);
  setActionBadge(tabId, badgeTextFor(first, redirectCount), badgeLevelFor(first, redirectCount));
}

function setActionBadge(tabId, text, level) {
  browser.action.setBadgeText({ text, tabId });
  if (!level) return;
  browser.action.setBadgeBackgroundColor({ color: BADGE_COLORS[level], tabId });
  if (browser.action.setBadgeTextColor) {
    browser.action.setBadgeTextColor({ color: '#ffffff', tabId });
  }
}

browser.webRequest.onBeforeRequest.addListener(details => {
  if (details.frameId !== 0) return;
  // Keep the finished previous chain around until onCommitted tells us whether
  // this navigation is a client (JS/meta) redirect — if so it gets stitched on.
  // Goes through the queue so the lookup survives a worker restart and stays
  // ordered against any still-pending work for this tab.
  withRedirectEntry(details.tabId, prev => {
    // A server redirect fires onBeforeRequest AGAIN for the redirect target,
    // carrying the SAME requestId. Without this guard the reset below wipes
    // the hop onBeforeRedirect recorded moments earlier, and what survives
    // looks like a direct navigation straight to the destination — which is
    // how a plain 301 came to be reported as "Redirects: 0", contradicting the
    // Link Health overlay that had flagged the very same link.
    //
    // Only a genuinely new navigation starts a fresh chain: a different
    // requestId, or the same one after it has finished.
    if (prev && !prev.done && prev.requestId === details.requestId) return;
    saveRedirect(details.tabId, {
      requestId: details.requestId,
      chain: [],
      finalUrl: null,
      finalStatus: null,
      error: null,
      done: false,
      startedAt: details.timeStamp,
      _lastTs: details.timeStamp,
      _pending: null,
      prevChain: (prev && prev.done && prev.chain && prev.chain.length) ? prev.chain : null
    });
  });
  setActionBadge(details.tabId, '');   // clear while the new navigation loads
}, REDIRECT_FILTER);

// Pull per-hop metadata off a hop's response: how long it took, whether it
// came from cache, the cookies it set, and any X-Robots-Tag directive.
function takePendingHopMeta(entry, details) {
  const ms = entry._lastTs != null ? Math.max(0, Math.round(details.timeStamp - entry._lastTs)) : null;
  entry._lastTs = details.timeStamp;
  const pending = entry._pending || {};
  entry._pending = null;
  return { ms, fromCache: !!details.fromCache, cookies: pending.cookies || [], xRobots: pending.xRobots || null };
}

browser.webRequest.onBeforeRedirect.addListener(details => {
  if (details.frameId !== 0) return;
  withRedirectEntry(details.tabId, entry => {
    if (!entry || entry.requestId !== details.requestId) return;
    entry.chain.push({ url: details.url, status: details.statusCode, ...takePendingHopMeta(entry, details) });
    saveRedirect(details.tabId, entry);
  });
}, REDIRECT_FILTER);

browser.webRequest.onCompleted.addListener(details => {
  if (details.frameId !== 0) return;
  withRedirectEntry(details.tabId, entry => {
    if (!entry || entry.requestId !== details.requestId) return;
    entry.chain.push({ url: details.url, status: details.statusCode, ...takePendingHopMeta(entry, details) });
    entry.finalUrl = details.url;
    entry.finalStatus = details.statusCode;
    entry.done = true;
    entry.totalMs = entry.startedAt != null ? Math.max(0, Math.round(details.timeStamp - entry.startedAt)) : null;
    saveRedirect(details.tabId, entry);
    paintBadgeFromEntry(details.tabId, entry);
    browser.runtime.sendMessage({ action: 'redirectUpdated', tabId: details.tabId }).catch(() => {});
  });
}, REDIRECT_FILTER);

browser.webRequest.onErrorOccurred.addListener(details => {
  if (details.frameId !== 0) return;
  withRedirectEntry(details.tabId, entry => {
    if (!entry || entry.requestId !== details.requestId) return;
    entry.error = details.error;
    entry.done = true;
    saveRedirect(details.tabId, entry);
    // Skip user-initiated cancellations (clicking away mid-load)
    if (!/aborted/i.test(details.error || '')) {
      setActionBadge(details.tabId, 'ERR', 'server');
    }
  });
}, REDIRECT_FILTER);

// Security headers + TLS details for the document response. Captured here
// (not via an external API) — getSecurityInfo only works inside a blocking
// onHeadersReceived listener for the live request.
//
// Both halves of that are Firefox-only: Chrome MV3 removed blocking
// webRequest for non-policy extensions, and has no getSecurityInfo at all.
// They stand or fall together, so one capability check drives both — on
// Chrome the listener registers observationally (security headers, cookies
// and X-Robots-Tag still work) and the DNS tab's TLS panel shows #tls-note,
// which popup-dns.js already renders whenever `tls` is absent.
const CAN_READ_TLS = typeof browser.webRequest.getSecurityInfo === 'function';
const HEADERS_SPEC = CAN_READ_TLS ? ['blocking', 'responseHeaders'] : ['responseHeaders'];
const SECURITY_HEADER_NAMES = [
  'strict-transport-security',
  'content-security-policy',
  'x-frame-options',
  'x-content-type-options',
  'referrer-policy',
  'permissions-policy'
];

browser.webRequest.onHeadersReceived.addListener(details => {
  if (details.frameId !== 0) return;
  // Returned so Firefox's blocking listener waits for the getSecurityInfo read
  // below. withRedirectEntry keeps the warm case synchronous, so in practice
  // this only becomes a real promise after a service-worker restart.
  return withRedirectEntry(details.tabId, async entry => {
    if (!entry || entry.requestId !== details.requestId) return;

    // Final hop's headers win (each redirect hop overwrites the previous)
    const headers = {};
    const cookies = [];
    let xRobots = null;
    for (const h of details.responseHeaders || []) {
      const name = h.name.toLowerCase();
      if (SECURITY_HEADER_NAMES.includes(name)) headers[name] = h.value || '';
      if (name === 'set-cookie') {
        // A Set-Cookie value can carry multiple cookies on separate lines
        (h.value || '').split('\n').forEach(line => {
          const cookieName = line.split('=')[0].trim();
          if (cookieName) cookies.push(cookieName);
        });
      }
      if (name === 'x-robots-tag') xRobots = h.value || '';
    }
    entry.securityHeaders = headers;
    // Stashed for the hop that onBeforeRedirect/onCompleted is about to push
    entry._pending = { cookies, xRobots };

    if (CAN_READ_TLS && details.url.startsWith('https:')) {
      try {
        const sec = await browser.webRequest.getSecurityInfo(details.requestId, {});
        const cert = sec.certificates && sec.certificates[0];
        entry.tls = {
          state: sec.state,                       // secure | weak | broken | insecure
          protocol: sec.protocolVersion || null,
          cipher: sec.cipherSuite || null,
          issuer: cert?.issuer || null,
          subject: cert?.subject || null,
          validityStart: cert?.validity?.start ?? null,
          validityEnd: cert?.validity?.end ?? null
        };
      } catch { /* security info unavailable for this request */ }
    }
    saveRedirect(details.tabId, entry);
  });
}, REDIRECT_FILTER, HEADERS_SPEC);

// JS/meta redirects start a brand-new request, which webRequest sees as an
// unrelated navigation. onCommitted's transitionQualifiers identifies them, so
// the previous page's chain gets stitched onto this one instead of dropped.
browser.webNavigation.onCommitted.addListener(details => {
  if (details.frameId !== 0) return;
  withRedirectEntry(details.tabId, entry => {
    if (!entry || !entry.prevChain) return;
    if ((details.transitionQualifiers || []).includes('client_redirect')) {
      const prev = entry.prevChain.map(h => ({ ...h }));
      prev[prev.length - 1].kind = 'client';   // junction hop: page issued a JS/meta redirect
      entry.chain = prev.concat(entry.chain).slice(-REDIRECT_MAX_HOPS);
      // Stitching prepends hops, so the first status just changed — repaint (a
      // no-op while the new navigation is still in flight).
      paintBadgeFromEntry(details.tabId, entry);
      browser.runtime.sendMessage({ action: 'redirectUpdated', tabId: details.tabId }).catch(() => {});
    }
    entry.prevChain = null;
    saveRedirect(details.tabId, entry);
  });
});

browser.tabs.onRemoved.addListener(tabId => {
  redirectByTab.delete(tabId);
  _redirectQueue.delete(tabId);
  browser.storage.session.remove(redirectKey(tabId)).catch(() => {});
});

function getRedirectInfo({ tabId }) {
  return loadRedirect(tabId);
}

// ─── Active redirect trace ──────────────────────────────────────────────────
// The passive trace above only shows what the browser actually did to arrive at
// the page. This actively re-requests a URL and follows the whole chain, so the
// canonical path (http→https, non-www→www, trailing slash, …) always shows even
// when you're already sitting on the final URL. We fire our own background fetch
// and read each hop off webRequest (a plain fetch with redirect:'manual' returns
// an opaque response with no status/Location; our host permissions let
// webRequest see every cross-origin hop instead).

const TRACE_TIMEOUT_MS = 12000;

// Trace the page's actual URL so the chain reflects how this specific URL
// behaves — no synthesized bare-domain variant.
async function traceUrl({ pageUrl }) {
  let url;
  try { url = new URL(pageUrl).href; }
  catch { return { error: 'BAD_URL', hops: [] }; }
  if (!/^https?:/i.test(url)) return { error: 'BAD_URL', hops: [] };
  return traceOnce(url);
}

function traceOnce(startUrl) {
  return new Promise(resolve => {
    const filter = { urls: ['*://*/*'], types: ['xmlhttprequest'] };
    const abort = new AbortController();
    const trace = { startUrl, requestId: null, lastTs: null, hops: [], error: null };
    let settled = false;

    const cleanup = () => {
      browser.webRequest.onBeforeRequest.removeListener(onReq);
      browser.webRequest.onBeforeRedirect.removeListener(onRedir);
      browser.webRequest.onCompleted.removeListener(onDone);
      browser.webRequest.onErrorOccurred.removeListener(onErr);
      clearTimeout(timer);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        startUrl,
        hops: trace.hops,
        finalUrl: trace.hops.length ? trace.hops[trace.hops.length - 1].url : null,
        finalStatus: trace.hops.length ? trace.hops[trace.hops.length - 1].status : null,
        error: trace.hops.length ? null : trace.error
      });
    };
    const hopMs = ts => {
      const ms = trace.lastTs != null ? Math.max(0, Math.round(ts - trace.lastTs)) : 0;
      trace.lastTs = ts;
      return ms;
    };

    // Only our own background fetch (extension origin, no tab) starts the chain.
    // Firefox reports the initiating page as `originUrl`, Chrome as `initiator`
    // (and with a chrome-extension:// scheme), so accept either — matching only
    // the Firefox pair left every Chrome trace unmatched and timing out.
    const onReq = d => {
      if (trace.requestId != null) return;
      const from = d.originUrl || d.initiator || '';
      const isSelf = from.startsWith('moz-extension://') || from.startsWith('chrome-extension://');
      if (d.url === startUrl && d.tabId === -1 && isSelf) {
        trace.requestId = d.requestId;
        trace.lastTs = d.timeStamp;
      }
    };
    const onRedir = d => {
      if (d.requestId !== trace.requestId) return;
      const internal = /internal redirect/i.test(d.statusLine || '');
      trace.hops.push({ url: d.url, status: d.statusCode, ms: hopMs(d.timeStamp), fromCache: !!d.fromCache, kind: internal ? 'internal' : null });
      if (trace.hops.length >= REDIRECT_MAX_HOPS) { abort.abort(); finish(); }
    };
    const onDone = d => {
      if (d.requestId !== trace.requestId) return;
      trace.hops.push({ url: d.url, status: d.statusCode, ms: hopMs(d.timeStamp), fromCache: !!d.fromCache, final: true });
      finish();
    };
    const onErr = d => {
      if (d.requestId !== trace.requestId) return;
      trace.error = d.error;
      finish();
    };

    browser.webRequest.onBeforeRequest.addListener(onReq, filter);
    browser.webRequest.onBeforeRedirect.addListener(onRedir, filter);
    browser.webRequest.onCompleted.addListener(onDone, filter);
    browser.webRequest.onErrorOccurred.addListener(onErr, filter);

    const timer = setTimeout(() => { trace.error = trace.error || 'TIMEOUT'; abort.abort(); finish(); }, TRACE_TIMEOUT_MS);

    fetch(startUrl, { method: 'GET', redirect: 'follow', cache: 'no-store', credentials: 'omit', signal: abort.signal })
      .then(() => setTimeout(finish, 60))   // onCompleted normally finishes first; backstop
      .catch(err => { if (!trace.hops.length) trace.error = trace.error || String(err && err.message || err); setTimeout(finish, 60); });
  });
}

// ─── Shared helpers ──────────────────────────────────────────────────────────
// These four came from the Search Console section and kept their gsc* names,
// but they are generic and always were: gscPageHost is the app's host
// normaliser (24 call sites outside GSC), and gscFormatDate builds the date
// params every Google API takes. They live here so bg-ads/bg-ga/bg-webceo/
// bg-export don't have to reach into bg-gsc.js for them.
//
// GSC_CACHE_LIMIT stays as the cap those caches have always used; the pruning
// itself now lives in writeCache below, which every cache write goes through.
//
// The names are deliberately left alone: renaming would touch 34 call sites for
// no behavioural gain, and belongs to its own pass if it's ever wanted.

const GSC_CACHE_LIMIT = 20;

function gscFormatDate(d) {
  return d.toISOString().slice(0, 10);
}

function gscPageHost(pageUrl) {
  try { return new URL(pageUrl).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return null; }
}


// ─── Cache writes ────────────────────────────────────────────────────────────
// Every fetch-and-cache path in the background ends the same way: stash the
// result under a storage key, then return it. Two problems lived in that one
// line, and both are the kind that only appear on somebody else's machine.
//
// 1. UNGUARDED WRITE. The set() sat between a successful API fetch and its
//    return, unawaited by any try/catch. If storage.local rejected — quota is
//    the realistic cause — the whole handler rejected with it, so a fetch that
//    had actually SUCCEEDED was reported to the user as a failure. It would
//    only start happening once an install had accumulated enough data, which
//    makes it close to impossible to reproduce from a bug report. Losing a
//    cache entry is the right trade: the caller still returns real data and
//    the next call refetches.
//
// 2. NO SIZE BOUND on the WebCEO caches and driveExportFolderIds, so they grew
//    for the life of the install.
//
// ── On the cap, and why it is set where it is ────────────────────────────────
// CACHE_CAP_GENEROUS is deliberately far above any working set this extension
// should ever hold. Every cache routed through here is keyed by PROJECT or
// DOMAIN — one entry per client — so a large agency sits in the tens. The cap
// is a backstop against a pathological case, NOT a working-set limit, and it
// should never evict in normal use.
//
// That is why eviction logs. If this warning ever appears in the wild it means
// an assumption here is wrong — most likely a cache key that turned out to be
// more granular than "per project" (a per-URL key would blow through this) —
// and the fix is to look at the key, not to quietly raise the number. Treat a
// sighting as a bug report about this comment.
//
// KNOWN LIMITATION, recorded so a future reader doesn't mistake it for a bug:
// eviction is FIFO by fetch time, not LRU. Entries carry `fetchedAt` (when
// they were WRITTEN) and reading one does not refresh it, because refreshing
// would mean a storage write on every cache HIT — more cost than the eviction
// it avoids. The consequence is that the entry dropped is the oldest fetch,
// not the least recently used, so a heavily-used project can be evicted for
// being stale-by-write-time. At the cap above this is theoretical; it would
// only start to matter if the cap were ever lowered toward a real working set.
const CACHE_CAP_GENEROUS = 200;

/**
 * Prunes a cache to `cap` entries and persists it, surviving a failed write.
 * Returns true if it persisted, false if the write was dropped.
 */
async function writeCache(storageKey, cache, cap = CACHE_CAP_GENEROUS) {
  const keys = Object.keys(cache);
  if (keys.length > cap) {
    // Most entries stamp `fetchedAt`; sheetsSpreadsheetIds uses `updatedAt`.
    // Accepting either keeps that cache's existing eviction order rather than
    // silently degrading it to "arbitrary" when the field is missing.
    const stamp = (k) => (cache[k] && (cache[k].fetchedAt ?? cache[k].updatedAt)) || 0;
    keys.sort((a, b) => stamp(a) - stamp(b));
    const evicted = keys.slice(0, keys.length - cap);
    evicted.forEach(k => delete cache[k]);
    console.warn(
      `[cache] ${storageKey} reached its ${cap}-entry cap and evicted ${evicted.length}. ` +
      `Caches here are keyed per project/domain and should never get this large — ` +
      `check whether the key is more granular than intended rather than raising the cap.`
    );
  }
  try {
    await browser.storage.local.set({ [storageKey]: cache });
    return true;
  } catch (e) {
    // Never let a cache write fail the operation that produced the data.
    console.warn(`[cache] ${storageKey} could not be persisted (${(e && e.message) || e}); continuing uncached.`);
    return false;
  }
}
