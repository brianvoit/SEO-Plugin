// ─── Client Registry UI ───────────────────────────────────────────────────────
// Replaces the old per-host Branded Terms list/form in Settings with a
// CLIENTS list + a full-screen Client panel (name, domains, branded terms,
// Image SEO config, Drive folder, and per-domain GSC/GA4/Ads/Web CEO
// bindings).
//
// A brand-new client has no id until its first real edit (name/Drive
// folder) — ensureClientPersisted() creates it then; abandoning a blank panel
// via Back never leaves an empty client behind. Domains and branded terms use
// their own dedicated background actions (clientRegistryAddDomain/
// RemoveDomain/SetBrandedTerms) since those cascade cleanup of the flat
// override maps/caches — a plain clientRegistrySave never touches those.

let _clients = [];
let _editingClient = null;
let _currentClientHost = null;   // the active tab's host, for highlighting its client in the list

function clientRegistryDraft() {
  return { id: null, name: '', domains: [], brandedTerms: '', driveFolderId: null, driveFolderName: null };
}

// Guesses for a brand-new client, taken from the tab the user is looking at.
// Only ever used to PREFILL the inputs — nothing is persisted until the user
// blurs the name or clicks + Domain, so a bad guess costs one edit.
let _clientPrefill = null;

// Strip a trailing brand segment off a page title: "Some Page | Acme Co"
// → "Acme Co". Titles put the brand last far more often than first, and the
// separator set here is what site templates actually emit.
function brandFromTitle(title) {
  const parts = String(title || '').split(/\s+[|–—·•-]\s+/);
  if (parts.length < 2) return '';
  const last = parts[parts.length - 1].trim();
  // A long tail segment is usually a tagline ("Best Widgets in Ohio"), not a
  // brand — better to fall through to the domain than to guess wrong.
  return (last && last.length <= 40 && last.split(/\s+/).length <= 5) ? last : '';
}

// "acme-corp.co.uk" → "Acme Corp". Last-resort guess when the page carries no
// explicit branding.
function brandFromHost(host) {
  const label = String(host || '').split('.')[0] || '';
  return label
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, ch => ch.toUpperCase());
}

// Ordered best-guess: explicit site branding first, then schema.org, then the
// title's brand segment, then the bare domain.
function inferClientName(pageData, host) {
  const og = (pageData && pageData.openGraph && pageData.openGraph.og) || {};
  const explicit = (og['og:site_name'] || '').trim();
  if (explicit) return explicit;

  for (const item of (pageData && pageData.structuredData) || []) {
    const types = [].concat(item['@type'] || []);
    if (!types.some(t => t === 'Organization' || t === 'WebSite' || t === 'LocalBusiness')) continue;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (name) return name;
  }

  return brandFromTitle(pageData && pageData.title && pageData.title.text) || brandFromHost(host);
}

async function loadClientPrefill() {
  _clientPrefill = null;
  try {
    const tab = await getActiveTab();
    if (!tab || !tab.url) return;
    const host = new URL(tab.url).hostname.replace(/^www\./, '').toLowerCase();
    if (!host) return;
    _clientPrefill = { host, name: brandFromHost(host) };
    // Page read is best-effort — a restricted page (about:, PDF, store pages)
    // still gets the domain-derived name above.
    const pageData = await getPageDataFromTab(tab.id).catch(() => null);
    if (pageData) _clientPrefill.name = inferClientName(pageData, host);
  } catch { /* leave whatever we managed to derive */ }
}

function patchClientInList(client) {
  const i = _clients.findIndex(c => c.id === client.id);
  if (i === -1) _clients.push(client); else _clients[i] = client;
  renderClientsList();
}

async function loadClients() {
  try {
    const tab = await getActiveTab();
    _currentClientHost = new URL(tab.url).hostname.toLowerCase().replace(/^www\./, '');
  } catch { _currentClientHost = null; }

  const res = await sendMessageWithTimeout({ action: 'clientRegistryList' });
  _clients = (res && res.clients) || [];
  renderClientsList();
}

function renderClientsList() {
  const list  = document.getElementById('clients-list');
  const empty = document.getElementById('clients-empty');
  list.replaceChildren();

  if (!_clients.length) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  // Sorted here (not at each mutation site) so add/rename/delete can never
  // leave the list out of order.
  const sorted = _clients.slice().sort((a, b) =>
    (a.name || 'Unnamed client').localeCompare(b.name || 'Unnamed client', undefined, { sensitivity: 'base' }));

  sorted.forEach(client => {
    const domains = (client.domains || []).map(d => d.domain);
    const line2 = domains.length ? domains.join(', ') : 'No domains yet';
    const { row, removeBtn, editBtn } = buildSettingsRow(client.name || 'Unnamed client', line2, 'Delete', true, domains[0] || null);

    // Flag the client that owns the domain of the page currently being
    // inspected — the row outline alone is enough, no extra dot needed.
    if (_currentClientHost && domains.includes(_currentClientHost)) {
      row.classList.add('wp-site-row--active');
      row.title = 'This is the client for the page you\'re inspecting';
    }

    row.addEventListener('click', (e) => {
      if (e.target.closest('.wp-site-remove') || e.target.closest('.wp-site-edit')) return;
      showClientPanel(client.id);
    });
    editBtn.addEventListener('click', () => showClientPanel(client.id));
    removeBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${client.name || 'Unnamed client'}"? This removes its branded terms, keywords, Image SEO settings, and per-domain bindings.`)) return;
      await sendMessageWithTimeout({ action: 'clientRegistryDelete', id: client.id });
      _clients = _clients.filter(c => c.id !== client.id);
      renderClientsList();
    });
    list.appendChild(row);
  });
}

document.getElementById('btn-add-client').addEventListener('click', () => showClientPanel(null));

// ─── Client panel ─────────────────────────────────────────────────────────────

async function openClientPanel(id) {
  document.getElementById('btn-client-delete').classList.toggle('hidden', !id);
  if (id) {
    _clientPrefill = null;
    const res = await sendMessageWithTimeout({ action: 'clientRegistryGet', id });
    _editingClient = (res && res.client) || clientRegistryDraft();
    renderClientPanelContent();
  } else {
    _editingClient = clientRegistryDraft();
    // Render immediately so the panel isn't blank while the page is read,
    // then re-render once the guesses land.
    renderClientPanelContent();
    await loadClientPrefill();
    if (_clientPrefill && _editingClient && !_editingClient.id) renderClientPanelContent();
  }
}

