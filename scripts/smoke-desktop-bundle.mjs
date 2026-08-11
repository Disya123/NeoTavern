#!/usr/bin/env node
/** Headless lifecycle smoke for native macOS and Linux desktop bundles. */
import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
  throw new Error('Use desktop:shell-smoke for the Windows portable bundle');
}
if (process.platform !== 'darwin' && process.platform !== 'linux') {
  throw new Error(`Unsupported desktop bundle smoke platform: ${process.platform}`);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundleRoot = resolve(root, 'apps/desktop/src-tauri/target/release/bundle');
const smokeRoot = resolve(root, '.tmp-desktop-bundle-smoke');
if (dirname(smokeRoot) !== root) throw new Error('Unsafe desktop bundle smoke directory');
await rm(smokeRoot, { recursive: true, force: true });
await mkdir(smokeRoot, { recursive: true });

const beforeSidecars = runningSidecars();
const launch = await resolveBundleLaunch();
const output = [];
const errors = [];
const child = spawn(launch.executable, [], {
  cwd: launch.cwd,
  env: {
    ...process.env,
    ...launch.env,
    HOME: smokeRoot,
    XDG_DATA_HOME: resolve(smokeRoot, 'xdg-data'),
    NEOTA_DESKTOP_SMOKE: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => output.push(chunk));
child.stderr.on('data', (chunk) => errors.push(chunk));

const exitCode = await new Promise((resolvePromise, reject) => {
  const timer = setTimeout(() => {
    reject(new Error(`Desktop bundle smoke timed out\n${output.join('')}\n${errors.join('')}`));
  }, 120_000);
  child.once('exit', (code) => {
    clearTimeout(timer);
    resolvePromise(code);
  });
  child.once('error', (error) => {
    clearTimeout(timer);
    reject(new Error(`Desktop bundle could not be started: ${error.message}`, { cause: error }));
  });
}).catch((error) => {
  child.kill('SIGKILL');
  throw error;
});
if (exitCode !== 0) {
  throw new Error(`Desktop bundle exited with ${exitCode}\n${output.join('')}\n${errors.join('')}`);
}

await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
const leakedSidecars = [...runningSidecars()].filter((processId) => !beforeSidecars.has(processId));
if (leakedSidecars.length > 0) {
  throw new Error(`Desktop bundle left sidecar processes running: ${leakedSidecars.join(', ')}`);
}
const files = await readdir(smokeRoot, { recursive: true });
const database = files.find((entry) => entry.replaceAll('\\', '/').endsWith('/app.db'));
if (!database || (await stat(resolve(smokeRoot, database))).size <= 0) {
  throw new Error(
    `Desktop bundle did not create its app-local SQLite database\n--- app stdout (tail) ---\n` +
      `${output.join('').slice(-4000)}\n--- app stderr (tail) ---\n${errors.join('').slice(-4000)}`,
  );
}
await rm(smokeRoot, { recursive: true, force: true });
console.log(`[desktop:bundle-smoke] OK — ${process.platform} lifecycle and sidecar cleanup`);

async function resolveBundleLaunch() {
  if (process.platform === 'darwin') {
    const directory = resolve(bundleRoot, 'macos');
    const applications = (await readdir(directory)).filter((entry) => entry.endsWith('.app'));
    if (applications.length !== 1) {
      throw new Error(`Expected one macOS application bundle, found ${applications.length}`);
    }
    const application = resolve(directory, applications[0]);
    return {
      executable: resolve(application, 'Contents/MacOS/neotavern'),
      cwd: resolve(application, 'Contents/MacOS'),
      env: {},
    };
  }

  const directory = resolve(bundleRoot, 'appimage');
  const images = (await readdir(directory)).filter((entry) => entry.endsWith('.AppImage'));
  if (images.length !== 1) {
    throw new Error(`Expected one Linux AppImage, found ${images.length}`);
  }
  const executable = resolve(directory, images[0]);
  await chmod(executable, 0o755);
  return { executable, cwd: directory, env: { APPIMAGE_EXTRACT_AND_RUN: '1' } };
}

function runningSidecars() {
  const output = execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' });
  const processIds = new Set();
  for (const line of output.split('\n')) {
    if (!line.includes('neotavern-server')) continue;
    const processId = Number.parseInt(line.trimStart().split(/\s+/, 1)[0] ?? '', 10);
    if (Number.isSafeInteger(processId)) processIds.add(processId);
  }
  return processIds;
}
