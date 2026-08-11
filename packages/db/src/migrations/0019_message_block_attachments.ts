/**
 * Persistent message block attachments (rev4 stage 4).
 *
 * Block attachments (plugin → message, with the renderer's serialized state)
 * are durable data: they survive page reloads and render identically in any
 * client. Cascade rules keep the table tidy: deleting a message or
 * uninstalling a plugin removes its attachments with it — no orphaned rows.
 *
 * Additive DDL only; rollback is restoring the pre-migration backup the
 * runner creates for a populated database.
 */
import type { Migration } from './types.js';

const up = /* sql */ `
CREATE TABLE IF NOT EXISTS message_block_attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL REFERENCES plugin_registry(id) ON DELETE CASCADE,
  block_type TEXT NOT NULL,
  renderer_id TEXT NOT NULL,
  descriptor_json TEXT NOT NULL DEFAULT '{}',
  serialized_state_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_message_blocks_message
  ON message_block_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_message_blocks_plugin
  ON message_block_attachments(plugin_id);
`;

export const migration: Migration = {
  version: 19,
  name: '0019_message_block_attachments',
  up,
};
