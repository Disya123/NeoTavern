/**
 * Resource governance contracts (ТЗ Plugin SDK vNext §8, §20).
 *
 * Single source of truth for the low-VPS resource profile: the YAML config
 * file schema, the runtime limits handshake version, and the admin
 * diagnostics payload. Values are MiB for memory and plain integers for
 * concurrency, matching the ТЗ §20 table.
 *
 * Profile names (ТЗ §20.1): `low-vps-3gb` is the reference profile for
 * 3 GiB / 2 vCPU; `low-vps-2gb` is the frozen compatibility profile for
 * existing 2 GiB installs (MIG-05: an upgrade must not silently raise
 * budgets); `standard` is the loose preset for capable machines; `custom`
 * means the config file supplies the overrides on top of the `low-vps-3gb`
 * base.
 */
import { Type, type Static } from '@sinclair/typebox';

/** Named resource profiles. `low-vps-3gb` is the default server profile. */
export const PluginResourceProfileNameSchema = Type.Union([
  Type.Literal('low-vps-3gb'),
  Type.Literal('low-vps-2gb'),
  Type.Literal('standard'),
  Type.Literal('custom'),
]);
export type PluginResourceProfileName = Static<typeof PluginResourceProfileNameSchema>;

/** Resource-pressure levels reported by the governor (ТЗ §8.4 ladder). */
export const PluginPressureLevelSchema = Type.Union([
  Type.Literal('ok'),
  Type.Literal('soft'),
  Type.Literal('elevated'),
  Type.Literal('critical'),
  Type.Literal('hard'),
]);
export type PluginPressureLevel = Static<typeof PluginPressureLevelSchema>;

/** Per-plugin budget section of the resource profile (ТЗ §8.1). */
export const PluginResourcePluginsSchema = Type.Object(
  {
    maxActiveBackends: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
    maxWarmBackends: Type.Optional(Type.Integer({ minimum: 0, maximum: 16 })),
    defaultIdleTimeoutSec: Type.Optional(Type.Integer({ minimum: 5, maximum: 3600 })),
    aggregateRssSoftMiB: Type.Optional(Type.Integer({ minimum: 64 })),
    aggregateRssHardMiB: Type.Optional(Type.Integer({ minimum: 64 })),
    defaultProcessHeapMiB: Type.Optional(Type.Integer({ minimum: 16, maximum: 8192 })),
    defaultProcessRssSoftMiB: Type.Optional(Type.Integer({ minimum: 16 })),
    defaultProcessRssHardMiB: Type.Optional(Type.Integer({ minimum: 16 })),
    cpuHeavyConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
    backgroundCpuPercent: Type.Optional(Type.Integer({ minimum: 1, maximum: 800 })),
    networkGlobalConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 256 })),
    networkPerPluginConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
    serviceGlobalConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 256 })),
    servicePerPluginConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
    serviceInFlightMiBPerPlugin: Type.Optional(Type.Integer({ minimum: 1, maximum: 1024 })),
    jobsGlobalConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
    jobsPerPluginConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
    eventReplayBytesMiB: Type.Optional(Type.Integer({ minimum: 1 })),
    eventReplayBytesPerNameMiB: Type.Optional(Type.Integer({ minimum: 1 })),
    ipcInFlightBytesMiB: Type.Optional(Type.Integer({ minimum: 1 })),
    ipcInFlightBytesPerPluginMiB: Type.Optional(Type.Integer({ minimum: 1 })),
    installConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
    dependencyUnpackedMiBPerPlugin: Type.Optional(Type.Integer({ minimum: 8 })),
  },
  { additionalProperties: false },
);
export type PluginResourcePluginsConfig = Static<typeof PluginResourcePluginsSchema>;

/** Server-process budget section of the resource profile. */
export const PluginResourceServerSchema = Type.Object(
  {
    nodeHeapMiB: Type.Optional(Type.Integer({ minimum: 64, maximum: 8192 })),
    processTreeRssSoftMiB: Type.Optional(Type.Integer({ minimum: 256 })),
    processTreeRssHardMiB: Type.Optional(Type.Integer({ minimum: 256 })),
    mainRssTargetMiB: Type.Optional(Type.Integer({ minimum: 64 })),
    mainRssHardMiB: Type.Optional(Type.Integer({ minimum: 128 })),
  },
  { additionalProperties: false },
);
export type PluginResourceServerConfig = Static<typeof PluginResourceServerSchema>;