async function deleteCurrentClient() {
  if (!_editingClient || !_editingClient.id) { hideClientPanelToSettings(); return; }
  if (!confirm(`Delete "${_editingClient.name || 'Unnamed client'}"? This removes its branded terms, keywords, Image SEO settings, and per-domain bindings.`)) return;
  await sendMessageWithTimeout({ action: 'clientRegistryDelete', id: _editingClient.id });
  _clients = _clients.filter(c => c.id !== _editingClient.id);
  renderClientsList();
  hideClientPanelToSettings();
}

// Handles only fields with no override/cache implications (name, Drive
// folder) — creates the client on its first call if it doesn't exist yet.
async function saveClientField(patch) {
  const client = { id: _editingClient.id, name: _editingClient.name, ...patch };
  const res = await sendMessageWithTimeout({ action: 'clientRegistrySave', client });
  if (res && res.ok) {
    _editingClient = res.client;
    document.getElementById('btn-client-delete').classList.remove('hidden');
    patchClientInList(_editingClient);
  }
  return _editingClient;
}

async function ensureClientPersisted() {
  if (_editingClient.id) return _editingClient.id;
  // Keep the prefilled guess if the user went straight to + Domain without
  // ever focusing the name field — otherwise it would save as "New Client"
  // despite the name being visibly filled in.
  const prefilled = _clientPrefill ? _clientPrefill.name : '';
  await saveClientField({ name: _editingClient.name || prefilled || 'New Client' });
  return _editingClient.id;
}

function renderClientPanelContent() {
  const client = _editingClient;
  const root = document.getElementById('client-content');
  root.replaceChildren();

  // Name
  const nameSection = document.createElement('section');
  nameSection.className = 'field-section';
  const nameLabel = document.createElement('label');
  nameLabel.className = 'wp-field';
  const nameLabelText = document.createElement('span');
  nameLabelText.className = 'wp-field-label';
  nameLabelText.textContent = 'Name';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'wp-input';
  nameInput.placeholder = 'Client name';
  // A brand-new client starts with the guess from the active tab; an existing
  // one always shows its stored name, even if that's blank.
  nameInput.value = client.name || (!client.id && _clientPrefill ? _clientPrefill.name : '') || '';
  nameInput.autocomplete = 'off';
  nameInput.spellcheck = false;
  nameInput.addEventListener('blur', () => {
    const name = nameInput.value.trim() || 'New Client';
    if (name !== client.name || !client.id) saveClientField({ name }).then(renderClientPanelContent);
  });
  nameLabel.append(nameLabelText, nameInput);
  nameSection.appendChild(nameLabel);
  root.appendChild(nameSection);

  // Domains
  const domainsSection = document.createElement('section');
  domainsSection.className = 'field-section';
  const domainsHeader = document.createElement('div');
  domainsHeader.className = 'field-label';
  domainsHeader.textContent = 'DOMAINS';
  domainsSection.appendChild(domainsHeader);
  renderDomainsSection(domainsSection, client);
  root.appendChild(domainsSection);

  // Branded terms (client-level — shared by every domain above)
  const brandedSection = document.createElement('section');
  brandedSection.className = 'field-section';
  renderBrandedTermsField(brandedSection, client);
  root.appendChild(brandedSection);

  // Competitors — client-level, and the thing that turns on the Backlinks
  // panel's "VS. COMPETITORS" section, which is otherwise dark on any project
  // whose competitors were never configured in Web CEO's own UI.
  const competitorsSection = document.createElement('section');
  competitorsSection.className = 'field-section';
  const competitorsHeader = document.createElement('div');
  competitorsHeader.className = 'field-label';
  competitorsHeader.textContent = 'COMPETITORS';
  competitorsSection.appendChild(competitorsHeader);
  renderCompetitorsSection(competitorsSection, client);
  root.appendChild(competitorsSection);

  // Trust profile — gates the E-E-A-T rules in the Action Plan.
  const trustSection = document.createElement('section');
  trustSection.className = 'field-section';
  const trustHeader = document.createElement('div');
  trustHeader.className = 'field-label';
  trustHeader.textContent = 'TRUST PROFILE';
  trustSection.appendChild(trustHeader);
  renderTrustProfileSection(trustSection, client);
  root.appendChild(trustSection);

  // Content generation settings — client-level, like branded terms above.
  // Applies uniformly to every AI-generated text field (Title, Meta, OG,
  // Twitter, and the WP Media Library image generators) — none of it is
  // scoped to one generator over another.
  const contentGenSection = document.createElement('section');
  contentGenSection.className = 'field-section';
  renderContentGenSection(contentGenSection, client);
  root.appendChild(contentGenSection);

  // Drive folder
  const driveSection = document.createElement('section');
  driveSection.className = 'field-section';
  renderDriveFolderRow(driveSection, client);
  root.appendChild(driveSection);

  // Per-domain bindings
  if (client.id && (client.domains || []).length) {
    const bindingsSection = document.createElement('section');
    bindingsSection.className = 'field-section';
    const bindingsHeader = document.createElement('div');
    bindingsHeader.className = 'field-label';
    bindingsHeader.textContent = 'PER-DOMAIN BINDINGS';
    bindingsSection.appendChild(bindingsHeader);
    client.domains.forEach(d => {
      const domainBlock = document.createElement('div');
      domainBlock.className = 'client-binding-domain';
      const domainTitle = document.createElement('div');
      domainTitle.className = 'client-binding-domain-title';
      domainTitle.textContent = d.domain;
      domainBlock.appendChild(domainTitle);
      ['gsc', 'ga', 'ads', 'webceo'].forEach(kind => {
        const row = document.createElement('div');
        row.className = 'client-binding-row';
        domainBlock.appendChild(row);
        renderClientBindingRow(row, d.domain, kind);
      });
      bindingsSection.appendChild(domainBlock);
    });
    root.appendChild(bindingsSection);
  } else if (client.id) {
    const hint = document.createElement('div');
    hint.className = 'field-hint hint-muted';
    hint.textContent = 'Add a domain above to bind Search Console, Analytics, Ads, and Web CEO for it.';
    root.appendChild(hint);
  }
}

