/**
 * NeoBackend singleton for the web UI (ТЗ §15).
 *
 * Every API call in the web app routes through the `NeoBackend` facade.
 * Until Phase 3 vertical slices migrate features to the Runtime Kernel, the
 * legacy Fastify server stays the transport: `LegacyBackend` serves the typed
 * wire operations it maps and the temporary `raw` passthrough covers the
 * unmigrated routes (tracked in the migration routing table,
 * `docs/architecture/operations-inventory.md`).
 */
import { LegacyBackend, type NeoBackend } from '@neotavern/neobackend';
import { request, sseUrl, upload } from './client.js';

export const backend: NeoBackend = new LegacyBackend({
  baseUrl: window.location.origin,
  transport: {
    request: (method, path, body, signal) => request(method, path, body, signal),
    upload: (path, file, signal) => upload(path, file, signal),
    sseUrl,
  },
});

/**
 * Raw legacy passthrough for unmigrated routes.
 *
 * Temporary: each Phase 3 feature cutover deletes its calls from this path.
 * The `LegacyBackend` getter throws `UnsupportedError` when constructed
 * without a transport; this singleton always has one.
 */
export function legacyRaw() {
  return (backend as LegacyBackend).raw;
}

export type { NeoBackend };
