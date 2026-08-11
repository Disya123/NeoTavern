#!/usr/bin/env node
/**
 * Pre-flight / post-build verification for the custom Linux AppImage
 * pipeline. Every check corresponds to a failure mode that was reproduced
 * and root-caused during the NeoTavern 0.1.0 release work:
 *
 *   1. missing binaries          -> sidecar ENOENT, premature exit
 *   2. missing tools             -> linuxdeploy/plugin subprocess 127
 *   3. FUSE absent               -> informative: the pipeline is FUSE-independent
 *                                    (raw ELF + APPIMAGE_EXTRACT_AND_RUN)
 *   4. cached AppImage plugins   -> informative: isolated PATH prevents discovery
 *   5. AppImage runtime usage    -> AppRun recursive re-exec chain (confirmed)
 *   6. unguarded GTK re-entry    -> linuxdeploy -> linuxdeploy -> ... (confirmed via
 *                                    process tree; 659c9db checks
 *                                    LINUXDEPLOY_PLUGIN_MODE late in main(), after
 *                                    re-scanning every ELF of the real AppDir)
 *   7. native .node ldd sanity   -> diagnostic only (not the confirmed root cause;
 *                                    the last log line before a stall drifts)
 *   8. sidecar mutation          -> rpm bundler rewrites the pkg sidecar rpath
 *                                    (sha256 drift); the pipeline must restore the
 *                                    pristine file in every artifact
 *
 * Exit codes: 0 = pass (warnings allowed); 1 = hard failure; 2 = warnings with
 * --strict-warnings (default GitHub Actions steps treat any nonzero as failure,
 * so expected environment warnings must not fail the job by default).
 *
 * Usage:
 *   node scripts/check-linux-appimage-env.mjs                 # pre-build
 *   node scripts/check-linux-appimage-env.mjs --post          # post-build
 *   node scripts/check-linux-appimage-env.mjs --strict-warnings
 */
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = resolve(root, 'apps/desktop');
const tauriRoot = resolve(desktop, 'src-tauri');
const target = resolve(tauriRoot, 'target/release');
const post = process.argv.includes('--post');
const strictWarnings = process.argv.includes('--strict-warnings');
const requireSignature = process.argv.includes('--require-signature');
const triple = process.env.TARGET_TRIPLE ?? 'x86_64-unknown-linux-gnu';
const toolsDir = resolve(process.env.HOME ?? '/root', '.cache/tauri');
const appDir = resolve(target, 'bundle/appimage', 'NeoTavern.AppDir');
const version = JSON.parse(await readFile(resolve(tauriRoot, 'tauri.conf.json'), 'utf8')).version;
const outAppImage = resolve(target, 'bundle/appimage', `NeoTavern_${version}_amd64.AppImage`);

const results = [];
const sha256 = async (p) => createHash('sha256').update(await readFile(p)).digest('hex');
const sha256Sync = (buf) => createHash('sha256').update(buf).digest('hex');

function pass(name, detail = '') {
  results.push({ level: 0, name, detail });
}

function warn(name, detail = '') {
  results.push({ level: 2, name, detail });
}

function fail(name, detail = '') {
  results.push({ level: 1, name, detail });
}

function info(name, detail = '') {
  results.push({ level: 3, name, detail });
}

function check(name, ok, detail = '') {
  (ok ? pass : fail)(name, detail);
}

