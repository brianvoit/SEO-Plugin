// Entry point: sidebar embed mode, the update checker, and the initial load.
// Loaded last — every other popup-*.js file must be loaded before this one.

// ─── Sidebar embed mode ───────────────────────────────────────────────────────

if (browser.extension.getViews({ type: 'sidebar' }).includes(window)) {
  document.body.classList.add('embed-sidebar');
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

loadGscPrefs().then(() => loadData());
