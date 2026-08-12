// ─── Client Registry UI ───────────────────────────────────────────────────────
// Replaces the old per-host Branded Terms list/form in Settings with a
// CLIENTS list + a full-screen Client panel (name, domains, branded terms,
// keywords, Drive folder, and per-domain GSC/GA4/Ads/Web CEO bindings).
//
// A brand-new client has no id until its first real edit (name/keywords/Drive
// folder) — ensureClientPersisted() creates it then; abandoning a blank panel
// via Back never leaves an empty client behind. Domains and branded terms use
// their own dedicated background actions (clientRegistryAddDomain/
// RemoveDomain/SetBrandedTerms) since those cascade cleanup of the flat
// override maps/caches — a plain clientRegistrySave never touches those.

let _clients = [];
let _editingClient = null;

function clientRegistryDraft() {
  return { id: null, name: '', domains: [], brandedTerms: '', keywords: [], driveFolderId: null, driveFolderName: null };
}

function patchClientInList(client) {
  const i = _clients.findIndex(c => c.id === client.id);
  if (i === -1) _clients.push(client); else _clients[i] = client;
  renderClientsList();
}

function loadClients() {
  return sendMessageWithTimeout({ action: 'clientRegistryList' }).then(res => {
    _clients = (res && res.clients) || [];
    renderClientsList();
  });
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

  _clients.forEach(client => {
    const domains = (client.domains || []).map(d => d.domain);
    const line2 = domains.length ? domains.join(', ') : 'No domains yet';
    const { row, removeBtn, editBtn } = buildSettingsRow(client.name || 'Unnamed client', line2, 'Delete', true, domains[0] || null);
    row.addEventListener('click', (e) => {
      if (e.target.closest('.wp-site-remove') || e.target.closest('.wp-site-edit')) return;
      showClientPanel(client.id);
    });
    editBtn.addEventListener('click', () => showClientPanel(client.id));
    removeBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
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
    const res = await sendMessageWithTimeout({ action: 'clientRegistryGet', id });
    _editingClient = (res && res.client) || clientRegistryDraft();
  } else {
    _editingClient = clientRegistryDraft();
  }
  renderClientPanelContent();
}

async function deleteCurrentClient() {
  if (!_editingClient || !_editingClient.id) { hideClientPanelToSettings(); return; }
  await sendMessageWithTimeout({ action: 'clientRegistryDelete', id: _editingClient.id });
  _clients = _clients.filter(c => c.id !== _editingClient.id);
  renderClientsList();
  hideClientPanelToSettings();
}

// Handles only fields with no override/cache implications (name, keywords,
// Drive folder) — creates the client on its first call if it doesn't exist yet.
async function saveClientField(patch) {
  const client = { id: _editingClient.id, name: _editingClient.name, keywords: _editingClient.keywords, ...patch };
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
  await saveClientField({ name: _editingClient.name || 'New Client' });
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
  nameInput.value = client.name || '';
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

  // Keywords
  const keywordsSection = document.createElement('section');
  keywordsSection.className = 'field-section';
  const kwLabel = document.createElement('label');
  kwLabel.className = 'wp-field';
  const kwLabelText = document.createElement('span');
  kwLabelText.className = 'wp-field-label';
  kwLabelText.textContent = 'Keywords (comma-separated)';
  const kwInput = document.createElement('input');
  kwInput.type = 'text';
  kwInput.className = 'wp-input';
  kwInput.placeholder = 'keyword one, keyword two';
  kwInput.value = (client.keywords || []).join(', ');
  kwInput.autocomplete = 'off';
  kwInput.spellcheck = false;
  kwInput.addEventListener('blur', () => {
    const keywords = kwInput.value.split(',').map(s => s.trim()).filter(Boolean);
    saveClientField({ keywords }).then(renderClientPanelContent);
  });
  kwLabel.append(kwLabelText, kwInput);
  keywordsSection.appendChild(kwLabel);
  root.appendChild(keywordsSection);

  // Image SEO (WP Media Library generators) — client-level, like branded
  // terms above. Any future domain/brand-specific setting belongs here too,
  // rather than a new top-level Settings section.
  const imageSeoSection = document.createElement('section');
  imageSeoSection.className = 'field-section';
  renderImageSeoSection(imageSeoSection, client);
  root.appendChild(imageSeoSection);

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

// Per-domain goals for the WP Media Library generators (Alt Text/Title/
// Caption/Description), client-level like branded terms above. Each field
// saves independently on blur/change, merged against the LIVE _editingClient
// (not the `client` snapshot this function closed over) so editing one field
// right after another never clobbers the previous save.
function renderImageSeoSection(container, client) {
  const header = document.createElement('div');
  header.className = 'field-label';
  header.textContent = 'IMAGE SEO (WordPress Media Library generators)';
  container.appendChild(header);

  const cfg = client.imageSeo || {};

  const saveImageSeo = async (patch) => {
    const next = { ...(_editingClient.imageSeo || {}), ...patch };
    const id = await ensureClientPersisted();
    const res = await sendMessageWithTimeout({ action: 'clientRegistrySetImageSeo', id, imageSeo: next });
    if (res && res.client) { _editingClient = res.client; patchClientInList(_editingClient); }
  };

  const kwLabel = document.createElement('label');
  kwLabel.className = 'wp-field';
  const kwLabelText = document.createElement('span');
  kwLabelText.className = 'wp-field-label';
  kwLabelText.textContent = 'Focus Keywords (comma-separated)';
  const kwInput = document.createElement('input');
  kwInput.type = 'text';
  kwInput.className = 'wp-input';
  kwInput.placeholder = 'dental implants, cosmetic dentistry';
  kwInput.value = (cfg.focusKeywords || []).join(', ');
  kwInput.autocomplete = 'off';
  kwInput.spellcheck = false;
  kwInput.addEventListener('blur', () => saveImageSeo({ focusKeywords: kwInput.value.split(',').map(s => s.trim()).filter(Boolean) }));
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
  toneInput.addEventListener('blur', () => saveImageSeo({ tone: toneInput.value.trim() }));
  toneLabel.append(toneLabelText, toneInput);
  container.appendChild(toneLabel);

  const rulesLabel = document.createElement('label');
  rulesLabel.className = 'wp-field';
  const rulesLabelText = document.createElement('span');
  rulesLabelText.className = 'wp-field-label';
  rulesLabelText.textContent = 'Rules (applied to Alt Text, Title, Caption, and Description)';
  const rulesInput = document.createElement('textarea');
  rulesInput.className = 'wp-input';
  rulesInput.rows = 3;
  rulesInput.spellcheck = false;
  rulesInput.placeholder = 'e.g. Always work a location into the alt text — Twin Cities, Minneapolis, St. Paul — when the photo is of a local project. Call these "remodels", never "renovations".';
  rulesInput.value = cfg.rules || '';
  rulesInput.addEventListener('blur', () => saveImageSeo({ rules: rulesInput.value.trim() }));
  rulesLabel.append(rulesLabelText, rulesInput);
  container.appendChild(rulesLabel);

  const trackedLabel = document.createElement('label');
  trackedLabel.className = 'ranking-onpage-toggle';
  trackedLabel.style.marginTop = '8px';
  const trackedInput = document.createElement('input');
  trackedInput.type = 'checkbox';
  trackedInput.checked = cfg.useTrackedKeywords !== false;
  trackedInput.addEventListener('change', () => saveImageSeo({ useTrackedKeywords: trackedInput.checked }));
  trackedLabel.append(trackedInput, document.createTextNode(' Also use Web CEO tracked keywords'));
  container.appendChild(trackedLabel);

  const brandLabel = document.createElement('label');
  brandLabel.className = 'ranking-onpage-toggle';
  brandLabel.style.marginTop = '6px';
  const brandInput = document.createElement('input');
  brandInput.type = 'checkbox';
  brandInput.checked = !!cfg.includeBrand;
  brandInput.addEventListener('change', () => saveImageSeo({ includeBrand: brandInput.checked }));
  brandLabel.append(brandInput, document.createTextNode(' Allow the brand name in Title / Caption / Description'));
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
    const verify = await sendMessageWithTimeout({ action: 'driveVerifyFolder', folderId: client.driveFolderId }).catch(() => null);
    if (verify && verify.missing) {
      const hint = document.createElement('span');
      hint.className = 'field-hint hint-red';
      hint.textContent = 'This folder is no longer available — pick a new one.';
      row.appendChild(hint);
    } else {
      const name = document.createElement('span');
      name.className = 'client-drive-name';
      name.textContent = client.driveFolderName || client.driveFolderId;
      row.appendChild(name);
      row.appendChild(propertyTrashButton('Unlink this Drive folder', async () => {
        await ensureClientPersisted();
        await saveClientField({ driveFolderId: null, driveFolderName: null });
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

async function onDriveFolderPicked(folder) {
  await ensureClientPersisted();
  await saveClientField({ driveFolderId: folder.id, driveFolderName: folder.name });
  closeDriveFolderBrowser();
  renderClientPanelContent();
}

// ─── Per-domain binding pickers ───────────────────────────────────────────────
// A generic version of the four tabs' renderXPropertyOptions (which are all
// hardcoded to "the current tab's host") — the Client panel needs to pick a
// binding for an arbitrary domain, not necessarily the one being viewed.
function renderClientBindingOptions(container, items, selected, { idKey, labelKey, sublabelKey }, onSelect) {
  container.replaceChildren();
  if (!items.length) {
    const hint = document.createElement('div');
    hint.className = 'field-hint hint-muted';
    hint.textContent = 'Nothing to pick from yet.';
    container.appendChild(hint);
    return;
  }

  const search = document.createElement('input');
  search.type = 'text';
  search.className = 'ga-property-search';
  search.placeholder = 'Search…';
  search.autocomplete = 'off';
  search.spellcheck = false;
  container.appendChild(search);

  items.forEach(item => {
    const id = item[idKey];
    const label = item[labelKey] || id;
    const sub = sublabelKey ? item[sublabelKey] : null;
    const opt = document.createElement('button');
    opt.className = 'gsc-property-option' + (id === selected ? ' gsc-property-option--active' : '');
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
    container.appendChild(opt);
  });

  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    container.querySelectorAll('.gsc-property-option').forEach(el => {
      el.classList.toggle('hidden', q && !el.dataset.search.includes(q));
    });
  });
}

const CLIENT_BINDING_KINDS = {
  gsc:    { label: 'Search Console', action: 'gscSetProperty',    paramKey: 'siteUrl' },
  ga:     { label: 'Analytics',      action: 'gaSetProperty',     paramKey: 'property' },
  ads:    { label: 'Google Ads',     action: 'adsSetAccount',     paramKey: 'account' },
  webceo: { label: 'Web CEO',        action: 'webceoSetProject',  paramKey: 'project' }
};

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
    const r = await sendMessageWithTimeout({ action: 'gaResolveProperty', pageUrl });
    return {
      connected: r.connected, error: r.error, detail: r.detail,
      items: (r.properties || []).map(p => ({ id: p.property, label: p.displayName, sub: p.account })),
      selected: r.property || null
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

  renderClientBindingOptions(box, res.items, res.selected, { idKey: 'id', labelKey: 'label', sublabelKey: 'sub' }, async (id) => {
    await sendMessageWithTimeout({ action: cfg.action, host: domain, [cfg.paramKey]: id });
    rerender();
  });
}

// ─── Drive folder browser modal ───────────────────────────────────────────────

let _driveBrowserRoot = 'mydrive';     // 'mydrive' | 'shared' | 'teamdrives'
let _driveBrowserDriveId = null;       // set once a Shared Drive has been entered
let _driveBrowserPath = [];            // [{id, name}] — folders/drive descended into

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

function driveBrowserRow(id, name, isDrive) {
  const opt = document.createElement('button');
  opt.className = 'gsc-property-option';
  const radio = document.createElement('span');
  radio.className = 'gsc-property-radio';
  const text = document.createElement('span');
  text.className = 'gsc-property-option-text';
  text.textContent = name;
  opt.append(radio, text);
  opt.addEventListener('click', () => {
    if (isDrive) { _driveBrowserDriveId = id; _driveBrowserPath = [{ id, name }]; }
    else { _driveBrowserPath.push({ id, name }); }
    driveBrowserLoad();
  });
  return opt;
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

async function driveBrowserLoad() {
  const listEl  = document.getElementById('drive-browser-list');
  const emptyEl = document.getElementById('drive-browser-empty');
  const errorEl = document.getElementById('drive-browser-error');
  listEl.replaceChildren();
  emptyEl.classList.add('hidden');
  errorEl.classList.add('hidden');
  renderDriveBreadcrumb();
  document.getElementById('btn-drive-browser-select').disabled = _driveBrowserPath.length === 0;

  if (_driveBrowserRoot === 'teamdrives' && !_driveBrowserDriveId) {
    const res = await sendMessageWithTimeout({ action: 'driveListSharedDrives' });
    if (handleDriveBrowserError(res, errorEl)) return;
    const drives = res.drives || [];
    if (!drives.length) emptyEl.classList.remove('hidden');
    drives.forEach(d => listEl.appendChild(driveBrowserRow(d.id, d.name, true)));
    return;
  }

  const parentId = _driveBrowserPath.length ? _driveBrowserPath[_driveBrowserPath.length - 1].id : (_driveBrowserDriveId || 'root');
  const res = await sendMessageWithTimeout({
    action: 'driveListFolders',
    parentId,
    driveId: _driveBrowserDriveId || undefined,
    sharedWithMe: (_driveBrowserRoot === 'shared' && !_driveBrowserPath.length) || undefined
  });
  if (handleDriveBrowserError(res, errorEl)) return;
  const folders = res.folders || [];
  if (!folders.length) emptyEl.classList.remove('hidden');
  folders.forEach(f => listEl.appendChild(driveBrowserRow(f.id, f.name, false)));
}

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
  onDriveFolderPicked(_driveBrowserPath[_driveBrowserPath.length - 1]);
});
