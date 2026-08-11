/**
 * Durable, idempotent imports of external user data.
 *
 * The repository is intentionally the only layer that knows how an imported
 * artifact maps to the normalized SQLite schema. Small artifacts are committed
 * atomically. Chats are streamed message-by-message and carry an `importing`
 * recovery marker so an interrupted retry can remove the partial chat first.
 */
import type {
  CharacterCreate,
  DataImportConflictPolicy,
  MessageRole,
  PersonaCreate,
} from '@neotavern/contracts';
import { uuidv7 } from '@neotavern/shared';
import type { Clock } from '../db.js';
import type { SqliteConnection } from '../connection.js';
import { parseJson, toJson } from '../json.js';

export interface CompletedImportJob {
  id: string;
  summary: Record<string, unknown>;
}

export interface ImportArtifactIdentity {
  sourceKind: string;
  sourceKey: string;
  sourceHash: string;
  metadata?: Record<string, unknown>;
}

export interface ImportEntityResult {
  id: string;
  created: boolean;
}

export interface ImportConflictMatch {
  id: string;
  name: string;
  kind: 'artifact' | 'name';
}

export type ImportResolutionPolicy = DataImportConflictPolicy | 'preserve';

export interface ImportedChatStart extends ImportArtifactIdentity {
  characterId: string | null;
  personaId: string | null;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface ImportedChatSession extends ImportEntityResult {
  branchId: string;
  messageCount: number;
  replacedId?: string;
}

export interface ImportedMessageInput {
  role: MessageRole;
  content: string;
  name: string | null;
  meta: Record<string, unknown>;
  createdAt: number;
  variants: readonly string[];
}

export interface ImportedLoreEntry {
  keys: readonly string[];
  secondaryKeys: readonly string[];
  content: string;
  enabled: boolean;
  position: number;
  constant: boolean;
  selective: boolean;
  metadata: Record<string, unknown>;
}

export interface ImportedLorebookInput extends ImportArtifactIdentity {
  name: string;
  description: string;
  entries: readonly ImportedLoreEntry[];
}

interface ArtifactRow {
  target_id: string;
  status: string;
}

export class DataImportRepository {
  constructor(
    private readonly sqlite: SqliteConnection,
    private readonly clock: Clock,
  ) {}

  findCompletedJob(sourceHash: string): CompletedImportJob | null {
    const row = this.sqlite
      .prepare(
        `SELECT id, summary
         FROM import_jobs
         WHERE source_hash = ? AND status = 'completed'
         ORDER BY completed_at DESC
         LIMIT 1`,
      )
      .get(sourceHash) as { id: string; summary: string } | undefined;
    return row ? { id: row.id, summary: parseJson(row.summary, {}) } : null;
  }

  startJob(sourceHash: string, sourceName: string, sourceKind: string): string {
    const id = uuidv7();
    this.sqlite
      .prepare(
        `INSERT INTO import_jobs (
           id, source_hash, source_name, source_kind, status, summary,
           error_code, started_at, completed_at
         ) VALUES (?, ?, ?, ?, 'running', '{}', NULL, ?, NULL)`,
      )
      .run(id, sourceHash, sourceName, sourceKind, this.clock());
    return id;
  }

  completeJob(id: string, summary: Record<string, unknown>): void {
    this.sqlite
      .prepare(
        `UPDATE import_jobs
         SET status = 'completed', summary = ?, error_code = NULL, completed_at = ?
         WHERE id = ?`,
      )
      .run(toJson(summary), this.clock(), id);
  }

