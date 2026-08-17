#!/usr/bin/env node
/**
 * Capture-host helpers for post-GateP:P1 M0-D1a. Not D1a PASS. Not D1b.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PACKAGE = 'com.neotavern.mobile';
export const ACTIVITY = 'com.neotavern.mobile.M0D1aActivity';
export const COMPONENT = `${PACKAGE}/.M0D1aActivity`;
export const MIN_DEVICE_SDK = 30;
export const REQUIRED_DEBUG_GROUPS = ['m0-d1a-roi-read:1', 'm0-d1a-roi-read:2'];
export const ACCUMULATOR_LABEL = 'm0-d1a-accumulator';
export const SNAPSHOT_LABEL = 'm0-d1a-glass-roi';
export const EVIDENCE_SCHEMA = 'm0-d1a-capture-evidence/v1';
export const AGI_PIN_REL = 'tools/agi.pin.json';
export const PRESET_REL = 'tools/agi-frame-capture.preset.json';
/** Capture-host scripts identity. APK provenance is the latest BOUND bundle. */
export const PINNED_CAPTURE_TOOLING_COMMIT = '5df24c8fa97ca2edce3d5627445c2b3e419d683c';
export const READY_POINTER = 'capture-host-ready.json';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CAPTURES_DIR = join(ROOT, 'apps', 'android', 'm0-d1a-captures');
export const DEFAULT_APK = join(
  ROOT,
  'apps',
  'android',
  'app',
  'build',
  'outputs',
  'apk',
  'debug',
  'app-debug.apk',
);

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function loadAgiPin(root = ROOT) {
  return JSON.parse(readFileSync(join(root, AGI_PIN_REL), 'utf8'));
}

export function loadPreset(root = ROOT) {
  return JSON.parse(readFileSync(join(root, PRESET_REL), 'utf8'));
}

export function gitRevParse(root = ROOT) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) return null;
  return (result.stdout || '').trim() || null;
}

export function toolingCommitIsAncestor(root = ROOT) {
  const result = spawnSync(
    'git',
    ['merge-base', '--is-ancestor', PINNED_CAPTURE_TOOLING_COMMIT, 'HEAD'],
    { cwd: root, encoding: 'utf8' },
  );
  return result.status === 0;
}

export function classifyProvenance({ bundle, apkSha256, toolingCommit }) {
  const tooling = toolingCommit ?? PINNED_CAPTURE_TOOLING_COMMIT;
  if (!bundle?.apk_sha256 || bundle.apk_linkage !== 'BOUND') {
    return { ok: false, reason: 'no BOUND source bundle for APK provenance' };
  }
  if (bundle.evidence_dirty) {
    return { ok: false, reason: 'bound bundle evidence_dirty=true; do not cite' };
  }
  if (!apkSha256 || bundle.apk_sha256 !== apkSha256) {
    return {
      ok: false,
      reason: 'APK SHA-256 does not match the BOUND source bundle',
    };
  }
  if (!bundle.base_commit) {
    return { ok: false, reason: 'bound bundle missing apk_source_commit (base_commit)' };
  }
  if (bundle.base_commit === tooling) {
    return {
      ok: false,
      reason:
        'apk_source_commit equals capture_tooling_commit; APK must be bound from a later source commit',
    };
  }
  return {
    ok: true,
    apk_source_commit: bundle.base_commit,
    apk_sha256: bundle.apk_sha256,
    capture_tooling_commit: tooling,
    bound_bundle: bundle.bundle_path ?? null,
    evidence_dirty: false,
    apk_linkage: 'BOUND',
    reason: 'APK provenance is the BOUND source bundle; capture tooling stays pinned at 5df24c8',
  };
}

