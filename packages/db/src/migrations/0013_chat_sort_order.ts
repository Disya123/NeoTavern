/**
 * Manual chat ordering.
 *
 * Adds `sort_order` to `chats` so the sidebar chat panel can persist the user's
 * drag-and-drop ordering. The list sorts by `sort_order ASC, updated_at DESC`
 * (new chats default to `sort_order = 0` and therefore appear on top until the
 * user reorders, matching the "manual order + new on top" behavior).
 *
 * `sort_order` is maintained only by the repository (reorder writes all rows of
 * a character in one transaction), so no triggers are required. Existing chats
 * keep `sort_order = 0` and fall back to `updated_at DESC` ordering.
 *
 * The migration is additive (`ALTER TABLE ADD COLUMN` + `CREATE INDEX IF NOT
 * EXISTS`) and idempotent-safe; rollback is restoring the pre-migration backup
 * the runner creates for a populated database.
 */
import type { Migration } from './types.js';

const up = /* sql */ `
ALTER TABLE chats ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS chats_character_sort_idx
  ON chats(character_id, sort_order, updated_at, id);
`;

export const migration: Migration = {
  version: 13,
  name: '0013_chat_sort_order',
  up,
};
