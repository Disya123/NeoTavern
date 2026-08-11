/**
 * Integration tests for runtime capability grants (rev4 §B2
 * `capabilities.request`): POST /api/v2/plugins/:id/capabilities persists a
 * user-approved grant through the broker and stays idempotent, while unknown
 * names and non-enabled plugins are refused.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { TypedApp } from '../src/types.js';
import { createTestApp } from './helpers.js';
import type { AppDatabase } from '@neotavern/db';

const PLUGIN_ID = 'test.capability-grants';

/** Minimal manifest the onReady activation pass accepts (id/name/version/apiVersion). */
const VALID_MANIFEST = { id: PLUGIN_ID, name: PLUGIN_ID, version: '1.0.0', apiVersion: 2 };

let app: TypedApp;
let database: AppDatabase;

beforeEach(async () => {
  ({ app, database } = await createTestApp());
});

function installPlugin(id: string, capabilities: readonly string[] = []): void {
  database.repos.plugins.install({
    id,
    name: id,
    version: '1.0.0',
    manifest: VALID_MANIFEST,
    requestedPermissions: [...capabilities],
  });
  database.repos.plugins.grantAndEnable(id, [...capabilities]);
}

describe('runtime capability grants (POST /api/v2/plugins/:id/capabilities)', () => {
  it('issues a catalog capability and persists it as an active grant', async () => {
    installPlugin(PLUGIN_ID);

    const response = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/capabilities`,
      payload: { name: 'camera.request' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { grant: { name: string; revision: number } };
    expect(body.grant).toMatchObject({ name: 'camera.request', revision: 1 });

    const listed = await app.inject({
      method: 'GET',
      url: `/api/v2/plugins/${PLUGIN_ID}/capabilities`,
    });
    expect(listed.json().items).toMatchObject([{ name: 'camera.request' }]);
  });

  it('is idempotent: an already-active grant is returned without revision churn', async () => {
    installPlugin(PLUGIN_ID);

    const first = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/capabilities`,
      payload: { name: 'storage.user' },
    });
    const second = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/capabilities`,
      payload: { name: 'storage.user' },
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().grant.revision).toBe(first.json().grant.revision);
  });

  it('re-grants a previously revoked capability with a bumped revision', async () => {
    installPlugin(PLUGIN_ID);

    await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/capabilities`,
      payload: { name: 'camera.request' },
    });

    // Revoke through the broker as the plugin manager does on deactivation.
    const { createCapabilityBroker } = await import('../src/plugin/capabilityBroker.js');
    const { EventBus } = await import('@neotavern/plugin-sdk');
    const broker = createCapabilityBroker(database.repos.capabilityGrants, new EventBus());
    broker.revoke(PLUGIN_ID, 'camera.request');

    const again = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/capabilities`,
      payload: { name: 'camera.request' },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().grant.revision).toBe(2);
  });

  it('normalizes scoped family names (network:*) into catalog grants', async () => {
    installPlugin(PLUGIN_ID);

    const response = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/capabilities`,
      payload: { name: 'network:https://api.example.com' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().grant).toMatchObject({
      name: 'network.domains',
      scope: { kind: 'origins', origins: ['https://api.example.com'] },
    });
  });

  it('rejects names outside the catalog with 400', async () => {
    installPlugin(PLUGIN_ID);

    const response = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/capabilities`,
      payload: { name: 'system.root' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('BAD_REQUEST');
  });

  it('rejects legacy.trusted — an admin-only extension type', async () => {
    installPlugin(PLUGIN_ID);

    const response = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/capabilities`,
      payload: { name: 'legacy.trusted' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses unknown or disabled plugins with 404', async () => {
    const missing = await app.inject({
      method: 'POST',
      url: '/api/v2/plugins/test.nope/capabilities',
      payload: { name: 'camera.request' },
    });
    expect(missing.statusCode).toBe(404);

    database.repos.plugins.install({
      id: PLUGIN_ID,
      name: PLUGIN_ID,
      version: '1.0.0',
      manifest: VALID_MANIFEST,
      requestedPermissions: [],
    });
    const disabled = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${PLUGIN_ID}/capabilities`,
      payload: { name: 'camera.request' },
    });
    expect(disabled.statusCode).toBe(404);
  });
});
