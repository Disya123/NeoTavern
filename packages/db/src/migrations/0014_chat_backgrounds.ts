/**
 * Chat backgrounds.
 *
 * Adds `background_id` to `chats` so a chat can reference a wallpaper file in
 * `data/files/backgrounds/`. The filesystem is authoritative: the id is the
 * stored filename (content hash for uploads, original basename for ST1
 * imports), so no `backgrounds` table or foreign key is required. Deleting a
 * background nulls referencing rows at the API level.
 *
 * The migration is additive (`ALTER TABLE ADD COLUMN`) and idempotent-safe;
 * rollback is restoring the pre-migration backup the runner creates for a
 * populated database.
 */
import type { Migration } from './types.js';

const up = /* sql */ `
ALTER TABLE chats ADD COLUMN background_id TEXT;
`;

export const migration: Migration = {
  version: 14,
  name: '0014_chat_backgrounds',
  up,
};
