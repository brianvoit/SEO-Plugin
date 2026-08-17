// Part of the extension background — see bg-core.js for how these files load.
// Client Registry, the Drive folder browser, and export-folder retargeting.

// ─── Client Registry ─────────────────────────────────────────────────────────
// Unifies the six separate host-keyed maps above (gscPropertyOverrides,
// gaPropertyOverrides, adsAccountOverrides, webceoProjectOverrides, the
// popup-owned brandedTerms, and imageSeoConfig) into one synced "Client" per
// group of domains — an agency's whole per-client setup (which GSC property,
// which Ads account, branded terms, image-SEO prompt guidance, a Drive
// folder) now travels between machines via storage.sync, instead of only
// branded terms doing so. This is also the intended home for any FUTURE
// domain/brand-specific setting — add a field to the Client record and a
// setter here, rather than a new host-keyed map and a new Settings section.
// The Client panel is the only place any of this is edited; the Settings
// list itself only ever shows a client's name and domain count (see
// popup-clients.js) — click in to see the specifics.
//
// Sharded one storage.sync item per client (`client:<id>`) to stay well under
// the 8KB-per-item quota — a single combined item would cap out around
// 12-25 clients. `clientIndex` is a small {id,name} summary so the list can
// render without fetching every client record.
//
// The four override maps are NOT retired — gscLoadOverride/gaGetProperty/
// adsGetAccount/webceoGetProject (the read side every tab's data-fetching
// actually uses) keep reading them completely unchanged. Only the write side
// changes: gscSetProperty/gaSetProperty/adsSetAccount/webceoSetProject keep
// their exact signatures and their own override-map write, and now also call
// clientRegistrySetBinding() to mirror the change into the owning Client —
// best-effort, so a sync hiccup never breaks the flat-map write that already
// succeeded. The maps become a materialized, always-current view of the
// registry rather than the registry itself.
//
// Branded terms is the one exception with a real behavior change: it becomes
// CLIENT-level (one pattern shared by every domain the client owns) rather
// than per-host, edited only from the Client panel via
// clientRegistrySetBrandedTerms(). popup-shared.js's allBrandedTerms /
// loadBrandedTermsStore / saveBrandedTerms and every one of their 7 existing
// readers (popup-gsc.js, popup-ads.js, popup-addkw.js, popup-generate.js,
// content.js, …) are deliberately left untouched — including the Search tab's
// "add this query as a branded term" quick-add and the Ads branded-terms
// toggle, which still write brandedTerms[host] directly from the popup. That
// means a quick-add can drift out of sync with a domain's Client record until
// the Client panel is next saved — an accepted limitation for this pass
// rather than building bidirectional per-host/client-level reconciliation.

function clientRegistryId() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `c${Date.now()}${Math.random().toString(36).slice(2)}`;
}

function clientRegistryNew(name) {
  const now = Date.now();
  return {
    id: clientRegistryId(), name: name || 'New Client', domains: [], brandedTerms: '', keywords: [],
    imageSeo: null, driveFolderId: null, driveFolderName: null, createdAt: now, updatedAt: now
  };
}

async function clientRegistryIndexRaw() {
  const { clientIndex } = await browser.storage.sync.get('clientIndex');
  return clientIndex || [];
}

async function clientRegistryGetRaw(id) {
  if (!id) return null;
  const key = `client:${id}`;
  const stored = await browser.storage.sync.get(key);
  return stored[key] || null;
}

async function clientRegistryListRaw() {
  const index = await clientRegistryIndexRaw();
  if (!index.length) return { clients: [] };
  const keys = index.map(e => `client:${e.id}`);
  const stored = await browser.storage.sync.get(keys);
  const clients = index.map(e => stored[`client:${e.id}`]).filter(Boolean);
  return { clients };
}

