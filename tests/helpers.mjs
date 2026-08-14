import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DIST = path.join(ROOT, 'dist');

export const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));

/** The extension's single source of truth for its version. */
export const baseVersion = async () =>
  (await readJson(path.join(ROOT, 'manifest.base.json'))).version;

/** `<script src="...">` values from popup.html, in load order. */
export async function popupScripts() {
  const html = await readFile(path.join(ROOT, 'popup.html'), 'utf8');
  return [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1]);
}

/**
 * The whole background, concatenated in load order.
 *
 * The background ships as several files sharing one global scope, so a test
 * that wants to run it has to reassemble it the way the browser does. The file
 * list comes from scripts/build.mjs — the same array that generates Chrome's
 * importScripts call — so a test can never silently run a stale subset after
 * a file is added or renamed.
 */
export async function backgroundSource() {
  const { BACKGROUND_FILES } = await import('../scripts/build.mjs');
  const parts = await Promise.all(
    BACKGROUND_FILES.map(f => readFile(path.join(ROOT, f), 'utf8'))
  );
  return parts.join('\n');
}
