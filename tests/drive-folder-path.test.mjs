// The Client panel shows a Drive folder's two nearest ancestors, so
// "Clients › Acme › SEO" replaces a bare "SEO" — the point at which a folder
// name stops being ambiguous, since most agencies have several called
// "Assets" or "2026".
//
// The path is captured from the folder browser at pick time, where it costs
// nothing, and resolved from Drive only for folders attached before this
// existed — then saved, so that backfill happens once.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

const clients = await readFile(path.join(ROOT, 'popup-clients.js'), 'utf8');
const bg      = await readFile(path.join(ROOT, 'bg-clients.js'), 'utf8');

const ancestorsOf = new Function('cfg', `
  const _driveBrowserPath = cfg.path;
  const _driveBrowserRoot = cfg.root;
  ${clients.slice(clients.indexOf('function driveBrowserAncestors('), clients.indexOf('// ─── Per-domain binding pickers'))}
  return driveBrowserAncestors(cfg.excludeCurrent);
`);

const P = (...names) => names.map((name, i) => ({ id: `f${i}`, name }));

describe('the path captured from the browser', () => {
  test('picking from inside a folder drops it off its own path', () => {
    const a = ancestorsOf({ path: P('Clients', 'Acme', 'SEO'), root: 'mydrive', excludeCurrent: true });
    assert.deepEqual(a, ['My Drive', 'Clients', 'Acme']);
  });

  test('picking a row without descending keeps the whole location', () => {
    const a = ancestorsOf({ path: P('Clients', 'Acme'), root: 'mydrive', excludeCurrent: false });
    assert.deepEqual(a, ['My Drive', 'Clients', 'Acme']);
  });

  test('My Drive is included, so a top-level folder still says something', () => {
    // A bare "Acme" tells a reader less than "My Drive › Acme".
    assert.deepEqual(ancestorsOf({ path: P('Acme'), root: 'mydrive', excludeCurrent: true }), ['My Drive']);
  });

  test('a Shared Drive heads its own path and is not prefixed', () => {
    const a = ancestorsOf({ path: P('Agency Drive', 'Clients', 'Acme'), root: 'teamdrives', excludeCurrent: true });
    assert.deepEqual(a, ['Agency Drive', 'Clients']);
  });

  test('"Shared with me" is not prefixed — nothing lives in it', () => {
    const a = ancestorsOf({ path: P('Acme', 'SEO'), root: 'shared', excludeCurrent: true });
    assert.deepEqual(a, ['Acme']);
  });

  test('only the nearest two are stored', () => {
    assert.match(clients, /driveFolderPath: ancestors\.slice\(-2\)/);
  });
});

describe('resolving a path from Drive', () => {
  const fn = bg.slice(bg.indexOf('async function driveAncestors('), bg.indexOf('// `withPath` is opt-in'));

  test('walks up exactly two levels', () => {
    assert.match(bg, /const DRIVE_PATH_DEPTH = 2;/);
    assert.match(fn, /i < DRIVE_PATH_DEPTH && id/);
  });

  test('returns outermost first, so it renders left to right', () => {
    assert.match(fn, /out\.unshift\(meta\.name\)/);
  });

  test('a parent that will not resolve ends the walk instead of failing', () => {
    // A folder in someone else's Drive, or a Shared Drive root, can
    // legitimately refuse — a partial path beats none.
    assert.match(fn, /if \(!res \|\| !res\.ok\) break;/);
    assert.match(fn, /if \(!meta \|\| !meta\.name\) break;/);
  });

  test('it supports shared drives', () => {
    assert.match(fn, /supportsAllDrives=true/);
  });

  test('resolving is opt-in, since each level is a request', () => {
    assert.match(bg, /async function driveVerifyFolder\(\{ folderId, withPath = false \}\)/);
    assert.match(bg, /if \(withPath\) out\.path = await driveAncestors\(/);
  });
});

describe('the panel', () => {
  test('only asks Drive when it has no stored path', () => {
    assert.match(clients, /const needPath = !\(client\.driveFolderPath && client\.driveFolderPath\.length\)/);
    assert.match(clients, /action: 'driveVerifyFolder', folderId: client\.driveFolderId, withPath: needPath/);
  });

  test('a backfilled path is saved, so the walk happens once', () => {
    assert.match(clients, /if \(needPath && verify && verify\.path && verify\.path\.length\) \{\s*saveClientField\(\{ driveFolderPath: verify\.path \}\)/);
  });

  test('the stored path wins over a freshly resolved one', () => {
    assert.match(clients, /\(client\.driveFolderPath && client\.driveFolderPath\.length\)\s*\?\s*client\.driveFolderPath/);
  });

  test('ancestors are muted and the folder itself is not', () => {
    assert.match(clients, /crumb\.className = 'client-drive-crumb'/);
    assert.match(clients, /name\.appendChild\(document\.createTextNode\(folderName\)\)/);
  });

  test('the full path is also the row title, for a narrow panel', () => {
    assert.match(clients, /name\.title = \[\.\.\.ancestors, folderName\]\.join/);
  });

  test('unlinking clears the path too', () => {
    // Left behind, it would show up above the next folder picked.
    assert.match(clients, /driveFolderId: null, driveFolderName: null, driveFolderPath: \[\]/);
  });

  test('the path is capped when persisted, whatever the caller sends', () => {
    assert.match(bg, /Array\.isArray\(client\.driveFolderPath\) \? client\.driveFolderPath\.slice\(0, 2\) : \[\]/);
  });
});