// Competitor domains for this client, plus the explicit push to Web CEO.
//
// The list lives on the Client (synced, useful even where there is no Web CEO
// project). Syncing is a deliberate button rather than an on-save side effect:
// it is a remote write against the user's Web CEO quota, and it targets the
// project bound to each domain, so firing it automatically as someone types
// would be both surprising and wasteful.
// Trust profile — the client-level gating for the E-E-A-T rules. Manual on
// purpose: whether a business publishes bylined material or operates under a
// licence is not detectable from a crawl, and guessing it wrong makes rules
// fire that the client cannot act on.
const CLIENT_BUSINESS_MODEL_OPTS = [
  { value: 'local_service',  label: 'Local service' },
  { value: 'multi_location', label: 'Multi-location' },
  { value: 'ecommerce',      label: 'Ecommerce' },
  { value: 'b2b_technical',  label: 'B2B / technical' },
  { value: 'publisher',      label: 'Publisher' }
];
const CLIENT_YMYL_OPTS = [
  { value: 'none',      label: 'None' },
  { value: 'health',    label: 'Health' },
  { value: 'finance',   label: 'Finance' },
  { value: 'legal',     label: 'Legal' },
  { value: 'regulated', label: 'Regulated (not YMYL)' }
];

function renderTrustProfileSection(container, client) {
  const trust = Object.assign(
    { businessModel: 'local_service', ymyl: 'none', hasGbp: false, authoredContent: false },
    client.trust || {}
  );

  const save = async (patch) => {
    const id = await ensureClientPersisted();
    const res = await sendMessageWithTimeout({ action: 'clientRegistrySetTrust', id, trust: { ...trust, ...patch } });
    if (res && res.client) { _editingClient = res.client; patchClientInList(_editingClient); renderClientPanelContent(); }
  };

  const addSelect = (labelText, opts, current, key, hint) => {
    const label = document.createElement('label');
    label.className = 'wp-field';
    const lt = document.createElement('span');
    lt.className = 'wp-field-label';
    lt.textContent = labelText;
    const sel = document.createElement('select');
    sel.className = 'neg-list-select client-trust-select';
    opts.forEach(o => {
      const el = document.createElement('option');
      el.value = o.value; el.textContent = o.label;
      sel.appendChild(el);
    });
    sel.value = current;
    sel.addEventListener('change', () => save({ [key]: sel.value }));
    label.append(lt, sel);
    container.appendChild(label);
    if (hint) {
      const h = document.createElement('div');
      h.className = 'field-hint hint-muted';
      h.textContent = hint;
      container.appendChild(h);
    }
  };

  addSelect('Business model', CLIENT_BUSINESS_MODEL_OPTS, trust.businessModel, 'businessModel',
    'Decides which trust recommendations can fire at all.');
  addSelect('YMYL / regulated', CLIENT_YMYL_OPTS, trust.ymyl, 'ymyl',
    'Anything but "None" asks for licensure and credentials to be surfaced.');

  const addToggle = (labelText, checked, key, hint) => {
    const row = document.createElement('label');
    row.className = 'client-trust-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!checked;
    cb.addEventListener('change', () => save({ [key]: cb.checked }));
    const txt = document.createElement('span');
    txt.textContent = labelText;
    row.append(cb, txt);
    container.appendChild(row);
    if (hint) {
      const h = document.createElement('div');
      h.className = 'field-hint hint-muted';
      h.textContent = hint;
      container.appendChild(h);
    }
  };

  addToggle('Has a Google Business Profile', trust.hasGbp, 'hasGbp',
    'Enables review-display advice, and the note that stars are not achievable on this entity type.');
  addToggle('Publishes bylined content', trust.authoredContent, 'authoredContent',
    'Off suppresses author-page and Person-schema advice entirely — most service businesses should leave this off.');
}

function renderCompetitorsSection(container, client) {
  const saveList = async (next) => {
    const id = await ensureClientPersisted();
    const res = await sendMessageWithTimeout({ action: 'clientRegistrySetCompetitors', id, competitors: next });
    if (res && res.client) { _editingClient = res.client; patchClientInList(_editingClient); renderClientPanelContent(); }
  };

  const current = client.competitors || [];

  const list = document.createElement('div');
  list.className = 'client-domain-chips';
  current.forEach(domain => {
    const chip = document.createElement('span');
    chip.className = 'client-domain-chip';
    const text = document.createElement('span');
    text.textContent = domain;
    chip.appendChild(text);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'client-domain-chip-remove';
    labelIconButton(remove, `Remove ${domain}`);
    remove.textContent = '\u00d7';
    remove.addEventListener('click', () => saveList(current.filter(c => c !== domain)));
    chip.appendChild(remove);
    list.appendChild(chip);
  });
  container.appendChild(list);

  if (!current.length) {
    const hint = document.createElement('div');
    hint.className = 'field-hint hint-muted';
    hint.textContent = 'Add competitor domains to turn on the Backlinks panel\u2019s VS. COMPETITORS comparison.';
    container.appendChild(hint);
  }

  const addRow = document.createElement('div');
  addRow.className = 'client-domain-add-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'wp-input';
  input.placeholder = 'competitor.com';
  input.autocomplete = 'off';
  input.spellcheck = false;
  const addBtn = document.createElement('button');
  addBtn.className = 'save-key-btn';
  addBtn.textContent = '+ Competitor';
  const doAdd = () => {
    const domain = input.value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    if (!domain || current.includes(domain)) { input.value = ''; return; }
    input.value = '';
    saveList([...current, domain]);
  };
  addBtn.addEventListener('click', doAdd);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });
  addRow.append(input, addBtn);
  container.appendChild(addRow);

  // Sync is only meaningful for a domain that actually has a Web CEO project.
  const bound = (client.domains || []).filter(d => d.webceoProject);
  if (!bound.length) return;

  const syncRow = document.createElement('div');
  syncRow.className = 'client-competitor-sync';
  const status = document.createElement('span');
  status.className = 'field-hint hint-muted';

  // With nothing to push, offer the other direction instead. A project whose
  // competitors were configured in Web CEO's own UI already has a list, and
  // pushing an empty one at it would WIPE that — so an empty list must never
  // be a Sync button.
  if (!current.length) {
    const importBtn = document.createElement('button');
    importBtn.className = 'save-key-btn';
    importBtn.textContent = 'Import from Web CEO';
    importBtn.addEventListener('click', async () => {
      importBtn.disabled = true;
      status.className = 'field-hint hint-muted';
      status.textContent = 'Reading…';
      const found = [];
      const failures = [];
      for (const d of bound) {
        const res = await sendMessageWithTimeout({
          action: 'webceoGetCompetitors', pageUrl: `https://${d.domain}/`
        }).catch(() => null);
        if (res && Array.isArray(res.competitors)) found.push(...res.competitors);
        else failures.push(`${d.domain}: ${(res && (res.detail || res.error)) || 'no response'}`);
      }
      importBtn.disabled = false;
      if (found.length) { saveList([...new Set(found)]); return; }   // re-renders
      status.className = failures.length ? 'field-hint hint-red' : 'field-hint hint-muted';
      status.textContent = failures.length ? failures.join(' · ') : 'Web CEO has no competitors for this project either.';
    });
    syncRow.append(importBtn, status);
    container.appendChild(syncRow);
    return;
  }

  const syncBtn = document.createElement('button');
  syncBtn.className = 'save-key-btn';
  syncBtn.textContent = bound.length > 1 ? `Sync to Web CEO (${bound.length} projects)` : 'Sync to Web CEO';

  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true;
    status.className = 'field-hint hint-muted';
    status.textContent = 'Syncing\u2026';
    const failures = [];
    for (const d of bound) {
      const res = await sendMessageWithTimeout({
        action: 'webceoSetCompetitors', pageUrl: `https://${d.domain}/`, competitors: current
      }).catch(() => null);
      if (!res || !res.ok) failures.push(`${d.domain}: ${(res && (res.detail || res.error)) || 'no response'}`);
    }
    syncBtn.disabled = false;
    if (!failures.length) {
      status.className = 'field-hint hint-green';
      status.textContent = `Synced to ${bound.length} project${bound.length === 1 ? '' : 's'}.`;
    } else {
      // Deliberately verbose: the likeliest failure is that Web CEO names the
      // write parameter something this build does not try yet, and the detail
      // string says exactly which names were attempted.
      status.className = 'field-hint hint-red';
      status.textContent = failures.join(' · ');
    }
  });

  syncRow.append(syncBtn, status);
  container.appendChild(syncRow);
}

