/**
 * Module-graph builder + loader tests (Stage B, ТЗ §6, §8.6, §40.1.2).
 *
 * The loader tests run lockdown() in this vitest worker and evaluate the
 * graph inside a real SES Compartment. errorTaming 'unsafe-debug' is the
 * allowed disposable local developer runtime policy (§40.1.5); it is required
 * here to assert the `neotavern-plugin://` stack conformance.
 */
import 'ses';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  PluginModuleErrorCode,
  pluginModuleLocation,
  toModuleMapManifest,
  type PluginModuleError,
} from '@neotavern/contracts';
import { buildModuleGraph, type PluginPackageSource } from './moduleGraphBuilder.js';
import {
  loadModuleGraph,
  moduleDescriptorFor,
  prepareModuleGraph,
  resolveGraphSpecifier,
} from './moduleGraphLoader.js';

beforeAll(() => {
  lockdown({ errorTaming: 'unsafe-debug', overrideTaming: 'moderate', consoleTaming: 'safe' });
});

function pkg(
  files: Record<string, string>,
  entry = 'src/index.js',
  pluginId = 'test.plugin',
): PluginPackageSource {
  return { pluginId, entry, files: new Map(Object.entries(files)) };
}

function buildOk(files: Record<string, string>, entry = 'src/index.js', pluginId = 'test.plugin') {
  return buildModuleGraph(pkg(files, entry, pluginId));
}

const SIMPLE_PLUGIN = {
  'src/index.js':
    "import { helper } from './helper.js';\n" +
    "export const name = 'test.plugin';\n" +
    "export const greeting = helper('hi');\n",
  'src/helper.js': 'export function helper(x) { return `helper(${x})`; }\n',
};

