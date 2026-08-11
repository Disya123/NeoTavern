/**
 * Integration tests for POST /api/v2/plugins/install-git (Fastify inject).
 *
 * Network access is faked: global fetch serves both the repository archive
 * (codeload.github.com shape) and a mock npm registry, so no test touches
 * the real internet.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create } from 'tar';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAppDatabase, type AppDatabase } from '@neotavern/db';
import { DEFAULT_PROVIDER_TIMEOUTS, ProviderRegistry } from '@neotavern/provider-sdk';
import { createLogger } from '@neotavern/shared';
import { buildApp } from '../src/app.js';
import { ensureDataDirs, resolveDataPaths, type DataPaths } from '../src/lib/paths.js';
import type { TypedApp } from '../src/types.js';
import { ContextStrategyRegistry } from '../src/pipeline/contextShift.js';
import { PostProcessorRegistry } from '../src/pipeline/postProcess.js';

const REGISTRY_URL = 'https://registry.test';
const ARCHIVE_URL = 'https://codeload.github.com/test-owner/test-repo/tar.gz/HEAD';

/** Build a tar.gz archive from a file map (paths relative to the archive root). */
async function makeTarGz(files: Record<string, string>): Promise<Buffer> {
  const stage = await mkdtemp(join(tmpdir(), 'neotavern-gitarchive-'));
  try {
    const names: string[] = [];
    for (const [name, content] of Object.entries(files)) {
      const target = join(stage, ...name.split('/'));
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, content);
      names.push(name);
    }
    const chunks: Buffer[] = [];
    const pack = create({ cwd: stage, gzip: true, portable: true }, names);
    for await (const chunk of pack) chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

interface FakeWorld {
  /** Repository archive bytes served for codeload requests (null = 404). */
  archive: Buffer | null;
  /** npm packages served at REGISTRY_URL. */
  registry: Record<string, { version: string; dependencies?: Record<string, string> }>;
  /** Every archive URL the server requested (for ref assertions). */
  requestedArchiveUrls: string[];
}

function makeFakeFetch(world: FakeWorld): typeof fetch {
  const tarballs = new Map<string, { bytes: Buffer; integrity: string }>();

  const buildDependencyTarball = async (
    name: string,
  ): Promise<{ bytes: Buffer; integrity: string }> => {
    const cached = tarballs.get(name);
    if (cached) return cached;
    const spec = world.registry[name];
    if (!spec) throw new Error(`unknown registry package: ${name}`);
    const bytes = await makeTarGz({
      'package/package.json': JSON.stringify({
        name,
        version: spec.version,
        dependencies: spec.dependencies ?? {},
      }),
      'package/index.js': `export const id = ${JSON.stringify(`${name}@${spec.version}`)};`,
    });
    const entry = {
      bytes,
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    };
    tarballs.set(name, entry);
    return entry;
  };

  return (async (input: unknown) => {
    const url = new URL(String(input));

    if (url.hostname === 'codeload.github.com') {
      world.requestedArchiveUrls.push(url.href);
      if (!world.archive) return new Response(null, { status: 404 });
      return new Response(world.archive, {
        status: 200,
        headers: { 'content-type': 'application/x-gzip' },
      });
    }

    if (url.origin === REGISTRY_URL) {
      const tarballMatch = /^\/tarballs\/(.+)\.tgz$/u.exec(decodeURIComponent(url.pathname));
      if (tarballMatch) {
        const entry = await buildDependencyTarball(tarballMatch[1] ?? '').catch(() => null);
        if (!entry) return new Response(null, { status: 404 });
        return new Response(entry.bytes, { status: 200 });
      }
      const name = decodeURIComponent(url.pathname).replace(/^\//u, '');
      const spec = world.registry[name];
      if (!spec) return new Response(null, { status: 404 });
      const entry = await buildDependencyTarball(name);
      return new Response(
        JSON.stringify({
          name,
          'dist-tags': { latest: spec.version },
          versions: {
            [spec.version]: {
              name,
              version: spec.version,
              dependencies: spec.dependencies ?? {},
              dist: {
                tarball: `${REGISTRY_URL}/tarballs/${encodeURIComponent(name)}.tgz`,
                integrity: entry.integrity,
              },
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    throw new Error(`unexpected fetch in test: ${url.href}`);
  }) as typeof fetch;
}

function pluginManifest(id: string, dependencies: Record<string, string>): Record<string, string> {
  const files: Record<string, string> = {
    'test-repo-main/plugin.json': JSON.stringify({
      id,
      name: 'Git Installed Plugin',
      version: '1.0.0',
      apiVersion: 2,
      frontend: 'dist/frontend.js',
    }),
    'test-repo-main/dist/frontend.js': 'export default { activate() {} };',
  };
  if (Object.keys(dependencies).length > 0) {
    files['test-repo-main/package.json'] = JSON.stringify({
      name: id,
      version: '1.0.0',
      dependencies,
    });
  }
  return files;
}

async function buildTestApp(
  pluginGitInstall: boolean,
): Promise<{ app: TypedApp; paths: DataPaths }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'neotavern-gitinstall-'));
  const paths = resolveDataPaths(dataDir);
  ensureDataDirs(paths);
  const database: AppDatabase = createAppDatabase(':memory:');
  const app = await buildApp({
    database,
    providers: new ProviderRegistry(),
    contextStrategies: new ContextStrategyRegistry(),
    postProcessors: new PostProcessorRegistry(),
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
      pluginNodePath: process.execPath,
      pluginWorkerPath: null,
      pluginLoaderPath: null,
      providerTimeouts: DEFAULT_PROVIDER_TIMEOUTS,
      pluginGitInstall,
      pluginRegistryUrl: REGISTRY_URL,
      pluginDepsMaxPackages: 50,
      pluginDepsMaxBytes: 50 * 1024 * 1024,
    },
    logger: createLogger({ level: 'error' }),
    paths,
  });
  return { app, paths };
}

describe('plugin install from git', () => {
  let app: TypedApp;
  let paths: DataPaths;
  const world: FakeWorld = { archive: null, registry: {}, requestedArchiveUrls: [] };

  beforeAll(async () => {
    ({ app, paths } = await buildTestApp(true));
    vi.stubGlobal('fetch', makeFakeFetch(world));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  afterEach(() => {
    world.archive = null;
    world.registry = {};
    world.requestedArchiveUrls = [];
  });

  it('installs a plugin from a repository archive and records the source', async () => {
    const pluginId = 'test.git-plugin';
    world.archive = await makeTarGz(pluginManifest(pluginId, {}));

    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/plugins/install-git',
      payload: { url: 'https://github.com/test-owner/test-repo' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      replaced: false,
      plugin: {
        id: pluginId,
        // No requested permissions → nothing to consent to → installed disabled.
        status: 'disabled',
        source: { type: 'git', url: 'https://github.com/test-owner/test-repo' },
      },
    });
    expect(existsSync(join(paths.plugins, pluginId, 'package', 'plugin.json'))).toBe(true);
    expect(world.requestedArchiveUrls).toEqual([ARCHIVE_URL]);
  });

  it('prefers the explicit ref from the request body over the URL', async () => {
    const pluginId = 'test.git-plugin-ref';
    world.archive = await makeTarGz(pluginManifest(pluginId, {}));

    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/plugins/install-git',
      payload: { url: 'https://github.com/test-owner/test-repo/tree/main', ref: 'v1.2.3' },
    });
    expect(response.statusCode).toBe(200);
    expect(world.requestedArchiveUrls.at(-1)).toBe(
      'https://codeload.github.com/test-owner/test-repo/tar.gz/v1.2.3',
    );
    expect(response.json().plugin.source).toEqual({
      type: 'git',
      url: 'https://github.com/test-owner/test-repo/tree/main',
      ref: 'v1.2.3',
    });
  });

  it('installs npm dependencies and records them in the registry entry', async () => {
    const pluginId = 'test.git-plugin-deps';
    world.registry['dep-lib'] = { version: '2.1.0' };
    world.archive = await makeTarGz(pluginManifest(pluginId, { 'dep-lib': '^2.0.0' }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/plugins/install-git',
      payload: { url: 'https://github.com/test-owner/test-repo' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.plugin.dependencies).toEqual([
      expect.objectContaining({ name: 'dep-lib', version: '2.1.0' }),
    ]);

    const packageRoot = join(paths.plugins, pluginId, 'package');
    const marker = JSON.parse(
      await readFile(join(packageRoot, 'node_modules', '.neotavern-deps.json'), 'utf8'),
    ) as { dependencies: Array<{ name: string; version: string }> };
    expect(marker.dependencies).toEqual([
      expect.objectContaining({ name: 'dep-lib', version: '2.1.0' }),
    ]);
    expect(
      await readFile(join(packageRoot, 'node_modules', 'dep-lib', 'index.js'), 'utf8'),
    ).toContain('dep-lib@2.1.0');
  });

  it('rejects insecure and unsupported repository URLs', async () => {
    const insecure = await app.inject({
      method: 'POST',
      url: '/api/v2/plugins/install-git',
      payload: { url: 'http://github.com/test-owner/test-repo' },
    });
    expect(insecure.statusCode).toBe(422);
    expect(insecure.json()).toMatchObject({
      code: 'PLUGIN_SOURCE_INVALID',
      params: { reason: 'REPO_URL_INSECURE' },
    });

    const unsupported = await app.inject({
      method: 'POST',
      url: '/api/v2/plugins/install-git',
      payload: { url: 'https://bitbucket.org/test-owner/test-repo' },
    });
    expect(unsupported.statusCode).toBe(422);
    expect(unsupported.json()).toMatchObject({
      code: 'PLUGIN_SOURCE_UNSUPPORTED',
      params: { reason: 'REPO_HOST' },
    });
  });

  it('reports an unavailable archive without touching the registry', async () => {
    world.archive = null; // 404
    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/plugins/install-git',
      payload: { url: 'https://github.com/test-owner/missing-repo' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'PLUGIN_SOURCE_INVALID' });
    expect(response.json().params.reason).toBe('REPO_ARCHIVE_UNAVAILABLE');
  });

  it('can be disabled through configuration', async () => {
    const disabled = await buildTestApp(false);
    try {
      const response = await disabled.app.inject({
        method: 'POST',
        url: '/api/v2/plugins/install-git',
        payload: { url: 'https://github.com/test-owner/test-repo' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        code: 'FORBIDDEN',
        params: { reason: 'PLUGIN_GIT_INSTALL_DISABLED' },
      });
    } finally {
      await disabled.app.close();
    }
  });
});