export function verifyAgiPin(pin = loadAgiPin()) {
  const home = pin.install_path;
  const missing = [];
  const mismatches = [];
  for (const [name, expected] of Object.entries(pin.binaries ?? {})) {
    const path = join(home, name);
    if (!existsSync(path)) {
      missing.push(name);
      continue;
    }
    const actual = sha256File(path);
    if (actual !== expected) {
      mismatches.push({ name, expected, actual });
    }
  }
  const gapit = join(home, 'gapit.exe');
  const propsPath = join(home, 'build.properties');
  let buildShaOk = existsSync(propsPath);
  let buildShaActual = null;
  if (buildShaOk) {
    const props = readFileSync(propsPath, 'utf8');
    buildShaActual = props.match(/Build\.SHA=([0-9a-f]+)/u)?.[1] ?? null;
    buildShaOk = buildShaActual === pin.build_sha;
  }
  const ready = missing.length === 0 && mismatches.length === 0 && existsSync(gapit) && buildShaOk;
  return {
    version: pin.version,
    build_sha: pin.build_sha,
    build_sha_actual: buildShaActual,
    install_path: home,
    gapit: existsSync(gapit) ? gapit : null,
    agi: existsSync(join(home, 'agi.exe')) ? join(home, 'agi.exe') : null,
    missing,
    mismatches,
    ready,
    reason: ready
      ? `AGI ${pin.version} pin verified at ${home}`
      : missing.length
        ? `AGI binaries missing: ${missing.join(',')}`
        : !buildShaOk
          ? `AGI Build.SHA mismatch (pin ${pin.build_sha}, actual ${buildShaActual})`
          : 'AGI binary hash mismatch',
  };
}

export function parseJavaVersion(text) {
  const match = text.match(/version "?([0-9]+)(?:\.([0-9]+))?/u);
  if (!match) return null;
  const major = Number(match[1]) === 1 && match[2] ? Number(match[2]) : Number(match[1]);
  return { major, raw: (text.trim().split(/\r?\n/u)[0] ?? text).trim() };
}

export function findJava(pin = loadAgiPin()) {
  const candidates = [
    join(pin.install_path, 'jre', 'bin', 'java.exe'),
    process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', 'java.exe') : null,
    'E:\\Android\\Android Studio\\jbr\\bin\\java.exe',
    'java',
  ].filter(Boolean);
  let fallback = null;
  for (const bin of candidates) {
    if (bin !== 'java' && !existsSync(bin)) continue;
    const result = spawnSync(bin, ['-version'], { encoding: 'utf8' });
    const parsed = parseJavaVersion(`${result.stderr || ''}\n${result.stdout || ''}`);
    if (!parsed) continue;
    const row = { bin, ...parsed, ok: parsed.major >= 11 };
    if (row.ok) return { ...row, reason: `Java ${parsed.major}` };
    fallback = { ...row, reason: `Java ${parsed.major} < 11` };
  }
  return fallback ?? { bin: null, major: 0, ok: false, reason: 'no Java >= 11' };
}

export function findAdb() {
  const homes = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    'E:\\android_sdk',
    join(homedir(), 'AppData', 'Local', 'Android', 'Sdk'),
  ].filter(Boolean);
  const candidates = homes.flatMap((home) => [
    join(home, 'platform-tools', 'adb.exe'),
    join(home, 'platform-tools', 'adb'),
  ]);
  candidates.push('adb');
  for (const bin of candidates) {
    if (bin !== 'adb' && !existsSync(bin)) continue;
    const result = spawnSync(bin, ['version'], { encoding: 'utf8' });
    if (result.status === 0) {
      return { bin, ok: true, version: (result.stdout || '').trim().split(/\r?\n/u)[0] };
    }
  }
  return { bin: null, ok: false, version: null, reason: 'adb not found' };
}

export function findAapt() {
  const homes = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, 'E:\\android_sdk'].filter(
    Boolean,
  );
  for (const home of homes) {
    const buildTools = join(home, 'build-tools');
    if (!existsSync(buildTools)) continue;
    for (const ver of readdirSync(buildTools).sort().reverse()) {
      for (const name of ['aapt.exe', 'aapt']) {
        const exe = join(buildTools, ver, name);
        if (existsSync(exe)) return exe;
      }
    }
  }
  return null;
}

export function ensureTraceDir(dir = CAPTURES_DIR) {
  mkdirSync(dir, { recursive: true });
  const probe = join(dir, '.write-probe');
  writeFileSync(probe, 'ok\n');
  rmSync(probe, { force: true });
  return { dir, ok: true, writable: true };
}

export function captureStamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/gu, '-');
}

