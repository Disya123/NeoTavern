#!/usr/bin/env node
/**
 * One-command UI editing loop for the native chat chrome (M4 wave 2).
 *
 *   pnpm ui:dev [document.json] [--w n] [--h n] [--messages n]
 *
 * Without an argument it seeds a WRITABLE copy of the canonical chat document
 * into a stable scratch path and opens it in the editor loop — structure,
 * labels, icons and token styles all live in that JSON and hot-reload by
 * mtime into the running host.
 */

import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const repositoryRoot = resolve(import.meta.dirname, '..');
const canonicalFixture = resolve(
  repositoryRoot,
  'packages',
  'contracts',
  'src',
  'presentation',
  'fixtures',
  'ui-blueprint-document-chat-v1.json',
);
const validatorScript = resolve(
  repositoryRoot,
  'packages',
  'contracts',
  'tools',
  'validate-document.mjs',
);
const scratchDoc = join(tmpdir(), 'neotavern-ui-dev', 'chat.document.json');

function desktopBin() {
  const override = process.env.NEOTA_DESKTOP_BIN;
  if (override) {
    return resolve(override);
  }
  const exe = process.platform === 'win32' ? 'neocompositor-desktop.exe' : 'neocompositor-desktop';
  return resolve(repositoryRoot, 'crates', 'target', 'release', exe);
}

function parseOption(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function main() {
  const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const width = parseOption('--w') ?? '1100';
  const height = parseOption('--h') ?? '760';
  const messages = parseOption('--messages') ?? '12';

  let documentPath;
  if (positional.length === 0) {
    mkdirSync(join(scratchDoc, '..'), { recursive: true });
    copyFileSync(canonicalFixture, scratchDoc);
    documentPath = scratchDoc;
  } else {
    documentPath = resolve(positional[0]);
  }
  if (!existsSync(documentPath)) {
    console.error(`[ui:dev] document not found: ${documentPath}`);
    process.exit(2);
  }

  // Preflight so authoring mistakes surface immediately, with warnings.
  const validation = spawnSync(process.execPath, [validatorScript, documentPath], {
    encoding: 'utf8',
  });
  process.stdout.write(validation.stdout ?? '');
  if (validation.status !== 0) {
    console.error('[ui:dev] fix validation errors, then re-run.');
    process.exit(validation.status ?? 1);
  }

  if (!existsSync(desktopBin())) {
    console.log('[ui:dev] building desktop host (release)…');
    const built = spawnSync(
      process.platform === 'win32' ? 'cmd.exe' : 'cargo',
      process.platform === 'win32'
        ? [
            '/c',
            'cargo',
            'build',
            '--release',
            '--manifest-path',
            join(repositoryRoot, 'crates', 'Cargo.toml'),
            '-p',
            'neotavern-presentation-chat',
            '--bin',
            'neocompositor-desktop',
            '--features',
            'desktop-host',
          ]
        : [
            'build',
            '--release',
            '--manifest-path',
            join(repositoryRoot, 'crates', 'Cargo.toml'),
            '-p',
            'neotavern-presentation-chat',
            '--bin',
            'neocompositor-desktop',
            '--features',
            'desktop-host',
          ],
      { stdio: 'inherit' },
    );
    if (built.status !== 0) {
      process.exit(built.status ?? 1);
    }
  }

  console.log('');
  console.log('──────────────────────────────────────────────────────────────');
  console.log('NeoTavern ui:dev — правьте документ, кадр обновится сам (mtime)');
  console.log(`документ:  ${documentPath}`);
  console.log(`проверка:  pnpm blueprint:validate "${documentPath}"`);
  console.log(`отчёт:     pnpm blueprint-preview "${documentPath}"`);
  console.log('остановка: Ctrl+C');
  console.log('──────────────────────────────────────────────────────────────');
  console.log('');

  const child = spawn(
    desktopBin(),
    [
      '--blueprint',
      documentPath,
      '--w',
      String(width),
      '--h',
      String(height),
      '--messages',
      messages,
    ],
    { stdio: 'inherit' },
  );
  child.on('exit', (code) => process.exit(code ?? 0));
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