async function clientRegistrySaveRaw(client) {
  client.updatedAt = Date.now();
  await browser.storage.sync.set({ [`client:${client.id}`]: client });
  const index = await clientRegistryIndexRaw();
  const i = index.findIndex(e => e.id === client.id);
  const entry = { id: client.id, name: client.name || '' };
  if (i === -1) index.push(entry); else index[i] = entry;
  await browser.storage.sync.set({ clientIndex: index });
  return client;
}

// One-time migration: union the host keys across the five legacy maps and
// create one Client per host not already covered by an existing client
// (name = host, to be renamed/merged manually later — no bespoke "group
// these domains" wizard). Idempotent and safely retryable: the completion
// flag is only set after every host has been migrated, and a host already
// covered by a client (manually created or from a prior partial run) is
// skipped, so a retry after a failure never duplicates a client.
async function ensureClientRegistryMigrated() {
  const { clientRegistryMigrated } = await browser.storage.local.get('clientRegistryMigrated');
  if (clientRegistryMigrated) return;
  try {
    const { gscPropertyOverrides, gaPropertyOverrides, adsAccountOverrides, webceoProjectOverrides, imageSeoConfig } =
      await browser.storage.local.get(['gscPropertyOverrides', 'gaPropertyOverrides', 'adsAccountOverrides', 'webceoProjectOverrides', 'imageSeoConfig']);
    const branded = await bgLoadBrandedTerms();
    const hosts = new Set([
      ...Object.keys(gscPropertyOverrides || {}),
      ...Object.keys(gaPropertyOverrides || {}),
      ...Object.keys(adsAccountOverrides || {}),
      ...Object.keys(webceoProjectOverrides || {}),
      ...Object.keys(branded),
      ...Object.keys(imageSeoConfig || {})
    ]);
    if (hosts.size) {
      const { clients } = await clientRegistryListRaw();
      const already = new Set();
      for (const c of clients) for (const d of c.domains || []) already.add(d.domain);
      for (const host of hosts) {
        if (already.has(host)) continue;
        const client = clientRegistryNew(host);
        client.domains = [{
          domain: host,
          gscProperty: (gscPropertyOverrides && gscPropertyOverrides[host]) || null,
          gaProperty: (gaPropertyOverrides && gaPropertyOverrides[host]) || null,
          adsAccount: (adsAccountOverrides && adsAccountOverrides[host]) || null,
          webceoProject: (webceoProjectOverrides && webceoProjectOverrides[host]) || null
        }];
        client.brandedTerms = branded[host] || '';
        client.imageSeo = (imageSeoConfig && imageSeoConfig[host]) || null;
        await clientRegistrySaveRaw(client);
      }
    }
    await browser.storage.local.set({ clientRegistryMigrated: true });
  } catch { /* offline or sync unavailable — retried on the next call */ }
}

// Mirrors popup-shared.js's sync-with-local-fallback brandedTerms storage
// (loadBrandedTermsStore/saveBrandedTerms) for use from the background
// context, which has no access to the popup's in-memory allBrandedTerms.
async function bgLoadBrandedTerms() {
  try {
    const { brandedTerms } = await browser.storage.sync.get('brandedTerms');
    if (brandedTerms && Object.keys(brandedTerms).length) return brandedTerms;
  } catch { /* sync unavailable */ }
  const { brandedTerms: local } = await browser.storage.local.get('brandedTerms');
  return local || {};
}
async function bgSaveBrandedTerms(map) {
  try { await browser.storage.sync.set({ brandedTerms: map }); return; }
  catch { /* fall through to local */ }
  await browser.storage.local.set({ brandedTerms: map });
}

