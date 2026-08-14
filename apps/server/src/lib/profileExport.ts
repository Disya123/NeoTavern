/**
 * Portable profile export (ТЗ §10.4, §SEC-02): a single archive containing the
 * user's product data serialized from an **entity and field allowlist**, plus
 * the user's original files.
 *
 * A full-DB snapshot is FORBIDDEN as a profile export (§SEC-02). This module
 * therefore never calls the SQLite backup API: it reads only the allowlisted
 * tables below, drops every secret-bearing column/JSON field, and records
 * exactly what was exported and what was excluded in `manifest.json`, so an
 * importer and a reviewer can verify the archive's bounds.
 *
 * Two hardening properties (SEC-02 audit findings, fixed):
 *
 * 1. **Snapshot transaction.** The whole export runs inside one SQLite
 *    transaction (`BEGIN` … `COMMIT`, rollback on failure). Every table is
 *    therefore read from a single consistent snapshot — a concurrent writer
 *    can never split the archive between two states of the database.
 * 2. **Explicit field allowlist.** Every table is read through an explicit
 *    `SELECT <allowlisted columns>`, never `SELECT *`. A column added to a
 *    table in a future migration cannot silently enter the archive: the
 *    allowlist check in `apps/server/test/profileExport.spec.ts` compares the
 *    exported keys against the current schema (`PRAGMA table_info`).
 *
 * Archive layout (format version 2 — see docs/architecture/version-axes.md):
 *
 * ```text
 * manifest.json                 — envelope, table rows/counts, exclusions, redactions
 * data/<table>.jsonl            — one JSON Lines file per allowlisted table
 * files/...                     — original user files (unchanged)
 * ```
 *
 * Excluded by design (§SEC-02 + §10.4): secret stores (provider_secrets,
 * plugin_secrets, plugin_auth_connections), plugin/theme installations and
 * plugin-owned data, cache metadata, derived diagnostics (prompt_context_audits)
 * and transient import bookkeeping. The remaining tables carry no secret-bearing
 * fields except the two redacted below; the SEC-02 sentinel test
 * (`apps/server/test/profileExport.spec.ts`) proves their absence.
 */
import { createWriteStream } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { finished } from 'node:stream/promises';
import type { AppDatabase } from '@neotavern/db';
import { AppError, ErrorCodes } from '@neotavern/shared';
import yazl from 'yazl';
import type { DataPaths } from './paths.js';

export interface ProfileExportInput {
  database: AppDatabase;
  paths: DataPaths;
  profile: { id: string; name: string };
  appVersion: string;
}

export interface ProfileExportArchive {
  /** Stream the archive body from. */
  zip: yazl.ZipFile;
  /** Remove temporary export files. Call after the response ends. */
  cleanup(): Promise<void>;
}

