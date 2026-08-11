/**
 * Integration tests for the rev4 plugin data routes (src/plugins/pluginData.ts
 * + src/plugin/blobStore.ts). Boots the real app against a throwaway data
 * directory and exercises KV CAS semantics, blob round-trips, limits and
 * capability gating via Fastify inject().
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { TypedApp } from '../src/types.js';
import { createTestApp } from './helpers.js';
import type { AppDatabase } from '@neotavern/db';

const PLUGIN_ID = 'test.plugin-data';

let app: TypedApp;
let database: AppDatabase;

beforeEach(async () => {
  ({ app, database } = await createTestApp());
});

function installPlugin(id: string, capabilities: readonly string[]): void {
  database.repos.plugins.install({
    id,
    name: id,
    version: '1.0.0',
    manifest: {},
    requestedPermissions: [...capabilities],
  });
  for (const name of capabilities) {
    database.repos.capabilityGrants.grant({ pluginId: id, name, scope: {} });
  }
}

describe('plugin state (storage.kv REST)', () => {
  it('stores, reads and deletes scoped state', async () => {
    installPlugin(PLUGIN_ID, ['storage.user']);

    const put = await app.inject({
      method: 'PUT',
      url: `/api/v2/plugins/${PLUGIN_ID}/state?scope=user`,
      payload: { data: { theme: 'dark', count: 3 } },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ revision: 1 });

    const got = await app.inject({
      method: 'GET',
      url: `/api/v2/plugins/${PLUGIN_ID}/state?scope=user`,
    });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toMatchObject({
      scope: 'user',
      ownerId: null,
      revision: 1,
      data: { theme: 'dark', count: 3 },
    });

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v2/plugins/${PLUGIN_ID}/state?scope=user`,
    });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ deleted: true });

    const missing = await app.inject({
      method: 'GET',
      url: `/api/v2/plugins/${PLUGIN_ID}/state?scope=user`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('NOT_FOUND');
  });

  it('rejects a stale expectedRevision with CONFLICT and both revisions', async () => {
    installPlugin(PLUGIN_ID, ['storage.user']);

    await app.inject({
      method: 'PUT',
      url: `/api/v2/plugins/${PLUGIN_ID}/state?scope=user`,
      payload: { data: { a: 1 } },
    });

    const conflict = await app.inject({
      method: 'PUT',
      url: `/api/v2/plugins/${PLUGIN_ID}/state?scope=user`,
      payload: { data: { a: 2 }, expectedRevision: 999 },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      code: 'CONFLICT',
      params: { expectedRevision: 999, revision: 1 },
    });

    // A matching expectedRevision succeeds and bumps the revision.
    const ok = await app.inject({
      method: 'PUT',
      url: `/api/v2/plugins/${PLUGIN_ID}/state?scope=user`,
      payload: { data: { a: 2 }, expectedRevision: 1 },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ revision: 2 });
  });

  it('keeps workspace and chat scopes in separate rows', async () => {
    installPlugin(PLUGIN_ID, ['storage.workspace', 'storage.chat']);

    await app.inject({
      method: 'PUT',
      url: `/api/v2/plugins/${PLUGIN_ID}/state?scope=workspace`,
      payload: { data: { which: 'workspace' } },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/v2/plugins/${PLUGIN_ID}/state?scope=chat&ownerId=chat-1`,
      payload: { data: { which: 'chat-1' } },
    });

    const workspace = await app.inject({
      method: 'GET',
      url: `/api/v2/plugins/${PLUGIN_ID}/state?scope=workspace`,
    });
    expect(workspace.json()).toMatchObject({ ownerId: 'workspace', data: { which: 'workspace' } });

    const chat = await app.inject({
      method: 'GET',
      url: `/api/v2/plugins/${PLUGIN_ID}/state?scope=chat&ownerId=chat-1`,
    });
    expect(chat.json()).toMatchObject({ ownerId: 'chat-1', data: { which: 'chat-1' } });

    // chat scope without an ownerId is a caller error.
    const noOwner = await app.inject({
      method: 'GET',
      url: `/api/v2/plugins/${PLUGIN_ID}/state?scope=chat`,
    });
    expect(noOwner.statusCode).toBe(400);
    expect(noOwner.json().params.reason).toBe('OWNER_ID_REQUIRED');
  });

  it('denies state access without the matching capability (403-ish envelope)', async () => {
    installPlugin(PLUGIN_ID, ['storage.user']);

    const wrongScope = await app.inject({
      method: 'GET',
      url: `/api/v2/plugins/${PLUGIN_ID}/state?scope=workspace`,
    });
    expect(wrongScope.statusCode).toBe(403);
    expect(wrongScope.json()).toMatchObject({
      code: 'PLUGIN_PERMISSION_DENIED',
      params: { pluginId: PLUGIN_ID, capability: 'storage.workspace' },
    });

    const unknownPlugin = await app.inject({
      method: 'GET',
      url: '/api/v2/plugins/nope.not-installed/state?scope=user',
    });
    expect(unknownPlugin.statusCode).toBe(404);
    expect(unknownPlugin.json().code).toBe('PLUGIN_NOT_FOUND');
  });
});

describe('plugin blobs (storage.blobs REST)', () => {
  it('round-trips a blob: put, list, stream back, delete', async () => {
    installPlugin(PLUGIN_ID, ['storage.blobs']);
    const content = Buffer.from('hello rev4 blobs');

    const put = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/blobs?name=notes.txt&contentType=text/plain`,
      payload: content,
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(put.statusCode, put.payload).toBe(200);
    const { blobId, hash, size } = put.json() as { blobId: string; hash: string; size: number };
    expect(size).toBe(content.byteLength);
    expect(blobId).toBe(hash);
    expect(blobId).toMatch(/^[a-f0-9]{64}$/);

    const list = await app.inject({ method: 'GET', url: `/api/v2/plugins/${PLUGIN_ID}/blobs` });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toMatchObject([
      { blobId, name: 'notes.txt', contentType: 'text/plain', size: content.byteLength },
    ]);

    const get = await app.inject({
      method: 'GET',
      url: `/api/v2/plugins/${PLUGIN_ID}/blobs/${blobId}`,
    });
    expect(get.statusCode).toBe(200);
    expect(get.headers['content-type']).toBe('text/plain');
    expect(get.rawPayload.equals(content)).toBe(true);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v2/plugins/${PLUGIN_ID}/blobs/${blobId}`,
    });
    expect(del.json()).toEqual({ deleted: true });

    const gone = await app.inject({
      method: 'GET',
      url: `/api/v2/plugins/${PLUGIN_ID}/blobs/${blobId}`,
    });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().code).toBe('FILE_NOT_FOUND');
  });

  it('deduplicates identical content and refreshes metadata', async () => {
    installPlugin(PLUGIN_ID, ['storage.blobs']);
    const content = Buffer.from('same bytes twice');

    for (const name of ['first.bin', 'second.bin']) {
      const put = await app.inject({
        method: 'POST',
        url: `/api/v2/plugins/${PLUGIN_ID}/blobs?name=${name}`,
        payload: content,
        headers: { 'content-type': 'application/octet-stream' },
      });
      expect(put.statusCode).toBe(200);
    }

    const list = await app.inject({ method: 'GET', url: `/api/v2/plugins/${PLUGIN_ID}/blobs` });
    const items = list.json().items as Array<{ name: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.name).toBe('second.bin');
  });

  it('rejects blobs over the 8 MiB cap with FILE_TOO_LARGE', async () => {
    installPlugin(PLUGIN_ID, ['storage.blobs']);
    const tooBig = Buffer.alloc(8 * 1024 * 1024 + 1, 7);

    const put = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/blobs?name=big.bin`,
      payload: tooBig,
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(put.statusCode).toBe(413);
    expect(put.json().code).toBe('FILE_TOO_LARGE');
  });

  it('denies blob access without storage.blobs', async () => {
    installPlugin(PLUGIN_ID, ['storage.user']);

    const list = await app.inject({ method: 'GET', url: `/api/v2/plugins/${PLUGIN_ID}/blobs` });
    expect(list.statusCode).toBe(403);
    expect(list.json()).toMatchObject({
      code: 'PLUGIN_PERMISSION_DENIED',
      params: { pluginId: PLUGIN_ID, capability: 'storage.blobs' },
    });

    const put = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/blobs?name=x.bin`,
      payload: Buffer.from('x'),
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(put.statusCode).toBe(403);
  });
});