function renderDomainsSection(container, client) {
  const list = document.createElement('div');
  list.className = 'client-domain-chips';
  (client.domains || []).forEach(d => {
    const chip = document.createElement('span');
    chip.className = 'client-domain-chip';
    const text = document.createElement('span');
    text.textContent = d.domain;
    chip.appendChild(text);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'client-domain-chip-remove';
    remove.title = `Remove ${d.domain}`;
    remove.textContent = '×';
    remove.addEventListener('click', async () => {
      const res = await sendMessageWithTimeout({ action: 'clientRegistryRemoveDomain', id: client.id, domain: d.domain });
      if (res && res.client) { _editingClient = res.client; patchClientInList(_editingClient); renderClientPanelContent(); }
    });
    chip.appendChild(remove);
    list.appendChild(chip);
  });
  container.appendChild(list);

  const addRow = document.createElement('div');
  addRow.className = 'client-domain-add-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'wp-input';
  input.placeholder = 'example.com';
  input.autocomplete = 'off';
  input.spellcheck = false;
  // Prefill the active tab's host on a new client, as long as it isn't already
  // attached. Left in the input rather than added automatically so opening
  // + Client never silently binds a domain the user didn't intend.
  if (!client.id && _clientPrefill && !(client.domains || []).some(d => d.domain === _clientPrefill.host)) {
    input.value = _clientPrefill.host;
  }
  const addBtn = document.createElement('button');
  addBtn.className = 'save-key-btn';
  addBtn.textContent = '+ Domain';
  const doAdd = async () => {
    const domain = input.value.trim();
    if (!domain) return;
    const id = await ensureClientPersisted();
    const res = await sendMessageWithTimeout({ action: 'clientRegistryAddDomain', id, domain });
    if (res && res.ok && res.client) {
      input.value = '';
      _editingClient = res.client;
      patchClientInList(_editingClient);
      renderClientPanelContent();
    }
  };
  addBtn.addEventListener('click', doAdd);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });
  addRow.append(input, addBtn);
  container.appendChild(addRow);
}

function renderBrandedTermsField(container, client) {
  const label = document.createElement('label');
  label.className = 'wp-field';
  const labelText = document.createElement('span');
  labelText.className = 'wp-field-label';
  labelText.textContent = 'Branded Terms (regex, case-insensitive — shared by every domain above)';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'wp-input';
  input.placeholder = 'brand|brandname|bn|other';
  input.value = client.brandedTerms || '';
  input.autocomplete = 'off';
  input.spellcheck = false;
  label.append(labelText, input);
  container.appendChild(label);

  const error = document.createElement('div');
  error.className = 'field-hint hint-red hidden';
  container.appendChild(error);

  input.addEventListener('blur', async () => {
    const pattern = input.value.trim();
    error.classList.add('hidden');
    if (pattern) {
      try { new RegExp(pattern, 'i'); }
      catch (err) { error.textContent = `Invalid regex: ${err.message}`; error.classList.remove('hidden'); return; }
    }
    if (pattern === (client.brandedTerms || '')) return;
    const id = await ensureClientPersisted();
    const res = await sendMessageWithTimeout({ action: 'clientRegistrySetBrandedTerms', id, pattern });
    if (res && res.client) { _editingClient = res.client; patchClientInList(_editingClient); }
  });
}

// Client-level content-generation settings — applies uniformly to every
// "Generate with Claude" text field (Title tag, Meta description, OG,
// Twitter, and the WP Media Library image generators). None of it is
// image-specific: the same record (client.imageSeo, kept as the storage key
// name for now — renaming it would touch the client-registry schema for no
// functional benefit) is read by both popup-generate.js and content.js.
// Each field saves independently on blur/change, merged against the LIVE
// _editingClient (not a snapshot closed over earlier) so editing one field
// right after another never clobbers the previous save.
async function patchImageSeo(patch) {
  const next = { ...(_editingClient.imageSeo || {}), ...patch };
  const id = await ensureClientPersisted();
  const res = await sendMessageWithTimeout({ action: 'clientRegistrySetImageSeo', id, imageSeo: next });
  if (res && res.client) { _editingClient = res.client; patchClientInList(_editingClient); }
}

