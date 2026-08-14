/**
 * ARC-11 enforcement suite (ADR-0039, ТЗ §14.2): legacy compatibility may
 * translate or restrict an operation, but must never grant MORE authority than
 * the corresponding native capability. Asserts, through the real app:
 *
 *  1. legacy Express routers are confined to /api/plugins/{id}/... and can
 *     never shadow core /api/v2 routes;
 *  2. legacy extension settings are namespaced per installed plugin, bounded
 *     and validated;
 *  3. the scoped plugin VFS (files.plugin) is wired to
 *     <data-root>/plugins/{id}/data — outside the canonical DB and secrets —
 *     rejects traversal/backslash escapes and requires the grant.
 *
 * The per-API authority map lives in packages/legacy-compat/COMPATIBILITY.md.
 */
import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import yazl from 'yazl';
import type { AppDatabase } from '@neotavern/db';
import { mountLegacyServerPlugin, type LegacyServerPluginContract } from '../src/legacy/host.js';
import type { DataPaths } from '../src/lib/paths.js';
import type { TypedApp } from '../src/types.js';
import { createTestApp } from './helpers.js';

let app: TypedApp;
let database: AppDatabase;
let paths: DataPaths;

beforeEach(async () => {
  ({ app, database, paths } = await createTestApp());
});

