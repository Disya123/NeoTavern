#!/usr/bin/env node
/**
 * Desktop WebView E2E: drives the packaged Tauri shell through the real WebView2
 * (Playwright over CDP), not a browser tab and not a headless kernel.
 *
 * The shell is copied to a throwaway directory first — the same rule the shell
 * smoke follows — and `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` opens a loopback
 * DevTools endpoint the test process connects to. Nothing is deleted inside the
 * artifact, and the copy is removed on exit.
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { cp, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('Desktop WebView E2E currently targets Windows');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const portableBase = resolve(root, 'apps/desktop/src-tauri/target/release/bundle/portable');
const entries = await readdir(portableBase, { withFileTypes: true }).catch(() => {
  throw new Error(`No portable bundle under ${portableBase}. Run "pnpm desktop:portable" first.`);
});
const candidates = entries.filter(
  (entry) => entry.isDirectory() && entry.name.endsWith('-portable'),
);
if (candidates.length !== 1)
  throw new Error(`Expected one portable directory, found ${candidates.length}`);

const stagingBase = await mkdtemp(resolve(tmpdir(), 'neotavern-desktop-e2e-'));
const appDir = resolve(stagingBase, 'app');
await cp(resolve(portableBase, candidates[0].name), appDir, { recursive: true });
rmSync(resolve(appDir, 'data'), { recursive: true, force: true });
const cleanup = () => {
  // The WebView2 helper processes keep handles open for a moment after the shell
  // exits; a failed delete must never fail the run.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(stagingBase, { recursive: true, force: true });
      return;
    } catch {
      // retry
    }
  }
};
process.on('exit', cleanup);

const port = Number(process.env['DESKTOP_E2E_PORT'] ?? '9444');
const exe = resolve(appDir, 'NeoTavern.exe');
const child = spawn(exe, [], {
  cwd: appDir,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  },
});
let logs = '';
child.stdout.on('data', (chunk) => (logs += chunk));
child.stderr.on('data', (chunk) => (logs += chunk));

const endpoint = `http://127.0.0.1:${port}`;
const deadline = Date.now() + 90_000;
let ready = false;
while (Date.now() < deadline) {
  try {
    const response = await fetch(`${endpoint}/json/version`);
    if (response.ok) {
      ready = true;
      break;
    }
  } catch {
    // not listening yet
  }
  if (child.exitCode !== null) break;
  await new Promise((done) => setTimeout(done, 500));
}
if (!ready) {
  child.kill();
  throw new Error(`WebView2 never opened the DevTools endpoint\n${logs}`);
}

const playwright = spawn(
  process.execPath,
  [
    resolve(root, 'node_modules/@playwright/test/cli.js'),
    'test',
    '-c',
    'playwright.desktop.config.ts',
    ...process.argv.slice(2),
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, DESKTOP_CDP_URL: endpoint },
  },
);
const code = await new Promise((done) => playwright.once('exit', (value) => done(value ?? 1)));
const exited = new Promise((done) => child.once('exit', done));
child.kill();
await Promise.race([exited, new Promise((done) => setTimeout(done, 10_000))]);
process.exit(code);
