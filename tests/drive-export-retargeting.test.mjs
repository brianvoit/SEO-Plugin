// Tests bg-export.js/bg-clients.js's export-folder retargeting: resolveExportFolder,
// driveFindOrCreateFolder, driveResolveClientSubfolder, and the re-parent
// logic in sheetsGetOrCreateSpreadsheet.
//
// Before this, every export (Docs and Sheets) landed in one single global
// "Marketing Plans" folder regardless of which client's page it came from —
// a Client's own attached Drive folder (driveFolderId) was stored but never
// read by the export path. This pins the real behaviour: a domain owned by
// a client with an attached folder gets its exports under that folder's own
// "SEO Inspector/Exports" or "SEO Inspector/Plans" subfolder; unregistered
// domains, clients with no folder attached, and a folder that's gone missing
// all keep exactly the prior global-fallback behaviour.
//
// The whole background is loaded into a vm (same approach as
// branded-term.test.mjs) against fake storage and a small in-memory fake
// Drive/Sheets reachable through a mocked fetch — real enough to exercise the
// actual query/create/patch calls the shipped code makes, without a network.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { backgroundSource } from './helpers.mjs';

const src = await backgroundSource();

/** A tiny fake Drive + Sheets backing store, driven entirely through fetch. */
function makeDriveMock() {
  let nextId = 1;
  const files = new Map(); // id -> { id, name, parents, trashed, mimeType }
  const newId = () => `f${nextId++}`;
  const jsonRes = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
  const notFound = () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });

  function addFolder(name, parents = [], trashed = false) {
    const id = newId();
    files.set(id, { id, name, parents, trashed, mimeType: 'application/vnd.google-apps.folder' });
    return id;
  }

  async function fetchMock(url, opts = {}) {
    const u = new URL(String(url));
    const method = (opts.method || 'GET').toUpperCase();
    const byIdMatch = /^\/drive\/v3\/files\/([^/?]+)$/.exec(u.pathname);

    if (u.hostname === 'www.googleapis.com' && u.pathname.startsWith('/upload/drive/v3/files') && method === 'POST') {
      const id = newId();
      files.set(id, { id, name: 'doc', parents: [], trashed: false, mimeType: 'application/vnd.google-apps.document' });
      return jsonRes({ id });
    }

    if (u.hostname === 'www.googleapis.com' && u.pathname === '/drive/v3/files' && method === 'GET') {
      const q = u.searchParams.get('q') || '';
      const parent = (/'([^']+)' in parents/.exec(q) || [])[1] || null;
      const name = (/name='((?:[^'\\]|\\.)*)'/.exec(q) || [])[1];
      const wantName = name ? name.replace(/\\'/g, "'") : null;
      const matches = [...files.values()].filter(f =>
        !f.trashed && f.mimeType === 'application/vnd.google-apps.folder' &&
        (parent ? (f.parents || []).includes(parent) : true) &&
        (wantName ? f.name === wantName : true)
      );
      return jsonRes({ files: matches.map(f => ({ id: f.id, name: f.name })) });
    }

    if (u.hostname === 'www.googleapis.com' && u.pathname === '/drive/v3/files' && method === 'POST') {
      const body = JSON.parse(opts.body || '{}');
      const id = newId();
      files.set(id, { id, name: body.name, parents: body.parents || [], trashed: false, mimeType: body.mimeType });
      return jsonRes({ id });
    }

    if (u.hostname === 'www.googleapis.com' && byIdMatch && method === 'GET') {
      const f = files.get(byIdMatch[1]);
      if (!f) return notFound();
      return jsonRes({ id: f.id, name: f.name, trashed: !!f.trashed, parents: f.parents || [] });
    }

    if (u.hostname === 'www.googleapis.com' && byIdMatch && method === 'PATCH') {
      const f = files.get(byIdMatch[1]);
      if (!f) return notFound();
      const addP = (u.searchParams.get('addParents') || '').split(',').filter(Boolean);
      const removeP = (u.searchParams.get('removeParents') || '').split(',').filter(Boolean);
      f.parents = (f.parents || []).filter(p => !removeP.includes(p));
      for (const p of addP) if (!f.parents.includes(p)) f.parents.push(p);
      return jsonRes({ id: f.id });
    }

    if (u.hostname === 'sheets.googleapis.com' && u.pathname === '/v4/spreadsheets' && method === 'POST') {
      const body = JSON.parse(opts.body || '{}');
      const id = newId();
      files.set(id, {
        id, name: 'sheet', parents: [], trashed: false,
        mimeType: 'application/vnd.google-apps.spreadsheet',
        tabs: (body.sheets || []).map(s => s.properties.title),
        appended: {}
      });
      return jsonRes({ spreadsheetId: id });
    }

    const ssMatch = /^\/v4\/spreadsheets\/([^/:]+)/.exec(u.pathname);
    if (u.hostname === 'sheets.googleapis.com' && ssMatch) {
      const ss = files.get(ssMatch[1]);
      if (!ss) return notFound();
      if (u.pathname.endsWith(':batchUpdate')) {
        const body = JSON.parse(opts.body || '{}');
        (body.requests || []).forEach(r => {
          if (r.addSheet) ss.tabs.push(r.addSheet.properties.title);
        });
        return jsonRes({});
      }
      // values/…:append — record which tab got rows, so tests can assert the
      // routing rather than just that the call succeeded.
      const appendMatch = /\/values\/([^:]+):append/.exec(u.pathname);
      if (appendMatch && method === 'POST') {
        const tab = decodeURIComponent(appendMatch[1]).replace(/^'|'!A1$/g, '').replace(/'$/, '');
        const body = JSON.parse(opts.body || '{}');
        ss.appended[tab] = (ss.appended[tab] || []).concat(body.values || []);
        return jsonRes({});
      }
      if (method === 'GET') return jsonRes({ sheets: ss.tabs.map(t => ({ properties: { title: t } })) });
      return jsonRes({});   // header PUT
    }

    return notFound();
  }

  return { fetchMock, files, addFolder };
}

