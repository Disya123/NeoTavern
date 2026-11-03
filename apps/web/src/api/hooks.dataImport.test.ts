/**
 * Wire → legacy-shape mappers for cutover-registry row 10 (SillyTavern data
 * import). The panel renders the legacy DTOs, so the kernel plane must translate
 * honestly: every count comes from the kernel's per-category arithmetic, and the
 * two fields the wire deliberately does not model (`safetyBackupId`,
 * `legacyExtensions`) stay empty/zero instead of being invented.
 */
import { describe, expect, it } from 'vitest';
import { importCategoryFromWire, importResultFromWire } from './hooks.js';

describe('importCategoryFromWire', () => {
  it('keeps the analyzer counts and reports no conflicts before a policy is chosen', () => {
    expect(
      importCategoryFromWire({
        id: 'chats',
        discovered: 12,
        dependentRecords: 340,
        invalid: 2,
        sizeBytes: 4096,
      }),
    ).toEqual({
      id: 'chats',
      discovered: 12,
      dependentRecords: 340,
      invalid: 2,
      conflicts: 0,
      sizeBytes: 4096,
    });
  });
});

describe('importResultFromWire', () => {
  const categories = [
    {
      id: 'characters' as const,
      imported: 2,
      reused: 1,
      skipped: 0,
      dependentImported: 0,
      conflicted: 0,
      invalid: 0,
      discovered: 3,
    },
    {
      id: 'chats' as const,
      imported: 4,
      reused: 0,
      skipped: 1,
      dependentImported: 120,
      conflicted: 1,
      invalid: 0,
      discovered: 5,
    },
    {
      id: 'lorebooks' as const,
      imported: 1,
      reused: 0,
      skipped: 0,
      dependentImported: 30,
      conflicted: 0,
      invalid: 0,
      discovered: 1,
    },
  ];

  const dto = {
    runId: '00000000-0000-4000-8000-0000000000aa',
    sourceHash: 'a'.repeat(64),
    conflictPolicy: 'skip' as const,
    archiveAlreadyImported: false,
    categories,
    totals: {
      imported: 7,
      reused: 1,
      skipped: 1,
      conflicted: 1,
      invalid: 0,
      dependentImported: 150,
    },
    warningCount: 1,
    warnings: [{ code: 'SECRETS_SKIPPED' as const, path: 'secrets.json' }],
  };

  it('maps per-category counts, incl. dependent rows as messages/lore entries', () => {
    const result = importResultFromWire(
      dto,
      { categories: ['characters', 'chats'], conflictPolicy: 'skip' },
      ['characters', 'chats'],
    );
    expect(result.counts.characters).toEqual({ imported: 2, reused: 1, skipped: 0 });
    expect(result.counts.chats).toEqual({ imported: 4, reused: 0, skipped: 1 });
    expect(result.counts.messages).toEqual({ imported: 120, reused: 0, skipped: 0 });
    expect(result.counts.loreEntries).toEqual({ imported: 30, reused: 0, skipped: 0 });
    expect(result.counts.presets).toEqual({ imported: 0, reused: 0, skipped: 0 });
    expect(result.counts.legacyExtensions).toEqual({ imported: 0, reused: 0, skipped: 0 });
  });

  it('never fabricates a safety backup id and echoes the wire identity', () => {
    const result = importResultFromWire(
      dto,
      { categories: ['characters'], conflictPolicy: 'skip' },
      ['characters'],
    );
    expect(result.jobId).toBe(dto.runId);
    expect(result.sourceHash).toBe(dto.sourceHash);
    expect(result.safetyBackupId).toBe('');
    expect(result.reusedArchive).toBe(false);
    expect(result.conflictPolicy).toBe('skip');
    expect(result.warnings).toEqual([{ code: 'SECRETS_SKIPPED', path: 'secrets.json' }]);
  });
});
