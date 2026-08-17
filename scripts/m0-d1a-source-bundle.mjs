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

export const SCHEMA = 'm0-d1a-source-bundle/v2';
export const RFC_EDITION = '4.5';

/** RFC 0.5 root TZ copy — not part of the D1a evidence tree. */
export const UNRELATED_PATH_EXCLUDES = ['Техническое задание_ NeoUI v4.md'];

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = join(ROOT, 'apps', 'android', 'm0-d1a-captures');

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

export function decodeGitCQuotedPath(rel) {
  let text = rel.trim();
  const quoted = text.startsWith('"') && text.endsWith('"');
  if (quoted) {
    text = text.slice(1, -1);
  }
  if (!text.includes('\\')) {
    return text.replace(/\\/gu, '/');
  }
  const bytes = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '\\') {
      bytes.push(text.charCodeAt(i));
      continue;
    }
    const oct = text.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/u.test(oct)) {
      bytes.push(Number.parseInt(oct, 8));
      i += 3;
      continue;
    }
    const next = text[i + 1];
    if (next === '\\') {
      bytes.push(0x5c);
      i += 1;
      continue;
    }
    if (next === '"') {
      bytes.push(0x22);
      i += 1;
      continue;
    }
    if (next === 'n') {
      bytes.push(0x0a);
      i += 1;
      continue;
    }
    if (next === 't') {
      bytes.push(0x09);
      i += 1;
      continue;
    }
    bytes.push(text.charCodeAt(i));
  }
  return Buffer.from(bytes).toString('utf8');
}

export function normalizeRelPath(rel) {
  return decodeGitCQuotedPath(rel);
}

export function porcelainPath(line) {
  return normalizeRelPath(line.slice(3));
}

export function isUnrelatedPath(rel, excludes = UNRELATED_PATH_EXCLUDES) {
  const normalized = normalizeRelPath(rel);
  const base = normalized.split('/').pop();
  return excludes.some((ex) => normalized === ex || normalized.endsWith(`/${ex}`) || base === ex);
}

export function classifyEvidenceTree(
  porcelainEntries,
  untrackedPaths,
  excludes = UNRELATED_PATH_EXCLUDES,
) {
  const excluded = [];
  const remainingPorcelain = [];
  for (const line of porcelainEntries) {
    const rel = porcelainPath(line);
    if (isUnrelatedPath(rel, excludes)) {
      excluded.push(rel);
    } else {
      remainingPorcelain.push(line);
    }
  }
  const remainingUntracked = [];
  for (const rel of untrackedPaths) {
    if (isUnrelatedPath(rel, excludes)) {
      if (!excluded.includes(normalizeRelPath(rel))) {
        excluded.push(normalizeRelPath(rel));
      }
    } else {
      remainingUntracked.push(rel);
    }
  }
  return {
    excluded_unrelated_paths: [...new Set(excluded)],
    evidence_dirty: remainingPorcelain.length > 0 || remainingUntracked.length > 0,
    remaining_porcelain: remainingPorcelain,
    remaining_untracked: remainingUntracked,
  };
}

