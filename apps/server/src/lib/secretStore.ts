/**
 * Server-side SecretStore wiring (ТЗ §SEC-01 / §SEC-01.1).
 *
 * Owns the active SecretStore backend and the opaque-reference contract:
 * - provider secrets live under the `provider` namespace, one record per
 *   `provider_secrets` row, referenced by row id;
 * - plugin secrets live under the `plugin` namespace, one record per
 *   (scope, key), referenced by `scope\u0000key`.
 *
 * The main database holds only references (`portable:…`, `session:…`,
 * `env:…`). `resolve()` maps a reference back to a value through the store —
 * a reference whose backend is unavailable resolves to null and the caller
 * surfaces the stable "secret unavailable" state instead of a plaintext
 * fallback. `migrateLegacySecrets()` moves pre-migration plaintext rows into
 * the store (idempotent, skipped while the store is locked).
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, ErrorCodes, type Logger } from '@neotavern/shared';
import {
  FileEncryptedSecretStore,
  MemorySecretStore,
  UnavailableSecretStore,
  EnvSecretStore,
  SecretStoreError,
  SecretStoreErrorCodes,
  parseSecretRef,
  type SecretStore,
} from '@neotavern/secret-store';
import type { AppContext } from '../types.js';

export const PROVIDER_SECRET_NAMESPACE = 'provider';
export const PLUGIN_SECRET_NAMESPACE = 'plugin';

export interface SecretStoreHandle {
  /** The active backend (portable / session / env / unavailable). */
  readonly backend: SecretStore;
  /** Namespace for a provider's secrets. */
  providerNamespace(providerId: string): string;
  /** Namespace + record id for a plugin secret (scope, key). */
  pluginSecretId(scope: string, key: string): string;
  /**
   * Persist a value and return its opaque reference. Throws when the backend
   * is read-only (env) or unavailable — callers surface an explicit error,
   * never a plaintext fallback.
   */
  storeValue(namespace: string, id: string, value: string): Promise<string>;
  /** Resolve an opaque reference to a value, or null when unavailable. */
  resolve(ref: string): Promise<string | null>;
  /** Move pre-migration plaintext rows into the store. Returns migrated rows. */
  migrateLegacySecrets(ctx: AppContext): Promise<{ provider: number; plugin: number }>;
}

export async function createSecretStoreHandle(
  mode: 'portable' | 'session' | 'env',
  passphrase: string | null,
  dataDir: string,
  logger: Logger,
): Promise<SecretStoreHandle> {
  let backend: SecretStore;
  let portable: FileEncryptedSecretStore | null = null;

  if (mode === 'portable') {
    const file = join(dataDir, 'secrets.enc');
    portable = new FileEncryptedSecretStore(file);
    mkdirSync(dataDir, { recursive: true });
    try {
      await portable.open(passphrase ?? '');
      logger.info(`[secret-store] portable backend opened at ${file}`);
    } catch {
      // A missing file means the store was never created (fresh profile);
      // create it. Any other failure (wrong passphrase, corruption) must
      // surface loudly — never degrade to another backend.
      try {
        await portable.create(passphrase ?? '');
        logger.info(`[secret-store] portable backend created at ${file}`);
      } catch (error) {
        logger.error(`[secret-store] cannot open portable store: ${String(error)}`);
        throw error;
      }
    }
    backend = portable;
  } else if (mode === 'env') {
    backend = new EnvSecretStore();
  } else if (mode === 'session') {
    backend = new MemorySecretStore();
  } else {
    backend = new UnavailableSecretStore();
  }

  return createSecretStoreHandleForBackend(backend, portable, logger);
}

/**
 * Build a handle around an already-constructed backend (tests inject their own
 * store; `portable` must be supplied for portable refs to resolve).
 */
export function createSecretStoreHandleForBackend(
  backend: SecretStore,
  portable: FileEncryptedSecretStore | null = null,
  logger: Logger | null = null,
): SecretStoreHandle {
  return {
    backend,
    providerNamespace(providerId: string): string {
      return `${PROVIDER_SECRET_NAMESPACE}:${providerId}`;
    },
    pluginSecretId(scope: string, key: string): string {
      return `${scope}\u0000${key}`;
    },
    async storeValue(namespace: string, id: string, value: string): Promise<string> {
      const ref = await backend.put(namespace, id, value);
      return backend.ref(namespace, ref);
    },
    async resolve(ref: string): Promise<string | null> {
      const parsed = parseSecretRef(ref);
      if (!parsed) return null;
      const owner = ownerFor(parsed.kind, portable, backend);
      if (!owner) return null;
      return owner.get(parsed.namespace, parsed.id);
    },
    async migrateLegacySecrets(ctx: AppContext): Promise<{ provider: number; plugin: number }> {
      return migrateLegacySecrets(ctx, backend, logger);
    },
  };
}

