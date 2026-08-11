/**
 * Trusted module-graph builder (ТЗ Plugin SDK vNext v3.2 §6, §8.1).
 *
 * Takes a plugin package as pure in-memory files (the future `@neotavern/plugin-build`
 * feeds it from a directory; the prototype feeds it from the host/runtime) and
 * produces the signed module graph: per-module records with virtual locations,
 * SHA-256 digests, import/export lists from `@endo/module-source` and the
 * resolved import map. It also enforces the package policy — pure JS/JSON only,
 * no Node builtins (§9 vetted set comes later), no external dependencies.
 *
 * Runs in the TRUSTED context (runtime process / build tool), never inside the
 * plugin Compartment. Parsing via ModuleSource never executes plugin code.
 */
import { ModuleSource } from '@endo/module-source';
import { parse } from '@babel/parser';
import {
  PLUGIN_MODULE_MAX_COUNT,
  PLUGIN_MODULE_MAX_SOURCE_BYTES,
  PluginModuleError,
  PluginModuleErrorCode,
  pluginModuleLocation,
  type PluginModuleGraph,
  type PluginModuleRecord,
} from '@neotavern/contracts';
import { sha256Hex } from './digest.js';

/** Known Node builtin module names (bare forms; `node:`-prefixed always match). */
const NODE_BUILTIN_MODULES = new Set([
  'assert',
  'assert/strict',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'dns/promises',
  'domain',
  'events',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'inspector',
  'inspector/promises',
  'module',
  'net',
  'os',
  'path',
  'path/posix',
  'path/win32',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'readline/promises',
  'repl',
  'sea',
  'sqlite',
  'stream',
  'stream/consumers',
  'stream/promises',
  'stream/web',
  'string_decoder',
  'sys',
  'test',
  'timers',
  'timers/promises',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'util/types',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
]);

const JS_EXTENSIONS = ['.js', '.mjs', '.json'] as const;

export interface PluginPackageSource {
  /** Plugin identity used to build virtual locations (§8.6). */
  pluginId: string;
  /** Package-relative entry module id (e.g. `src/index.js`). */
  entry: string;
  /** Package-relative posix path -> file text. */
  files: ReadonlyMap<string, string>;
}

export interface BuildModuleGraphOptions {
  /** Node builtins permitted by the §9 compat layer. Stage B: empty. */
  allowedNodeBuiltins?: readonly string[];
  /** External packages permitted by policy. Stage B: empty. */
  allowedDependencies?: readonly string[];
  /** Hard cap on graph size (import-time runaway, §6.7). */
  maxModules?: number;
  /** Hard cap on a single module source size. */
  maxSourceBytes?: number;
}

export interface ModuleGraphBuildResult {
  graph: PluginModuleGraph;
  /** Diagnostic warnings (dynamic code/CJS idioms, §6.8) — never fatal. */
  warnings: string[];
}

function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith('node:') || NODE_BUILTIN_MODULES.has(specifier);
}

/** `./a/b` + `..` normalization, rejecting escapes above the package root. */
function normalizePackagePath(path: string): string {
  const segments: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (segments.length === 0) return '';
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return segments.join('/');
}

/**
 * Resolve a relative import specifier to a module id, checking exact match,
 * `.{js,mjs,json}` extensions and `index.{js,mjs,json}` directories. Returns
 * `''` when nothing in `existing` matches. Shared by the builder (against the
 * package file set) and the loader (against the signed graph ids, for dynamic
 * import fallback §6.4).
 */
export function resolveRelativeId(
  importerId: string,
  specifier: string,
  existing: ReadonlySet<string>,
): string {
  const base = importerId.slice(0, importerId.lastIndexOf('/') + 1);
  const candidate = normalizePackagePath(base + specifier);
  if (candidate === '') return '';
  if (existing.has(candidate)) return candidate;
  for (const extension of JS_EXTENSIONS) {
    if (existing.has(candidate + extension)) return candidate + extension;
  }
  for (const extension of JS_EXTENSIONS) {
    const index = `${candidate}/index${extension}`;
    if (existing.has(index)) return index;
  }
  return '';
}

function moduleKind(id: string): PluginModuleRecord['kind'] {
  if (id.endsWith('.json')) return 'json';
  return 'js';
}

/**
 * Extract dynamic-import specifiers (`import('./x.js')`) via a real Babel
 * parse (§6.4). ModuleSource only reports static imports; dynamic-import
 * targets must still be part of the signed graph, so the builder discovers
 * them with the same parser the module transform uses. Only static string /
 * simple template-literal specifiers are captured: `import(expr)` where the
 * target is not statically known stays OUT of the graph and is rejected at
 * load time (MODULE_NOT_IN_GRAPH), which is exactly the §6.4 restriction.
 */
export function collectDynamicImports(source: string): string[] {
  const specifiers: string[] = [];
  const ast = parse(source, { sourceType: 'module' });
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const record = node as { type?: string; source?: unknown; quasis?: unknown };
    if (
      record.type === 'ImportExpression' &&
      record.source !== null &&
      record.source !== undefined
    ) {
      const sourceNode = record.source as { type?: string; value?: string; quasis?: unknown };
      if (sourceNode.type === 'StringLiteral') {
        if (typeof sourceNode.value === 'string') specifiers.push(sourceNode.value);
      } else if (
        sourceNode.type === 'TemplateLiteral' &&
        Array.isArray(sourceNode.quasis) &&
        sourceNode.quasis.length === 1
      ) {
        const quasi = sourceNode.quasis[0] as { value?: { cooked?: string } };
        if (typeof quasi.value?.cooked === 'string') specifiers.push(quasi.value.cooked);
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra') continue;
      walk((node as Record<string, unknown>)[key]);
    }
  };
  walk(ast);
  return specifiers;
}

