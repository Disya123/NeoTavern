/**
 * Redacted diagnostics contracts.
 *
 * The snapshot intentionally contains aggregate state only. Absolute paths,
 * logs, user-authored content, provider settings and credentials are not part
 * of this public contract.
 */
import { Type, type Static } from '@sinclair/typebox';

export const DiagnosticEntityCountsSchema = Type.Object({
  characters: Type.Integer({ minimum: 0 }),
  chats: Type.Integer({ minimum: 0 }),
  messages: Type.Integer({ minimum: 0 }),
  personas: Type.Integer({ minimum: 0 }),
  lorebooks: Type.Integer({ minimum: 0 }),
  presets: Type.Integer({ minimum: 0 }),
});
export type DiagnosticEntityCounts = Static<typeof DiagnosticEntityCountsSchema>;

export const DiagnosticsSnapshotSchema = Type.Object({
  formatVersion: Type.Literal(1),
  generatedAt: Type.Integer({ minimum: 0 }),
  app: Type.Object({
    version: Type.String(),
    apiVersion: Type.Integer({ minimum: 1 }),
    nodeVersion: Type.String(),
    platform: Type.String(),
    architecture: Type.String(),
    uptimeSeconds: Type.Number({ minimum: 0 }),
    remoteAccess: Type.Boolean(),
  }),
  database: Type.Object({
    integrity: Type.Union([Type.Literal('ok'), Type.Literal('error')]),
    schemaVersion: Type.Integer({ minimum: -1 }),
    migrationCount: Type.Integer({ minimum: 0 }),
    sizeBytes: Type.Integer({ minimum: 0 }),
    entities: DiagnosticEntityCountsSchema,
  }),
  storage: Type.Object({
    filesBytes: Type.Integer({ minimum: 0 }),
    cacheBytes: Type.Integer({ minimum: 0 }),
    backupsBytes: Type.Integer({ minimum: 0 }),
    freeBytes: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  }),
  providers: Type.Object({
    registeredKinds: Type.Array(Type.String()),
    configured: Type.Integer({ minimum: 0 }),
    enabled: Type.Integer({ minimum: 0 }),
  }),
  plugins: Type.Object({
    installed: Type.Integer({ minimum: 0 }),
    enabled: Type.Integer({ minimum: 0 }),
  }),
  themes: Type.Object({
    installed: Type.Integer({ minimum: 0 }),
    enabled: Type.Integer({ minimum: 0 }),
    safeModeAvailable: Type.Literal(true),
  }),
  privacy: Type.Object({
    redacted: Type.Literal(true),
    secretsIncluded: Type.Literal(false),
    userContentIncluded: Type.Literal(false),
    absolutePathsIncluded: Type.Literal(false),
    logsIncluded: Type.Literal(false),
  }),
});
export type DiagnosticsSnapshot = Static<typeof DiagnosticsSnapshotSchema>;

export const CacheCleanupResultSchema = Type.Object({
  removedFiles: Type.Integer({ minimum: 0 }),
  removedBytes: Type.Integer({ minimum: 0 }),
  metadataRowsRemoved: Type.Integer({ minimum: 0 }),
});
export type CacheCleanupResult = Static<typeof CacheCleanupResultSchema>;