function renderContentGenSection(container, client) {
  const cfg = client.imageSeo || {};

  const kwLabel = document.createElement('label');
  kwLabel.className = 'wp-field';
  const kwLabelText = document.createElement('span');
  kwLabelText.className = 'wp-field-label';
  kwLabelText.textContent = 'Additional Focus Keywords';
  const kwInput = document.createElement('input');
  kwInput.type = 'text';
  kwInput.className = 'wp-input';
  kwInput.placeholder = 'dental implants, cosmetic dentistry';
  kwInput.value = (cfg.focusKeywords || []).join(', ');
  kwInput.autocomplete = 'off';
  kwInput.spellcheck = false;
  kwInput.addEventListener('blur', () => patchImageSeo({ focusKeywords: kwInput.value.split(',').map(s => s.trim()).filter(Boolean) }));
  kwLabel.append(kwLabelText, kwInput);
  container.appendChild(kwLabel);

  const toneLabel = document.createElement('label');
  toneLabel.className = 'wp-field';
  const toneLabelText = document.createElement('span');
  toneLabelText.className = 'wp-field-label';
  toneLabelText.textContent = 'Tone / Style (optional)';
  const toneInput = document.createElement('input');
  toneInput.type = 'text';
  toneInput.className = 'wp-input';
  toneInput.placeholder = 'clinical, friendly, premium…';
  toneInput.value = cfg.tone || '';
  toneInput.autocomplete = 'off';
  toneInput.spellcheck = false;
  toneInput.addEventListener('blur', () => patchImageSeo({ tone: toneInput.value.trim() }));
  toneLabel.append(toneLabelText, toneInput);
  container.appendChild(toneLabel);

  const rulesLabel = document.createElement('label');
  rulesLabel.className = 'wp-field';
  const rulesLabelText = document.createElement('span');
  rulesLabelText.className = 'wp-field-label';
  rulesLabelText.textContent = 'Rules (applied to all AI-generated text)';
  const rulesInput = document.createElement('textarea');
  rulesInput.className = 'wp-input';
  rulesInput.rows = 3;
  rulesInput.spellcheck = false;
  rulesInput.placeholder = 'e.g. Mention the city/neighborhood when the content is location-specific. Prefer "consultation" over "meeting". Keep a formal, professional tone.';
  rulesInput.value = cfg.rules || '';
  rulesInput.addEventListener('blur', () => patchImageSeo({ rules: rulesInput.value.trim() }));
  rulesLabel.append(rulesLabelText, rulesInput);
  container.appendChild(rulesLabel);

  const trackedLabel = document.createElement('label');
  trackedLabel.className = 'ranking-onpage-toggle';
  // .ranking-onpage-toggle is inline-flex, which lets these two checkboxes
  // flow onto the same line with no horizontal gap — force each onto its
  // own row here (scoped to this usage, not the shared class).
  trackedLabel.style.display = 'flex';
  trackedLabel.style.marginTop = '8px';
  const trackedInput = document.createElement('input');
  trackedInput.type = 'checkbox';
  trackedInput.checked = cfg.useTrackedKeywords !== false;
  trackedInput.addEventListener('change', () => patchImageSeo({ useTrackedKeywords: trackedInput.checked }));
  trackedLabel.append(trackedInput, document.createTextNode(' Also use Web CEO tracked keywords'));
  container.appendChild(trackedLabel);

  const brandLabel = document.createElement('label');
  brandLabel.className = 'ranking-onpage-toggle';
  brandLabel.style.display = 'flex';
  brandLabel.style.marginTop = '10px';
  const brandInput = document.createElement('input');
  brandInput.type = 'checkbox';
  brandInput.checked = !!cfg.includeBrand;
  brandInput.addEventListener('change', () => patchImageSeo({ includeBrand: brandInput.checked }));
  brandLabel.append(brandInput, document.createTextNode(' Allow the brand name in AI-generated text'));
  container.appendChild(brandLabel);
}

async function renderDriveFolderRow(container, client) {
  const label = document.createElement('div');
  label.className = 'field-label';
  label.textContent = 'DRIVE FOLDER';
  container.appendChild(label);

  const row = document.createElement('div');
  row.className = 'client-drive-row';
  container.appendChild(row);

  if (client.driveFolderId) {
    // Only ask Drive to resolve ancestors when we have none stored — a folder
    // picked in this build already carried its path down from the browser, and
    // each level costs a request.
    const needPath = !(client.driveFolderPath && client.driveFolderPath.length);
    const verify = await sendMessageWithTimeout({
      action: 'driveVerifyFolder', folderId: client.driveFolderId, withPath: needPath
    }).catch(() => null);
    if (verify && verify.missing) {
      const hint = document.createElement('span');
      hint.className = 'field-hint hint-red';
      hint.textContent = 'This folder is no longer available — pick a new one.';
      row.appendChild(hint);
    } else {
      const ancestors = (client.driveFolderPath && client.driveFolderPath.length)
        ? client.driveFolderPath
        : ((verify && verify.path) || []);
      const folderName = (verify && verify.name) || client.driveFolderName || client.driveFolderId;

      const name = document.createElement('span');
      name.className = 'client-drive-name';
      // Ancestors are muted and the folder itself is not, so the eye lands on
      // the folder exports actually go into.
      ancestors.forEach(a => {
        const crumb = document.createElement('span');
        crumb.className = 'client-drive-crumb';
        crumb.textContent = a;
        name.append(crumb, document.createTextNode(' \u203a '));
      });
      name.appendChild(document.createTextNode(folderName));
      name.title = [...ancestors, folderName].join(' \u203a ');
      row.appendChild(name);

      // Backfilled from Drive rather than the picker — save it so the next
      // panel open costs nothing.
      if (needPath && verify && verify.path && verify.path.length) {
        saveClientField({ driveFolderPath: verify.path });
      }

      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'icon-btn';
      openBtn.title = 'Open this folder in Google Drive';
      openBtn.appendChild(svgFromString('<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2.5h4.5V7"/><path d="M13.5 2.5L8 8"/><path d="M11.5 9v3.5a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1H7"/></svg>'));
      openBtn.addEventListener('click', () => browser.tabs.create({ url: `https://drive.google.com/drive/folders/${client.driveFolderId}` }));
      row.appendChild(openBtn);

      row.appendChild(propertyTrashButton('Unlink this Drive folder', async () => {
        await ensureClientPersisted();
        await saveClientField({ driveFolderId: null, driveFolderName: null, driveFolderPath: [] });
        renderClientPanelContent();
      }));
    }
  } else {
    const hint = document.createElement('span');
    hint.className = 'field-hint hint-muted';
    hint.textContent = 'Not set';
    row.appendChild(hint);
  }

  const browseBtn = document.createElement('button');
  browseBtn.className = 'save-key-btn';
  browseBtn.textContent = 'Browse…';
  browseBtn.addEventListener('click', () => openDriveFolderBrowser());
  row.appendChild(browseBtn);
}

// The breadcrumb the user just navigated IS the folder's path, so capturing it
// here costs nothing. `ancestors` is everything above the chosen folder; only
// the nearest two are kept, which is where a name stops being ambiguous.
async function onDriveFolderPicked(folder, ancestors = []) {
  await ensureClientPersisted();
  await saveClientField({
    driveFolderId: folder.id,
    driveFolderName: folder.name,
    driveFolderPath: ancestors.slice(-2)
  });
  closeDriveFolderBrowser();
  renderClientPanelContent();
}

