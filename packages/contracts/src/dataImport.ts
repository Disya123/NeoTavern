/**
 * Contracts for importing a complete full-data archive.
 *
 * Warnings use stable machine codes and parameters; localization remains a
 * frontend concern. Only a bounded warning sample is returned, while
 * `warningCount` reports the full total.
 */
import { Type, type Static } from '@sinclair/typebox';
import { IdSchema } from './common.js';

export const FullBackupCategoryIdSchema = Type.Union([
  Type.Literal('characters'),
  Type.Literal('chats'),
  Type.Literal('personas'),
  Type.Literal('lorebooks'),
  Type.Literal('presets'),
  Type.Literal('groups'),
  Type.Literal('backgrounds'),
  Type.Literal('extensionSettings'),
  Type.Literal('apiSettings'),
  Type.Literal('legacyExtensions'),
  Type.Literal('themes'),
]);
export type FullBackupCategoryId = Static<typeof FullBackupCategoryIdSchema>;

export const DataImportConflictPolicySchema = Type.Union([
  Type.Literal('skip'),
  Type.Literal('copy'),
  Type.Literal('merge'),
  Type.Literal('replace'),
]);
export type DataImportConflictPolicy = Static<typeof DataImportConflictPolicySchema>;

export const DataImportEntityCountSchema = Type.Object({
  imported: Type.Integer({ minimum: 0 }),
  reused: Type.Integer({ minimum: 0 }),
  skipped: Type.Integer({ minimum: 0 }),
});
export type DataImportEntityCount = Static<typeof DataImportEntityCountSchema>;

export const DataImportCountsSchema = Type.Object({
  characters: DataImportEntityCountSchema,
  chats: DataImportEntityCountSchema,
  messages: DataImportEntityCountSchema,
  personas: DataImportEntityCountSchema,
  lorebooks: DataImportEntityCountSchema,
  loreEntries: DataImportEntityCountSchema,
  presets: DataImportEntityCountSchema,
  groups: DataImportEntityCountSchema,
  backgrounds: DataImportEntityCountSchema,
  extensionSettings: DataImportEntityCountSchema,
  apiSettings: DataImportEntityCountSchema,
  legacyExtensions: DataImportEntityCountSchema,
  themes: DataImportEntityCountSchema,
});
export type DataImportCounts = Static<typeof DataImportCountsSchema>;

export const DataImportWarningSchema = Type.Object({
  code: Type.String({ pattern: '^[A-Z][A-Z0-9_]*$' }),
  path: Type.Optional(Type.String()),
  params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type DataImportWarning = Static<typeof DataImportWarningSchema>;

export const FullBackupCategoryAnalysisSchema = Type.Object({
  id: FullBackupCategoryIdSchema,
  discovered: Type.Integer({ minimum: 0 }),
  dependentRecords: Type.Integer({ minimum: 0 }),
  invalid: Type.Integer({ minimum: 0 }),
  conflicts: Type.Integer({ minimum: 0 }),
  sizeBytes: Type.Integer({ minimum: 0 }),
});
export type FullBackupCategoryAnalysis = Static<typeof FullBackupCategoryAnalysisSchema>;

export const DataImportConflictSchema = Type.Object({
  category: FullBackupCategoryIdSchema,
  sourceKey: Type.String(),
  path: Type.Optional(Type.String()),
  kind: Type.Union([Type.Literal('artifact'), Type.Literal('name')]),
  targetId: IdSchema,
  targetName: Type.String(),
  safePolicies: Type.Array(DataImportConflictPolicySchema, { minItems: 1 }),
});
export type DataImportConflict = Static<typeof DataImportConflictSchema>;

export const FullBackupAnalysisSchema = Type.Object({
  analysisId: IdSchema,
  sourceHash: Type.String({ pattern: '^[0-9a-f]{64}$' }),
  sourceName: Type.String(),
  expiresAt: Type.Integer(),
  archiveAlreadyImported: Type.Boolean(),
  totalCompressedBytes: Type.Integer({ minimum: 0 }),
  totalExpandedBytes: Type.Integer({ minimum: 0 }),
  categories: Type.Array(FullBackupCategoryAnalysisSchema),
  conflictCount: Type.Integer({ minimum: 0 }),
  conflicts: Type.Array(DataImportConflictSchema),
  warningCount: Type.Integer({ minimum: 0 }),
  warnings: Type.Array(DataImportWarningSchema),
});
export type FullBackupAnalysis = Static<typeof FullBackupAnalysisSchema>;

export const FullBackupExecuteSchema = Type.Object({
  categories: Type.Array(FullBackupCategoryIdSchema, {
    minItems: 1,
    uniqueItems: true,
  }),
  conflictPolicy: DataImportConflictPolicySchema,
});
export type FullBackupExecute = Static<typeof FullBackupExecuteSchema>;

export const FullBackupImportResultSchema = Type.Object({
  jobId: IdSchema,
  sourceHash: Type.String({ pattern: '^[0-9a-f]{64}$' }),
  sourceName: Type.String(),
  safetyBackupId: Type.String(),
  reusedArchive: Type.Boolean(),
  selectedCategories: Type.Optional(Type.Array(FullBackupCategoryIdSchema)),
  conflictPolicy: Type.Optional(DataImportConflictPolicySchema),
  counts: DataImportCountsSchema,
  warningCount: Type.Integer({ minimum: 0 }),
  warnings: Type.Array(DataImportWarningSchema),
});
export type FullBackupImportResult = Static<typeof FullBackupImportResultSchema>;
