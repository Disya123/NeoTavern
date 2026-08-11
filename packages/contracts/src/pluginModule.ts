/**
 * Plugin module-graph contracts (ТЗ Plugin SDK vNext v3.2 §6, §8.1, §8.6,
 * §8.8, §40.1.2).
 *
 * The canonical plugin package is SOURCE (§8.1); the build/runtime derives a
 * module-map manifest from it (§6.2): one record per module with a stable
 * virtual location `neotavern-plugin://<pluginId>/<path>` (§8.6), a SHA-256 digest
 * over the module source, the import/export lists produced by
 * `@endo/module-source` and the resolved import map used by the SES
 * `Compartment` hooks.
 *
 * Records are deliberately dependency-free of Node (pure TypeBox + Web
 * primitives) so both the trusted runtime and the worker consume the same
 * shape. The worker bootstrap inlines the few string constants (code values
 * and the `neotavern-plugin://` scheme) to keep its pre-lockdown capture minimal;
 * the integration test pins them against the values below.
 */
import { Type, type Static } from '@sinclair/typebox';

/** Maximum modules in one plugin graph (import-time runaway guard, §6.7). */
export const PLUGIN_MODULE_MAX_COUNT = 256;

/** Maximum source size of a single module record in bytes. */
export const PLUGIN_MODULE_MAX_SOURCE_BYTES = 1024 * 1024;

/** Virtual location scheme for plugin modules (§8.6, §40.1.2). */
export const PLUGIN_MODULE_VIRTUAL_SCHEME = 'neotavern-plugin';

/**
 * Stable virtual location of a module (used for resolution, stack traces,
 * diagnostics and source maps). Host filesystem paths never leak into it.
 */
export function pluginModuleLocation(pluginId: string, id: string): string {
  return `${PLUGIN_MODULE_VIRTUAL_SCHEME}://${pluginId}/${String(id).replace(/^\/+/, '')}`;
}

/** Module-loading error codes (Stage B plan: PACKAGE_INVALID,
 * UNSUPPORTED_DEPENDENCY, UNSUPPORTED_NODE_BUILTIN + the loader-internal
 * codes below). */
export const PluginModuleErrorCode = {
  /** Package shape, entry, syntax or module content is invalid. */
  PACKAGE_INVALID: 'PACKAGE_INVALID',
  /** Import resolves outside the signed graph (external package, §7.2). */
  UNSUPPORTED_DEPENDENCY: 'UNSUPPORTED_DEPENDENCY',
  /** Import targets a Node builtin that the compat layer does not vet (§9). */
  UNSUPPORTED_NODE_BUILTIN: 'UNSUPPORTED_NODE_BUILTIN',
  /** Dynamic/static import target is not present in the signed graph (§6.4). */
  MODULE_NOT_IN_GRAPH: 'MODULE_NOT_IN_GRAPH',
  /** Record digest does not match the shipped source. */
  MODULE_DIGEST_MISMATCH: 'MODULE_DIGEST_MISMATCH',
  /** The entry module graph failed to link or evaluate (§6.7). */
  MODULE_EVALUATION_FAILED: 'MODULE_EVALUATION_FAILED',
} as const;

export type PluginModuleErrorCodeValue =
  (typeof PluginModuleErrorCode)[keyof typeof PluginModuleErrorCode];

/** Stable machine-readable module-loading error (AGENTS.md §5). */
export class PluginModuleError extends Error {
  readonly code: PluginModuleErrorCodeValue;
  readonly params: Record<string, unknown>;

  constructor(code: PluginModuleErrorCodeValue, params: Record<string, unknown> = {}) {
    super(code);
    this.name = 'PluginModuleError';
    this.code = code;
    this.params = params;
  }
}

export const PluginModuleRecordSchema = Type.Object(
  {
    /** Package-relative posix path that identifies the module (no `../`). */
    id: Type.String({ minLength: 1, maxLength: 1024 }),
    /** Virtual location `neotavern-plugin://<pluginId>/<id>` (§8.6). */
    location: Type.String({ minLength: 1, maxLength: 1024 }),
    kind: Type.Union([Type.Literal('js'), Type.Literal('json')]),
    /** SHA-256 hex (64 chars) over the UTF-8 module source. */
    digest: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    /** Import specifiers exactly as written in source (from ModuleSource). */
    imports: Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 512 }),
    /** Export names declared by the module (from ModuleSource). */
    exports: Type.Array(Type.String({ maxLength: 256 }), { maxItems: 512 }),
    /**
     * `imports` specifier -> resolved module `id` inside the graph. Built
     * once by the trusted builder so the worker never re-implements Node
     * resolution (§8.9: no custom resolver).
     */
    resolvedImports: Type.Record(
      Type.String({ maxLength: 1024 }),
      Type.String({ minLength: 1, maxLength: 1024 }),
      { maxAdditionalProperties: 512 },
    ),
    /** Originating dependency package when the module is vendored (§6.2). */
    dependencyPackage: Type.Optional(Type.String({ maxLength: 256 })),
    /**
     * UTF-8 module source. Present on the wire/bridge payload and in the
     * `modules/*.json` records; stripped from the canonical `module-map.json`
     * manifest (which only carries the signed metadata, §6.2).
     */
    source: Type.Optional(Type.String({ maxLength: PLUGIN_MODULE_MAX_SOURCE_BYTES })),
  },
  { additionalProperties: false },
);
export type PluginModuleRecord = Static<typeof PluginModuleRecordSchema>;

export const PluginModuleGraphSchema = Type.Object(
  {
    pluginId: Type.String({ minLength: 1, maxLength: 160 }),
    /** Package-relative entry module id (§6.2). */
    entry: Type.String({ minLength: 1, maxLength: 1024 }),
    records: Type.Array(PluginModuleRecordSchema, { maxItems: PLUGIN_MODULE_MAX_COUNT }),
  },
  { additionalProperties: false },
);
export type PluginModuleGraph = Static<typeof PluginModuleGraphSchema>;

/**
 * `module-map.json` manifest: the signed metadata of the graph without any
 * source payload (§6.2). `records` are sorted by id for reproducibility.
 */
export function toModuleMapManifest(graph: PluginModuleGraph): {
  pluginId: string;
  entry: string;
  records: Array<Omit<PluginModuleRecord, 'source'>>;
} {
  return {
    pluginId: graph.pluginId,
    entry: graph.entry,
    records: graph.records
      .map((record) => {
        const { source: _source, ...rest } = record;
        void _source;
        return rest;
      })
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}
