import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GOLDEN_D1A_COUNTERS,
  PINNED_CAPTURE_TOOLING_COMMIT,
  REQUIRED_DEBUG_GROUPS,
  abiCompatible,
  bindApkMatches,
  buildEvidenceManifest,
  buildGapitTraceCommand,
  buildRenderdocCaptureCommand,
  captureFilenames,
  classifyCaptureDump,
  classifyRenderdocApi,
  classifyHardwareGpu,
  classifyProvenance,
  classifyRoiReadOrder,
  debugManifestAgiMainDeclared,
  debugManifestRenderdocQueriesDeclared,
  debugManifestVulkanDeclared,
  loadPreset,
  loadRenderdocPin,
  loadRenderdocPreset,
  parseProbeLogLine,
  deviceGate,
  inspectApkFromText,
  isEmulator,
  parseAdbDevices,
  parseJavaVersion,
  verifyAgiPin,
  verifyRenderdocPin,
} from './m0-d1a-capture-host.mjs';

const ROOT = join(import.meta.dirname, '..');

const completeDump = readFileSync(
  new URL('./fixtures/m0-d1a-agi-commands-complete.txt', import.meta.url),
  'utf8',
);
const incompleteDump = readFileSync(
  new URL('./fixtures/m0-d1a-agi-commands-incomplete.txt', import.meta.url),
  'utf8',
);

