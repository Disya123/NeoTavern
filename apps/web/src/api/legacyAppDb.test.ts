/**
 * Legacy app.db bindings tests (round 30): error-string parsing, IPC
 * argument shapes, cancel-safe file picking, and the non-Tauri guard.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
const openMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  Channel: class {},
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: openMock,
}));

import {
  isLegacyImportAvailable,
  legacyImportExecute,
  legacyImportPlan,
  legacyImportRollback,
  parseLegacyOpError,
  pickLegacyAppDb,
} from './legacyAppDb.js';

/** Makes `isTauriRuntime()` true for the duration of the test. */
function withTauriRuntime(run: () => Promise<void> | void): Promise<void> {
  const marker = '__TAURI_INTERNALS__';
  const target = window as unknown as Record<string, unknown>;
  const had = marker in target;
  if (!had) target[marker] = {};
  return Promise.resolve(run()).finally(() => {
    if (!had) delete target[marker];
  });
}

afterEach(() => {
  invokeMock.mockReset();
  openMock.mockReset();
  vi.restoreAllMocks();
});

describe('parseLegacyOpError', () => {
  it('parses a stable CODE: message string', () => {
    const failure = parseLegacyOpError('LEGACY_NO_ROLLBACK_TARGET: nothing to roll back');
    expect(failure.code).toBe('LEGACY_NO_ROLLBACK_TARGET');
    expect(failure.message).toBe('nothing to roll back');
  });

  it('degrades unknown shapes to LEGACY_UNAVAILABLE without losing the text', () => {
    const failure = parseLegacyOpError({ boom: true });
    expect(failure.code).toBe('LEGACY_UNAVAILABLE');
    expect(failure.message).toContain('boom');
  });
});

describe('isLegacyImportAvailable', () => {
  it('is false outside Tauri and true inside', async () => {
    await withTauriRuntime(() => {
      expect(isLegacyImportAvailable()).toBe(true);
    });
    expect(isLegacyImportAvailable()).toBe(false);
  });
});

describe('legacyImportPlan / Execute / Rollback', () => {
  it('plan passes sourcePath and resolves the report', async () => {
    await withTauriRuntime(async () => {
      invokeMock.mockResolvedValueOnce({
        sourceDb: 'C:/old/app.db',
        ready: true,
        problems: [],
        families: [{ family: 'characters', count: 2, present: true }],
      });
      const report = await legacyImportPlan('C:/old/app.db');
      expect(invokeMock).toHaveBeenCalledWith('legacy_import_plan', {
        sourcePath: 'C:/old/app.db',
      });
      expect(report.ready).toBe(true);
      expect(report.families[0]?.family).toBe('characters');
    });
  });

  it('execute passes sourcePath and carries restartRequired', async () => {
    await withTauriRuntime(async () => {
      invokeMock.mockResolvedValueOnce({
        stagedRootId: 'root-1',
        previousRoot: 'C:/data',
        families: [],
        restartRequired: true,
      });
      const report = await legacyImportExecute('C:/old/app.db');
      expect(invokeMock).toHaveBeenCalledWith('legacy_import_execute', {
        sourcePath: 'C:/old/app.db',
      });
      expect(report.restartRequired).toBe(true);
    });
  });

  it('rollback takes no args', async () => {
    await withTauriRuntime(async () => {
      invokeMock.mockResolvedValueOnce({ restoredRoot: 'C:/data', restartRequired: true });
      await legacyImportRollback();
      expect(invokeMock).toHaveBeenCalledWith('legacy_import_rollback', {});
    });
  });

  it('refuses to call IPC outside Tauri', async () => {
    await expect(legacyImportPlan('x')).rejects.toThrow('LEGACY_UNAVAILABLE');
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe('pickLegacyAppDb', () => {
  it('returns the picked path from the dialog', async () => {
    await withTauriRuntime(async () => {
      openMock.mockResolvedValueOnce('C:/old/app.db');
      expect(await pickLegacyAppDb()).toBe('C:/old/app.db');
      expect(openMock).toHaveBeenCalledTimes(1);
      const args = openMock.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(args.multiple).toBe(false);
      expect(args.directory).toBe(false);
    });
  });

  it('maps a cancelled dialog to null and null runtime to null', async () => {
    await withTauriRuntime(async () => {
      openMock.mockResolvedValueOnce(null);
      expect(await pickLegacyAppDb()).toBeNull();
    });
    expect(await pickLegacyAppDb()).toBeNull();
  });
});
