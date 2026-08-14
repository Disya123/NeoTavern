/**
 * Drizzle ORM table definitions. These mirror the SQL in `migrations/` exactly.
 * Every entity has a stable string ID (UUIDv7); timestamps are epoch millis.
 * JSON blobs (ext/meta/settings) are stored as TEXT and parsed in repositories.
 */
import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/** Arbitrary app metadata (schema version, install id, etc.). */
export const appMeta = sqliteTable('app_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

/** Multi-profile support (default profile used for single-user local mode). */
export const profiles = sqliteTable('profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull(),
});

/** Key/value application settings (values are JSON). */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const personas = sqliteTable(
  'personas',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    avatar: text('avatar'),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  () => [index('personas_name_nocase_idx').on(sql`name COLLATE NOCASE`)],
);

export const characters = sqliteTable(
  'characters',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    avatar: text('avatar'),
    description: text('description').notNull().default(''),
    personality: text('personality').notNull().default(''),
    scenario: text('scenario').notNull().default(''),
    firstMessage: text('first_message').notNull().default(''),
    exampleDialogues: text('example_dialogues').notNull().default(''),
    systemPrompt: text('system_prompt'),
    postHistoryInstructions: text('post_history_instructions'),
    creator: text('creator'),
    creatorNotes: text('creator_notes'),
    ext: text('ext').notNull().default('{}'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    lastUsedAt: integer('last_used_at'),
    deletedAt: integer('deleted_at'),
    // Catalog sort counters (migration 0012). `favorite` mirrors
    // `ext.favorite` / `ext.legacy.favorite` so "favorites first" is indexable;
    // `ext` stays the source of truth and the API contract is unchanged.
    // `chat_count` / `token_count` exclude soft-deleted chats and are kept in
    // sync by SQL triggers on `chats` / `messages`.
    favorite: integer('favorite').notNull().default(0),
    chatCount: integer('chat_count').notNull().default(0),
    tokenCount: integer('token_count').notNull().default(0),
  },
  (table) => [
    index('characters_name_idx').on(table.name),
    index('characters_created_idx').on(table.createdAt),
    index('characters_last_used_idx').on(table.lastUsedAt),
    // Performance indexes from migration 0007 (mirrored here so drizzle-kit
    // push/generate cannot silently drop them — OTHER-62). Expression indexes
    // match the exact SQL expressions the query planner actually uses.
    index('characters_usage_idx').on(sql`COALESCE(last_used_at, 0) DESC`, sql`id DESC`),
    index('characters_import_hash_idx').on(sql`json_extract(ext, '$._st2.importHash')`),
    index('characters_name_nocase_idx').on(sql`name COLLATE NOCASE`),
    // Catalog sort indexes (migration 0012) — match the exact ORDER BY the
    // browser uses so a 100k-character catalog pages without a temp sort.
    index('characters_favorite_idx').on(sql`favorite DESC`, sql`name ASC`, sql`id ASC`),
    index('characters_chat_count_idx').on(sql`chat_count DESC`, sql`name ASC`, sql`id ASC`),
    index('characters_token_count_idx').on(sql`token_count DESC`, sql`name ASC`, sql`id ASC`),
  ],
);

export const tags = sqliteTable('tags', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
});