/** Boots the real background (all bg-*.js) against fake storage and a fake fetch. */
function boot({ local = {}, sync = {}, fetchImpl } = {}) {
  const auto = () => new Proxy(function () {}, {
    get: (t, p) => (p === 'then' || typeof p === 'symbol') ? undefined : auto(),
    apply: () => auto()
  });

  const area = (backing) => ({
    get: (k) => {
      if (k == null) return Promise.resolve({ ...backing });
      const keys = Array.isArray(k) ? k : [k];
      return Promise.resolve(Object.fromEntries(keys.map(x => [x, backing[x]])));
    },
    set: (o) => { Object.assign(backing, o); return Promise.resolve(); },
    remove: (k) => { (Array.isArray(k) ? k : [k]).forEach(x => delete backing[x]); return Promise.resolve(); }
  });

  const real = {
    storage: {
      local: area(local),
      sync: area(sync),
      session: area({}),
      onChanged: { addListener() {} }
    },
    runtime: {
      onMessage: { addListener() {} },
      onInstalled: { addListener() {} },
      getURL: () => 'moz-extension://test/',
      sendMessage: () => Promise.resolve({})
    }
  };

  const ctx = {
    console, URL, URLSearchParams, Date, Math, JSON, RegExp, String, Object, Array,
    setTimeout, clearTimeout, setInterval, clearInterval,
    crypto: globalThis.crypto, TextEncoder, btoa: globalThis.btoa, atob: globalThis.atob,
    fetch: fetchImpl || (() => Promise.reject(new Error('network is not used in this suite'))),
    browser: new Proxy(real, { get: (t, p) => (p in t ? t[p] : auto()) })
  };
  vm.createContext(ctx);
  vm.runInContext(`${src}
;globalThis.__x = { resolveExportFolder, driveFindOrCreateFolder, driveResolveClientSubfolder,
                    sheetsGetOrCreateSpreadsheet, docsGetOrCreateFolder,
                    clientRegistrySave, clientRegistryAddDomain, clientRegistryGet,
                    clientRegistryFindByDomain, sheetsExportPhrases };`, ctx);

  return { ...ctx.__x, local, sync };
}

