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
   * Explicit column allowlist. When absent, every column of the table is
   * exported (the table's DDL is the field allowlist — no secret-bearing
   * columns exist outside the redactions below).
   */
  columns?: readonly string[];
  /** Redact secret-bearing JSON payloads inside a row before serialization. */
  transform?: (row: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Entity allowlist (ТЗ §SEC-02). Rows are written as JSON Lines in stable
 * primary-key order (`rowid`) so the archive is deterministic and diffable.
 */
const EXPORTED_TABLES: readonly TableSpec[] = [
  { table: 'profiles' },
  { table: 'settings' },
  { table: 'personas' },
  { table: 'characters' },
  { table: 'tags' },
  { table: 'character_tags' },
  { table: 'chats' },
  { table: 'chat_branches' },
  { table: 'messages' },
  { table: 'message_variants' },
  { table: 'message_content_revisions' },
  { table: 'message_drafts' },
  { table: 'message_block_attachments' },
  // `payload.includeHeaders` can carry credentials (write-only projection in
  // the connection-profile repo) — removed before export.
  { table: 'connection_profiles', transform: redactConnectionProfile },
  { table: 'character_versions' },
  { table: 'attachments' },
  { table: 'lorebooks' },
  { table: 'lore_entries' },
  { table: 'presets' },
  { table: 'memories' },
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
    for (const spec of EXPORTED_TABLES) {
      counts.set(spec.table, await writeTable(tempDir, input.database, spec));
    }

    const manifest = {
      app: 'neotavern',
      format: 'neotavern-profile-export',
      version: 2,
      appVersion: input.appVersion,
      exportedAt: new Date().toISOString(),
      profile: input.profile,
      schemaVersion: input.database.diagnostics().schemaVersion,
      tables: EXPORTED_TABLES.map((spec) => ({
        table: spec.table,
        rows: counts.get(spec.table) ?? 0,
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
  const columns = spec.columns?.join(', ') ?? '*';
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
