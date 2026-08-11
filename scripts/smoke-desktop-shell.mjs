#!/usr/bin/env node
/** Headless lifecycle smoke for the assembled portable Tauri shell. */
import { spawn } from 'node:child_process';
import { stat, readdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('Desktop shell smoke currently targets Windows');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const portableBase = resolve(root, 'apps/desktop/src-tauri/target/release/bundle/portable');
let entries;
try {
  entries = await readdir(portableBase, { withFileTypes: true });
} catch {
  throw new Error(
    `No portable bundle found under ${portableBase}. Run "pnpm desktop:portable" first ` +
      '(it builds the Tauri bundle and packages the portable archive).',
  );
}
const candidates = entries.filter(
  (entry) => entry.isDirectory() && entry.name.endsWith('-portable'),
);
if (candidates.length !== 1) {
  throw new Error(`Expected one portable directory, found ${candidates.length}`);
}
const portableRoot = resolve(portableBase, candidates[0].name);
const dataDir = resolve(portableRoot, 'data');
if (dirname(dataDir) !== portableRoot) throw new Error('Unsafe portable smoke data directory');
await rm(dataDir, { recursive: true, force: true });

/** Resolve with the exit code; rejects on spawn failure or timeout. */
function waitForExit(child, timeoutMs, label, output, errors) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `${label} did not exit within ${timeoutMs / 1000}s of readiness\n${output.join('')}\n${errors.join('')}`,
        ),
      );
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolvePromise(code);
    });
    // spawn emits 'error' (ENOENT/EACCES) instead of rejecting — without this
    // handler the failure bypasses the timeout and diagnostics entirely.
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`${label} could not be started: ${error.message}`, { cause: error }));
    });
  });
}

const output = [];
const errors = [];
const child = spawn(resolve(portableRoot, 'NeoTavern.exe'), [], {
  cwd: portableRoot,
  windowsHide: true,
  env: { ...process.env, NEOTA_DESKTOP_SMOKE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => output.push(chunk));
child.stderr.on('data', (chunk) => errors.push(chunk));

const exitCode = await waitForExit(child, 20_000, 'Portable Tauri shell', output, errors).catch(
  (error) => {
    child.kill();
    throw error;
  },
);

if (exitCode !== 0) {
  throw new Error(
    `Portable Tauri shell exited with ${exitCode}\n${output.join('')}\n${errors.join('')}`,
  );
}
const database = await stat(resolve(dataDir, 'app.db'));
if (database.size <= 0) throw new Error('Portable shell did not create its local database');
await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
const sidecarProbe = spawn('tasklist', ['/FI', 'IMAGENAME eq neotavern-server.exe', '/FO', 'CSV'], {
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'ignore'],
});
let taskList = '';
sidecarProbe.stdout.setEncoding('utf8');
sidecarProbe.stdout.on('data', (chunk) => {
  taskList += chunk;
});
const probeCode = await new Promise((resolvePromise, reject) => {
  sidecarProbe.once('exit', resolvePromise);
  sidecarProbe.once('error', (error) =>
    reject(new Error(`tasklist probe could not be started: ${error.message}`, { cause: error })),
  );
});
if (probeCode !== 0 || taskList.toLowerCase().includes('"neotavern-server.exe"')) {
  throw new Error('Portable Tauri shell left a backend sidecar process running');
}
await rm(dataDir, { recursive: true, force: true });
console.log('[desktop:shell-smoke] OK — portable data path, readiness and sidecar cleanup');