export function captureFilenames(stamp) {
  const base = `${stamp}-d1a`;
  return {
    stamp,
    gfxtrace: `${base}.gfxtrace`,
    commands: `${base}-commands.txt`,
    logcat: `${base}-logcat.txt`,
    device: `${base}-device.json`,
    evidence: `${base}-evidence.json`,
  };
}

export function parseAdbDevices(text) {
  const devices = [];
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('List of devices')) continue;
    const serial = line.split(/\s+/u)[0];
    const emulator = serial.startsWith('emulator-') || /sdk_gphone|goldfish|ranchu/iu.test(line);
    devices.push({
      serial,
      line,
      emulator,
      usb: /\busb:/u.test(line),
      unauthorized: /\bunauthorized\b/u.test(line),
    });
  }
  return devices;
}

export function isEmulator(serial, props = {}) {
  const blob = `${serial} ${props['ro.hardware'] ?? ''} ${props['ro.product.model'] ?? ''} ${props['ro.product.device'] ?? ''}`;
  return (
    serial.startsWith('emulator-') ||
    props['ro.kernel.qemu'] === '1' ||
    /goldfish|ranchu|sdk_gphone|emulator/iu.test(blob)
  );
}

export function classifyHardwareGpu(props) {
  const egl = `${props['ro.hardware.egl'] ?? ''} ${props['ro.opengles.version'] ?? ''}`;
  if (/swiftshader/iu.test(egl) || props['ro.kernel.qemu'] === '1') {
    return { ok: false, hardware: false, vulkan: false, reason: 'software renderer or qemu' };
  }
  const vulkan = Boolean(
    String(props['ro.hardware.vulkan'] ?? props['ro.gfx.driver.0'] ?? '').trim(),
  );
  return { ok: true, hardware: true, vulkan, reason: 'hardware GPU props accepted' };
}

export function abiCompatible(deviceAbi, apkAbis) {
  if (!deviceAbi || !apkAbis?.length) return false;
  if (apkAbis.includes(deviceAbi)) return true;
  if (deviceAbi.startsWith('arm64')) return apkAbis.includes('arm64-v8a');
  if (deviceAbi.startsWith('x86_64')) return apkAbis.includes('x86_64');
  return false;
}

export function parseAaptBadging(text) {
  const native = [...text.matchAll(/native-code: ([^\n]+)/gu)].flatMap((row) =>
    [...row[1].matchAll(/'([^']+)'/gu)].map((m) => m[1]),
  );
  return {
    package: text.match(/package: name='([^']+)'/u)?.[1] ?? null,
    debuggable: /application-debuggable/u.test(text),
    abis: native,
    min_sdk: Number(text.match(/sdkVersion:'(\d+)'/u)?.[1] ?? 0),
    vulkan_feature: /android\.hardware\.vulkan/u.test(text),
  };
}

export function parseManifestActivities(xmltree) {
  return {
    has_m0d1a:
      xmltree.includes('com.neotavern.mobile.M0D1aActivity') || xmltree.includes('.M0D1aActivity'),
    exported_m0d1a: /M0D1aActivity[\s\S]{0,500}android:exported[^=]*=\(type 0x12\)0xffffffff/u.test(
      xmltree,
    ),
    agi_main_m0d1a: /M0D1aActivity[\s\S]{0,2500}android\.intent\.action\.MAIN/u.test(xmltree),
  };
}

export function inspectApkFromText(badging, xmltree, apkPath, sha256, bytes) {
  const parsed = parseAaptBadging(badging);
  const activities = parseManifestActivities(xmltree);
  const vulkanFeature = parsed.vulkan_feature || /android\.hardware\.vulkan/u.test(xmltree);
  const ok =
    parsed.package === PACKAGE &&
    parsed.debuggable &&
    activities.has_m0d1a &&
    activities.exported_m0d1a &&
    activities.agi_main_m0d1a &&
    parsed.abis.length > 0 &&
    vulkanFeature;
  return {
    ok,
    path: apkPath,
    sha256,
    bytes,
    package: parsed.package,
    activity: ACTIVITY,
    component: COMPONENT,
    debuggable: parsed.debuggable,
    activity_exported: activities.exported_m0d1a,
    agi_main_intent: activities.agi_main_m0d1a,
    abis: parsed.abis,
    min_sdk: parsed.min_sdk,
    vulkan_feature: vulkanFeature,
    vulkan_runtime:
      'wgpu prefers Vulkan on physical Android; GLES is fallback; AGI preset uses -api vulkan',
    reason: ok
      ? 'debug APK inspect ok'
      : 'APK inspect failed package/debuggable/exported activity/agi MAIN/abi/vulkan',
  };
}

