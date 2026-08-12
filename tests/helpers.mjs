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