  failJob(id: string, errorCode: string, summary: Record<string, unknown> = {}): void {
    this.sqlite
      .prepare(
        `UPDATE import_jobs
         SET status = 'failed', summary = ?, error_code = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(toJson(summary), errorCode, this.clock(), id);
  }

  findArtifactTarget(sourceKind: string, sourceKey: string): string | null {
    const row = this.findArtifact(sourceKind, sourceKey);
    return row?.status === 'complete' && this.artifactTargetExists(sourceKind, row.target_id)
      ? row.target_id
      : null;
  }

  findConflict(options: {
    sourceKind: 'character' | 'chat' | 'persona' | 'lorebook' | 'preset';
    sourceKey: string;
    name: string;
    presetKind?: string;
  }): ImportConflictMatch | null {
    const artifact = this.findArtifact(options.sourceKind, options.sourceKey);
    if (
      artifact?.status === 'complete' &&
      this.artifactTargetExists(options.sourceKind, artifact.target_id)
    ) {
      return {
        id: artifact.target_id,
        name: this.artifactTargetName(options.sourceKind, artifact.target_id) ?? options.name,
        kind: 'artifact',
      };
    }

    const row =
      options.sourceKind === 'character'
        ? (this.sqlite
            .prepare(
              `SELECT id, name FROM characters
               WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL LIMIT 1`,
            )
            .get(options.name) as { id: string; name: string } | undefined)
        : options.sourceKind === 'persona'
          ? (this.sqlite
              .prepare('SELECT id, name FROM personas WHERE name = ? COLLATE NOCASE LIMIT 1')
              .get(options.name) as { id: string; name: string } | undefined)
          : options.sourceKind === 'lorebook'
            ? (this.sqlite
                .prepare(
                  `SELECT id, name FROM lorebooks
                   WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL LIMIT 1`,
                )
                .get(options.name) as { id: string; name: string } | undefined)
            : options.sourceKind === 'preset' && options.presetKind
              ? (this.sqlite
                  .prepare(
                    `SELECT id, name FROM presets
                     WHERE kind = ? AND name = ? COLLATE NOCASE LIMIT 1`,
                  )
                  .get(options.presetKind, options.name) as
                  { id: string; name: string } | undefined)
              : undefined;
    return row ? { ...row, kind: 'name' } : null;
  }

  importCharacter(
    identity: ImportArtifactIdentity,
    input: CharacterCreate,
    avatar: string | null,
    policy: ImportResolutionPolicy = 'preserve',
  ): ImportEntityResult {
    return this.sqlite.transaction(() => {
      const existing = this.findArtifact(identity.sourceKind, identity.sourceKey);
      if (
        policy === 'preserve' &&
        existing?.status === 'complete' &&
        this.artifactTargetExists('character', existing.target_id)
      ) {
        return { id: existing.target_id, created: false };
      }
      const conflict =
        policy === 'skip' || policy === 'merge' || policy === 'replace'
          ? this.findConflict({
              sourceKind: 'character',
              sourceKey: identity.sourceKey,
              name: input.name,
            })
          : null;
      if (existing) this.deleteArtifact(identity.sourceKind, identity.sourceKey);
      if (conflict) {
        if (policy === 'merge' || policy === 'replace') {
          this.updateImportedCharacter(conflict.id, input, avatar, policy);
        }
        this.insertArtifact(identity, 'character', conflict.id, 'complete');
        return { id: conflict.id, created: false };
      }

      const id = uuidv7();
      const now = this.clock();
      this.sqlite
        .prepare(
          `INSERT INTO characters (
             id, name, avatar, description, personality, scenario, first_message,
             example_dialogues, system_prompt, post_history_instructions, creator,
             creator_notes, ext, created_at, updated_at, deleted_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          id,
          input.name,
          avatar,
          input.description ?? '',
          input.personality ?? '',
          input.scenario ?? '',
          input.firstMessage ?? '',
          input.exampleDialogues ?? '',
          input.systemPrompt ?? null,
          input.postHistoryInstructions ?? null,
          input.creator ?? null,
          input.creatorNotes ?? null,
          toJson(input.ext ?? {}),
          now,
          now,
        );

      this.addCharacterTags(id, input.tags ?? []);

      this.insertArtifact(identity, 'character', id, 'complete');
      return { id, created: true };
    })();
  }