const TOKEN = 'test-access-token';
const DOCS_AUTH = { accessToken: TOKEN, refreshToken: 'r', expiresAt: Date.now() + 999999, scope: 'https://www.googleapis.com/auth/drive' };

let drive, b;
beforeEach(() => {
  drive = makeDriveMock();
  b = boot({ local: { docsAuth: { ...DOCS_AUTH } }, fetchImpl: drive.fetchMock });
});

/** Attaches a client owning `domain` to a Drive folder id. */
async function makeClientWithFolder(domain, folderId, folderName = 'Acme') {
  const { client } = await b.clientRegistrySave({ client: { name: domain } });
  await b.clientRegistryAddDomain({ id: client.id, domain });
  await b.clientRegistrySave({ client: { id: client.id, driveFolderId: folderId, driveFolderName: folderName } });
  return client.id;
}

describe('resolveExportFolder — no client involved', () => {
  test('an unregistered domain uses the global Marketing Plans folder', async () => {
    const { folderId, clientId } = await b.resolveExportFolder(TOKEN, 'https://unbound.com/page', 'Exports');
    assert.equal(clientId, null);
    const f = drive.files.get(folderId);
    assert.equal(f.name, 'Marketing Plans');
  });

  test('a client with no driveFolderId attached also falls back to the global folder', async () => {
    const { client } = await b.clientRegistrySave({ client: { name: 'Acme' } });
    await b.clientRegistryAddDomain({ id: client.id, domain: 'acme.com' });

    const { folderId } = await b.resolveExportFolder(TOKEN, 'https://acme.com/page', 'Exports');
    assert.equal(drive.files.get(folderId).name, 'Marketing Plans');
  });

  test('a client whose driveFolderId no longer exists falls back to the global folder', async () => {
    await makeClientWithFolder('acme.com', 'ghost-folder-id');
    const { folderId, clientId } = await b.resolveExportFolder(TOKEN, 'https://acme.com/page', 'Exports');
    assert.equal(clientId, null, 'should not report a client win when its folder was unreachable');
    assert.equal(drive.files.get(folderId).name, 'Marketing Plans');
  });

  test('a trashed client folder falls back to the global folder', async () => {
    const trashedId = drive.addFolder('Acme (trashed)', [], true);
    await makeClientWithFolder('acme.com', trashedId);
    const { folderId } = await b.resolveExportFolder(TOKEN, 'https://acme.com/page', 'Exports');
    assert.equal(drive.files.get(folderId).name, 'Marketing Plans');
  });
});