/** One allowlisted table and its export behaviour. */
interface TableSpec {
  table: string;
  /**
   * Explicit column allowlist — REQUIRED for every table (SEC-02): the export
   * reads `SELECT <columns>`, never `SELECT *`, so future columns cannot leak
   * into the archive silently. `apps/server/test/profileExport.spec.ts`
   * verifies the allowlist matches the live schema (`PRAGMA table_info`).
   */
  columns: readonly string[];
  /** Redact secret-bearing JSON payloads inside a row before serialization. */
  transform?: (row: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Entity allowlist (ТЗ §SEC-02). Rows are written as JSON Lines in stable
 * primary-key order (`rowid`) so the archive is deterministic and diffable.
 * Column lists mirror `packages/db/src/schema/tables.ts` (the SQL DDL is the
 * source of truth; the allowlist test re-checks against the live schema).
 */
const EXPORTED_TABLES: readonly TableSpec[] = [
  {
    table: 'profiles',
    columns: ['id', 'name', 'created_at'],
  },
  { table: 'settings', columns: ['key', 'value'] },
  {
    table: 'personas',
    columns: ['id', 'name', 'description', 'avatar', 'is_default', 'created_at', 'updated_at'],
  },
  {
    table: 'characters',
    columns: [
      'id',
      'name',
      'avatar',
      'description',
      'personality',
      'scenario',
      'first_message',
      'example_dialogues',
      'system_prompt',
      'post_history_instructions',
      'creator',
      'creator_notes',
      'ext',
      'created_at',
      'updated_at',
      'last_used_at',
      'deleted_at',
      'favorite',
      'chat_count',
      'token_count',
    ],
  },
  { table: 'tags', columns: ['id', 'name'] },
  { table: 'character_tags', columns: ['character_id', 'tag_id'] },
  {
    table: 'chats',
    columns: [
      'id',
      'character_id',
      'persona_id',
      'title',
      'active_branch_id',
      'background_id',
      'summary',
      'message_count',
      'created_at',
      'updated_at',
      'deleted_at',
      'parent_chat_id',
      'origin',
      'source_message_id',
      'sort_order',
    ],
  },
  { table: 'chat_branches', columns: ['id', 'chat_id', 'name', 'created_at'] },
  {
    table: 'messages',
    columns: [
      'id',
      'chat_id',
      'branch_id',
      'parent_id',
      'role',
      'content',
      'name',
      'meta',
      'created_at',
      'revision',
      'updated_at',
      'idempotency_key',
      'variant_count',
      'active_variant_position',
      'content_revision_count',
      'checkpoint_chat_id',
    ],
  },
  { table: 'message_variants', columns: ['id', 'message_id', 'position', 'content', 'created_at'] },
  {
    table: 'message_content_revisions',
    columns: ['id', 'message_id', 'position', 'content', 'created_at'],
  },
  {
    table: 'message_drafts',
    columns: [
      'id',
      'chat_id',
      'branch_id',
      'role',
      'content',
      'name',
      'meta',
      'sequence',
      'revision',
      'committed_message_id',
      'created_at',
      'updated_at',
    ],
  },
  {
    table: 'message_block_attachments',
    columns: [
      'id',
      'message_id',
      'plugin_id',
      'block_type',
      'renderer_id',
      'descriptor_json',
      'serialized_state_json',
      'created_at',
      'updated_at',
    ],
  },
  // `payload.includeHeaders` can carry credentials (write-only projection in
  // the connection-profile repo) — removed before export.
  {
    table: 'connection_profiles',
    columns: ['id', 'name', 'mode', 'payload', 'created_at', 'updated_at'],
    transform: redactConnectionProfile,
  },
  {
    table: 'character_versions',
    columns: ['id', 'character_id', 'version', 'snapshot', 'created_at'],
  },
  {
    table: 'attachments',
    columns: [
      'id',
      'owner_type',
      'owner_id',
      'logical_name',
      'relative_path',
      'content_hash',
      'mime',
      'size_bytes',
      'metadata',
      'created_at',
    ],
  },
  {
    table: 'lorebooks',
    columns: ['id', 'name', 'description', 'metadata', 'created_at', 'updated_at', 'deleted_at'],
  },
  {
    table: 'lore_entries',
    columns: [
      'id',
      'lorebook_id',
      'keys_json',
      'secondary_keys',
      'content',
      'enabled',
      'position',
      'constant',
      'selective',
      'metadata',
      'created_at',
      'updated_at',
    ],
  },
  { table: 'presets', columns: ['id', 'kind', 'name', 'data', 'created_at', 'updated_at'] },
  {
    table: 'memories',
    columns: [
      'id',
      'scope',
      'character_id',
      'keys_json',
      'content',
      'enabled',
      'position',
      'metadata',
      'created_at',
      'updated_at',
    ],
  },
  // Explicit column allowlist: the legacy `api_key` column is a secret.
  {
    table: 'provider_configs',
    columns: [
      'id',
      'kind',
      'name',
      'base_url',
      'model',
      'enabled',
      'settings',
      'created_at',
      'updated_at',
    ],
    transform: redactProviderConfig,
  },
];

/** Tables that are intentionally never carried, with the reason (SEC-02). */
const EXCLUDED_TABLES: readonly { table: string; reason: string }[] = [
  {
    table: 'app_meta',
    reason: 'System/install metadata (schema bookkeeping, install id) — not profile data.',
  },
  {
    table: 'provider_secrets',
    reason: 'Provider API keys — SEC-02 forbids secrets in the archive.',
  },
  { table: 'plugin_secrets', reason: 'Plugin secrets — SEC-02 forbids secrets in the archive.' },
  {
    table: 'plugin_auth_connections',
    reason:
      'OAuth tokens, PKCE verifier and auth state — SEC-02 forbids auth material in the archive.',
  },
  { table: 'plugin_registry', reason: 'Plugin installations are not profile data (§10.4 design).' },
  { table: 'plugin_settings', reason: 'Plugin-owned data of excluded plugin installations.' },
  {
    table: 'plugin_storage',
    reason: 'Plugin-owned KV storage of excluded plugin installations (may carry tokens).',
  },
  { table: 'plugin_state', reason: 'Plugin-owned runtime state of excluded plugin installations.' },
  {
    table: 'plugin_capability_grants',
    reason: 'Grant bookkeeping of excluded plugin installations.',
  },
  { table: 'theme_registry', reason: 'Theme installations are not profile data (§10.4 design).' },
  { table: 'cache_metadata', reason: 'Regenerable cache metadata — excluded by design (§10.4).' },
  {
    table: 'prompt_context_audits',
    reason: 'Derived diagnostics (log-like) — excluded by design (§10.4).',
  },
  { table: 'import_jobs', reason: 'Transient import bookkeeping.' },
  { table: 'import_artifacts', reason: 'Transient import bookkeeping.' },
];

/** Field-level redactions applied before serialization (mirrored in tests). */
const REDACTIONS: readonly string[] = [
  'provider_configs.api_key — legacy secret column dropped from the export.',
  'provider_configs.settings.customIncludeHeaders — write-only secret request headers removed.',
  'connection_profiles.payload.includeHeaders — write-only secret request headers removed.',
];

export async function buildProfileExportArchive(
  input: ProfileExportInput,
): Promise<ProfileExportArchive> {
  const tempDir = await mkdtemp(join(tmpdir(), 'neotavern-profile-export-'));
  try {
    const counts = new Map<string, number>();
    // SEC-02 snapshot transaction: one consistent read snapshot for ALL
    // tables. A concurrent mutation between two table reads can no longer
    // split the archive across two database states.
    await input.database.sqlite.exec('BEGIN');
    try {
      for (const spec of EXPORTED_TABLES) {
        counts.set(spec.table, await writeTable(tempDir, input.database, spec));
      }
      await input.database.sqlite.exec('COMMIT');
    } catch (error) {
      await input.database.sqlite.exec('ROLLBACK');
      throw error;
    }

    const manifest = {
      app: 'neotavern',
      format: 'neotavern-profile-export',
      version: 2,
      appVersion: input.appVersion,
      exportedAt: new Date().toISOString(),
      profile: input.profile,
      schemaVersion: input.database.diagnostics().schemaVersion,
      /** SEC-02: every table was read inside one SQLite snapshot transaction. */
      snapshotTransaction: true,
      tables: EXPORTED_TABLES.map((spec) => ({
        table: spec.table,
        rows: counts.get(spec.table) ?? 0,
        columns: [...spec.columns],
      })),
      excluded: EXCLUDED_TABLES,
      redactions: REDACTIONS,
    };

    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), 'manifest.json');
    for (const spec of EXPORTED_TABLES) {
      zip.addFile(join(tempDir, `${spec.table}.jsonl`), `data/${spec.table}.jsonl`);
    }
    await addDirectory(zip, input.paths.files, 'files');
    zip.end();

    return {
      zip,
      cleanup: async () => {
        await rm(tempDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw new AppError({
      code: ErrorCodes.PROFILE_EXPORT_FAILED,
      message: 'Profile export failed',
      cause: error,
    });
  }
}

/** Write one allowlisted table as JSON Lines and return the row count. */
async function writeTable(
  tempDir: string,
  database: AppDatabase,
  spec: TableSpec,
): Promise<number> {
  const columns = spec.columns.join(', ');
  const statement = database.sqlite.prepare(`SELECT ${columns} FROM ${spec.table} ORDER BY rowid`);
  const outPath = join(tempDir, `${spec.table}.jsonl`);
  const out = createWriteStream(outPath, { encoding: 'utf8' });
  let rows = 0;
  try {
    for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
      const record = spec.transform ? spec.transform(row) : row;
      if (!out.write(`${JSON.stringify(record)}\n`)) {
        await new Promise<void>((resolve, reject) => {
          out.once('drain', resolve);
          out.once('error', reject);
        });
      }
      rows += 1;
    }
  } finally {
    out.end();
  }
  await finished(out);
  return rows;
}

/** Drop the legacy `api_key` column and write-only `customIncludeHeaders`. */
function redactProviderConfig(row: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...row };
  delete copy['api_key'];
  const settings = parseJsonObject(copy['settings']);
  if (settings !== null) {
    delete settings['customIncludeHeaders'];
    copy['settings'] = JSON.stringify(settings);
  }
  return copy;
}

/** Drop write-only `includeHeaders` from the connection-profile payload. */
function redactConnectionProfile(row: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...row };
  const payload = parseJsonObject(copy['payload']);
  if (payload !== null) {
    delete payload['includeHeaders'];
    copy['payload'] = JSON.stringify(payload);
  }
  return copy;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Recursively add a directory tree under a zip prefix. Missing dirs are fine. */
async function addDirectory(zip: yazl.ZipFile, dir: string, zipPrefix: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // directory does not exist yet
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const zipPath = `${zipPrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await addDirectory(zip, full, zipPath);
    } else if (entry.isFile()) {
      zip.addFile(full, zipPath.split(sep).join('/'));
    }
  }
}