// Drops every flat override/cache/branded-term entry for one host — mirrors
// what gscDisconnect/webceoDisconnect already do when clearing a whole
// integration, just scoped to a single domain leaving a Client.
async function clientRegistryClearHost(host) {
  for (const key of ['gscPropertyOverrides', 'gaPropertyOverrides', 'adsAccountOverrides', 'webceoProjectOverrides']) {
    const stored = await browser.storage.local.get(key);
    const overrides = stored[key];
    if (overrides && overrides[host]) { delete overrides[host]; await browser.storage.local.set({ [key]: overrides }); }
  }
  const map = await bgLoadBrandedTerms();
  if (map[host]) { delete map[host]; await bgSaveBrandedTerms(map); }
  const { imageSeoConfig } = await browser.storage.local.get('imageSeoConfig');
  if (imageSeoConfig && imageSeoConfig[host]) {
    delete imageSeoConfig[host];
    await browser.storage.local.set({ imageSeoConfig });
  }
  await gscClearCacheForHost(host);
  await gaClearCacheForHost(host);
  await adsClearCacheForHost(host);
  await browser.storage.local.remove('webceoCache');
}

// Mirrors a binding a setter above just wrote to its flat override map into
// the owning Client, auto-creating a single-domain client named after the
// host if none owns it yet (same fallback shape migration uses). Best-effort.
async function clientRegistrySetBinding(host, field, value) {
  if (!host) return;
  try {
    await ensureClientRegistryMigrated();
    const { clients } = await clientRegistryListRaw();
    let client = clients.find(c => (c.domains || []).some(d => d.domain === host));
    if (!client) {
      client = clientRegistryNew(host);
      client.domains = [{ domain: host, gscProperty: null, gaProperty: null, adsAccount: null, webceoProject: null }];
    }
    const entry = client.domains.find(d => d.domain === host);
    entry[field] = value || null;
    await clientRegistrySaveRaw(client);
  } catch { /* registry sync is best-effort; the flat override already took effect */ }
}

async function clientRegistryList() {
  await ensureClientRegistryMigrated();
  return clientRegistryListRaw();
}

async function clientRegistryGet({ id }) {
  await ensureClientRegistryMigrated();
  const client = await clientRegistryGetRaw(id);
  return { client };
}

// Used by the export-folder prompt (popup-shared.js) to check, before an
// export runs, whether the page's domain belongs to a client that hasn't
// attached a Drive folder yet. Read-only — never auto-creates a client for
// an unregistered domain, same "never gate on having a Client" rule as
// everywhere else this registry is read from the export path.
async function clientRegistryFindByDomain({ domain }) {
  await ensureClientRegistryMigrated();
  const { clients } = await clientRegistryListRaw();
  const client = clients.find(c => (c.domains || []).some(d => d.domain === domain)) || null;
  return { client };
}

// Handles only the fields that carry no override/cache implications (name,
// keywords, Drive folder). Domain membership and branded terms go through
// their own actions below, which cascade the flat-map cleanup a plain
// overwrite here could otherwise silently orphan.
async function clientRegistrySave({ client }) {
  await ensureClientRegistryMigrated();
  if (!client) return { ok: false };
  if (!client.id) {
    const fresh = clientRegistryNew(client.name);
    fresh.keywords = Array.isArray(client.keywords) ? client.keywords : [];
    await clientRegistrySaveRaw(fresh);
    return { ok: true, client: fresh };
  }
  const existing = await clientRegistryGetRaw(client.id);
  if (!existing) return { ok: false, error: 'NOT_FOUND' };
  existing.name = client.name ?? existing.name;
  if (Array.isArray(client.keywords)) existing.keywords = client.keywords;
  if ('driveFolderId' in client) {
    existing.driveFolderId = client.driveFolderId || null;
    existing.driveFolderName = client.driveFolderName || null;
    // A fresh folder attachment clears any earlier "not now" — the whole
    // reason to dismiss the prompt (no folder to offer) no longer applies.
    if (existing.driveFolderId) existing.driveFolderPromptDismissed = false;
  }
  if ('driveFolderPromptDismissed' in client) {
    existing.driveFolderPromptDismissed = !!client.driveFolderPromptDismissed;
  }
  await clientRegistrySaveRaw(existing);
  return { ok: true, client: existing };
}