describe('buildModuleGraph', () => {
  it('builds a signed graph with virtual locations and resolved imports', () => {
    const { graph } = buildOk(SIMPLE_PLUGIN);
    expect(graph.pluginId).toBe('test.plugin');
    expect(graph.entry).toBe('src/index.js');
    expect(graph.records.map((r) => r.id)).toEqual(['src/helper.js', 'src/index.js']);

    const index = graph.records.find((r) => r.id === 'src/index.js');
    expect(index).toMatchObject({
      location: 'neotavern-plugin://test.plugin/src/index.js',
      kind: 'js',
      imports: ['./helper.js'],
      // ModuleSource reports exports in sorted order.
      exports: ['greeting', 'name'],
      resolvedImports: { './helper.js': 'src/helper.js' },
    });
    expect(index?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(index?.source).toBe(SIMPLE_PLUGIN['src/index.js']);

    const helper = graph.records.find((r) => r.id === 'src/helper.js');
    expect(helper?.imports).toEqual([]);
    expect(helper?.exports).toEqual(['helper']);
  });

  it('produces deterministic digests', () => {
    const first = buildOk(SIMPLE_PLUGIN);
    const second = buildOk(SIMPLE_PLUGIN);
    expect(first.graph.records.map((r) => r.digest)).toEqual(
      second.graph.records.map((r) => r.digest),
    );
  });

  it('resolves extensionless and directory-index relative imports', () => {
    const { graph } = buildOk({
      'src/index.js': "export { util } from './util';\nexport { helper } from './helper';\n",
      'src/helper.mjs': 'export const helper = 1;\n',
      'src/util/index.js': 'export const util = 2;\n',
    });
    const index = graph.records.find((r) => r.id === 'src/index.js');
    expect(index?.resolvedImports).toEqual({
      './util': 'src/util/index.js',
      './helper': 'src/helper.mjs',
    });
  });

  it('rejects node: builtins with UNSUPPORTED_NODE_BUILTIN', () => {
    expect(() =>
      buildOk({ 'src/index.js': "import fs from 'node:fs';\nexport const x = 1;\n" }),
    ).toThrowError(
      expect.objectContaining({
        code: PluginModuleErrorCode.UNSUPPORTED_NODE_BUILTIN,
        params: expect.objectContaining({ specifier: 'node:fs' }),
      }),
    );
  });

  it('rejects bare Node builtins with UNSUPPORTED_NODE_BUILTIN', () => {
    expect(() =>
      buildOk({ 'src/index.js': "import { readFile } from 'fs';\nexport const x = 1;\n" }),
    ).toThrowError(
      expect.objectContaining({ code: PluginModuleErrorCode.UNSUPPORTED_NODE_BUILTIN }),
    );
  });

  it('rejects external packages with UNSUPPORTED_DEPENDENCY', () => {
    expect(() =>
      buildOk({ 'src/index.js': "import lodash from 'lodash';\nexport const x = 1;\n" }),
    ).toThrowError(
      expect.objectContaining({
        code: PluginModuleErrorCode.UNSUPPORTED_DEPENDENCY,
        params: expect.objectContaining({ specifier: 'lodash' }),
      }),
    );
  });

  it('rejects a missing entry with PACKAGE_INVALID', () => {
    expect(() =>
      buildModuleGraph(pkg({ 'src/other.js': 'export const x = 1;\n' }, 'src/index.js')),
    ).toThrowError(expect.objectContaining({ code: PluginModuleErrorCode.PACKAGE_INVALID }));
  });

  it('rejects unresolved relative imports with PACKAGE_INVALID', () => {
    expect(() =>
      buildOk({ 'src/index.js': "import { x } from './nope.js';\nexport const y = 1;\n" }),
    ).toThrowError(
      expect.objectContaining({
        code: PluginModuleErrorCode.PACKAGE_INVALID,
        params: expect.objectContaining({ specifier: './nope.js' }),
      }),
    );
  });

  it('rejects path escapes above the package root with PACKAGE_INVALID', () => {
    expect(() =>
      buildOk({ 'src/index.js': "import { x } from '../../secret.js';\nexport const y = 1;\n" }),
    ).toThrowError(expect.objectContaining({ code: PluginModuleErrorCode.PACKAGE_INVALID }));
  });

  it('rejects invalid ES module syntax with PACKAGE_INVALID', () => {
    expect(() => buildOk({ 'src/index.js': 'export const broken = ;\n' })).toThrowError(
      expect.objectContaining({
        code: PluginModuleErrorCode.PACKAGE_INVALID,
        params: expect.objectContaining({ id: 'src/index.js' }),
      }),
    );
  });

  it('warns about require/eval/Function and CJS idioms but still builds', () => {
    const { warnings } = buildOk({
      'src/index.js':
        "const x = require('./x');\n" +
        'const y = eval("1+1");\n' +
        'const z = Function("return 1")();\n' +
        'module.exports = { x, y, z };\n',
    });
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('require()'),
        expect.stringContaining('eval()'),
        expect.stringContaining('Function()'),
        expect.stringContaining('CommonJS'),
      ]),
    );
  });

  it('builds JSON modules with a synthetic default export', () => {
    const { graph } = buildOk({
      'src/index.js': "import data from './data.json';\nexport const value = data.answer;\n",
      'src/data.json': '{"answer":42}\n',
    });
    const record = graph.records.find((r) => r.id === 'src/data.json');
    expect(record).toMatchObject({ kind: 'json', imports: [], exports: ['default'] });
    expect(record?.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects invalid JSON modules with PACKAGE_INVALID', () => {
    expect(() =>
      buildOk({
        'src/index.js': "import data from './data.json';\nexport const v = data;\n",
        'src/data.json': '{not json}\n',
      }),
    ).toThrowError(expect.objectContaining({ code: PluginModuleErrorCode.PACKAGE_INVALID }));
  });

  it('enforces the module-count cap (import-time runaway §6.7)', () => {
    const files: Record<string, string> = {
      'src/index.js': 'export const x = 1;\n',
    };
    expect(() => buildModuleGraph(pkg(files), { maxModules: 0 })).toThrowError(
      expect.objectContaining({
        code: PluginModuleErrorCode.PACKAGE_INVALID,
        params: expect.objectContaining({ detail: expect.stringContaining('exceeds') }),
      }),
    );
  });

  it('strips sources from the module-map manifest (§6.2)', () => {
    const { graph } = buildOk(SIMPLE_PLUGIN);
    const manifest = toModuleMapManifest(graph);
    expect(manifest.entry).toBe('src/index.js');
    expect(manifest.records.length).toBe(2);
    for (const record of manifest.records) {
      expect(record).not.toHaveProperty('source');
      expect(record).toHaveProperty('digest');
      expect(record).toHaveProperty('location');
    }
    expect(manifest.records.map((r) => r.id)).toEqual(['src/helper.js', 'src/index.js']);
  });
});