export function buildModuleGraph(
  source: PluginPackageSource,
  options: BuildModuleGraphOptions = {},
): ModuleGraphBuildResult {
  const {
    allowedNodeBuiltins = [],
    allowedDependencies = [],
    maxModules = PLUGIN_MODULE_MAX_COUNT,
    maxSourceBytes = PLUGIN_MODULE_MAX_SOURCE_BYTES,
  } = options;

  if (typeof source.pluginId !== 'string' || source.pluginId.length === 0) {
    throw new PluginModuleError(PluginModuleErrorCode.PACKAGE_INVALID, {
      detail: 'pluginId is required',
    });
  }
  if (!source.files.has(source.entry)) {
    throw new PluginModuleError(PluginModuleErrorCode.PACKAGE_INVALID, {
      entry: source.entry,
      detail: 'entry module not found in package',
    });
  }

  const warnings: string[] = [];
  const records = new Map<string, PluginModuleRecord>();
  const queue: string[] = [source.entry];

  const rememberWarning = (id: string, message: string): void => {
    warnings.push(`${id}: ${message}`);
  };

  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    if (records.has(id)) continue;
    if (records.size >= maxModules) {
      throw new PluginModuleError(PluginModuleErrorCode.PACKAGE_INVALID, {
        detail: `module graph exceeds ${maxModules} modules`,
        max: maxModules,
      });
    }

    const fileSource = source.files.get(id);
    if (fileSource === undefined) {
      throw new PluginModuleError(PluginModuleErrorCode.PACKAGE_INVALID, {
        id,
        detail: 'imported module is missing from the package',
      });
    }
    if (fileSource.length > maxSourceBytes) {
      throw new PluginModuleError(PluginModuleErrorCode.PACKAGE_INVALID, {
        id,
        detail: `module source exceeds ${maxSourceBytes} bytes`,
        max: maxSourceBytes,
      });
    }

    const location = pluginModuleLocation(source.pluginId, id);
    const digest = sha256Hex(fileSource);
    const kind = moduleKind(id);

    let imports: string[] = [];
    let exports: string[] = [];
    if (kind === 'json') {
      try {
        JSON.parse(fileSource);
      } catch (error) {
        throw new PluginModuleError(PluginModuleErrorCode.PACKAGE_INVALID, {
          id,
          detail: 'invalid JSON module',
          cause: error instanceof Error ? error.message : String(error),
        });
      }
      exports = ['default'];
    } else {
      let parsed: ModuleSource;
      try {
        parsed = new ModuleSource(fileSource, location);
      } catch (error) {
        throw new PluginModuleError(PluginModuleErrorCode.PACKAGE_INVALID, {
          id,
          detail: 'module is not valid SES-compatible ES module',
          cause: error instanceof Error ? error.message : String(error),
        });
      }
      imports = [...parsed.imports];
      exports = [...parsed.exports];
    }

    if (/\brequire\s*\(/.test(fileSource)) {
      rememberWarning(id, 'uses require(): unsupported outside the compartment');
    }
    if (/\beval\s*\(/.test(fileSource)) {
      rememberWarning(id, 'uses eval(): dynamic code (§6.8)');
    }
    if (/\bFunction\s*\(/.test(fileSource)) {
      rememberWarning(id, 'uses Function(): dynamic code (§6.8)');
    }
    if (/module\.exports\b/.test(fileSource)) {
      rememberWarning(id, 'CommonJS module.exports idiom detected');
    }

    // Dynamic-import targets join the static import set: they must resolve
    // inside the signed graph or the build fails (§6.4).
    const allSpecifiers = [...imports];
    if (kind === 'js') {
      for (const dynamicSpecifier of collectDynamicImports(fileSource)) {
        if (!allSpecifiers.includes(dynamicSpecifier)) allSpecifiers.push(dynamicSpecifier);
      }
    }

    const resolvedImports: Record<string, string> = {};
    const existingIds = new Set(source.files.keys());
    for (const specifier of allSpecifiers) {
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        const resolvedId = resolveRelativeId(id, specifier, existingIds);
        if (resolvedId === '') {
          throw new PluginModuleError(PluginModuleErrorCode.PACKAGE_INVALID, {
            id,
            specifier,
            detail: 'relative import does not resolve inside the package',
          });
        }
        resolvedImports[specifier] = resolvedId;
        queue.push(resolvedId);
        continue;
      }
      if (isNodeBuiltin(specifier)) {
        if (!allowedNodeBuiltins.includes(specifier)) {
          throw new PluginModuleError(PluginModuleErrorCode.UNSUPPORTED_NODE_BUILTIN, {
            id,
            specifier,
            detail: 'Node builtin is not vetted by the §9 compat layer',
          });
        }
        resolvedImports[specifier] = specifier;
        continue;
      }
      if (allowedDependencies.includes(specifier)) {
        resolvedImports[specifier] = specifier;
        continue;
      }
      throw new PluginModuleError(PluginModuleErrorCode.UNSUPPORTED_DEPENDENCY, {
        id,
        specifier,
        detail: 'external package is not part of the signed graph (§7.2)',
      });
    }

    records.set(id, {
      id,
      location,
      kind,
      digest,
      imports: allSpecifiers,
      exports,
      resolvedImports,
      source: fileSource,
    });
  }

  const sorted = [...records.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    graph: {
      pluginId: source.pluginId,
      entry: source.entry,
      records: sorted,
    },
    warnings,
  };
}
