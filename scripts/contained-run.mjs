#!/usr/bin/env node
/**
 * Contained heavy-workload runner (plan rev 2.2 Layer A/B): serializes heavy
 * commands through the native `resource-runner` (Windows Job Object with
 * two-threshold memory control, host-headroom gate, wall-clock deadline,
 * named-mutex scheduler) and refuses to run heavy stages uncontained.
 *
 * Usage:
 * ```text
 * node scripts/contained-run.mjs [--cap <MiB>] [--min-cap <MiB>]
 *     [--deadline <secs>] [--lock <name>] -- <command...>
 * ```
 *
 * Exit codes are forwarded from `resource-runner` (see crates/resource-runner
 * README): 3 = SKIPPED (insufficient host memory), 4 = RESOURCE_LIMIT,
 * 5 = BUSY (another heavy command is running), 6 = TIMEOUT.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

const USAGE = `usage: contained-run.mjs [--cap MiB] [--min-cap MiB] [--deadline secs] [--lock name] -- <command...>`;

function findRunner() {
  const candidates = [
    join(root, 'crates', 'target', 'release', 'resource-runner.exe'),
    join(root, 'crates', 'target', 'debug', 'resource-runner.exe'),
    join(root, 'target', 'release', 'resource-runner.exe'),
    join(root, 'target', 'debug', 'resource-runner.exe'),
  ];
  return candidates.find(existsSync) ?? null;
}

function parseArgs(argv) {
  const opts = { cap: undefined, minCap: undefined, deadline: undefined, lock: undefined };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') {
      return { opts, cmd: argv.slice(i + 1) };
    }
    const take = (name) => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${name} requires a value`);
      i += 1;
      return v;
    };
    if (a === '--cap') opts.cap = Number(take(a));
    else if (a === '--min-cap') opts.minCap = Number(take(a));
    else if (a === '--deadline') opts.deadline = Number(take(a));
    else if (a === '--lock') opts.lock = take(a);
    else throw new Error(`unknown option ${a}\n${USAGE}`);
    i += 1;
  }
  throw new Error(`missing -- separator\n${USAGE}`);
}

function main() {
  const { opts, cmd } = parseArgs(process.argv.slice(2));
  if (cmd.length === 0) throw new Error(`empty command\n${USAGE}`);

  const runner = findRunner();
  if (!runner) {
    console.error(
      'contained-run: resource-runner binary not found; build it first:\n' +
        '  cargo build --manifest-path crates\\Cargo.toml -p resource-runner --release',
    );
    process.exit(2);
  }

  if (process.platform !== 'win32') {
    console.error(
      'contained-run: Job Object containment is Windows-only; on this platform the ' +
        'command would run UNCONTAINED. Refusing (run the suite directly on CI only ' +
        'when the runner is not involved).',
    );
    process.exit(2);
  }

  // Options FIRST, then --cmd last (the runner treats everything after
  // --cmd as the command tokens).
  const runnerArgs = [];
  if (opts.cap !== undefined) runnerArgs.push('--cap', String(opts.cap));
  if (opts.minCap !== undefined) runnerArgs.push('--min-cap', String(opts.minCap));
  if (opts.deadline !== undefined) runnerArgs.push('--deadline', String(opts.deadline));
  if (opts.lock !== undefined) runnerArgs.push('--lock', opts.lock);
  runnerArgs.push('--cmd', ...cmd);

  const child = spawn(runner, runnerArgs, {
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, RESOURCE_BUDGET_MODE: 'contained' },
  });
  child.on('error', (err) => {
    console.error(`contained-run: cannot spawn ${runner}: ${err.message}`);
    process.exit(2);
  });
  child.on('close', (code) => process.exit(code ?? 2));
}

main();