describe('moduleGraphLoader', () => {
  it('loads the entry graph and returns the live namespace', async () => {
    const { graph } = buildOk(SIMPLE_PLUGIN);
    const { namespace, exportNames } = await loadModuleGraph(graph);
    expect(exportNames.slice().sort()).toEqual(['greeting', 'name']);
    expect(namespace['greeting']).toBe('helper(hi)');
    expect(namespace['name']).toBe('test.plugin');
  });

  it('loads JSON modules through the graph', async () => {
    const { graph } = buildOk({
      'src/index.js': "import data from './data.json';\nexport const answer = data.answer;\n",
      'src/data.json': '{"answer":42}\n',
    });
    const { namespace } = await loadModuleGraph(graph);
    expect(namespace['answer']).toBe(42);
  });

  it('keeps neotavern-plugin:// virtual locations in stack traces (§40.1.2)', async () => {
    const { graph } = buildOk({
      'src/index.js': "import { boom } from './boom.js';\nexport const value = boom();\n",
      'src/boom.js': "export function boom() { throw new Error('kaboom'); }\n",
    });
    const ErrorCtor = globalThis.Error as unknown as { prepareStackTrace: unknown };
    const saved = ErrorCtor.prepareStackTrace;
    try {
      // vitest's sourcemap-interceptor prepareStackTrace crashes when V8 calls
      // it with a hardened error under lockdown ("Cannot assign to read only
      // property 'constructor'"), masking the plugin error inside the loader.
      // Native stack formatting surfaces the virtual frames, so we neutralize
      // the interceptor for the duration of the load and restore it after.
      ErrorCtor.prepareStackTrace = undefined;
      try {
        await loadModuleGraph(graph);
        expect.unreachable('loadModuleGraph should have rejected');
      } catch (error) {
        const moduleError = error as PluginModuleError;
        // Manual field assertions: vitest's diff serialization of hardened
        // errors crashes, so avoid asymmetric matchers on the error itself.
        expect(moduleError.code).toBe(PluginModuleErrorCode.MODULE_EVALUATION_FAILED);
        const cause = moduleError.params['cause'];
        expect(typeof cause).toBe('string');
        expect(cause).toContain('neotavern-plugin://test.plugin/src/boom.js');
      }
    } finally {
      ErrorCtor.prepareStackTrace = saved;
    }
  });

  it('allows dynamic import only within the signed graph (§6.4)', async () => {
    const { graph } = buildOk({
      'src/index.js': "export const dyn = import('./helper.js').then((m) => m.helper(3));\n",
      'src/helper.js': 'export function helper(x) { return x * 2; }\n',
    });
    const { namespace } = await loadModuleGraph(graph);
    await expect(namespace['dyn']).resolves.toBe(6);
  });

  it('rejects dynamic import outside the graph at build time', () => {
    expect(() =>
      buildOk({
        'src/index.js':
          "export const dyn = import('neotavern-plugin://evil.js').then(() => 'ok');\n",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: PluginModuleErrorCode.UNSUPPORTED_DEPENDENCY,
        params: expect.objectContaining({ specifier: 'neotavern-plugin://evil.js' }),
      }),
    );
  });

  it('rejects a relative dynamic import outside the package at build time', () => {
    expect(() =>
      buildOk({
        'src/index.js': "export const dyn = import('./missing.js').then(() => 'ok');\n",
      }),
    ).toThrowError(expect.objectContaining({ code: PluginModuleErrorCode.PACKAGE_INVALID }));
  });

  it('rejects a tampered source with MODULE_DIGEST_MISMATCH', async () => {
    const { graph } = buildOk(SIMPLE_PLUGIN);
    const record = graph.records.find((r) => r.id === 'src/index.js');
    expect(record).toBeDefined();
    (record as { digest: string }).digest = 'a'.repeat(64);
    await expect(loadModuleGraph(graph)).rejects.toThrowError(
      expect.objectContaining({ code: PluginModuleErrorCode.MODULE_DIGEST_MISMATCH }),
    );
  });

  it('rejects records without a source payload with PACKAGE_INVALID', async () => {
    const { graph } = buildOk(SIMPLE_PLUGIN);
    const { source: _source, ...rest } = graph.records.find((r) => r.id === 'src/index.js') as {
      source: string;
    } & Record<string, unknown>;
    void _source;
    (rest as Record<string, unknown>)['source'] = undefined;
    const stripped = { ...graph, records: [rest as never] };
    const prepared = prepareModuleGraph(stripped);
    expect(() =>
      moduleDescriptorFor(prepared, 'neotavern-plugin://test.plugin/src/index.js'),
    ).toThrowError(expect.objectContaining({ code: PluginModuleErrorCode.PACKAGE_INVALID }));
  });

  it('resolves only graph-local referrers (§8.9: no custom resolver)', () => {
    const prepared = prepareModuleGraph(buildOk(SIMPLE_PLUGIN).graph);
    expect(
      resolveGraphSpecifier(
        prepared,
        './helper.js',
        pluginModuleLocation('test.plugin', 'src/index.js'),
      ),
    ).toBe(pluginModuleLocation('test.plugin', 'src/helper.js'));
    expect(() =>
      resolveGraphSpecifier(
        prepared,
        './nope.js',
        pluginModuleLocation('test.plugin', 'src/index.js'),
      ),
    ).toThrowError(expect.objectContaining({ code: PluginModuleErrorCode.MODULE_NOT_IN_GRAPH }));
    expect(() =>
      resolveGraphSpecifier(
        prepared,
        './x.js',
        pluginModuleLocation('test.plugin', 'src/other.js'),
      ),
    ).toThrowError(expect.objectContaining({ code: PluginModuleErrorCode.MODULE_NOT_IN_GRAPH }));
  });

  it('rejects an entry missing from the graph in prepareModuleGraph', () => {
    expect(() =>
      prepareModuleGraph({ pluginId: 'test.plugin', entry: 'src/nope.js', records: [] }),
    ).toThrowError(expect.objectContaining({ code: PluginModuleErrorCode.MODULE_NOT_IN_GRAPH }));
  });
});
