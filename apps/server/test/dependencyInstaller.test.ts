import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create } from 'tar';
import { describe, expect, it } from 'vitest';
import { isAppError } from '@neotavern/shared';
import {
  DEPENDENCY_MARKER_FILE,
  installPluginDependencies,
  readPluginDependencySpecs,
} from '../src/plugin/dependencyInstaller.js';

const REGISTRY_URL = 'https://registry.test';

interface FakeVersion {
  dependencies?: Record<string, string>;
  files?: Record<string, string>;
  /** Inject a forbidden file (e.g. native binary) into the tarball. */
  forbiddenFile?: string;
  /** Serve corrupted bytes while advertising a valid integrity. */
  corrupt?: boolean;
  /** Override the tarball URL advertised in the packument (SSRF tests). */
  tarballUrl?: string;
}

interface FakePackage {
  versions: Record<string, FakeVersion>;
}

interface FakeRegistry {
  fetchImpl: typeof fetch;
  tarballFetches: Map<string, number>;
}

/** Build an npm-style tarball: all files under a `package/` root. */
async function makePackageTarball(files: Record<string, string>): Promise<Buffer> {
  const stage = await mkdtemp(join(tmpdir(), 'neotavern-deptar-'));
  try {
    const names: string[] = [];
    for (const [name, content] of Object.entries(files)) {
      const target = join(stage, ...name.split('/'));
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, content);
      names.push(name);
    }
    const chunks: Buffer[] = [];
    const pack = create({ cwd: stage, gzip: true, portable: true, prefix: 'package' }, names);
    for await (const chunk of pack) chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

function makeFakeRegistry(packages: Record<string, FakePackage>): FakeRegistry {
  const tarballFetches = new Map<string, number>();
  const tarballs = new Map<string, { bytes: Buffer; integrity: string }>();

  const buildTarball = async (name: string, version: string, spec: FakeVersion): Promise<void> => {
    const key = `${name}@${version}`;
    if (tarballs.has(key)) return;
    const files = {
      'package.json': JSON.stringify({ name, version, dependencies: spec.dependencies ?? {} }),
      ...(spec.files ?? { 'index.js': `export const id = ${JSON.stringify(key)};` }),
    };
    if (spec.forbiddenFile) files[spec.forbiddenFile] = 'binary';
    let bytes = await makePackageTarball(files);
    if (spec.corrupt) bytes = Buffer.concat([bytes, Buffer.from('corruption')]);
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    tarballs.set(key, { bytes, integrity });
  };

  const fetchImpl = (async (input: string) => {
    const url = new URL(String(input));
    if (url.origin !== REGISTRY_URL) throw new Error(`unexpected registry host: ${url.origin}`);
    const path = decodeURIComponent(url.pathname);

    const tarballMatch = /^\/tarballs\/(.+)@(.+)\.tgz$/u.exec(path);
    if (tarballMatch) {
      const key = `${tarballMatch[1]}@${tarballMatch[2]}`;
      const entry = tarballs.get(key);
      if (!entry) return new Response(null, { status: 404 });
      tarballFetches.set(key, (tarballFetches.get(key) ?? 0) + 1);
      // Corrupt packages advertise the pre-corruption hash.
      return new Response(entry.bytes, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    }

    const name = path.replace(/^\//u, '');
    const packument = packages[name];
    if (!packument) return new Response(null, { status: 404 });
    for (const [version, spec] of Object.entries(packument.versions)) {
      await buildTarball(name, version, spec);
    }
    const versionNames = Object.keys(packument.versions);
    const body: Record<string, unknown> = {
      name,
      'dist-tags': { latest: versionNames[versionNames.length - 1] },
      versions: Object.fromEntries(
        versionNames.map((version) => {
          const entry = tarballs.get(`${name}@${version}`);
          const spec = packument.versions[version];
          const integrity = spec?.corrupt
            ? `sha512-${createHash('sha512').update('other-content').digest('base64')}`
            : (entry?.integrity ?? '');
          return [
            version,
            {
              name,
              version,
              dependencies: spec?.dependencies ?? {},
              dist: {
                tarball:
                  spec.tarballUrl ??
                  `${REGISTRY_URL}/tarballs/${encodeURIComponent(name)}@${version}.tgz`,
                integrity,
              },
            },
          ];
        }),
      ),
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  return { fetchImpl, tarballFetches };
}

async function makePluginPackage(dependencies: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'neotavern-depinstall-'));
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'test-plugin', version: '1.0.0', dependencies }),
  );
  return root;
}

describe('readPluginDependencySpecs', () => {
  it('accepts semver ranges and dist-tags', () => {
    const specs = readPluginDependencySpecs({
      dependencies: { lodash: '^4.17.0', leftpad: 'latest', '@scope/pkg': '~1.2.3' },
    });
    expect(specs.get('lodash')).toBe('^4.17.0');
    expect(specs.get('leftpad')).toBe('latest');
    expect(specs.get('@scope/pkg')).toBe('~1.2.3');
  });

  it('rejects non-registry specs before any download', () => {
    const cases: Record<string, string> = {
      'git-pkg': 'git+https://github.com/x/y.git',
      'file-pkg': 'file:../local',
      'ws-pkg': 'workspace:*',
      'url-pkg': 'https://example.com/x.tgz',
      'bad-range': 'not a range at all',
    };
    for (const [name, spec] of Object.entries(cases)) {
      let error: unknown;
      try {
        readPluginDependencySpecs({ dependencies: { [name]: spec } });
      } catch (caught) {
        error = caught;
      }
      expect(isAppError(error), `${name}=${spec}`).toBe(true);
      if (isAppError(error)) {
        expect(error.code, name).toBe('PLUGIN_DEPS_UNSUPPORTED');
        expect(error.params['dependency'], name).toBe(name);
      }
    }
  });

  it('rejects invalid package names', () => {
    let error: unknown;
    try {
      readPluginDependencySpecs({ dependencies: { '../evil': '^1.0.0' } });
    } catch (caught) {
      error = caught;
    }
    expect(isAppError(error)).toBe(true);
  });
});

describe('installPluginDependencies', () => {
  it('installs direct, transitive and scoped packages with a marker file', async () => {
    const registry = makeFakeRegistry({
      'dep-a': {
        versions: { '1.0.0': { dependencies: { 'dep-b': '^2.0.0', '@scope/dep-c': '^1.0.0' } } },
      },
      'dep-b': { versions: { '2.3.4': {} } },
      '@scope/dep-c': { versions: { '1.1.1': {} } },
    });
    const packageRoot = await makePluginPackage({ 'dep-a': '^1.0.0' });

    const records = await installPluginDependencies(
      packageRoot,
      readPluginDependencySpecs(
        JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')),
      ),
      { registryUrl: REGISTRY_URL, fetchImpl: registry.fetchImpl },
    );

    expect(records.map((record) => record.name)).toEqual(['@scope/dep-c', 'dep-a', 'dep-b']);
    expect(await readFile(join(packageRoot, 'node_modules/dep-a/index.js'), 'utf8')).toContain(
      'dep-a@1.0.0',
    );
    expect(await readFile(join(packageRoot, 'node_modules/dep-b/index.js'), 'utf8')).toContain(
      'dep-b@2.3.4',
    );
    expect(
      await readFile(join(packageRoot, 'node_modules/@scope/dep-c/index.js'), 'utf8'),
    ).toContain('@scope/dep-c@1.1.1');

    const marker = JSON.parse(
      await readFile(join(packageRoot, 'node_modules', DEPENDENCY_MARKER_FILE), 'utf8'),
    ) as {
      version: number;
      dependencies: Array<{ name: string; version: string; integrity: string }>;
    };
    expect(marker.version).toBe(1);
    expect(marker.dependencies).toHaveLength(3);
    expect(marker.dependencies.every((dep) => dep.integrity.startsWith('sha512-'))).toBe(true);
  });

  it('reports a conflict when flat hoisting cannot satisfy both ranges', async () => {
    const registry = makeFakeRegistry({
      'dep-a': { versions: { '1.0.0': { dependencies: { shared: '^1.0.0' } } } },
      'dep-b': { versions: { '1.0.0': { dependencies: { shared: '^2.0.0' } } } },
      shared: { versions: { '1.5.0': {}, '2.5.0': {} } },
    });
    const packageRoot = await makePluginPackage({ 'dep-a': '^1.0.0', 'dep-b': '^1.0.0' });

    let error: unknown;
    try {
      await installPluginDependencies(
        packageRoot,
        readPluginDependencySpecs(
          JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')),
        ),
        { registryUrl: REGISTRY_URL, fetchImpl: registry.fetchImpl },
      );
    } catch (caught) {
      error = caught;
    }
    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe('PLUGIN_DEPS_CONFLICT');
      expect(error.params['dependency']).toBe('shared');
    }
  });

  it('rejects packages containing forbidden files', async () => {
    const registry = makeFakeRegistry({
      evil: { versions: { '1.0.0': { forbiddenFile: 'native.node' } } },
    });
    const packageRoot = await makePluginPackage({ evil: '^1.0.0' });

    let error: unknown;
    try {
      await installPluginDependencies(
        packageRoot,
        readPluginDependencySpecs(
          JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')),
        ),
        { registryUrl: REGISTRY_URL, fetchImpl: registry.fetchImpl },
      );
    } catch (caught) {
      error = caught;
    }
    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) expect(error.code).toBe('PLUGIN_DEPS_FORBIDDEN_FILE');
  });

  it('verifies registry integrity and fails on mismatch', async () => {
    const registry = makeFakeRegistry({
      tampered: { versions: { '1.0.0': { corrupt: true } } },
    });
    const packageRoot = await makePluginPackage({ tampered: '^1.0.0' });

    let error: unknown;
    try {
      await installPluginDependencies(
        packageRoot,
        readPluginDependencySpecs(
          JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')),
        ),
        { registryUrl: REGISTRY_URL, fetchImpl: registry.fetchImpl },
      );
    } catch (caught) {
      error = caught;
    }
    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe('PLUGIN_DEPS_FAILED');
      expect(String(error.params['reason'])).toContain('integrity');
    }
  });

  it('resolves dist-tags', async () => {
    const registry = makeFakeRegistry({
      tagged: { versions: { '1.0.0': {}, '2.0.0': {} } },
    });
    const packageRoot = await makePluginPackage({ tagged: 'latest' });

    const records = await installPluginDependencies(
      packageRoot,
      readPluginDependencySpecs(
        JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')),
      ),
      { registryUrl: REGISTRY_URL, fetchImpl: registry.fetchImpl },
    );
    expect(records[0]?.version).toBe('2.0.0');
  });

  it('reuses cached tarballs on a second install', async () => {
    const registry = makeFakeRegistry({
      cached: { versions: { '1.0.0': {} } },
    });
    const cacheDir = await mkdtemp(join(tmpdir(), 'neotavern-depcache-'));
    const firstRoot = await makePluginPackage({ cached: '^1.0.0' });
    const secondRoot = await makePluginPackage({ cached: '^1.0.0' });

    await installPluginDependencies(
      firstRoot,
      readPluginDependencySpecs(
        JSON.parse(await readFile(join(firstRoot, 'package.json'), 'utf8')),
      ),
      { registryUrl: REGISTRY_URL, fetchImpl: registry.fetchImpl, cacheDir },
    );
    await installPluginDependencies(
      secondRoot,
      readPluginDependencySpecs(
        JSON.parse(await readFile(join(secondRoot, 'package.json'), 'utf8')),
      ),
      { registryUrl: REGISTRY_URL, fetchImpl: registry.fetchImpl, cacheDir },
    );

    expect(registry.tarballFetches.get('cached@1.0.0')).toBe(1);
  });

  it('rejects a plaintext registry URL (§SEC-03)', async () => {
    const packageRoot = await makePluginPackage({ dep: '^1.0.0' });
    let error: unknown;
    try {
      await installPluginDependencies(
        packageRoot,
        readPluginDependencySpecs(
          JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')),
        ),
        { registryUrl: 'http://registry.test' },
      );
    } catch (caught) {
      error = caught;
    }
    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe('PLUGIN_DEPS_FAILED');
      expect(String(error.params['reason'])).toContain('https');
    }
  });

  it('rejects a tarball URL targeting a forbidden destination (§SEC-03)', async () => {
    const registry = makeFakeRegistry({
      evil: { versions: { '1.0.0': { tarballUrl: 'https://127.0.0.1:8443/evil.tgz' } } },
    });
    const packageRoot = await makePluginPackage({ evil: '^1.0.0' });

    let error: unknown;
    try {
      await installPluginDependencies(
        packageRoot,
        readPluginDependencySpecs(
          JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')),
        ),
        { registryUrl: REGISTRY_URL, fetchImpl: registry.fetchImpl },
      );
    } catch (caught) {
      error = caught;
    }
    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe('PLUGIN_DEPS_FAILED');
      expect(String(error.params['reason'])).toContain('forbidden destination');
    }
  });

  it('leaves the package untouched when there are no dependencies', async () => {
    const packageRoot = await makePluginPackage({});
    const records = await installPluginDependencies(packageRoot, new Map(), {
      registryUrl: REGISTRY_URL,
    });
    expect(records).toEqual([]);
  });
});