describe('m0-d1a capture host', () => {
  it('keeps RenderDoc queries out of the production main manifest', () => {
    const xml = readFileSync(
      join(ROOT, 'apps', 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
      'utf8',
    );
    expect(xml).not.toContain('org.renderdoc.renderdoccmd');
  });

  it('keeps the debug-only in-app RenderDoc boundary on the documented 1.1.2 slots', () => {
    const src = readFileSync(
      join(ROOT, 'crates', 'presentation-m0', 'src', 'renderdoc_capture.rs'),
      'utf8',
    );
    expect(src).toContain('const IDX_SET_PATH: usize = 11;');
    expect(src).toContain('const IDX_START: usize = 19;');
    expect(src).toContain('const IDX_END: usize = 21;');
    expect(src).toContain('StartFrameCapture');
    expect(src).toContain('capture_device=wgpu-vulkan');
    expect(src).toContain('as_hal::<VulkanApi>');
    expect(src).toContain('start(ptrs.rdoc_device, ptr::null_mut())');
    expect(src).not.toMatch(/start\(\s*ptr::null_mut\(\)/u);
  });

  it('pulls Android .rdc files above Node maxBuffer default', () => {
    const src = readFileSync(join(ROOT, 'scripts', 'm0-d1a-renderdoc-capture.mjs'), 'utf8');
    expect(src).toContain('maxBuffer: 64 * 1024 * 1024');
    expect(src).toContain("ls -1 files");
  });

  it('does not enable renderdoc-capture from android-jni', () => {
    const toml = readFileSync(join(ROOT, 'crates', 'presentation-m0', 'Cargo.toml'), 'utf8');
    expect(toml).toMatch(/android-jni = \["gpu"\]/u);
    expect(toml).not.toMatch(/android-jni = \[[^\]]*renderdoc-capture/u);
    expect(toml).toMatch(/renderdoc-capture = \["gpu", "dep:ash"\]/u);
  });

  it('pins vendored renderdoc_app.h', () => {
    const pin = loadRenderdocPin();
    const header = readFileSync(join(ROOT, pin.app_header.path));
    expect(header.byteLength).toBe(pin.app_header.bytes);
    expect(createHash('sha256').update(header).digest('hex')).toBe(pin.app_header.sha256);
  });

  it('exposes M0D1aActivity to AGI via MAIN without LAUNCHER', () => {
    expect(debugManifestAgiMainDeclared()).toBe(true);
    const preset = loadPreset();
    expect(preset.uri).toBe(
      'android.intent.action.MAIN:com.neotavern.mobile/com.neotavern.mobile.M0D1aActivity',
    );
    expect(preset.capture_frames).toBe(0);
    expect(preset.duration).toBe('15s');
  });

  it('declares debug-only RenderDoc package queries', () => {
    expect(debugManifestRenderdocQueriesDeclared()).toBe(true);
    const preset = loadRenderdocPreset();
    expect(preset.tool).toBe('RenderDoc');
    expect(preset.layer_package).toBe('org.renderdoc.renderdoccmd.arm64');
    expect(preset.vulkan_layer).toBe('VK_LAYER_RENDERDOC_Capture');
  });

  it('pins AGI 3.3.3 at E:\\agi', () => {
    const pin = JSON.parse(readFileSync(new URL('../tools/agi.pin.json', import.meta.url), 'utf8'));
    expect(pin.version).toBe('3.3.3');
    expect(pin.install_path.replaceAll('/', '\\')).toBe('E:\\agi');
    expect(pin.build_sha).toBe('5f97b4fd99a9459320b782203ce2de5351a1e661');
  });

  it('verifies installed AGI hashes', () => {
    const result = verifyAgiPin();
    expect(result.ready).toBe(true);
    expect(result.gapit).toMatch(/gapit\.exe$/u);
  });

  it('pins RenderDoc 1.45 at E:\\renderdoc', () => {
    const pin = JSON.parse(
      readFileSync(new URL('../tools/renderdoc.pin.json', import.meta.url), 'utf8'),
    );
    expect(pin.version).toBe('1.45');
    expect(pin.install_path.replaceAll('/', '\\')).toBe('E:\\renderdoc');
    expect(pin.build_sha).toBe('2fc0bc04cb95499635f63986a55bc6f67849dd9f');
    expect(pin.zip_sha256).toBe('bd665c348a8245d10a1f513e35b83603edc1a78006277583d09ec0769286eea4');
    expect(pin.app_header.sha256).toBe(
      'b7005e7dc34c3635046868bbd76d81b9b055aede0f56daa0bd39fedee0639ffb',
    );
  });

  it('verifies installed RenderDoc hashes', () => {
    const result = verifyRenderdocPin();
    expect(result.ready).toBe(true);
    expect(result.qrenderdoc).toMatch(/qrenderdoc\.exe$/u);
    expect(result.renderdoccmd).toMatch(/renderdoccmd\.exe$/u);
    expect(result.android_apk).toMatch(/org\.renderdoc\.renderdoccmd\.arm64\.apk$/u);
  });

  it('parses Java 11+', () => {
    expect(parseJavaVersion('openjdk version "11.0.7" 2020-04-14').major).toBe(11);
    expect(parseJavaVersion('openjdk version "21.0.8" 2025-07-15').major).toBe(21);
    expect(parseJavaVersion('java version "1.8.0_202"').major).toBe(8);
  });

  it('excludes emulator serials and qemu props', () => {
    const devices = parseAdbDevices(
      [
        'List of devices attached',
        'emulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:1',
        'R58M30ABCDE           device usb:1-1 product:r8sxxx model:SM_S911B device:r8s',
      ].join('\n'),
    );
    expect(devices[0].emulator).toBe(true);
    expect(devices[1].emulator).toBe(false);
    expect(isEmulator('emulator-5554', {})).toBe(true);
    expect(isEmulator('R58M30ABCDE', { 'ro.kernel.qemu': '1' })).toBe(true);
    expect(isEmulator('R58M30ABCDE', { 'ro.hardware': 'qcom' })).toBe(false);
  });

  it('rejects SwiftShader / qemu GPU', () => {
    expect(classifyHardwareGpu({ 'ro.hardware.egl': 'swiftshader' }).ok).toBe(false);
    expect(classifyHardwareGpu({ 'ro.kernel.qemu': '1' }).ok).toBe(false);
    expect(
      classifyHardwareGpu({ 'ro.hardware.egl': 'adreno', 'ro.hardware.vulkan': 'adreno' }).ok,
    ).toBe(true);
  });

  it('checks ABI compatibility', () => {
    expect(abiCompatible('arm64-v8a', ['arm64-v8a', 'x86_64'])).toBe(true);
    expect(abiCompatible('x86_64', ['arm64-v8a', 'x86_64'])).toBe(true);
    expect(abiCompatible('armeabi-v7a', ['arm64-v8a'])).toBe(false);
  });

  it('rejects a debug APK without AGI MAIN on M0D1aActivity', () => {
    const inspect = inspectApkFromText(
      [
        "package: name='com.neotavern.mobile'",
        'application-debuggable',
        "native-code: 'arm64-v8a'",
        "uses-feature: name='android.hardware.vulkan.level'",
      ].join('\n'),
      'A: android:name="com.neotavern.mobile.M0D1aActivity"\nA: android:exported(0x01010010)=(type 0x12)0xffffffff',
      'app-debug.apk',
      'abc',
      1,
    );
    expect(inspect.agi_main_intent).toBe(false);
    expect(inspect.ok).toBe(false);
  });

  it('rejects a debug APK without Vulkan uses-feature', () => {
    const inspect = inspectApkFromText(
      [
        "package: name='com.neotavern.mobile'",
        'application-debuggable',
        "native-code: 'arm64-v8a'",
      ].join('\n'),
      'A: android:name="com.neotavern.mobile.M0D1aActivity"\nA: android:exported(0x01010010)=(type 0x12)0xffffffff',
      'app-debug.apk',
      'abc',
      1,
    );
    expect(inspect.vulkan_feature).toBe(false);
    expect(inspect.ok).toBe(false);
  });

  it('inspects aapt badging for debuggable D1a activity', () => {
    const inspect = inspectApkFromText(
      [
        "package: name='com.neotavern.mobile' versionCode='1'",
        'application-debuggable',
        "sdkVersion:'26'",
        "native-code: 'arm64-v8a' 'x86_64'",
        "uses-feature: name='android.hardware.vulkan.level'",
      ].join('\n'),
      'E: activity (line=12)\n  A: android:name(0x01010003)="com.neotavern.mobile.M0D1aActivity"\n  A: android:exported(0x01010010)=(type 0x12)0xffffffff\n  E: action\n    A: android:name="android.intent.action.MAIN"',
      'app-debug.apk',
      'abc',
      1,
    );
    expect(inspect.ok).toBe(true);
    expect(inspect.debuggable).toBe(true);
    expect(inspect.vulkan_feature).toBe(true);
    expect(inspect.agi_main_intent).toBe(true);
    expect(inspect.abis).toEqual(['arm64-v8a', 'x86_64']);
  });

  it('rejects SHA mismatch against BOUND bundle', () => {
    expect(
      bindApkMatches({ apk_linkage: 'BOUND', apk_sha256: 'aa'.repeat(32) }, 'no-such.apk').ok,
    ).toBe(false);
  });

  it('names traces as {stamp}-d1a.gfxtrace and {stamp}-d1a.rdc', () => {
    const files = captureFilenames('2026-08-17T18-00-00-000Z');
    expect(files.gfxtrace).toBe('2026-08-17T18-00-00-000Z-d1a.gfxtrace');
    expect(files.rdc).toBe('2026-08-17T18-00-00-000Z-d1a.rdc');
    expect(files.xml).toBe('2026-08-17T18-00-00-000Z-d1a.xml');
    expect(files.commands).toBe('2026-08-17T18-00-00-000Z-d1a-commands.txt');
    expect(files.evidence).toBe('2026-08-17T18-00-00-000Z-d1a-evidence.json');
  });

  it('builds the gapit Vulkan frame-capture command', () => {
    const cmd = buildGapitTraceCommand({
      gapit: 'E:\\agi\\gapit.exe',
      serial: 'R58M30ABCDE',
      out: 'apps/android/m0-d1a-captures/stamp-d1a.gfxtrace',
      preset: {
        api: 'vulkan',
        capture_frames: 1,
        uri: 'android.intent.action.MAIN:com.neotavern.mobile/com.neotavern.mobile.M0D1aActivity',
        additionalargs: '-e com.neotavern.mobile.M0_D1A_FRAMES 100',
      },
    });
    expect(cmd).toContain('-api');
    expect(cmd).toContain('vulkan');
    expect(cmd).toContain('-capture-frames');
    expect(cmd).toContain('1');
    expect(cmd).not.toContain('-for');
    expect(cmd[0]).toBe('E:\\agi\\gapit.exe');
    const timed = buildGapitTraceCommand({
      gapit: 'E:\\agi\\gapit.exe',
      serial: 'R58M30ABCDE',
      out: 'apps/android/m0-d1a-captures/stamp-d1a.gfxtrace',
      preset: loadPreset(),
    });
    expect(timed).toContain('-for');
    expect(timed).toContain('15s');
    expect(timed).toContain('0');
  });

  it('accepts a complete AGI commands dump', () => {
    const result = classifyCaptureDump(completeDump);
    expect(result.ok).toBe(true);
    expect(result.found_groups).toEqual(REQUIRED_DEBUG_GROUPS);
  });

  it('rejects an incomplete AGI commands dump', () => {
    const result = classifyCaptureDump(incompleteDump);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('m0-d1a-roi-read:1');
    expect(result.missing).toContain('m0-d1a-roi-read:2');
  });

  it('requires ROI read :1 before :2', () => {
    expect(classifyRoiReadOrder(completeDump).ok).toBe(true);
    expect(classifyRoiReadOrder('m0-d1a-roi-read:2 then m0-d1a-roi-read:1').ok).toBe(false);
  });

  it('marks OpenGLES RenderDoc XML as WRONG_API_CAPTURE', () => {
    const gles = `<?xml version="1.0"?><rdc><header><driver id="9">OpenGLES</driver></header>
      <chunks><chunk name="glGenVertexArrays"/><string>Default VAO</string></chunks></rdc>`;
    const api = classifyRenderdocApi(gles);
    expect(api.status).toBe('WRONG_API_CAPTURE');
    expect(api.admissible).toBe(false);
    expect(classifyCaptureDump(gles).ok).toBe(false);
  });

  it('accepts Vulkan RenderDoc XML only with both ROI groups', () => {
    const vulkan = `<?xml version="1.0"?><rdc><header><driver id="1">Vulkan</driver></header>
      <chunks>
        <chunk name="vkQueueSubmit"/>
        <chunk name="vkCmdCopyImage"/>
        <string>m0-d1a-roi-read:1</string>
        <string>m0-d1a-roi-read:2</string>
        <string>m0-d1a-accumulator</string>
        <string>m0-d1a-glass-roi</string>
      </chunks></rdc>`;
    expect(classifyRenderdocApi(vulkan).ok).toBe(true);
    expect(classifyCaptureDump(vulkan).ok).toBe(true);
  });

  it('parses the golden D1a logcat counters', () => {
    const log = `ignored
m0-d1a gpu_ran=true adapter=Adreno_(TM)_710 backend=Vulkan software=false devices=1 readbacks=0 xdev=0 roi_copies=200 raster=400 glass=200 frames=100 ran_on_android=true capture=false timeline=${GOLDEN_D1A_COUNTERS.timeline} timeline_events=13 first_frame_cpu_us=1 acc_bytes=1 verdict=BLOCKED reason=x`;
    const parsed = parseProbeLogLine(log);
    expect(parsed.ok).toBe(true);
    expect(parsed.values).toMatchObject(GOLDEN_D1A_COUNTERS);
  });

  it('builds the RenderDoc capture command', () => {
    const cmd = buildRenderdocCaptureCommand({ serial: '8f5c2b7c' });
    expect(cmd[1]).toMatch(/m0-d1a-renderdoc-capture\.mjs$/u);
    expect(cmd.at(-1)).toBe('--serial=8f5c2b7c');
  });

  it('fails pin verify when a binary is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agi-pin-'));
    writeFileSync(join(dir, 'agi.exe'), 'x');
    const result = verifyAgiPin({
      version: '0',
      build_sha: 'deadbeef',
      install_path: dir,
      binaries: { 'agi.exe': '00'.repeat(32), 'gapit.exe': '11'.repeat(32) },
    });
    expect(result.ready).toBe(false);
    expect(result.missing).toContain('gapit.exe');
  });

  it('rejects Android < 11, ABI mismatch, and qemu GPU at the device gate', () => {
    expect(
      deviceGate({ props: { 'ro.build.version.sdk': '29', 'ro.product.cpu.abi': 'arm64-v8a' } }, [
        'arm64-v8a',
      ]).ok,
    ).toBe(false);
    expect(
      deviceGate({ props: { 'ro.build.version.sdk': '33', 'ro.product.cpu.abi': 'armeabi-v7a' } }, [
        'arm64-v8a',
      ]).ok,
    ).toBe(false);
    expect(
      deviceGate(
        {
          props: {
            'ro.build.version.sdk': '33',
            'ro.product.cpu.abi': 'arm64-v8a',
            'ro.hardware.egl': 'swiftshader',
          },
        },
        ['arm64-v8a'],
      ).ok,
    ).toBe(false);
    expect(
      deviceGate(
        {
          props: {
            'ro.build.version.sdk': '33',
            'ro.product.cpu.abi': 'arm64-v8a',
            'ro.hardware.egl': 'adreno',
            'ro.hardware.vulkan': 'adreno',
          },
        },
        ['arm64-v8a'],
      ).ok,
    ).toBe(true);
  });

  it('rejects an APK inspect when M0D1a is not exported', () => {
    const inspect = inspectApkFromText(
      [
        "package: name='com.neotavern.mobile'",
        'application-debuggable',
        "native-code: 'arm64-v8a'",
      ].join('\n'),
      'A: android:name="com.neotavern.mobile.M0D1aActivity"',
      'app-debug.apk',
      'abc',
      1,
    );
    expect(inspect.ok).toBe(false);
    expect(inspect.activity_exported).toBe(false);
  });

  it('runs capture-check on fixture dumps', () => {
    const complete = spawnSync(
      process.execPath,
      [
        join(ROOT, 'scripts', 'm0-d1a-capture-check.mjs'),
        '--commands',
        join(ROOT, 'scripts', 'fixtures', 'm0-d1a-agi-commands-complete.txt'),
      ],
      { encoding: 'utf8' },
    );
    const incomplete = spawnSync(
      process.execPath,
      [
        join(ROOT, 'scripts', 'm0-d1a-capture-check.mjs'),
        '--commands',
        join(ROOT, 'scripts', 'fixtures', 'm0-d1a-agi-commands-incomplete.txt'),
      ],
      { encoding: 'utf8' },
    );
    expect(complete.status).toBe(0);
    expect(incomplete.status).toBe(4);
  });

  it('takes APK provenance from the BOUND bundle and pins capture tooling at 5df24c8', () => {
    expect(PINNED_CAPTURE_TOOLING_COMMIT.startsWith('5df24c8')).toBe(true);
    const apkSha = '4dfc8b41e48f7c3ba7b996e240a8c39ac16c569e7f92c9b61605ccf3c2f8ef30';
    const bound = {
      apk_linkage: 'BOUND',
      apk_sha256: apkSha,
      base_commit: '4bbc3eb93d4a84e14977c3fea0dcf6bb379f1cf5',
      evidence_dirty: false,
      bundle_path: 'bundle.json',
    };
    expect(
      classifyProvenance({
        bundle: bound,
        apkSha256: apkSha,
        toolingCommit: bound.base_commit,
      }).ok,
    ).toBe(false);
    expect(
      classifyProvenance({
        bundle: { ...bound, evidence_dirty: true },
        apkSha256: apkSha,
        toolingCommit: PINNED_CAPTURE_TOOLING_COMMIT,
      }).ok,
    ).toBe(false);
    expect(
      classifyProvenance({
        bundle: bound,
        apkSha256: '00'.repeat(32),
        toolingCommit: PINNED_CAPTURE_TOOLING_COMMIT,
      }).ok,
    ).toBe(false);
    const ok = classifyProvenance({
      bundle: bound,
      apkSha256: apkSha,
      toolingCommit: PINNED_CAPTURE_TOOLING_COMMIT,
    });
    expect(ok.ok).toBe(true);
    expect(ok.apk_source_commit).toBe(bound.base_commit);
    expect(ok.capture_tooling_commit).toBe(PINNED_CAPTURE_TOOLING_COMMIT);
    expect(ok.capture_tooling_commit).not.toBe(ok.apk_source_commit);
    const manifest = buildEvidenceManifest({
      physical_device: 'BLOCKED_EXTERNAL',
      capture_host: 'READY',
      apk_source_commit: ok.apk_source_commit,
      apk_sha256: ok.apk_sha256,
      capture_tooling_commit: ok.capture_tooling_commit,
    });
    expect(manifest.capture_tooling_commit).toBe(PINNED_CAPTURE_TOOLING_COMMIT);
    expect(manifest.apk_source_commit).not.toBe(PINNED_CAPTURE_TOOLING_COMMIT);
  });
});