// Names above the current browser location, outermost first. My Drive is
// included because "My Drive > Acme" tells a reader more than a bare "Acme";
// a Shared Drive already sits at the head of _driveBrowserPath under its own
// name, and "Shared with me" is not a real folder anything lives in.
function driveBrowserAncestors(excludeCurrent) {
  const names = _driveBrowserPath.map(f => f.name);
  if (excludeCurrent) names.pop();
  if (_driveBrowserRoot === 'mydrive') names.unshift('My Drive');
  return names;
}

// ─── Per-domain binding pickers ───────────────────────────────────────────────
// A generic version of the four tabs' renderXPropertyOptions (which are all
// hardcoded to "the current tab's host") — the Client panel needs to pick a
// binding for an arbitrary domain, not necessarily the one being viewed.

function buildBindingOption(item, idKey, labelKey, sublabelKey, isActive, onSelect) {
  const id = item[idKey];
  const label = item[labelKey] || id;
  const sub = sublabelKey ? item[sublabelKey] : null;
  const opt = document.createElement('button');
  opt.className = 'gsc-property-option' + (isActive ? ' gsc-property-option--active' : '');
  opt.dataset.search = `${label} ${sub || ''} ${id}`.toLowerCase();

  const radio = document.createElement('span');
  radio.className = 'gsc-property-radio';
  const text = document.createElement('span');
  text.className = 'gsc-property-option-text';
  text.textContent = label;
  opt.append(radio, text);

  if (sub) {
    const idEl = document.createElement('span');
    idEl.className = 'gsc-property-id';
    idEl.textContent = sub;
    opt.appendChild(idEl);
  }

  opt.addEventListener('click', () => onSelect(id));
  return opt;
}

// A client can carry hundreds of properties/accounts once an account has
// enough history — showing them all at once (the original behavior: every
// row rendered, none hidden) was exactly the "messy wall of rows" this fixes.
// Now nothing is shown until there's a query, and matches are capped so a
// broad query can't reproduce the same wall.
const CLIENT_BINDING_RESULTS_CAP = 30;

// `suggested`, when given, is a confident match this page's own detected tag
// already points to (see clientBindingFetch's measurementId pass-through for
// GA4) — pinned above the search box regardless of what's typed, since making
// the user type the exact name of something already known defeats the point.
function renderClientBindingOptions(container, items, selected, { idKey, labelKey, sublabelKey, suggested }, onSelect) {
  container.replaceChildren();
  if (!items.length) {
    const hint = document.createElement('div');
    hint.className = 'field-hint hint-muted';
    hint.textContent = 'Nothing to pick from yet.';
    container.appendChild(hint);
    return;
  }

  if (suggested) {
    const sugItem = items.find(i => i[idKey] === suggested.id);
    if (sugItem) {
      const row = document.createElement('div');
      row.className = 'gsc-property-suggested';
      const badge = document.createElement('div');
      badge.className = 'gsc-property-suggested-badge';
      badge.textContent = suggested.reason;
      row.appendChild(badge);
      row.appendChild(buildBindingOption(sugItem, idKey, labelKey, sublabelKey, sugItem[idKey] === selected, onSelect));
      container.appendChild(row);
    }
  }

  // Matches the in-tab pickers' own structure (.gsc-property-all, scrollable)
  // rather than appending straight into .gsc-property-box — that box has no
  // gap between children, so without this wrapper a capped list of up to 30
  // rows would stack edge-to-edge with no spacing between them.
  const list = document.createElement('div');
  list.className = 'gsc-property-all gsc-property-all--scroll';
  container.appendChild(list);

  const search = document.createElement('input');
  search.type = 'text';
  search.className = 'ga-property-search';
  search.placeholder = `Search ${items.length} ${items.length === 1 ? 'option' : 'options'}…`;
  search.autocomplete = 'off';
  search.spellcheck = false;
  list.appendChild(search);

  const hint = document.createElement('div');
  hint.className = 'field-hint hint-muted';
  hint.textContent = 'Start typing to search…';
  list.appendChild(hint);

  const more = document.createElement('div');
  more.className = 'field-hint hint-muted hidden';
  list.appendChild(more);

  const options = items.map(item => buildBindingOption(item, idKey, labelKey, sublabelKey, item[idKey] === selected, onSelect));
  options.forEach(opt => list.appendChild(opt));

  function applyFilter() {
    const q = search.value.trim().toLowerCase();
    hint.classList.toggle('hidden', !!q);
    if (!q) {
      options.forEach(opt => opt.classList.add('hidden'));
      more.classList.add('hidden');
      return;
    }
    let shown = 0, matched = 0;
    options.forEach(opt => {
      const isMatch = opt.dataset.search.includes(q);
      if (isMatch) matched++;
      const show = isMatch && shown < CLIENT_BINDING_RESULTS_CAP;
      opt.classList.toggle('hidden', !show);
      if (show) shown++;
    });
    const overflow = matched - shown;
    more.textContent = overflow > 0 ? `+${overflow} more — keep typing to narrow it down` : '';
    more.classList.toggle('hidden', overflow <= 0);
  }
  search.addEventListener('input', applyFilter);
  applyFilter();   // establishes the hidden-until-typed initial state
}

const CLIENT_BINDING_KINDS = {
  gsc:    { label: 'Search Console', action: 'gscSetProperty',    paramKey: 'siteUrl' },
  ga:     { label: 'Analytics',      action: 'gaSetProperty',     paramKey: 'property' },
  ads:    { label: 'Google Ads',     action: 'adsSetAccount',     paramKey: 'account' },
  webceo: { label: 'Web CEO',        action: 'webceoSetProject',  paramKey: 'project' }
};

// The GA4 measurement ID Tags & Pixels already found on the CURRENT tab, if
// any — prefer that broader detector (it also catches gtag loaded via GTM,
// which the older narrow gaMeasurementIds field misses), falling back to the
// original field for safety. Only meaningful for whichever domain matches the
// tab actually being inspected; a client's other domains have no live page to
// have detected anything from.
function detectedGaMeasurementId() {
  if (typeof pageData === 'undefined' || !pageData) return null;
  const vendors = pageData.marketingTags && pageData.marketingTags.vendors;
  const ga4 = Array.isArray(vendors) && vendors.find(v => v.id === 'ga4');
  if (ga4 && ga4.ids && ga4.ids[0]) return ga4.ids[0];
  return (pageData.gaMeasurementIds && pageData.gaMeasurementIds[0]) || null;
}