export function inspectApk(apkPath, aaptBin = findAapt()) {
  if (!apkPath || !existsSync(apkPath)) return { ok: false, reason: 'APK missing', path: apkPath };
  if (!aaptBin) return { ok: false, reason: 'aapt not found', path: apkPath };
  const badging = spawnSync(aaptBin, ['dump', 'badging', apkPath], { encoding: 'utf8' });
  const tree = spawnSync(aaptBin, ['dump', 'xmltree', apkPath, 'AndroidManifest.xml'], {
    encoding: 'utf8',
  });
  if (badging.status !== 0) {
    return { ok: false, reason: `aapt dump failed: ${badging.stderr || badging.stdout}` };
  }
  return inspectApkFromText(
    badging.stdout,
    tree.stdout || '',
    apkPath,
    sha256File(apkPath),
    statSync(apkPath).size,
  );
}

export function debugManifestVulkanDeclared(root = ROOT) {
  const path = join(root, 'apps', 'android', 'app', 'src', 'debug', 'AndroidManifest.xml');
  return existsSync(path) && readFileSync(path, 'utf8').includes('android.hardware.vulkan');
}

export function debugManifestAgiMainDeclared(root = ROOT) {
  const path = join(root, 'apps', 'android', 'app', 'src', 'debug', 'AndroidManifest.xml');
  if (!existsSync(path)) return false;
  const xml = readFileSync(path, 'utf8');
  return (
    /M0D1aActivity[\s\S]*android\.intent\.action\.MAIN/u.test(xml) &&
    !xml.includes('android.intent.category.LAUNCHER')
  );
}

export function latestBoundBundle(dir = CAPTURES_DIR) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('-source-bundle.json'))
    .sort();
  for (let i = files.length - 1; i >= 0; i -= 1) {
    try {
      const rec = JSON.parse(readFileSync(join(dir, files[i]), 'utf8'));
      if (rec.apk_linkage === 'BOUND' && rec.apk_sha256) {
        return { ...rec, bundle_path: join(dir, files[i]) };
      }
    } catch {
      continue;
    }
  }
  return null;
}

export function bindApkMatches(bundle, apkPath) {
  if (!bundle?.apk_sha256) return { ok: false, reason: 'no BOUND bundle' };
  if (bundle.apk_linkage !== 'BOUND') return { ok: false, reason: 'apk_linkage is not BOUND' };
  if (!apkPath || !existsSync(apkPath)) return { ok: false, reason: 'APK file missing' };
  const actual = sha256File(apkPath);
  if (actual !== bundle.apk_sha256) {
    return {
      ok: false,
      actual,
      expected: bundle.apk_sha256,
      reason: 'APK SHA-256 != bound bundle',
    };
  }
  return { ok: true, sha256: actual, reason: 'APK SHA-256 matches BOUND bundle' };
}

export function classifyCaptureDump(text) {
  const missing = REQUIRED_DEBUG_GROUPS.filter((group) => !text.includes(group));
  if (!text.includes(ACCUMULATOR_LABEL)) missing.push(ACCUMULATOR_LABEL);
  if (!text.includes(SNAPSHOT_LABEL)) missing.push(SNAPSHOT_LABEL);
  return {
    ok: missing.length === 0,
    missing,
    found_groups: REQUIRED_DEBUG_GROUPS.filter((group) => text.includes(group)),
    reason:
      missing.length === 0
        ? 'capture dump contains both ROI reads and named resources'
        : `capture incomplete: missing ${missing.join(',')}`,
  };
}

export function buildGapitTraceCommand({ gapit, serial, out, preset = loadPreset() }) {
  return [
    gapit,
    'trace',
    '-api',
    preset.api,
    '-capture-frames',
    String(preset.capture_frames),
    '-serial',
    serial,
    '-out',
    out,
    '-uri',
    preset.uri,
    '-additionalargs',
    preset.additionalargs,
  ];
}

