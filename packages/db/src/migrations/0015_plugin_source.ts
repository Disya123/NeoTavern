/**
 * Plugin install source and resolved npm dependencies.
 *
 * `source` records where the package came from: `{"type":"zip"}` for a manual
 * upload or `{"type":"git","url":...,"ref":...}` for a repository install.
 * `dependencies` stores the installer-produced list of npm packages placed in
 * the package's `node_modules` (name/version/integrity), surfaced in the
 * consent UI. Both are nullable JSON so pre-existing rows keep working.
 *
 * Additive (`ALTER TABLE ADD COLUMN`); rollback is restoring the pre-migration
 * backup the runner creates for a populated database.
 */
import type { Migration } from './types.js';

const up = /* sql */ `
ALTER TABLE plugin_registry ADD COLUMN source TEXT;
ALTER TABLE plugin_registry ADD COLUMN dependencies TEXT;
`;

export const migration: Migration = {
  version: 15,
  name: '0015_plugin_source',
  up,
};
