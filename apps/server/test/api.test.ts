/**
 * Backend integration tests via Fastify inject() (AGENTS.md §23). Boots the
 * real app against an in-memory database.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PROMPT_TEMPLATE, parseMessageGenerationMeta } from '@neotavern/contracts';
import { createAppDatabase, type AppDatabase } from '@neotavern/db';
import { DEFAULT_PROVIDER_TIMEOUTS, ProviderRegistry } from '@neotavern/provider-sdk';
import { MemorySecretStore } from '@neotavern/secret-store';
import { createLogger } from '@neotavern/shared';
import yazl from 'yazl';
import { buildApp } from '../src/app.js';
import { createSecretStoreHandleForBackend } from '../src/lib/secretStore.js';
import { ensureDataDirs, resolveDataPaths, type DataPaths } from '../src/lib/paths.js';
import type { TypedApp } from '../src/types.js';
import { ContextStrategyRegistry } from '../src/pipeline/contextShift.js';
import { PostProcessorRegistry } from '../src/pipeline/postProcess.js';

let app: TypedApp;
let providers: ProviderRegistry;
let contextStrategies: ContextStrategyRegistry;
let postProcessors: PostProcessorRegistry;
let database: AppDatabase;
let paths: DataPaths;
let secretsHandle: ReturnType<typeof createSecretStoreHandleForBackend>;

function multipartFile(
  bytes: Buffer,
  filename: string,
  contentType: string,
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `neotavern-test-${Date.now().toString(16)}`;
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
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

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'neotavern-test-'));
  paths = resolveDataPaths(dataDir);
  ensureDataDirs(paths);
  database = createAppDatabase(':memory:');
  providers = new ProviderRegistry();
  providers.tokenizers.register({
    id: 'test:echo-exact',
    approximate: false,
    matches: (model) => model === 'echo',
    count: (text) => Math.ceil(text.length / 3),
  });
  contextStrategies = new ContextStrategyRegistry();
  contextStrategies.register({
    id: 'plugin.custom',
    shift: ({ messages }) => ({
      kept: messages,
      excluded: [],
      estimatedTokens: 0,
      truncated: false,
      fitsBudget: true,
    }),
  });
  postProcessors = new PostProcessorRegistry();
  secretsHandle = createSecretStoreHandleForBackend(new MemorySecretStore());
  database = createAppDatabase(':memory:', { secretResolver: (ref) => secretsHandle.resolve(ref) });
  app = await buildApp({
    database,
    providers,
    contextStrategies,
    postProcessors,
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      webDir: null,
      logLevel: 'error',
      corsOrigin: 'http://127.0.0.1:5173',
      remoteAccess: false,
      publicOrigin: 'http://127.0.0.1:5173',
      remoteTokenHash: null,
      secureSessionCookies: false,
      safeMode: false,
      allowSecretsExposure: false,
      secretMode: 'session',
      secretPassphrase: null,
      pluginNodePath: process.execPath,
      pluginWorkerPath: null,
      pluginLoaderPath: null,
      pluginGitInstall: true,
      pluginRegistryUrl: 'https://registry.npmjs.org',
      pluginDepsMaxPackages: 300,
      pluginDepsMaxBytes: 200 * 1024 * 1024,
      providerTimeouts: DEFAULT_PROVIDER_TIMEOUTS,
    },
    secrets: secretsHandle,
    logger: createLogger({ level: 'error' }),
    paths,
  });
});

afterAll(async () => {
  await app.close();
});

describe('meta', () => {
  it('reports health', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v2/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  it('reports version', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v2/version' });
    expect(res.json().apiVersion).toBe(2);
  });
});

describe('themes', () => {
  it('installs, serves, activates, updates, safely resets and removes a theme', async () => {
    const manifest = {
      id: 'test.release-theme',
      name: 'Release Theme',
      version: '1.0.0',
      apiVersion: 1,
      modes: ['light', 'dark'],
      tokens: { dark: { 'color-accent': '#7c5cff' } },
      componentsCss: 'styles/components.css',
      shell: 'styles/shell.css',
      preview: 'preview.png',
    };
    const archive = await zipArchive({
      'release-theme/theme.json': JSON.stringify(manifest),
      'release-theme/styles/components.css':
        '[data-component="app-shell"] { border-color: var(--st-color-accent); }',
      'release-theme/styles/shell.css':
        '[data-component="app-shell"] { grid-template-columns: auto minmax(0, 1fr); }',
      'release-theme/preview.png': Buffer.from([137, 80, 78, 71]),
    });
    const installed = await app.inject({
      method: 'POST',
      url: '/api/v2/themes/install',
      ...multipartFile(archive, 'release-theme.sttheme', 'application/zip'),
    });
    expect(installed.statusCode).toBe(200);
    expect(installed.json()).toMatchObject({
      replaced: false,
      theme: {
        id: manifest.id,
        enabled: false,
        componentsCssUrl: `/api/v2/themes/${manifest.id}/assets/styles/components.css`,
        shellCssUrl: `/api/v2/themes/${manifest.id}/assets/styles/shell.css`,
      },
    });

    const css = await app.inject({
      method: 'GET',
      url: `/api/v2/themes/${manifest.id}/assets/styles/components.css`,
    });
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toContain('text/css');
    // Cacheable with an ETag, and wrapped in the `theme` cascade layer.
    expect(css.headers['cache-control']).toBe('private, max-age=3600');
    expect(css.headers['etag']).toMatch(/^W\//u);
    expect(css.body).toContain('@layer theme {');
    expect(css.body).toContain('[data-component="app-shell"]');

    const activated = await app.inject({
      method: 'POST',
      url: `/api/v2/themes/${manifest.id}/activate`,
    });
    expect(activated.json()).toEqual({ activeThemeId: manifest.id });
    expect((await app.inject({ method: 'GET', url: '/api/v2/settings' })).json().themeId).toBe(
      manifest.id,
    );

    // Pre-hydration boot payload: resolved tokens for both modes and CSS URLs.
    const boot = await app.inject({ method: 'GET', url: '/api/v2/themes/boot' });
    expect(boot.statusCode).toBe(200);
    expect(boot.json()).toMatchObject({
      themeId: manifest.id,
      cssUrls: [
        `/api/v2/themes/${manifest.id}/assets/styles/components.css`,
        `/api/v2/themes/${manifest.id}/assets/styles/shell.css`,
      ],
    });
    // The manifest overrides color-accent for dark mode only.
    expect(boot.json().light['--st-color-accent']).toBe('#984729');
    expect(boot.json().dark['--st-color-accent']).toBe('#7c5cff');

    const replacementArchive = await zipArchive({
      'theme.json': JSON.stringify({ ...manifest, name: 'Release Theme 2', version: '2.0.0' }),
      'styles/components.css': '[data-component="app-shell"] { opacity: .99; }',
      'styles/shell.css': '[data-component="app-shell"] { min-width: 0; }',
      'preview.png': Buffer.from([137, 80, 78, 71]),
    });
    const replaced = await app.inject({
      method: 'POST',
      url: '/api/v2/themes/install',
      ...multipartFile(replacementArchive, 'release-theme-v2.sttheme', 'application/zip'),
    });
    expect(replaced.json()).toMatchObject({
      replaced: true,
      theme: { id: manifest.id, version: '2.0.0', enabled: true },
    });

    const list = await app.inject({ method: 'GET', url: '/api/v2/themes' });
    expect(list.json()).toMatchObject({
      activeThemeId: manifest.id,
      items: [{ id: manifest.id, enabled: true, version: '2.0.0' }],
    });

    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/api/v2/themes/active',
        })
      ).json(),
    ).toEqual({ activeThemeId: null });
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v2/themes/${manifest.id}`,
    });
    expect(removed.json()).toEqual({ deleted: true, activeThemeId: null });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v2/themes/${manifest.id}/assets/styles/components.css`,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('rejects executable shell modules, remote CSS and missing inheritance parents', async () => {
    const moduleArchive = await zipArchive({
      'theme.json': JSON.stringify({
        id: 'test.module-shell',
        name: 'Module shell',
        version: '1.0.0',
        shell: 'shell.ts',
      }),
      'shell.ts': 'export default {}',
    });
    const moduleResult = await app.inject({
      method: 'POST',
      url: '/api/v2/themes/install',
      ...multipartFile(moduleArchive, 'module.sttheme', 'application/zip'),
    });
    expect(moduleResult.statusCode).toBe(422);
    expect(moduleResult.json().code).toBe('THEME_INVALID');

    const remoteCssArchive = await zipArchive({
      'theme.json': JSON.stringify({
        id: 'test.remote-css',
        name: 'Remote CSS',
        version: '1.0.0',
        componentsCss: 'skin.css',
      }),
      'skin.css': '@import "https://tracker.example/theme.css";',
    });
    const remoteResult = await app.inject({
      method: 'POST',
      url: '/api/v2/themes/install',
      ...multipartFile(remoteCssArchive, 'remote.sttheme', 'application/zip'),
    });
    expect(remoteResult.statusCode).toBe(422);
    expect(remoteResult.json().code).toBe('THEME_INVALID');

    const childArchive = await zipArchive({
      'theme.json': JSON.stringify({
        id: 'test.orphan-child',
        name: 'Orphan child',
        version: '1.0.0',
        extends: 'test.missing-parent',
      }),
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v2/themes/install',
          ...multipartFile(childArchive, 'child.sttheme', 'application/zip'),
        })
      ).statusCode,
    ).toBe(200);
    const activation = await app.inject({
      method: 'POST',
      url: '/api/v2/themes/test.orphan-child/activate',
    });
    expect(activation.statusCode).toBe(422);
    expect(activation.json().code).toBe('THEME_INVALID');
    await app.inject({ method: 'DELETE', url: '/api/v2/themes/test.orphan-child' });
  });

  it('rejects malformed archives, forbidden CSS and unsafe paths', async () => {
    const install = async (
      entries: Record<string, string | Buffer>,
    ): Promise<{ statusCode: number; code: string }> => {
      const archive = await zipArchive(entries);
      const response = await app.inject({
        method: 'POST',
        url: '/api/v2/themes/install',
        ...multipartFile(archive, 'unsafe.sttheme', 'application/zip'),
      });
      return { statusCode: response.statusCode, code: String(response.json().code) };
    };

    const notZip = await app.inject({
      method: 'POST',
      url: '/api/v2/themes/install',
      ...multipartFile(Buffer.from('definitely not a zip archive'), 'plain.txt', 'text/plain'),
    });
    expect(notZip.statusCode).toBe(400);

    expect(await install({ 'skin.css': 'body {}' })).toMatchObject({
      statusCode: 422,
      code: 'THEME_INVALID',
    });
    expect(await install({ 'theme.json': '{not json' })).toMatchObject({
      statusCode: 422,
      code: 'THEME_INVALID',
    });
    expect(
      await install({
        'theme.json': JSON.stringify({ id: 'test.x', name: 42, version: '1.0.0' }),
      }),
    ).toMatchObject({ statusCode: 422, code: 'THEME_INVALID' });
    expect(
      await install({
        'theme.json': JSON.stringify({
          id: 'test.x',
          name: 'X',
          version: '1.0.0',
          componentsCss: '../evil.css',
        }),
        'evil.css': 'body {}',
      }),
    ).toMatchObject({ statusCode: 422, code: 'THEME_INVALID' });
    expect(
      await install({
        'theme.json': JSON.stringify({
          id: 'test.x',
          name: 'X',
          version: '1.0.0',
          shell: 'shell.css',
        }),
      }),
    ).toMatchObject({ statusCode: 422, code: 'THEME_INVALID' });

    const manifest = (shell: string) => ({
      'theme.json': JSON.stringify({
        id: 'test.x',
        name: 'X',
        version: '1.0.0',
        shell: 'shell.css',
      }),
      'shell.css': shell,
    });
    for (const css of [
      'a { background: url(//evil.example/x.png); }',
      'a { background-image: url(https://evil.example/x.png); }',
      'a { behavior: url(#default#VML); }',
      'x { background: url(javascript:alert(1)); }',
      'a { width: 1px !important; }',
    ]) {
      expect(await install(manifest(css))).toMatchObject({
        statusCode: 422,
        code: 'THEME_INVALID',
      });
    }

    expect(
      await install({
        'theme.json': JSON.stringify({
          id: 'test.x',
          name: 'X',
          version: '1.0.0',
          preview: 'preview.exe',
        }),
        'preview.exe': 'MZ',
      }),
    ).toMatchObject({ statusCode: 422, code: 'THEME_INVALID' });
    expect(
      await install({
        'theme.json': JSON.stringify({
          id: 'test.x',
          name: 'X',
          version: '1.0.0',
          locales: { en: 'locales/en.json' },
        }),
        'locales/en.json': '{broken',
      }),
    ).toMatchObject({ statusCode: 422, code: 'THEME_INVALID' });
  });

  it('enforces inheritance cycles, asset restrictions and per-theme settings', async () => {
    let sequence = 0;
    const id = (suffix: string): string =>
      `test.contract-${Date.now().toString(36)}-${sequence++}-${suffix}`;
    const installTheme = async (
      manifest: Record<string, unknown>,
      extra: Record<string, string | Buffer> = {},
    ): Promise<string> => {
      const archive = await zipArchive({ 'theme.json': JSON.stringify(manifest), ...extra });
      const response = await app.inject({
        method: 'POST',
        url: '/api/v2/themes/install',
        ...multipartFile(archive, 'contract.sttheme', 'application/zip'),
      });
      expect(response.statusCode, response.payload).toBe(200);
      return String((response.json() as { theme: { id: string } }).theme.id);
    };
    const base = { version: '1.0.0', apiVersion: 1 };
    const installed: string[] = [];

    // A child can activate only when the full inheritance chain is installed.
    const parentId = id('parent');
    const childId = id('child');
    const grandchildId = id('grandchild');
    for (const themeId of [parentId, childId, grandchildId]) {
      installed.push(
        await installTheme(
          { ...base, id: themeId, name: themeId, shell: 'shell.css' },
          {
            'shell.css': '[data-component="app-shell"] { min-width: 0; }',
          },
        ),
      );
    }
    const brokenChain = await app.inject({
      method: 'POST',
      url: `/api/v2/themes/${id('orphan')}/activate`,
    });
    expect(brokenChain.statusCode).toBe(404);
    expect(brokenChain.json().code).toBe('THEME_NOT_FOUND');

    // A chain cycle is detected at activation time.
    const cycleA = id('cycle-a');
    const cycleB = id('cycle-b');
    installed.push(
      await installTheme({ ...base, id: cycleA, name: 'Cycle A', extends: cycleB }),
      await installTheme({ ...base, id: cycleB, name: 'Cycle B', extends: cycleA }),
    );
    const cycleActivation = await app.inject({
      method: 'POST',
      url: `/api/v2/themes/${cycleA}/activate`,
    });
    expect(cycleActivation.statusCode).toBe(422);
    expect(cycleActivation.json().code).toBe('THEME_INVALID');

    // Deleting the active theme clears the active id.
    const activated = await app.inject({
      method: 'POST',
      url: `/api/v2/themes/${grandchildId}/activate`,
    });
    expect(activated.json()).toEqual({ activeThemeId: grandchildId });
    const removedActive = await app.inject({
      method: 'DELETE',
      url: `/api/v2/themes/${grandchildId}`,
    });
    expect(removedActive.json()).toEqual({ deleted: true, activeThemeId: null });

    // Assets: only whitelisted extensions, existing files, cached CSS.
    const cssAsset = await app.inject({
      method: 'GET',
      url: `/api/v2/themes/${parentId}/assets/shell.css`,
    });
    expect(cssAsset.statusCode).toBe(200);
    expect(cssAsset.headers['content-type']).toContain('text/css');
    const missingAsset = await app.inject({
      method: 'GET',
      url: `/api/v2/themes/${parentId}/assets/nope.css`,
    });
    expect(missingAsset.statusCode).toBe(404);
    expect(missingAsset.json().code).toBe('FILE_NOT_FOUND');
    const wrongType = await app.inject({
      method: 'GET',
      url: `/api/v2/themes/${parentId}/assets/README.txt`,
    });
    expect(wrongType.statusCode).toBe(415);
    expect(wrongType.json().code).toBe('FILE_TYPE_NOT_ALLOWED');

    // Per-theme settings: defaults, validated patches, persistence and cleanup.
    const settingsThemeId = id('settings');
    installed.push(
      await installTheme(
        {
          ...base,
          id: settingsThemeId,
          name: 'Settings theme',
          settings: {
            accent: {
              type: 'color',
              label: 'Accent',
              default: '#123456',
              variable: '--theme-accent',
            },
            density: {
              type: 'select',
              label: 'Density',
              options: ['compact', 'cozy'],
              default: 'cozy',
            },
            blur: { type: 'boolean', label: 'Blur', default: true },
            width: { type: 'number', label: 'Width', default: 12 },
          },
        },
        {},
      ),
    );
    const defaults = await app.inject({
      method: 'GET',
      url: `/api/v2/themes/${settingsThemeId}/settings`,
    });
    expect(defaults.json().values).toEqual({
      accent: '#123456',
      density: 'cozy',
      blur: true,
      width: 12,
    });
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v2/themes/${settingsThemeId}/settings`,
      payload: { accent: '#ff0000', density: 'compact' },
    });
    expect(patched.json().values).toMatchObject({ accent: '#ff0000', density: 'compact' });
    const persisted = await app.inject({
      method: 'GET',
      url: `/api/v2/themes/${settingsThemeId}/settings`,
    });
    expect(persisted.json().values).toMatchObject({ accent: '#ff0000', density: 'compact' });
    for (const invalid of [{ accent: 'red;}' }, { density: 'huge' }, { unknown: 1 }]) {
      const rejected = await app.inject({
        method: 'PATCH',
        url: `/api/v2/themes/${settingsThemeId}/settings`,
        payload: invalid,
      });
      expect(rejected.statusCode).toBe(422);
      expect(rejected.json().code).toBe('VALIDATION');
    }
    await app.inject({ method: 'DELETE', url: `/api/v2/themes/${settingsThemeId}` });
    const settingsGone = await app.inject({
      method: 'GET',
      url: `/api/v2/themes/${settingsThemeId}/settings`,
    });
    expect(settingsGone.statusCode).toBe(404);
    expect(settingsGone.json().code).toBe('THEME_NOT_FOUND');

    for (const themeId of installed) {
      await app.inject({ method: 'DELETE', url: `/api/v2/themes/${themeId}` });
    }
  });
});

describe('plugins', () => {
  it('installs with explicit consent, requires re-consent on permission expansion and deletes', async () => {
    const pluginId = 'test.release-plugin';
    const manifest = {
      id: pluginId,
      name: 'Release Plugin',
      version: '1.0.0',
      apiVersion: 2,
      frontend: 'dist/frontend.js',
      styles: 'dist/styles.css',
      i18n: { en: 'locales/en.json' },
      permissions: ['ui.toolbar'],
    };
    const archive = await zipArchive({
      'release-plugin/plugin.json': JSON.stringify(manifest),
      'release-plugin/dist/frontend.js':
        'export default { activate(api) { api.logger = undefined; } };',
      'release-plugin/dist/styles.css': '[data-component="plugin-sandbox"] { min-width: 0; }',
      'release-plugin/locales/en.json': JSON.stringify({
        toolbar: { title: 'Translated toolbar action' },
      }),
    });
    const installed = await app.inject({
      method: 'POST',
      url: '/api/v2/plugins/install',
      ...multipartFile(archive, 'release-plugin.stplugin', 'application/zip'),
    });
    expect(installed.statusCode).toBe(200);
    expect(installed.json()).toMatchObject({
      replaced: false,
      plugin: {
        id: pluginId,
        enabled: false,
        status: 'needs-consent',
        requestedPermissions: ['ui.toolbar'],
        grantedPermissions: [],
        addedPermissions: ['ui.toolbar'],
      },
    });

    // Granting a permission the manifest never requested is refused…
    const denied = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${pluginId}/activate`,
      payload: { grantedPermissions: ['chat.write'] },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('PLUGIN_PERMISSION_DENIED');

    // …while a strict subset (here: none of the requested permissions) is a
    // valid partial consent — the plugin runs without that capability.
    const partial = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${pluginId}/activate`,
      payload: { grantedPermissions: [] },
    });
    expect(partial.statusCode).toBe(200);
    expect(partial.json()).toMatchObject({
      plugin: { enabled: true, grantedPermissions: [] },
    });
    await app.inject({ method: 'POST', url: `/api/v2/plugins/${pluginId}/disable` });

    const activated = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${pluginId}/activate`,
      payload: { grantedPermissions: ['ui.toolbar'] },
    });
    expect(activated.json()).toMatchObject({
      plugin: { enabled: true, status: 'active', grantedPermissions: ['ui.toolbar'] },
    });

    const asset = await app.inject({
      method: 'GET',
      url: `/api/v2/plugins/${pluginId}/assets/dist/frontend.js`,
      headers: { origin: 'null' },
    });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toContain('text/javascript');
    expect(asset.headers['access-control-allow-origin']).toBe('*');

    const sandbox = await app.inject({
      method: 'GET',
      url: `/api/v2/plugins/${pluginId}/sandbox`,
    });
    expect(sandbox.statusCode).toBe(200);
    expect(sandbox.headers['content-security-policy']).toContain("connect-src 'none'");
    expect(sandbox.payload).toContain('sandbox.js');

    const bootstrap = await app.inject({
      method: 'GET',
      url: `/api/v2/plugins/${pluginId}/sandbox.js`,
      headers: { origin: 'null' },
    });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.headers['access-control-allow-origin']).toBe('*');
    expect(bootstrap.payload).toContain('Translated toolbar action');
    expect(bootstrap.payload).toContain('neotavern.plugin.deactivate');

    const enteredSafeMode = await app.inject({
      method: 'POST',
      url: '/api/v2/plugins/runtime/safe-mode',
    });
    expect(enteredSafeMode.json()).toEqual({ safeMode: true });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v2/plugins/${pluginId}/sandbox`,
        })
      ).statusCode,
    ).toBe(404);
    const exitedSafeMode = await app.inject({
      method: 'DELETE',
      url: '/api/v2/plugins/runtime/safe-mode',
    });
    expect(exitedSafeMode.json()).toEqual({ safeMode: false });

    const expandedArchive = await zipArchive({
      'plugin.json': JSON.stringify({
        ...manifest,
        version: '2.0.0',
        permissions: ['notifications', 'ui.toolbar'],
      }),
      'dist/frontend.js': 'export default { activate() {} };',
      'dist/styles.css': '[data-component="plugin-sandbox"] { min-height: 0; }',
      'locales/en.json': JSON.stringify({ toolbar: { title: 'Updated action' } }),
    });
    const updated = await app.inject({
      method: 'POST',
      url: '/api/v2/plugins/install',
      ...multipartFile(expandedArchive, 'release-plugin-v2.stplugin', 'application/zip'),
    });
    expect(updated.json()).toMatchObject({
      replaced: true,
      plugin: {
        enabled: false,
        status: 'needs-consent',
        version: '2.0.0',
        grantedPermissions: ['ui.toolbar'],
        addedPermissions: ['notifications'],
      },
    });

    const reactivated = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${pluginId}/activate`,
      payload: { grantedPermissions: ['ui.toolbar', 'notifications'] },
    });
    expect(reactivated.json().plugin.status).toBe('active');

    const savedLegacySettings = await app.inject({
      method: 'PATCH',
      url: `/api/v2/legacy/extension-settings/${pluginId}`,
      payload: { settings: { compactMode: true } },
    });
    expect(savedLegacySettings.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v2/legacy/extension-settings',
        })
      ).json(),
    ).toEqual({ items: { [pluginId]: { compactMode: true } } });

    const disabled = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${pluginId}/disable`,
    });
    expect(disabled.json()).toMatchObject({
      plugin: {
        status: 'disabled',
        grantedPermissions: ['notifications', 'ui.toolbar'],
      },
    });
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v2/plugins/${pluginId}`,
    });
    expect(removed.json()).toEqual({ deleted: true });
  });

  it('rejects native executable payloads and unknown permissions', async () => {
    const nativeArchive = await zipArchive({
      'plugin.json': JSON.stringify({
        id: 'test.native-plugin',
        name: 'Native plugin',
        version: '1.0.0',
        apiVersion: 2,
        backend: 'backend.js',
      }),
      'backend.js': 'export default { activate() {} };',
      'native.node': Buffer.from([1, 2, 3]),
    });
    const nativeResult = await app.inject({
      method: 'POST',
      url: '/api/v2/plugins/install',
      ...multipartFile(nativeArchive, 'native.stplugin', 'application/zip'),
    });
    expect(nativeResult.statusCode).toBe(422);
    expect(nativeResult.json().code).toBe('PLUGIN_INVALID');

    const permissionArchive = await zipArchive({
      'plugin.json': JSON.stringify({
        id: 'test.permission-plugin',
        name: 'Permission plugin',
        version: '1.0.0',
        apiVersion: 2,
        permissions: ['everything.read'],
      }),
    });
    const permissionResult = await app.inject({
      method: 'POST',
      url: '/api/v2/plugins/install',
      ...multipartFile(permissionArchive, 'permission.stplugin', 'application/zip'),
    });
    expect(permissionResult.statusCode).toBe(422);
    expect(permissionResult.json().code).toBe('PLUGIN_INVALID');
  });

  it('runs backend code in a permission-limited child and removes routes on disable', async () => {
    const pluginId = 'test.backend-worker';
    const archive = await zipArchive({
      'plugin.json': JSON.stringify({
        id: pluginId,
        name: 'Backend worker',
        version: '1.0.0',
        apiVersion: 2,
        backend: 'backend.mjs',
        permissions: ['files:plugin', 'prompt.modify', 'providers.register', 'server.routes'],
      }),
      'backend.mjs': `
        import { marker } from './helper.mjs';
        let lastCoreEvent = null;
        let lastCustomEvent = null;
        export default {
          async activate(api) {
            if (
              globalThis.fetch !== undefined ||
              process.getBuiltinModule !== undefined ||
              process.binding !== undefined
            ) {
              throw new Error('raw host capabilities leaked into plugin process');
            }
            await api.storage.set('activation', { isolated: true });
            await api.files.write('state/status.txt', 'ready');
            api.events.on('chat.created', (payload) => {
              lastCoreEvent = payload;
            });
            api.events.on(\`\${api.pluginId}.ping\`, (payload) => {
              lastCustomEvent = payload;
            });
            api.routes.get('/status', async () => ({
              status: 200,
              body: {
                storage: await api.storage.get('activation'),
                file: await api.files.read('state/status.txt'),
                marker,
                lastCoreEvent,
                lastCustomEvent
              }
            }));
            api.routes.post('/emit-event', async () => {
              await api.events.emit(\`\${api.pluginId}.ping\`, { value: 'pong' });
              return { status: 200, body: { ok: true } };
            });
            api.routes.get('/items/:itemId', async (request) => ({
              status: 200,
              body: { itemId: request.params.itemId }
            }));
            api.providers.register('test-isolated-provider', (config) => ({
              kind: 'test-isolated-provider',
              async validateConfig() {
                return { valid: config.settings?.enabled === true, issues: [] };
              },
              async listModels() {
                return [{ id: 'isolated-model', name: 'Isolated model', contextLimit: 4096 }];
              },
              async *generate(request) {
                yield { type: 'start', requestId: 'isolated-request' };
                yield { type: 'delta', text: request.messages[0]?.content ?? '' };
                yield { type: 'done', text: 'isolated response' };
              },
              async countTokens() {
                return { tokens: 7, approximate: false };
              }
            }));
            api.providers.registerTokenizer({
              id: 'test-isolated-tokenizer',
              priority: 100,
              approximate: false,
              matches(model) {
                return model === 'isolated-model';
              },
              count(text) {
                return text.split(/\\s+/u).filter(Boolean).length;
              }
            });
            api.contextStrategies.register({
              id: 'test.remote-context',
              priority: 50,
              shift({ messages, countTokens }) {
                return {
                  kept: messages.slice(-1),
                  excluded: messages.slice(0, -1),
                  estimatedTokens: countTokens(messages.at(-1)?.content ?? ''),
                  truncated: messages.length > 1,
                  fitsBudget: true
                };
              }
            });
          }
        };
      `,
      'helper.mjs': `export const marker = 'package-local-import';`,
    });
    const installed = await app.inject({
      method: 'POST',
      url: '/api/v2/plugins/install',
      ...multipartFile(archive, 'backend-worker.stplugin', 'application/zip'),
    });
    expect(installed.statusCode, installed.payload).toBe(200);

    const activated = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${pluginId}/activate`,
      payload: {
        grantedPermissions: [
          'server.routes',
          'files:plugin',
          'providers.register',
          'prompt.modify',
        ],
      },
    });
    expect(activated.statusCode, activated.payload).toBe(200);
    expect(activated.json().plugin.status).toBe('active');

    const response = await app.inject({
      method: 'GET',
      url: `/api/plugins/${pluginId}/status`,
    });
    expect(response.statusCode, response.payload).toBe(200);
    expect(response.json()).toEqual({
      storage: { isolated: true },
      file: 'ready',
      marker: 'package-local-import',
      lastCoreEvent: null,
      lastCustomEvent: null,
    });
    const parameterized = await app.inject({
      method: 'GET',
      url: `/api/plugins/${pluginId}/items/example-item`,
    });
    expect(parameterized.statusCode, parameterized.payload).toBe(200);
    expect(parameterized.json()).toEqual({ itemId: 'example-item' });

    const customEvent = await app.inject({
      method: 'POST',
      url: `/api/plugins/${pluginId}/emit-event`,
    });
    expect(customEvent.statusCode, customEvent.payload).toBe(200);
    const eventChat = await app.inject({
      method: 'POST',
      url: '/api/v2/chats',
      payload: { title: 'Backend event test' },
    });
    expect(eventChat.statusCode, eventChat.payload).toBe(200);
    const eventStatus = await app.inject({
      method: 'GET',
      url: `/api/plugins/${pluginId}/status`,
    });
    expect(eventStatus.json()).toMatchObject({
      lastCoreEvent: { chatId: eventChat.json().id },
      lastCustomEvent: { value: 'pong' },
    });

    const isolatedProvider = providers.create('test-isolated-provider', {
      baseUrl: null,
      model: 'isolated-model',
      apiKey: null,
      settings: { enabled: true },
    });
    expect(await isolatedProvider.validateConfig()).toEqual({ valid: true, issues: [] });
    expect(await isolatedProvider.listModels(new AbortController().signal)).toEqual([
      { id: 'isolated-model', name: 'Isolated model', contextLimit: 4096 },
    ]);
    const providerEvents = [];
    for await (const event of isolatedProvider.generate(
      {
        model: 'isolated-model',
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 16,
        temperature: 1,
        stream: true,
      },
      new AbortController().signal,
    )) {
      providerEvents.push(event);
    }
    expect(providerEvents.map((event) => event.type)).toEqual(['start', 'delta', 'done']);
    expect(
      await isolatedProvider.countTokens?.({
        model: 'isolated-model',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    ).toEqual({ tokens: 7, approximate: false });
    const isolatedTokenizer = await providers.tokenizers.resolve('isolated-model');
    expect(isolatedTokenizer).toMatchObject({
      profile: 'test-isolated-tokenizer',
      approximate: false,
    });
    await expect(isolatedTokenizer.count('one two three')).resolves.toBe(3);

    const remoteContext = await contextStrategies.resolve('test.remote-context').shift({
      messages: [
        { id: 'old', role: 'user', content: 'old' },
        { id: 'new', role: 'assistant', content: 'new response' },
      ],
      budgetTokens: 100,
      countTokens: (text) => text.length,
    });
    expect(remoteContext).toMatchObject({
      kept: [{ id: 'new', content: 'new response' }],
      excluded: [{ id: 'old', content: 'old' }],
      estimatedTokens: 12,
      truncated: true,
      fitsBudget: true,
    });

    const disabled = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${pluginId}/disable`,
    });
    expect(disabled.json().plugin.status).toBe('disabled');
    expect(providers.has('test-isolated-provider')).toBe(false);
    expect((await providers.tokenizers.resolve('isolated-model')).profile).toBe(
      'approximate-character-v1',
    );
    expect(() => contextStrategies.resolve('test.remote-context')).toThrow();
    const unavailable = await app.inject({
      method: 'GET',
      url: `/api/plugins/${pluginId}/status`,
    });
    expect(unavailable.statusCode).toBe(404);
    await app.inject({ method: 'DELETE', url: `/api/v2/plugins/${pluginId}` });
  });

  it('blocks backend plugin imports that bypass the permission-checked SDK', async () => {
    const pluginId = 'test.backend-import-denied';
    const archive = await zipArchive({
      'plugin.json': JSON.stringify({
        id: pluginId,
        name: 'Denied backend import',
        version: '1.0.0',
        apiVersion: 2,
        backend: 'backend.mjs',
      }),
      'backend.mjs': `
        import 'node:http';
        export default { activate() {} };
      `,
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v2/plugins/install',
          ...multipartFile(archive, 'backend-import-denied.stplugin', 'application/zip'),
        })
      ).statusCode,
    ).toBe(200);
    const activation = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${pluginId}/activate`,
      payload: { grantedPermissions: [] },
    });
    expect(activation.statusCode).toBe(500);
    expect(activation.json().code).toBe('PLUGIN_LOAD_FAILED');
    await app.inject({ method: 'DELETE', url: `/api/v2/plugins/${pluginId}` });
  });

  it('runs trusted legacy frontend and Express entries only after explicit consent', async () => {
    const pluginId = 'test.legacy-trusted';
    const archive = await zipArchive({
      'plugin.json': JSON.stringify({
        id: pluginId,
        name: 'Trusted legacy fixture',
        version: '1.0.0',
        apiVersion: 2,
        legacy: {
          frontend: 'legacy.js',
          backend: 'legacy-server.mjs',
        },
        permissions: ['legacy.trusted'],
      }),
      'legacy.js': `window.__neotavernLegacyFixture = (window.__neotavernLegacyFixture ?? 0) + 1;`,
      'legacy-server.mjs': `
        export default {
          info: { id: '${pluginId}', name: 'Trusted legacy fixture', version: '1.0.0' },
          init(router) {
            router.get('/status', (_request, response) => {
              response.json({ legacy: true });
            });
          }
        };
      `,
    });
    const installed = await app.inject({
      method: 'POST',
      url: '/api/v2/plugins/install',
      ...multipartFile(archive, 'legacy-trusted.stplugin', 'application/zip'),
    });
    expect(installed.statusCode, installed.payload).toBe(200);
    expect(installed.json().plugin).toMatchObject({
      compatibilityLevel: 'legacy-trusted',
      hasLegacyFrontend: true,
      hasLegacyBackend: true,
      status: 'needs-consent',
    });
    const denied = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${pluginId}/activate`,
      payload: { grantedPermissions: [] },
    });
    expect(denied.statusCode).toBe(403);

    const activated = await app.inject({
      method: 'POST',
      url: `/api/v2/plugins/${pluginId}/activate`,
      payload: { grantedPermissions: ['legacy.trusted'] },
    });
    expect(activated.statusCode, activated.payload).toBe(200);
    const legacyResponse = await app.inject({
      method: 'GET',
      url: `/api/plugins/${pluginId}/status`,
    });
    expect(
      legacyResponse.payload,
      JSON.stringify({
        statusCode: legacyResponse.statusCode,
        headers: legacyResponse.headers,
      }),
    ).toBe(JSON.stringify({ legacy: true }));
    const frontend = await app.inject({
      method: 'GET',
      url: `/api/v2/plugins/${pluginId}/legacy.js`,
    });
    expect(frontend.statusCode).toBe(200);
    expect(frontend.headers['content-type']).toContain('text/javascript');
    expect(frontend.payload).toContain('__neotavernLegacyFixture');

    await app.inject({ method: 'POST', url: `/api/v2/plugins/${pluginId}/disable` });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/plugins/${pluginId}/status`,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v2/plugins/${pluginId}/legacy.js`,
        })
      ).statusCode,
    ).toBe(404);
    await app.inject({ method: 'DELETE', url: `/api/v2/plugins/${pluginId}` });
  });
});

describe('characters', () => {
  let characterId: string;

  it('creates a character', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v2/characters',
      payload: { name: 'Alice', description: 'Wonderland', tags: ['fantasy'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe('Alice');
    expect(body.tags).toEqual(['fantasy']);
    characterId = body.id;
  });

  it('lists characters with a cursor page', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v2/characters' });
    const body = res.json();
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.hasMore).toBe(false);
  });

  it('accepts every documented sort value and rejects an unknown one', async () => {
    const values = [
      'name',
      'name-desc',
      'newest',
      'oldest',
      'favorites',
      'used',
      'chats-most',
      'chats-least',
      'tokens-most',
      'tokens-least',
      'random',
      'relevance',
      // Deprecated aliases are still accepted.
      'recent',
      'created',
      'usage',
    ];
    for (const sort of values) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v2/characters?sort=${encodeURIComponent(sort)}`,
      });
      expect(res.statusCode).toBe(200);
    }
    const bad = await app.inject({
      method: 'GET',
      url: '/api/v2/characters?sort=bogus',
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().code).toBe('VALIDATION');
  });

  it('returns a single random page with no cursor', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v2/characters?sort=random&limit=1',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
  });

  it('rejects invalid create bodies with a VALIDATION envelope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v2/characters',
      payload: { description: 'no name' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('VALIDATION');
  });

  it('returns CHARACTER_NOT_FOUND for a missing id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v2/characters/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('CHARACTER_NOT_FOUND');
  });

  it('imports Character Card V2 idempotently and exports preserved extensions', async () => {
    const card = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Mira Vale',
        description: 'Cartographer of impossible coastlines',
        personality: 'Precise and curious',
        scenario: 'A storm reveals an uncharted island.',
        first_mes: 'The shoreline was not here yesterday.',
        mes_example: '',
        creator_notes: 'Import integration fixture',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: ['The compass is pointing inland.'],
        tags: ['adventure'],
        creator: 'ST2 tests',
        character_version: '1.4',
        extensions: { examplePlugin: { enabled: true } },
        future_field: { preserved: true },
      },
    };
    const upload = multipartFile(
      Buffer.from(JSON.stringify(card)),
      'mira.json',
      'application/json',
    );

    const first = await app.inject({
      method: 'POST',
      url: '/api/v2/characters/import',
      ...upload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().created).toBe(true);
    expect(first.json().character.name).toBe('Mira Vale');

    const second = await app.inject({
      method: 'POST',
      url: '/api/v2/characters/import',
      ...upload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().created).toBe(false);
    expect(second.json().character.id).toBe(first.json().character.id);

    const exported = await app.inject({
      method: 'GET',
      url: `/api/v2/characters/${first.json().character.id}/export`,
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.json().spec).toBe('chara_card_v2');
    expect(exported.json().data.alternate_greetings).toEqual(['The compass is pointing inland.']);
    expect(exported.json().data.extensions.examplePlugin).toEqual({ enabled: true });
    expect(exported.json().data.extensions.future_field).toEqual({ preserved: true });
  });

  it('rejects unsupported character-card files without creating data', async () => {
    const upload = multipartFile(Buffer.from('not a character card'), 'card.txt', 'text/plain');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/characters/import',
      ...upload,
    });
    expect(response.statusCode).toBe(415);
    expect(response.json().code).toBe('FILE_TYPE_NOT_ALLOWED');
  });

  it('updates then soft-deletes', async () => {
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v2/characters/${characterId}`,
      payload: { name: 'Alice Updated' },
    });
    expect(patch.json().name).toBe('Alice Updated');

    const del = await app.inject({ method: 'DELETE', url: `/api/v2/characters/${characterId}` });
    expect(del.statusCode).toBe(200);

    const list = await app.inject({
      method: 'GET',
      url: '/api/v2/characters?q=Alice%20Updated',
    });
    expect(list.json().items.length).toBe(0);
  });
});

describe('SillyTavern data migration', () => {
  it('streams a complete archive, preserves metadata, and is idempotent', async () => {
    try {
      const card = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
          name: 'Archive Guide',
          description: 'Imported from a complete data archive',
          personality: 'Methodical',
          scenario: '',
          first_mes: 'Welcome.',
          mes_example: '',
          creator_notes: '',
          system_prompt: '',
          post_history_instructions: '',
          alternate_greetings: [],
          tags: ['migration'],
          creator: 'Fixture',
          character_version: '1',
          extensions: { fixtureExtension: { retained: true } },
        },
      };
      const header = {
        user_name: 'Traveler',
        character_name: 'Archive Guide',
        chat_metadata: {
          persona: 'traveler.png',
          custom_chat_field: { retained: true },
        },
      };
      const userMessage = {
        name: 'Traveler',
        is_user: true,
        send_date: '2026-07-20T10:00:00.000Z',
        mes: 'Show me the archive.',
        extra: { custom: 'user metadata' },
      };
      const assistantMessage = {
        name: 'Archive Guide',
        is_user: false,
        send_date: '2026-07-20T10:00:01.000Z',
        mes: 'Here it is.',
        swipes: ['Here it is.', 'A second answer.'],
        extra: { reasoning: 'preserved' },
      };
      const settings = {
        power_user: {
          personas: { 'traveler.png': 'Traveler' },
          persona_descriptions: {
            'traveler.png': {
              description: 'An explorer',
              position: 0,
              custom_persona_field: { retained: true },
            },
          },
          default_persona: 'traveler.png',
        },
      };
      const world = {
        name: 'Archive World',
        custom_world_field: true,
        entries: {
          0: {
            uid: 0,
            key: ['archive'],
            keysecondary: ['library'],
            content: 'The archive is beneath the old library.',
            order: 100,
            constant: false,
            selective: true,
            custom_entry_field: 'retained',
          },
        },
      };
      const zip = await zipArchive({
        'backup/data/default-user/settings.json': JSON.stringify(settings),
        'backup/data/default-user/secrets.json': JSON.stringify({ api_key: 'must-not-import' }),
        'backup/data/default-user/characters/Archive Guide.json': JSON.stringify(card),
        'backup/data/default-user/chats/Archive Guide/First journey.jsonl': [
          JSON.stringify(header),
          JSON.stringify(userMessage),
          '{broken line',
          JSON.stringify(assistantMessage),
        ].join('\n'),
        'backup/data/default-user/worlds/Archive World.json': JSON.stringify(world),
        'backup/data/default-user/instruct/Archive Format.json': JSON.stringify({
          name: 'Archive Format',
          input_sequence: 'User:',
          output_sequence: 'Assistant:',
        }),
        'backup/data/default-user/groups/unsupported.json': '{}',
      });
      const upload = multipartFile(zip, 'sillytavern-data.zip', 'application/zip');

      const first = await app.inject({
        method: 'POST',
        url: '/api/v2/imports/sillytavern',
        ...upload,
      });
      expect(first.statusCode, first.payload).toBe(200);
      expect(first.json()).toMatchObject({
        reusedArchive: false,
        counts: {
          characters: { imported: 1, reused: 0, skipped: 0 },
          chats: { imported: 1, reused: 0, skipped: 0 },
          messages: { imported: 2, reused: 0, skipped: 1 },
          personas: { imported: 1, reused: 0, skipped: 0 },
          lorebooks: { imported: 1, reused: 0, skipped: 0 },
          loreEntries: { imported: 1, reused: 0, skipped: 0 },
          presets: { imported: 1, reused: 0, skipped: 0 },
        },
      });
      const backups = await app.inject({ method: 'GET', url: '/api/v2/backups' });
      expect(
        (backups.json().items as Array<{ id: string }>).some(
          (backup) => backup.id === first.json().safetyBackupId,
        ),
      ).toBe(true);
      const warningCodes = new Set(
        (first.json().warnings as Array<{ code: string }>).map((warning) => warning.code),
      );
      expect(warningCodes.has('SECRETS_SKIPPED')).toBe(true);
      // groups/ is now an importable category; the fixture's nameless
      // groups/unsupported.json is reported as an invalid group record.
      expect(warningCodes.has('GROUP_INVALID')).toBe(true);
      expect(warningCodes.has('CHAT_LINE_INVALID')).toBe(true);
      expect(warningCodes.has('PERSONA_AVATAR_MISSING')).toBe(true);

      const characters = await app.inject({
        method: 'GET',
        url: '/api/v2/characters?q=Archive%20Guide',
      });
      const importedCharacter = characters.json().items[0] as {
        id: string;
        name: string;
      };
      expect(importedCharacter.name).toBe('Archive Guide');
      const fullCharacter = await app.inject({
        method: 'GET',
        url: `/api/v2/characters/${importedCharacter.id}`,
      });
      expect(fullCharacter.json().ext.fixtureExtension).toEqual({ retained: true });

      const chats = await app.inject({
        method: 'GET',
        url: `/api/v2/chats?characterId=${importedCharacter.id}`,
      });
      expect(chats.json().items).toHaveLength(1);
      const importedChatId = chats.json().items[0].id as string;
      const messages = await app.inject({
        method: 'GET',
        url: `/api/v2/chats/${importedChatId}/messages?order=asc`,
      });
      expect(messages.json().items.map((message: { content: string }) => message.content)).toEqual([
        'Show me the archive.',
        'Here it is.',
      ]);
      expect(
        database.sqlite
          .prepare(
            `SELECT content FROM message_variants
           WHERE message_id = (
             SELECT id FROM messages WHERE chat_id = ? AND content = 'Here it is.'
           )`,
          )
          .all(importedChatId),
      ).toEqual([{ content: 'A second answer.' }]);
      expect(JSON.stringify(first.json())).not.toContain('must-not-import');
      expect(
        database.sqlite
          .prepare("SELECT value FROM settings WHERE value LIKE '%must-not-import%'")
          .all(),
      ).toEqual([]);

      const second = await app.inject({
        method: 'POST',
        url: '/api/v2/imports/sillytavern',
        ...upload,
      });
      expect(second.statusCode, second.payload).toBe(200);
      expect(second.json().reusedArchive).toBe(true);
      expect(second.json().jobId).toBe(first.json().jobId);
      expect(
        database.sqlite
          .prepare(
            `SELECT COUNT(*) AS count
           FROM import_artifacts
           WHERE source_kind IN ('character', 'chat', 'persona', 'lorebook', 'preset')`,
          )
          .get(),
      ).toEqual({ count: 5 });
    } finally {
      // The archive marks 'traveler.png' as the default persona; remove it so
      // later generation tests see the same baseline as a fresh database
      // (generation falls back to the default persona when none is active).
      const defaultPersona = await database.repos.personas.getDefault();
      if (defaultPersona) await database.repos.personas.delete(defaultPersona.id);
    }
  });

  it('analyzes without writes, reports conflicts, and imports only confirmed categories', async () => {
    const existing = await database.repos.characters.create({
      name: 'Preflight Keeper',
      description: 'Local description must win',
    });
    const card = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Preflight Keeper',
        description: 'Incoming description',
        personality: '',
        scenario: '',
        first_mes: 'Hello.',
        mes_example: '',
        creator_notes: '',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: [],
        creator: 'Fixture',
        character_version: '1',
        extensions: {},
      },
    };
    const zip = await zipArchive({
      'data/default-user/characters/Preflight Keeper.json': JSON.stringify(card),
      'data/default-user/chats/Preflight Keeper/Not selected.jsonl': [
        JSON.stringify({ chat_metadata: {} }),
        JSON.stringify({ is_user: true, mes: 'Do not import this chat.' }),
      ].join('\n'),
    });
    const before = {
      characters: database.sqlite.prepare('SELECT COUNT(*) AS count FROM characters').get(),
      chats: database.sqlite.prepare('SELECT COUNT(*) AS count FROM chats').get(),
      jobs: database.sqlite.prepare('SELECT COUNT(*) AS count FROM import_jobs').get(),
    };
    const backupsBefore = (await app.inject({ method: 'GET', url: '/api/v2/backups' })).json().items
      .length as number;

    const analysisResponse = await app.inject({
      method: 'POST',
      url: '/api/v2/imports/sillytavern/analyze',
      ...multipartFile(zip, 'preflight.zip', 'application/zip'),
    });
    expect(analysisResponse.statusCode, analysisResponse.payload).toBe(200);
    const analysis = analysisResponse.json();
    expect(analysis).toMatchObject({ sourceName: 'preflight.zip', conflictCount: 1 });
    expect(
      analysis.categories.find((category: { id: string }) => category.id === 'characters'),
    ).toMatchObject({ discovered: 1, conflicts: 1, invalid: 0 });
    expect(
      analysis.categories.find((category: { id: string }) => category.id === 'chats'),
    ).toMatchObject({ discovered: 1, dependentRecords: 1 });
    expect(analysis.conflicts[0]).toMatchObject({
      category: 'characters',
      kind: 'name',
      targetId: existing.id,
    });
    expect(database.sqlite.prepare('SELECT COUNT(*) AS count FROM characters').get()).toEqual(
      before.characters,
    );
    expect(database.sqlite.prepare('SELECT COUNT(*) AS count FROM chats').get()).toEqual(
      before.chats,
    );
    expect(database.sqlite.prepare('SELECT COUNT(*) AS count FROM import_jobs').get()).toEqual(
      before.jobs,
    );
    expect((await app.inject({ method: 'GET', url: '/api/v2/backups' })).json().items.length).toBe(
      backupsBefore,
    );

    const execute = await app.inject({
      method: 'POST',
      url: `/api/v2/imports/sillytavern/${analysis.analysisId}/execute`,
      payload: { categories: ['characters'], conflictPolicy: 'skip' },
    });
    expect(execute.statusCode, execute.payload).toBe(200);
    expect(execute.json()).toMatchObject({
      selectedCategories: ['characters'],
      conflictPolicy: 'skip',
      counts: {
        characters: { imported: 0, reused: 1, skipped: 0 },
        chats: { imported: 0, reused: 0, skipped: 0 },
      },
    });
    expect(database.sqlite.prepare('SELECT COUNT(*) AS count FROM characters').get()).toEqual(
      before.characters,
    );
    expect(database.sqlite.prepare('SELECT COUNT(*) AS count FROM chats').get()).toEqual(
      before.chats,
    );
    expect(
      database.sqlite.prepare('SELECT description FROM characters WHERE id = ?').get(existing.id),
    ).toEqual({ description: 'Local description must win' });
    expect((await app.inject({ method: 'GET', url: '/api/v2/backups' })).json().items.length).toBe(
      backupsBefore + 1,
    );

    const consumed = await app.inject({
      method: 'DELETE',
      url: `/api/v2/imports/sillytavern/${analysis.analysisId}`,
    });
    expect(consumed.statusCode).toBe(404);
  });

  it('discards staged analysis explicitly', async () => {
    const zip = await zipArchive({
      'data/default-user/characters/Discarded.json': JSON.stringify({
        name: 'Discarded',
        description: '',
        personality: '',
        scenario: '',
        first_mes: '',
        mes_example: '',
      }),
    });
    const analyzed = await app.inject({
      method: 'POST',
      url: '/api/v2/imports/sillytavern/analyze',
      ...multipartFile(zip, 'discard.zip', 'application/zip'),
    });
    expect(analyzed.statusCode, analyzed.payload).toBe(200);
    const discarded = await app.inject({
      method: 'DELETE',
      url: `/api/v2/imports/sillytavern/${analyzed.json().analysisId}`,
    });
    expect(discarded.statusCode).toBe(204);
    const execute = await app.inject({
      method: 'POST',
      url: `/api/v2/imports/sillytavern/${analyzed.json().analysisId}/execute`,
      payload: { categories: ['characters'], conflictPolicy: 'skip' },
    });
    expect(execute.statusCode).toBe(404);
  });

  it('rejects a non-ZIP migration upload without creating an import job', async () => {
    const upload = multipartFile(Buffer.from('not a zip'), 'data.zip', 'application/zip');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/imports/sillytavern',
      ...upload,
    });
    expect(response.statusCode).toBe(415);
    expect(response.json().code).toBe('FILE_TYPE_NOT_ALLOWED');
  });

  it('rejects a ZIP that does not contain a SillyTavern user-data root', async () => {
    const zip = await zipArchive({ 'notes/readme.txt': 'not user data' });
    const upload = multipartFile(zip, 'unrelated.zip', 'application/zip');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/imports/sillytavern',
      ...upload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'BAD_REQUEST',
      params: { reason: 'SILLYTAVERN_DATA_ROOT_NOT_FOUND' },
    });
  });
});

describe('chats + messages + generation', () => {
  it('creates chats with the character greeting as the first assistant message', async () => {
    const authoredGreeting = '\n  Welcome to Eldoria.  \n';
    const character = await app.inject({
      method: 'POST',
      url: '/api/v2/characters',
      payload: {
        name: 'Seraphina',
        firstMessage: authoredGreeting,
        ext: { alternateGreetings: ['A second dawn.', 'Third greeting.'] },
      },
    });
    const chat = await app.inject({
      method: 'POST',
      url: '/api/v2/chats',
      payload: { characterId: character.json().id, greetingIndex: 1 },
    });
    expect(chat.statusCode).toBe(200);
    expect(chat.json().messageCount).toBe(1);

    const messages = await app.inject({
      method: 'GET',
      url: `/api/v2/chats/${chat.json().id}/messages?order=asc`,
    });
    expect(messages.json().items).toEqual([
      expect.objectContaining({
        role: 'assistant',
        content: 'A second dawn.',
        meta: expect.objectContaining({
          greeting: true,
          swipeId: 1,
          swipes: [authoredGreeting, 'A second dawn.', 'Third greeting.'],
        }),
      }),
    ]);

    const blankCharacter = await app.inject({
      method: 'POST',
      url: '/api/v2/characters',
      payload: { name: 'Silent', firstMessage: '   ' },
    });
    const blankChat = await app.inject({
      method: 'POST',
      url: '/api/v2/chats',
      payload: { characterId: blankCharacter.json().id },
    });
    expect(blankChat.json().messageCount).toBe(0);
  });

  it('previews the real new-chat prompt without creating a chat or calling a provider', async () => {
    const originalSettings = await app.inject({ method: 'GET', url: '/api/v2/settings' });
    const character = await app.inject({
      method: 'POST',
      url: '/api/v2/characters',
      payload: {
        name: 'Preview Keeper',
        description: 'Guards the clockwork orchard.',
        personality: 'Patient and precise.',
        firstMessage: 'The brass trees begin to chime.',
      },
    });
    const characterId = character.json().id as string;
    const persona = await app.inject({
      method: 'POST',
      url: '/api/v2/personas',
      payload: {
        name: 'Aster',
        description: 'A cartographer searching for the clockwork orchard.',
      },
    });
    const personaId = persona.json().id as string;
    const incompleteProvider = await database.repos.providerConfigs.create({
      kind: 'openai-compatible',
      name: 'Preview setup in progress',
      model: null,
    });

    await app.inject({
      method: 'POST',
      url: '/api/v2/lorebooks',
      payload: {
        name: 'Preview world',
        characterId,
        entries: [
          {
            keys: ['clockwork orchard'],
            content: 'Every brass tree stores one forgotten route.',
          },
        ],
      },
    });
    await app.inject({
      method: 'PATCH',
      url: '/api/v2/settings',
      payload: { activePersonaId: personaId },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v2/context-preview',
        payload: {
          characterId,
          userMessage: 'Show me the clockwork orchard.',
          providerConfigId: incompleteProvider.id,
        },
      });

      expect(response.statusCode, response.payload).toBe(200);
      const preview = response.json().preview as {
        tokenizer: { profile: string; approximate: boolean };
        budget: { promptTokens: number };
        entries: Array<{
          identifier: string;
          source: string;
          content: string;
          included: boolean;
        }>;
      };
      expect(preview.tokenizer).toEqual({
        profile: 'approximate-character-v1',
        approximate: true,
      });
      expect(preview.budget.promptTokens).toBeGreaterThan(0);
      expect(preview.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            identifier: 'core.character-description',
            included: true,
          }),
          expect.objectContaining({
            identifier: 'core.character-personality',
            included: true,
          }),
          expect.objectContaining({ identifier: 'core.persona', included: true }),
          expect.objectContaining({
            source: 'lorebook',
            content: 'Every brass tree stores one forgotten route.',
            included: true,
          }),
          expect.objectContaining({
            source: 'history',
            content: 'The brass trees begin to chime.',
            included: true,
          }),
          expect.objectContaining({
            source: 'user',
            content: 'Show me the clockwork orchard.',
            included: true,
          }),
        ]),
      );

      const chats = await app.inject({
        method: 'GET',
        url: `/api/v2/chats?characterId=${characterId}`,
      });
      expect(chats.json().items).toHaveLength(0);
    } finally {
      await app.inject({
        method: 'PATCH',
        url: '/api/v2/settings',
        payload: { activePersonaId: originalSettings.json().activePersonaId },
      });
      await database.repos.providerConfigs.delete(incompleteProvider.id);
    }
  });

  it('previews an existing chat with live settings without mutating its history', async () => {
    const originalSettings = await app.inject({ method: 'GET', url: '/api/v2/settings' });
    const character = await app.inject({
      method: 'POST',
      url: '/api/v2/characters',
      payload: {
        name: 'Existing Preview Keeper',
        description: 'Remembers every brass leaf.',
        firstMessage: 'The orchard is quiet tonight.',
      },
    });
    const chat = await app.inject({
      method: 'POST',
      url: '/api/v2/chats',
      payload: { characterId: character.json().id },
    });
    const chatId = chat.json().id as string;
    await app.inject({
      method: 'POST',
      url: `/api/v2/chats/${chatId}/messages`,
      payload: { role: 'user', content: 'Remember the western path.' },
    });
    const before = await app.inject({
      method: 'GET',
      url: `/api/v2/chats/${chatId}/messages?order=asc`,
    });

    try {
      await app.inject({
        method: 'PATCH',
        url: '/api/v2/settings',
        payload: { maxContextTokens: 32_768 },
      });
      const response = await app.inject({
        method: 'POST',
        url: '/api/v2/context-preview',
        payload: { chatId, userMessage: 'Which path did I mention?' },
      });

      expect(response.statusCode, response.payload).toBe(200);
      const preview = response.json().preview as {
        budget: { contextLimit: number; promptTokens: number };
        entries: Array<{ source: string; content: string; included: boolean }>;
      };
      expect(preview.budget.contextLimit).toBe(32_768);
      expect(preview.budget.promptTokens).toBeGreaterThan(0);
      expect(preview.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: 'history',
            content: 'The orchard is quiet tonight.',
            included: true,
          }),
          expect.objectContaining({
            source: 'history',
            content: 'Remember the western path.',
            included: true,
          }),
          expect.objectContaining({
            source: 'user',
            content: 'Which path did I mention?',
            included: true,
          }),
        ]),
      );

      const after = await app.inject({
        method: 'GET',
        url: `/api/v2/chats/${chatId}/messages?order=asc`,
      });
      expect(after.json()).toEqual(before.json());
    } finally {
      await app.inject({
        method: 'PATCH',
        url: '/api/v2/settings',
        payload: { maxContextTokens: originalSettings.json().maxContextTokens },
      });
    }
  });

  it('creates a chat, streams an echo generation, and persists both messages', async () => {
    const char = await app.inject({
      method: 'POST',
      url: '/api/v2/characters',
      payload: { name: 'Bot' },
    });
    const chat = await app.inject({
      method: 'POST',
      url: '/api/v2/chats',
      payload: { characterId: char.json().id },
    });
    const chatId = chat.json().id as string;

    const gen = await app.inject({
      method: 'POST',
      url: `/api/v2/chats/${chatId}/generate`,
      payload: { userMessage: 'hi there' },
    });
    expect(gen.statusCode).toBe(200);
    expect(gen.headers['content-type']).toContain('text/event-stream');

    const events = gen.payload
      .split('\n\n')
      .map((block) => block.trim())
      .filter((block) => block.startsWith('data:'))
      .map((block) => JSON.parse(block.slice(5).trim()) as { type: string });
    expect(events[0]?.type).toBe('start');
    expect(events.some((e) => e.type === 'done')).toBe(true);

    const messages = await app.inject({
      method: 'GET',
      url: `/api/v2/chats/${chatId}/messages?order=asc`,
    });
    const items = messages.json().items as Array<{
      role: string;
      content: string;
      meta: Record<string, unknown>;
    }>;
    expect(items[0]).toMatchObject({ role: 'user', content: 'hi there' });
    expect(items[1]?.role).toBe('assistant');
    expect(items[1]?.content.length).toBeGreaterThan(0);
    expect(items[1]?.meta['tokenBudget']).toMatchObject({
      profile: 'test:echo-exact',
      approximate: false,
    });

    // Terminal generation bookkeeping is persisted under meta.generation
    // (MessageGenerationMetaSchema). Echo fallback: no configured provider,
    // so the provider fields are null — never fabricated strings.
    const generationMeta = parseMessageGenerationMeta(items[1]?.meta['generation']);
    expect(generationMeta).not.toBeNull();
    expect(generationMeta?.generationId.length).toBeGreaterThan(0);
    expect(generationMeta?.model).toBe('echo');
    expect(generationMeta?.providerKind).toBeNull();
    expect(generationMeta?.providerConfigId).toBeNull();
    expect(generationMeta?.providerSource).toBeNull();
    expect(generationMeta?.durationMs).toBeGreaterThanOrEqual(0);
    expect(generationMeta?.usage).not.toBeNull();
    expect(generationMeta?.usage?.promptTokens).toBeGreaterThanOrEqual(0);
    expect(generationMeta?.usage?.completionTokens).toBeGreaterThanOrEqual(0);
    expect(generationMeta?.usage?.totalTokens).toBeGreaterThanOrEqual(0);
    // The legacy top-level meta.model stays in place for compatibility.
    expect(items[1]?.meta['model']).toBe('echo');

    const auditResponse = await app.inject({
      method: 'GET',
      url: `/api/v2/chats/${chatId}/context-audit`,
    });
    expect(auditResponse.statusCode).toBe(200);
    expect(auditResponse.json().audit).toMatchObject({
      chatId,
      providerKind: 'echo',
      model: 'echo',
      status: 'completed',
      promptTemplateMode: 'chat',
      tokenizer: { profile: 'test:echo-exact', approximate: false },
    });
    expect(
      auditResponse
        .json()
        .audit.entries.some(
          (entry: { source: string; content: string; included: boolean }) =>
            entry.source === 'user' && entry.content === 'hi there' && entry.included,
        ),
    ).toBe(true);
    expect(auditResponse.json().audit.providerMessages).toEqual(
      expect.arrayContaining([{ role: 'user', content: 'hi there' }]),
    );
    const firstGenerationId = auditResponse.json().audit.generationId as string;
    const secondGeneration = await app.inject({
      method: 'POST',
      url: `/api/v2/chats/${chatId}/generate`,
      payload: { userMessage: 'second turn' },
    });
    expect(secondGeneration.statusCode).toBe(200);
    const latestAudit = await app.inject({
      method: 'GET',
      url: `/api/v2/chats/${chatId}/context-audit`,
    });
    expect(latestAudit.json().audit.generationId).not.toBe(firstGenerationId);
    expect(latestAudit.json().audit.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'user', content: 'second turn', included: true }),
      ]),
    );
  });

  it('expands {{user}} and {{char}} macros through the generate route', async () => {
    const originalSettings = await app.inject({ method: 'GET', url: '/api/v2/settings' });
    const persona = await app.inject({
      method: 'POST',
      url: '/api/v2/personas',
      payload: { name: 'Aster', description: 'A traveler.' },
    });
    const personaId = persona.json().id as string;
    await app.inject({
      method: 'PATCH',
      url: '/api/v2/settings',
      payload: { activePersonaId: personaId },
    });

    const character = await app.inject({
      method: 'POST',
      url: '/api/v2/characters',
      payload: {
        name: 'Seraphina',
        description: '{{char}} watches over {{user}}.',
        firstMessage: 'Welcome, {{user}}.',
      },
    });
    const chat = await app.inject({
      method: 'POST',
      url: '/api/v2/chats',
      payload: { characterId: character.json().id },
    });
    const chatId = chat.json().id as string;

    try {
      const generation = await app.inject({
        method: 'POST',
        url: `/api/v2/chats/${chatId}/generate`,
        payload: { userMessage: 'Greetings, {{char}}.' },
      });
      expect(generation.statusCode).toBe(200);

      const messages = await app.inject({
        method: 'GET',
        url: `/api/v2/chats/${chatId}/messages?order=asc`,
      });
      const items = messages.json().items as Array<{ role: string; content: string }>;
      expect(items[0]).toMatchObject({ role: 'assistant', content: 'Welcome, {{user}}.' });
      expect(items[1]).toMatchObject({ role: 'user', content: 'Greetings, {{char}}.' });

      const auditResponse = await app.inject({
        method: 'GET',
        url: `/api/v2/chats/${chatId}/context-audit`,
      });
      const audit = auditResponse.json().audit as {
        entries: Array<{ source: string; content: string; included: boolean }>;
        providerMessages: Array<{ role: string; content: string }>;
      };
      expect(
        audit.entries.some(
          (entry) =>
            entry.included &&
            entry.content.includes('Seraphina watches over Aster.') &&
            entry.content.includes('Seraphina'),
        ),
      ).toBe(true);
      expect(
        audit.providerMessages.some(
          (message) => message.role === 'user' && message.content === 'Greetings, Seraphina.',
        ),
      ).toBe(true);
      expect(
        audit.providerMessages.some(
          (message) => message.role === 'assistant' && message.content === 'Welcome, Aster.',
        ),
      ).toBe(true);
    } finally {
      await app.inject({
        method: 'PATCH',
        url: '/api/v2/settings',
        payload: { activePersonaId: originalSettings.json().activePersonaId },
      });
    }
  });

  it('records provider errors as failed audits without saving an assistant message', async () => {
    const unregister = providers.register('test-error', () => ({
      kind: 'test-error',
      async validateConfig() {
        return { valid: true, issues: [] };
      },
      async listModels() {
        return [{ id: 'test-error', name: 'Test error' }];
      },
      async *generate() {
        yield { type: 'start' as const, requestId: 'test-error-request' };
        yield {
          type: 'error' as const,
          code: 'GENERATION_FAILED',
          message: 'Expected provider failure',
        };
      },
    }));
    const provider = await database.repos.providerConfigs.create({
      kind: 'test-error',
      name: 'Error provider',
      model: 'test-error',
    });
    try {
      const character = await app.inject({
        method: 'POST',
        url: '/api/v2/characters',
        payload: { name: 'Error Bot' },
      });
      const chat = await app.inject({
        method: 'POST',
        url: '/api/v2/chats',
        payload: { characterId: character.json().id },
      });
      const chatId = chat.json().id as string;

      const generation = await app.inject({
        method: 'POST',
        url: `/api/v2/chats/${chatId}/generate`,
        payload: { userMessage: 'fail safely', providerConfigId: provider.id },
      });
      const events = generation.payload
        .split('\n\n')
        .map((block) => block.trim())
        .filter((block) => block.startsWith('data:'))
        .map(
          (block) =>
            JSON.parse(block.slice(5).trim()) as { type: string; code?: string; message?: string },
        );
      expect(events.at(-1)).toMatchObject({ type: 'error', code: 'GENERATION_FAILED' });

      const audit = await app.inject({
        method: 'GET',
        url: `/api/v2/chats/${chatId}/context-audit`,
      });
      expect(audit.json().audit).toMatchObject({
        status: 'failed',
        errorCode: 'GENERATION_FAILED',
      });

      const messages = await app.inject({
        method: 'GET',
        url: `/api/v2/chats/${chatId}/messages?order=asc`,
      });
      expect(
        (messages.json().items as Array<{ role: string }>).filter(
          (message) => message.role === 'assistant',
        ),
      ).toEqual([]);
    } finally {
      await database.repos.providerConfigs.delete(provider.id);
      unregister();
    }
  });

  it('runs post-processing hooks before saving the assistant message', async () => {
    const cleanup = postProcessors.register({
      id: 'test:suffix',
      process: (text) => `${text} [processed]`,
    });
    try {
      const char = await app.inject({
        method: 'POST',
        url: '/api/v2/characters',
        payload: { name: 'PostBot' },
      });
      const chat = await app.inject({
        method: 'POST',
        url: '/api/v2/chats',
        payload: { characterId: char.json().id },
      });
      const chatId = chat.json().id as string;

      const gen = await app.inject({
        method: 'POST',
        url: `/api/v2/chats/${chatId}/generate`,
        payload: { userMessage: 'process me' },
      });
      const events = gen.payload
        .split('\n\n')
        .map((block) => block.trim())
        .filter((block) => block.startsWith('data:'))
        .map((block) => JSON.parse(block.slice(5).trim()) as { type: string; text?: string });
      const done = events.find((event) => event.type === 'done');
      expect(done?.text).toContain('[processed]');

      const messages = await app.inject({
        method: 'GET',
        url: `/api/v2/chats/${chatId}/messages?order=asc`,
      });
      const items = messages.json().items as Array<{
        role: string;
        content: string;
        meta: Record<string, unknown>;
      }>;
      const assistant = items.at(-1);
      expect(assistant?.content).toContain('[processed]');
      expect(assistant?.meta['postProcess']).toContain('post-process "test:suffix" applied');
    } finally {
      cleanup();
    }
  });

  it('keeps serving messages with corrupted meta.generation and rejects it via the parser', async () => {
    const chat = await app.inject({ method: 'POST', url: '/api/v2/chats', payload: {} });
    const chatId = chat.json().id as string;
    const gen = await app.inject({
      method: 'POST',
      url: `/api/v2/chats/${chatId}/generate`,
      payload: { userMessage: 'meta probe' },
    });
    expect(gen.statusCode).toBe(200);

    const readAssistant = async (): Promise<{ id: string; meta: Record<string, unknown> }> => {
      const messages = await app.inject({
        method: 'GET',
        url: `/api/v2/chats/${chatId}/messages?order=asc`,
      });
      return (
        messages.json().items as Array<{ id: string; role: string; meta: Record<string, unknown> }>
      ).find((message) => message.role === 'assistant') as {
        id: string;
        meta: Record<string, unknown>;
      };
    };

    const generated = await readAssistant();
    expect(parseMessageGenerationMeta(generated.meta['generation'])).not.toBeNull();

    // Corrupt meta.generation through a plain PATCH (meta is an open record,
    // so the write succeeds); the message must stay readable and the parser
    // must reject the garbage without throwing.
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v2/chats/${chatId}/messages/${generated.id}`,
      payload: { meta: { generation: { generationId: 42, durationMs: 'nope' } } },
    });
    expect(patched.statusCode, patched.payload).toBe(200);
    const patchedBody = patched.json() as { meta: Record<string, unknown> };
    expect(parseMessageGenerationMeta(patchedBody.meta['generation'])).toBeNull();

    const after = await readAssistant();
    expect(after.id).toBe(generated.id);
    expect(parseMessageGenerationMeta(after.meta['generation'])).toBeNull();
  });
  it('rejects message and branch mutations through a different chat', async () => {
    const firstChat = await app.inject({
      method: 'POST',
      url: '/api/v2/chats',
      payload: { title: 'First' },
    });
    const secondChat = await app.inject({
      method: 'POST',
      url: '/api/v2/chats',
      payload: { title: 'Second' },
    });
    const firstChatId = firstChat.json().id as string;
    const secondChatId = secondChat.json().id as string;

    const created = await app.inject({
      method: 'POST',
      url: `/api/v2/chats/${firstChatId}/messages`,
      payload: { role: 'user', content: 'keep me' },
    });
    const messageId = created.json().id as string;
    const crossChatDelete = await app.inject({
      method: 'DELETE',
      url: `/api/v2/chats/${secondChatId}/messages/${messageId}`,
    });
    expect(crossChatDelete.statusCode).toBe(404);
    expect(crossChatDelete.json().code).toBe('MESSAGE_NOT_FOUND');
    const retained = await app.inject({
      method: 'GET',
      url: `/api/v2/chats/${firstChatId}/messages?order=asc`,
    });
    expect(retained.json().items).toEqual([
      expect.objectContaining({ id: messageId, content: 'keep me' }),
    ]);

    await app.inject({
      method: 'POST',
      url: `/api/v2/chats/${firstChatId}/generate`,
      payload: { userMessage: 'variant source' },
    });
    const generatedMessages = (
      await app.inject({
        method: 'GET',
        url: `/api/v2/chats/${firstChatId}/messages?order=asc`,
      })
    ).json().items as Array<{ id: string; role: string; content: string }>;
    const assistant = generatedMessages.find((message) => message.role === 'assistant');
    expect(assistant).toBeDefined();
    await app.inject({
      method: 'PATCH',
      url: `/api/v2/chats/${firstChatId}/messages/${assistant?.id}`,
      payload: { content: 'archived content' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v2/chats/${firstChatId}/generate`,
      payload: { regenerate: true },
    });
    const variants = (
      await app.inject({
        method: 'GET',
        url: `/api/v2/chats/${firstChatId}/messages/${assistant?.id}/variants`,
      })
    ).json().items as Array<{ id: string; content: string }>;
    expect(variants).toHaveLength(1);
    const beforeCrossChatActivation = (
      await app.inject({
        method: 'GET',
        url: `/api/v2/chats/${firstChatId}/messages?order=asc`,
      })
    ).json().items as Array<{ id: string; content: string }>;
    const currentContent = beforeCrossChatActivation.find(
      (message) => message.id === assistant?.id,
    )?.content;

    const crossChatActivation = await app.inject({
      method: 'POST',
      url: `/api/v2/chats/${secondChatId}/messages/${assistant?.id}/variants/${variants[0]?.id}/activate`,
    });
    expect(crossChatActivation.statusCode).toBe(404);
    expect(crossChatActivation.json().code).toBe('MESSAGE_NOT_FOUND');
    const afterCrossChatActivation = (
      await app.inject({
        method: 'GET',
        url: `/api/v2/chats/${firstChatId}/messages?order=asc`,
      })
    ).json().items as Array<{ id: string; content: string }>;
    expect(afterCrossChatActivation.find((message) => message.id === assistant?.id)?.content).toBe(
      currentContent,
    );

    const firstBranches = (
      await app.inject({ method: 'GET', url: `/api/v2/chats/${firstChatId}/branches` })
    ).json().branches as Array<{ id: string }>;
    const crossChatBranch = await app.inject({
      method: 'PATCH',
      url: `/api/v2/chats/${secondChatId}`,
      payload: { activeBranchId: firstBranches[0]?.id },
    });
    expect(crossChatBranch.statusCode).toBe(404);
    expect(crossChatBranch.json().code).toBe('CHAT_BRANCH_NOT_FOUND');
    const unchangedSecondChat = await app.inject({
      method: 'GET',
      url: `/api/v2/chats/${secondChatId}`,
    });
    expect(unchangedSecondChat.json().activeBranchId).not.toBe(firstBranches[0]?.id);
  });
});

describe('lorebooks', () => {
  it('supports CRUD, entry management, FTS search and generation injection', async () => {
    const char = await app.inject({
      method: 'POST',
      url: '/api/v2/characters',
      payload: { name: 'LoreBot' },
    });
    const characterId = char.json().id as string;

    // Book linked to the character, with an inline keyword entry.
    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/lorebooks',
      payload: {
        name: 'World of Tests',
        description: 'character book',
        characterId,
        entries: [{ keys: ['ancient map'], content: 'The ancient map leads north.' }],
      },
    });
    expect(created.statusCode, created.payload).toBe(200);
    const bookId = created.json().id as string;
    expect(created.json().characterId).toBe(characterId);

    // Constant entries are always injected.
    const constant = await app.inject({
      method: 'POST',
      url: `/api/v2/lorebooks/${bookId}/entries`,
      payload: { keys: ['unused'], content: 'The sky is green here.', constant: true },
    });
    expect(constant.statusCode).toBe(200);
    const entryId = constant.json().id as string;

    const list = await app.inject({ method: 'GET', url: `/api/v2/lorebooks/${bookId}/entries` });
    expect(list.json().items.length).toBe(2);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v2/lorebooks/${bookId}/entries/${entryId}`,
      payload: { position: 5 },
    });
    expect(patched.json().position).toBe(5);

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/v2/lorebooks/${bookId}`,
      payload: { description: 'updated description' },
    });
    expect(updated.json().description).toBe('updated description');

    // FTS over lore entries (scope from ТЗ §12).
    const search = await app.inject({
      method: 'GET',
      url: '/api/v2/search?q=ancient&scope=lorebooks',
    });
    expect(search.statusCode).toBe(200);
    const results = search.json().results as Array<{ scope: string; title: string }>;
    expect(results.some((r) => r.scope === 'lorebooks' && r.title === 'World of Tests')).toBe(true);

    // Generation must assemble the lore blocks into the prompt: character
    // system prompt + 2 lore system blocks + user message = 4 messages.
    const chat = await app.inject({
      method: 'POST',
      url: '/api/v2/chats',
      payload: { characterId },
    });
    const chatId = chat.json().id as string;
    const gen = await app.inject({
      method: 'POST',
      url: `/api/v2/chats/${chatId}/generate`,
      payload: { userMessage: 'tell me about the ancient map' },
    });
    expect(gen.statusCode).toBe(200);
    expect(gen.payload).toContain('"type":"done"');
    const messages = await app.inject({
      method: 'GET',
      url: `/api/v2/chats/${chatId}/messages?order=asc`,
    });
    const assistant = (
      messages.json().items as Array<{ role: string; meta: Record<string, unknown> }>
    ).at(-1);
    expect(assistant?.role).toBe('assistant');
    const diagnostics = assistant?.meta['diagnostics'] as string[];
    expect(diagnostics.some((d) => d.includes('assembled 4 message(s)'))).toBe(true);

    // Soft delete hides the book; restore brings it back.
    const del = await app.inject({ method: 'DELETE', url: `/api/v2/lorebooks/${bookId}` });
    expect(del.json().ok).toBe(true);
    const missing = await app.inject({ method: 'GET', url: `/api/v2/lorebooks/${bookId}` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('LOREBOOK_NOT_FOUND');
    const restored = await app.inject({
      method: 'POST',
      url: `/api/v2/lorebooks/${bookId}/restore`,
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().name).toBe('World of Tests');
  });
});

describe('presets', () => {
  it('creates, filters by kind, patches and deletes presets', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/presets',
      payload: {
        kind: 'generation',
        name: 'Creative',
        data: { maxContextTokens: 16032, generationDefaults: { temperature: 1.2 } },
      },
    });
    expect(created.statusCode, created.payload).toBe(200);
    const id = created.json().id as string;

    const sameKind = await app.inject({ method: 'GET', url: '/api/v2/presets?kind=generation' });
    expect((sameKind.json().items as Array<{ id: string }>).some((p) => p.id === id)).toBe(true);
    const otherKind = await app.inject({ method: 'GET', url: '/api/v2/presets?kind=instruct' });
    expect((otherKind.json().items as Array<{ id: string }>).some((p) => p.id === id)).toBe(false);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v2/presets/${id}`,
      payload: { name: 'Creative v2' },
    });
    expect(patched.json().name).toBe('Creative v2');
    expect(patched.json().data).toMatchObject({ generationDefaults: { temperature: 1.2 } });

    const del = await app.inject({ method: 'DELETE', url: `/api/v2/presets/${id}` });
    expect(del.json().ok).toBe(true);
    const missing = await app.inject({ method: 'GET', url: `/api/v2/presets/${id}` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('PRESET_NOT_FOUND');

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v2/presets',
      payload: { kind: 'Bad Kind!', name: 'x' },
    });
    expect(invalid.statusCode).toBe(422);

    const invalidGeneration = await app.inject({
      method: 'POST',
      url: '/api/v2/presets',
      payload: { kind: 'generation', name: 'Invalid generation', data: { temperature: 1.2 } },
    });
    expect(invalidGeneration.statusCode).toBe(422);

    const promptPreset = await app.inject({
      method: 'POST',
      url: '/api/v2/presets',
      payload: {
        kind: 'prompt-template',
        name: 'Story order',
        data: { ...DEFAULT_PROMPT_TEMPLATE, mode: 'text' },
      },
    });
    expect(promptPreset.statusCode, promptPreset.payload).toBe(200);

    const incompletePrompt = await app.inject({
      method: 'POST',
      url: '/api/v2/presets',
      payload: {
        kind: 'prompt-template',
        name: 'Incomplete',
        data: { ...DEFAULT_PROMPT_TEMPLATE, blocks: DEFAULT_PROMPT_TEMPLATE.blocks.slice(1) },
      },
    });
    expect(incompletePrompt.statusCode).toBe(422);
  });
});

describe('profiles', () => {
  it('auto-creates the default profile, renames it and exports a portable archive', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v2/profiles' });
    expect(list.statusCode, list.payload).toBe(200);
    const body = list.json() as {
      items: Array<{ id: string; name: string }>;
      currentId: string;
    };
    expect(body.items.length).toBe(1);
    expect(body.items[0]?.name).toBe('Default');
    expect(body.currentId).toBe(body.items[0]?.id);

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/v2/profiles/${body.currentId}`,
      payload: { name: 'Main' },
    });
    expect(renamed.json().name).toBe('Main');

    const missing = await app.inject({
      method: 'PATCH',
      url: '/api/v2/profiles/nonexistent',
      payload: { name: 'X' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('PROFILE_NOT_FOUND');

    const exported = await app.inject({ method: 'GET', url: '/api/v2/profiles/export' });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toBe('application/zip');
    // ZIP magic bytes; the archive carries the DB snapshot + manifest.
    expect(exported.rawPayload.subarray(0, 2).toString()).toBe('PK');
    expect(exported.rawPayload.length).toBeGreaterThan(1000);
  });
});

describe('message variants (swipes)', () => {
  it('regeneration archives the reply as a variant and activate swaps it back', async () => {
    const chat = await app.inject({ method: 'POST', url: '/api/v2/chats', payload: {} });
    const chatId = chat.json().id as string;
    const gen = await app.inject({
      method: 'POST',
      url: `/api/v2/chats/${chatId}/generate`,
      payload: { userMessage: 'one' },
    });
    expect(gen.statusCode).toBe(200);

    const read = async (): Promise<
      Array<{ id: string; role: string; content: string; meta: Record<string, unknown> }>
    > => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v2/chats/${chatId}/messages?order=asc`,
      });
      return response.json().items;
    };

    let items = await read();
    expect(items.length).toBe(2);
    const assistantId = items[1]?.id as string;
    const firstGeneration = parseMessageGenerationMeta(items[1]?.meta['generation']);
    expect(firstGeneration).not.toBeNull();
    const firstGenerationId = firstGeneration?.generationId;
    expect(items[1]?.meta['model']).toBe('echo');

    // Edit the reply so the archived variant differs from the regenerated one.
    const edited = await app.inject({
      method: 'PATCH',
      url: `/api/v2/chats/${chatId}/messages/${assistantId}`,
      payload: { content: 'manual edit' },
    });
    expect(edited.statusCode).toBe(200);

    const regen = await app.inject({
      method: 'POST',
      url: `/api/v2/chats/${chatId}/generate`,
      payload: { regenerate: true },
    });
    expect(regen.statusCode).toBe(200);

    items = await read();
    expect(items.length).toBe(2); // rewritten in place, not deleted + re-created
    expect(items[1]?.id).toBe(assistantId);
    expect(items[1]?.content).not.toBe('manual edit');
    const regeneratedContent = items[1]?.content;

    // Regeneration REPLACES meta.generation with a fresh, still-valid object
    // while the legacy top-level meta.model stays in place.
    const regeneratedGeneration = parseMessageGenerationMeta(items[1]?.meta['generation']);
    expect(regeneratedGeneration).not.toBeNull();
    expect(regeneratedGeneration?.generationId).not.toBe(firstGenerationId);
    expect(regeneratedGeneration?.model).toBe('echo');
    expect(regeneratedGeneration?.durationMs).toBeGreaterThanOrEqual(0);
    expect(regeneratedGeneration?.usage).not.toBeNull();
    expect(items[1]?.meta['model']).toBe('echo');

    const variants = (
      await app.inject({
        method: 'GET',
        url: `/api/v2/chats/${chatId}/messages/${assistantId}/variants`,
      })
    ).json().items as Array<{ id: string; content: string }>;
    expect(variants.length).toBe(1);
    expect(variants[0]?.content).toBe('manual edit');

    const activated = await app.inject({
      method: 'POST',
      url: `/api/v2/chats/${chatId}/messages/${assistantId}/variants/${variants[0]?.id}/activate`,
    });
    expect(activated.statusCode, activated.payload).toBe(200);
    expect(activated.json().content).toBe('manual edit');

    const variantsAfter = (
      await app.inject({
        method: 'GET',
        url: `/api/v2/chats/${chatId}/messages/${assistantId}/variants`,
      })
    ).json().items as Array<{ id: string; content: string }>;
    expect(variantsAfter.length).toBe(1);
    expect(variantsAfter[0]?.content).toBe(regeneratedContent);
  });
});

describe('settings', () => {
  it('reads defaults and patches language', async () => {
    const initial = await app.inject({ method: 'GET', url: '/api/v2/settings' });
    expect(initial.json().language).toBe('en');
    expect(initial.json().contextStrategy).toBe('truncate');
    expect(initial.json().maxContextTokens).toBe(16032);
    expect(initial.json().instructFormat).toBeNull();
    expect(initial.json().instructFormatId).toBeNull();
    expect(initial.json().promptTemplate).toMatchObject({
      mode: 'chat',
      postHistoryInstructions:
        'Keep the roleplay engaging. Drive the story forward proactively while staying in character.',
    });
    expect(initial.json().promptTemplate.blocks).toHaveLength(12);

    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/v2/settings',
      payload: { language: 'ru', contextStrategy: 'summarize' },
    });
    expect(patched.json().language).toBe('ru');
    expect(patched.json().contextStrategy).toBe('summarize');

    const custom = await app.inject({
      method: 'PATCH',
      url: '/api/v2/settings',
      payload: { contextStrategy: 'plugin.custom' },
    });
    expect(custom.statusCode, custom.payload).toBe(200);
    expect(custom.json().contextStrategy).toBe('plugin.custom');

    const generation = await app.inject({
      method: 'PATCH',
      url: '/api/v2/settings',
      payload: {
        maxContextTokens: 32768,
        generationDefaults: { topK: 40, minP: 0.05, stream: false },
        instructFormat: {
          id: 'custom-test',
          version: 1,
          system: 'S:{{{content}}}',
          user: 'U:{{{content}}}',
          assistant: 'A:{{{content}}}',
          tool: 'T:{{{content}}}',
          promptSuffix: 'A:',
          stopStrings: ['STOP'],
        },
      },
    });
    expect(generation.statusCode, generation.payload).toBe(200);
    expect(generation.json()).toMatchObject({
      maxContextTokens: 32768,
      generationDefaults: { topK: 40, minP: 0.05, stream: false },
      instructFormat: { id: 'custom-test', stopStrings: ['STOP'] },
    });

    const invalid = await app.inject({
      method: 'PATCH',
      url: '/api/v2/settings',
      payload: { contextStrategy: 'unsafe-custom-id' },
    });
    expect(invalid.statusCode).toBe(422);

    const promptTemplate = await app.inject({
      method: 'PATCH',
      url: '/api/v2/settings',
      payload: { promptTemplate: { ...DEFAULT_PROMPT_TEMPLATE, mode: 'text' } },
    });
    expect(promptTemplate.statusCode, promptTemplate.payload).toBe(200);
    expect(promptTemplate.json().promptTemplate.mode).toBe('text');

    const customPromptTemplate = await app.inject({
      method: 'PATCH',
      url: '/api/v2/settings',
      payload: {
        promptTemplate: {
          ...DEFAULT_PROMPT_TEMPLATE,
          mode: 'text',
          blocks: [
            ...DEFAULT_PROMPT_TEMPLATE.blocks.slice(0, -2),
            {
              id: 'custom-emotion',
              enabled: true,
              name: 'Emotion cue',
              role: 'assistant',
              content: 'Show visible tension.',
              injectionPosition: 'in-chat',
              injectionDepth: 1,
              injectionOrder: 90,
              triggers: ['normal', 'regenerate'],
            },
            ...DEFAULT_PROMPT_TEMPLATE.blocks.slice(-2),
          ],
        },
      },
    });
    expect(customPromptTemplate.statusCode, customPromptTemplate.payload).toBe(200);
    expect(customPromptTemplate.json().promptTemplate.blocks.at(-3)).toMatchObject({
      id: 'custom-emotion',
      role: 'assistant',
      injectionPosition: 'in-chat',
    });
    expect(
      customPromptTemplate
        .json()
        .promptTemplate.blocks.slice(-2)
        .map((block: { id: string }) => block.id),
    ).toEqual(['chat-history', 'post-history-instructions']);

    const modelBoundTemplate = await app.inject({
      method: 'PATCH',
      url: '/api/v2/settings',
      payload: {
        promptTemplate: {
          ...DEFAULT_PROMPT_TEMPLATE,
          blocks: DEFAULT_PROMPT_TEMPLATE.blocks.map((block, index) =>
            index === 0 ? { ...block, model: 'gpt-4o' } : block,
          ),
        },
      },
    });
    expect(modelBoundTemplate.statusCode, modelBoundTemplate.payload).toBe(200);
    expect(modelBoundTemplate.json().promptTemplate.blocks[0]).toMatchObject({
      id: 'main-prompt',
      model: 'gpt-4o',
    });

    const incompletePromptTemplate = await app.inject({
      method: 'PATCH',
      url: '/api/v2/settings',
      payload: {
        promptTemplate: {
          ...DEFAULT_PROMPT_TEMPLATE,
          blocks: DEFAULT_PROMPT_TEMPLATE.blocks.slice(0, 11),
        },
      },
    });
    expect(incompletePromptTemplate.statusCode).toBe(422);

    const misplacedTerminalBlocks = await app.inject({
      method: 'PATCH',
      url: '/api/v2/settings',
      payload: {
        promptTemplate: {
          ...DEFAULT_PROMPT_TEMPLATE,
          blocks: [
            DEFAULT_PROMPT_TEMPLATE.blocks.at(-1),
            ...DEFAULT_PROMPT_TEMPLATE.blocks.slice(0, -1),
          ],
        },
      },
    });
    expect(misplacedTerminalBlocks.statusCode).toBe(422);
    expect(misplacedTerminalBlocks.json()).toMatchObject({
      code: 'VALIDATION',
      params: { path: 'promptTemplate.blocks', reason: 'BLOCK_ORDER_INVALID' },
    });
  });
});

describe('providers', () => {
  it('returns the fixed provider source catalog', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v2/providers/catalog' });
    expect(response.statusCode, response.payload).toBe(200);
    const body = response.json();
    expect(body.items.map((item: { id: string }) => item.id)).toEqual([
      'nanogpt',
      'openai',
      'openai-compatible',
      'anthropic',
      'deepseek',
      'google-ai-studio',
      'groq',
      'fireworks-ai',
      'cohere',
      'mistralai',
      'chutes',
      'electron-hub',
      'text-completion',
      'ooba',
      'koboldcpp',
      'vllm',
      'ollama',
      'novelai',
      'ai-horde',
      'koboldai',
    ]);
    expect(body.items.find((item: { id: string }) => item.id === 'nanogpt')).toMatchObject({
      adapterKind: 'openai-compatible',
      samplerSupport: [
        'temperature',
        'topP',
        'frequencyPenalty',
        'presencePenalty',
        'seed',
        'reasoningEffort',
        'topK',
        'minP',
        'topA',
        'repetitionPenalty',
      ],
      reasoningEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
    });
    expect(body.items.find((item: { id: string }) => item.id === 'anthropic')).toMatchObject({
      adapterKind: 'anthropic',
      defaultBaseUrl: null,
      apiKeyRequired: true,
      baseUrlEditable: false,
      samplerSupport: ['reasoning', 'reasoningEffort'],
      reasoningEfforts: ['low', 'medium', 'high'],
    });
    expect(body.items.find((item: { id: string }) => item.id === 'openai')).toMatchObject({
      adapterKind: 'openai-compatible',
      defaultBaseUrl: 'https://api.openai.com/v1',
    });
    // Classic SillyTavern text-completion backends serialize the prompt as text.
    expect(body.items.find((item: { id: string }) => item.id === 'ooba')).toMatchObject({
      adapterKind: 'text-completion',
      defaultBaseUrl: 'http://127.0.0.1:5000/v1',
      apiKeyRequired: false,
      baseUrlEditable: true,
    });
    expect(body.items.find((item: { id: string }) => item.id === 'novelai')).toMatchObject({
      adapterKind: 'novelai',
      defaultBaseUrl: 'https://api.novelai.net',
      apiKeyRequired: true,
    });
    expect(body.items.find((item: { id: string }) => item.id === 'ai-horde')).toMatchObject({
      adapterKind: 'ai-horde',
      defaultBaseUrl: 'https://stablehorde.net',
      apiKeyRequired: false,
    });
    expect(body.items.find((item: { id: string }) => item.id === 'koboldai')).toMatchObject({
      adapterKind: 'koboldai',
      defaultBaseUrl: null,
      apiKeyRequired: false,
    });
  });

  it('tests a stored provider without returning its secret', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/providers',
      payload: {
        kind: 'echo',
        name: 'Offline test',
        model: 'echo',
        apiKey: 'never-return-this',
      },
    });
    expect(created.statusCode, created.payload).toBe(200);

    const response = await app.inject({
      method: 'POST',
      url: `/api/v2/providers/${created.json().id}/test`,
      payload: { message: 'Hello provider' },
    });
    expect(response.statusCode, response.payload).toBe(200);
    expect(response.json()).toMatchObject({
      text: 'You said: "Hello provider". This is the offline echo provider.',
      usage: {
        promptTokens: expect.any(Number),
        completionTokens: expect.any(Number),
        totalTokens: expect.any(Number),
      },
    });
    expect(response.payload).not.toContain('never-return-this');
  });

  it('applies catalog defaults, validates source-kind pairs, and preserves write-only keys', async () => {
    const missingKey = await app.inject({
      method: 'POST',
      url: '/api/v2/providers',
      payload: {
        kind: 'openai-compatible',
        name: 'DeepSeek',
        model: 'deepseek-chat',
        settings: { source: 'deepseek' },
      },
    });
    expect(missingKey.statusCode, missingKey.payload).toBe(200);
    expect(missingKey.json()).toMatchObject({
      baseUrl: 'https://api.deepseek.com',
      hasApiKey: false,
      settings: { source: 'deepseek' },
    });

    const missingKeyModels = await app.inject({
      method: 'GET',
      url: `/api/v2/providers/${missingKey.json().id}/models`,
    });
    expect(missingKeyModels.statusCode).toBe(422);
    expect(missingKeyModels.json()).toMatchObject({
      code: 'PROVIDER_CONFIG_INVALID',
      params: { issues: [{ path: 'apiKey' }] },
    });

    const mismatch = await app.inject({
      method: 'POST',
      url: '/api/v2/providers',
      payload: {
        kind: 'anthropic',
        name: 'Wrong source',
        model: 'claude-opus-4-7',
        apiKey: 'secret',
        settings: { source: 'openai' },
      },
    });
    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.json().code).toBe('PROVIDER_CONFIG_INVALID');

    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/providers',
      payload: {
        kind: 'openai-compatible',
        name: 'OpenAI',
        model: 'gpt-test',
        apiKey: 'stored-key',
        settings: { source: 'openai' },
      },
    });
    expect(created.statusCode, created.payload).toBe(200);
    expect(created.json()).toMatchObject({
      baseUrl: 'https://api.openai.com/v1',
      hasApiKey: true,
      settings: { source: 'openai' },
    });

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/v2/providers/${created.json().id}`,
      payload: { name: 'Renamed OpenAI' },
    });
    expect(renamed.statusCode, renamed.payload).toBe(200);
    expect(renamed.json()).toMatchObject({ name: 'Renamed OpenAI', hasApiKey: true });
    const fullConfig = await database.repos.providerConfigs.getFullConfig(created.json().id);
    expect(fullConfig?.apiKey).toBe('stored-key');

    const clearRequiredKey = await app.inject({
      method: 'PATCH',
      url: `/api/v2/providers/${created.json().id}`,
      payload: { apiKey: null },
    });
    expect(clearRequiredKey.statusCode).toBe(422);

    const custom = await app.inject({
      method: 'POST',
      url: '/api/v2/providers',
      payload: {
        kind: 'openai-compatible',
        name: 'Local compatible',
        baseUrl: 'http://127.0.0.1:1234/v1',
        settings: { source: 'openai-compatible' },
      },
    });
    expect(custom.statusCode, custom.payload).toBe(200);
    expect(custom.json()).toMatchObject({
      hasApiKey: false,
      settings: {
        source: 'openai-compatible',
        samplerCompatibility: 'standard',
      },
    });
  });

  it('validates SillyTavern-style additional parameters and post-processing', async () => {
    const valid = await app.inject({
      method: 'POST',
      url: '/api/v2/providers',
      payload: {
        kind: 'echo',
        name: 'Additional params',
        model: 'echo',
        settings: {
          promptPostProcessing: 'merge',
          customIncludeBody: { top_k: 20 },
          customExcludeBody: ['frequency_penalty'],
          customIncludeHeaders: { 'X-Custom': 'value' },
        },
      },
    });
    expect(valid.statusCode, valid.payload).toBe(200);
    // Header values are write-only secrets: the response carries a masked
    // preview, never the raw value (PROV-32).
    expect(valid.json().settings).toMatchObject({
      promptPostProcessing: 'merge',
      customIncludeBody: { top_k: 20 },
      customExcludeBody: ['frequency_penalty'],
    });
    expect(valid.json().settings.customIncludeHeaders).toEqual({ 'X-Custom': '•alue' });
    expect(valid.json().settings.customIncludeHeaders['X-Custom']).not.toContain('value');

    // Round-trip: saving the masked preview back must not corrupt the stored
    // secret — the masked value counts as "unchanged".
    const providerId = valid.json().id as string;
    const roundTrip = await app.inject({
      method: 'PATCH',
      url: `/api/v2/providers/${providerId}`,
      payload: { settings: valid.json().settings },
    });
    expect(roundTrip.statusCode, roundTrip.payload).toBe(200);
    expect(roundTrip.json().settings.customIncludeHeaders).toEqual({ 'X-Custom': '•alue' });
    const reread = await app.inject({ method: 'GET', url: '/api/v2/providers' });
    const rereadSettings = reread
      .json()
      .items.find((entry: { id: string }) => entry.id === providerId)?.settings;
    expect(rereadSettings.customIncludeHeaders).toEqual({ 'X-Custom': '•alue' });

    const badBody = await app.inject({
      method: 'POST',
      url: '/api/v2/providers',
      payload: {
        kind: 'echo',
        name: 'Bad include body',
        model: 'echo',
        settings: { customIncludeBody: ['not', 'an', 'object'] },
      },
    });
    expect(badBody.statusCode).toBe(422);
    expect(badBody.json()).toMatchObject({
      code: 'PROVIDER_CONFIG_INVALID',
      params: { issues: [{ path: 'settings.customIncludeBody' }] },
    });

    const forbiddenHeader = await app.inject({
      method: 'POST',
      url: '/api/v2/providers',
      payload: {
        kind: 'echo',
        name: 'Forbidden header',
        model: 'echo',
        settings: { customIncludeHeaders: { Authorization: 'Bearer leak' } },
      },
    });
    expect(forbiddenHeader.statusCode).toBe(422);
    expect(forbiddenHeader.json().code).toBe('PROVIDER_CONFIG_INVALID');

    // Adapter-reserved body keys are rejected at write time (PROV-30): an
    // accepted `stream: false` would yield silent empty generations.
    const reservedBodyKey = await app.inject({
      method: 'POST',
      url: '/api/v2/providers',
      payload: {
        kind: 'echo',
        name: 'Reserved body key',
        model: 'echo',
        settings: { customIncludeBody: { stream: false, top_k: 20 } },
      },
    });
    expect(reservedBodyKey.statusCode).toBe(422);
    expect(reservedBodyKey.json()).toMatchObject({
      code: 'PROVIDER_CONFIG_INVALID',
      params: {
        issues: [{ path: 'settings.customIncludeBody', code: 'reservedBodyKey' }],
      },
    });

    const reservedExcludeKey = await app.inject({
      method: 'POST',
      url: '/api/v2/providers',
      payload: {
        kind: 'echo',
        name: 'Reserved exclude key',
        model: 'echo',
        settings: { customExcludeBody: ['stream'] },
      },
    });
    expect(reservedExcludeKey.statusCode).toBe(422);
    expect(reservedExcludeKey.json()).toMatchObject({
      code: 'PROVIDER_CONFIG_INVALID',
      params: {
        issues: [{ path: 'settings.customExcludeBody', code: 'reservedExcludeKey' }],
      },
    });

    const badMode = await app.inject({
      method: 'POST',
      url: '/api/v2/providers',
      payload: {
        kind: 'echo',
        name: 'Bad post-processing',
        model: 'echo',
        settings: { promptPostProcessing: 'scramble' },
      },
    });
    expect(badMode.statusCode).toBe(422);
    expect(badMode.json()).toMatchObject({
      code: 'PROVIDER_CONFIG_INVALID',
      params: { issues: [{ path: 'settings.promptPostProcessing' }] },
    });
  });

  it('rejects explicit generation through a disabled provider config', async () => {
    const provider = await app.inject({
      method: 'POST',
      url: '/api/v2/providers',
      payload: {
        kind: 'echo',
        name: 'Disabled echo',
        model: 'echo',
        enabled: false,
      },
    });
    const character = await app.inject({
      method: 'POST',
      url: '/api/v2/characters',
      payload: { name: 'Disabled provider test' },
    });
    const chat = await app.inject({
      method: 'POST',
      url: '/api/v2/chats',
      payload: { characterId: character.json().id },
    });

    const generation = await app.inject({
      method: 'POST',
      url: `/api/v2/chats/${chat.json().id}/generate`,
      payload: {
        providerConfigId: provider.json().id,
        userMessage: 'Do not generate',
      },
    });
    const events = generation.payload
      .split('\n\n')
      .map((block) => block.trim())
      .filter((block) => block.startsWith('data:'))
      .map(
        (block) =>
          JSON.parse(block.slice(5).trim()) as {
            type: string;
            code?: string;
          },
      );
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'PROVIDER_DISABLED' });
    expect(events.some((event) => event.type === 'done')).toBe(false);
  });

  it('stores an API key but never exposes it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v2/providers',
      payload: {
        kind: 'openai-compatible',
        name: 'Local LLM',
        baseUrl: 'http://127.0.0.1:11434/v1',
        apiKey: 'sk-super-secret',
      },
    });
    const body = res.json();
    expect(body.hasApiKey).toBe(true);
    expect(JSON.stringify(body)).not.toContain('sk-super-secret');

    const list = await app.inject({ method: 'GET', url: '/api/v2/providers' });
    expect(JSON.stringify(list.json())).not.toContain('sk-super-secret');
  });

  it('generates end-to-end through a text-completion backend with a mocked upstream', async () => {
    // Capture what the adapter actually posts so we can prove the prompt was
    // serialized as text (a `prompt` string, never a `messages` array).
    const completionBodies: Array<Record<string, unknown>> = [];
    const modelRequests: string[] = [];

    const sseResponse = (chunks: string[]): Response => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };

    const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/v1/models') && method === 'GET') {
        modelRequests.push(url);
        return new Response(
          JSON.stringify({ data: [{ id: 'llama-local', context_length: 8192 }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.endsWith('/v1/completions') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        completionBodies.push(body);
        if (body['stream'] === true) {
          return sseResponse([
            JSON.stringify({ choices: [{ text: 'Hello' }] }),
            JSON.stringify({ choices: [{ text: ' from ooba' }] }),
            JSON.stringify({
              choices: [{ text: '' }],
              usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
            }),
          ]);
        }
        return new Response(
          JSON.stringify({
            choices: [{ text: 'Test reply from ooba' }],
            usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', mockFetch);

    try {
      // Catalog default base URL is applied for the ooba source; no key needed.
      const created = await app.inject({
        method: 'POST',
        url: '/api/v2/providers',
        payload: {
          kind: 'text-completion',
          name: 'Ooba local',
          model: 'llama-local',
          settings: { source: 'ooba' },
        },
      });
      expect(created.statusCode, created.payload).toBe(200);
      expect(created.json()).toMatchObject({
        baseUrl: 'http://127.0.0.1:5000/v1',
        hasApiKey: false,
        settings: { source: 'ooba' },
      });
      const providerId = created.json().id as string;

      // Model discovery hits the OpenAI-compatible /v1/models endpoint.
      const models = await app.inject({
        method: 'GET',
        url: `/api/v2/providers/${providerId}/models`,
      });
      expect(models.statusCode, models.payload).toBe(200);
      expect(models.json().models).toEqual([
        { id: 'llama-local', name: 'llama-local', contextLimit: 8192 },
      ]);
      expect(modelRequests[0]).toBe('http://127.0.0.1:5000/v1/models');

      // Connection test posts a non-streaming completion and returns the text.
      const test = await app.inject({
        method: 'POST',
        url: `/api/v2/providers/${providerId}/test`,
        payload: { message: 'ping' },
      });
      expect(test.statusCode, test.payload).toBe(200);
      expect(test.json()).toMatchObject({ text: 'Test reply from ooba' });

      // Full generation through the chat pipeline streams and persists the reply.
      const character = await app.inject({
        method: 'POST',
        url: '/api/v2/characters',
        payload: { name: 'OobaBot' },
      });
      const chat = await app.inject({
        method: 'POST',
        url: '/api/v2/chats',
        payload: { characterId: character.json().id },
      });
      const chatId = chat.json().id as string;

      const gen = await app.inject({
        method: 'POST',
        url: `/api/v2/chats/${chatId}/generate`,
        payload: {
          providerConfigId: providerId,
          userMessage: 'hello ooba',
          overrides: { stream: true },
        },
      });
      expect(gen.statusCode, gen.payload).toBe(200);
      expect(gen.headers['content-type']).toContain('text/event-stream');
      const events = gen.payload
        .split('\n\n')
        .map((block) => block.trim())
        .filter((block) => block.startsWith('data:'))
        .map((block) => JSON.parse(block.slice(5).trim()) as { type: string; text?: string });
      expect(events[0]?.type).toBe('start');
      expect(events.some((e) => e.type === 'done')).toBe(true);

      const streamed = completionBodies.filter((body) => body['stream'] === true);
      expect(streamed.length).toBeGreaterThan(0);
      // Text-completion backends receive a serialized prompt, not chat messages.
      for (const body of completionBodies) {
        expect(typeof body['prompt']).toBe('string');
        expect((body['prompt'] as string).length).toBeGreaterThan(0);
        expect(body['messages']).toBeUndefined();
        expect(body['model']).toBe('llama-local');
      }
      expect(streamed[0]?.['prompt']).toContain('hello ooba');

      const messages = await app.inject({
        method: 'GET',
        url: `/api/v2/chats/${chatId}/messages?order=asc`,
      });
      const items = messages.json().items as Array<{ role: string; content: string }>;
      expect(items[0]).toMatchObject({ role: 'user', content: 'hello ooba' });
      expect(items[1]).toMatchObject({ role: 'assistant', content: 'Hello from ooba' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('provider secrets', () => {
  async function makeProvider(name: string): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/providers',
      payload: { kind: 'echo', name, model: 'echo' },
    });
    return created.json().id as string;
  }

  it('reports the exposure flag from server config', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v2/secrets/exposure' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ allowSecretsExposure: false });
  });

  it('404s for secrets of an unknown provider', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v2/providers/does-not-exist/secrets',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('PROVIDER_NOT_FOUND');
  });

  it('creates, lists (masked) and switches the active secret without leaking values', async () => {
    const providerId = await makeProvider('Secrets CRUD');

    const first = await app.inject({
      method: 'POST',
      url: `/api/v2/providers/${providerId}/secrets`,
      payload: { value: 'sk-first-abcd1111', label: 'first' },
    });
    expect(first.statusCode, first.payload).toBe(200);
    expect(first.json().id).toBeTruthy();

    const second = await app.inject({
      method: 'POST',
      url: `/api/v2/providers/${providerId}/secrets`,
      payload: { value: 'sk-second-efgh2222' },
    });
    expect(second.statusCode, second.payload).toBe(200);

    const list = await app.inject({
      method: 'GET',
      url: `/api/v2/providers/${providerId}/secrets`,
    });
    expect(list.statusCode).toBe(200);
    const items = list.json().items as Array<{
      id: string;
      label: string | null;
      active: boolean;
      masked: string;
    }>;
    expect(items).toHaveLength(2);
    // The most recent non-empty key is active; exactly one active overall.
    expect(items.filter((item) => item.active)).toHaveLength(1);
    const activeMasked = items.find((item) => item.active)?.masked;
    // The mask is derived from the opaque reference — non-empty, but never
    // contains a fragment of the actual key (ТЗ §SEC-01).
    expect(activeMasked?.length).toBeGreaterThan(0);
    expect(activeMasked).not.toContain('sk-second-efgh2222');
    // Values are write-only: never serialized in list responses.
    expect(list.payload).not.toContain('sk-first-abcd1111');
    expect(list.payload).not.toContain('sk-second-efgh2222');

    // Activate the first key via PATCH; siblings deactivate.
    const firstId = items.find((item) => item.label === 'first')?.id as string;
    const activated = await app.inject({
      method: 'PATCH',
      url: `/api/v2/providers/${providerId}/secrets/${firstId}`,
      payload: { active: true },
    });
    expect(activated.statusCode, activated.payload).toBe(200);
    expect(activated.json()).toMatchObject({ active: true, label: 'first' });
    // The DB holds only an opaque reference — never the plaintext key.
    const activeRef = await database.repos.providerSecrets.getActiveReference(providerId);
    expect(activeRef).toMatch(/^session:provider:/u);
    expect(activeRef).not.toContain('sk-first-abcd1111');
  });

  it('renames a secret and 404s when patching an unknown secret', async () => {
    const providerId = await makeProvider('Secrets rename');
    const created = await app.inject({
      method: 'POST',
      url: `/api/v2/providers/${providerId}/secrets`,
      payload: { value: 'sk-rename', label: 'old' },
    });
    const secretId = created.json().id as string;

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/v2/providers/${providerId}/secrets/${secretId}`,
      payload: { label: 'production' },
    });
    expect(renamed.statusCode, renamed.payload).toBe(200);
    expect(renamed.json().label).toBe('production');

    const missing = await app.inject({
      method: 'PATCH',
      url: `/api/v2/providers/${providerId}/secrets/nope`,
      payload: { label: 'x' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('PROVIDER_SECRET_NOT_FOUND');
  });

  it('deletes a secret and 404s on an unknown id', async () => {
    const providerId = await makeProvider('Secrets delete');
    const created = await app.inject({
      method: 'POST',
      url: `/api/v2/providers/${providerId}/secrets`,
      payload: { value: 'sk-delete-me' },
    });
    const secretId = created.json().id as string;

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v2/providers/${providerId}/secrets/${secretId}`,
    });
    expect(deleted.statusCode, deleted.payload).toBe(200);
    expect(deleted.json()).toEqual({ ok: true });
    expect(await database.repos.providerSecrets.listByProvider(providerId)).toHaveLength(0);

    const again = await app.inject({
      method: 'DELETE',
      url: `/api/v2/providers/${providerId}/secrets/${secretId}`,
    });
    expect(again.statusCode).toBe(404);
  });

  it('refuses reveal while secrets exposure is disabled', async () => {
    const providerId = await makeProvider('Secrets reveal off');
    const created = await app.inject({
      method: 'POST',
      url: `/api/v2/providers/${providerId}/secrets`,
      payload: { value: 'sk-hidden' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v2/providers/${providerId}/secrets/${created.json().id}/reveal`,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('SECRETS_EXPOSURE_DISABLED');
  });

  it('reveals a secret value only when exposure is enabled server-side', async () => {
    const providerId = await makeProvider('Secrets reveal on');
    const created = await app.inject({
      method: 'POST',
      url: `/api/v2/providers/${providerId}/secrets`,
      payload: { value: 'sk-revealable-9999' },
    });
    const secretId = created.json().id as string;

    const exposed = await buildApp({
      database,
      providers,
      contextStrategies,
      postProcessors,
      config: {
        host: '127.0.0.1',
        port: 0,
        dataDir: paths.root,
        webDir: null,
        logLevel: 'error',
        corsOrigin: 'http://127.0.0.1:5173',
        remoteAccess: false,
        publicOrigin: 'http://127.0.0.1:5173',
        remoteTokenHash: null,
        secureSessionCookies: false,
        safeMode: false,
        allowSecretsExposure: true,
        secretMode: 'session',
        secretPassphrase: null,
        pluginNodePath: process.execPath,
        pluginWorkerPath: null,
        pluginLoaderPath: null,
        providerTimeouts: DEFAULT_PROVIDER_TIMEOUTS,
      },
      secrets: secretsHandle,
      logger: createLogger({ level: 'error' }),
      paths,
    });
    try {
      const res = await exposed.inject({
        method: 'POST',
        url: `/api/v2/providers/${providerId}/secrets/${secretId}/reveal`,
      });
      expect(res.statusCode, res.payload).toBe(200);
      expect(res.json()).toEqual({ value: 'sk-revealable-9999' });
    } finally {
      await exposed.close();
    }
  });

  it('cascade-deletes secrets when the provider config is removed', async () => {
    const providerId = await makeProvider('Secrets cascade');
    await app.inject({
      method: 'POST',
      url: `/api/v2/providers/${providerId}/secrets`,
      payload: { value: 'sk-orphan' },
    });
    expect(await database.repos.providerSecrets.listByProvider(providerId)).toHaveLength(1);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v2/providers/${providerId}`,
    });
    expect(deleted.statusCode).toBe(200);
    expect(await database.repos.providerSecrets.listByProvider(providerId)).toHaveLength(0);
  });
});

describe('search', () => {
  it('finds a character by description', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v2/characters',
      payload: { name: 'Gandalf', description: 'a powerful wizard of Middle-earth' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v2/search?q=wizard&scope=characters',
    });
    const body = res.json();
    expect(body.results.length).toBeGreaterThan(0);
  });
});

describe('backups', () => {
  it('creates and lists a backup', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v2/backups' });
    expect(created.statusCode).toBe(200);
    expect(created.json().id).toContain('backup-');

    const list = await app.inject({ method: 'GET', url: '/api/v2/backups' });
    expect(list.json().items.length).toBeGreaterThan(0);
  });
});

describe('diagnostics and regenerable cache', () => {
  it('returns aggregate redacted state and clears thumbnails without user data', async () => {
    const secret = 'diagnostics-must-never-export-this';
    const secretRef = await secretsHandle.storeValue('provider:diag', 'diag-key', secret);
    await database.repos.providerConfigs.create({
      kind: 'openai-compatible',
      name: 'Diagnostic provider',
      apiKey: secretRef,
      settings: { privateHeader: secret },
    });
    await writeFile(join(paths.thumbnails, 'diagnostic.webp'), Buffer.alloc(17));
    database.sqlite
      .prepare(
        `INSERT OR REPLACE INTO cache_metadata
          (key, relative_path, source_hash, target_size, algorithm_version, mime,
           size_bytes, created_at, last_accessed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'diagnostic-thumbnail',
        'thumbnails/diagnostic.webp',
        'd'.repeat(64),
        256,
        1,
        'image/webp',
        17,
        1,
        1,
      );

    const response = await app.inject({ method: 'GET', url: '/api/v2/diagnostics' });
    expect(response.statusCode, response.payload).toBe(200);
    expect(response.json()).toMatchObject({
      formatVersion: 1,
      database: { integrity: 'ok', schemaVersion: 24 },
      providers: { configured: expect.any(Number), enabled: expect.any(Number) },
      themes: { safeModeAvailable: true },
      privacy: {
        redacted: true,
        secretsIncluded: false,
        userContentIncluded: false,
        absolutePathsIncluded: false,
        logsIncluded: false,
      },
    });
    expect(response.payload).not.toContain(secret);
    expect(response.payload).not.toContain(paths.root);

    const cleared = await app.inject({ method: 'DELETE', url: '/api/v2/diagnostics/cache' });
    expect(cleared.statusCode, cleared.payload).toBe(200);
    expect(cleared.json().removedFiles).toBeGreaterThanOrEqual(1);
    expect(cleared.json().removedBytes).toBeGreaterThanOrEqual(17);
    expect(cleared.json().metadataRowsRemoved).toBeGreaterThanOrEqual(1);

    const characters = await app.inject({ method: 'GET', url: '/api/v2/characters' });
    expect(characters.statusCode).toBe(200);
    expect(characters.json().items.length).toBeGreaterThan(0);
  });

  it('reorders chats manually, searches message content, and exports a chat', async () => {
    const character = await app.inject({
      method: 'POST',
      url: '/api/v2/characters',
      payload: { name: 'Reorder Host' },
    });
    const characterId = character.json().id as string;

    const first = await app.inject({
      method: 'POST',
      url: '/api/v2/chats',
      payload: { characterId, title: 'First' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/v2/chats',
      payload: { characterId, title: 'Second' },
    });
    const third = await app.inject({
      method: 'POST',
      url: '/api/v2/chats',
      payload: { characterId, title: 'Third' },
    });
    const ids = [first.json().id, second.json().id, third.json().id] as string[];

    // Content search: only the second chat mentions the unique term.
    await app.inject({
      method: 'POST',
      url: `/api/v2/chats/${second.json().id}/messages`,
      payload: { role: 'user', content: 'the kumquat grove is behind the hill' },
    });
    const byContent = await app.inject({
      method: 'GET',
      url: `/api/v2/chats?characterId=${characterId}&q=kumquat`,
    });
    expect(byContent.statusCode, byContent.payload).toBe(200);
    expect(byContent.json().items.map((item: { id: string }) => item.id)).toEqual([
      second.json().id,
    ]);

    // Manual reorder reverses the default updated_at ordering.
    const reordered = await app.inject({
      method: 'PUT',
      url: '/api/v2/chats/order',
      payload: { characterId, order: [third.json().id, first.json().id, second.json().id] },
    });
    expect(reordered.statusCode, reordered.payload).toBe(200);
    expect(reordered.json()).toEqual({ reordered: 3, invalidIds: [] });

    const listed = await app.inject({
      method: 'GET',
      url: `/api/v2/chats?characterId=${characterId}`,
    });
    expect(listed.json().items.map((item: { id: string }) => item.id)).toEqual([
      third.json().id,
      first.json().id,
      second.json().id,
    ]);

    const recentFirstPage = await app.inject({
      method: 'GET',
      url: `/api/v2/chats?characterId=${characterId}&sort=recent&limit=2`,
    });
    expect(recentFirstPage.statusCode, recentFirstPage.payload).toBe(200);
    expect(
      recentFirstPage.json().items.map((item: { id: string; characterName: string | null }) => ({
        id: item.id,
        characterName: item.characterName,
      })),
    ).toEqual([
      { id: second.json().id, characterName: 'Reorder Host' },
      { id: third.json().id, characterName: 'Reorder Host' },
    ]);

    const recentSecondPage = await app.inject({
      method: 'GET',
      url: `/api/v2/chats?characterId=${characterId}&sort=recent&limit=2&cursor=${encodeURIComponent(
        recentFirstPage.json().nextCursor as string,
      )}`,
    });
    expect(recentSecondPage.json().items.map((item: { id: string }) => item.id)).toEqual([
      first.json().id,
    ]);

    const invalidSort = await app.inject({
      method: 'GET',
      url: '/api/v2/chats?sort=oldest',
    });
    expect(invalidSort.statusCode).toBe(422);

    // Reorder with an id that does not belong to the character → 404.
    const foreign = await app.inject({
      method: 'POST',
      url: '/api/v2/chats',
      payload: { title: 'Foreign' },
    });
    const invalid = await app.inject({
      method: 'PUT',
      url: '/api/v2/chats/order',
      payload: { characterId, order: [foreign.json().id] },
    });
    expect(invalid.statusCode).toBe(404);

    // Export returns a JSON attachment with chat metadata and every message.
    const exported = await app.inject({
      method: 'GET',
      url: `/api/v2/chats/${second.json().id}/export`,
    });
    expect(exported.statusCode, exported.payload).toBe(200);
    expect(exported.headers['content-disposition']).toContain('attachment');
    const payload = exported.json();
    expect(payload.kind).toBe('neotavern-chat-export');
    expect(payload.version).toBe(2);
    expect(payload.chat.id).toBe(second.json().id);
    expect(payload.characterName).toBe('Reorder Host');
    expect(payload.messages).toContainEqual(
      expect.objectContaining({ role: 'user', content: 'the kumquat grove is behind the hill' }),
    );
    expect(ids).toHaveLength(3);
  });
});
