/**
 * Separate requested permissions from explicit user grants and retain a stable
 * runtime error code without serializing developer messages into the UI.
 */
import type { Migration } from './types.js';

const up = /* sql */ `
ALTER TABLE plugin_registry
  ADD COLUMN granted_permissions TEXT NOT NULL DEFAULT '[]';
ALTER TABLE plugin_registry
  ADD COLUMN last_error_code TEXT;
`;

export const migration: Migration = {
  version: 4,
  name: '0004_plugin_consent',
  up,
};