async function clientRegistryDelete({ id }) {
  await ensureClientRegistryMigrated();
  const client = await clientRegistryGetRaw(id);
  if (client) for (const d of client.domains || []) await clientRegistryClearHost(d.domain);
  await browser.storage.sync.remove(`client:${id}`);
  const index = (await clientRegistryIndexRaw()).filter(e => e.id !== id);
  await browser.storage.sync.set({ clientIndex: index });
  return { ok: true };
}

async function clientRegistryAddDomain({ id, domain }) {
  await ensureClientRegistryMigrated();
  const host = (domain || '').trim().toLowerCase().replace(/^www\./, '');
  if (!host) return { ok: false, error: 'BAD_DOMAIN' };
  const client = await clientRegistryGetRaw(id);
  if (!client) return { ok: false, error: 'NOT_FOUND' };
  client.domains = client.domains || [];
  if (client.domains.some(d => d.domain === host)) return { ok: true, client };

  // A domain can only belong to one client at a time (bindings are
  // host-singleton) — reassigning here mirrors picking a new property for an
  // already-bound host: the old binding is simply replaced.
  const { clients } = await clientRegistryListRaw();
  const owner = clients.find(c => c.id !== id && (c.domains || []).some(d => d.domain === host));
  if (owner) {
    owner.domains = (owner.domains || []).filter(d => d.domain !== host);
    await clientRegistrySaveRaw(owner);
  }

  client.domains.push({ domain: host, gscProperty: null, gaProperty: null, adsAccount: null, webceoProject: null });
  await clientRegistrySaveRaw(client);
  if (client.brandedTerms) {
    const map = await bgLoadBrandedTerms();
    map[host] = client.brandedTerms;
    await bgSaveBrandedTerms(map);
  }
  if (client.imageSeo) {
    const { imageSeoConfig } = await browser.storage.local.get('imageSeoConfig');
    const map = imageSeoConfig || {};
    map[host] = client.imageSeo;
    await browser.storage.local.set({ imageSeoConfig: map });
  }
  return { ok: true, client };
}

async function clientRegistryRemoveDomain({ id, domain }) {
  await ensureClientRegistryMigrated();
  const client = await clientRegistryGetRaw(id);
  if (!client) return { ok: false, error: 'NOT_FOUND' };
  client.domains = (client.domains || []).filter(d => d.domain !== domain);
  await clientRegistrySaveRaw(client);
  await clientRegistryClearHost(domain);
  return { ok: true, client };
}

// Branded terms editing lives only in the Client panel now (see the header
// comment above) — this is client-level, projected to every domain it owns.
async function clientRegistrySetBrandedTerms({ id, pattern }) {
  await ensureClientRegistryMigrated();
  const client = await clientRegistryGetRaw(id);
  if (!client) return { ok: false, error: 'NOT_FOUND' };
  client.brandedTerms = pattern || '';
  await clientRegistrySaveRaw(client);
  const map = await bgLoadBrandedTerms();
  for (const d of client.domains || []) {
    if (!d.domain) continue;
    if (client.brandedTerms) map[d.domain] = client.brandedTerms; else delete map[d.domain];
  }
  await bgSaveBrandedTerms(map);
  return { ok: true, client };
}