export const characterTags = sqliteTable(
  'character_tags',
  {
    characterId: text('character_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.characterId, table.tagId] })],
);

export const chats = sqliteTable(
  'chats',
  {
    id: text('id').primaryKey(),
    characterId: text('character_id').references(() => characters.id, { onDelete: 'set null' }),
    personaId: text('persona_id').references(() => personas.id, { onDelete: 'set null' }),
    title: text('title').notNull().default('New chat'),
    activeBranchId: text('active_branch_id'),
    // Wallpaper file in data/files/backgrounds/ (migration 0014). Plain
    // filename, no FK: the filesystem is authoritative.
    backgroundId: text('background_id'),
    summary: text('summary').notNull().default(''),
    messageCount: integer('message_count').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
    // Snapshot provenance (migration 0020): parent chat, origin, source message.
    parentChatId: text('parent_chat_id'),
    origin: text('origin', { enum: ['checkpoint', 'branch'] }),
    sourceMessageId: text('source_message_id'),
    // Manual ordering for the sidebar chat panel (migration 0013). New chats
    // default to 0 (top of the list); the repository renumbers all rows of a
    // character in one transaction on reorder. Ties fall back to updated_at.
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (table) => [
    index('chats_character_idx').on(table.characterId),
    index('chats_updated_idx').on(table.updatedAt),
    index('chats_character_sort_idx').on(
      table.characterId,
      table.sortOrder,
      table.updatedAt,
      table.id,
    ),
  ],
);

export const chatBranches = sqliteTable(
  'chat_branches',
  {
    id: text('id').primaryKey(),
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    name: text('name').notNull().default('main'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('chat_branches_chat_idx').on(table.chatId)],
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    branchId: text('branch_id')
      .notNull()
      .references(() => chatBranches.id, { onDelete: 'cascade' }),
    parentId: text('parent_id'),
    role: text('role', {
      enum: ['system', 'user', 'assistant', 'tool', 'plugin'],
    }).notNull(),
    content: text('content').notNull(),
    name: text('name'),
    meta: text('meta').notNull().default('{}'),
    createdAt: integer('created_at').notNull(),
    /** Compare-and-swap version (rev4 stage 3); bumped on every update. */
    revision: integer('revision').notNull().default(1),
    updatedAt: integer('updated_at'),
    /** Outbox dedupe: unique per chat; retried creates return the original. */
    idempotencyKey: text('idempotency_key'),
    // Swipe history (migration 0020): total variants incl. the active one,
    // active position within the permutation, and the checkpoint child chat.
    variantCount: integer('variant_count').notNull().default(0),
    activeVariantPosition: integer('active_variant_position'),
    /** Immutable manual-edit history count (migration 0021). */
    contentRevisionCount: integer('content_revision_count').notNull().default(0),
    checkpointChatId: text('checkpoint_chat_id'),
  },
  (table) => [
    index('messages_chat_branch_idx').on(table.chatId, table.branchId),
    index('messages_created_idx').on(table.createdAt),
    // Generation hot path (migration 0007): recent-history lookups order by
    // created_at DESC, id DESC — the plain (chat, branch) index forced a
    // temp-B-tree sort per generation.
    index('messages_chat_branch_created_idx').on(
      table.chatId,
      table.branchId,
      sql`created_at DESC`,
      sql`id DESC`,
    ),
  ],
);

/** Message variants (alternative generations for the same parent). */
export const messageVariants = sqliteTable(
  'message_variants',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    /** 0-based position in the variant permutation (migration 0020). */
    position: integer('position').notNull().default(0),
    content: text('content').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('message_variants_msg_idx').on(table.messageId),
    uniqueIndex('message_variants_position_idx').on(table.messageId, table.position),
  ],
);

/** Immutable previous contents created by manual edits and restores. */
export const messageContentRevisions = sqliteTable(
  'message_content_revisions',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    content: text('content').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('message_content_revisions_msg_idx').on(table.messageId),
    uniqueIndex('message_content_revisions_position_idx').on(table.messageId, table.position),
  ],
);

/**
 * Server-side streaming drafts (rev4 stage 3). Writers stream into a draft;
 * only `commit` materializes a real message atomically. `sequence` makes
 * replayed PATCHes idempotent no-ops, `committedMessageId` makes a commit
 * retry return the original result, and the server sweep removes stale rows.
 */
export const messageDrafts = sqliteTable(
  'message_drafts',
  {
    id: text('id').primaryKey(),
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    branchId: text('branch_id')
      .notNull()
      .references(() => chatBranches.id, { onDelete: 'cascade' }),
    role: text('role', {
      enum: ['system', 'user', 'assistant', 'tool', 'plugin'],
    }).notNull(),
    content: text('content').notNull().default(''),
    name: text('name'),
    meta: text('meta').notNull().default('{}'),
    sequence: integer('sequence').notNull().default(0),
    revision: integer('revision').notNull().default(1),
    committedMessageId: text('committed_message_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('message_drafts_chat_idx').on(table.chatId, table.branchId)],
);

/**
 * Persistent plugin block attachments (rev4 stage 4): a plugin block bound
 * to a message, including the renderer's serialized state. Cascade rules
 * remove attachments with their message or plugin.
 */
export const messageBlockAttachments = sqliteTable(
  'message_block_attachments',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    pluginId: text('plugin_id')
      .notNull()
      .references(() => pluginRegistry.id, { onDelete: 'cascade' }),
    blockType: text('block_type').notNull(),
    rendererId: text('renderer_id').notNull(),
    descriptorJson: text('descriptor_json').notNull().default('{}'),
    serializedStateJson: text('serialized_state_json'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('message_blocks_message_idx').on(table.messageId),
    index('message_blocks_plugin_idx').on(table.pluginId),
  ],
);

/**
 * Provider configurations. The legacy `apiKey` column is retained for migration
 * compatibility only; live keys live in {@link providerSecrets} and are never
 * exposed via the API (only `hasApiKey`).
 */
export const providerConfigs = sqliteTable('provider_configs', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  baseUrl: text('base_url'),
  model: text('model'),
  apiKey: text('api_key'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  settings: text('settings').notNull().default('{}'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * Stored provider API keys. A provider may hold several labelled keys; exactly
 * one is `active` and used for generation. The plaintext `value` is write-only
 * at the API boundary — repositories expose it only to the provider runtime.
 */
export const providerSecrets = sqliteTable(
  'provider_secrets',
  {
    id: text('id').primaryKey(),
    providerId: text('provider_id')
      .notNull()
      .references(() => providerConfigs.id, { onDelete: 'cascade' }),
    label: text('label'),
    value: text('value').notNull(),
    active: integer('active', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('provider_secrets_provider_idx').on(table.providerId)],
);

/**
 * Connection profiles — named bundles of connection settings layered over
 * provider configs (references + formatting overrides). `name` and `mode` are
 * columns for listing/filtering; every other field lives in the versioned
 * `payload` JSON so unknown fields survive round-trips (AGENTS.md §11).
 */
export const connectionProfiles = sqliteTable(
  'connection_profiles',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    mode: text('mode', { enum: ['chat', 'text'] }).notNull(),
    payload: text('payload').notNull().default('{}'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('connection_profiles_name_idx').on(table.name)],
);

export const pluginRegistry = sqliteTable('plugin_registry', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  version: text('version').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  manifest: text('manifest').notNull().default('{}'),
  permissions: text('permissions').notNull().default('[]'),
  grantedPermissions: text('granted_permissions').notNull().default('[]'),
  lastErrorCode: text('last_error_code'),
  /** Install source descriptor JSON (`{"type":"zip"}` / `{"type":"git",...}`). */
  source: text('source'),
  /** Installer-produced npm dependency list JSON. */
  dependencies: text('dependencies'),
  /** Package trust state (ТЗ §SEC-05): built-in / verified-publisher / locally-trusted / unsigned-untrusted. */
  trustState: text('trust_state').notNull().default('unsigned-untrusted'),
  /** Publisher key fingerprint for verified-publisher packages. */
  publisherKeyId: text('publisher_key_id'),
  installedAt: integer('installed_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const pluginSettings = sqliteTable('plugin_settings', {
  pluginId: text('plugin_id').primaryKey(),
  settings: text('settings').notNull().default('{}'),
});

export const pluginStorage = sqliteTable(
  'plugin_storage',
  {
    pluginId: text('plugin_id').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
  },
  (table) => [primaryKey({ columns: [table.pluginId, table.key] })],
);

/**
 * Plugin user state (rev4 §5): separate from the registry because scope,
 * quotas, ownership and migration rules differ. Indexes are expression-based
 * (COALESCE on owner_id) and live only in migration 0016.
 */
export const pluginState = sqliteTable('plugin_state', {
  id: text('id').primaryKey(),
  pluginId: text('plugin_id')
    .notNull()
    .references(() => pluginRegistry.id, { onDelete: 'cascade' }),
  scope: text('scope').notNull(),
  ownerId: text('owner_id'),
  schemaVersion: integer('schema_version').notNull().default(1),
  revision: integer('revision').notNull().default(1),
  data: text('data').notNull().default('{}'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/** Capability grants issued by the broker (rev4 §B2). */
export const pluginCapabilityGrants = sqliteTable('plugin_capability_grants', {
  id: text('id').primaryKey(),
  pluginId: text('plugin_id')
    .notNull()
    .references(() => pluginRegistry.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  scope: text('scope').notNull(),
  revision: integer('revision').notNull().default(1),
  grantedAt: integer('granted_at').notNull(),
  expiresAt: integer('expires_at'),
  revokedAt: integer('revoked_at'),
});

/**
 * Plugin SecretStore (ТЗ §54): write-only per-plugin secrets. Values are never
 * serialized in list/state/backup/export/diagnostics surfaces; the plaintext
 * is only reachable through the gated reveal route. The DDL lives in
 * migration 0022; `plugin_id` cascades with plugin deletion.
 */
export const pluginSecrets = sqliteTable(
  'plugin_secrets',
  {
    pluginId: text('plugin_id')
      .notNull()
      .references(() => pluginRegistry.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.pluginId, table.scope, table.key] })],
);

/**
 * Plugin OAuth connections (rev4 §K5, api.auth). Token, state and PKCE
 * verifier live only here, server-side; sandbox sees metadata only. Indexes
 * live in migration 0017.
 */
export const pluginAuthConnections = sqliteTable('plugin_auth_connections', {
  id: text('id').primaryKey(),
  pluginId: text('plugin_id')
    .notNull()
    .references(() => pluginRegistry.id, { onDelete: 'cascade' }),
  serviceId: text('service_id').notNull(),
  serviceName: text('service_name').notNull(),
  scopesJson: text('scopes_json').notNull(),
  status: text('status').notNull(),
  tokenJson: text('token_json'),
  state: text('state').notNull(),
  codeVerifier: text('code_verifier').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const themeRegistry = sqliteTable('theme_registry', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  version: text('version').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  manifest: text('manifest').notNull().default('{}'),
  installedAt: integer('installed_at').notNull(),
});

/** Immutable snapshots created before character edits/import replacement. */
export const characterVersions = sqliteTable(
  'character_versions',
  {
    id: text('id').primaryKey(),
    characterId: text('character_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    snapshot: text('snapshot').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    // Mirrors the SQL `UNIQUE (character_id, version)` constraint — keeping
    // the Drizzle model in sync prevents drizzle-kit generate/push from
    // silently dropping it.
    uniqueIndex('character_versions_character_idx').on(table.characterId, table.version),
  ],
);

/** File metadata only; payloads remain under data/files/. */
export const attachments = sqliteTable(
  'attachments',
  {
    id: text('id').primaryKey(),
    ownerType: text('owner_type').notNull(),
    ownerId: text('owner_id').notNull(),
    logicalName: text('logical_name').notNull(),
    relativePath: text('relative_path').notNull(),
    contentHash: text('content_hash').notNull(),
    mime: text('mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    metadata: text('metadata').notNull().default('{}'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('attachments_owner_idx').on(table.ownerType, table.ownerId),
    index('attachments_hash_idx').on(table.contentHash),
    // Mirrors the SQL `UNIQUE (owner_type, owner_id, content_hash)` —
    // content-addressed dedupe per owner.
    uniqueIndex('attachments_owner_hash_uniq').on(
      table.ownerType,
      table.ownerId,
      table.contentHash,
    ),
  ],
);

export const lorebooks = sqliteTable(
  'lorebooks',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    metadata: text('metadata').notNull().default('{}'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (table) => [
    index('lorebooks_name_idx').on(table.name),
    index('lorebooks_name_nocase_idx').on(sql`name COLLATE NOCASE`),
  ],
);

export const loreEntries = sqliteTable(
  'lore_entries',
  {
    id: text('id').primaryKey(),
    lorebookId: text('lorebook_id')
      .notNull()
      .references(() => lorebooks.id, { onDelete: 'cascade' }),
    keysJson: text('keys_json').notNull().default('[]'),
    secondaryKeys: text('secondary_keys').notNull().default('[]'),
    content: text('content').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    position: integer('position').notNull().default(0),
    constant: integer('constant', { mode: 'boolean' }).notNull().default(false),
    selective: integer('selective', { mode: 'boolean' }).notNull().default(false),
    metadata: text('metadata').notNull().default('{}'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('lore_entries_book_position_idx').on(table.lorebookId, table.position)],
);

export const presets = sqliteTable(
  'presets',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    data: text('data').notNull().default('{}'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('presets_kind_idx').on(table.kind),
    // Mirrors the SQL `UNIQUE (kind, name)` constraint.
    uniqueIndex('presets_kind_name_uniq').on(table.kind, table.name),
  ],
);

export const cacheMetadata = sqliteTable(
  'cache_metadata',
  {
    key: text('key').primaryKey(),
    relativePath: text('relative_path').notNull(),
    sourceHash: text('source_hash').notNull(),
    targetSize: integer('target_size'),
    algorithmVersion: integer('algorithm_version').notNull(),
    mime: text('mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    createdAt: integer('created_at').notNull(),
    lastAccessedAt: integer('last_accessed_at').notNull(),
  },
  (table) => [index('cache_metadata_source_idx').on(table.sourceHash, table.algorithmVersion)],
);

export const importJobs = sqliteTable(
  'import_jobs',
  {
    id: text('id').primaryKey(),
    sourceHash: text('source_hash').notNull(),
    sourceName: text('source_name').notNull(),
    sourceKind: text('source_kind').notNull(),
    status: text('status').notNull(),
    summary: text('summary').notNull().default('{}'),
    errorCode: text('error_code'),
    startedAt: integer('started_at').notNull(),
    completedAt: integer('completed_at'),
  },
  (table) => [index('import_jobs_started_idx').on(table.startedAt)],
);

/**
 * Stable mapping from an external source artifact to the local entity created
 * from it. `status = importing` is a recoverable marker left by an interrupted
 * streamed chat import; a retry removes the partial target and starts again.
 */
export const importArtifacts = sqliteTable(
  'import_artifacts',
  {
    sourceKind: text('source_kind').notNull(),
    sourceKey: text('source_key').notNull(),
    sourceHash: text('source_hash').notNull(),
    targetKind: text('target_kind').notNull(),
    targetId: text('target_id').notNull(),
    status: text('status').notNull(),
    metadata: text('metadata').notNull().default('{}'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sourceKind, table.sourceKey] }),
    index('import_artifacts_target_idx').on(table.targetKind, table.targetId),
    index('import_artifacts_hash_idx').on(table.sourceHash),
  ],
);

/**
 * Memory/RAG fragments (ТЗ §4.4): global facts or character-scoped knowledge,
 * injected into the prompt when their keys match the conversation context.
 */
export const memories = sqliteTable(
  'memories',
  {
    id: text('id').primaryKey(),
    scope: text('scope').notNull().default('global'),
    characterId: text('character_id').references(() => characters.id, { onDelete: 'cascade' }),
    keysJson: text('keys_json').notNull().default('[]'),
    content: text('content').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    position: integer('position').notNull().default(0),
    metadata: text('metadata').notNull().default('{}'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('memories_scope_idx').on(table.scope, table.characterId),
    index('memories_position_idx').on(table.position),
  ],
);

/** Latest full, secret-free generation context audit retained for each chat. */
export const promptContextAudits = sqliteTable(
  'prompt_context_audits',
  {
    chatId: text('chat_id')
      .primaryKey()
      .references(() => chats.id, { onDelete: 'cascade' }),
    generationId: text('generation_id').notNull(),
    payload: text('payload').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('prompt_context_audits_generation_idx').on(table.generationId)],
);
