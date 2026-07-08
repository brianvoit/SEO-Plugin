// Shared "+ Annotation" modal (Analytics + Tracked tabs). Writes a dated note
// to GA4 (reportingDataAnnotations, needs the analytics.edit scope) and/or Web
// CEO (add_event) in one action. Targets are auto-checked based on what's
// connected for the current page.

let _annotationPageUrl = '';
let _annotationBusy = false;

function annotationTodayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function showAnnotationStatus(msg, isError, actionLabel, onAction) {
  const el = document.getElementById('annotation-status');
  el.replaceChildren();
  el.className = 'annotation-status' + (isError ? ' annotation-status--err' : ' annotation-status--ok');
  const text = document.createElement('span');
  text.textContent = msg;
  el.appendChild(text);
  if (actionLabel && onAction) {
    const btn = document.createElement('button');
    btn.className = 'annotation-status-action';
    btn.textContent = actionLabel;
    btn.addEventListener('click', onAction);
    el.appendChild(btn);
  }
  el.classList.remove('hidden');
}

async function openAnnotationModal() {
  const overlay = document.getElementById('annotation-modal');
  document.getElementById('annotation-text').value = '';
  const dateEl = document.getElementById('annotation-date');
  dateEl.value = annotationTodayISO();
  dateEl.max = annotationTodayISO();
  document.getElementById('annotation-status').classList.add('hidden');
  document.getElementById('annotation-ga-check').classList.add('hidden');
  document.getElementById('annotation-webceo-check').classList.add('hidden');
  const gaCb = document.getElementById('annotation-ga');
  const wcCb = document.getElementById('annotation-webceo');
  const gaRow = gaCb.closest('.annotation-target');
  const wcRow = wcCb.closest('.annotation-target');
  // Only connected destinations are shown at all — hide both rows until the
  // resolve below confirms which apply to this page, rather than listing
  // disconnected tools as disabled rows.
  gaCb.checked = false; wcCb.checked = false;
  gaRow.classList.add('hidden'); wcRow.classList.add('hidden');
  showAnnotationStatus('Checking connections…', false);
  overlay.classList.remove('hidden');
  document.getElementById('annotation-text').focus();

  let tab; try { tab = await getActiveTab(); } catch { tab = null; }
  _annotationPageUrl = tab ? tab.url : '';

  const [ga, wc] = await Promise.all([
    sendMessageWithTimeout({ action: 'gaResolveProperty', pageUrl: _annotationPageUrl }).catch(() => null),
    sendMessageWithTimeout({ action: 'webceoResolveProject', pageUrl: _annotationPageUrl }).catch(() => null)
  ]);
  // The modal may have been closed while resolving
  if (overlay.classList.contains('hidden')) return;

  const gaOk = !!(ga && ga.connected && !ga.error && ga.property);
  const wcOk = !!(wc && wc.connected && !wc.error && wc.project);
  gaRow.classList.toggle('hidden', !gaOk); gaCb.checked = gaOk;
  wcRow.classList.toggle('hidden', !wcOk); wcCb.checked = wcOk;
  if (!gaOk && !wcOk) {
    showAnnotationStatus('Connect GA4 or Web CEO for this domain first.', true);
  } else {
    document.getElementById('annotation-status').classList.add('hidden');
  }
}

function closeAnnotationModal() {
  document.getElementById('annotation-modal').classList.add('hidden');
}

function annotationErr(r) {
  if (!r) return 'no response';
  if (r.connected === false) return 'not connected';
  if (r.error) return r.detail ? `${r.error} (${r.detail})` : String(r.error);
  return 'failed';
}

async function saveAnnotation() {
  if (_annotationBusy) return;
  const saveBtn = document.getElementById('btn-annotation-save');
  const date = document.getElementById('annotation-date').value;
  const text = document.getElementById('annotation-text').value.trim();
  const doGa = document.getElementById('annotation-ga').checked;
  const doWc = document.getElementById('annotation-webceo').checked;

  if (!date) { showAnnotationStatus('Pick a date.', true); return; }
  if (!text) { showAnnotationStatus('Enter a note.', true); return; }
  if (!doGa && !doWc) { showAnnotationStatus('Choose at least one destination.', true); return; }

  _annotationBusy = true;
  saveBtn.disabled = true; saveBtn.textContent = 'Adding…';
  document.getElementById('annotation-status').classList.add('hidden');

  const results = [];
  if (doGa) {
    const r = await sendMessageWithTimeout({ action: 'ga4AddAnnotation', pageUrl: _annotationPageUrl, date, title: text }).catch(() => null);
    if (r && r.error === 'GA_EDIT_SCOPE_MISSING') {
      _annotationBusy = false;
      saveBtn.disabled = false; saveBtn.textContent = 'Add';
      showAnnotationStatus('GA4 needs one-time permission to write annotations.', true, 'Grant access', grantGaEditAndRetry);
      return;
    }
    results.push(['Google Analytics', !!(r && r.ok), r, 'annotation-ga-check']);
  }
  if (doWc) {
    const r = await sendMessageWithTimeout({ action: 'webceoAddEvent', pageUrl: _annotationPageUrl, date, text }).catch(() => null);
    results.push(['Web CEO', !!(r && r.ok), r, 'annotation-webceo-check']);
  }

  _annotationBusy = false;
  saveBtn.disabled = false; saveBtn.textContent = 'Add';

  // Success shows as a green check on that destination's own row; only
  // failures fall through to the status line below the list.
  results.forEach(([, ok, , checkId]) => {
    document.getElementById(checkId).classList.toggle('hidden', !ok);
  });

  if (results.every(x => x[1])) {
    setTimeout(closeAnnotationModal, 900);
  } else {
    showAnnotationStatus(results.filter(x => !x[1]).map(([name, , r]) => `${name}: ${annotationErr(r)}`).join(' · '), true);
  }
}

// One-time consent upgrade to analytics.edit, then retry the save.
async function grantGaEditAndRetry() {
  showAnnotationStatus('Opening Google sign-in…', false);
  const res = await sendMessageWithTimeout({ action: 'gaConnectEdit' }, 180000).catch(() => null);
  if (res && res.connected) {
    showAnnotationStatus('Access granted — adding…', false);
    saveAnnotation();
  } else {
    showAnnotationStatus('Could not grant access. Try again.', true, 'Retry', grantGaEditAndRetry);
  }
}

document.getElementById('btn-ga-annotation').addEventListener('click', openAnnotationModal);
document.getElementById('btn-ranking-annotation').addEventListener('click', openAnnotationModal);
document.getElementById('btn-ads-annotation').addEventListener('click', openAnnotationModal);
document.getElementById('btn-annotation-cancel').addEventListener('click', closeAnnotationModal);
document.getElementById('btn-annotation-save').addEventListener('click', saveAnnotation);
document.getElementById('annotation-modal').addEventListener('mousedown', (e) => {
  if (e.target.id === 'annotation-modal') closeAnnotationModal();   // click outside the card
});
document.getElementById('annotation-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); saveAnnotation(); }
});
