/**
 * Unit tests for the plugin ESM resolver boundary (worker/plugin-loader.mjs).
 *
 * The loader reads its configuration from environment variables at import
 * time, so each scenario re-imports the module with a cache-busting query.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const LOADER_URL = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), '../worker/plugin-loader.mjs'),
);

type NextResolveStub = (specifier: string, context: unknown) => Promise<{ url: string }>;
type LoaderResolve = (
  specifier: string,
  context: { parentURL?: string },
  nextResolve: NextResolveStub,
) => Promise<{ url: string }>;

let packageRoot = '';
const savedEnv: Record<string, string | undefined> = {};

async function loadResolve(allowBareImports: boolean): Promise<LoaderResolve> {
  process.env['NEOTA_PLUGIN_ALLOW_BARE_IMPORTS'] = allowBareImports ? '1' : '0';
  const moduleUrl = `${LOADER_URL.href}?bare=${allowBareImports ? '1' : '0'}`;
  const mod = (await import(moduleUrl)) as { resolve: LoaderResolve };
  return mod.resolve;
}

/** Stub resolver that maps any specifier onto a fixed file path. */
function nextResolveTo(path: string): NextResolveStub {
  return async () => ({ url: pathToFileURL(path).href });
}

beforeAll(async () => {
  packageRoot = await mkdtemp(join(tmpdir(), 'neotavern-loader-test-'));
  const keys = [
    'NEOTA_PLUGIN_PACKAGE_ROOT',
    'NEOTA_PLUGIN_WORKER_URL',
    'NEOTA_PLUGIN_WORKER_PATH',
    'NEOTA_PLUGIN_ALLOW_BARE_IMPORTS',
  ];
  for (const key of keys) savedEnv[key] = process.env[key];
  process.env['NEOTA_PLUGIN_PACKAGE_ROOT'] = packageRoot;
  process.env['NEOTA_PLUGIN_WORKER_URL'] = pathToFileURL(join(packageRoot, 'worker.mjs')).href;
  process.env['NEOTA_PLUGIN_WORKER_PATH'] = join(packageRoot, 'worker.mjs');
});

afterAll(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(packageRoot, { recursive: true, force: true });
});

describe('plugin loader import boundary', () => {
  it('denies bare imports when the dependency marker is absent', async () => {
    const resolve = await loadResolve(false);
    await expect(
      resolve('some-package', {}, nextResolveTo(join(packageRoot, 'node_modules/x.js'))),
    ).rejects.toMatchObject({ code: 'PLUGIN_PERMISSION_DENIED' });
  });

  it('allows bare imports that resolve inside the package root', async () => {
    const resolve = await loadResolve(true);
    const target = join(packageRoot, 'node_modules', 'some-package', 'index.js');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, 'export default true;\n', 'utf8');
    const resolved = await resolve('some-package', {}, nextResolveTo(target));
    expect(resolved.url).toBe(pathToFileURL(target).href);
  });

  it('denies bare imports that resolve outside the package root', async () => {
    const resolve = await loadResolve(true);
    await expect(
      resolve('escape', {}, nextResolveTo(join(tmpdir(), 'elsewhere', 'index.js'))),
    ).rejects.toMatchObject({ code: 'PLUGIN_PERMISSION_DENIED' });
  });

  it.each(['node:fs', 'data:text/javascript,', 'http://example.test/x', 'https://example.test/x'])(
    'keeps %s denied even when bare imports are allowed',
    async (specifier) => {
      const resolve = await loadResolve(true);
      await expect(
        resolve(specifier, {}, nextResolveTo(join(packageRoot, 'ignored.js'))),
      ).rejects.toMatchObject({ code: 'PLUGIN_PERMISSION_DENIED' });
    },
  );
});
