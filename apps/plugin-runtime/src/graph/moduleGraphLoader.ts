/**
 * Module-graph loader into an SES Compartment (ТЗ Plugin SDK vNext v3.2 §6.4,
 * §8.8, §40.1.2).
 *
 * Consumes a graph produced by the trusted builder and evaluates it inside a
 * Compartment whose `resolveHook`/`importHook` serve ONLY the signed graph:
 * - every module source is re-verified against its SHA-256 digest before
 *   evaluation (MODULE_DIGEST_MISMATCH);
 * - relative imports are resolved through the builder's `resolvedImports`
 *   map, so the worker never re-implements Node resolution (§8.9);
 * - any import (static or dynamic) whose target is absent from the graph is
 *   rejected with MODULE_NOT_IN_GRAPH (§6.4);
 * - each module is compiled via `ModuleSource(source, virtualLocation)`, so
 *   stack traces and diagnostics expose `neotavern-plugin://` locations and never
 *   host filesystem paths (§40.1.2).
 *
 * The loader may run in the trusted runtime or in the worker; the worker
 * bootstrap inlines the same wiring in plain ESM to keep its pre-lockdown
 * capture minimal (see `workerGraph.test.ts` which pins both paths).
 */
import { ModuleSource } from '@endo/module-source';
import type { CompartmentOptions } from 'ses';
import {
  PluginModuleError,
  PluginModuleErrorCode,
  pluginModuleLocation,
  type PluginModuleGraph,
  type PluginModuleRecord,
} from '@neotavern/contracts';
import { sha256Hex } from './digest.js';

const CompartmentCtor = (globalThis as unknown as { Compartment: typeof Compartment }).Compartment;

export interface PreparedModuleGraph {
  pluginId: string;
  entry: string;
  byLocation: ReadonlyMap<string, PluginModuleRecord>;
}

export interface LoadModuleGraphOptions {
  /** Vetted endowments exposed to plugin code (empty default; §5.4). */
  endowments?: Record<string, unknown>;
  /** Compartment name for diagnostics. */
  name?: string;
}

export interface LoadModuleGraphResult {
  /** Live module namespace of the entry module. */
  namespace: Record<string, unknown>;
  /** Stable export names of the entry module. */
  exportNames: string[];
}

/** Structural validation + location index for a signed graph. */
export function prepareModuleGraph(graph: PluginModuleGraph): PreparedModuleGraph {
  if (typeof graph !== 'object' || graph === null) {
    throw new PluginModuleError(PluginModuleErrorCode.PACKAGE_INVALID, {
      detail: 'graph must be an object',
    });
  }
  if (typeof graph.pluginId !== 'string' || graph.pluginId.length === 0) {
    throw new PluginModuleError(PluginModuleErrorCode.PACKAGE_INVALID, {
      detail: 'pluginId is required',
    });
  }
  if (typeof graph.entry !== 'string' || graph.entry.length === 0) {
    throw new PluginModuleError(PluginModuleErrorCode.PACKAGE_INVALID, {
      detail: 'entry is required',
    });
  }
  if (!Array.isArray(graph.records)) {
    throw new PluginModuleError(PluginModuleErrorCode.PACKAGE_INVALID, {
      detail: 'records must be an array',
    });
  }
  const byLocation = new Map<string, PluginModuleRecord>();
  for (const record of graph.records) {
    if (
      record === null ||
      typeof record !== 'object' ||
      typeof record.id !== 'string' ||
      typeof record.location !== 'string'
    ) {
      throw new PluginModuleError(PluginModuleErrorCode.PACKAGE_INVALID, {
        detail: 'malformed module record',
      });
    }
    if (byLocation.has(record.location)) {
      throw new PluginModuleError(PluginModuleErrorCode.PACKAGE_INVALID, {
        location: record.location,
        detail: 'duplicate module location',
      });
    }
    byLocation.set(record.location, record);
  }
  const entryLocation = pluginModuleLocation(graph.pluginId, graph.entry);
  if (!byLocation.has(entryLocation)) {
    throw new PluginModuleError(PluginModuleErrorCode.MODULE_NOT_IN_GRAPH, {
      specifier: entryLocation,
      detail: 'entry module is not present in the graph',
    });
  }
  return { pluginId: graph.pluginId, entry: graph.entry, byLocation };
}