export function buildGapitCommandsCommand({ gapit, gfxtrace, out }) {
  return [gapit, 'commands', '-groupbyusermarkers', '-groupbyframe', gfxtrace, '>', out];
}

export function buildEvidenceManifest(input) {
  return {
    schema: EVIDENCE_SCHEMA,
    note: 'not a D1a PASS; not D1b; capture_tooling_commit stays 5df24c8; APK provenance is the BOUND bundle',
    physical_device: input.physical_device,
    capture_host: input.capture_host,
    apk_source_commit: input.apk_source_commit ?? null,
    apk_sha256: input.apk_sha256 ?? null,
    capture_tooling_commit: input.capture_tooling_commit ?? PINNED_CAPTURE_TOOLING_COMMIT,
    apk_linkage: input.apk_linkage ?? 'BOUND',
    evidence_dirty: input.evidence_dirty ?? false,
    agi: input.agi,
    apk: input.apk,
    required_debug_groups: REQUIRED_DEBUG_GROUPS,
    files: input.files ?? null,
    completeness: input.completeness ?? null,
    capture_command: input.capture_command ?? null,
    unblock: input.unblock,
  };
}

export function writeCaptureManifest(dir, files, manifest) {
  const evidencePath = join(dir, files.evidence);
  const pointerPath = join(dir, READY_POINTER);
  writeFileSync(evidencePath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    pointerPath,
    `${JSON.stringify({ ...manifest, evidence_path: evidencePath }, null, 2)}\n`,
  );
  return { evidencePath, pointerPath };
}

export function evaluateHost(opts = {}) {
  const pin = opts.pin ?? loadAgiPin();
  const agi = verifyAgiPin(pin);
  const java = findJava(pin);
  const adb = findAdb();
  const traces = ensureTraceDir(opts.capturesDir ?? CAPTURES_DIR);
  const aapt = findAapt();
  const bundle = latestBoundBundle(opts.capturesDir ?? CAPTURES_DIR);
  const apkPath =
    opts.apkPath ??
    (bundle?.apk_path && existsSync(bundle.apk_path) ? bundle.apk_path : DEFAULT_APK);
  const apk = opts.apkInspect ?? inspectApk(apkPath, aapt);
  const bind = bundle ? bindApkMatches(bundle, apkPath) : { ok: false, reason: 'no BOUND bundle' };
  const toolingCommit = opts.toolingCommit ?? PINNED_CAPTURE_TOOLING_COMMIT;
  const provenance = classifyProvenance({
    bundle,
    apkSha256: apk.sha256 ?? bind.sha256,
    toolingCommit,
  });
  const blockers = [];
  if (!agi.ready) blockers.push(agi.reason);
  if (!java.ok) blockers.push(java.reason);
  if (!adb.ok) blockers.push(adb.reason ?? 'adb not found');
  if (!traces.ok) blockers.push('trace directory not writable');
  if (!apk.ok) blockers.push(apk.reason);
  if (!bind.ok) blockers.push(bind.reason);
  if (!opts.skipToolingAncestor && !toolingCommitIsAncestor()) {
    blockers.push(
      `capture_tooling_commit ${PINNED_CAPTURE_TOOLING_COMMIT} is not an ancestor of HEAD`,
    );
  }
  if (!provenance.ok) blockers.push(provenance.reason);
  const capture_host = blockers.length === 0 ? 'READY' : 'NOT_READY_INTERNAL';
  return {
    capture_host,
    physical_device: 'BLOCKED_EXTERNAL',
    agi,
    java,
    adb,
    traces,
    aapt,
    apk: { ...apk, bind },
    vulkan_source: debugManifestVulkanDeclared(),
    agi_main_source: debugManifestAgiMainDeclared(),
    provenance,
    bundle: bundle
      ? {
          path: bundle.bundle_path,
          apk_sha256: bundle.apk_sha256,
          base_commit: bundle.base_commit,
          apk_linkage: bundle.apk_linkage,
        }
      : null,
    blockers,
    ready: capture_host === 'READY',
    unblock:
      capture_host === 'READY'
        ? 'attach a physical Android over USB (not emulator); then run node scripts/m0-d1a-capture-preflight.mjs'
        : `fix capture host: ${blockers.join('; ')}`,
  };
}

