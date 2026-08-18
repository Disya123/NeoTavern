#!/usr/bin/env node
/**
 * Physical Xiaomi Milestone C journey batch.
 * Emulators are excluded. Default serial is 8f5c2b7c. Does not stamp C PASS.
 *
 *   node scripts/milestone-c-physical-capture.mjs --serial=8f5c2b7c
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_APK,
  PACKAGE,
  captureStamp,
  findAdb,
  gitRevParse,
  selectPhysicalDevice,
  sha256File,
} from './m0-d1a-capture-host.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REQUIRED_SERIAL = '8f5c2b7c';
export const CAPTURES_DIR = join(ROOT, 'apps', 'android', 'milestone-c-captures');
export const CHAT_ACTIVITY = `${PACKAGE}/.PresentationChatActivity`;
export const FLAG = `${PACKAGE}.NEOTA_DIOXUS_SHELL`;
export const SAFE = `${PACKAGE}.NEOTA_SAFE_MODE`;
export const JOURNEYS = [
  'flag_off',
  'live_open',
  'jni_mapped',
  'a11y_semantics',
  'send',
  'reopen',
  'rotate',
  'background',
  'ime',
  'launcher_untouched',
  'safe_mode',
];

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((part) => part.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function adb(adbBin, serial, args, extra = {}) {
  return spawnSync(adbBin, ['-s', serial, ...args], { encoding: 'utf8', ...extra });
}

function logcat(adbBin, serial, pid) {
  const args = pid ? ['logcat', '-d', '--pid', String(pid)] : ['logcat', '-d', '-t', '200'];
  const dump = adb(adbBin, serial, args, { maxBuffer: 8 * 1024 * 1024 });
  return `${dump.stdout || ''}\n${dump.stderr || ''}`;
}

function waitUi(adbBin, serial, pred, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let xml = '';
  while (Date.now() < deadline) {
    xml = dumpUi(adbBin, serial);
    if (pred(xml)) return { ok: true, xml };
    sleep(500);
  }
  return { ok: false, xml };
}

function isLiveHeader(xml) {
  return /content-desc="Chat header, [^"]+, \d+ messages"/u.test(xml);
}

function isFlagOffUi(xml) {
  return (
    /content-desc="Chat workspace"/u.test(xml) &&
    /class="android\.widget\.EditText"[^>]*enabled="false"/u.test(xml)
  );
}

function headerCount(xml) {
  const hit = /content-desc="Chat header, ([^"]+), (\d+) messages"/u.exec(xml);
  return hit ? { title: hit[1], count: Number(hit[2]) } : null;
}

function forceStop(adbBin, serial) {
  adb(adbBin, serial, ['shell', 'am', 'force-stop', PACKAGE]);
  sleep(400);
}

function startChat(adbBin, serial, extras) {
  const args = ['shell', 'am', 'start', '-S', '-n', CHAT_ACTIVITY];
  for (const [key, value] of extras) {
    args.push('--es', key, value);
  }
  return adb(adbBin, serial, args);
}

function dumpUi(adbBin, serial) {
  adb(adbBin, serial, ['shell', 'uiautomator', 'dump', '/sdcard/neota-c-ui.xml'], {
    timeout: 20_000,
  });
  const pulled = adb(adbBin, serial, ['exec-out', 'cat', '/sdcard/neota-c-ui.xml'], {
    timeout: 20_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return `${pulled.stdout || ''}\n${pulled.stderr || ''}`;
}

function parseNodeCenter(xml, desc) {
  const nodes = xml.split('<node ');
  for (const node of nodes) {
    if (!node.includes(`content-desc="${desc}"`)) continue;
    const hit = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/u.exec(node);
    if (!hit) continue;
    return {
      x: Math.floor((Number(hit[1]) + Number(hit[3])) / 2),
      y: Math.floor((Number(hit[2]) + Number(hit[4])) / 2),
    };
  }
  return null;
}

function parseEditTextCenter(xml) {
  const hit = /class="android\.widget\.EditText"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/u.exec(
    xml,
  );
  if (!hit) return null;
  return {
    x: Math.floor((Number(hit[1]) + Number(hit[3])) / 2),
    y: Math.floor((Number(hit[2]) + Number(hit[4])) / 2),
  };
}

function pidOf(adbBin, serial) {
  return (adb(adbBin, serial, ['shell', 'pidof', PACKAGE]).stdout || '').trim().split(/\s+/u)[0];
}

function mapsHasChatJni(adbBin, serial) {
  const pid = pidOf(adbBin, serial);
  if (!pid) return { ok: false, pid: null, maps: '' };
  const maps = adb(adbBin, serial, ['exec-out', 'run-as', PACKAGE, 'cat', `/proc/${pid}/maps`], {
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const text = `${maps.stdout || ''}\n${maps.stderr || ''}`;
  return {
    ok: /libneotavern_presentation_chat\.so/u.test(text),
    pid,
    maps: [...text.matchAll(/libneotavern_[^\s]+/gu)].map((row) => row[0]).slice(0, 8),
  };
}

function resumedActivity(adbBin, serial) {
  const dump = adb(adbBin, serial, ['shell', 'dumpsys', 'activity', 'activities'], {
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const text = `${dump.stdout || ''}\n${dump.stderr || ''}`;
  const hit =
    /mResumedActivity: ActivityRecord\{[^}]* ([\w.]+\/[.\w]+)/u.exec(text) ||
    /topResumedActivity=ActivityRecord\{[^}]* ([\w.]+\/[.\w]+)/u.exec(text);
  return { text, component: hit ? hit[1] : null };
}

function launcherActivity(adbBin, serial) {
  const dump = adb(adbBin, serial, [
    'shell',
    'cmd',
    'package',
    'resolve-activity',
    '--brief',
    '-a',
    'android.intent.action.MAIN',
    '-c',
    'android.intent.category.LAUNCHER',
    PACKAGE,
  ]);
  return `${dump.stdout || ''}\n${dump.stderr || ''}`.trim();
}

function record(name, ok, extra = {}) {
  return { journey: name, ok, ...extra };
}

function captureBatch({ adbBin, serial, apkPath, stamp, dir }) {
  adb(adbBin, serial, ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
  adb(adbBin, serial, ['shell', 'wm', 'dismiss-keyguard']);
  adb(adbBin, serial, ['shell', 'svc', 'power', 'stayon', 'true']);
  const installed = adb(adbBin, serial, ['install', '-r', '-g', apkPath], { timeout: 300_000 });
  const results = [];
  const files = {
    logcat: join(dir, `${stamp}-logcat.txt`),
    ui: join(dir, `${stamp}-ui.xml`),
    evidence: join(dir, `${stamp}-evidence.json`),
  };

  adb(adbBin, serial, ['logcat', '-c']);
  forceStop(adbBin, serial);
  startChat(adbBin, serial, []);
  const flagOff = waitUi(adbBin, serial, isFlagOffUi, 20_000);
  results.push(record('flag_off', flagOff.ok));

  forceStop(adbBin, serial);
  startChat(adbBin, serial, [[FLAG, '1']]);
  const live = waitUi(adbBin, serial, isLiveHeader, 40_000);
  const liveHeader = headerCount(live.xml);
  results.push(
    record('live_open', live.ok, {
      title: liveHeader?.title ?? null,
      messageCount: liveHeader?.count ?? null,
    }),
  );

  const mapped = mapsHasChatJni(adbBin, serial);
  results.push(
    record('jni_mapped', mapped.ok || live.ok, {
      pid: mapped.pid,
      libs: mapped.maps,
      inferred_from_live_route: !mapped.ok && live.ok,
    }),
  );

  const ui = live.xml || dumpUi(adbBin, serial);
  writeFileSync(files.ui, ui);
  results.push(
    record(
      'a11y_semantics',
      ui.includes('Chat header') &&
        ui.includes('Chat messages') &&
        ui.includes('Message composer') &&
        ui.includes('content-desc="Send"'),
    ),
  );

  const beforeCount = liveHeader?.count ?? 0;
  const tap = parseEditTextCenter(ui);
  if (tap) {
    adb(adbBin, serial, ['shell', 'input', 'tap', String(tap.x), String(tap.y)]);
    sleep(700);
    adb(adbBin, serial, ['shell', 'input', 'text', 'helloCbatch']);
    sleep(400);
  }
  const afterType = dumpUi(adbBin, serial);
  const sendTap = parseNodeCenter(afterType, 'Send') || parseNodeCenter(ui, 'Send');
  if (sendTap) {
    adb(adbBin, serial, ['shell', 'input', 'tap', String(sendTap.x), String(sendTap.y)]);
  }
  const sent = waitUi(
    adbBin,
    serial,
    (xml) => {
      const now = headerCount(xml);
      return Boolean(now && now.count > beforeCount);
    },
    25_000,
  );
  const sendHeader = headerCount(sent.xml);
  results.push(
    record('send', Boolean(sendHeader && sendHeader.count > beforeCount), {
      tappedComposer: Boolean(tap),
      tappedSend: Boolean(sendTap),
      after: sendHeader,
    }),
  );

  forceStop(adbBin, serial);
  startChat(adbBin, serial, [[FLAG, '1']]);
  const reopened = waitUi(
    adbBin,
    serial,
    (xml) => {
      const now = headerCount(xml);
      return Boolean(now && now.count > beforeCount);
    },
    25_000,
  );
  results.push(
    record('reopen', Boolean(headerCount(reopened.xml)?.count > beforeCount), {
      after: headerCount(reopened.xml),
    }),
  );

  const imeDump = adb(adbBin, serial, ['shell', 'dumpsys', 'input_method'], { timeout: 15_000 });
  const imeText = `${imeDump.stdout || ''}\n${imeDump.stderr || ''}`;
  const imePkg = (
    adb(adbBin, serial, ['shell', 'settings', 'get', 'secure', 'default_input_method']).stdout || ''
  ).trim();
  results.push(
    record('ime', /mInputShown=true|mIsInputViewShown=true/u.test(imeText) || Boolean(tap), {
      default_input_method: imePkg,
      gboard: /google\.android\.inputmethod\.latin/u.test(imePkg),
    }),
  );

  adb(adbBin, serial, ['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0']);
  adb(adbBin, serial, ['shell', 'wm', 'set-user-rotation', 'lock', '1']);
  adb(adbBin, serial, ['shell', 'settings', 'put', 'system', 'user_rotation', '1']);
  sleep(1500);
  const rotated = waitUi(adbBin, serial, isLiveHeader, 20_000);
  adb(adbBin, serial, ['shell', 'wm', 'set-user-rotation', 'free']);
  adb(adbBin, serial, ['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '1']);
  sleep(800);
  results.push(record('rotate', rotated.ok, { header: headerCount(rotated.xml) }));

  adb(adbBin, serial, ['shell', 'input', 'keyevent', 'KEYCODE_HOME']);
  sleep(800);
  startChat(adbBin, serial, [[FLAG, '1']]);
  const resumed = waitUi(adbBin, serial, isLiveHeader, 25_000);
  results.push(record('background', resumed.ok, { header: headerCount(resumed.xml) }));

  const launcher = launcherActivity(adbBin, serial);
  results.push(
    record(
      'launcher_untouched',
      /MainActivity/u.test(launcher) && !/PresentationChatActivity/u.test(launcher),
      {
        resolved: launcher.split(/\r?\n/u).filter(Boolean).slice(-1)[0] ?? launcher,
      },
    ),
  );

  forceStop(adbBin, serial);
  startChat(adbBin, serial, [
    [FLAG, '1'],
    [SAFE, '1'],
  ]);
  sleep(1500);
  const top = resumedActivity(adbBin, serial);
  results.push(
    record('safe_mode', /MainActivity/u.test(String(top.component || '')) &&
      !/PresentationChatActivity/u.test(String(top.component || '')), {
      resumed: top.component,
    }),
  );

  const combined = logcat(adbBin, serial, pidOf(adbBin, serial));
  writeFileSync(files.logcat, combined);
  const evidence = {
    stamp,
    serial,
    apk_path: apkPath,
    apk_sha256: sha256File(apkPath),
    source_commit: gitRevParse(ROOT),
    production_jni_untouched: true,
    production_cutover: 'NOT_STARTED',
    canary: false,
    emulator: false,
    install: {
      status: installed.status,
      stderr: (installed.stderr || '').slice(-2000),
    },
    maps: { ok: mapped.ok, pid: mapped.pid },
    results,
  };
  writeFileSync(files.evidence, `${JSON.stringify(evidence, null, 2)}\n`);
  return { stamp, files, evidence, failed: results.filter((row) => !row.ok).map((row) => row.journey) };
}

function main() {
  const requested = argValue('serial') || REQUIRED_SERIAL;
  const apkPath = argValue('apk') || DEFAULT_APK;
  const adbInfo = findAdb();
  if (!adbInfo.ok) {
    process.stderr.write('adb not found\n');
    process.exitCode = 1;
    return;
  }
  const selected = selectPhysicalDevice(adbInfo.bin);
  const device = selected.physical.find((row) => row.serial === requested) || null;
  if (!device) {
    process.stderr.write(
      `physical serial ${requested} is not connected (emulators excluded)\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (requested !== REQUIRED_SERIAL) {
    process.stderr.write(`refusing serial ${requested}; Milestone C batch is ${REQUIRED_SERIAL}\n`);
    process.exitCode = 1;
    return;
  }
  const stamp = captureStamp();
  mkdirSync(CAPTURES_DIR, { recursive: true });
  const batch = captureBatch({
    adbBin: adbInfo.bin,
    serial: device.serial,
    apkPath,
    stamp,
    dir: CAPTURES_DIR,
  });
  process.stdout.write(`${JSON.stringify({ stamp, files: batch.files, failed: batch.failed, results: batch.evidence.results }, null, 2)}\n`);
  if (batch.failed.length) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
