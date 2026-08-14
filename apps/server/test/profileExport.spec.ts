/**
 * SEC-02 acceptance tests for the logical profile export
 * (apps/server/src/lib/profileExport.ts, format version 2).
 *
 * The fixture places unique sentinel secrets into every secret-bearing store
 * (provider_secrets, the legacy provider_configs.api_key column,
 * provider_configs.settings.customIncludeHeaders,
 * connection_profiles.payload.includeHeaders, plugin_secrets,
 * plugin_auth_connections) and asserts none of them appears anywhere in the
 * archive — not in data files, not in manifest.json. It also asserts the
 * entity/field allowlist shape: only the documented tables are exported, and
 * the excluded stores have no archive entries at all.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yauzl from 'yauzl';
import { createAppDatabase, type AppDatabase } from '@neotavern/db';
import type { TypedApp } from '../src/types.js';
import { buildProfileExportArchive, type ProfileExportArchive } from '../src/lib/profileExport.js';
import { resolveDataPaths, ensureDataDirs } from '../src/lib/paths.js';
import { createTestApp } from './helpers.js';

// --- sentinels ---------------------------------------------------------------

const SENTINEL_PROVIDER_KEY = 'sk-sentinel-provider-9f3c7a';
const SENTINEL_LEGACY_API_KEY = 'sk-sentinel-legacy-column-2b8d41';
const SENTINEL_CUSTOM_HEADER = 'Bearer sentinel-custom-header-5e19f2';
const SENTINEL_CONNECTION_HEADER = 'Bearer sentinel-connection-header-3f8ad9';
const SENTINEL_PLUGIN_SECRET = 'sentinel-plugin-secret-c41d77';
const SENTINEL_OAUTH_TOKEN = 'sentinel-oauth-token-7a62e8';
const SENTINEL_PKCE_VERIFIER = 'sentinel-pkce-verifier-1b93c5';

const SENTINELS: readonly string[] = [
  SENTINEL_PROVIDER_KEY,
  SENTINEL_LEGACY_API_KEY,
  SENTINEL_CUSTOM_HEADER,
  SENTINEL_CONNECTION_HEADER,
  SENTINEL_PLUGIN_SECRET,
  SENTINEL_OAUTH_TOKEN,
  SENTINEL_PKCE_VERIFIER,
];

/** Every table the export must carry (entity allowlist, SEC-02). */
const EXPECTED_EXPORTED_TABLES: readonly string[] = [
  'profiles',
  'settings',
  'personas',
  'characters',
  'tags',
  'character_tags',
  'chats',
  'chat_branches',
  'messages',
  'message_variants',
  'message_content_revisions',
  'message_drafts',
  'message_block_attachments',
  'connection_profiles',
  'character_versions',
  'attachments',
  'lorebooks',
  'lore_entries',
  'presets',
  'memories',
  'provider_configs',
];

/** Secret/system tables that must have NO archive entries (SEC-02). */
const EXPECTED_EXCLUDED_TABLES: readonly string[] = [
  'app_meta',
  'provider_secrets',
  'plugin_secrets',
  'plugin_auth_connections',
  'plugin_registry',
  'plugin_settings',
  'plugin_storage',
  'plugin_state',
  'plugin_capability_grants',
  'theme_registry',
  'cache_metadata',
  'prompt_context_audits',
  'import_jobs',
  'import_artifacts',
];

const NOW = 1_755_000_000_000;

let database: AppDatabase;
let dataDir: string;