describe('resolveExportFolder — a client with a folder attached', () => {
  test('lands under SEO Inspector/Exports inside the client\'s own folder', async () => {
    const rootId = drive.addFolder('Acme');
    await makeClientWithFolder('acme.com', rootId);

    const { folderId, clientId } = await b.resolveExportFolder(TOKEN, 'https://acme.com/page', 'Exports');
    const exportsFolder = drive.files.get(folderId);
    assert.equal(exportsFolder.name, 'Exports');
    const appFolder = drive.files.get(exportsFolder.parents[0]);
    assert.equal(appFolder.name, 'SEO Inspector');
    assert.deepEqual(appFolder.parents, [rootId]);
    assert.notEqual(clientId, null);
  });

  test('Exports and Plans share the same SEO Inspector folder, not two of them', async () => {
    const rootId = drive.addFolder('Acme');
    await makeClientWithFolder('acme.com', rootId);

    const exp = await b.resolveExportFolder(TOKEN, 'https://acme.com/page', 'Exports');
    const plans = await b.resolveExportFolder(TOKEN, 'https://acme.com/page', 'Plans');

    assert.notEqual(exp.folderId, plans.folderId);
    const expParent = drive.files.get(exp.folderId).parents[0];
    const plansParent = drive.files.get(plans.folderId).parents[0];
    assert.equal(expParent, plansParent, 'Exports and Plans should sit under one shared SEO Inspector folder');

    const seoInspectorFolders = [...drive.files.values()]
      .filter(f => f.name === 'SEO Inspector' && f.parents.includes(rootId));
    assert.equal(seoInspectorFolders.length, 1, 'a second SEO Inspector folder was created');
  });

  test('resolving twice is dedupe-safe — no duplicate subfolder on repeat calls', async () => {
    const rootId = drive.addFolder('Acme');
    await makeClientWithFolder('acme.com', rootId);

    const first = await b.resolveExportFolder(TOKEN, 'https://acme.com/page', 'Exports');
    const second = await b.resolveExportFolder(TOKEN, 'https://acme.com/page', 'Exports');
    assert.equal(first.folderId, second.folderId);

    const exportsFolders = [...drive.files.values()].filter(f => f.name === 'Exports');
    assert.equal(exportsFolders.length, 1);
  });

  test('re-picking the client folder invalidates the cached subfolder id', async () => {
    const oldRoot = drive.addFolder('Acme (old)');
    const id = await makeClientWithFolder('acme.com', oldRoot);
    const first = await b.resolveExportFolder(TOKEN, 'https://acme.com/page', 'Exports');

    const newRoot = drive.addFolder('Acme (new)');
    await b.clientRegistrySave({ client: { id, driveFolderId: newRoot, driveFolderName: 'Acme (new)' } });
    const second = await b.resolveExportFolder(TOKEN, 'https://acme.com/page', 'Exports');

    assert.notEqual(first.folderId, second.folderId, 'stale cache from the old root folder was reused');
    assert.equal(drive.files.get(second.folderId).parents[0] && drive.files.get(drive.files.get(second.folderId).parents[0]).parents[0], newRoot);
  });
});

describe('driveFindOrCreateFolder', () => {
  test('creates once, reuses on every later call', async () => {
    const rootId = drive.addFolder('Root');
    const first = await b.driveFindOrCreateFolder(TOKEN, rootId, 'SEO Inspector');
    const second = await b.driveFindOrCreateFolder(TOKEN, rootId, 'SEO Inspector');
    assert.equal(first, second);
    assert.equal([...drive.files.values()].filter(f => f.name === 'SEO Inspector' && f.parents.includes(rootId)).length, 1);
  });

  test('a folder with the same name under a DIFFERENT parent is not reused', async () => {
    const rootA = drive.addFolder('A');
    const rootB = drive.addFolder('B');
    const inA = await b.driveFindOrCreateFolder(TOKEN, rootA, 'SEO Inspector');
    const inB = await b.driveFindOrCreateFolder(TOKEN, rootB, 'SEO Inspector');
    assert.notEqual(inA, inB);
  });
});