/**
 * ResolveHook implementation over the prepared graph. Throws
 * MODULE_NOT_IN_GRAPH for specifiers that are not part of the signed graph.
 *
 * All resolution happens ONCE in the trusted builder and ships as the
 * record's `resolvedImports` map — the worker never re-implements Node
 * resolution (§8.9). Dynamic imports are discovered by the builder too
 * (§6.4), so any specifier not present in the map is rejected here.
 */
export function resolveGraphSpecifier(
  prepared: PreparedModuleGraph,
  specifier: string,
  referrer: string,
): string {
  const referrerRecord = prepared.byLocation.get(referrer);
  if (referrerRecord === undefined) {
    throw new PluginModuleError(PluginModuleErrorCode.MODULE_NOT_IN_GRAPH, {
      specifier,
      referrer,
      detail: 'referrer module is not part of the graph',
    });
  }
  const resolvedId = referrerRecord.resolvedImports[specifier];
  if (resolvedId === undefined) {
    throw new PluginModuleError(PluginModuleErrorCode.MODULE_NOT_IN_GRAPH, {
      specifier,
      referrer,
      detail: 'import target is not part of the signed graph (§6.4)',
    });
  }
  return pluginModuleLocation(prepared.pluginId, resolvedId);
}

/**
 * ImportHook implementation over the prepared graph: digest verification plus
 * `ModuleSource(source, virtualLocation)` compilation. JSON modules are
 * wrapped as `export default <json>`.
 */
export function moduleDescriptorFor(
  prepared: PreparedModuleGraph,
  specifier: string,
): ModuleSource {
  const record = prepared.byLocation.get(specifier);
  if (record === undefined) {
    throw new PluginModuleError(PluginModuleErrorCode.MODULE_NOT_IN_GRAPH, {
      specifier,
      detail: 'module is not part of the signed graph (§6.4)',
    });
  }
  if (typeof record.source !== 'string') {
    throw new PluginModuleError(PluginModuleErrorCode.PACKAGE_INVALID, {
      id: record.id,
      detail: 'record carries no source payload',
    });
  }
  const digest = sha256Hex(record.source);
  if (digest !== record.digest) {
    throw new PluginModuleError(PluginModuleErrorCode.MODULE_DIGEST_MISMATCH, {
      id: record.id,
      location: record.location,
      detail: 'module source does not match its signed digest',
    });
  }
  if (record.kind === 'json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(record.source);
    } catch (error) {
      throw new PluginModuleError(PluginModuleErrorCode.PACKAGE_INVALID, {
        id: record.id,
        detail: 'invalid JSON module',
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    void parsed;
    return new ModuleSource(`export default ${record.source}`, record.location);
  }
  try {
    return new ModuleSource(record.source, record.location);
  } catch (error) {
    throw new PluginModuleError(PluginModuleErrorCode.PACKAGE_INVALID, {
      id: record.id,
      location: record.location,
      detail: 'module is not valid SES-compatible ES module',
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

/** One-shot load: build the graph compartment, import the entry, return the
 * entry namespace. */
export async function loadModuleGraph(
  graph: PluginModuleGraph,
  options: LoadModuleGraphOptions = {},
): Promise<LoadModuleGraphResult> {
  const prepared = prepareModuleGraph(graph);
  const compartmentOptions: CompartmentOptions = {
    name: options.name,
    noAggregateLoadErrors: true,
    resolveHook: (specifier, referrer) => resolveGraphSpecifier(prepared, specifier, referrer),
    importHook: async (specifier) => moduleDescriptorFor(prepared, specifier),
  };
  const compartment = new CompartmentCtor(options.endowments ?? {}, {}, compartmentOptions);
  const entryLocation = pluginModuleLocation(prepared.pluginId, prepared.entry);
  let namespace: Record<string, unknown>;
  try {
    ({ namespace } = await compartment.import(entryLocation));
  } catch (error) {
    if (error instanceof PluginModuleError) throw error;
    // A plugin error must never be masked by diagnostics: reading `error.stack`
    // may itself throw (e.g. vitest's prepareStackTrace interceptor crashing on
    // hardened errors), so degrade to the message if stack capture fails.
    let cause: string;
    try {
      cause = error instanceof Error ? (error.stack ?? error.message) : String(error);
    } catch {
      cause = error instanceof Error ? error.message : String(error);
    }
    throw new PluginModuleError(PluginModuleErrorCode.MODULE_EVALUATION_FAILED, {
      entry: entryLocation,
      detail: 'module graph failed to link or evaluate (§6.7)',
      cause,
    });
  }
  return { namespace, exportNames: Object.keys(namespace) };
}
