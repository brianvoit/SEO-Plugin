// Entry point: view detection (sidebar / pop-out window), follow-active-tab
// auto refresh, the update checker, and the initial load.
// Loaded last — every other popup-*.js file must be loaded before this one.

// ─── View detection: sidebar / pop-out window ────────────────────────────────

const IS_SIDEBAR = browser.extension.getViews({ type: 'sidebar' }).includes(window);
const IS_WINDOW  = new URLSearchParams(location.search).get('view') === 'window';

if (IS_SIDEBAR) document.body.classList.add('embed-sidebar');
// The pop-out window reuses the sidebar's fluid sizing, plus its own marker
// class (getActiveTab targets the browser's last normal window instead of
// this window's own extension page).
if (IS_WINDOW) document.body.classList.add('embed-sidebar', 'embed-window');

// ─── Follow active tab (sidebar / pop-out only) ──────────────────────────────
// The anchored popup closes on any outside click, so it never needs this.

if (IS_SIDEBAR || IS_WINDOW) {
  let followEnabled = true;
  let followTimer = null;

  browser.storage.local.get('followActiveTab').then(({ followActiveTab }) => {
    followEnabled = followActiveTab !== false;
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.followActiveTab) {
      followEnabled = changes.followActiveTab.newValue !== false;
    }
  });

  const scheduleFollowRefresh = () => {
    if (!followEnabled) return;
    clearTimeout(followTimer);
    followTimer = setTimeout(() => {
      metaExpanded = false;
      if (typeof clearGenResults === 'function') clearGenResults();
      loadData(false);
    }, 400);
  };

  // The redirect trace is deliberately independent of follow-active-tab: the
  // status pill and trace should ALWAYS reflect the tab you're actually on, so
  // you never miss a redirect chain. When following is on, loadData() already
  // refreshes it, so this only does the work when following is off.
  const refreshRedirectIndependent = () => {
    if (followEnabled) return;
    getActiveTab()
      .then(tab => { if (tab) renderRedirectStatus(tab.id, null); })
      .catch(() => {});
  };

  browser.tabs.onActivated.addListener(() => { scheduleFollowRefresh(); refreshRedirectIndependent(); });
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tab.active && changeInfo.status === 'complete') { scheduleFollowRefresh(); refreshRedirectIndependent(); }
  });
  // Pop-out: switching focus between browser windows changes the target tab
  browser.windows.onFocusChanged.addListener(windowId => {
    if (IS_WINDOW && windowId !== browser.windows.WINDOW_ID_NONE) { scheduleFollowRefresh(); refreshRedirectIndependent(); }
  });
}

// ─── Update checker ──────────────────────────────────────────────────────────

const GITHUB_REPO = 'brianvoit/SEO-Plugin';

const currentVersion = browser.runtime.getManifest().version;
document.getElementById('update-version').textContent = `v${currentVersion}`;

async function checkForUpdates() {
  const btn      = document.getElementById('btn-check-update');
  const statusEl = document.getElementById('update-status');

  btn.disabled = true;
  btn.textContent = 'Checking…';
  statusEl.className = 'update-status hidden';

  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      { headers: { Accept: 'application/vnd.github+json' } }
    );
    if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
    const data = await res.json();
    const latest = data.tag_name?.replace(/^v/, '') ?? null;
    if (!latest) throw new Error('Could not read version from GitHub');

    statusEl.classList.remove('hidden', 'is-available', 'is-error');

    if (latest === currentVersion) {
      statusEl.textContent = 'Up to date';
    } else {
      statusEl.textContent = `v${latest} available →`;
      statusEl.classList.add('is-available');
      statusEl.title = 'Click to view release on GitHub';
      statusEl.addEventListener('click', () => {
        browser.tabs.create({ url: `https://github.com/${GITHUB_REPO}/releases/latest` });
      }, { once: true });
    }
  } catch (err) {
    statusEl.classList.remove('hidden', 'is-available');
    statusEl.classList.add('is-error');
    statusEl.textContent = 'Check failed';
    statusEl.title = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Check for updates';
  }
}

document.getElementById('btn-check-update').addEventListener('click', checkForUpdates);

// ─── Init ────────────────────────────────────────────────────────────────────

Promise.all([loadGscPrefs(), loadGaPrefs(), loadAdsPrefs(), loadWebceoPrefs()]).then(async () => {
  // Firefox MV3: host access is optional and off by default, so on a fresh
  // install the extension can't read the page and the Overview comes up empty.
  // Send first-time users straight to Setup (which has the Grant Page Access
  // button) once, instead of a broken Overview. After they've been prompted
  // once, load normally — the Grant button still lives in Setup if they
  // declined and change their mind.
  try {
    if (typeof hasPageAccess === 'function' && !(await hasPageAccess())) {
      const { pageAccessPrompted } = await browser.storage.local.get('pageAccessPrompted');
      if (!pageAccessPrompted) {
        await browser.storage.local.set({ pageAccessPrompted: true });
        if (typeof showSettings === 'function') { showSettings(); return; }
      }
    }
  } catch { /* fall through to a normal load */ }
  loadData();
});