function adbProps(adbBin, serial) {
  const keys = [
    'ro.build.version.sdk',
    'ro.product.cpu.abi',
    'ro.kernel.qemu',
    'ro.hardware',
    'ro.hardware.egl',
    'ro.hardware.vulkan',
    'ro.product.model',
    'ro.product.device',
    'ro.opengles.version',
  ];
  const props = {};
  for (const key of keys) {
    const result = spawnSync(adbBin, ['-s', serial, 'shell', 'getprop', key], { encoding: 'utf8' });
    props[key] = (result.stdout || '').trim();
  }
  return props;
}

export function selectPhysicalDevice(adbBin) {
  const listed = spawnSync(adbBin, ['devices', '-l'], { encoding: 'utf8' });
  const parsed = parseAdbDevices(listed.stdout || '');
  const physical = [];
  for (const row of parsed) {
    if (row.unauthorized) continue;
    const props = adbProps(adbBin, row.serial);
    if (isEmulator(row.serial, props) || row.emulator) continue;
    physical.push({ ...row, props });
  }
  return { listed: parsed, physical };
}

export function deviceGate(device, apkAbis) {
  const sdk = Number(device.props['ro.build.version.sdk'] || 0);
  if (sdk < MIN_DEVICE_SDK) {
    return { ok: false, reason: `Android ${sdk} < ${MIN_DEVICE_SDK} (need 11+)` };
  }
  if (!abiCompatible(device.props['ro.product.cpu.abi'], apkAbis)) {
    return {
      ok: false,
      reason: `device ABI ${device.props['ro.product.cpu.abi']} not in APK ${apkAbis.join(',')}`,
    };
  }
  const gpu = classifyHardwareGpu(device.props);
  if (!gpu.ok) return gpu;
  return { ok: true, reason: 'physical device gate passed', gpu, sdk };
}

export function formatCaptureHelp(command) {
  return [
    'AGI GUI: File → Capture Trace → API=Vulkan → Stop after 1 frame.',
    'Commands pane: group by user markers, search m0-d1a-roi-read:1 then m0-d1a-roi-read:2.',
    `CLI: ${command.map((part) => (/\s/u.test(part) ? JSON.stringify(part) : part)).join(' ')}`,
    'Then: gapit commands -groupbyusermarkers -groupbyframe TRACE.gfxtrace',
    'Then: node scripts/m0-d1a-capture-check.mjs --commands TRACE-commands.txt',
  ].join('\n');
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function hostOnlyMain() {
  const host = evaluateHost();
  const stamp = captureStamp();
  const files = captureFilenames(stamp);
  const preset = loadPreset();
  const captureCommand = host.agi.gapit
    ? buildGapitTraceCommand({
        gapit: host.agi.gapit,
        serial: '<PHYSICAL_SERIAL>',
        out: join(host.traces.dir, files.gfxtrace),
        preset,
      })
    : [];
  const manifest = buildEvidenceManifest({
    physical_device: 'BLOCKED_EXTERNAL',
    capture_host: host.capture_host,
    apk_source_commit: host.provenance?.apk_source_commit,
    apk_sha256: host.provenance?.apk_sha256,
    capture_tooling_commit: host.provenance?.capture_tooling_commit,
    agi: {
      version: host.agi.version,
      build_sha: host.agi.build_sha,
      path: host.agi.install_path,
      ready: host.agi.ready,
    },
    apk: host.apk,
    files,
    capture_command: captureCommand,
    unblock: host.unblock,
  });
  const written = host.ready ? writeCaptureManifest(host.traces.dir, files, manifest) : null;
  printJson({
    ...host,
    files,
    preset,
    capture_help: formatCaptureHelp(captureCommand),
    manifest,
    evidence_path: written?.evidencePath ?? null,
    ready_pointer: written?.pointerPath ?? null,
  });
  process.exit(host.ready ? 0 : 2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const cmd = process.argv[2] ?? 'host-only';
  if (cmd === 'host-only') hostOnlyMain();
  else {
    console.error(`unknown command ${cmd}`);
    process.exit(2);
  }
}
