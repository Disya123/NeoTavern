#!/usr/bin/env node
/**
 * Physical Xiaomi Milestone C journey batch.
 * Emulators are excluded. Default serial is 8f5c2b7c. Does not stamp C PASS.
 *
 * Gboard is driven by tapping Gboard keys, not adb input text / Espresso
 * typeText / a direct InputConnection call. TalkBack is not enabled in this
 * batch (operator skipped).
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
export const PROFILE = `${PACKAGE}.NEOTA_CHAT_PROFILE`;
export const GBOARD_PACKAGE = 'com.google.android.inputmethod.latin';
export const MARKERS_REL = 'files/neotavern-journey-markers.txt';
export const JOURNEYS = [
  'flag_off',
  'live_open',
  'jni_mapped',
  'a11y_semantics',
  'gboard_journey',
  'send',
  'reopen',
  'isolated_10k',
  'rotate',
  'background',
  'talkback_journey',
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

function parseNodeCenterIncludes(xml, snippet) {
  const nodes = xml.split('<node ');
  for (const node of nodes) {
    const desc = /content-desc="([^"]*)"/u.exec(node);
    if (!desc || !desc[1].includes(snippet)) continue;
    const hit = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/u.exec(node);
    if (!hit) continue;
    return {
      x: Math.floor((Number(hit[1]) + Number(hit[3])) / 2),
      y: Math.floor((Number(hit[2]) + Number(hit[4])) / 2),
      desc: desc[1],
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

function getSecure(adbBin, serial, key) {
  return (adb(adbBin, serial, ['shell', 'settings', 'get', 'secure', key]).stdout || '')
    .trim()
    .replace(/^null$/u, '');
}

function putSecure(adbBin, serial, key, value) {
  if (!value) {
    adb(adbBin, serial, ['shell', 'settings', 'delete', 'secure', key]);
    return;
  }
  adb(adbBin, serial, ['shell', 'settings', 'put', 'secure', key, value]);
}

function screenSize(adbBin, serial) {
  const text = adb(adbBin, serial, ['shell', 'wm', 'size']).stdout || '';
  const hit = /Physical size: (\d+)x(\d+)/u.exec(text);
  return hit ? { w: Number(hit[1]), h: Number(hit[2]) } : { w: 1220, h: 2712 };
}

function imeWindowHeight(adbBin, serial) {
  const win = `${adb(adbBin, serial, ['shell', 'dumpsys', 'window'], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }).stdout || ''}`;
  const visible = /mInputMethodWindowVisibleHeight=(\d+)/.exec(win);
  if (visible) {
    const height = Number(visible[1]);
    if (height >= 400) return height;
  }
  return 0;
}

function imeDump(adbBin, serial) {
  return `${adb(adbBin, serial, ['shell', 'dumpsys', 'input_method'], { timeout: 15_000 }).stdout || ''}`;
}

function waitImeShown(adbBin, serial, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let height = 0;
  while (Date.now() < deadline) {
    const dump = imeDump(adbBin, serial);
    height = imeWindowHeight(adbBin, serial);
    if (/mInputShown=true/u.test(dump) && height >= 400) {
      return { ok: true, height };
    }
    sleep(400);
  }
  return { ok: false, height };
}

function journeyBroadcast(adbBin, serial, action) {
  adb(adbBin, serial, [
    'shell',
    'am',
    'broadcast',
    '-n',
    `${PACKAGE}/.PresentationChatA11yReceiver`,
    '-a',
    'com.neotavern.mobile.NEOTA_CHAT_A11Y',
    '--es',
    'action',
    action,
  ]);
}

function readMarkers(adbBin, serial) {
  const out = adb(adbBin, serial, ['exec-out', 'run-as', PACKAGE, 'cat', MARKERS_REL], {
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return `${out.stdout || ''}`;
}

function clearMarkers(adbBin, serial) {
  adb(adbBin, serial, ['exec-out', 'run-as', PACKAGE, 'rm', '-f', MARKERS_REL], { timeout: 10_000 });
}

function waitMarkers(adbBin, serial, pred, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    text = readMarkers(adbBin, serial);
    if (pred(text)) return { ok: true, text };
    sleep(350);
  }
  return { ok: false, text };
}

function waitAddedMarkers(adbBin, serial, previous, pred, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let text = previous;
  while (Date.now() < deadline) {
    text = readMarkers(adbBin, serial);
    const added = text.length >= previous.length ? text.slice(previous.length) : text;
    if (pred(added)) return { ok: true, text };
    sleep(350);
  }
  return { ok: false, text };
}

function parseLabeledCenter(xml, label) {
  const nodes = xml.split('<node ');
  for (const node of nodes) {
    const desc = /content-desc="([^"]*)"/u.exec(node);
    const text = /text="([^"]*)"/u.exec(node);
    const value = `${desc ? desc[1] : ''} ${text ? text[1] : ''}`;
    if (!value.toLowerCase().includes(label.toLowerCase())) continue;
    const hit = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/u.exec(node);
    if (!hit) continue;
    return {
      x: Math.floor((Number(hit[1]) + Number(hit[3])) / 2),
      y: Math.floor((Number(hit[2]) + Number(hit[4])) / 2),
      label: value.trim(),
    };
  }
  return null;
}

function tap(adbBin, serial, x, y) {
  adb(adbBin, serial, ['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))]);
}

function parseLatinKeys(xml) {
  const keys = [];
  for (const chunk of xml.split('<node ')) {
    if (!chunk.includes(GBOARD_PACKAGE) && !chunk.includes('inputmethod.latin')) continue;
    const descHit = /content-desc="([^"]*)"/u.exec(chunk);
    const bounds = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/u.exec(chunk);
    if (!bounds) continue;
    const x1 = Number(bounds[1]);
    const y1 = Number(bounds[2]);
    const x2 = Number(bounds[3]);
    const y2 = Number(bounds[4]);
    if (x2 - x1 < 24 || y2 - y1 < 24) continue;
    keys.push({
      desc: descHit ? descHit[1] : '',
      x: Math.floor((x1 + x2) / 2),
      y: Math.floor((y1 + y2) / 2),
    });
  }
  return keys;
}

function gboardGrid(size, inset) {
  const top = Math.max(0, size.h - inset);
  const h = Math.max(inset, 1);
  const w = size.w;
  const keyW = w / 10;
  const lettersY = top + h * 0.38;
  return {
    letters: [1.5, 2.6, 3.7, 4.8].map((i) => ({ x: keyW * i, y: lettersY })),
    backspace: { x: w - keyW * 0.7, y: top + h * 0.62 },
    space: { x: w * 0.5, y: top + h * 0.88 },
    send: { x: w - keyW * 0.55, y: top + h * 0.88 },
    globe: { x: keyW * 1.15, y: top + h * 0.88 },
  };
}

function tapGboardLetters(adbBin, serial, keys, grid) {
  const letters = keys.filter((key) => key.desc.length === 1);
  const targets = letters.length >= 3 ? letters.slice(0, 4) : grid.letters;
  for (const point of targets) {
    tap(adbBin, serial, point.x, point.y);
    sleep(180);
  }
}

function findKey(keys, pattern) {
  return keys.find((key) => pattern.test(key.desc)) || null;
}

function driveGboard(adbBin, serial, size) {
  const xml = dumpUi(adbBin, serial);
  const composer = parseEditTextCenter(xml) || parseNodeCenterIncludes(xml, 'Message composer');
  if (!composer) {
    return { ok: false, reason: 'composer_missing', markers: readMarkers(adbBin, serial) };
  }
  journeyBroadcast(adbBin, serial, 'clear_composer');
  sleep(400);
  tap(adbBin, serial, composer.x, composer.y);
  sleep(500);
  let shown = waitImeShown(adbBin, serial, 8_000);
  if (!shown.ok) {
    tap(adbBin, serial, composer.x, composer.y);
    shown = waitImeShown(adbBin, serial, 8_000);
  }
  waitMarkers(
    adbBin,
    serial,
    (text) => {
      const hit = [...text.matchAll(/gboard_ime inset_show px=(\d+)/gu)].pop();
      return Boolean(hit && Number(hit[1]) >= 200);
    },
    8_000,
  );
  const afterFocus = dumpUi(adbBin, serial);
  let keys = parseLatinKeys(afterFocus);
  const markers0 = readMarkers(adbBin, serial);
  const insetHit = [...markers0.matchAll(/gboard_ime inset_show px=(\d+)/gu)].pop();
  const markerInset = insetHit ? Number(insetHit[1]) : 0;
  const inset =
    shown.height >= 400 ? shown.height : markerInset >= 400 ? markerInset : 0;
  if (inset < 400) {
    return {
      ok: false,
      reason: 'ime_not_shown',
      driver: 'gboard_keys',
      ime_shown: false,
      ime_height: shown.height,
      latin_keys: keys.length,
      markers: markers0,
    };
  }
  const grid = gboardGrid(size, inset);
  const alphabet = parseLabeledCenter(afterFocus, 'Alphabet');
  if (alphabet) {
    tap(adbBin, serial, alphabet.x, alphabet.y);
    sleep(700);
  }
  keys = parseLatinKeys(dumpUi(adbBin, serial));
  let beforeAction = readMarkers(adbBin, serial);
  tapGboardLetters(adbBin, serial, keys, grid);
  let composing = waitAddedMarkers(
    adbBin,
    serial,
    beforeAction,
    (text) => /gboard_ic action=setComposingText\b/u.test(text),
    4_000,
  );
  if (!composing.ok) {
    tap(adbBin, serial, grid.globe.x, grid.globe.y);
    sleep(700);
    const picker = dumpUi(adbBin, serial);
    const picked =
      parseLabeledCenter(picker, 'Alphabet') || parseLabeledCenter(picker, 'English');
    if (picked) {
      tap(adbBin, serial, picked.x, picked.y);
      sleep(700);
    }
    keys = parseLatinKeys(dumpUi(adbBin, serial));
    beforeAction = readMarkers(adbBin, serial);
    tapGboardLetters(adbBin, serial, keys, grid);
    composing = waitAddedMarkers(
      adbBin,
      serial,
      beforeAction,
      (text) => /gboard_ic action=setComposingText\b/u.test(text),
      4_000,
    );
  }
  const space = findKey(keys, /space/iu) || grid.space;
  beforeAction = readMarkers(adbBin, serial);
  tap(adbBin, serial, space.x, space.y);
  waitAddedMarkers(
    adbBin,
    serial,
    beforeAction,
    (text) => /gboard_ic action=commitText\b/u.test(text),
    4_000,
  );
  const del = findKey(keys, /delete|backspace/iu) || grid.backspace;
  beforeAction = readMarkers(adbBin, serial);
  tap(adbBin, serial, del.x, del.y);
  waitAddedMarkers(
    adbBin,
    serial,
    beforeAction,
    (text) => /gboard_ic action=deleteSurroundingText\b/u.test(text),
    4_000,
  );
  beforeAction = readMarkers(adbBin, serial);
  tapGboardLetters(adbBin, serial, keys, grid);
  waitAddedMarkers(
    adbBin,
    serial,
    beforeAction,
    (text) =>
      /gboard_ic action=setComposingText\b/u.test(text) ||
      /gboard_ic action=commitText\b/u.test(text),
    4_000,
  );
  const sendKey =
    findKey(keys, /^(send|enter|go|done)$/iu) ||
    findKey(keys, /send|enter/iu) ||
    grid.send;
  const sendTargets = [
    sendKey,
    { x: sendKey.x, y: sendKey.y - 36 },
    { x: size.w - 56, y: size.h - inset * 0.12 },
    { x: size.w - 40, y: grid.send.y },
  ];
  let editor = { ok: false, text: '' };
  for (const point of sendTargets) {
    beforeAction = readMarkers(adbBin, serial);
    tap(adbBin, serial, point.x, point.y);
    editor = waitAddedMarkers(
      adbBin,
      serial,
      beforeAction,
      (text) => /gboard_ic action=performEditorAction code=SEND\b/u.test(text),
      3_000,
    );
    if (editor.ok) break;
  }
  const before = headerCount(xml)?.count ?? 0;
  const sent = waitUi(
    adbBin,
    serial,
    (nowXml) => {
      const now = headerCount(nowXml);
      return Boolean(now && now.count > before);
    },
    25_000,
  );
  if (!/gboard_ime inset_hide\b/u.test(readMarkers(adbBin, serial))) {
    adb(adbBin, serial, ['shell', 'input', 'keyevent', 'KEYCODE_BACK']);
    waitMarkers(adbBin, serial, (text) => /gboard_ime inset_hide\b/u.test(text), 4_000);
  }
  const markers = readMarkers(adbBin, serial);
  const sendCount = (markers.match(/gboard_ic action=performEditorAction code=SEND\b/gu) || []).length;
  const sendHeader = headerCount(sent.xml);
  return {
    ok: Boolean(
      shown.ok &&
        sendHeader &&
        sendHeader.count > before &&
        /gboard_ic action=commitText\b/u.test(markers) &&
        /gboard_ic action=deleteSurroundingText\b/u.test(markers) &&
        /gboard_ic action=performEditorAction code=SEND\b/u.test(markers),
    ),
    driver: 'gboard_keys',
    default_input_method: getSecure(adbBin, serial, 'default_input_method'),
    ime_shown: shown.ok,
    ime_height: inset,
    sendOnce: sendCount === 1,
    after: sendHeader,
    before,
    latin_keys: keys.length,
    markers,
  };
}

function lastComposingStuck(markers) {
  const matches = [...markers.matchAll(/gboard_ic action=lifecycle_resume composing=(true|false)/gu)];
  if (!matches.length) return true;
  return matches[matches.length - 1][1] === 'true';
}

function restoreA11y(adbBin, serial, original) {
  putSecure(adbBin, serial, 'enabled_accessibility_services', original.services);
  putSecure(adbBin, serial, 'accessibility_enabled', original.enabled || '0');
  if (Object.prototype.hasOwnProperty.call(original, 'touchExplorationGranted')) {
    putSecure(
      adbBin,
      serial,
      'touch_exploration_granted_accessibility_services',
      original.touchExplorationGranted,
    );
  }
  sleep(800);
  const services = getSecure(adbBin, serial, 'enabled_accessibility_services');
  const enabled = getSecure(adbBin, serial, 'accessibility_enabled');
  return (
    services === original.services &&
    (enabled === (original.enabled || '0') || (!original.services && enabled === '0'))
  );
}

function captureBatch({ adbBin, serial, apkPath, stamp, dir }) {
  adb(adbBin, serial, ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
  adb(adbBin, serial, ['shell', 'wm', 'dismiss-keyguard']);
  adb(adbBin, serial, ['shell', 'svc', 'power', 'stayon', 'true']);
  const a11yOriginal = {
    services: getSecure(adbBin, serial, 'enabled_accessibility_services'),
    enabled: getSecure(adbBin, serial, 'accessibility_enabled') || '0',
    touchExplorationGranted: getSecure(
      adbBin,
      serial,
      'touch_exploration_granted_accessibility_services',
    ),
  };
  const installed = adb(adbBin, serial, ['install', '-r', '-g', apkPath], { timeout: 300_000 });
  const results = [];
  const files = {
    logcat: join(dir, `${stamp}-logcat.txt`),
    ui: join(dir, `${stamp}-ui.xml`),
    evidence: join(dir, `${stamp}-evidence.json`),
  };
  const size = screenSize(adbBin, serial);

  try {
    adb(adbBin, serial, ['logcat', '-c']);
    forceStop(adbBin, serial);
    startChat(adbBin, serial, []);
    const flagOff = waitUi(adbBin, serial, isFlagOffUi, 20_000);
    results.push(record('flag_off', flagOff.ok));

    forceStop(adbBin, serial);
    clearMarkers(adbBin, serial);
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

    const imePkg = getSecure(adbBin, serial, 'default_input_method');
    const gboard = driveGboard(adbBin, serial, size);
    const sendOk = Boolean(gboard.after && gboard.after.count > (liveHeader?.count ?? 0));
    results.push(
      record('send', sendOk, {
        driver: 'gboard_keys',
        tappedComposer: true,
        tappedSend: false,
        after: gboard.after,
      }),
    );

    forceStop(adbBin, serial);
    startChat(adbBin, serial, [[FLAG, '1']]);
    const reopened = waitUi(
      adbBin,
      serial,
      (xml) => {
        const now = headerCount(xml);
        return Boolean(now && now.count > (liveHeader?.count ?? 0));
      },
      25_000,
    );
    results.push(
      record('reopen', Boolean(headerCount(reopened.xml)?.count > (liveHeader?.count ?? 0)), {
        after: headerCount(reopened.xml),
      }),
    );

    results.push(
      record('ime', /google\.android\.inputmethod\.latin/u.test(imePkg), {
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

    const afterLifecycle = readMarkers(adbBin, serial);
    const composingStuck = lastComposingStuck(afterLifecycle);
    results.push(
      record('gboard_journey', Boolean(gboard.ok && sendOk && gboard.sendOnce && !composingStuck), {
        driver: 'gboard_keys',
        default_input_method: imePkg,
        sendOnce: gboard.sendOnce,
        composingStuckAfterLifecycle: composingStuck,
        ime_shown: gboard.ime_shown,
        latin_keys: gboard.latin_keys,
        markers: afterLifecycle,
      }),
    );

    forceStop(adbBin, serial);
    startChat(adbBin, serial, [
      [FLAG, '1'],
      [PROFILE, 'isolated-10k'],
    ]);
    const isolated = waitUi(
      adbBin,
      serial,
      (xml) => {
        const now = headerCount(xml);
        return Boolean(now && now.title === 'Isolated 10k' && now.count === 10_000);
      },
      180_000,
    );
    const isolatedHeader = headerCount(isolated.xml);
    if (isolated.ok) {
      adb(adbBin, serial, ['shell', 'input', 'swipe', '540', '400', '540', '1400', '400']);
      sleep(800);
    }
    const afterScroll = isolated.ok ? dumpUi(adbBin, serial) : isolated.xml;
    results.push(
      record('isolated_10k', Boolean(isolatedHeader && isolatedHeader.count === 10_000), {
        header: isolatedHeader,
        scrolled: isolated.ok,
        viewportHasOldest:
          /content-desc="Chat messages"[\s\S]*msg 0/u.test(afterScroll) ||
          /content-desc="Chat messages"[\s\S]*\*\*msg 0\*\*/u.test(afterScroll),
      }),
    );

    results.push(
      record('talkback_journey', false, {
        skipped: true,
        operator_waived: true,
        talkbackEnabled: false,
        reason: 'operator_skipped',
      }),
    );

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
      record(
        'safe_mode',
        /MainActivity/u.test(String(top.component || '')) &&
          !/PresentationChatActivity/u.test(String(top.component || '')),
        {
          resumed: top.component,
        },
      ),
    );

    const combined = `${logcat(adbBin, serial, pidOf(adbBin, serial))}\n${readMarkers(adbBin, serial)}`;
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
    return { stamp, files, evidence, failed: results.filter((row) => !row.ok && !row.skipped).map((row) => row.journey) };
  } finally {
    restoreA11y(adbBin, serial, a11yOriginal);
    adb(adbBin, serial, ['shell', 'wm', 'set-user-rotation', 'free']);
    adb(adbBin, serial, ['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '1']);
  }
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
