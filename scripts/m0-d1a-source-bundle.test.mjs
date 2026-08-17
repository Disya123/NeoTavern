import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HELPER_REL_PATH,
  RFC_EDITION,
  SCHEMA,
  UNRELATED_PATH_EXCLUDES,
  buildBundleRecord,
  classifyEvidenceTree,
  collectHelperIdentity,
  finalizeApkLinkage,
  isUnrelatedPath,
  parseArgs,
  parsePorcelain,
  resolveApkBinding,
  sha256Bytes,
  sha256File,
} from './m0-d1a-source-bundle.mjs';

const ROOT = join(import.meta.dirname, '..');
const HELPER_ABS = join(ROOT, HELPER_REL_PATH);

function fakeApk() {
  const dir = mkdtempSync(join(tmpdir(), 'm0-d1a-apk-'));
  const path = join(dir, 'app-debug.apk');
  writeFileSync(path, 'not-a-production-apk');
  return path;
}

function sampleRecord(extra = {}) {
  return buildBundleRecord({
    baseCommit: '59af10c1d5c2aec8123fd7600cfb19ca9eb565da',
    dirty: false,
    porcelain: [],
    diffSha256: sha256Bytes(Buffer.from('diff')),
    diffBytes: 4,
    lockfileSha256: 'abc',
    crateTomlSha256: 'def',
    submoduleStatus: '(none)',
    apkSha256: null,
    apkPath: null,
    apkBytes: null,
    rustc: 'rustc 1.97.1',
    cargo: 'cargo 1.97.1',
    runner: { probe_bin: 'm0-d1a-probe' },
    ...extra,
  });
}

describe('m0-d1a source bundle', () => {
  it('marks a dirty tree from porcelain without inventing a PASS', () => {
    const parsed = parsePorcelain(
      ' M crates/Cargo.lock\n?? crates/presentation-m0/src/timeline.rs\n',
    );
    expect(parsed.dirty).toBe(true);
    expect(parsed.entries).toHaveLength(2);
    const record = sampleRecord({
      dirty: parsed.dirty,
      porcelain: parsed.entries,
    });
    expect(record.schema).toBe(SCHEMA);
    expect(record.rfc).toBe(RFC_EDITION);
    expect(record.program.gate_p).toBe('UNDECIDED');
    expect(record.program.runner_d1a).toBe('PRE-GATE / BLOCKED');
    expect(record.program.d1b).toBe('NOT_STARTED');
    expect(record.apk_sha256).toBeNull();
    expect(record.apk_linkage).toBe('UNBOUND');
    expect(record.note).toContain('not an M0-D1a PASS');
  });

  it('treats empty porcelain as a clean tree', () => {
    expect(parsePorcelain('').dirty).toBe(false);
    expect(parsePorcelain('\n').dirty).toBe(false);
  });

  it('defaults to apk_linkage=UNBOUND without --bind-apk', () => {
    const opts = parseArgs([]);
    expect(opts.bindApk).toBe(false);
    expect(opts.apk).toBeNull();
    const resolved = resolveApkBinding(opts);
    expect(resolved.apk_linkage).toBe('UNBOUND');
    expect(resolved.apk_sha256).toBeNull();
    expect(resolved.apk_observational_sha256).toBeNull();
    expect(sampleRecord().apk_linkage).toBe('UNBOUND');
  });

  it('binds an APK only through explicit --bind-apk', () => {
    const apkPath = fakeApk();
    const digest = sha256File(apkPath);

    const observational = resolveApkBinding(parseArgs(['--apk', apkPath]));
    expect(observational.apk_linkage).toBe('UNBOUND');
    expect(observational.apk_sha256).toBeNull();
    expect(observational.apk_observational_sha256).toBe(digest);

    const bound = resolveApkBinding(parseArgs(['--apk', apkPath, '--bind-apk']));
    expect(bound.apk_linkage).toBe('BOUND');
    expect(bound.apk_sha256).toBe(digest);
    expect(bound.apk_observational_sha256).toBeNull();
    expect(finalizeApkLinkage(bound, false).apk_linkage).toBe('BOUND');

    const refused = finalizeApkLinkage(bound, true);
    expect(refused.apk_linkage).toBe('UNBOUND');
    expect(refused.apk_sha256).toBeNull();
    expect(refused.apk_observational_sha256).toBe(digest);

    expect(resolveApkBinding(parseArgs(['--bind-apk'])).apk_linkage).toBe('UNBOUND');
  });

  it('marks task-relevant dirty files as evidence_dirty', () => {
    const classified = classifyEvidenceTree(
      [' M crates/Cargo.lock', ' M scripts/m0-d1a-source-bundle.mjs'],
      ['crates/presentation-m0/src/timeline.rs'],
    );
    expect(classified.evidence_dirty).toBe(true);
    expect(classified.excluded_unrelated_paths).toEqual([]);
    expect(classified.remaining_porcelain).toEqual([
      ' M crates/Cargo.lock',
      ' M scripts/m0-d1a-source-bundle.mjs',
    ]);
    expect(classified.remaining_untracked).toEqual(['crates/presentation-m0/src/timeline.rs']);
  });

  it('does not let excluded_unrelated_paths hide relevant changes', () => {
    const tz = UNRELATED_PATH_EXCLUDES[0];
    const classified = classifyEvidenceTree(
      [' M crates/Cargo.lock', ' M scripts/m0-d1a-source-bundle.mjs', `?? ${tz}`],
      [tz],
    );
    expect(classified.evidence_dirty).toBe(true);
    expect(classified.excluded_unrelated_paths).toEqual([tz]);
    expect(classified.remaining_porcelain).toEqual([
      ' M crates/Cargo.lock',
      ' M scripts/m0-d1a-source-bundle.mjs',
    ]);
  });

  it('records the helper path and content hash on every bundle', () => {
    const record = sampleRecord();
    const identity = collectHelperIdentity();
    expect(record.helper_path).toBe(HELPER_REL_PATH);
    expect(record.helper_sha256).toBe(sha256File(HELPER_ABS));
    expect(record.helper_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(identity.helperPath).toBe(HELPER_REL_PATH);
    expect(identity.helperSha256).toBe(record.helper_sha256);
    expect(identity.helperGitBlob).toMatch(/^[0-9a-f]{40}$/u);
    expect(identity.helperMatchesHead).toBe(
      Boolean(identity.helperGitBlob) && identity.helperGitBlob === identity.helperHeadBlob,
    );
  });

  it('excludes a git C-quoted octal path for the root TZ copy', () => {
    const octal = [...Buffer.from(UNRELATED_PATH_EXCLUDES[0])]
      .map((byte) => `\\${byte.toString(8).padStart(3, '0')}`)
      .join('');
    const quoted = `"${octal}"`;
    expect(isUnrelatedPath(quoted)).toBe(true);
    const classified = classifyEvidenceTree([`?? ${quoted}`], [quoted]);
    expect(classified.evidence_dirty).toBe(false);
    expect(classified.excluded_unrelated_paths).toEqual(UNRELATED_PATH_EXCLUDES);
  });

  it('excludes the root TZ copy from evidence_dirty', () => {
    expect(isUnrelatedPath(UNRELATED_PATH_EXCLUDES[0])).toBe(true);
    const classified = classifyEvidenceTree(
      [`?? ${UNRELATED_PATH_EXCLUDES[0]}`],
      [UNRELATED_PATH_EXCLUDES[0]],
    );
    expect(classified.evidence_dirty).toBe(false);
    expect(classified.excluded_unrelated_paths).toEqual(UNRELATED_PATH_EXCLUDES);
  });
});