/**
 * Translate a SecretStore failure into the stable API error vocabulary
 * (ТЗ §7.3): no backend / locked store → `SECRET_UNAVAILABLE_ON_THIS_DEVICE`,
 * read-only backend → `SECRET_STORE_READ_ONLY`, anything else → INTERNAL.
 * Returns null for non-SecretStore errors (callers rethrow the original).
 */
export function toSecretStoreAppError(error: unknown): AppError | null {
  if (!(error instanceof SecretStoreError)) return null;
  switch (error.code) {
    case SecretStoreErrorCodes.SECRET_STORE_LOCKED:
      return new AppError({
        code: ErrorCodes.SECRET_UNAVAILABLE_ON_THIS_DEVICE,
        message: error.message,
      });
    case SecretStoreErrorCodes.SECRET_READ_ONLY:
      return new AppError({ code: ErrorCodes.SECRET_STORE_READ_ONLY, message: error.message });
    default:
      return new AppError({ code: ErrorCodes.INTERNAL, message: error.message, cause: error });
  }
}

/** The store instance owning a reference kind (portable refs → file store). */
function ownerFor(
  kind: string,
  portable: FileEncryptedSecretStore | null,
  fallback: SecretStore,
): SecretStore | null {
  if (kind === 'portable') return portable;
  if (kind === 'session' || kind === 'env') return fallback;
  return null;
}

/**
 * Idempotent bootstrap import: rows that still hold pre-migration plaintext
 * (`value` set, `value_ref` NULL) are moved into the store and rewritten as
 * references. Rows whose value is already an opaque reference are skipped.
 * While the store is locked/unavailable nothing is migrated — the runtime
 * then reports secrets as unavailable rather than reading plaintext.
 */
async function migrateLegacySecrets(
  ctx: AppContext,
  backend: SecretStore,
  logger: Logger | null,
): Promise<{ provider: number; plugin: number }> {
  const log = logger ?? ctx.logger;
  if (!backend.isAvailable()) {
    log.warn('[secret-store] backend unavailable — legacy secret import skipped');
    return { provider: 0, plugin: 0 };
  }
  const repos = ctx.database.repos;
  let provider = 0;
  let plugin = 0;

  for (const row of await repos.providerSecrets.listUnmigrated()) {
    if (parseSecretRef(row.value) !== null) {
      // Already a reference (e.g. written by an older build); normalize it.
      await repos.providerSecrets.markMigrated(row.id, row.value);
      continue;
    }
    const namespace = `provider:${row.providerId}`;
    try {
      const ref = await backend.put(namespace, row.id, row.value);
      await repos.providerSecrets.markMigrated(row.id, backend.ref(namespace, ref));
      provider += 1;
    } catch (error) {
      log.error(`[secret-store] provider secret import failed for ${row.id}: ${String(error)}`);
    }
  }

  for (const row of await repos.pluginSecrets.listUnmigrated()) {
    if (parseSecretRef(row.value) !== null) {
      await repos.pluginSecrets.markMigrated(row.pluginId, row.scope, row.key, row.value);
      continue;
    }
    const id = `${row.scope}\u0000${row.key}`;
    const namespace = `plugin:${row.pluginId}`;
    try {
      const ref = await backend.put(namespace, id, row.value);
      await repos.pluginSecrets.markMigrated(
        row.pluginId,
        row.scope,
        row.key,
        backend.ref(namespace, ref),
      );
      plugin += 1;
    } catch (error) {
      log.error(
        `[secret-store] plugin secret import failed for ${row.pluginId}/${row.scope}/${row.key}: ${String(error)}`,
      );
    }
  }

  if (provider + plugin > 0) {
    log.info(`[secret-store] migrated ${provider} provider + ${plugin} plugin secrets`);
  }
  return { provider, plugin };
}