describe('sheetsGetOrCreateSpreadsheet — re-parent, don\'t duplicate', () => {
  test('a sheet created before a client folder existed gets moved into it, not duplicated', async () => {
    // First export with no client attached — lands in the global folder.
    const first = await b.sheetsGetOrCreateSpreadsheet(TOKEN, 'gsc-queries::acme.com', {
      title: 'Search Inspector Queries — acme.com', tabName: 'Search Queries', headerRow: ['a'],
      pageUrl: 'https://acme.com/page'
    });
    const globalFolderId = drive.files.get(first.id).parents[0];
    assert.equal(drive.files.get(globalFolderId).name, 'Marketing Plans');

    // Now the client attaches a Drive folder.
    const rootId = drive.addFolder('Acme');
    await makeClientWithFolder('acme.com', rootId);

    const second = await b.sheetsGetOrCreateSpreadsheet(TOKEN, 'gsc-queries::acme.com', {
      title: 'Search Inspector Queries — acme.com', tabName: 'Search Queries', headerRow: ['a'],
      pageUrl: 'https://acme.com/page'
    });

    assert.equal(second.id, first.id, 'a second spreadsheet was created instead of moving the existing one');
    const movedParent = drive.files.get(second.id).parents[0];
    assert.equal(drive.files.get(movedParent).name, 'Exports');
    assert.equal(drive.files.get(movedParent).parents[0] && drive.files.get(drive.files.get(movedParent).parents[0]).parents[0], rootId);

    const allSpreadsheets = [...drive.files.values()].filter(f => f.mimeType === 'application/vnd.google-apps.spreadsheet');
    assert.equal(allSpreadsheets.length, 1, 'a duplicate spreadsheet was created');
  });

  test('an unregistered domain\'s sheet stays put across repeat exports (no spurious re-parent)', async () => {
    const first = await b.sheetsGetOrCreateSpreadsheet(TOKEN, 'gsc-queries::unbound.com', {
      title: 'Search Inspector Queries — unbound.com', tabName: 'Search Queries', headerRow: ['a'],
      pageUrl: 'https://unbound.com/page'
    });
    const second = await b.sheetsGetOrCreateSpreadsheet(TOKEN, 'gsc-queries::unbound.com', {
      title: 'Search Inspector Queries — unbound.com', tabName: 'Search Queries', headerRow: ['a'],
      pageUrl: 'https://unbound.com/page'
    });
    assert.equal(first.id, second.id);
    assert.deepEqual(drive.files.get(first.id).parents, drive.files.get(second.id).parents);
  });
});

