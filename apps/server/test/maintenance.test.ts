/**
 * Global maintenance lock tests (ТЗ §10.4, Wave 1 «maintenance lock для
 * restore»): exclusive acquisition, the mutation gate, restore-under-lock,
 * and lock release on both the success and the failure path.
 */
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAppError } from '@neotavern/shared';
import { MaintenanceController } from '../src/lib/maintenance.js';
import { createTestApp } from './helpers.js';

describe('MaintenanceController (ТЗ §10.4)', () => {
  it('acquires exclusively and releases exactly once', () => {
    const controller = new MaintenanceController();
    expect(controller.isActive()).toBe(false);

    const release = controller.acquire();
    expect(controller.isActive()).toBe(true);

    release();
    expect(controller.isActive()).toBe(false);
    // Repeat release is a no-op.
    release();
    expect(controller.isActive()).toBe(false);
  });

  it('rejects a second holder while maintenance is active', () => {
    const controller = new MaintenanceController();
    controller.acquire();

    let error: unknown;
    try {
      controller.acquire();
    } catch (caught) {
      error = caught;
    }
    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe('MAINTENANCE_MODE');
      expect(error.params).toMatchObject({ reason: 'RESTORE_IN_PROGRESS' });
    }
  });
});

describe('maintenance mutation gate (ТЗ §10.4)', () => {
  it('rejects new product mutations with MAINTENANCE_MODE while held', async () => {
    const maintenance = new MaintenanceController();
    const { app } = await createTestApp({ maintenance });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/chats',
      payload: { title: 'Before maintenance' },
    });
    expect(created.statusCode, created.payload).toBe(200);

    const release = maintenance.acquire();
    try {
      const denied = await app.inject({
        method: 'POST',
        url: '/api/v2/chats',
        payload: { title: 'During maintenance' },
      });
      expect(denied.statusCode).toBe(503);
      expect(denied.json()).toMatchObject({ code: 'MAINTENANCE_MODE' });

      // Plugin activation is a mutation too — blocked while held.
      const deniedActivate = await app.inject({
        method: 'POST',
        url: '/api/v2/plugins/author.example/activate',
        payload: { grantedPermissions: [] },
      });
      expect(deniedActivate.statusCode).toBe(503);
      expect(deniedActivate.json()).toMatchObject({ code: 'MAINTENANCE_MODE' });

      // Read-only requests keep working so the UI can show maintenance state.
      const reads = await app.inject({ method: 'GET', url: '/api/v2/chats' });
      expect(reads.statusCode).toBe(200);
    } finally {
      release();
    }

    const writable = await app.inject({
      method: 'POST',
      url: '/api/v2/chats',
      payload: { title: 'After maintenance' },
    });
    expect(writable.statusCode, writable.payload).toBe(200);
  });

  it('allows backup tooling during maintenance', async () => {
    const maintenance = new MaintenanceController();
    const { app } = await createTestApp({ maintenance, useFileDatabase: true });
    const release = maintenance.acquire();
    try {
      const backup = await app.inject({ method: 'POST', url: '/api/v2/backups' });
      expect(backup.statusCode, backup.payload).toBe(200);
    } finally {
      release();
    }
  });
});

describe('restore under the maintenance lock (ТЗ §10.4)', () => {
  it('rejects restore when another maintenance holder is active', async () => {
    const maintenance = new MaintenanceController();
    const { app } = await createTestApp({ maintenance, useFileDatabase: true });
    const backup = await app.inject({ method: 'POST', url: '/api/v2/backups' });
    expect(backup.statusCode, backup.payload).toBe(200);

    const release = maintenance.acquire();
    try {
      const restored = await app.inject({
        method: 'POST',
        url: `/api/v2/backups/${backup.json().id as string}/restore`,
      });
      expect(restored.statusCode).toBe(503);
      expect(restored.json()).toMatchObject({ code: 'MAINTENANCE_MODE' });
    } finally {
      release();
    }
  });

  it('releases the lock after a successful restore', async () => {
    const { app } = await createTestApp({ useFileDatabase: true });
    await app.inject({
      method: 'POST',
      url: '/api/v2/chats',
      payload: { title: 'Snapshot title' },
    });
    const backup = await app.inject({ method: 'POST', url: '/api/v2/backups' });
    const backupId = backup.json().id as string;

    const restored = await app.inject({
      method: 'POST',
      url: `/api/v2/backups/${backupId}/restore`,
    });
    expect(restored.statusCode, restored.payload).toBe(200);

    // The lock was released: a subsequent mutation works.
    const writable = await app.inject({
      method: 'POST',
      url: '/api/v2/chats',
      payload: { title: 'Created after restore' },
    });
    expect(writable.statusCode, writable.payload).toBe(200);
  });

  it('releases the lock after a failed restore', async () => {
    const { app, paths } = await createTestApp({ useFileDatabase: true });
    const backup = await app.inject({ method: 'POST', url: '/api/v2/backups' });
    expect(backup.statusCode, backup.payload).toBe(200);
    const backupId = backup.json().id as string;

    // Corrupt the backup file so the SQLite restore fails.
    await writeFile(join(paths.backups, `${backupId}.db`), 'not a sqlite database at all');

    const failed = await app.inject({
      method: 'POST',
      url: `/api/v2/backups/${backupId}/restore`,
    });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toMatchObject({ code: 'RESTORE_FAILED' });

    // Even after a failure the maintenance lock is released.
    const writable = await app.inject({
      method: 'POST',
      url: '/api/v2/chats',
      payload: { title: 'Created after failed restore' },
    });
    expect(writable.statusCode, writable.payload).toBe(200);
  });

  it('failed restore leaves no locked file handle behind (Windows §10.3.1)', async () => {
    const { app, paths } = await createTestApp({ useFileDatabase: true });
    const backup = await app.inject({ method: 'POST', url: '/api/v2/backups' });
    expect(backup.statusCode, backup.payload).toBe(200);
    const backupId = backup.json().id as string;
    const backupPath = join(paths.backups, `${backupId}.db`);

    // Corrupt the backup so the SQLite restore fails *while opening* the file.
    await writeFile(backupPath, 'not a sqlite database at all');

    const failed = await app.inject({
      method: 'POST',
      url: `/api/v2/backups/${backupId}/restore`,
    });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toMatchObject({ code: 'RESTORE_FAILED' });

    // Handle hygiene (ТЗ §10.3.1, §17.4): a failed restore must not leave the
    // OS file handle open. The old implementation opened the corrupted backup
    // with better-sqlite3 and dropped the instance without close() when a
    // pragma failed — on Windows the file stays locked without
    // FILE_SHARE_DELETE and cannot be removed until the process exits
    // (EBUSY/EPERM). Delete must succeed immediately after the failure.
    await expect(rm(backupPath)).resolves.toBeUndefined();
  });
});