// Quick-add from the Search and Ads tables ("+" next to a query). Those used
// to write the per-host brandedTerms map directly from the popup, which left
// the owning client's record stale until the Client panel happened to be saved
// again. Routing the append through here keeps the two in step: the term lands
// on the CLIENT's pattern, and that pattern is projected back across every
// domain the client owns — so branding a term on one domain now applies to all
// of them, matching how the Client panel already behaves.
//
// Hosts with no client still work: they fall back to a bare per-host entry.
async function clientRegistryAddBrandedTerm({ host, term }) {
  await ensureClientRegistryMigrated();
  // Lowercase BEFORE stripping www., or an uppercase "WWW." survives the
  // strip and the entry is keyed somewhere nothing else looks. Same order as
  // clientRegistryAddDomain above. Today's callers all hand over a host
  // already normalised out of URL.hostname, so this is a guard on the
  // message-router contract rather than a live fix.
  const domain = String(host || '').toLowerCase().replace(/^www\./, '');
  const text = String(term || '').trim();
  if (!domain || !text) return { ok: false, error: 'BAD_INPUT' };

  const map = await bgLoadBrandedTerms();
  const { clients } = await clientRegistryListRaw();
  const client = clients.find(c => (c.domains || []).some(d => d.domain === domain)) || null;

  // The client's pattern is authoritative when one owns this domain.
  const current = client ? (client.brandedTerms || '') : (map[domain] || '');
  let covered = false;
  try { covered = !!current && new RegExp(current, 'i').test(text); } catch { covered = false; }
  if (covered) return { ok: true, pattern: current, client };

  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = current ? `${current}|${escaped}` : escaped;

  if (client) {
    client.brandedTerms = pattern;
    await clientRegistrySaveRaw(client);
    for (const d of client.domains || []) if (d.domain) map[d.domain] = pattern;
  } else {
    map[domain] = pattern;
  }
  await bgSaveBrandedTerms(map);
  return { ok: true, pattern, client };
}

// Image SEO prompt guidance for the WP Media Library generators — same
// client-level shape and projection as branded terms above, but unlike
// brandedTerms this map has only ever lived in storage.local (content.js
// reads it directly, no sync fallback), so it stays there rather than
// gaining a new sync path here.
async function clientRegistrySetImageSeo({ id, imageSeo }) {
  await ensureClientRegistryMigrated();
  const client = await clientRegistryGetRaw(id);
  if (!client) return { ok: false, error: 'NOT_FOUND' };
  client.imageSeo = imageSeo || null;
  await clientRegistrySaveRaw(client);
  const { imageSeoConfig } = await browser.storage.local.get('imageSeoConfig');
  const map = imageSeoConfig || {};
  for (const d of client.domains || []) {
    if (!d.domain) continue;
    if (client.imageSeo) map[d.domain] = client.imageSeo; else delete map[d.domain];
  }
  await browser.storage.local.set({ imageSeoConfig: map });
  return { ok: true, client };
}

// ─── Drive folder browser ────────────────────────────────────────────────────
// Lets a Client attach to a folder the user already has in their own Drive
// (an agency's existing Clients/<name>/ structure) rather than only the
// single app-managed "Marketing Plans" folder docsGetOrCreateFolder owns.
// `drive.file` (the export connection's scope) grants no access to a folder
// this app didn't create, so browsing needs the broader `drive` scope —
// requested lazily, only the first time a user clicks "Browse…", so users who
// only use exports never see the wider consent screen. Upgrades the SAME
// docsAuth connection (one Drive connection, two possible scope levels) via
// the exact backup/restore pattern gaConnectEdit already proved for the GA4
// analytics.edit upgrade.
const DRIVE_BROWSE_SCOPE = 'https://www.googleapis.com/auth/drive';

async function driveConnectBrowse() {
  const { docsAuth: backup } = await browser.storage.local.get('docsAuth');
  const res = await googleOAuthConnectRequireScope(DRIVE_BROWSE_SCOPE, 'docsAuth', 'DRIVE_BROWSE_SCOPE_MISSING');
  if (res && res.error === 'DRIVE_BROWSE_SCOPE_MISSING' && backup) {
    await browser.storage.local.set({ docsAuth: backup });
  }
  return res;
}

async function driveHasBrowseScope() {
  const { docsAuth } = await browser.storage.local.get('docsAuth');
  return /(^|\s)https:\/\/www\.googleapis\.com\/auth\/drive(\s|$)/.test((docsAuth && docsAuth.scope) || '');
}

