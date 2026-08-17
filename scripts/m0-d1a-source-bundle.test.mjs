import { describe, expect, it } from 'vitest';
import {
  RFC_EDITION,
  SCHEMA,
  buildBundleRecord,
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
    expect(record.note).toContain('not an M0-D1a PASS');
  });

  it('treats empty porcelain as a clean tree', () => {
    expect(parsePorcelain('').dirty).toBe(false);
    expect(parsePorcelain('\n').dirty).toBe(false);
  });
});
