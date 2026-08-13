#!/usr/bin/env node
/** Build signed Tauri updater artifacts without persisting release keys. */
import { spawnSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = resolve(root, 'apps/desktop');
const tauriRoot = resolve(desktop, 'src-tauri');
const generatedConfig = resolve(tauriRoot, '.release-config.generated.json');
if (dirname(generatedConfig) !== tauriRoot) throw new Error('Unsafe generated release config path');

const endpoint = process.env['NEOTA_UPDATE_ENDPOINT'];
const publicKey = process.env['NEOTA_UPDATE_PUBLIC_KEY'];
const privateKey = process.env['TAURI_SIGNING_PRIVATE_KEY'];
const bundles = process.env['TAURI_BUNDLES'];
if (!endpoint || !publicKey || !privateKey) {
  throw new Error(
    'desktop:release requires NEOTA_UPDATE_ENDPOINT, NEOTA_UPDATE_PUBLIC_KEY and TAURI_SIGNING_PRIVATE_KEY',
  );
}
const updateUrl = new URL(endpoint);
if (updateUrl.protocol !== 'https:') throw new Error('NEOTA_UPDATE_ENDPOINT must use HTTPS');

// Overwrite (not 'wx'): a killed previous run may leave this file behind, and
// 'wx' would then block every retry until manual cleanup. The file is removed
// in `finally` below and never contains secrets beyond the public key.
await writeFile(
  generatedConfig,
  `${JSON.stringify(
    {
      build: { beforeBuildCommand: '' },
      bundle: { createUpdaterArtifacts: true },
      // The endpoint is the exact update-manifest URL (static JSON mode):
      // the client GETs it and expects the Tauri updater manifest, e.g.
      // {"version":"0.1.0","platforms":{"windows-x86_64":{"signature":"...","url":"..."}}}.
      // For GitHub Releases, host that JSON as a release asset and point the
      // variable at its latest-download URL.
      plugins: { updater: { pubkey: publicKey, endpoints: [endpoint] } },
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);

let status = null;
try {
  const args = [
    '--dir',
    desktop,
    'tauri',
    'build',
    '--config',
    'src-tauri/.release-config.generated.json',
  ];
  if (bundles) args.push('--bundles', bundles);
  const result = spawnSync('pnpm', args, {
    cwd: root,
    env: {
      ...process.env,
      CI: process.env['CI'] === '1' ? 'true' : process.env['CI'],
      // Public release channel: the shell defaults to the tested legacy
      // sidecar while the Kernel is an explicit Preview (ADR-0038 honest
      // staged default). Nightly/internal builds set NEOTA_DESKTOP_CHANNEL
      // =nightly (or NEOTA_KERNEL=1 at runtime) to default to the Kernel.
      NEOTA_DESKTOP_CHANNEL: 'release',
    },
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  status = result.status;
} finally {
  await rm(generatedConfig, { force: true });
}
if (status !== 0) throw new Error(`Tauri updater build exited with ${status ?? 'no status'}`);