function multipartFile(
  bytes: Buffer,
  filename: string,
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `neotavern-arc11-${Date.now().toString(16)}`;
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`,
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([prefix, bytes, suffix]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

function zipArchive(entries: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const [path, contents] of Object.entries(entries)) {
    zip.addBuffer(typeof contents === 'string' ? Buffer.from(contents) : contents, path);
  }
  zip.end();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function installPlugin(id: string, permissions: readonly string[]): void {
  database.repos.plugins.install({
    id,
    name: id,
    version: '1.0.0',
    manifest: { id, name: id, version: '1.0.0', apiVersion: 2 },
    requestedPermissions: [...permissions],
  });
}

describe('ARC-11: legacy router confinement (ТЗ §14.2)', () => {
  it('core /api/v2 routes are never shadowed by legacy routers', async () => {
    // A hostile legacy router registers paths that collide with core API
    // routes. The Express app is only ever invoked with the plugin-relative
    // path, so the core routes keep answering.
    const hostile: LegacyServerPluginContract = {
      info: { id: 'legacy.shadow-attempt', name: 'Shadow attempt' },
      init(router) {
        router.get('/api/v2/legacy/extension-settings', (_req, res) => {
          res.json({ shadowed: true });
        });
        router.get('/api/v2/backups', (_req, res) => {
          res.json({ shadowed: true });
        });
        router.get('/ping', (_req, res) => {
          res.json({ ok: true });
        });
      },
    };
    const unmount = mountLegacyServerPlugin(app, hostile);
    try {
      const coreSettings = await app.inject({
        method: 'GET',
        url: '/api/v2/legacy/extension-settings',
      });
      expect(coreSettings.statusCode).toBe(200);
      // The core route answers with its own body, not the legacy handler's.
      expect(coreSettings.json()).toEqual({ items: {} });

      const coreBackups = await app.inject({ method: 'GET', url: '/api/v2/backups' });
      expect(coreBackups.statusCode).toBe(200);
      expect((coreBackups.json() as { items?: unknown }).items).toBeDefined();

      // The legacy handlers are only reachable under the plugin's own mount.
      const mounted = await app.inject({
        method: 'GET',
        url: '/api/plugins/legacy.shadow-attempt/ping',
      });
      expect(mounted.statusCode).toBe(200);
      expect(mounted.json()).toEqual({ ok: true });
    } finally {
      unmount();
    }
  });

  it('legacy routes are reachable only under /api/plugins/{id}/...', async () => {
    const plugin: LegacyServerPluginContract = {
      info: { id: 'legacy.confined', name: 'Confined' },
      init(router) {
        router.get('/ping', (_req, res) => {
          res.json({ confined: true });
        });
        router.get('/../api/v2/anything', (_req, res) => {
          res.json({ escaped: true });
        });
      },
    };
    const unmount = mountLegacyServerPlugin(app, plugin);
    try {
      // The plugin's own route works under its prefix…
      const own = await app.inject({ method: 'GET', url: '/api/plugins/legacy.confined/ping' });
      expect(own.statusCode).toBe(200);
      expect(own.json()).toEqual({ confined: true });

      // …but the same handler is never reachable outside the mount.
      const outside = await app.inject({ method: 'GET', url: '/api/v2/anything' });
      expect(outside.statusCode).toBe(404);
      const otherMount = await app.inject({
        method: 'GET',
        url: '/api/plugins/legacy.confined/api/v2/anything',
      });
      expect(otherMount.statusCode).toBe(404);
    } finally {
      unmount();
    }
  });
});

describe('ARC-11: legacy extension-settings namespace isolation (ТЗ §14.2.2)', () => {
  it('keeps each plugin settings under its own namespace', async () => {
    installPlugin('legacy.alpha', ['legacy.trusted']);
    installPlugin('legacy.beta', ['legacy.trusted']);

    const patchA = await app.inject({
      method: 'PATCH',
      url: '/api/v2/legacy/extension-settings/legacy.alpha',
      payload: { settings: { theme: 'dark' } },
    });
    expect(patchA.statusCode, patchA.payload).toBe(200);
    const patchB = await app.inject({
      method: 'PATCH',
      url: '/api/v2/legacy/extension-settings/legacy.beta',
      payload: { settings: { theme: 'light', marker: 'beta-only' } },
    });
    expect(patchB.statusCode, patchB.payload).toBe(200);

    const list = await app.inject({ method: 'GET', url: '/api/v2/legacy/extension-settings' });
    expect(list.statusCode).toBe(200);
    const items = (list.json() as { items: Record<string, unknown> }).items;
    // Namespaced per plugin id — one plugin never reads or clobbers another's.
    expect(items['legacy.alpha']).toEqual({ theme: 'dark' });
    expect(items['legacy.beta']).toEqual({ theme: 'light', marker: 'beta-only' });
  });

  it('rejects a namespace that is not an installed plugin', async () => {
    const unknown = await app.inject({
      method: 'PATCH',
      url: '/api/v2/legacy/extension-settings/legacy.not-installed',
      payload: { settings: { a: 1 } },
    });
    expect(unknown.statusCode).toBe(404);
    expect((unknown.json() as { code?: string }).code).toBe('PLUGIN_NOT_FOUND');
  });

  it('rejects settings over the 1 MiB namespace bound', async () => {
    installPlugin('legacy.big', ['legacy.trusted']);
    const big = { blob: 'x'.repeat(1024 * 1024 + 1) };
    const oversized = await app.inject({
      method: 'PATCH',
      url: '/api/v2/legacy/extension-settings/legacy.big',
      payload: { settings: big },
    });
    expect(oversized.statusCode).toBe(413);
    expect((oversized.json() as { code?: string }).code).toBe('FILE_TOO_LARGE');
  });
});

describe('ARC-11: scoped VFS namespace wiring (ТЗ §14.2.3)', () => {
  async function installBackendPlugin(
    pluginId: string,
    grantedPermissions: readonly string[],
  ): Promise<void> {
    const archive = await zipArchive({
      'plugin.json': JSON.stringify({
        id: pluginId,
        name: 'VFS probe',
        version: '1.0.0',
        apiVersion: 2,
        backend: 'backend.mjs',
        permissions: [...grantedPermissions],
      }),
      'backend.mjs': `
        export default {
          async activate(api) {
            try { await api.files.write('state/status.txt', 'ready'); } catch {}
            api.routes.get('/escape-dotdot', async () => {
              try {
                await api.files.write('../../escape.txt', 'x');
                return { status: 200, body: { ok: true } };
              } catch (error) { return { status: 200, body: { error: error?.code } }; }
            });
            api.routes.get('/escape-backslash', async () => {
              try {
                await api.files.write('..\\\\..\\\\escape.txt', 'x');
                return { status: 200, body: { ok: true } };
              } catch (error) { return { status: 200, body: { error: error?.code } }; }
            });
            api.routes.get('/escape-read-db', async () => {
              try {
                const content = await api.files.read('../../app.db');
                return { status: 200, body: { ok: true, length: content.length } };
              } catch (error) { return { status: 200, body: { error: error?.code } }; }
            });
            api.routes.get('/write-ungranted', async () => {
              try {
                await api.files.write('a.txt', 'x');
                return { status: 200, body: { ok: true } };
              } catch (error) { return { status: 200, body: { error: error?.code } }; }
            });
          }
        };
      `,
    });
    const installed = await app.inject({
      method: 'POST',
      url: '/api/v2/plugins/install',
      ...multipartFile(archive, 'vfs-probe.stplugin'),
    });
    expect(installed.statusCode, installed.payload).toBe(200);
    const activated = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${pluginId}/activate`,
      payload: { grantedPermissions },
    });
    expect(activated.statusCode, activated.payload).toBe(200);
    expect(activated.json().plugin.status).toBe('active');
  }

  it('writes land inside <data-root>/plugins/{id}/data and nowhere else', async () => {
    const pluginId = 'test.vfs-wiring';
    await installBackendPlugin(pluginId, ['files:plugin', 'server.routes']);

    const written = join(paths.plugins, pluginId, 'data', 'state', 'status.txt');
    expect(existsSync(written)).toBe(true);
    // No stray files anywhere outside the plugin's own data root.
    expect(existsSync(join(paths.plugins, pluginId, 'state', 'status.txt'))).toBe(false);
    expect(existsSync(join(paths.plugins, 'state', 'status.txt'))).toBe(false);
  });

  it('rejects ../ and backslash escapes from the plugin namespace', async () => {
    const pluginId = 'test.vfs-escapes';
    await installBackendPlugin(pluginId, ['files:plugin', 'server.routes']);

    for (const route of ['escape-dotdot', 'escape-backslash', 'escape-read-db']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/plugins/${pluginId}/${route}`,
      });
      expect(res.statusCode, `${route}: ${res.payload}`).toBe(200);
      // The vnext backend host rejects unsafe plugin-relative paths through
      // validatePackageEntryPath (BAD_REQUEST); the plugin-runtime executor
      // reports the same rejection as VALIDATION_FAILED. Both are stable,
      // machine-readable codes and the file is never written.
      expect(['BAD_REQUEST', 'VALIDATION_FAILED']).toContain(res.json().error);
    }

    // Nothing escaped: no files outside the plugin data root.
    expect(existsSync(join(paths.plugins, pluginId, 'escape.txt'))).toBe(false);
    expect(existsSync(join(paths.plugins, 'escape.txt'))).toBe(false);
    expect(existsSync(join(paths.root, 'escape.txt'))).toBe(false);
  });

  it('denies files.write without the files.plugin grant', async () => {
    const pluginId = 'test.vfs-ungranted';
    await installBackendPlugin(pluginId, ['server.routes']);

    const res = await app.inject({
      method: 'GET',
      url: `/api/plugins/${pluginId}/write-ungranted`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ error: 'PLUGIN_PERMISSION_DENIED' });
  });

  it('keeps the canonical DB and secret paths outside the plugin namespace', async () => {
    const pluginDataRoot = join(paths.plugins, 'test.vfs-namespace', 'data');
    const rel = (candidate: string): string => relative(pluginDataRoot, candidate);
    // The plugin data root is a strict descendant of <data-root>/plugins/…
    expect(rel(paths.plugins)).toMatch(/^\.\.(\/|\\)/u);
    // …so the canonical DB (app.db / database.sqlite) and future secrets.enc
    // live outside every plugin's namespace.
    for (const forbidden of [
      paths.dbFile,
      join(paths.root, 'database.sqlite'),
      join(paths.root, 'secrets.enc'),
    ]) {
      const diff = rel(forbidden);
      expect(diff.startsWith(`..${sep}`), `${forbidden} must be outside the plugin namespace`).toBe(
        true,
      );
    }
  });
});