  importPersona(
    identity: ImportArtifactIdentity,
    input: PersonaCreate,
    policy: ImportResolutionPolicy = 'preserve',
  ): ImportEntityResult {
    return this.sqlite.transaction(() => {
      const existing = this.findArtifact(identity.sourceKind, identity.sourceKey);
      if (
        policy === 'preserve' &&
        existing?.status === 'complete' &&
        this.artifactTargetExists('persona', existing.target_id)
      ) {
        return { id: existing.target_id, created: false };
      }
      const conflict =
        policy === 'skip' || policy === 'merge' || policy === 'replace'
          ? this.findConflict({
              sourceKind: 'persona',
              sourceKey: identity.sourceKey,
              name: input.name,
            })
          : null;
      if (existing) this.deleteArtifact(identity.sourceKind, identity.sourceKey);
      if (conflict) {
        if (policy !== 'skip') {
          const current = this.sqlite
            .prepare(
              'SELECT name, description, avatar, is_default FROM personas WHERE id = ? LIMIT 1',
            )
            .get(conflict.id) as
            | {
                name: string;
                description: string;
                avatar: string | null;
                is_default: number;
              }
            | undefined;
          if (current) {
            const replacing = policy === 'replace';
            const isDefault = replacing ? Boolean(input.isDefault) : Boolean(current.is_default);
            if (isDefault) {
              this.sqlite.prepare('UPDATE personas SET is_default = 0 WHERE is_default = 1').run();
            }
            this.sqlite
              .prepare(
                `UPDATE personas
                 SET name = ?, description = ?, avatar = ?, is_default = ?, updated_at = ?
                 WHERE id = ?`,
              )
              .run(
                replacing ? input.name : preferExisting(current.name, input.name),
                replacing
                  ? (input.description ?? '')
                  : preferExisting(current.description, input.description ?? ''),
                replacing ? (input.avatar ?? null) : (current.avatar ?? input.avatar ?? null),
                isDefault ? 1 : 0,
                this.clock(),
                conflict.id,
              );
          }
        }
        this.insertArtifact(identity, 'persona', conflict.id, 'complete');
        return { id: conflict.id, created: false };
      }

      const id = uuidv7();
      const now = this.clock();
      if (input.isDefault) {
        this.sqlite.prepare('UPDATE personas SET is_default = 0 WHERE is_default = 1').run();
      }
      this.sqlite
        .prepare(
          `INSERT INTO personas (
             id, name, description, avatar, is_default, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.name,
          input.description ?? '',
          input.avatar ?? null,
          input.isDefault ? 1 : 0,
          now,
          now,
        );
      this.insertArtifact(identity, 'persona', id, 'complete');
      return { id, created: true };
    })();
  }

  beginChatImport(
    input: ImportedChatStart,
    policy: ImportResolutionPolicy = 'preserve',
  ): ImportedChatSession {
    return this.sqlite.transaction(() => {
      const existing = this.findArtifact(input.sourceKind, input.sourceKey);
      let replacedId: string | undefined;
      if (existing?.status === 'complete') {
        const branch = this.sqlite
          .prepare('SELECT active_branch_id, message_count FROM chats WHERE id = ?')
          .get(existing.target_id) as
          { active_branch_id: string | null; message_count: number } | undefined;
        if (branch?.active_branch_id && policy !== 'replace') {
          return {
            id: existing.target_id,
            branchId: branch.active_branch_id,
            messageCount: branch.message_count,
            created: false,
          };
        }
        if (branch?.active_branch_id && policy === 'replace') {
          replacedId = existing.target_id;
        }
        this.deleteArtifact(input.sourceKind, input.sourceKey);
      } else if (existing) {
        this.sqlite.prepare('DELETE FROM chats WHERE id = ?').run(existing.target_id);
        this.deleteArtifact(input.sourceKind, input.sourceKey);
      }

      const id = uuidv7();
      const branchId = uuidv7();
      this.sqlite
        .prepare(
          `INSERT INTO chats (
             id, character_id, persona_id, title, active_branch_id, summary,
             message_count, created_at, updated_at, deleted_at
           ) VALUES (?, ?, ?, ?, ?, '', 0, ?, ?, NULL)`,
        )
        .run(
          id,
          input.characterId,
          input.personaId,
          input.title,
          branchId,
          input.createdAt,
          input.updatedAt,
        );
      this.sqlite
        .prepare(
          `INSERT INTO chat_branches (id, chat_id, name, created_at)
           VALUES (?, ?, 'main', ?)`,
        )
        .run(branchId, id, input.createdAt);
      this.insertArtifact(input, 'chat', id, 'importing');
      return {
        id,
        branchId,
        messageCount: 0,
        created: true,
        ...(replacedId ? { replacedId } : {}),
      };
    })();
  }

  /**
   * Store legacy extension settings imported from SillyTavern. Shares the
   * storage shape and key with the server-side legacy compat host
   * (`apps/server/src/legacy/host.ts` LEGACY_SETTINGS_KEY), so imported values
   * are immediately served by GET /api/v2/legacy/extension-settings.
   */
  findLegacySettings(namespace: string): Record<string, unknown> | null {
    const row = this.sqlite
      .prepare(
        `SELECT value FROM plugin_storage
          WHERE plugin_id = ? AND key = 'legacy.extension-settings'`,
      )
      .get(namespace) as { value: string } | undefined;
    if (!row) return null;
    try {
      const parsed: unknown = JSON.parse(row.value);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  upsertLegacySettings(namespace: string, value: Record<string, unknown>): void {
    this.sqlite
      .prepare(
        `INSERT INTO plugin_storage (plugin_id, key, value)
         VALUES (?, 'legacy.extension-settings', ?)
         ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value`,
      )
      .run(namespace, JSON.stringify(value));
  }

  appendChatMessage(
    session: Pick<ImportedChatSession, 'id' | 'branchId'>,
    parentId: string | null,
    input: ImportedMessageInput,
  ): string {
    return this.sqlite.transaction(() => {
      const id = uuidv7();
      // Swipe model (migration 0020): the imported variants get deterministic
      // positions 0..N-1 and the current content is the active variant at N.
      const variants = uniqueStrings(input.variants).filter((variant) => variant !== input.content);
      this.sqlite
        .prepare(
          `INSERT INTO messages (
             id, chat_id, branch_id, parent_id, role, content, name, meta, created_at,
             variant_count, active_variant_position
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          session.id,
          session.branchId,
          parentId,
          input.role,
          input.content,
          input.name,
          toJson(input.meta),
          input.createdAt,
          variants.length + 1,
          variants.length,
        );
      for (const [index, content] of variants.entries()) {
        this.sqlite
          .prepare(
            `INSERT INTO message_variants (id, message_id, position, content, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(uuidv7(), id, index, content, input.createdAt);
      }
      return id;
    })();
  }

  finishChatImport(
    sourceKey: string,
    chatId: string,
    messageCount: number,
    updatedAt: number,
    replacedId?: string,
  ): void {
    this.sqlite.transaction(() => {
      if (replacedId) this.sqlite.prepare('DELETE FROM chats WHERE id = ?').run(replacedId);
      this.sqlite
        .prepare('UPDATE chats SET message_count = ?, updated_at = ? WHERE id = ?')
        .run(messageCount, updatedAt, chatId);
      this.sqlite
        .prepare(
          `UPDATE import_artifacts
           SET status = 'complete', updated_at = ?
           WHERE source_kind = 'chat' AND source_key = ? AND target_id = ?`,
        )
        .run(this.clock(), sourceKey, chatId);
    })();
  }

  abortChatImport(sourceKey: string, chatId: string, replacedId?: string, sourceHash = ''): void {
    this.sqlite.transaction(() => {
      this.sqlite.prepare('DELETE FROM chats WHERE id = ?').run(chatId);
      this.deleteArtifact('chat', sourceKey);
      if (replacedId && this.artifactTargetExists('chat', replacedId)) {
        this.insertArtifact(
          {
            sourceKind: 'chat',
            sourceKey,
            sourceHash,
            metadata: { restoredAfterCancelledReplace: true },
          },
          'chat',
          replacedId,
          'complete',
        );
      }
    })();
  }

  importLorebook(
    input: ImportedLorebookInput,
    policy: ImportResolutionPolicy = 'preserve',
  ): ImportEntityResult {
    return this.sqlite.transaction(() => {
      const existing = this.findArtifact(input.sourceKind, input.sourceKey);
      if (
        policy === 'preserve' &&
        existing?.status === 'complete' &&
        this.artifactTargetExists('lorebook', existing.target_id)
      ) {
        return { id: existing.target_id, created: false };
      }
      const conflict =
        policy === 'skip' || policy === 'merge' || policy === 'replace'
          ? this.findConflict({
              sourceKind: 'lorebook',
              sourceKey: input.sourceKey,
              name: input.name,
            })
          : null;
      if (existing) this.deleteArtifact(input.sourceKind, input.sourceKey);
      if (conflict) {
        if (policy === 'merge' || policy === 'replace') {
          this.updateImportedLorebook(conflict.id, input, policy);
        }
        this.insertArtifact(input, 'lorebook', conflict.id, 'complete');
        return { id: conflict.id, created: false };
      }

      const id = uuidv7();
      const now = this.clock();
      this.sqlite
        .prepare(
          `INSERT INTO lorebooks (
             id, name, description, metadata, created_at, updated_at, deleted_at
           ) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(id, input.name, input.description, toJson(input.metadata ?? {}), now, now);

      const insertEntry = this.sqlite.prepare(
        `INSERT INTO lore_entries (
           id, lorebook_id, keys_json, secondary_keys, content, enabled, position,
           constant, selective, metadata, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const entry of input.entries) {
        insertEntry.run(
          uuidv7(),
          id,
          toJson(entry.keys),
          toJson(entry.secondaryKeys),
          entry.content,
          entry.enabled ? 1 : 0,
          entry.position,
          entry.constant ? 1 : 0,
          entry.selective ? 1 : 0,
          toJson(entry.metadata),
          now,
          now,
        );
      }
      this.insertArtifact(input, 'lorebook', id, 'complete');
      return { id, created: true };
    })();
  }

  importPreset(
    identity: ImportArtifactIdentity,
    kind: string,
    name: string,
    data: Record<string, unknown>,
    policy: ImportResolutionPolicy = 'preserve',
  ): ImportEntityResult {
    return this.sqlite.transaction(() => {
      const existing = this.findArtifact(identity.sourceKind, identity.sourceKey);
      if (
        policy === 'preserve' &&
        existing?.status === 'complete' &&
        this.artifactTargetExists('preset', existing.target_id)
      ) {
        return { id: existing.target_id, created: false };
      }
      const conflict =
        policy === 'skip' || policy === 'merge' || policy === 'replace'
          ? this.findConflict({
              sourceKind: 'preset',
              sourceKey: identity.sourceKey,
              name,
              presetKind: kind,
            })
          : null;
      if (existing) this.deleteArtifact(identity.sourceKind, identity.sourceKey);
      if (conflict) {
        if (policy !== 'skip') {
          const current = this.sqlite
            .prepare('SELECT name, data FROM presets WHERE id = ? LIMIT 1')
            .get(conflict.id) as { name: string; data: string } | undefined;
          if (current) {
            const replacing = policy === 'replace';
            const nextData = replacing
              ? data
              : { ...data, ...parseJson<Record<string, unknown>>(current.data, {}) };
            this.sqlite
              .prepare('UPDATE presets SET name = ?, data = ?, updated_at = ? WHERE id = ?')
              .run(
                replacing
                  ? this.availablePresetName(kind, name, current.name, conflict.id)
                  : current.name,
                toJson(nextData),
                this.clock(),
                conflict.id,
              );
          }
        }
        this.insertArtifact(identity, 'preset', conflict.id, 'complete');
        return { id: conflict.id, created: false };
      }

      const id = uuidv7();
      const now = this.clock();
      const uniqueName = this.uniquePresetName(kind, name, identity.sourceHash);
      this.sqlite
        .prepare(
          `INSERT INTO presets (id, kind, name, data, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, kind, uniqueName, toJson(data), now, now);
      this.insertArtifact(identity, 'preset', id, 'complete');
      return { id, created: true };
    })();
  }

  private updateImportedCharacter(
    id: string,
    input: CharacterCreate,
    avatar: string | null,
    policy: 'merge' | 'replace',
  ): void {
    const current = this.sqlite
      .prepare(
        `SELECT name, avatar, description, personality, scenario, first_message,
                example_dialogues, system_prompt, post_history_instructions,
                creator, creator_notes, ext
         FROM characters WHERE id = ? LIMIT 1`,
      )
      .get(id) as
      | {
          name: string;
          avatar: string | null;
          description: string;
          personality: string;
          scenario: string;
          first_message: string;
          example_dialogues: string;
          system_prompt: string | null;
          post_history_instructions: string | null;
          creator: string | null;
          creator_notes: string | null;
          ext: string;
        }
      | undefined;
    if (!current) return;

    if (policy === 'replace') {
      const version = this.sqlite
        .prepare(
          `SELECT COALESCE(MAX(version), 0) + 1 AS version
           FROM character_versions WHERE character_id = ?`,
        )
        .get(id) as { version: number };
      const tags = this.characterTagNames(id);
      this.sqlite
        .prepare(
          `INSERT INTO character_versions (id, character_id, version, snapshot, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(uuidv7(), id, version.version, toJson({ ...current, tags }), this.clock());
    }

    const replacing = policy === 'replace';
    const currentExt = parseJson<Record<string, unknown>>(current.ext, {});
    const incomingExt = input.ext ?? {};
    this.sqlite
      .prepare(
        `UPDATE characters
         SET name = ?, avatar = ?, description = ?, personality = ?, scenario = ?,
             first_message = ?, example_dialogues = ?, system_prompt = ?,
             post_history_instructions = ?, creator = ?, creator_notes = ?,
             ext = ?, updated_at = ?, deleted_at = NULL
         WHERE id = ?`,
      )
      .run(
        replacing ? input.name : preferExisting(current.name, input.name),
        replacing ? avatar : (current.avatar ?? avatar),
        replacing
          ? (input.description ?? '')
          : preferExisting(current.description, input.description ?? ''),
        replacing
          ? (input.personality ?? '')
          : preferExisting(current.personality, input.personality ?? ''),
        replacing ? (input.scenario ?? '') : preferExisting(current.scenario, input.scenario ?? ''),
        replacing
          ? (input.firstMessage ?? '')
          : preferExisting(current.first_message, input.firstMessage ?? ''),
        replacing
          ? (input.exampleDialogues ?? '')
          : preferExisting(current.example_dialogues, input.exampleDialogues ?? ''),
        replacing
          ? (input.systemPrompt ?? null)
          : (current.system_prompt ?? input.systemPrompt ?? null),
        replacing
          ? (input.postHistoryInstructions ?? null)
          : (current.post_history_instructions ?? input.postHistoryInstructions ?? null),
        replacing ? (input.creator ?? null) : (current.creator ?? input.creator ?? null),
        replacing
          ? (input.creatorNotes ?? null)
          : (current.creator_notes ?? input.creatorNotes ?? null),
        toJson(replacing ? incomingExt : { ...incomingExt, ...currentExt }),
        this.clock(),
        id,
      );
    if (replacing) {
      this.sqlite.prepare('DELETE FROM character_tags WHERE character_id = ?').run(id);
    }
    this.addCharacterTags(id, input.tags ?? []);
  }

  private addCharacterTags(characterId: string, names: readonly string[]): void {
    for (const name of uniqueStrings(names)) {
      this.sqlite
        .prepare('INSERT OR IGNORE INTO tags (id, name) VALUES (?, ?)')
        .run(uuidv7(), name);
      const tag = this.sqlite.prepare('SELECT id FROM tags WHERE name = ?').get(name) as
        { id: string } | undefined;
      if (tag) {
        this.sqlite
          .prepare('INSERT OR IGNORE INTO character_tags (character_id, tag_id) VALUES (?, ?)')
          .run(characterId, tag.id);
      }
    }
  }

  private characterTagNames(characterId: string): string[] {
    return (
      this.sqlite
        .prepare(
          `SELECT tags.name
           FROM tags
           JOIN character_tags ON character_tags.tag_id = tags.id
           WHERE character_tags.character_id = ?
           ORDER BY tags.name`,
        )
        .all(characterId) as Array<{ name: string }>
    ).map((row) => row.name);
  }

  private updateImportedLorebook(
    id: string,
    input: ImportedLorebookInput,
    policy: 'merge' | 'replace',
  ): void {
    const current = this.sqlite
      .prepare('SELECT name, description, metadata FROM lorebooks WHERE id = ? LIMIT 1')
      .get(id) as { name: string; description: string; metadata: string } | undefined;
    if (!current) return;
    const replacing = policy === 'replace';
    const currentMetadata = parseJson<Record<string, unknown>>(current.metadata, {});
    this.sqlite
      .prepare(
        `UPDATE lorebooks
         SET name = ?, description = ?, metadata = ?, updated_at = ?, deleted_at = NULL
         WHERE id = ?`,
      )
      .run(
        replacing ? input.name : preferExisting(current.name, input.name),
        replacing ? input.description : preferExisting(current.description, input.description),
        toJson(
          replacing ? (input.metadata ?? {}) : { ...(input.metadata ?? {}), ...currentMetadata },
        ),
        this.clock(),
        id,
      );

    if (replacing) {
      this.sqlite.prepare('DELETE FROM lore_entries WHERE lorebook_id = ?').run(id);
      this.insertLoreEntries(id, input.entries);
      return;
    }

    const existingKeys = new Set(
      (
        this.sqlite
          .prepare(
            `SELECT keys_json, secondary_keys, content
             FROM lore_entries WHERE lorebook_id = ?`,
          )
          .all(id) as Array<{ keys_json: string; secondary_keys: string; content: string }>
      ).map((entry) => `${entry.keys_json}\u0000${entry.secondary_keys}\u0000${entry.content}`),
    );
    this.insertLoreEntries(
      id,
      input.entries.filter(
        (entry) =>
          !existingKeys.has(
            `${toJson(entry.keys)}\u0000${toJson(entry.secondaryKeys)}\u0000${entry.content}`,
          ),
      ),
    );
  }

  private insertLoreEntries(lorebookId: string, entries: readonly ImportedLoreEntry[]): void {
    const now = this.clock();
    const insertEntry = this.sqlite.prepare(
      `INSERT INTO lore_entries (
         id, lorebook_id, keys_json, secondary_keys, content, enabled, position,
         constant, selective, metadata, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const entry of entries) {
      insertEntry.run(
        uuidv7(),
        lorebookId,
        toJson(entry.keys),
        toJson(entry.secondaryKeys),
        entry.content,
        entry.enabled ? 1 : 0,
        entry.position,
        entry.constant ? 1 : 0,
        entry.selective ? 1 : 0,
        toJson(entry.metadata),
        now,
        now,
      );
    }
  }

  private findArtifact(sourceKind: string, sourceKey: string): ArtifactRow | null {
    const row = this.sqlite
      .prepare(
        `SELECT target_id, status
         FROM import_artifacts
         WHERE source_kind = ? AND source_key = ?`,
      )
      .get(sourceKind, sourceKey) as ArtifactRow | undefined;
    return row ?? null;
  }

  private insertArtifact(
    identity: ImportArtifactIdentity,
    targetKind: string,
    targetId: string,
    status: 'importing' | 'complete',
  ): void {
    const now = this.clock();
    this.sqlite
      .prepare(
        `INSERT INTO import_artifacts (
           source_kind, source_key, source_hash, target_kind, target_id, status,
           metadata, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        identity.sourceKind,
        identity.sourceKey,
        identity.sourceHash,
        targetKind,
        targetId,
        status,
        toJson(identity.metadata ?? {}),
        now,
        now,
      );
  }

  private deleteArtifact(sourceKind: string, sourceKey: string): void {
    this.sqlite
      .prepare('DELETE FROM import_artifacts WHERE source_kind = ? AND source_key = ?')
      .run(sourceKind, sourceKey);
  }

  private uniquePresetName(kind: string, requested: string, sourceHash: string): string {
    const exists = (name: string): boolean =>
      Boolean(
        this.sqlite.prepare('SELECT 1 FROM presets WHERE kind = ? AND name = ?').get(kind, name),
      );
    if (!exists(requested)) return requested;
    const base = `${requested} [Imported ${sourceHash.slice(0, 8)}]`;
    if (!exists(base)) return base;
    let suffix = 2;
    while (exists(`${base} ${suffix}`)) suffix += 1;
    return `${base} ${suffix}`;
  }

  private availablePresetName(
    kind: string,
    requested: string,
    current: string,
    targetId: string,
  ): string {
    const conflict = this.sqlite
      .prepare('SELECT 1 FROM presets WHERE kind = ? AND name = ? AND id <> ? LIMIT 1')
      .get(kind, requested, targetId);
    return conflict ? current : requested;
  }

  private artifactTargetExists(kind: string, id: string): boolean {
    const table =
      kind === 'character'
        ? 'characters'
        : kind === 'persona'
          ? 'personas'
          : kind === 'chat'
            ? 'chats'
            : kind === 'lorebook'
              ? 'lorebooks'
              : kind === 'preset'
                ? 'presets'
                : null;
    if (!table) return false;
    return Boolean(this.sqlite.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id));
  }

  private artifactTargetName(kind: string, id: string): string | null {
    const column = kind === 'chat' ? 'title' : 'name';
    const table =
      kind === 'character'
        ? 'characters'
        : kind === 'persona'
          ? 'personas'
          : kind === 'chat'
            ? 'chats'
            : kind === 'lorebook'
              ? 'lorebooks'
              : kind === 'preset'
                ? 'presets'
                : null;
    if (!table) return null;
    const row = this.sqlite
      .prepare(`SELECT ${column} AS name FROM ${table} WHERE id = ?`)
      .get(id) as { name: string } | undefined;
    return row?.name ?? null;
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function preferExisting(existing: string, incoming: string): string {
  return existing.trim().length > 0 ? existing : incoming;
}