export function classifyApkLinkage(apkPath, observational) {
  if (!apkPath) {
    return {
      apk_sha256: null,
      apk_observational_sha256: null,
      apk_linkage: 'UNBOUND',
      apk_linkage_reason: 'no APK built from this source bundle',
    };
  }
  if (observational) {
    return {
      apk_sha256: null,
      apk_observational_sha256: sha256File(apkPath),
      apk_linkage: 'UNBOUND',
      apk_linkage_reason:
        'pulled/installed APK is not a build of this source bundle; do not cite as matching evidence',
    };
  }
  return {
    apk_sha256: sha256File(apkPath),
    apk_observational_sha256: null,
    apk_linkage: 'BOUND',
    apk_linkage_reason: 'APK path is the assembleDebug output of this tree',
  };
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
    evidence_dirty: input.evidenceDirty ?? input.dirty,
    excluded_unrelated_paths: input.excludedUnrelatedPaths ?? [],
    porcelain: input.porcelain,
    diff_sha256: input.diffSha256,
    diff_bytes: input.diffBytes,
    untracked_sha256: input.untrackedSha256 ?? null,
    lockfile_sha256: input.lockfileSha256,
    crate_toml_sha256: input.crateTomlSha256,
    submodule_status: input.submoduleStatus,
    apk_sha256: input.apkSha256,
    apk_observational_sha256: input.apkObservationalSha256 ?? null,
    apk_path: input.apkPath,
    apk_bytes: input.apkBytes,
    apk_linkage: input.apkLinkage ?? 'UNBOUND',
    apk_linkage_reason: input.apkLinkageReason ?? 'not classified',
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
  const out = { apk: null, stdout: false, outDir: DEFAULT_OUT, bindApk: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--apk' && next) {
      out.apk = resolve(next);
      i += 1;
    } else if (arg === '--out' && next) {
      out.outDir = resolve(next);
      i += 1;
    } else if (arg === '--bind-apk') {
      out.bindApk = true;
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
  const evidence = classifyEvidenceTree(porcelain.entries, others);
  const untracked = hashUntrackedFiles(evidence.remaining_untracked);
  let submoduleStatus = git(['submodule', 'status']).stdout.trim();
  if (!submoduleStatus) submoduleStatus = '(none)';
  const requestedApk = opts.apk && existsSync(opts.apk) ? opts.apk : null;
  const observational = Boolean(requestedApk) && !opts.bindApk;
  const apk = classifyApkLinkage(requestedApk, observational);
  if (apk.apk_linkage === 'BOUND' && evidence.evidence_dirty) {
    apk.apk_observational_sha256 = apk.apk_sha256;
    apk.apk_sha256 = null;
    apk.apk_linkage = 'UNBOUND';
    apk.apk_linkage_reason =
      'assembleDebug APK exists but evidence_dirty=true; do not bind APK to this tree';
  }
  return buildBundleRecord({
    baseCommit,
    dirty: porcelain.dirty,
    evidenceDirty: evidence.evidence_dirty,
    excludedUnrelatedPaths: evidence.excluded_unrelated_paths,
    porcelain: porcelain.entries,
    diffSha256: sha256Bytes(diff),
    diffBytes: diff.length,
    untrackedSha256: untracked.sha256,
    lockfileSha256: sha256File(join(ROOT, 'crates', 'Cargo.lock')),
    crateTomlSha256: sha256File(join(ROOT, 'crates', 'presentation-m0', 'Cargo.toml')),
    submoduleStatus,
    apkSha256: apk.apk_sha256,
    apkObservationalSha256: apk.apk_observational_sha256,
    apkPath: requestedApk,
    apkBytes: requestedApk ? readFileSync(requestedApk).byteLength : null,
    apkLinkage: apk.apk_linkage,
    apkLinkageReason: apk.apk_linkage_reason,
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

  node scripts/m0-d1a-source-bundle.mjs [--apk <debug.apk>] [--bind-apk] [--out <dir>] [--stdout]

  APK is UNBOUND unless --bind-apk is passed for an APK built from this tree.
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
  const others = git(['ls-files', '--others', '--exclude-standard'])
    .stdout.split(/\r?\n/u)
    .filter(Boolean);
  const evidence = classifyEvidenceTree(record.porcelain, others);
  const extra = hashUntrackedFiles(evidence.remaining_untracked);
  writeFileSync(
    join(opts.outDir, `${stamp}-untracked.json`),
    `${JSON.stringify({ ...extra, excluded_unrelated_paths: evidence.excluded_unrelated_paths }, null, 2)}\n`,
  );
  console.log(`[m0-d1a-bundle] wrote ${jsonPath}`);
  console.log(`[m0-d1a-bundle] wrote ${patchPath}`);
  console.log(
    `[m0-d1a-bundle] base=${record.base_commit} dirty=${record.dirty} evidence_dirty=${record.evidence_dirty} apk_linkage=${record.apk_linkage} apk=${record.apk_sha256 ?? 'unbound'}`,
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
