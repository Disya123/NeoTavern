import { describe, expect, it } from 'vitest';
import {
  RFC_EDITION,
  SCHEMA,
  UNRELATED_PATH_EXCLUDES,
  buildBundleRecord,
  classifyApkLinkage,
  classifyEvidenceTree,
  isUnrelatedPath,
  parsePorcelain,
  sha256Bytes,
} from './m0-d1a-source-bundle.mjs';

describe('m0-d1a source bundle', () => {
  it('marks a dirty tree from porcelain without inventing a PASS', () => {
    const parsed = parsePorcelain(
      ' M crates/Cargo.lock\n?? crates/presentation-m0/src/timeline.rs\n',
    );
    expect(parsed.dirty).toBe(true);
    expect(parsed.entries).toHaveLength(2);
    const record = buildBundleRecord({
      baseCommit: '59af10c1d5c2aec8123fd7600cfb19ca9eb565da',
      dirty: parsed.dirty,
      porcelain: parsed.entries,
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

  it('excludes a git C-quoted octal path for the root TZ copy', () => {
    const quoted =
      '"\\320\\242\\320\\265\\321\\205\\320\\275\\320\\270\\321\\207\\320\\265\\321\\201\\320\\272\\320\\276\\320\\265 \\320\\267\\320\\260\\320\\264\\320\\260\\320\\275\\320\\270\\320\\265_ NeoUI v4.md"';
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

  it('keeps lockfile edits as evidence_dirty', () => {
    const classified = classifyEvidenceTree([' M crates/Cargo.lock'], []);
    expect(classified.evidence_dirty).toBe(true);
    expect(classified.excluded_unrelated_paths).toEqual([]);
  });

  it('does not bind an observational pulled APK to the source hash', () => {
    const linkage = classifyApkLinkage(null, false);
    expect(linkage.apk_linkage).toBe('UNBOUND');
    expect(linkage.apk_sha256).toBeNull();
  });
});
