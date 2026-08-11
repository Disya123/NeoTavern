/**
 * Swipe history and child chats (ST1 message actions).
 *
 * Three additive changes:
 *
 * 1. `message_variants.position` — each variant gets a deterministic 0-based
 *    position ordered by (created_at, id), enforced by a UNIQUE index.
 * 2. `messages.variant_count` / `active_variant_position` — the swipe model
 *    counts the active content as a variant (positions form a permutation of
 *    0..variant_count-1 with exactly one hole: the active one). The backfill
 *    makes the current text the newest variant at position N.
 * 3. `chats.parent_chat_id` / `origin` / `source_message_id` — checkpoint and
 *    branch snapshots record their provenance.
 *
 * Additive DDL + backfill UPDATEs only; rollback is restoring the
 * pre-migration backup the runner creates for a populated database.
 */
import type { Migration } from './types.js';

const up = /* sql */ `
ALTER TABLE message_variants ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
UPDATE message_variants SET position = (
  SELECT COUNT(*) FROM message_variants AS earlier
  WHERE earlier.message_id = message_variants.message_id
    AND (earlier.created_at < message_variants.created_at
      OR (earlier.created_at = message_variants.created_at AND earlier.id < message_variants.id))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_variants_position
  ON message_variants(message_id, position);
ALTER TABLE messages ADD COLUMN variant_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN active_variant_position INTEGER;
ALTER TABLE messages ADD COLUMN checkpoint_chat_id TEXT;
UPDATE messages SET
  variant_count = 1 + (SELECT COUNT(*) FROM message_variants v WHERE v.message_id = messages.id),
  active_variant_position = (SELECT COUNT(*) FROM message_variants v WHERE v.message_id = messages.id);
ALTER TABLE chats ADD COLUMN parent_chat_id TEXT;
ALTER TABLE chats ADD COLUMN origin TEXT;
ALTER TABLE chats ADD COLUMN source_message_id TEXT;
`;

export const migration: Migration = {
  version: 20,
  name: '0020_swipe_history_and_child_chats',
  up,
};