function which(tool) {
  const r = spawnSync('bash', ['-lc', `command -v -- "${tool}"`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

// --- 1. binaries -----------------------------------------------------------
const bin = resolve(target, 'neotavern');
const sidecarSrc = resolve(tauriRoot, `binaries/neotavern-server-${triple}`);
check(
  'binaries present',
  await stat(bin).then(() => true, () => false) &&
    await stat(sidecarSrc).then(() => true, () => false),
  `expected ${bin} and ${sidecarSrc} (run pnpm desktop:prepare first)`,
);

// --- 2. tools --------------------------------------------------------------
const requiredTools = [
  'bash', 'curl', 'env', 'find', 'ldd', 'mktemp', 'readelf', 'file',
  'sed', 'cp', 'ln', 'chmod', 'patchelf', 'strip', 'pkgconf', 'pkg-config',
  'glib-compile-schemas', 'timeout', 'ps',
];
const missingTools = requiredTools.filter((t) => !which(t));
check(
  'required tools present',
  missingTools.length === 0,
  missingTools.length ? `missing: ${missingTools.join(', ')}` : '',
);

// --- 3./4. environment notes (the pipeline handles both) --------------------
if (await stat('/dev/fuse').then(() => true, () => false)) {
  info('FUSE present (AppImage runtimes may use mounts)');
} else {
  info(
    'FUSE absent',
    'okay: the pipeline is FUSE-independent (raw linuxdeploy ELF + APPIMAGE_EXTRACT_AND_RUN)',
  );
}

const cacheEntries = await readdirSafe(toolsDir);
const cachedPluginAppImages = cacheEntries.filter(
  (e) => e.startsWith('linuxdeploy-plugin-') && e.endsWith('.AppImage'),
);
if (cachedPluginAppImages.length === 0) {
  info('~/.cache/tauri has no AppImage plugins');
} else {
  info(
    `cached AppImage plugins present (${cachedPluginAppImages.join(', ')})`,
    'okay: the isolated plugin dir + explicit raw PATH prevent their discovery by linuxdeploy',
  );
}

// --- 5./6. static pipeline invariants (source of the build script) ---------
const scriptSrc = await readFile(resolve(root, 'scripts/build-linux-appimage.mjs'), 'utf8');

// 5. linuxdeploy must only be EXTRACTED, never executed through its runtime
check(
  'linuxdeploy AppImage only extracted (exact token)',
  /['"]--appimage-extract['"]/.test(scriptSrc),
  'expected the exact --appimage-extract token',
);
check(
  'no extract-and-run for the linuxdeploy AppImage',
  !scriptSrc.includes('linuxdeploy-${arch}.AppImage")') ||
    !scriptSrc.includes('--appimage-extract-and-run'),
  'linuxdeploy must never execute through its AppImage runtime (AppRun recursion)',
);

// 6. architecture: Stage 1 (no plugins) -> direct GTK plugin -> guarded scratch re-entry
check(
  'linuxdeploy invoked without --plugin',
  !scriptSrc.includes("'--plugin'"),
  'no plugin discovery by linuxdeploy; the GTK plugin is invoked directly',
);
check(
  'GTK plugin invoked directly via bash',
  scriptSrc.includes("gtkPlugin, '--appdir', appDir"),
  'Stage 2 must run linuxdeploy-plugin-gtk.sh directly, not via linuxdeploy discovery',
);
check(
  're-entry LINUXDEPLOY env points at the wrapper',
  scriptSrc.includes('LINUXDEPLOY: reentry'),
  'the GTK plugin must re-enter through the guarded wrapper, not the raw ELF',
);
check(
  're-entry redirects to an empty scratch AppDir',
  scriptSrc.includes('--appdir="$scratch"') && scriptSrc.includes('neotavern-gtkdeps'),
  'the child linuxdeploy must never receive the real AppDir (better_sqlite3.node re-scan = the stall)',
);
check(
  're-entry blocks --plugin/--output',
  scriptSrc.includes('--plugin*|--output*'),
  'the wrapper must reject --plugin/--output in the re-entry args',
);
check(
  're-entry recursion guard present',
  scriptSrc.includes('NEOTAVERN_LINUXDEPLOY_REENTRY') &&
    scriptSrc.includes('exit 70'),
  'a second re-entry must be blocked',
);
check(
  're-entry wrapper PATH excludes the plugin dir',
  scriptSrc.includes('export PATH="${join(extractedRoot') &&
    !/export PATH="\$\{join\(pluginDir/.test(scriptSrc),
  'the nested linuxdeploy must not be able to rediscover the GTK plugin',
);

// 6b. raw linuxdeploy PATH: explicit, no ~/.cache/tauri, no process.env.PATH
const pathArray = scriptSrc.match(/env\.PATH\s*=\s*\[([\s\S]*?)\]\s*\.join\(delimiter\);/);
if (pathArray) {
  const arr = pathArray[1];
  check(
    'raw linuxdeploy PATH excludes ~/.cache/tauri',
    !arr.includes('toolsDir'),
    'the poisoned cache (linuxdeploy-plugin-*.AppImage) must not be discoverable',
  );
  check(
    'raw linuxdeploy PATH is explicit (no process.env.PATH)',
    !arr.includes('process.env.PATH'),
    'an arbitrary inherited PATH could reintroduce an AppImage plugin',
  );
} else {
  fail('raw linuxdeploy PATH array found in the build script', 'expected env.PATH = [...]');
}

// --- 7. ldd sanity on native modules (diagnostic only, pre-build) ----------
if (!post) {
  const resources = JSON.parse(
    await readFile(resolve(tauriRoot, 'tauri.conf.json'), 'utf8'),
  ).bundle.resources ?? [];
  const nativeModules = [];
  for (const pattern of resources) {
    const dir = pattern.split('/**')[0];
    if (!dir || !dir.startsWith('resources/')) continue;
    const dirPath = resolve(tauriRoot, dir);
    for (const entry of await readdirSafe(dirPath, { recursive: true })) {
      if (entry.endsWith('.node')) nativeModules.push(resolve(dirPath, entry));
    }
  }
  for (const module of nativeModules) {
    const r = spawnSync(
      'timeout',
      ['10s', '/usr/bin/ldd', module],
      { encoding: 'utf8', timeout: 15_000 },
    );
    if (r.status === 124) {
      warn(
        `ldd unusually slow: ${module.split(/[\\/]/).pop()}`,
        'diagnostic only — the confirmed stall is the GTK re-entry re-scan, not ldd itself',
      );
    } else if (r.status === 0) {
      pass(`ldd ${module.split(/[\\/]/).pop()}`, 'ok');
    } else {
      warn(
        `ldd ${module.split(/[\\/]/).pop()}`,
        `rc=${r.status}: ${(r.stderr || r.stdout || '').trim().split('\n')[0] ?? ''}`,
      );
    }
  }
}

// --- 8. post-build: pristine sidecar across ALL artifacts ------------------
if (post) {
  const pristine = await sha256(sidecarSrc);

  const sidecarInApp = resolve(appDir, 'usr/bin/neotavern-server');
  if (await stat(sidecarInApp).then(() => true, () => false)) {
    const appHash = await sha256(sidecarInApp);
    check('sidecar pristine in AppDir', appHash === pristine, `src=${pristine} app=${appHash}`);
  } else {
    warn('AppDir sidecar not found', `expected ${sidecarInApp}`);
  }

  // DEB
  const debDir = resolve(target, 'bundle/deb');
  const debs = (await readdirSafe(debDir)).filter((e) => e.endsWith('.deb'));
  if (debs.length === 1 && which('dpkg-deb')) {
    const deb = resolve(debDir, debs[0]);
    const tmp = await mkdtempLocal('neotavern-debcheck-');
    try {
      const r = spawnSync('dpkg-deb', ['-x', deb, tmp], { encoding: 'utf8' });
      if (r.status === 0) {
        const extracted = resolve(tmp, 'usr/bin/neotavern-server');
        if (await stat(extracted).then(() => true, () => false)) {
          const h = await sha256(extracted);
          check('sidecar pristine in DEB', h === pristine, `src=${pristine} deb=${h}`);
        } else {
          warn('DEB sidecar not found at usr/bin/neotavern-server', extracted);
        }
      } else {
        warn('dpkg-deb extraction failed', r.stderr?.trim().split('\n')[0] ?? `rc=${r.status}`);
      }
    } finally {
      await rmrf(tmp);
    }
  } else if (debs.length > 0) {
    warn('DEB sidecar check skipped', debs.length !== 1 ? `found ${debs.length} debs` : 'dpkg-deb missing');
  }

  // RPM (newc cpio payload; compression:none in the tauri config)
  const rpmDir = resolve(target, 'bundle/rpm');
  const rpms = (await readdirSafe(rpmDir)).filter((e) => e.endsWith('.rpm'));
  if (rpms.length === 1) {
    const rpm = resolve(rpmDir, rpms[0]);
    const hit = sidecarInRpm(rpm);
    if (hit) {
      check('sidecar pristine in RPM', hit.sha === pristine, `src=${pristine} rpm=${hit.sha}`);
    } else {
      warn('RPM sidecar not found in payload', 'newc cpio parse found no neotavern-server entry');
    }
  } else if (rpms.length > 0) {
    warn('RPM sidecar check skipped', `found ${rpms.length} rpms`);
  }

  // Final AppImage: extract (no FUSE needed) and verify the shipped sidecar
  if (await stat(outAppImage).then(() => true, () => false)) {
    const tmp = await mkdtempLocal('neotavern-appimage-check-');
    try {
      const r = spawnSync(outAppImage, ['--appimage-extract'], {
        cwd: tmp,
        stdio: 'ignore',
        timeout: 120_000,
      });
      if (r.status === 0) {
        const extracted = resolve(tmp, 'squashfs-root/usr/bin/neotavern-server');
        if (await stat(extracted).then(() => true, () => false)) {
          const h = await sha256(extracted);
          check('sidecar pristine in final AppImage', h === pristine, `src=${pristine} appimage=${h}`);
        } else {
          fail('AppImage sidecar not found', 'squashfs-root/usr/bin/neotavern-server missing after --appimage-extract');
        }
      } else {
        warn('AppImage extraction failed', `--appimage-extract rc=${r.status}`);
      }
    } finally {
      await rmrf(tmp);
    }
  } else {
    fail('AppImage produced', `expected ${outAppImage}`);
  }

  // Signature: required only when signing is expected
  const sig = `${outAppImage}.sig`;
  const signed = await stat(sig).then(() => true, () => false);
  const signingExpected = Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY) || requireSignature;
  if (signingExpected) {
    check('AppImage updater signature', signed, `expected ${sig}`);
  } else if (signed) {
    pass('AppImage updater signature', 'present');
  } else {
    pass('AppImage updater signature', 'not required for this build');
  }
}

// --- report ----------------------------------------------------------------
const hardFails = results.filter((r) => r.level === 1).length;
const warns = results.filter((r) => r.level === 2).length;
for (const r of results) {
  const mark = r.level === 0 ? 'PASS' : r.level === 1 ? 'FAIL' : r.level === 2 ? 'WARN' : 'INFO';
  console.log(`[${mark}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(
  `\n${results.length - hardFails - warns - results.filter((r) => r.level === 3).length} passed, ` +
    `${results.filter((r) => r.level === 3).length} info, ${warns} warnings, ${hardFails} failed`,
);
process.exit(hardFails > 0 ? 1 : strictWarnings && warns > 0 ? 2 : 0);

// --- helpers ---------------------------------------------------------------
// rpm-rs 0.16 bundles payloads with the `cpio` crate (0.4). Its newc writer
// pads the entry name relative to the entry start: name region = 110 + namesize
// padded to 4; data padding is relative to (header+name region + filesize).
// Neither is absolute file alignment. pad4 mirrors the crate's pad().
function pad4(n) {
  return (4 - (n % 4)) % 4;
}

function sidecarInRpm(rpmPath) {
  const data = readFileSync(rpmPath);
  const magic = Buffer.from('070701');
  let i = 0;
  while (true) {
    const j = data.indexOf(magic, i);
    if (j < 0 || j + 110 > data.length) return null;
    const h = data.subarray(j, j + 110);
    if (h.subarray(0, 6).toString('ascii') !== '070701') return null;
    const size = Number.parseInt(h.subarray(54, 62).toString('ascii'), 16);
    const nameSize = Number.parseInt(h.subarray(94, 102).toString('ascii'), 16);
    if (nameSize < 1 || nameSize > 4096 || size > data.length) {
      i = j + 1; // coincidental "070701" inside payload data — rescan forward
      continue;
    }
    const name = data.subarray(j + 110, j + 110 + nameSize).toString('utf8').replace(/\0+$/, '');
    const dataStart = j + 110 + nameSize + pad4(110 + nameSize);
    if (name.includes('neotavern-server')) {
      const body = data.subarray(dataStart, dataStart + size);
      // The ELF magic is an assertion, not a padding search — a parser bug
      // must surface as an error, not be silently "fixed" by offset picking.
      if (
        body[0] !== 0x7f ||
        body[1] !== 0x45 ||
        body[2] !== 0x4c ||
        body[3] !== 0x46
      ) {
        throw new Error('expected ELF magic at parsed cpio payload offset');
      }
      return { name, sha: sha256Sync(body) };
    }
    const headerSize = 110 + nameSize + pad4(110 + nameSize);
    i = j + headerSize + size + pad4(headerSize + size);
  }
}

async function readdirSafe(dir, opts) {
  try {
    const { readdir } = await import('node:fs/promises');
    return await readdir(dir, opts);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function mkdtempLocal(prefix) {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  return mkdtemp(join(tmpdir(), prefix));
}

async function rmrf(dir) {
  const { rm } = await import('node:fs/promises');
  await rm(dir, { recursive: true, force: true });
}
