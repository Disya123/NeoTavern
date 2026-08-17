#!/usr/bin/env node
/**
 * Immutable source bundle for the PRE-GATE M0-D1a probe (RFC §0.3.2 / §48).
 *
 * Writes gitignored files under apps/android/m0-d1a-captures/. Does not claim
 * D1a PASS, does not start D1b, and does not change production WebView.
 *
 *   node scripts/m0-d1a-source-bundle.mjs
 *   node scripts/m0-d1a-source-bundle.mjs --apk path/to/app-debug.apk
 *   node scripts/m0-d1a-source-bundle.mjs --stdout
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SCHEMA = 'm0-d1a-source-bundle/v1';
export const RFC_EDITION = '4.5';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = join(ROOT, 'apps', 'android', 'm0-d1a-captures');
const DEFAULT_APK = join(
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

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

export function parsePorcelain(text) {
  const entries = [];
  for (const raw of text.split(/\r?\n/u)) {
    if (!raw) continue;
    entries.push(raw);
  }
  return { dirty: entries.length > 0, entries };
}

export function buildBundleRecord(input) {
  return {
    schema: SCHEMA,
    rfc: RFC_EDITION,
    note: 'PRE-GATE; not an M0-D1a PASS; not Gate P; not Track D GO',
    program: {
      gate_p: 'UNDECIDED',
      normative_m0: 'NOT_ENTERED',
      runner_d1a: 'PRE-GATE / BLOCKED',
      d1b: 'NOT_STARTED',
      track_d_go: 'NOT_GRANTED',
    },
    base_commit: input.baseCommit,
    dirty: input.dirty,
    porcelain: input.porcelain,
    diff_sha256: input.diffSha256,
    diff_bytes: input.diffBytes,
    untracked_sha256: input.untrackedSha256 ?? null,
    lockfile_sha256: input.lockfileSha256,
    crate_toml_sha256: input.crateTomlSha256,
    submodule_status: input.submoduleStatus,
    apk_sha256: input.apkSha256,
    apk_path: input.apkPath,
    apk_bytes: input.apkBytes,
    rustc: input.rustc,
    cargo: input.cargo,
    runner: input.runner,
  };
}

function git(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error) {
    throw new Error(`git failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} exited ${result.status}: ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

function toolVersion(bin) {
  const result = spawnSync(bin, ['-V'], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return (result.stdout || '').trim();
}

function hashUntrackedFiles(paths) {
  const hash = createHash('sha256');
  const hashed = [];
  for (const rel of paths) {
    const normalized = rel.replace(/\\/gu, '/');
    const abs = join(ROOT, normalized);
    if (!existsSync(abs)) continue;
    const digest = sha256File(abs);
    hashed.push({ path: normalized, sha256: digest });
    hash.update(normalized);
    hash.update('\0');
    hash.update(digest);
    hash.update('\n');
  }
  return { sha256: hashed.length ? hash.digest('hex') : null, files: hashed };
}

function parseArgs(argv) {
  const out = { apk: null, stdout: false, outDir: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--apk' && next) {
      out.apk = resolve(next);
      i += 1;
    } else if (arg === '--out' && next) {
      out.outDir = resolve(next);
      i += 1;
    } else if (arg === '--stdout') {
      out.stdout = true;
    } else if (arg === '--help' || arg === '-h') {
      out.help = true;
    }
  }
  return out;
}

function collect(opts) {
  const baseCommit = git(['rev-parse', 'HEAD']).stdout.trim();
  const porcelainText = git(['status', '--porcelain']).stdout;
  const porcelain = parsePorcelain(porcelainText);
  const diff = git(['diff', '--binary', 'HEAD'], { encoding: 'buffer' }).stdout;
  const others = git(['ls-files', '--others', '--exclude-standard'])
    .stdout.split(/\r?\n/u)
    .filter(Boolean);
  const untracked = hashUntrackedFiles(others);
  let submoduleStatus = git(['submodule', 'status']).stdout.trim();
  if (!submoduleStatus) submoduleStatus = '(none)';
  const apkPath =
    opts.apk && existsSync(opts.apk) ? opts.apk : existsSync(DEFAULT_APK) ? DEFAULT_APK : null;
  return buildBundleRecord({
    baseCommit,
    dirty: porcelain.dirty,
    porcelain: porcelain.entries,
    diffSha256: sha256Bytes(diff),
    diffBytes: diff.length,
    untrackedSha256: untracked.sha256,
    lockfileSha256: sha256File(join(ROOT, 'crates', 'Cargo.lock')),
    crateTomlSha256: sha256File(join(ROOT, 'crates', 'presentation-m0', 'Cargo.toml')),
    submoduleStatus,
    apkSha256: apkPath ? sha256File(apkPath) : null,
    apkPath,
    apkBytes: apkPath ? readFileSync(apkPath).byteLength : null,
    rustc: toolVersion('rustc'),
    cargo: toolVersion('cargo'),
    runner: {
      probe_bin: 'm0-d1a-probe',
      crate: 'neotavern-presentation-m0',
      features: 'gpu',
      android_activity: 'com.neotavern.mobile/.M0D1aActivity',
      frames_default: 100,
    },
  });
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(`PRE-GATE M0-D1a source bundle (RFC ${RFC_EDITION}). Not a PASS.

  node scripts/m0-d1a-source-bundle.mjs [--apk <debug.apk>] [--out <dir>] [--stdout]
`);
    return;
  }
  const record = collect(opts);
  const text = `${JSON.stringify(record, null, 2)}\n`;
  if (opts.stdout) {
    process.stdout.write(text);
    return;
  }
  mkdirSync(opts.outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const jsonPath = join(opts.outDir, `${stamp}-source-bundle.json`);
  const patchPath = join(opts.outDir, `${stamp}.patch`);
  const diff = git(['diff', '--binary', 'HEAD'], { encoding: 'buffer' }).stdout;
  writeFileSync(jsonPath, text);
  writeFileSync(patchPath, diff);
  const extra = hashUntrackedFiles(
    git(['ls-files', '--others', '--exclude-standard']).stdout.split(/\r?\n/u).filter(Boolean),
  );
  writeFileSync(
    join(opts.outDir, `${stamp}-untracked.json`),
    `${JSON.stringify(extra, null, 2)}\n`,
  );
  console.log(`[m0-d1a-bundle] wrote ${jsonPath}`);
  console.log(`[m0-d1a-bundle] wrote ${patchPath}`);
  console.log(
    `[m0-d1a-bundle] base=${record.base_commit} dirty=${record.dirty} apk=${record.apk_sha256 ?? 'absent'}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (err) {
    console.error(`[m0-d1a-bundle] ${err.message}`);
    process.exit(1);
  }
}