/** SQLite budget section of the resource profile. */
export const PluginResourceDatabaseSchema = Type.Object(
  {
    cacheMiB: Type.Optional(Type.Integer({ minimum: 4, maximum: 4096 })),
    maintenancePriority: Type.Optional(
      Type.Union([Type.Literal('background'), Type.Literal('interactive')]),
    ),
  },
  { additionalProperties: false },
);
export type PluginResourceDatabaseConfig = Static<typeof PluginResourceDatabaseSchema>;

/**
 * Resource-profile config file (YAML, `NEOTA_CONFIG_FILE`). Mirrors ТЗ §20:
 * a profile name plus per-section overrides. Everything is optional — the
 * profile presets supply the defaults.
 */
export const PluginResourceConfigFileSchema = Type.Object(
  {
    resourceProfile: Type.Optional(PluginResourceProfileNameSchema),
    server: Type.Optional(PluginResourceServerSchema),
    plugins: Type.Optional(PluginResourcePluginsSchema),
    database: Type.Optional(PluginResourceDatabaseSchema),
  },
  { additionalProperties: false },
);
export type PluginResourceConfigFile = Static<typeof PluginResourceConfigFileSchema>;

/**
 * Versioned limits handshake passed to a backend plugin process via
 * `NEOTA_PLUGIN_RESOURCE_LIMITS` (ТЗ RES-09). Version bumps are additive-only.
 */
export const PluginResourceLimitsSchema = Type.Object(
  {
    version: Type.Literal(1),
    heapMiB: Type.Integer({ minimum: 1 }),
    rssSoftMiB: Type.Integer({ minimum: 1 }),
    rssHardMiB: Type.Integer({ minimum: 1 }),
    cpuSoftPercent: Type.Integer({ minimum: 1, maximum: 800 }),
    cpuHardPercent: Type.Integer({ minimum: 1, maximum: 800 }),
  },
  { additionalProperties: false },
);
export type PluginResourceLimits = Static<typeof PluginResourceLimitsSchema>;

/** One governed backend process inside the admin diagnostics payload. */
export const PluginRuntimeProcessSchema = Type.Object({
  pluginId: Type.String({ minLength: 1, maxLength: 160 }),
  pid: Type.Integer({ minimum: 0 }),
  heapMiB: Type.Integer({ minimum: 1 }),
  rssSoftMiB: Type.Integer({ minimum: 1 }),
  rssHardMiB: Type.Integer({ minimum: 1 }),
  rssMiB: Type.Optional(Type.Number({ minimum: 0 })),
  cpuMs: Type.Optional(Type.Number({ minimum: 0 })),
  source: Type.Optional(Type.Union([Type.Literal('proc'), Type.Literal('ipc')])),
});
export type PluginRuntimeProcess = Static<typeof PluginRuntimeProcessSchema>;

/** One recorded governor action (throttle/suspend/kill) — OBS-03 shape. */
export const PluginGovernorActionSchema = Type.Object({
  at: Type.Integer({ minimum: 0 }),
  traceId: Type.String({ minLength: 1 }),
  pluginId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  resource: Type.String({ minLength: 1, maxLength: 64 }),
  currentMiB: Type.Optional(Type.Number({ minimum: 0 })),
  limitMiB: Type.Optional(Type.Number({ minimum: 0 })),
  action: Type.String({ minLength: 1, maxLength: 64 }),
});
export type PluginGovernorAction = Static<typeof PluginGovernorActionSchema>;

/** Admin diagnostics payload for the resource governor (OBS-01, no secrets). */
export const PluginRuntimeResourcesResponseSchema = Type.Object({
  profile: PluginResourceProfileNameSchema,
  limitsVersion: Type.Literal(1),
  level: PluginPressureLevelSchema,
  budgets: Type.Object({
    mainHeapMiB: Type.Integer(),
    mainRssHardMiB: Type.Integer(),
    treeSoftMiB: Type.Integer(),
    treeHardMiB: Type.Integer(),
    aggregateSoftMiB: Type.Integer(),
    aggregateHardMiB: Type.Integer(),
  }),
  measurements: Type.Object({
    mainRssMiB: Type.Number({ minimum: 0 }),
    aggregateRssMiB: Type.Number({ minimum: 0 }),
    treeRssMiB: Type.Number({ minimum: 0 }),
    cgroup: Type.Optional(
      Type.Object({
        available: Type.Boolean(),
        currentMiB: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
        maxMiB: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
      }),
    ),
  }),
  processes: Type.Array(PluginRuntimeProcessSchema),
  actions: Type.Array(PluginGovernorActionSchema),
});
export type PluginRuntimeResourcesResponse = Static<typeof PluginRuntimeResourcesResponseSchema>;
