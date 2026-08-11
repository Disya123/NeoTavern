#!/usr/bin/env node
/**
 * Post-release verification for `desktop:release`. Local release runs
 * previously shipped unverified output (CI smokes separately); this closes
 * that gap per platform:
 * - macOS/Linux: the full headless bundle lifecycle smoke;
 * - Windows: artifact verification (installer + updater signature present),
 *   since NSIS installers cannot be exercised headlessly here.
 */
import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scriptsDir = dirname(fileURLToPath(import.meta.url));
const bundleRoot = resolve(root, 'apps/desktop/src-tauri/target/release/bundle');

if (process.platform === 'darwin' || process.platform === 'linux') {
  const bundleSmoke = resolve(scriptsDir, 'smoke-desktop-bundle.mjs');
  if (process.platform === 'linux') {
    // Headless CI/boxes have no DISPLAY; the Tauri app panics in gtk::init
    // without one. The workflow wraps the bundle smoke in xvfb-run; the
    // release chain must do the same or desktop:release fails locally.
    execFileSync('xvfb-run', ['-a', process.execPath, bundleSmoke], {
      cwd: root,
      stdio: 'inherit',
    });
  } else {
    execFileSync(process.execPath, [bundleSmoke], {
      cwd: root,
      stdio: 'inherit',
    });
  }
} else if (process.platform === 'win32') {
  const nsisDir = resolve(bundleRoot, 'nsis');
  const entries = await readdir(nsisDir).catch(() => []);
  const installers = entries.filter((name) => name.endsWith('.exe'));
  const signatures = entries.filter((name) => name.endsWith('.sig'));
  if (installers.length === 0) {
    throw new Error(`No NSIS installer found under ${nsisDir}`);
  }
  if (signatures.length === 0) {
    throw new Error('Updater signature (.sig) missing — release artifacts are not signed');
  }
  console.log(
    `[desktop] release artifacts verified: ${installers.join(', ')} + ${signatures.length} signature(s)`,
  );
} else {
  throw new Error(`Unsupported release smoke platform: ${process.platform}`);
}