async function clientBindingFetch(domain, kind) {
  const pageUrl = `https://${domain}/`;
  if (kind === 'gsc') {
    const [list, resolved] = await Promise.all([
      sendMessageWithTimeout({ action: 'gscListProperties' }),
      sendMessageWithTimeout({ action: 'gscResolveProperty', pageUrl })
    ]);
    return {
      connected: list.connected, error: list.error || resolved.error, detail: list.detail || resolved.detail,
      items: (list.sites || []).map(s => ({ id: s.siteUrl, label: s.siteUrl })),
      selected: resolved.override || resolved.siteUrl || null
    };
  }
  if (kind === 'ga') {
    const measurementId = domain === _currentClientHost ? detectedGaMeasurementId() : null;
    const r = await sendMessageWithTimeout({ action: 'gaResolveProperty', pageUrl, measurementId });
    return {
      connected: r.connected, error: r.error, detail: r.detail,
      items: (r.properties || []).map(p => ({ id: p.property, label: p.displayName, sub: p.account })),
      selected: r.property || null,
      suggested: r.detectedProperty
        ? { id: r.detectedProperty, reason: measurementId ? `${measurementId} detected on this page` : 'Detected on this page' }
        : null
    };
  }
  if (kind === 'ads') {
    const r = await sendMessageWithTimeout({ action: 'adsResolveAccount', pageUrl });
    return {
      connected: r.connected, error: r.error, detail: r.detail,
      items: (r.accounts || []).map(a => ({ id: a.id, label: a.name, sub: a.id })),
      selected: r.account || null
    };
  }
  const r = await sendMessageWithTimeout({ action: 'webceoResolveProject', pageUrl });
  return {
    connected: r.connected, error: r.error, detail: r.detail,
    items: (r.projects || []).map(p => ({ id: p.project, label: p.name, sub: p.domain })),
    selected: r.project || null
  };
}

function renderClientBindingRow(container, domain, kind) {
  const cfg = CLIENT_BINDING_KINDS[kind];
  const title = document.createElement('div');
  title.className = 'client-binding-label';
  title.textContent = cfg.label;
  container.appendChild(title);

  const box = document.createElement('div');
  box.className = 'gsc-property-box';
  container.appendChild(box);

  fillClientBindingBox(box, domain, kind);
}

// Fetches + renders one binding box in place — used both for the initial
// render and to redraw after a pick/unlink, without rebuilding the rest of
// the panel (which would also re-fire every other domain's fetches).
async function fillClientBindingBox(box, domain, kind) {
  const cfg = CLIENT_BINDING_KINDS[kind];
  let res;
  try { res = await clientBindingFetch(domain, kind); }
  catch { res = { connected: true, error: 'NETWORK' }; }

  if (!res.connected) {
    const hint = document.createElement('div');
    hint.className = 'field-hint hint-muted';
    hint.textContent = `Connect ${cfg.label} first, in Setup above.`;
    box.appendChild(hint);
    return;
  }
  if (res.error) {
    const hint = document.createElement('div');
    hint.className = 'field-hint hint-red';
    hint.textContent = res.detail || res.error;
    box.appendChild(hint);
    return;
  }

  const rerender = () => { box.replaceChildren(); fillClientBindingBox(box, domain, kind); };
  const selectedItem = res.items.find(i => i.id === res.selected);
  if (selectedItem) {
    renderSelectedRow(box, selectedItem.label, async () => {
      await sendMessageWithTimeout({ action: cfg.action, host: domain, [cfg.paramKey]: null });
      rerender();
    }, selectedItem.sub || null);
    return;
  }

  renderClientBindingOptions(box, res.items, res.selected, { idKey: 'id', labelKey: 'label', sublabelKey: 'sub', suggested: res.suggested }, async (id) => {
    await sendMessageWithTimeout({ action: cfg.action, host: domain, [cfg.paramKey]: id });
    rerender();
  });
}

// ─── Drive folder browser modal ───────────────────────────────────────────────

let _driveBrowserRoot = 'mydrive';     // 'mydrive' | 'shared' | 'teamdrives'
let _driveBrowserDriveId = null;       // set once a Shared Drive has been entered
let _driveBrowserPath = [];            // [{id, name}] — folders/drive descended into
// The folders (or Shared Drives) currently listed, kept so the filter box can
// narrow them without re-listing — Drive paginates heavily and a folder with
// dozens of children costs several round trips to enumerate.
let _driveBrowserItems = [];           // [{id, name, isDrive}]
let _driveBrowserFilter = '';

function openDriveFolderBrowser() {
  _driveBrowserRoot = 'mydrive';
  _driveBrowserDriveId = null;
  _driveBrowserPath = [];
  document.querySelectorAll('.drive-browser-root').forEach(b => b.classList.toggle('is-active', b.dataset.root === 'mydrive'));
  document.getElementById('drive-folder-browser').classList.remove('hidden');
  driveBrowserLoad();
}

function closeDriveFolderBrowser() {
  document.getElementById('drive-folder-browser').classList.add('hidden');
}

function handleDriveBrowserError(res, errorEl) {
  errorEl.replaceChildren();
  if (!res) {
    errorEl.textContent = 'Something went wrong.';
    errorEl.classList.remove('hidden');
    return true;
  }
  if (res.error === 'DRIVE_BROWSE_SCOPE_MISSING') {
    const btn = document.createElement('button');
    btn.className = 'save-key-btn';
    btn.textContent = 'Grant Drive browse access';
    btn.addEventListener('click', async () => {
      const upgrade = await sendMessageWithTimeout({ action: 'driveConnectBrowse' });
      if (upgrade && upgrade.connected) driveBrowserLoad();
    });
    errorEl.appendChild(btn);
    errorEl.classList.remove('hidden');
    return true;
  }
  if (res.notConnected) {
    errorEl.textContent = 'Connect Drive first, in Setup above.';
    errorEl.classList.remove('hidden');
    return true;
  }
  if (res.error) {
    errorEl.textContent = res.detail || res.error;
    errorEl.classList.remove('hidden');
    return true;
  }
  return false;
}

// Navigating "into" an item is shared by the row click, the drill-in
// chevron, and (implicitly) "Here" — which just skips straight to picking
// the folder you'd land on instead of drilling in first.
function driveBrowserEnter(id, name, isDrive) {
  if (isDrive) { _driveBrowserDriveId = id; _driveBrowserPath = [{ id, name }]; }
  else { _driveBrowserPath.push({ id, name }); }
  driveBrowserLoad();
}

