#!/usr/bin/env node
/** Assemble a no-install Windows portable ZIP from a completed Tauri build. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  throw new Error('The Windows portable package must be assembled on Windows');
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tauriRoot = resolve(root, 'apps/desktop/src-tauri');
const release = resolve(tauriRoot, 'target/release');
const portableBase = resolve(release, 'bundle/portable');
const tauriConfig = JSON.parse(await readFile(resolve(tauriRoot, 'tauri.conf.json'), 'utf8'));
const version = String(tauriConfig.version ?? '');
if (version.length === 0 || version === 'undefined') {
  throw new Error('tauri.conf.json has no "version" — refusing to build an unnamed artifact');
}
const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
const folderName = `NeoTavern_${version}_${architecture}-portable`;
const portableRoot = resolve(portableBase, folderName);
const archive = resolve(portableBase, `${folderName}.zip`);
const checksum = `${archive}.sha256`;

if (dirname(portableRoot) !== portableBase) throw new Error('Unsafe portable output directory');

let sidecars;
try {
  sidecars = (await readdir(resolve(tauriRoot, 'binaries'))).filter(
    (name) => name.startsWith('neotavern-server-') && name.endsWith('.exe'),
  );
} catch {
  throw new Error(
    'No sidecar binaries found — run "pnpm desktop:prepare" before packaging the portable build.',
  );
}
if (sidecars.length !== 1) {
  throw new Error(`Expected one prepared Windows sidecar, found ${sidecars.length}`);
}

const mainExecutable = resolve(release, 'neotavern.exe');
const requiredArtifacts = [
  [mainExecutable, 'run "pnpm desktop:build" (Tauri release build) first'],
  [resolve(tauriRoot, 'resources/web/index.html'), 'run "pnpm desktop:prepare" first'],
  [
    resolve(tauriRoot, 'resources/native/node_modules/better-sqlite3/lib/index.js'),
    'run "pnpm desktop:prepare" first',
  ],
  [
    resolve(tauriRoot, 'resources/native/node_modules/sharp/lib/index.js'),
    'run "pnpm desktop:prepare" first',
  ],
  [resolve(tauriRoot, 'resources/runtime/node.exe'), 'run "pnpm desktop:prepare" first'],
  [resolve(tauriRoot, 'resources/runtime/plugin-worker.mjs'), 'run "pnpm desktop:prepare" first'],
  [resolve(tauriRoot, 'resources/runtime/plugin-loader.mjs'), 'run "pnpm desktop:prepare" first'],
];
for (const [artifact, hint] of requiredArtifacts) {
  try {
    await stat(artifact);
  } catch {
    throw new Error(`Missing ${artifact} — ${hint}.`);
  }
}

await rm(portableRoot, { recursive: true, force: true });
await rm(archive, { force: true });
await rm(checksum, { force: true });
await mkdir(portableRoot, { recursive: true });
await Promise.all([
  cp(mainExecutable, resolve(portableRoot, 'NeoTavern.exe')),
  cp(resolve(tauriRoot, 'binaries', sidecars[0]), resolve(portableRoot, 'neotavern-server.exe')),
  cp(resolve(tauriRoot, 'resources'), resolve(portableRoot, 'resources'), {
    recursive: true,
    dereference: true,
  }),
  writeFile(resolve(portableRoot, 'portable.flag'), ''),
  writeFile(
    resolve(portableRoot, 'README.txt'),
    [
      'NeoTavern — portable Windows build',
      '',
      'Run "NeoTavern.exe". Keep the executable, neotavern-server.exe,',
      'resources folder and portable.flag together. User data is created in',
      'the local data folder beside the application.',
      '',
    ].join('\r\n'),
  ),
]);

execFileSync('tar', ['-a', '-c', '-f', archive, '-C', portableBase, folderName], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
});
const digest = await sha256File(archive);
await writeFile(checksum, `${digest}  ${folderName}.zip\r\n`);
console.log(`[desktop:portable] ${archive}`);
console.log(`[desktop:portable] SHA-256 ${digest}`);

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
