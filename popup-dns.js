// DNS tab: records via Google Public DNS-over-HTTPS (resolved + cached in the
// background), plus the security headers and TLS details the background
// captured from the page's own response (no external API for those).

const DNS_RECORD_ORDER = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT'];

const SEC_HEADER_DISPLAY = [
  ['strict-transport-security', 'Strict-Transport-Security'],
  ['content-security-policy', 'Content-Security-Policy'],
  ['x-frame-options', 'X-Frame-Options'],
  ['x-content-type-options', 'X-Content-Type-Options'],
  ['referrer-policy', 'Referrer-Policy'],
  ['permissions-policy', 'Permissions-Policy']
];

// ─── DNS records ──────────────────────────────────────────────────────────────

function renderDnsRecords(res) {
  const list    = document.getElementById('dns-records');
  const loading = document.getElementById('dns-loading');
  const empty   = document.getElementById('dns-empty');
  const errorEl = document.getElementById('dns-error');
  list.replaceChildren();
  loading.classList.add('hidden');
  empty.classList.add('hidden');
  errorEl.classList.add('hidden');

  if (!res || res.error) {
    errorEl.textContent = res?.error === 'NETWORK'
      ? 'DNS lookup failed — check your connection.'
      : 'Could not look up DNS records for this page.';
    errorEl.classList.remove('hidden');
    return;
  }

  let any = false;
  DNS_RECORD_ORDER.forEach(type => {
    (res.records[type] || []).forEach(record => {
      any = true;
      const row = document.createElement('div');
      row.className = 'dns-row';

      const chip = document.createElement('span');
      chip.className = 'dns-type';
      chip.textContent = type;

      const value = document.createElement('span');
      value.className = 'dns-value';
      value.textContent = record.data;
      value.title = record.data;

      const ttl = document.createElement('span');
      ttl.className = 'dns-ttl';
      ttl.textContent = record.ttl != null ? `${record.ttl}s` : '';

      row.append(chip, value, ttl);
      list.appendChild(row);
    });
  });

  if (!any) empty.classList.remove('hidden');
}

// ─── Security headers + TLS (from the captured response) ─────────────────────

function renderDnsSecuritySections() {
  const info = (typeof _redirectInfo !== 'undefined') ? _redirectInfo : null;

  // Security headers
  const list = document.getElementById('sec-headers-list');
  const note = document.getElementById('sec-headers-note');
  list.replaceChildren();
  const headers = info && info.securityHeaders;
  note.classList.toggle('hidden', !!headers);
  if (headers) {
    SEC_HEADER_DISPLAY.forEach(([key, label]) => {
      const value = headers[key];
      const row = document.createElement('div');
      row.className = 'sec-row';

      const dot = document.createElement('span');
      dot.className = 'index-dot ' + (value ? 'sec-dot--ok' : 'sec-dot--missing');

      const name = document.createElement('span');
      name.className = 'sec-name';
      name.textContent = label;

      const val = document.createElement('span');
      val.className = 'sec-value' + (value ? '' : ' sec-value--missing');
      val.textContent = value || 'Missing';
      if (value) val.title = value;

      row.append(dot, name, val);
      list.appendChild(row);
    });
  }

  // TLS / SSL details
  const tlsList = document.getElementById('tls-list');
  const tlsNote = document.getElementById('tls-note');
  tlsList.replaceChildren();
  const tls = info && info.tls;
  tlsNote.classList.toggle('hidden', !!tls);
  if (tls) {
    const days = tls.validityEnd ? Math.floor((tls.validityEnd - Date.now()) / 86400000) : null;
    const chainOk = tls.state === 'secure';
    const rows = [
      ['Chain', chainOk ? 'Valid' : (tls.state || 'Unknown'), chainOk ? 'hint-green' : 'hint-red'],
      ['Protocol', tls.protocol || '—'],
      ['Cipher', tls.cipher || '—'],
      ['Issuer', parseIssuerOrg(tls.issuer) || tls.issuer || '—'],
      ['Valid from', tls.validityStart ? formatDate(new Date(tls.validityStart)) : '—'],
      ['Expires', tls.validityEnd
        ? `${formatDate(new Date(tls.validityEnd))} (${days} days)`
        : '—',
        days != null ? (days < 8 ? 'hint-red' : days <= 30 ? 'hint-amber' : 'hint-green') : '']
    ];
    rows.forEach(([label, value, cls]) => {
      const row = document.createElement('div');
      row.className = 'sec-row';
      const name = document.createElement('span');
      name.className = 'sec-name';
      name.textContent = label;
      const val = document.createElement('span');
      val.className = 'sec-value' + (cls ? ' ' + cls : '');
      val.textContent = value;
      val.title = label === 'Issuer' && tls.issuer ? tls.issuer : '';
      row.append(name, val);
      tlsList.appendChild(row);
    });
  }
}

// ─── Load ─────────────────────────────────────────────────────────────────────

async function loadDnsData() {
  renderDnsSecuritySections();

  const hostEl  = document.getElementById('dns-host');
  const list    = document.getElementById('dns-records');
  const loading = document.getElementById('dns-loading');
  const empty   = document.getElementById('dns-empty');
  const errorEl = document.getElementById('dns-error');

  const tab = await getActiveTab();
  let host = '';
  try { host = new URL(tab.url).hostname; } catch { /* non-http page */ }

  if (!host) {
    hostEl.textContent = '';
    list.replaceChildren();
    loading.classList.add('hidden');
    empty.classList.add('hidden');
    errorEl.textContent = 'No domain to look up on this page.';
    errorEl.classList.remove('hidden');
    return;
  }

  // MX/NS/TXT live on the registrable domain, so query without the www
  const lookupHost = host.replace(/^www\./, '');
  hostEl.textContent = lookupHost;

  list.replaceChildren();
  empty.classList.add('hidden');
  errorEl.classList.add('hidden');
  loading.classList.remove('hidden');

  const res = await browser.runtime.sendMessage({ action: 'dnsResolve', host: lookupHost });
  // Ignore stale responses if the user navigated meanwhile
  if (document.getElementById('dns-host').textContent !== lookupHost) return;
  renderDnsRecords(res);
}
