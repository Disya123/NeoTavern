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
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, watch } from 'node:fs';
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

/** Debounce for `.rs` edits before a rebuild+restart cycle starts. */
export const RUST_WATCH_DEBOUNCE_MS = 1500;

function desktopBin() {
  const override = process.env.NEOTA_DESKTOP_BIN;
  if (override) {
    return resolve(override);
  }
  const exe = process.platform === 'win32' ? 'neocompositor-desktop.exe' : 'neocompositor-desktop';
  return resolve(repositoryRoot, 'crates', 'target', 'release', exe);
}

export function parseUiDevArgs(args) {
  const options = {
    width: '1100',
    height: '760',
    messages: '12',
    document: null,
    watch: false,
  };
  const flags = { '--w': 'width', '--h': 'height', '--messages': 'messages' };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (Object.hasOwn(flags, arg)) {
      const value = args[++index];
      if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error(`${arg} requires a positive integer`);
      }
      options[flags[arg]] = value;
    } else if (arg === '--watch') {
      options.watch = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (options.document !== null) {
      throw new Error('Only one UI document can be supplied');
    } else {
      options.document = arg;
    }
  }
  return options;
}

export function seedUiDocument(source, destination) {
  mkdirSync(join(destination, '..'), { recursive: true });
  try {
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

/** `src` dirs of every `presentation-*` crate the desktop bin links. */
export function watchRoots(cratesDir) {
  return readdirSync(cratesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('presentation-'))
    .map((entry) => join(cratesDir, entry.name, 'src'))
    .filter((src) => existsSync(src));
}

/** Only Rust sources trigger a rebuild; documents hot-reload in-process. */
export function isRustSourceFile(name) {
  // A bare ".rs" (length 3) is a dotfile with no stem — not a source file.
  return typeof name === 'string' && name.length > 3 && name.endsWith('.rs');
}

/**
 * Watch the presentation crates' sources and call `onChange` after the
 * debounce settles. Returns a disposer. FS watchers are per-root recursive
 * (supported on Windows and macOS); Linux falls back to per-file watches
 * because `recursive` there is a no-op.
 */
export function watchRustSources(roots, onChange, debounceMs = RUST_WATCH_DEBOUNCE_MS) {
  let timer = null;
  const schedule = (eventName) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange(eventName);
    }, debounceMs);
  };
  const watchers = [];
  for (const root of roots) {
    if (process.platform === 'linux') {
      const stack = [root];
      while (stack.length > 0) {
        const dir = stack.pop();
        watchers.push(
          watch(dir, { persistent: true }, (_event, name) => {
            const full = name === null ? null : join(dir, name.toString());
            if (full !== null && isRustSourceFile(full)) schedule('change');
            if (full !== null && !existsSync(full)) stack.push(full);
          }),
        );
        let entries = [];
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (entry.isDirectory()) stack.push(join(dir, entry.name));
        }
      }
    } else {
      watchers.push(watch(root, { recursive: true }, (_event, name) => {
        if (isRustSourceFile(name)) schedule('change');
      }));
    }
  }
  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    for (const watcher of watchers) watcher.close();
  };
}

function buildDesktopHost() {
  return spawnSync(
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
}

function main() {
  const { document, width, height, messages, watch: watchSources } = parseUiDevArgs(
    process.argv.slice(2),
  );

  let documentPath;
  if (document === null) {
    seedUiDocument(canonicalFixture, scratchDoc);
    documentPath = scratchDoc;
  } else {
    documentPath = resolve(document);
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

  if (!process.env.NEOTA_DESKTOP_BIN) {
    console.log('[ui:dev] checking/building desktop host (release)…');
    const built = buildDesktopHost();
    if (built.status !== 0) {
      process.exit(built.status ?? 1);
    }
  }

  console.log('');
  console.log('──────────────────────────────────────────────────────────────');
  console.log('NeoTavern ui:dev — правьте документ, кадр обновится сам (mtime)');
  if (watchSources) {
    console.log('watch:       правки .rs в presentation-крейтах пересобирают бин');
  }
  console.log(`документ:  ${documentPath}`);
  console.log(`проверка:  pnpm blueprint:validate "${documentPath}"`);
  console.log(`отчёт:     pnpm blueprint-preview "${documentPath}"`);
  console.log('остановка: Ctrl+C');
  console.log('──────────────────────────────────────────────────────────────');
  console.log('');

  const launch = () =>
    spawn(
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

  if (!watchSources) {
    const child = launch();
    child.on('exit', (code) => process.exit(code ?? 0));
    return;
  }

  // --watch: `.rs` edits in the presentation crates rebuild the release bin
  // and restart the window; documents keep hot-reloading in-process. A
  // failed rebuild keeps the loop alive on the previous binary.
  let stopping = false;
  let restarting = false;
  let stopWatch = () => {};
  let child = launch();
  const restart = () => {
    if (stopping || restarting) {
      return;
    }
    restarting = true;
    console.log('[ui:dev] .rs change — rebuilding…');
    child?.kill();
    child = null;
    const built = buildDesktopHost();
    if (built.status !== 0) {
      console.error('[ui:dev] rebuild failed — restarting the previous binary.');
    }
    child = launch();
    restarting = false;
  };
  stopWatch = watchRustSources(watchRoots(join(repositoryRoot, 'crates')), restart);
  child.on('exit', (code) => {
    if (stopping || restarting) return;
    // The window was closed by hand — end the loop like a plain run would.
    stopWatch();
    process.exit(code ?? 0);
  });
  process.on('SIGINT', () => {
    stopping = true;
    stopWatch();
    child?.kill();
    process.exit(0);
  });
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