async function driveListFolders({ parentId, driveId, sharedWithMe, pageToken }) {
  if (!(await driveHasBrowseScope())) return { error: 'DRIVE_BROWSE_SCOPE_MISSING' };
  const token = await docsGetAccessToken();
  if (token.error) return { notConnected: true, error: token.error };

  const clauses = ["mimeType='application/vnd.google-apps.folder'", 'trashed=false'];
  if (sharedWithMe) clauses.push('sharedWithMe=true');
  else clauses.push(`'${parentId || 'root'}' in parents`);

  const url = new URL('https://www.googleapis.com/drive/v3/files');
  url.searchParams.set('q', clauses.join(' and '));
  url.searchParams.set('fields', 'files(id,name),nextPageToken');
  url.searchParams.set('orderBy', 'name');
  url.searchParams.set('pageSize', '100');
  url.searchParams.set('supportsAllDrives', 'true');
  url.searchParams.set('includeItemsFromAllDrives', 'true');
  if (driveId) { url.searchParams.set('corpora', 'drive'); url.searchParams.set('driveId', driveId); }
  if (pageToken) url.searchParams.set('pageToken', pageToken);

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token.accessToken}` } });
  if (!res.ok) {
    if (res.status === 401) { await browser.storage.local.remove('docsAuth'); return { notConnected: true, error: 'REAUTH_REQUIRED' }; }
    const body = await res.json().catch(() => null);
    return { error: 'API_ERROR', detail: body?.error?.message || `files.list: HTTP ${res.status}` };
  }
  const data = await res.json();
  return { folders: data.files || [], nextPageToken: data.nextPageToken || null };
}

async function driveListSharedDrives({ pageToken }) {
  if (!(await driveHasBrowseScope())) return { error: 'DRIVE_BROWSE_SCOPE_MISSING' };
  const token = await docsGetAccessToken();
  if (token.error) return { notConnected: true, error: token.error };

  const url = new URL('https://www.googleapis.com/drive/v3/drives');
  url.searchParams.set('pageSize', '100');
  if (pageToken) url.searchParams.set('pageToken', pageToken);

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token.accessToken}` } });
  if (!res.ok) {
    if (res.status === 401) { await browser.storage.local.remove('docsAuth'); return { notConnected: true, error: 'REAUTH_REQUIRED' }; }
    const body = await res.json().catch(() => null);
    return { error: 'API_ERROR', detail: body?.error?.message || `drives.list: HTTP ${res.status}` };
  }
  const data = await res.json();
  return { drives: data.drives || [], nextPageToken: data.nextPageToken || null };
}

