#!/usr/bin/env node
/**
 * Upgrade drill for the data cutover (ТЗ §10.3 work 7, Этап 3): proves on a
 * real CLI artifact that a legacy `app.db` upgrade converts, activates, and
 * opens the same characters/chats/messages afterwards — without ever
 * modifying the legacy database.
 *
 * Runs on Windows, macOS and Linux (Node 24 built-in `node:sqlite`, no
 * external dependencies). The Windows lock-contention/restart-to-complete
 * platform corpus lives in the Rust integration suite
 * (`crates/storage/tests/migration.rs::windows_held_handle_...`); this drill
 * covers the cross-platform upgrade cycle on the packaged kernel host.
 *
 * Usage:
 *   node scripts/upgrade-drill.mjs [--cli <path>] [--keep]
 *
 *   --cli   path to the neotavern-cli binary (default: debug build, built
 *           with `cargo build -p neotavern-cli` when missing).
 *   --keep  keep the temporary data root instead of deleting it.
 *
 * Exit 0 = drill passed; non-zero = a step failed (diagnostic on stderr).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_DEBUG = resolve(root, 'crates/target/debug', process.platform === 'win32' ? 'neotavern-cli.exe' : 'neotavern-cli');

const args = process.argv.slice(2);
const cliPath = args.includes('--cli') ? resolve(args[args.indexOf('--cli') + 1]) : null;
const keep = args.includes('--keep');

function fail(message) {
  console.error(`[upgrade-drill] FAIL: ${message}`);
  process.exit(1);
}

function ok(message) {
  console.log(`[upgrade-drill] ok: ${message}`);
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Builds the CLI when needed and returns its absolute path. */
function resolveCli() {
  if (cliPath) {
    if (!existsSync(cliPath)) fail(`--cli path does not exist: ${cliPath}`);
    return cliPath;
  }
  if (!existsSync(CLI_DEBUG)) {
    console.log('[upgrade-drill] building neotavern-cli (debug)...');
    const build = spawnSync('cargo', ['build', '-p', 'neotavern-cli'], {
      cwd: resolve(root, 'crates'),
      stdio: 'inherit',
    });
    if (build.status !== 0) fail(`cargo build -p neotavern-cli exited ${build.status}`);
  }
  if (!existsSync(CLI_DEBUG)) fail(`CLI binary missing after build: ${CLI_DEBUG}`);
  return CLI_DEBUG;
}

