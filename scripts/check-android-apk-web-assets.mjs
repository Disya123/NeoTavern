#!/usr/bin/env node
/**
 * Fail-closed gate for ТЗ §11.4 / §18.3: a packaged Android APK must contain
 * `assets/web/index.html` (the production web UI). Assembling without that
 * file used to succeed and ship an error-screen APK — this scanner refuses
 * that artifact.
 *
 * Modes:
 *   (default)     find APKs under apps/android/app/build/outputs/apk/{debug,release}
 *                 and require `assets/web/index.html` in every ZIP central directory
 *                 (APK is a ZIP). Exit 1 if no APK or any APK is missing the entry.
 *   --self-test   fixture ZIP with/without the entry; no Gradle/SDK needed.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APK_OUTPUT_ROOT = join(ROOT, 'apps', 'android', 'app', 'build', 'outputs', 'apk');
const REQUIRED_ENTRY = 'assets/web/index.html';

/** Stored-only ZIP (no compression) so the filename is visible as UTF-8 bytes. */
function storedZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [path, body] of Object.entries(entries)) {
    const name = Buffer.from(path, 'utf8');
    const data = Buffer.from(body);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const localBuf = Buffer.concat(localParts);
  const centralBuf = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, end]);
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * List stored filenames from a ZIP/APK by walking the End of Central Directory
 * record. Does not inflate payloads — the gate only cares that the entry exists.
 */
function zipEntryNames(buf) {
  const sig = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === sig) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a ZIP/APK (missing End of Central Directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`corrupt ZIP central directory at offset ${offset}`);
    }
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    names.push(buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8'));
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

function apkContainsWebIndex(buf) {
  return zipEntryNames(buf).includes(REQUIRED_ENTRY);
}

function findAssembledApks() {
  const found = [];
  for (const variant of ['debug', 'release']) {
    const dir = join(APK_OUTPUT_ROOT, variant);
    let names;
    try {
      names = readdirSync(dir).filter((name) => name.endsWith('.apk'));
    } catch {
      continue;
    }
    names.sort();
    for (const name of names) {
      found.push(join(dir, name));
    }
  }
  return found;
}

function selfTest() {
  const withIndex = storedZip({
    'assets/web/index.html': '<!doctype html><title>NeoTavern</title>',
    'assets/web/assets/app.js': 'console.log(1)',
  });
  const withoutIndex = storedZip({
    'assets/index.html': '<!doctype html>',
    'lib/arm64-v8a/libneotavern_android_jni.so': 'not-a-real-so',
  });
  if (!apkContainsWebIndex(withIndex)) {
    throw new Error('self-test: expected assets/web/index.html to be detected');
  }
  if (apkContainsWebIndex(withoutIndex)) {
    throw new Error('self-test: must not pass an APK without assets/web/index.html');
  }
  const dir = mkdtempSync(join(tmpdir(), 'neota-apk-web-'));
  try {
    writeFileSync(join(dir, 'good.apk'), withIndex);
    writeFileSync(join(dir, 'bad.apk'), withoutIndex);
    const good = readFileSync(join(dir, 'good.apk'));
    const bad = readFileSync(join(dir, 'bad.apk'));
    if (!apkContainsWebIndex(good) || apkContainsWebIndex(bad)) {
      throw new Error('self-test: round-trip through files failed');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log('[android-apk-web-assets] self-test PASS');
}

function main() {
  if (process.argv.includes('--self-test')) {
    selfTest();
    return;
  }
  const apks = findAssembledApks();
  if (apks.length === 0) {
    console.error(
      `[android-apk-web-assets] FAIL — no APK under ${APK_OUTPUT_ROOT}/{debug,release}. ` +
        'Assemble first (`gradle -p apps/android :app:assembleDebug` or ' +
        '`:app:assembleRelease`) after `pnpm --filter @neotavern/web build`.',
    );
    process.exit(1);
  }
  let failed = false;
  for (const apk of apks) {
    const buf = readFileSync(apk);
    if (!apkContainsWebIndex(buf)) {
      console.error(
        `[android-apk-web-assets] FAIL — ${apk} has no ${REQUIRED_ENTRY} ` +
          '(ТЗ §18.3: Android APK assembled without web/index.html). ' +
          'Build the web client (`pnpm --filter @neotavern/web build`) before assemble.',
      );
      failed = true;
      continue;
    }
    console.log(`[android-apk-web-assets] OK — ${apk} contains ${REQUIRED_ENTRY}`);
  }
  if (failed) process.exit(1);
}

main();
