import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';

// Runs the packaged kernel self-smoke against the latest portable bundle.
// Usage: node tools/portable-smoke.mjs
const portableRoot =
  'E:/AI/Work/NeoTavern/apps/desktop/src-tauri/target/release/bundle/portable/NeoTavern_0.1.0_x64-portable';
const dataDir = portableRoot + '/data';
await rm(dataDir, { recursive: true, force: true });

const child = spawn(portableRoot + '/NeoTavern.exe', [], {
  cwd: portableRoot,
  windowsHide: true,
  env: { ...process.env, NEOTA_DESKTOP_SMOKE: '1', NEOTA_KERNEL: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (c) => (stderr += c));

const exitCode = await new Promise((resolvePromise, rejectPromise) => {
  const timer = setTimeout(() => {
    child.kill();
    rejectPromise(new Error('did not exit within 40s'));
  }, 40_000);
  child.once('exit', (code) => {
    clearTimeout(timer);
    resolvePromise(code);
  });
  child.once('error', (e) => rejectPromise(e));
});
console.log('exitCode=', exitCode);
console.log(
  stderr
    .split('\n')
    .filter((l) => l.includes('[smoke]'))
    .join('\n'),
);
const fail = stderr.split('\n').find((l) => l.includes('FAILED') || l.includes('envelope'));
if (fail) console.log('FAIL LINE:', fail);
process.exit(exitCode === 0 ? 0 : 1);
