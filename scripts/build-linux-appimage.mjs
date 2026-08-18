#!/usr/bin/env node
/**
 * Custom Linux AppImage bundling for NeoTavern.
 *
 * Why not `tauri build --bundles appimage`:
 *  - the tauri bundler's single long-lived process (deb -> rpm -> appimage)
 *    intermittently hangs on hosted runners inside the linuxdeploy AppImage
 *    runtime (recursive AppRun re-exec); this script extracts linuxdeploy and
 *    invokes its raw ELF payload, so AppRun cannot recursively re-exec.
 *  - the opaque `pkg` sidecar must stay byte-identical to the built binary:
 *    linuxdeploy may rewrite its rpath, so we restore the pristine file after
 *    deployment and verify it with sha256 (CI invariant).
 *
 * Pipeline (each step visible and independently reproducible):
 *   1. prepare AppDir layout (usr/bin, usr/lib/<product>/resources, desktop, icon, AppRun)
 *   2. extract linuxdeploy and run the raw ELF for base dependency deployment
 *   3. run the GTK plugin directly, with a guarded scratch-AppDir linuxdeploy re-entry
 *   4. restore pristine sidecar into the AppDir, sha256-verify both copies
 *   5. appimagetool <AppDir> <output>
 *   6. optional: sign with the updater key (env TAURI_SIGNING_PRIVATE_KEY)
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = resolve(root, 'apps/desktop');
const tauriRoot = resolve(desktop, 'src-tauri');
const target = resolve(tauriRoot, 'target/release');
const product = 'NeoTavern';
const version = JSON.parse(await readFile(resolve(tauriRoot, 'tauri.conf.json'), 'utf8')).version;
const arch = process.env.ARCH ?? 'x86_64';
const toolsDir = resolve(process.env.HOME ?? '/root', '.cache/tauri');

const appDir = resolve(target, 'bundle/appimage', `${product}.AppDir`);
const outAppImage = resolve(target, 'bundle/appimage', `${product}_${version}_amd64.AppImage`);

const bin = resolve(target, 'neotavern');

// tauri externalBin convention: binaries/<name>-<target-triple>
const triple = process.env.TARGET_TRIPLE ?? 'x86_64-unknown-linux-gnu';
const sidecarSrc = resolve(tauriRoot, `binaries/neotavern-server-${triple}`);

if (
  !(await stat(sidecarSrc).then(
    () => true,
    () => false,
  ))
) {
  throw new Error(`sidecar not found: ${sidecarSrc} (run pnpm desktop:prepare first)`);
}

const sha256 = async (p) =>
  createHash('sha256')
    .update(await readFile(p))
    .digest('hex');

function run(cmd, args, opts = {}) {
  const { quiet = false, ...spawnOpts } = opts;
  const r = spawnSync(cmd, args, {
    stdio: quiet ? 'ignore' : 'inherit',
    ...spawnOpts,
  });

  if (r.error) throw r.error;

  if (r.status !== 0) {
    const outcome = r.signal ? `terminated by ${r.signal}` : `exited with ${r.status}`;

    throw new Error(`${cmd} ${args.join(' ')} ${outcome}`);
  }

  return r;
}

function runProcessGroup(cmd, args, opts = {}) {
  const { quiet = false, timeoutMs = 10 * 60_000, ...spawnOpts } = opts;

  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(cmd, args, {
      stdio: quiet ? 'ignore' : 'inherit',
      detached: true,
      ...spawnOpts,
    });

    let settled = false;
    let timedOut = false;
    let timeoutHandle;
    let forceKillHandle;

    const cleanup = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (forceKillHandle) clearTimeout(forceKillHandle);
    };

    const settle = (error, result) => {
      if (settled) return;

      settled = true;
      cleanup();

      if (error) {
        rejectRun(error);
      } else {
        resolveRun(result);
      }
    };

    const killGroup = (signal) => {
      if (!child.pid) return;

      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error?.code !== 'ESRCH') {
          throw error;
        }
      }
    };

    child.once('error', (error) => {
      if (!timedOut) {
        settle(error);
      }
    });

    child.once('exit', (code, signal) => {
      if (timedOut) return;

      if (code === 0) {
        settle(null, { status: code, signal });
        return;
      }

      const outcome = signal ? `terminated by ${signal}` : `exited with ${code}`;

      settle(new Error(`${cmd} ${args.join(' ')} ${outcome}`));
    });

    timeoutHandle = setTimeout(() => {
      timedOut = true;

      dumpProcessTree(child);

      try {
        killGroup('SIGTERM');
      } catch (error) {
        settle(error);
        return;
      }

      forceKillHandle = setTimeout(() => {
        try {
          killGroup('SIGKILL');
        } catch (error) {
          settle(error);
          return;
        }

        settle(new Error(`${cmd} ${args.join(' ')} timed out after ${timeoutMs} ms`));
      }, 5_000);
    }, timeoutMs);
  });
}

function dumpProcessTree(child) {
  console.error('[appimage] linuxdeploy timed out; process tree snapshot:');

  spawnSync('ps', ['-eo', 'pid,ppid,pgid,sid,stat,wchan:32,etime,cmd', '--forest'], {
    stdio: 'inherit',
  });

  try {
    spawnSync('pstree', ['-ap', String(child.pid)], { stdio: 'inherit' });
  } catch {
    // pstree may be absent; the ps snapshot above is sufficient
  }
}

function cleanAppImageRuntimeEnv() {
  const env = { ...process.env };

  for (const key of [
    'APPIMAGE_EXTRACT_AND_RUN',
    'APPIMAGE',
    'APPDIR',
    'ARGV0',
    'OWD',
    'LINUXDEPLOY',
    'LINUXDEPLOY_PLUGIN_MODE',
  ]) {
    delete env[key];
  }

  return env;
}

async function runExtractedLinuxdeploy() {
  const linuxdeployAppImage = join(toolsDir, `linuxdeploy-${arch}.AppImage`);

  const extractionDir = await mkdtemp(join(tmpdir(), 'neotavern-linuxdeploy-'));

  try {
    const extractionEnv = cleanAppImageRuntimeEnv();
    extractionEnv.ARCH = arch;

    console.log(`[appimage] Extracting linuxdeploy payload from ${linuxdeployAppImage}`);

    run(linuxdeployAppImage, ['--appimage-extract'], {
      cwd: extractionDir,
      env: extractionEnv,
      stdio: ['ignore', 'ignore', 'inherit'],
      timeout: 2 * 60_000,
      killSignal: 'SIGKILL',
    });

    const extractedRoot = join(extractionDir, 'squashfs-root');

    const linuxdeployElf = join(extractedRoot, 'usr/bin/linuxdeploy');

    await access(linuxdeployElf, constants.X_OK);

    // Isolated plugin dir: the shared ~/.cache/tauri may contain
    // linuxdeploy-plugin-appimage.AppImage, whose AppImage runtime cannot
    // answer the discovery probe (--plugin-api-version) without FUSE and
    // aborts discovery with exit 127. The extracted payload ships its own
    // raw linuxdeploy-plugin-appimage, so we only add the GTK shell plugin.
    const pluginDir = join(extractionDir, 'plugins');
    await mkdir(pluginDir, { recursive: true });
    const gtkPlugin = join(pluginDir, 'linuxdeploy-plugin-gtk.sh');
    await copyFile(join(toolsDir, 'linuxdeploy-plugin-gtk.sh'), gtkPlugin);
    run('chmod', ['+x', gtkPlugin]);

    // Guarded re-entry wrapper: the GTK plugin's final re-invocation
    // (env LINUXDEPLOY_PLUGIN_MODE=1 "$LINUXDEPLOY" --appdir=... --library=...)
    // must not re-scan the real AppDir. linuxdeploy 659c9db checks
    // LINUXDEPLOY_PLUGIN_MODE only near the end of main(), AFTER scanning
    // every ELF in the existing AppDir (including native .node modules),
    // which stalls on hosted runners. The wrapper redirects the re-entry to
    // an EMPTY scratch AppDir, then merges the deployed GTK libs back, so
    // better_sqlite3.node is never re-scanned. A second re-entry is blocked.
    const reentry = join(extractionDir, 'neotavern-linuxdeploy-reentry');
    await writeFile(
      reentry,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        '',
        'if [ "${NEOTAVERN_LINUXDEPLOY_REENTRY:-0}" = "1" ]; then',
        '  echo "ERROR: recursive linuxdeploy re-entry blocked" >&2',
        '  exit 70',
        'fi',
        '',
        'export NEOTAVERN_LINUXDEPLOY_REENTRY=1',
        `RAW_LINUXDEPLOY="${linuxdeployElf}"`,
        `export PATH="${join(extractedRoot, 'usr/bin')}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"`,
        '',
        'real_appdir=""',
        'forward_args=()',
        '',
        'while (($#)); do',
        '  case "$1" in',
        '    --appdir=*)',
        '      real_appdir="${1#--appdir=}"',
        '      shift',
        '      ;;',
        '    --appdir)',
        '      real_appdir="$2"',
        '      shift 2',
        '      ;;',
        '    *)',
        '      case "$1" in',
        '        --plugin*|--output*)',
        '          echo "ERROR: linuxdeploy re-entry must not receive --plugin/--output" >&2',
        '          exit 66',
        '          ;;',
        '      esac',
        '      forward_args+=("$1")',
        '      shift',
        '      ;;',
        '  esac',
        'done',
        '',
        'if [ -z "$real_appdir" ]; then',
        '  echo "ERROR: GTK linuxdeploy re-entry has no --appdir" >&2',
        '  exit 64',
        'fi',
        '',
        'scratch="$(mktemp -d "${TMPDIR:-/tmp}/neotavern-gtkdeps-XXXXXX")"',
        'cleanup() { rm -rf "$scratch"; }',
        'trap cleanup EXIT',
        '',
        'echo "[appimage] GTK dependency re-entry"',
        'echo "[appimage] real AppDir:    $real_appdir"',
        'echo "[appimage] scratch AppDir: $scratch"',
        '',
        'export LINUXDEPLOY_PLUGIN_MODE=1',
        '',
        '"$RAW_LINUXDEPLOY" --verbosity 1 --appdir="$scratch" "${forward_args[@]}"',
        '',
        'mkdir -p "$real_appdir/usr"',
        'cp -a "$scratch/usr/." "$real_appdir/usr/"',
        '',
        'echo "[appimage] GTK dependencies merged into real AppDir"',
        '',
      ].join('\n'),
    );
    run('chmod', ['+x', reentry]);

    const env = cleanAppImageRuntimeEnv();
    env.ARCH = arch;
    env.PATH = [
      pluginDir,
      join(extractedRoot, 'usr/bin'),
      '/usr/local/sbin',
      '/usr/local/bin',
      '/usr/sbin',
      '/usr/bin',
      '/sbin',
      '/bin',
    ].join(delimiter);

    // Stage 1: base dependency deployment, no plugins. The GTK plugin's
    // re-entry was the recursion source, so it is invoked directly in stage 2.
    console.log(`[appimage] Stage 1: raw linuxdeploy ELF (no plugins): ${linuxdeployElf}`);
    await runProcessGroup(linuxdeployElf, ['--verbosity', '1', '--appdir', appDir], {
      env,
      timeoutMs: 10 * 60_000,
    });

    // Stage 2: the GTK plugin, run directly; its re-invocation goes through
    // the guarded wrapper, so the chain is at most plugin -> wrapper -> ELF.
    console.log(`[appimage] Stage 2: GTK plugin (direct): ${gtkPlugin}`);
    await runProcessGroup('bash', [gtkPlugin, '--appdir', appDir], {
      env: { ...env, LINUXDEPLOY: reentry },
      timeoutMs: 10 * 60_000,
    });
  } finally {
    await rm(extractionDir, {
      recursive: true,
      force: true,
    });
  }
}

async function download(url, dest) {
  if (
    await stat(dest).then(
      () => true,
      () => false,
    )
  ) {
    return;
  }

  await mkdir(dirname(dest), {
    recursive: true,
  });

  run('curl', ['-fsSL', '-o', dest, url]);

  run('chmod', ['+x', dest]);
}

// 0. Fetch bundler tools (idempotent; warm ~/.cache/tauri on the runner)
await download(
  `https://github.com/tauri-apps/binary-releases/releases/download/linuxdeploy/linuxdeploy-${arch}.AppImage`,
  join(toolsDir, `linuxdeploy-${arch}.AppImage`),
);

await download(
  `https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-${arch}`,
  join(toolsDir, `AppRun-${arch}`),
);

await download(
  'https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gtk/master/linuxdeploy-plugin-gtk.sh',
  join(toolsDir, 'linuxdeploy-plugin-gtk.sh'),
);

// 1. Prepare AppDir
await rm(appDir, {
  recursive: true,
  force: true,
});

await mkdir(join(appDir, 'usr/bin'), {
  recursive: true,
});

await mkdir(join(appDir, 'usr/lib', product, 'resources'), {
  recursive: true,
});

await copyFile(bin, join(appDir, 'usr/bin/neotavern'));

await copyFile(sidecarSrc, join(appDir, 'usr/bin/neotavern-server'));

const resources =
  JSON.parse(await readFile(resolve(tauriRoot, 'tauri.conf.json'), 'utf8')).bundle.resources ?? [];

for (const pattern of resources) {
  const [dir] = pattern.split('/**');

  if (!dir) {
    continue;
  }

  // strip the resources/ base
  const rel = dir.replace(/^resources\//, '');

  run('cp', ['-r', resolve(tauriRoot, dir), join(appDir, 'usr/lib', product, 'resources', rel)], {
    quiet: true,
  });
}

await copyFile(resolve(tauriRoot, 'icons/128x128.png'), join(appDir, `${product}.png`));

await writeFile(
  join(appDir, `${product}.desktop`),
  [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${product}`,
    'Exec=neotavern',
    `Icon=${product}`,
    'Categories=Network;',
    '',
  ].join('\n'),
);

await copyFile(join(toolsDir, `AppRun-${arch}`), join(appDir, 'AppRun'));

run('chmod', [
  '+x',
  join(appDir, 'AppRun'),
  join(appDir, 'usr/bin/neotavern'),
  join(appDir, 'usr/bin/neotavern-server'),
]);

// 2. linuxdeploy deploy-only: base deps (stage 1) + GTK plugin direct (stage 2),
//    both without the AppImage runtime and with guarded re-entry
await runExtractedLinuxdeploy();

// 3. Restore pristine sidecar + verify (CI invariant)
const sidecarInApp = join(appDir, 'usr/bin/neotavern-server');

const before = await sha256(sidecarSrc);

await copyFile(sidecarSrc, sidecarInApp);

const after = await sha256(sidecarInApp);

if (before !== after) {
  throw new Error('sidecar sha256 mismatch after restore');
}

console.log(`sidecar restored: ${before} (${before === after ? 'ok' : 'MISMATCH'})`);

// 4. appimagetool
await download(
  `https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-${arch}.AppImage`,
  join(toolsDir, `appimagetool-${arch}.AppImage`),
);

const appImageToolEnv = cleanAppImageRuntimeEnv();

appImageToolEnv.ARCH = arch;
appImageToolEnv.APPIMAGE_EXTRACT_AND_RUN = '1';

run(
  join(toolsDir, `appimagetool-${arch}.AppImage`),
  ['--appimage-extract-and-run', appDir, outAppImage],
  {
    env: appImageToolEnv,
  },
);

const appImageSha = await sha256(outAppImage);

console.log(`AppImage: ${outAppImage} (${appImageSha})`);

// 5. Sign (updater) when the key is provided
const privKey = process.env.TAURI_SIGNING_PRIVATE_KEY;

if (privKey) {
  run('pnpm', [
    '--dir',
    desktop,
    'exec',
    'tauri',
    'signer',
    'sign',
    '-k',
    privKey,
    '-p',
    process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '',
    outAppImage,
  ]);
}
