import { describe, expect, it } from 'vitest';
import { createTestApp } from './helpers.js';

describe('backup restore', () => {
  it('restores a snapshot while keeping the live database usable', async () => {
    // File-backed database with the automatic backup dir wired (required for
    // snapshot/restore). The helper's afterEach tears down app, database and
    // the temp data directory.
    const { app } = await createTestApp({ useFileDatabase: true });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/chats',
      payload: { title: 'Snapshot title' },
    });
    const chatId = created.json().id as string;
    const backup = await app.inject({ method: 'POST', url: '/api/v2/backups' });
    expect(backup.statusCode, backup.payload).toBe(200);

    await app.inject({
      method: 'PATCH',
      url: `/api/v2/chats/${chatId}`,
      payload: { title: 'Changed title' },
    });
    const restored = await app.inject({
      method: 'POST',
      url: `/api/v2/backups/${backup.json().id as string}/restore`,
    });
    expect(restored.statusCode, restored.payload).toBe(200);
    expect(restored.json()).toEqual({ restored: true, restartRequired: false });

    const afterRestore = await app.inject({ method: 'GET', url: `/api/v2/chats/${chatId}` });
    expect(afterRestore.statusCode, afterRestore.payload).toBe(200);
    expect(afterRestore.json().title).toBe('Snapshot title');

    const writable = await app.inject({
      method: 'POST',
      url: '/api/v2/chats',
      payload: { title: 'Created after restore' },
    });
    expect(writable.statusCode, writable.payload).toBe(200);

    const backups = await app.inject({ method: 'GET', url: '/api/v2/backups' });
    expect(
      (backups.json().items as Array<{ id: string }>).some((item) =>
        item.id.startsWith('pre-restore-'),
      ),
    ).toBe(true);
  });
});