function runCli(cli, args, opts = {}) {
  const result = spawnSync(cli, args, { encoding: 'utf8', ...opts });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Real Drizzle-style legacy schema (the layout the converter maps). */
function buildLegacyFixture(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE characters (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, avatar TEXT,
      personality TEXT, scenario TEXT, first_message TEXT, example_dialogues TEXT,
      system_prompt TEXT, post_history_instructions TEXT, creator TEXT,
      creator_notes TEXT, tags TEXT, ext TEXT DEFAULT '{}', deleted_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE chats (
      id TEXT PRIMARY KEY, title TEXT, character_id TEXT, deleted_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, role TEXT, content TEXT NOT NULL,
      branch_id TEXT, parent_id TEXT, meta TEXT, name TEXT, deleted_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE lorebooks (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE presets (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, data TEXT DEFAULT '{}',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE provider_configs (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, name TEXT NOT NULL,
      config TEXT, api_key TEXT, deleted_at INTEGER
    );
    CREATE TABLE character_tags (character_id TEXT NOT NULL, tag_id TEXT NOT NULL);
    CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  `);
  const insert = db.prepare(
    `INSERT INTO characters (id, name, description, personality, scenario, first_message,
       system_prompt, creator, ext, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(
    'c1c1c1c1-0000-4000-8000-000000000001',
    'Drill Character',
    'description',
    'personality text',
    'scenario text',
    'first message',
    'system prompt',
    'creator',
    JSON.stringify({ unknownField: 'preserved' }),
    1700000000000,
    1700000001000,
  );
  db.prepare(`INSERT INTO chats (id, title, character_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run('c1c1c1c1-0000-4000-8000-000000000002', 'Drill Chat', 'c1c1c1c1-0000-4000-8000-000000000001', 1700000002000, 1700000003000);
  db.prepare(`INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run('c1c1c1c1-0000-4000-8000-000000000003', 'c1c1c1c1-0000-4000-8000-000000000002', 'user', 'Hello from the old version', 1700000004000);
  // A soft-deleted character and a soft-deleted provider config must be
  // skipped by the converter (never resurrected as live product data).
  db.prepare(`INSERT INTO characters (id, name, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run('c1c1c1c1-0000-4000-8000-000000000099', 'Deleted', 1700000005000, 1700000000000, 1700000006000);
  db.prepare(`INSERT INTO provider_configs (id, provider, name, api_key, deleted_at) VALUES (?, ?, ?, ?, ?)`)
    .run('cfg-deleted', 'openai', 'dead', 'sk-dead-secret', 1700000005000);
  // Tags come from the join tables (the real Drizzle mapping).
  db.prepare(`INSERT INTO tags (id, name) VALUES (?, ?)`).run('tag-1', 'knight');
  db.prepare(`INSERT INTO character_tags (character_id, tag_id) VALUES (?, ?)`)
    .run('c1c1c1c1-0000-4000-8000-000000000001', 'tag-1');
  db.prepare(`INSERT INTO lorebooks (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run('c1c1c1c1-0000-4000-8000-000000000004', 'Drill Lore', 'lore', 1700000007000, 1700000008000);
  db.prepare(`INSERT INTO presets (id, kind, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run('c1c1c1c1-0000-4000-8000-000000000005', 'instruct', 'Drill Preset', '{}', 1700000009000, 1700000010000);
  db.close();
}

function run(cli, dataRoot, legacyDb) {
  console.log(`[upgrade-drill] data root: ${dataRoot}`);
  console.log(`[upgrade-drill] legacy db: ${legacyDb}`);
  const sourceHashBefore = sha256File(legacyDb);

  // --- Step 1: one-shot migration (prepare + validate + commit + kernel open)
  const migrate = runCli(cli, ['--root', dataRoot, '--migrate-legacy', legacyDb]);
  if (migrate.status !== 0) fail(`migration exited ${migrate.status}\nstdout: ${migrate.stdout}\nstderr: ${migrate.stderr}`);
  for (const needle of ['migration committed', 'active_root:', 'kernel opened on the active root']) {
    if (!migrate.stdout.includes(needle)) fail(`stdout lacks ${JSON.stringify(needle)}\n${migrate.stdout}`);
  }
  if (!migrate.stdout.includes('characters=1')) fail(`converted count mismatch:\n${migrate.stdout}`);
  if (!migrate.stdout.includes('chats=1') || !migrate.stdout.includes('messages=1')) {
    fail(`chat/message counts mismatch:\n${migrate.stdout}`);
  }
  if (migrate.stdout.includes('- c1c1c1c1-0000-4000-8000-000000000099')) {
    fail('soft-deleted character was reported as migrated');
  }
  if (migrate.stderr.includes('sk-dead-secret')) {
    fail('provider secret leaked into progress output');
  }
  ok('migration committed with correct counts; kernel opened on the active root');

  // --- Step 2: the upgraded user sees the same data (characters.get)
  const get = runCli(cli, [
    '--root', dataRoot,
    '--operation', 'characters.get',
    JSON.stringify({ characterId: 'c1c1c1c1-0000-4000-8000-000000000001' }),
  ]);
  if (get.status !== 0) fail(`characters.get exited ${get.status}: ${get.stderr}`);
  if (!get.stdout.includes('Drill Character')) fail(`upgraded data lost the character name:\n${get.stdout}`);
  ok('characters.get returns the migrated character');

  // --- Step 3: the legacy database was never modified
  const sourceHashAfter = sha256File(legacyDb);
  if (sourceHashBefore !== sourceHashAfter) {
    fail('legacy database was modified by the migration');
  }
  ok('legacy database byte-identical after migration');

  // --- Step 4: re-running the migration is idempotent (no second staging root)
  const rerun = runCli(cli, ['--root', dataRoot, '--migrate-legacy', legacyDb]);
  if (rerun.status !== 0) fail(`idempotent re-run exited ${rerun.status}: ${rerun.stderr}`);
  const stagingRoots = [];
  for (const entry of (() => {
    try {
      return JSON.parse(readFileSync(join(dataRoot, 'activation-journal.json'), 'utf8')).entries ?? [];
    } catch {
      return [];
    }
  })()) {
    if (entry.kind === 'migration' && entry.toRoot) stagingRoots.push(entry.toRoot);
  }
  if (new Set(stagingRoots).size !== 1) {
    fail(`expected exactly one staging root, got: ${JSON.stringify(stagingRoots)}`);
  }
  ok('re-run idempotent: one committed entry, one staging root');

  // --- Step 5: the safety copy exists and matches the legacy source
  const backupsDir = join(dataRoot, 'backups');
  if (!existsSync(backupsDir)) fail('no pre-migration safety copy directory');
  const copyEntries = [];
  for (const name of readdirSyncSafe(backupsDir)) {
    if (name.startsWith('pre-migration-')) {
      const dbFile = join(backupsDir, name, 'database.sqlite');
      if (existsSync(dbFile)) copyEntries.push(dbFile);
    }
  }
  if (copyEntries.length !== 1) fail(`expected one pre-migration copy, got ${copyEntries.length}`);
  if (sha256File(copyEntries[0]) !== sourceHashBefore) {
    fail('safety copy does not match the legacy source');
  }
  ok('pre-migration safety copy matches the legacy database checksum');

  // --- Step 6: activation journal is committed; versioned root active
  const journal = JSON.parse(readFileSync(join(dataRoot, 'activation-journal.json'), 'utf8'));
  const last = journal.entries.at(-1);
  if (!last || last.status !== 'committed') fail(`journal last entry not committed: ${JSON.stringify(last)}`);
  if (!last.toRoot || !last.fromRoot) fail(`journal entry lacks root paths: ${JSON.stringify(last)}`);
  ok(`activation journal committed (${last.kind}); rollback pointer retained at ${last.fromRoot}`);
}

function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// Top-level (ESM).
const cli = resolveCli();
const workDir = mkdtempSync(join(tmpdir(), 'neotavern-upgrade-drill-'));
const legacyDb = join(workDir, 'app.db');
const dataRoot = join(workDir, 'data');
buildLegacyFixture(legacyDb);
ok(`fixture: ${legacyDb} (${readFileSync(legacyDb).length} bytes)`);
run(cli, dataRoot, legacyDb);
console.log('[upgrade-drill] PASS');
if (!keep) rmSync(workDir, { recursive: true, force: true });
