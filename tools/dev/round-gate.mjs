#!/usr/bin/env node
/**
 * One command for the "round gate" — the checks every slice must pass before it
 * is committed — so a round does not depend on remembering the right incantation
 * (and on this box: on a working `pnpm`, which it is not, see tools/dev/pnpm.mjs).
 *
 * Fast gate (default, minutes):
 *   1. wire contract in sync            node tools/contract-codegen/codegen.mjs --check
 *   2. every op has a dispatch arm      node scripts/check-kernel-dispatch.mjs
 *   3. rust formatting                  cargo fmt --check (kernel + storage)
 *   4. targeted kernel tests            cargo test -p runtime-kernel --test <suite>...
 *   5. typescript build + web types     tsc -b + tsc --noEmit (web)
 *   6. formatting of touched files      prettier --check (git diff vs HEAD)
 *
 * `--full` additionally runs the whole `cargo test -p runtime-kernel`, the web
 * vitest suite and `docs:check` — the pre-merge gate.
 *
 * Usage:
 *   node tools/dev/round-gate.mjs --cargo-test plugin_blobs --web src/api
 *   node tools/dev/round-gate.mjs --full
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const isWindows = process.platform === 'win32';

const args = process.argv.slice(2);
const full = args.includes('--full');
const cargoTests = [];
const webTests = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--cargo-test' && args[index + 1] !== undefined) {
    cargoTests.push(args[index + 1]);
    index += 1;
  } else if (args[index] === '--web' && args[index + 1] !== undefined) {
    webTests.push(args[index + 1]);
    index += 1;
  }
}

const failures = [];

function run(label, command, commandArgs, options = {}) {
  process.stdout.write(`\n[gate] ${label}\n`);
  const started = Date.now();
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? ROOT,
    stdio: 'inherit',
    shell: isWindows && command.endsWith('.cmd'),
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.error) {
    failures.push(`${label}: ${result.error.message}`);
    process.stdout.write(`[gate] FAIL ${label} (${seconds}s)\n`);
    return false;
  }
  if ((result.status ?? 1) !== 0) {
    failures.push(`${label}: exit ${result.status}`);
    process.stdout.write(`[gate] FAIL ${label} (${seconds}s)\n`);
    return false;
  }
  process.stdout.write(`[gate] ok ${label} (${seconds}s)\n`);
  return true;
}

function node(script, scriptArgs = []) {
  return ['node', [script, ...scriptArgs]];
}

/** Changed files vs HEAD, restricted to what prettier can format. */
function changedFormattableFiles() {
  const diff = spawnSync('git', ['diff', '--name-only', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const lines = `${diff.stdout ?? ''}\n${untracked.stdout ?? ''}`
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => /\.(ts|tsx|js|mjs|cjs|json|md|css|ya?ml)$/u.test(line));
  return [...new Set(lines)];
}

// ── 1-3: cheap static gates -------------------------------------------------
run('contracts in sync', ...node('tools/contract-codegen/codegen.mjs', ['--check']));
run('kernel dispatch arms', ...node('scripts/check-kernel-dispatch.mjs'));
run(
  'rust formatting',
  'cargo',
  ['fmt', '-p', 'runtime-kernel', '-p', 'neotavern-storage', '--', '--check'],
  { cwd: resolve(ROOT, 'crates') },
);

// ── 4: kernel tests ---------------------------------------------------------
// nextest runs test binaries in parallel and is typically 3-5x faster than
// `cargo test` on this suite; fall back to cargo test when it is not installed
// so a fresh machine can still gate.
const hasNextest = (() => {
  const probe = spawnSync('cargo', ['nextest', '--version'], { encoding: 'utf8' });
  return probe.status === 0;
})();
const kernelRunner = hasNextest
  ? (args) => ['cargo', ['nextest', 'run', '-p', 'runtime-kernel', ...args]]
  : (args) => ['cargo', ['test', '-p', 'runtime-kernel', ...args]];

if (full) {
  run('kernel tests (full)', ...kernelRunner([]), {
    cwd: resolve(ROOT, 'crates'),
  });
} else if (cargoTests.length === 0) {
  process.stdout.write('\n[gate] no --cargo-test suites requested; skipping kernel tests\n');
} else {
  for (const suite of cargoTests) {
    run(`kernel test ${suite}`, ...kernelRunner(['--test', suite]), {
      cwd: resolve(ROOT, 'crates'),
    });
  }
}

// ── 5: typescript -----------------------------------------------------------
run('tsc build', ...node('node_modules/typescript/bin/tsc', ['-b', 'tsconfig.build.json']));
run('web typecheck', ...node('node_modules/typescript/bin/tsc', ['--noEmit']), {
  cwd: resolve(ROOT, 'apps/web'),
});
run('ui typecheck', ...node('node_modules/typescript/bin/tsc', ['--noEmit']), {
  cwd: resolve(ROOT, 'packages/ui'),
});

// ── 6: formatting of touched files -----------------------------------------
const touched = changedFormattableFiles();
if (touched.length > 0) {
  run(
    'prettier (touched files)',
    ...node('node_modules/prettier/bin/prettier.cjs', ['--check', ...touched]),
  );
}

// ── 7: optional full gates --------------------------------------------------
if (full) {
  if (existsSync(resolve(ROOT, 'apps/web/package.json'))) {
    run('web tests (full)', ...node('node_modules/vitest/vitest.mjs', ['run']), {
      cwd: resolve(ROOT, 'apps/web'),
    });
  }
  run('docs check', ...node('scripts/docs-check.mjs'));
}

// ── summary -----------------------------------------------------------------
if (failures.length > 0) {
  process.stdout.write(
    `\n[gate] FAILED (${failures.length}):\n${failures.map((row) => `  - ${row}`).join('\n')}\n`,
  );
  process.exit(1);
}
process.stdout.write('\n[gate] all requested gates passed\n');
