#!/usr/bin/env node
/**
 * One probe run of the desktop host for the interaction audit: launches the
 * bin with the given args, waits for the `--snapshot` PNG to stabilize, then
 * kills the process tree (the host keeps its event loop alive by design).
 *
 *   node scripts/probe-host.mjs -- <bin args...>
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const bin = resolve(import.meta.dirname, '..', 'crates', 'target', 'release', 'neocompositor-desktop.exe');
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('usage: node scripts/probe-host.mjs -- <bin args>');
  process.exit(2);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
let err = '';
child.stdout.on('data', (chunk) => (out += chunk));
child.stderr.on('data', (chunk) => (err += chunk));
const snapshotAt = args.indexOf('--snapshot');
const expect = snapshotAt === -1 ? null : args[snapshotAt + 1];
const startedAt = expect && existsSync(expect) ? statSync(expect).mtimeMs : Number.NEGATIVE_INFINITY;
const deadline = Date.now() + 120_000;
let stable = -1;
try {
  while (Date.now() < deadline) {
    if (expect && existsSync(expect)) {
      const stats = statSync(expect);
      if (stats.mtimeMs > startedAt && stats.size > 0 && stats.size === stable) break;
      stable = stats.size;
    }
    if (child.exitCode !== null) break;
    sleepSync(150);
  }
} finally {
  if (child.exitCode === null) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  }
}
sleepSync(250);
console.log(out.trim());
if (err.trim()) console.error(err.trim());
