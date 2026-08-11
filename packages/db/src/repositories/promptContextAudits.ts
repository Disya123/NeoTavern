import {
  PromptContextAuditSchema,
  validateSchema,
  type PromptContextAudit,
  type PromptContextAuditStatus,
  type TokenUsage,
} from '@neotavern/contracts';
import type { SqliteConnection } from '../connection.js';
import { parseJson, toJson } from '../json.js';

interface PromptContextAuditRow {
  payload: string;
}

export interface PromptContextAuditTerminalUpdate {
  status: Exclude<PromptContextAuditStatus, 'prepared'>;
  errorCode: string | null;
  usage: TokenUsage | null;
}

/** Stores one bounded, full prompt audit per chat. */
export class PromptContextAuditRepository {
  constructor(private readonly sqlite: SqliteConnection) {}

  prepare(audit: PromptContextAudit): void {
    const validated = validateSchema(PromptContextAuditSchema, audit);
    if (!validated.ok) throw validated.error;
    this.sqlite
      .prepare(
        `INSERT INTO prompt_context_audits (chat_id, generation_id, payload, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET
           generation_id = excluded.generation_id,
           payload = excluded.payload,
           created_at = excluded.created_at`,
      )
      .run(audit.chatId, audit.generationId, toJson(validated.value), audit.createdAt);
  }

  getLatest(chatId: string): PromptContextAudit | null {
    const row = this.sqlite
      .prepare('SELECT payload FROM prompt_context_audits WHERE chat_id = ?')
      .get(chatId) as PromptContextAuditRow | undefined;
    if (!row) return null;
    const parsed = validateSchema(PromptContextAuditSchema, parseJson<unknown>(row.payload, null));
    if (!parsed.ok) throw parsed.error;
    return parsed.value;
  }

  /**
   * Apply a terminal state only when this generation is still the latest one.
   * The conditional JSON update is one SQLite statement, so concurrent older
   * requests cannot overwrite a newer audit.
   */
  finish(chatId: string, generationId: string, update: PromptContextAuditTerminalUpdate): boolean {
    if (update.errorCode && !/^[A-Z][A-Z0-9_]{0,127}$/.test(update.errorCode)) {
      throw new TypeError('Prompt audit errorCode must be a stable machine code');
    }
    const result = this.sqlite
      .prepare(
        `UPDATE prompt_context_audits
         SET payload = json_set(
           payload,
           '$.status', ?,
           '$.errorCode', ?,
           '$.usage', json(?)
         )
         WHERE chat_id = ? AND generation_id = ?`,
      )
      .run(update.status, update.errorCode, toJson(update.usage), chatId, generationId);
    return result.changes > 0;
  }
}
