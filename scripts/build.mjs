#!/usr/bin/env node
// Builds a loadable extension directory per browser.
//
// The repo root holds the shared source plus three manifest fragments:
//   manifest.base.json     — keys identical across browsers
//   manifest.firefox.json  — sidebar_action, background.scripts, gecko settings
//   manifest.chrome.json   — side_panel, background.service_worker
//
// `node scripts/build.mjs` merges base + <browser> into dist/<browser>/manifest.json
// and copies the shipped file set alongside it. Shipped files come from an explicit
// allowlist (not an ignore list) so a new local-only directory can never leak into
// a build — the old `web-ext --ignore-files` approach packaged anything it hadn't
// been told to exclude.

import { readFile, writeFile, mkdir, rm, cp, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

export const BROWSERS = ['firefox', 'chrome'];

// Keys that must be REPLACED wholesale by the per-browser fragment rather than
// deep-merged. `background` is the one that matters: merging Firefox's
// { scripts } with Chrome's { service_worker } would emit both and break both.
const REPLACE_KEYS = new Set(['background']);

function mergeManifest(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const prev = base[key];
    if (REPLACE_KEYS.has(key)) {
      out[key] = value;
    } else if (Array.isArray(value)) {
      // Permissions and host_permissions are sets — concat and dedupe so a
      // fragment adds to the shared list instead of clobbering it.
      out[key] = [...new Set([...(Array.isArray(prev) ? prev : []), ...value])];
    } else if (value && typeof value === 'object' && prev && typeof prev === 'object' && !Array.isArray(prev)) {
      out[key] = mergeManifest(prev, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export async function buildManifest(browser) {
  const base = JSON.parse(await readFile(path.join(ROOT, 'manifest.base.json'), 'utf8'));
  const override = JSON.parse(await readFile(path.join(ROOT, `manifest.${browser}.json`), 'utf8'));
  return mergeManifest(base, override);
}

// Every file that ships inside the packaged extension. Root-level *.js is the
// whole extension source (build tooling lives in scripts/, tests in tests/),
// so globbing it is complete without being a catch-all over the repo.
export async function shippedFiles() {
  const rootJs = (await readdir(ROOT))
    .filter(f => f.endsWith('.js'))
    .sort();
  return [...rootJs, 'popup.html', 'popup.css', 'icons'];
}

async function build(browser) {
  const outDir = path.join(DIST, browser);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const manifest = await buildManifest(browser);
  await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  for (const entry of await shippedFiles()) {
    const src = path.join(ROOT, entry);
    if (!existsSync(src)) throw new Error(`${browser}: shipped file missing from repo — ${entry}`);
    await cp(src, path.join(outDir, entry), { recursive: true });
  }

  return { browser, outDir, version: manifest.version };
}

// Only run when invoked directly, so the tests can import the helpers above.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv.find(a => a.startsWith('--browser='));
  const targets = arg ? [arg.split('=')[1]] : BROWSERS;

  for (const browser of targets) {
    if (!BROWSERS.includes(browser)) {
      console.error(`Unknown browser "${browser}" — expected one of: ${BROWSERS.join(', ')}`);
      process.exit(1);
    }
    const { outDir, version } = await build(browser);
    console.log(`built ${browser} v${version} → ${path.relative(ROOT, outDir)}/`);
  }
}