// The popup's "attach a Drive folder?" prompt (popup-shared.js's
// maybeOfferExportFolder) reads clientRegistryFindByDomain before an export,
// and persists a "not now" via clientRegistrySave's driveFolderPromptDismissed
// field so it doesn't nag on every subsequent export. Both pinned here since
// neither has any other test coverage.
// The phrases export is the only multi-tab writer in the app: each n-gram
// size gets its own tab rather than sharing one sheet behind a "Words"
// column. That means it has to create four tabs up front AND heal a
// spreadsheet cached from before those tabs existed.
describe('sheetsExportPhrases — one tab per n-gram size', () => {
  const sheetOf = () => [...drive.files.values()].find(f => f.mimeType === 'application/vnd.google-apps.spreadsheet');

  test('creates all four tabs even when exporting a single table', async () => {
    // A later single-table export must never have to create a tab mid-flight.
    await b.sheetsExportPhrases({ pageUrl: 'https://acme.com/p', tables: [{ size: 2, rows: [['best telescope', 4]] }] });
    assert.deepEqual(sheetOf().tabs, ['One Word', 'Two Words', 'Three Words', 'Four Words']);
  });

  test('routes each table to its own tab', async () => {
    await b.sheetsExportPhrases({
      pageUrl: 'https://acme.com/p',
      tables: [
        { size: 1, rows: [['telescope', 9]] },
        { size: 4, rows: [['best telescope for beginners', 5]] }
      ]
    });
    const ss = sheetOf();
    assert.deepEqual(Object.keys(ss.appended).sort(), ['Four Words', 'One Word']);
    assert.match(ss.appended['One Word'][0].join(' '), /telescope/);
  });

  test('does not touch the tabs it was not given rows for', async () => {
    await b.sheetsExportPhrases({ pageUrl: 'https://acme.com/p', tables: [{ size: 3, rows: [['a b c', 2]] }] });
    const ss = sheetOf();
    assert.deepEqual(Object.keys(ss.appended), ['Three Words'], 'an empty tab received a bare date/URL row');
  });

  test('every row is stamped with the export date and page URL', async () => {
    await b.sheetsExportPhrases({ pageUrl: 'https://acme.com/p', tables: [{ size: 1, rows: [['telescope', 9]] }] });
    const row = sheetOf().appended['One Word'][0];
    assert.match(String(row[0]), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(row[1], 'https://acme.com/p');
    assert.equal(row[2], 'telescope');
  });

  test('adds the missing tabs to a spreadsheet that predates them', async () => {
    // Simulates the real upgrade path: a sheet cached by an earlier build
    // that only ever created one tab.
    await b.sheetsExportPhrases({ pageUrl: 'https://acme.com/p', tables: [{ size: 1, rows: [['telescope', 9]] }] });
    const ss = sheetOf();
    ss.tabs = ['One Word'];                       // strip the other three back off

    await b.sheetsExportPhrases({ pageUrl: 'https://acme.com/p', tables: [{ size: 4, rows: [['a b c d', 2]] }] });
    assert.ok(ss.tabs.includes('Four Words'), 'the missing tab was never added');
    assert.ok(ss.appended['Four Words'], 'rows never landed in the healed tab');
  });

  test('an export with no rows anywhere is rejected rather than creating an empty sheet', async () => {
    const res = await b.sheetsExportPhrases({ pageUrl: 'https://acme.com/p', tables: [{ size: 1, rows: [] }] });
    assert.equal(res.error, 'NO_ROWS');
  });
});

describe('clientRegistryFindByDomain — backs the export-folder prompt', () => {
  test('returns the owning client for a bound domain', async () => {
    const { client } = await b.clientRegistrySave({ client: { name: 'Acme' } });
    await b.clientRegistryAddDomain({ id: client.id, domain: 'acme.com' });

    const res = await b.clientRegistryFindByDomain({ domain: 'acme.com' });
    assert.equal(res.client.id, client.id);
  });

  test('returns null for a domain with no client — never invents one', async () => {
    const res = await b.clientRegistryFindByDomain({ domain: 'unbound.com' });
    assert.equal(res.client, null);
  });
});

describe('driveFolderPromptDismissed — "not now" persistence', () => {
  test('clientRegistrySave persists a decline', async () => {
    const { client } = await b.clientRegistrySave({ client: { name: 'Acme' } });
    await b.clientRegistrySave({ client: { id: client.id, driveFolderPromptDismissed: true } });

    const { client: reloaded } = await b.clientRegistryGet({ id: client.id });
    assert.equal(reloaded.driveFolderPromptDismissed, true);
  });

  test('attaching a real Drive folder clears a prior decline', async () => {
    const { client } = await b.clientRegistrySave({ client: { name: 'Acme' } });
    await b.clientRegistrySave({ client: { id: client.id, driveFolderPromptDismissed: true } });

    const rootId = drive.addFolder('Acme');
    await b.clientRegistrySave({ client: { id: client.id, driveFolderId: rootId, driveFolderName: 'Acme' } });

    const { client: reloaded } = await b.clientRegistryGet({ id: client.id });
    assert.equal(reloaded.driveFolderPromptDismissed, false, 'attaching a folder should clear the dismissal — there is nothing left to decline');
  });

  test('unlinking a folder does not itself resurrect a prior decline', async () => {
    const rootId = drive.addFolder('Acme');
    const { client } = await b.clientRegistrySave({ client: { name: 'Acme' } });
    await b.clientRegistrySave({ client: { id: client.id, driveFolderId: rootId, driveFolderName: 'Acme' } });
    await b.clientRegistrySave({ client: { id: client.id, driveFolderPromptDismissed: true } });

    await b.clientRegistrySave({ client: { id: client.id, driveFolderId: null, driveFolderName: null } });

    const { client: reloaded } = await b.clientRegistryGet({ id: client.id });
    assert.equal(reloaded.driveFolderPromptDismissed, true);
  });
});
