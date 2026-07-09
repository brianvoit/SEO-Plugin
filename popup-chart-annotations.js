// Chart annotation stars. Reads GA4 + WebCEO annotations for the current domain
// (getChartAnnotations) and overlays a star on the Search / Analytics / Ads
// charts for any day that has one. Hovering a star reveals the note(s) and which
// source they're attached to; a note present in every connected source collapses
// into one entry flagged "In all".

let _chartAnnotations = { connectedSources: [], byDate: {} };
let _chartAnnotHost = null;
let _chartAnnotLoading = false;

function annotSourceLabel(s) { return s === 'ga4' ? 'GA4' : s === 'webceo' ? 'Web CEO' : s; }

// Fetch once per domain (or force after adding one), then re-render the charts
// so their star overlays pick up the new data.
async function loadChartAnnotations(force = false) {
  let host = null, pageUrl = '';
  try { const tab = await getActiveTab(); pageUrl = tab.url; host = new URL(tab.url).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return; }
  if (_chartAnnotLoading) return;
  if (!force && _chartAnnotLoaded() && host === _chartAnnotHost) return;

  _chartAnnotLoading = true;
  try {
    const res = await sendMessageWithTimeout({ action: 'getChartAnnotations', pageUrl });
    _chartAnnotations = (res && res.byDate) ? res : { connectedSources: [], byDate: {} };
    _chartAnnotHost = host;
  } catch { /* leave prior data */ }
  _chartAnnotLoading = false;

  // Repaint whichever charts are currently mounted
  ['renderCombinedChart', 'renderGaChart', 'renderAdsChart'].forEach(fn => {
    if (typeof window[fn] === 'function') { try { window[fn](); } catch { /* chart not ready */ } }
  });
}
function _chartAnnotLoaded() { return _chartAnnotHost !== null; }

// Called at the end of each chart render. `built` carries xFor + dims from
// buildCombinedChart; the SVG is drawn at 1:1 (viewBox width = px width), so
// xFor(i) is a pixel offset we can position an HTML star at.
function overlayChartAnnotations(container, filled, built) {
  const old = container.querySelector('.chart-annot-layer');
  if (old) old.remove();
  const byDate = _chartAnnotations.byDate || {};
  if (!container || !built || !filled || !Object.keys(byDate).length) return;

  const layer = document.createElement('div');
  layer.className = 'chart-annot-layer';
  let any = false;
  filled.forEach((d, i) => {
    const anns = byDate[d.date];
    if (!anns || !anns.length) return;
    any = true;
    const star = document.createElement('div');
    star.className = 'chart-annot-star';
    star.style.left = built.xFor(i).toFixed(1) + 'px';
    star.textContent = '★';
    star.addEventListener('mouseenter', () => showAnnotTip(star, d.date, anns));
    star.addEventListener('mouseleave', hideAnnotTip);
    layer.appendChild(star);
  });
  if (any) container.appendChild(layer);
}

let _annotTipEl = null;
function showAnnotTip(anchor, date, anns) {
  if (!_annotTipEl) { _annotTipEl = document.createElement('div'); _annotTipEl.className = 'chart-annot-tip'; document.body.appendChild(_annotTipEl); }
  const tip = _annotTipEl;
  tip.replaceChildren();

  const head = document.createElement('div');
  head.className = 'chart-annot-tip-date';
  head.textContent = date;
  tip.appendChild(head);

  const all = _chartAnnotations.connectedSources || [];
  anns.forEach(a => {
    const row = document.createElement('div');
    row.className = 'chart-annot-tip-row';
    const txt = document.createElement('div');
    txt.className = 'chart-annot-tip-text';
    txt.textContent = a.text || '(no text)';
    const src = document.createElement('div');
    src.className = 'chart-annot-tip-src';
    if (all.length > 1 && a.sources.length >= all.length) { src.textContent = 'In all'; src.classList.add('chart-annot-tip-src--all'); }
    else src.textContent = a.sources.map(annotSourceLabel).join(' · ');
    row.append(txt, src);
    tip.appendChild(row);
  });

  tip.classList.add('visible');
  const r = anchor.getBoundingClientRect();
  const tw = tip.offsetWidth || 180;
  tip.style.left = `${Math.max(6, Math.min(r.left + r.width / 2 - tw / 2, window.innerWidth - tw - 6))}px`;
  tip.style.top = `${r.bottom + 6}px`;
}
function hideAnnotTip() { if (_annotTipEl) _annotTipEl.classList.remove('visible'); }