function driveBrowserRow(id, name, isDrive) {
  const row = document.createElement('div');
  row.className = 'drive-browser-item';
  row.title = `Open "${name}"`;
  row.addEventListener('click', () => driveBrowserEnter(id, name, isDrive));

  const text = document.createElement('span');
  text.className = 'drive-browser-item-name';
  text.textContent = name;
  row.appendChild(text);

  const actions = document.createElement('div');
  actions.className = 'drive-browser-item-actions';

  const hereBtn = document.createElement('button');
  hereBtn.type = 'button';
  hereBtn.className = 'drive-browser-item-here';
  hereBtn.title = `Save exports directly in "${name}"`;
  hereBtn.textContent = 'Here';
  // Picked without descending, so the current location is its whole path.
  hereBtn.addEventListener('click', (e) => { e.stopPropagation(); onDriveFolderPicked({ id, name }, driveBrowserAncestors(false)); });
  actions.appendChild(hereBtn);

  const drillBtn = document.createElement('button');
  drillBtn.type = 'button';
  drillBtn.className = 'drive-browser-item-drill';
  drillBtn.title = `Open "${name}"`;
  drillBtn.appendChild(svgFromString('<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 3 11 8 6 13"/></svg>'));
  drillBtn.addEventListener('click', (e) => { e.stopPropagation(); driveBrowserEnter(id, name, isDrive); });
  actions.appendChild(drillBtn);

  row.appendChild(actions);
  return row;
}

function renderDriveBreadcrumb() {
  const el = document.getElementById('drive-browser-breadcrumb');
  el.replaceChildren();
  const rootLabel = { mydrive: 'My Drive', shared: 'Shared with me', teamdrives: 'Shared Drives' }[_driveBrowserRoot];

  const rootBtn = document.createElement('button');
  rootBtn.className = 'drive-browser-crumb';
  rootBtn.textContent = rootLabel;
  rootBtn.addEventListener('click', () => { _driveBrowserPath = []; _driveBrowserDriveId = null; driveBrowserLoad(); });
  el.appendChild(rootBtn);

  _driveBrowserPath.forEach((seg, i) => {
    const sep = document.createElement('span');
    sep.className = 'drive-browser-crumb-sep';
    sep.textContent = '›';
    el.appendChild(sep);
    const btn = document.createElement('button');
    btn.className = 'drive-browser-crumb';
    btn.textContent = seg.name;
    btn.addEventListener('click', () => { _driveBrowserPath = _driveBrowserPath.slice(0, i + 1); driveBrowserLoad(); });
    el.appendChild(btn);
  });
}

// Paints _driveBrowserItems through the filter box. Separated from the load so
// keystrokes never touch the network.
function renderDriveBrowserItems() {
  const listEl  = document.getElementById('drive-browser-list');
  const emptyEl = document.getElementById('drive-browser-empty');
  listEl.replaceChildren();

  const q = _driveBrowserFilter.trim().toLowerCase();
  const shown = q ? _driveBrowserItems.filter(it => it.name.toLowerCase().includes(q)) : _driveBrowserItems;

  emptyEl.textContent = !_driveBrowserItems.length ? 'No folders here.'
    : `Nothing here matches “${_driveBrowserFilter.trim()}”.`;
  emptyEl.classList.toggle('hidden', shown.length > 0);

  shown.forEach(it => listEl.appendChild(driveBrowserRow(it.id, it.name, it.isDrive)));
}

async function driveBrowserLoad() {
  const listEl  = document.getElementById('drive-browser-list');
  const emptyEl = document.getElementById('drive-browser-empty');
  const errorEl = document.getElementById('drive-browser-error');
  listEl.replaceChildren();
  // A filter is about the folder you're looking at, so descending clears it.
  _driveBrowserItems = [];
  _driveBrowserFilter = '';
  const filterInput = document.getElementById('drive-browser-filter');
  if (filterInput) filterInput.value = '';
  emptyEl.classList.add('hidden');
  errorEl.classList.add('hidden');
  renderDriveBreadcrumb();
  document.getElementById('btn-drive-browser-select').disabled = _driveBrowserPath.length === 0;

  // Drive's files.list can return far fewer than `pageSize` items in a
  // single response even when more exist (a nextPageToken shows up anyway) —
  // so a folder with dozens of children needs several round trips to list
  // in full, not just one. Capped at 20 pages so a pathological folder can't
  // hang the picker open.
  const DRIVE_BROWSER_MAX_PAGES = 20;

  if (_driveBrowserRoot === 'teamdrives' && !_driveBrowserDriveId) {
    let drives = [], pageToken, pages = 0;
    do {
      const res = await sendMessageWithTimeout({ action: 'driveListSharedDrives', pageToken });
      if (handleDriveBrowserError(res, errorEl)) return;
      drives = drives.concat(res.drives || []);
      pageToken = res.nextPageToken || null;
    } while (pageToken && ++pages < DRIVE_BROWSER_MAX_PAGES);
    _driveBrowserItems = drives.map(d => ({ id: d.id, name: d.name, isDrive: true }));
    renderDriveBrowserItems();
    return;
  }

  const parentId = _driveBrowserPath.length ? _driveBrowserPath[_driveBrowserPath.length - 1].id : (_driveBrowserDriveId || 'root');
  let folders = [], pageToken, pages = 0;
  do {
    const res = await sendMessageWithTimeout({
      action: 'driveListFolders',
      parentId,
      driveId: _driveBrowserDriveId || undefined,
      sharedWithMe: (_driveBrowserRoot === 'shared' && !_driveBrowserPath.length) || undefined,
      pageToken
    });
    if (handleDriveBrowserError(res, errorEl)) return;
    folders = folders.concat(res.folders || []);
    pageToken = res.nextPageToken || null;
  } while (pageToken && ++pages < DRIVE_BROWSER_MAX_PAGES);
  _driveBrowserItems = folders.map(f => ({ id: f.id, name: f.name, isDrive: false }));
  renderDriveBrowserItems();
}

document.getElementById('drive-browser-filter').addEventListener('input', (e) => {
  _driveBrowserFilter = e.target.value;
  renderDriveBrowserItems();
});

document.querySelectorAll('.drive-browser-root').forEach(btn => {
  btn.addEventListener('click', () => {
    _driveBrowserRoot = btn.dataset.root;
    _driveBrowserDriveId = null;
    _driveBrowserPath = [];
    document.querySelectorAll('.drive-browser-root').forEach(b => b.classList.toggle('is-active', b === btn));
    driveBrowserLoad();
  });
});

document.getElementById('btn-drive-browser-close').addEventListener('click', closeDriveFolderBrowser);
document.getElementById('btn-drive-browser-cancel').addEventListener('click', closeDriveFolderBrowser);
document.getElementById('btn-drive-browser-select').addEventListener('click', () => {
  if (!_driveBrowserPath.length) return;
  // Picked from inside it, so drop it off the end of its own path.
  onDriveFolderPicked(_driveBrowserPath[_driveBrowserPath.length - 1], driveBrowserAncestors(true));
});
