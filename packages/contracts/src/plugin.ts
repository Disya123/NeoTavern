/** Public plugin package, consent and lifecycle API contracts. */
import { Type, type Static } from '@sinclair/typebox';

export const PluginIdSchema = Type.String({
  minLength: 3,
  maxLength: 160,
  pattern: '^[a-z0-9][a-z0-9_-]*(\\.[a-z0-9][a-z0-9_-]*)+$',
});
export type PluginId = Static<typeof PluginIdSchema>;

export const PluginRuntimeStatusSchema = Type.Union([
  Type.Literal('disabled'),
  Type.Literal('active'),
  Type.Literal('needs-consent'),
  Type.Literal('error'),
]);
export type PluginRuntimeStatus = Static<typeof PluginRuntimeStatusSchema>;

/**
 * Package trust state (ТЗ §SEC-05): how the installed package content was
 * vouched for. `built-in` packages ship with the product; `verified-publisher`
 * packages carry a signature from a trusted publisher key; `locally-trusted`
 * packages are unsigned but were explicitly accepted by the local user;
 * `unsigned-untrusted` packages have no signature and no local trust decision.
 */
export const PluginPackageTrustSchema = Type.Union([
  Type.Literal('built-in'),
  Type.Literal('verified-publisher'),
  Type.Literal('locally-trusted'),
  Type.Literal('unsigned-untrusted'),
]);
export type PluginPackageTrust = Static<typeof PluginPackageTrustSchema>;

/** Where an installed plugin package came from. */
export const PluginSourceSchema = Type.Union([
  Type.Object({ type: Type.Literal('zip') }, { additionalProperties: false }),
  Type.Object(
    {
      type: Type.Literal('git'),
      url: Type.String(),
      ref: Type.Optional(Type.String()),
      resolvedRef: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
]);
export type PluginSource = Static<typeof PluginSourceSchema>;

/** One npm dependency materialized into the package's node_modules. */
export const PluginDependencyRecordSchema = Type.Object(
  {
    name: Type.String(),
    version: Type.String(),
    tarball: Type.Optional(Type.String()),
    integrity: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type PluginDependencyRecord = Static<typeof PluginDependencyRecordSchema>;

/** A granted capability as delivered to the web host (rev4 §A1 handshake). */
export const CapabilityGrantWireSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 128 }),
  scope: Type.Optional(Type.Unknown()),
  revision: Type.Integer({ minimum: 1 }),
  grantedAt: Type.Integer({ minimum: 0 }),
});
export type CapabilityGrantWire = Static<typeof CapabilityGrantWireSchema>;

export const PluginCapabilitiesResponseSchema = Type.Object({
  items: Type.Array(CapabilityGrantWireSchema),
});
export type PluginCapabilitiesResponse = Static<typeof PluginCapabilitiesResponseSchema>;

/** Runtime capability grant request from a sandboxed plugin (rev4 §B2). */
export const PluginCapabilityRequestSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 128 }),
    scope: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);
export type PluginCapabilityRequest = Static<typeof PluginCapabilityRequestSchema>;

export const PluginCapabilityGrantResponseSchema = Type.Object({
  grant: CapabilityGrantWireSchema,
});
export type PluginCapabilityGrantResponse = Static<typeof PluginCapabilityGrantResponseSchema>;
export const InstalledPluginSchema = Type.Object({
  id: PluginIdSchema,
  name: Type.String({ minLength: 1, maxLength: 200 }),
  version: Type.String({ minLength: 1, maxLength: 100 }),
  apiVersion: Type.Integer({ minimum: 1 }),
  enabled: Type.Boolean(),
  status: PluginRuntimeStatusSchema,
  manifest: Type.Record(Type.String(), Type.Unknown()),
  requestedPermissions: Type.Array(Type.String()),
  grantedPermissions: Type.Array(Type.String()),
  addedPermissions: Type.Array(Type.String()),
  installedAt: Type.Integer({ minimum: 0 }),
  updatedAt: Type.Integer({ minimum: 0 }),
  hasFrontend: Type.Boolean(),
  hasBackend: Type.Boolean(),
  hasStyles: Type.Boolean(),
  hasLegacyFrontend: Type.Boolean(),
  hasLegacyBackend: Type.Boolean(),
  compatibilityLevel: Type.Union([
    Type.Literal('native-v2'),
    Type.Literal('native-v3'),
    Type.Literal('legacy-trusted'),
  ]),
  lastErrorCode: Type.Union([Type.String(), Type.Null()]),
  source: Type.Optional(PluginSourceSchema),
  dependencies: Type.Optional(Type.Array(PluginDependencyRecordSchema)),
  grantedCapabilities: Type.Array(CapabilityGrantWireSchema),
  /** Package trust state (ТЗ §SEC-05); defaults to unsigned-untrusted. */
  trust: PluginPackageTrustSchema,
  /** Publisher key fingerprint for verified-publisher packages. */
  publisherKeyId: Type.Optional(Type.String()),
});
export type InstalledPlugin = Static<typeof InstalledPluginSchema>;

export const PluginListResponseSchema = Type.Object({
  items: Type.Array(InstalledPluginSchema),
  safeMode: Type.Boolean(),
});

export type PluginListResponse = Static<typeof PluginListResponseSchema>;

export const PluginInstallResultSchema = Type.Object({
  plugin: InstalledPluginSchema,
  replaced: Type.Boolean(),
});
export type PluginInstallResult = Static<typeof PluginInstallResultSchema>;

/** Request to install a plugin from a public Git repository archive. */
export const PluginGitInstallRequestSchema = Type.Object(
  {
    /** HTTPS repository URL (GitHub/GitLab web URL). */
    url: Type.String({ minLength: 1, maxLength: 2048 }),
    /** Optional branch/tag/commit ref. Required by providers without a HEAD archive alias. */
    ref: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);
export type PluginGitInstallRequest = Static<typeof PluginGitInstallRequestSchema>;

export const PluginActivateRequestSchema = Type.Object(
  {
    grantedPermissions: Type.Array(Type.String({ minLength: 1 }), {
      uniqueItems: true,
      maxItems: 100,
    }),
  },
  { additionalProperties: false },
);
export type PluginActivateRequest = Static<typeof PluginActivateRequestSchema>;

export const PluginLifecycleResultSchema = Type.Object({
  plugin: InstalledPluginSchema,
});
export type PluginLifecycleResult = Static<typeof PluginLifecycleResultSchema>;

export const PluginDeleteResultSchema = Type.Object({
  deleted: Type.Boolean(),
});
export type PluginDeleteResult = Static<typeof PluginDeleteResultSchema>;

export const PluginSafeModeResultSchema = Type.Object({
  safeMode: Type.Boolean(),
});
export type PluginSafeModeResult = Static<typeof PluginSafeModeResultSchema>;
