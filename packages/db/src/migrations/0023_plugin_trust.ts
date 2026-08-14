/**
 * Plugin package trust (ТЗ §SEC-05): recorded trust state and the publisher
 * key fingerprint for verified packages.
 *
 * `trust_state` is one of `built-in`, `verified-publisher`, `locally-trusted`,
 * `unsigned-untrusted` (see contracts `PluginPackageTrust`). Pre-existing
 * rows predate signature verification and get the honest default
 * `unsigned-untrusted`. `publisher_key_id` is the fingerprint of the trusted
 * Ed25519 key that verified the package, NULL for everything else.
 *
 * Additive (`ALTER TABLE ADD COLUMN`); rollback is restoring the pre-migration
 * backup the runner creates for a populated database.
 */
import type { Migration } from './types.js';

const up = /* sql */ `
ALTER TABLE plugin_registry ADD COLUMN trust_state TEXT NOT NULL DEFAULT 'unsigned-untrusted';
ALTER TABLE plugin_registry ADD COLUMN publisher_key_id TEXT;
`;

export const migration: Migration = {
  version: 23,
  name: '0023_plugin_trust',
  up,
};
