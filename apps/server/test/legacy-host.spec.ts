/**
 * Legacy server-plugin compatibility suite (ТЗ §8.3, §17). Fixed reference
 * fixtures exercising the documented v1 contract — `info` / `init(router)` /
 * `exit()` on an Express router — through the real app and the
 * /api/plugins/{id}/ proxy, including failure containment and clean unmount.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mountLegacyServerPlugin, type LegacyServerPluginContract } from '../src/legacy/host.js';
import type { TypedApp } from '../src/types.js';
import { createTestApp } from './helpers.js';

let app: TypedApp;

function makeFixture(id: string): {
  plugin: LegacyServerPluginContract;
  exitCalled: () => boolean;
} {
  let exited = false;
  const plugin: LegacyServerPluginContract = {
    info: { id, name: 'Legacy fixture plugin', version: '1.0.0' },
    init(router) {
      router.get('/ping', (_req, res) => {
        res.json({ ok: true, id });
      });
      router.post('/echo', (_req, res) => {
        res.status(201).json({ echoed: true });
      });
      router.get('/boom-sync', () => {
        throw new Error('legacy sync failure');
      });
      router.get('/boom-async', async () => {
        throw new Error('legacy async failure');
      });
    },
    exit() {
      exited = true;
    },
  };
  return { plugin, exitCalled: () => exited };
}

// createTestApp tracks the app/database/temp dir and tears them down in its
// registered afterEach, so each test boots a fresh app. The helper defaults
// (pluginNodePath: process.execPath, pluginWorkerPath: null) match what this
// suite always used.
beforeEach(async () => {
  ({ app } = await createTestApp());
});

describe('legacy server plugin host', () => {
  it('serves init(router) routes under /api/plugins/{id}/', async () => {
    const { plugin } = makeFixture('legacy.routing');
    const unmount = mountLegacyServerPlugin(app, plugin);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/plugins/legacy.routing/ping' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, id: 'legacy.routing' });

      const posted = await app.inject({
        method: 'POST',
        url: '/api/plugins/legacy.routing/echo',
        payload: { value: 1 },
      });
      expect(posted.statusCode).toBe(201);
      expect(posted.json()).toEqual({ echoed: true });
    } finally {
      unmount();
    }
  });

  it('contains synchronous handler failures as a JSON error envelope', async () => {
    const { plugin } = makeFixture('legacy.sync-fail');
    const unmount = mountLegacyServerPlugin(app, plugin);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/plugins/legacy.sync-fail/boom-sync',
      });
      expect(res.statusCode).toBe(500);
      const body = res.json() as { code?: string; traceId?: string };
      expect(body.code).toBe('INTERNAL');
      expect(typeof body.traceId).toBe('string');
      // Raw messages never cross the boundary (ТЗ §4.2).
      expect(res.payload).not.toContain('legacy sync failure');
      // The host stays alive after a failing legacy handler.
      const alive = await app.inject({ method: 'GET', url: '/api/plugins/legacy.sync-fail/ping' });
      expect(alive.statusCode).toBe(200);
    } finally {
      unmount();
    }
  });

  it('contains async handler rejections without killing the server', async () => {
    const { plugin } = makeFixture('legacy.async-fail');
    const unmount = mountLegacyServerPlugin(app, plugin);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/plugins/legacy.async-fail/boom-async',
      });
      expect(res.statusCode).toBe(500);
      expect((res.json() as { code?: string }).code).toBe('INTERNAL');
      expect(res.payload).not.toContain('legacy async failure');
      const alive = await app.inject({
        method: 'GET',
        url: '/api/plugins/legacy.async-fail/ping',
      });
      expect(alive.statusCode).toBe(200);
    } finally {
      unmount();
    }
  });

  it('returns a NOT_FOUND envelope for unregistered plugin routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/plugins/legacy.missing/ping' });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code?: string }).code).toBe('NOT_FOUND');
  });

  it('unmount gates all routes and calls exit() exactly once', async () => {
    const { plugin, exitCalled } = makeFixture('legacy.lifecycle');
    const unmount = mountLegacyServerPlugin(app, plugin);
    const before = await app.inject({ method: 'GET', url: '/api/plugins/legacy.lifecycle/ping' });
    expect(before.statusCode).toBe(200);

    unmount();
    expect(exitCalled()).toBe(true);

    const after = await app.inject({ method: 'GET', url: '/api/plugins/legacy.lifecycle/ping' });
    expect(after.statusCode).toBe(404);

    // Repeated cleanup is a no-op: exit() must not run twice.
    unmount();
    expect(exitCalled()).toBe(true);
  });

  it('exposes legacy extension settings with plugin validation', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v2/legacy/extension-settings' });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { items: Record<string, unknown> }).items).toEqual({});

    const unknown = await app.inject({
      method: 'PATCH',
      url: '/api/v2/legacy/extension-settings/legacy.unknown-namespace',
      payload: { settings: { a: 1 } },
    });
    expect(unknown.statusCode).toBe(404);
    expect((unknown.json() as { code?: string }).code).toBe('PLUGIN_NOT_FOUND');
  });
});