/** Insert one row into every allowlisted table (plus the FK/secret stores). */
function seedDatabase(db: AppDatabase): void {
  const sql = db.sqlite;

  sql
    .prepare(`INSERT INTO profiles (id, name, created_at) VALUES (?, ?, ?)`)
    .run('profile-001', 'Default', NOW);
  sql
    .prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`)
    .run('themeSettings:abc', JSON.stringify({ customCss: 'body { }' }));

  sql
    .prepare(
      `INSERT INTO personas (id, name, description, avatar, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('persona-001', 'Persona One', 'desc', null, 1, NOW, NOW);

  sql
    .prepare(
      `INSERT INTO characters (id, name, avatar, description, personality, scenario, first_message,
         example_dialogues, system_prompt, post_history_instructions, creator, creator_notes, ext,
         created_at, updated_at, last_used_at, deleted_at, favorite, chat_count, token_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'char-001',
      'Character One',
      null,
      'A character',
      'personality',
      'scenario',
      'Hello!',
      '',
      null,
      null,
      'creator',
      'notes',
      JSON.stringify({ _st2: { importHash: 'abc' } }),
      NOW,
      NOW,
      null,
      null,
      1,
      2,
      3,
    );

  sql.prepare(`INSERT INTO tags (id, name) VALUES (?, ?)`).run('tag-001', 'fantasy');
  sql
    .prepare(`INSERT INTO character_tags (character_id, tag_id) VALUES (?, ?)`)
    .run('char-001', 'tag-001');

  sql
    .prepare(
      `INSERT INTO chats (id, character_id, persona_id, title, active_branch_id, background_id,
         summary, message_count, created_at, updated_at, deleted_at, parent_chat_id, origin,
         source_message_id, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'chat-001',
      'char-001',
      null,
      'Chat One',
      'branch-001',
      null,
      '',
      1,
      NOW,
      NOW,
      null,
      null,
      null,
      null,
      0,
    );
  sql
    .prepare(`INSERT INTO chat_branches (id, chat_id, name, created_at) VALUES (?, ?, ?, ?)`)
    .run('branch-001', 'chat-001', 'main', NOW);
  sql
    .prepare(
      `INSERT INTO messages (id, chat_id, branch_id, parent_id, role, content, name, meta,
         created_at, revision, updated_at, idempotency_key, variant_count,
         active_variant_position, content_revision_count, checkpoint_chat_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'msg-001',
      'chat-001',
      'branch-001',
      null,
      'user',
      'Hello there',
      null,
      '{}',
      NOW,
      1,
      NOW,
      'idem-001',
      1,
      0,
      1,
      null,
    );
  sql
    .prepare(
      `INSERT INTO message_variants (id, message_id, position, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run('variant-001', 'msg-001', 0, 'Variant text', NOW);
  sql
    .prepare(
      `INSERT INTO message_content_revisions (id, message_id, position, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run('rev-001', 'msg-001', 0, 'Older text', NOW);
  sql
    .prepare(
      `INSERT INTO message_drafts (id, chat_id, branch_id, role, content, name, meta, sequence,
         revision, committed_message_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'draft-001',
      'chat-001',
      'branch-001',
      'assistant',
      'streaming…',
      null,
      '{}',
      3,
      1,
      null,
      NOW,
      NOW,
    );

  // plugin_registry is EXCLUDED from the export but required by the FK of
  // message_block_attachments — the export must still carry the attachment.
  // The manifest is valid and the plugin disabled so app boot (which validates
  // enabled plugins) accepts the seeded row.
  sql
    .prepare(
      `INSERT INTO plugin_registry (id, name, version, enabled, manifest, permissions,
         granted_permissions, last_error_code, source, dependencies, installed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'plugin-001',
      'demo',
      '1.0.0',
      0,
      JSON.stringify({ id: 'author.demo', name: 'Demo', version: '1.0.0', apiVersion: 1 }),
      '[]',
      '[]',
      null,
      '{"type":"zip"}',
      null,
      NOW,
      NOW,
    );
  sql
    .prepare(
      `INSERT INTO message_block_attachments (id, message_id, plugin_id, block_type, renderer_id,
         descriptor_json, serialized_state_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'block-001',
      'msg-001',
      'plugin-001',
      'card',
      'cardRenderer',
      '{}',
      '{"state":1}',
      NOW,
      NOW,
    );

  sql
    .prepare(
      `INSERT INTO connection_profiles (id, name, mode, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'conn-001',
      'Profile One',
      'chat',
      JSON.stringify({
        providerConfigId: 'provider-001',
        model: 'gpt-4o',
        includeHeaders: { Authorization: SENTINEL_CONNECTION_HEADER },
      }),
      NOW,
      NOW,
    );

  sql
    .prepare(
      `INSERT INTO character_versions (id, character_id, version, snapshot, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run('cver-001', 'char-001', 1, JSON.stringify({ name: 'Character One' }), NOW);

  sql
    .prepare(
      `INSERT INTO attachments (id, owner_type, owner_id, logical_name, relative_path, content_hash,
         mime, size_bytes, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'att-001',
      'character',
      'char-001',
      'avatar.png',
      'char-001/avatar.png',
      'hash-1',
      'image/png',
      123,
      '{}',
      NOW,
    );

  sql
    .prepare(
      `INSERT INTO lorebooks (id, name, description, metadata, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('lore-001', 'Lorebook One', '', '{}', NOW, NOW, null);
  sql
    .prepare(
      `INSERT INTO lore_entries (id, lorebook_id, keys_json, secondary_keys, content, enabled,
         position, constant, selective, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('entry-001', 'lore-001', '["king"]', '[]', 'The king rules.', 1, 0, 0, 0, '{}', NOW, NOW);

  sql
    .prepare(
      `INSERT INTO presets (id, kind, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run('preset-001', 'instruct', 'ChatML', '{"format":"chatml"}', NOW, NOW);

  sql
    .prepare(
      `INSERT INTO memories (id, scope, character_id, keys_json, content, enabled, position,
         metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('mem-001', 'character', 'char-001', '["loves"]', 'Loves tea.', 1, 0, '{}', NOW, NOW);

  // Provider config with a legacy secret column AND write-only custom headers.
  sql
    .prepare(
      `INSERT INTO provider_configs (id, kind, name, base_url, model, api_key, enabled, settings,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'provider-001',
      'openai-compat',
      'OpenAI',
      'https://api.openai.com/v1',
      'gpt-4o',
      SENTINEL_LEGACY_API_KEY,
      1,
      JSON.stringify({
        temperature: 0.7,
        customIncludeHeaders: { 'api-key': SENTINEL_CUSTOM_HEADER },
      }),
      NOW,
      NOW,
    );

  // Secret stores — every one must stay out of the archive (SEC-02).
  sql
    .prepare(
      `INSERT INTO provider_secrets (id, provider_id, label, value, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run('psec-001', 'provider-001', 'main', SENTINEL_PROVIDER_KEY, 1, NOW);
  sql
    .prepare(
      `INSERT INTO plugin_secrets (plugin_id, scope, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run('plugin-001', 'workspace', 'apiKey', SENTINEL_PLUGIN_SECRET, NOW, NOW);
  sql
    .prepare(
      `INSERT INTO plugin_auth_connections (id, plugin_id, service_id, service_name, scopes_json,
         status, token_json, state, code_verifier, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'auth-001',
      'plugin-001',
      'github',
      'GitHub',
      '["repo"]',
      'connected',
      JSON.stringify({ accessToken: SENTINEL_OAUTH_TOKEN }),
      SENTINEL_OAUTH_TOKEN,
      SENTINEL_PKCE_VERIFIER,
      NOW,
      NOW,
    );
}

/** Expected row count per exported table (mirrors seedDatabase). */
const EXPECTED_COUNTS: Record<string, number> = {
  profiles: 1,
  settings: 1,
  personas: 1,
  characters: 1,
  tags: 1,
  character_tags: 1,
  chats: 1,
  chat_branches: 1,
  messages: 1,
  message_variants: 1,
  message_content_revisions: 1,
  message_drafts: 1,
  message_block_attachments: 1,
  connection_profiles: 1,
  character_versions: 1,
  attachments: 1,
  lorebooks: 1,
  lore_entries: 1,
  presets: 1,
  memories: 1,
  provider_configs: 1,
};

// --- zip helpers -------------------------------------------------------------

function openZip(buffer: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(err ?? new Error('yauzl: no zipfile'));
        return;
      }
      const entries = new Map<string, Buffer>();
      zipfile.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (openErr, stream) => {
          if (openErr || !stream) {
            reject(openErr ?? new Error('yauzl: no read stream'));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('end', () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            zipfile.readEntry();
          });
          stream.on('error', reject);
        });
      });
      zipfile.on('end', () => resolve(entries));
      zipfile.on('error', reject);
      zipfile.readEntry();
    });
  });
}

async function collectArchive(archive: ProfileExportArchive): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of archive.zip.outputStream) {
    chunks.push(chunk as Buffer);
  }
  await archive.cleanup();
  return Buffer.concat(chunks);
}

async function buildFixtureArchive(): Promise<{ entries: Map<string, Buffer>; manifest: any }> {
  const paths = resolveDataPaths(dataDir);
  ensureDataDirs(paths);
  writeFileSync(join(paths.files, 'avatar.png'), Buffer.from('fake-png-bytes'));
  const archive = await buildProfileExportArchive({
    database,
    paths,
    profile: { id: 'profile-001', name: 'Default' },
    appVersion: '0.1.0-test',
  });
  const entries = await openZip(await collectArchive(archive));
  const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf8'));
  return { entries, manifest };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'neotavern-profile-export-test-'));
  database = createAppDatabase(':memory:');
  seedDatabase(database);
});

afterEach(async () => {
  database.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('buildProfileExportArchive (SEC-02 logical export, format v2)', () => {
  it('carries every allowlisted table with the exact row counts', async () => {
    const { entries, manifest } = await buildFixtureArchive();

    expect(manifest.format).toBe('neotavern-profile-export');
    expect(manifest.version).toBe(2);
    expect(manifest.profile).toEqual({ id: 'profile-001', name: 'Default' });
    expect(manifest.schemaVersion).toBe(database.diagnostics().schemaVersion);

    const exported = new Set(manifest.tables.map((t: { table: string }) => t.table));
    expect([...exported].sort()).toEqual([...EXPECTED_EXPORTED_TABLES].sort());
    for (const [table, rows] of Object.entries(EXPECTED_COUNTS)) {
      expect(entries.has(`data/${table}.jsonl`)).toBe(true);
      const lines = entries
        .get(`data/${table}.jsonl`)!
        .toString('utf8')
        .trim()
        .split('\n')
        .filter((line) => line.length > 0);
      expect(lines).toHaveLength(rows);
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
      const recorded = manifest.tables.find((t: { table: string }) => t.table === table);
      expect(recorded.rows).toBe(rows);
    }
  });

  it('has no archive entry for any excluded or secret-bearing table', async () => {
    const { entries } = await buildFixtureArchive();
    expect(entries.has('app.db')).toBe(false);
    for (const table of EXPECTED_EXCLUDED_TABLES) {
      expect(entries.has(`data/${table}.jsonl`), `data/${table}.jsonl must not exist`).toBe(false);
    }
    // Sanity: the FTS/search virtual tables are never exported either.
    expect(entries.has('data/characters_fts.jsonl')).toBe(false);
  });

  it('records every exclusion and redaction in the manifest', async () => {
    const { manifest } = await buildFixtureArchive();
    const excludedTables = manifest.excluded.map((e: { table: string }) => e.table);
    expect([...excludedTables].sort()).toEqual([...EXPECTED_EXCLUDED_TABLES].sort());
    for (const entry of manifest.excluded) {
      expect(typeof entry.reason).toBe('string');
      expect(entry.reason.length).toBeGreaterThan(0);
    }
    expect(manifest.redactions).toEqual(
      expect.arrayContaining([
        expect.stringContaining('provider_configs.api_key'),
        expect.stringContaining('customIncludeHeaders'),
        expect.stringContaining('includeHeaders'),
      ]),
    );
  });

  it('never leaks sentinel secrets into any archive entry', async () => {
    const { entries } = await buildFixtureArchive();
    expect(entries.size).toBeGreaterThan(0);
    for (const [name, content] of entries) {
      const haystack = content.toString('latin1');
      for (const sentinel of SENTINELS) {
        expect(haystack.includes(sentinel), `sentinel ${sentinel} leaked into ${name}`).toBe(false);
      }
    }
  });

  it('drops secret-bearing fields at the field-allowlist level', async () => {
    const { entries } = await buildFixtureArchive();
    const providers = entries
      .get('data/provider_configs.jsonl')!
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(providers).toHaveLength(1);
    expect(providers[0]).not.toHaveProperty('api_key');
    expect(providers[0].id).toBe('provider-001');
    expect(providers[0].settings).not.toContain('customIncludeHeaders');

    const connections = entries
      .get('data/connection_profiles.jsonl')!
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(connections).toHaveLength(1);
    const payload = JSON.parse(connections[0].payload);
    expect(payload).not.toHaveProperty('includeHeaders');
    expect(payload.providerConfigId).toBe('provider-001');
  });

  it('carries the user files directory', async () => {
    const { entries } = await buildFixtureArchive();
    expect(entries.get('files/avatar.png')!.toString('utf8')).toBe('fake-png-bytes');
  });
});

describe('GET /api/v2/profiles/export (route integration)', () => {
  let app: TypedApp;

  beforeEach(async () => {
    const handle = await createTestApp();
    app = handle.app;
    seedDatabase(handle.database);
  });

  afterEach(async () => {
    // createTestApp tracks and closes the app; nothing extra needed here.
  });

  it('serves a format-v2 archive as a zip attachment', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v2/profiles/export' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/zip');
    expect(response.headers['content-disposition']).toContain('attachment');

    const entries = await openZip(response.rawPayload);
    const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf8'));
    expect(manifest.format).toBe('neotavern-profile-export');
    expect(manifest.version).toBe(2);
    for (const sentinel of SENTINELS) {
      for (const [name, content] of entries) {
        expect(
          content.toString('latin1').includes(sentinel),
          `sentinel ${sentinel} leaked into route archive entry ${name}`,
        ).toBe(false);
      }
    }
  });
});