// Verifies a Client's bound Drive folder still exists (same verify-before-
// trust shape as sheetsGetOrCreateSpreadsheet). Never silently recreates —
// it's the user's own folder, not one this app created — the caller should
// prompt a re-pick when `missing` comes back true.
async function driveVerifyFolder({ folderId }) {
  if (!folderId) return { missing: true };
  const token = await docsGetAccessToken();
  if (token.error) return { notConnected: true, error: token.error };
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${folderId}?fields=id,name,trashed&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token.accessToken}` } }
  ).catch(() => null);
  if (!res || !res.ok) return { missing: true };
  const meta = await res.json();
  if (meta.trashed) return { missing: true };
  return { missing: false, name: meta.name };
}

// ─── Export retargeting: land exports in a Client's own Drive folder ───────
// Every export (Docs and Sheets alike) used to go straight to the single
// app-managed Marketing Plans folder via docsGetOrCreateFolder, regardless of
// which client's page it came from. Now that a Client can have its own
// attached Drive folder (driveFolderId, set via the folder browser above),
// exports for a domain owned by such a client should land inside it, under
// an app-owned "SEO Inspector" subfolder so they don't get dropped loose into
// the user's own Clients/<name>/ folder. Domains with no client — or whose
// client has no folder attached, or whose folder has gone missing — keep
// today's exact behaviour: the global Marketing Plans fallback.
const DRIVE_APP_SUBFOLDER = 'SEO Inspector';
const DRIVE_EXPORTS_SUBDIR = 'Exports';
const DRIVE_PLANS_SUBDIR = 'Plans';

// Finds (or creates) a folder named `name` directly under `parentId`.
// Dedupe-safe: queries by name+parent+mimeType+trashed=false before
// creating, so a retry (or two exports racing) never produces a duplicate
// "SEO Inspector" folder. supportsAllDrives covers a client folder that
// lives inside a Shared Drive.
async function driveFindOrCreateFolder(accessToken, parentId, name) {
  const q = `'${parentId}' in parents and name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const listUrl = new URL('https://www.googleapis.com/drive/v3/files');
  listUrl.searchParams.set('q', q);
  listUrl.searchParams.set('fields', 'files(id,name)');
  listUrl.searchParams.set('supportsAllDrives', 'true');
  listUrl.searchParams.set('includeItemsFromAllDrives', 'true');
  const listRes = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } }).catch(() => null);
  if (listRes && listRes.ok) {
    const data = await listRes.json();
    if (data.files && data.files[0]) return data.files[0].id;
  }
  const createRes = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
  });
  if (!createRes.ok) return null;
  const { id } = await createRes.json();
  return id;
}

// Resolves the two-level `SEO Inspector/<sub>` path inside a Client's Drive
// folder, caching the derived id locally (never synced — it's derivable,
// same discipline as sheetsSpreadsheetIds) and healing the same way
// sheetsGetOrCreateSpreadsheet verifies a cached id before trusting it. The
// cache is also invalidated automatically if the client's root folder itself
// changed (a re-pick via Browse…) since last resolved.
async function driveResolveClientSubfolder(accessToken, clientId, rootFolderId, sub) {
  const cacheKey = `${clientId}::${sub}`;
  const { driveExportFolderIds } = await browser.storage.local.get('driveExportFolderIds');
  const cache = driveExportFolderIds || {};
  const cached = cache[cacheKey];
  if (cached && cached.rootFolderId === rootFolderId) {
    const check = await fetch(
      `https://www.googleapis.com/drive/v3/files/${cached.id}?fields=id,trashed&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    ).catch(() => null);
    if (check && check.ok) {
      const meta = await check.json();
      if (!meta.trashed) return cached.id;
    }
  }

  const appFolderId = await driveFindOrCreateFolder(accessToken, rootFolderId, DRIVE_APP_SUBFOLDER);
  if (!appFolderId) return null;
  const subId = await driveFindOrCreateFolder(accessToken, appFolderId, sub);
  if (!subId) return null;

  cache[cacheKey] = { id: subId, rootFolderId, updatedAt: Date.now() };
  await writeCache('driveExportFolderIds', cache);
  return subId;
}

// The single entry point every export path resolves its destination folder
// through. `sub` is DRIVE_EXPORTS_SUBDIR for a stable history-log Sheet or
// DRIVE_PLANS_SUBDIR for a dated one-per-run Doc.
async function resolveExportFolder(accessToken, pageUrl, sub) {
  const domain = sheetsDomainFromUrl(pageUrl);
  const { clients } = await clientRegistryListRaw();
  const client = clients.find(c => (c.domains || []).some(d => d.domain === domain));

  if (client && client.driveFolderId) {
    const verify = await driveVerifyFolder({ folderId: client.driveFolderId }).catch(() => ({ missing: true }));
    if (!verify.missing) {
      const subId = await driveResolveClientSubfolder(accessToken, client.id, client.driveFolderId, sub);
      if (subId) return { folderId: subId, clientId: client.id };
    }
  }
  const folderId = await docsGetOrCreateFolder(accessToken);
  return { folderId, clientId: null };
}
