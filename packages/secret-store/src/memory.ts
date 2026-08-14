/**
 * Session-only SecretStore backend (ТЗ §SEC-01: «session-only secret»).
 *
 * Explicit mode — never a silent plaintext fallback: values exist only in
 * process memory and are gone after restart. The database keeps an opaque
 * reference; the provider then reports a stable "secret unavailable" state
 * until the user re-enters the key.
 */
import { SecretStoreError, SecretStoreErrorCodes } from './errors.js';
import type { SecretBackendInfo, SecretRecord, SecretStore } from './store.js';

type SessionEntry = SecretRecord;

export class MemorySecretStore implements SecretStore {
  /** Namespace-isolated: records are keyed by `namespace\0id`. */
  private readonly records = new Map<string, SessionEntry>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private keyOf(namespace: string, id: string): string {
    return `${namespace}\u0000${id}`;
  }

  isAvailable(): boolean {
    return true;
  }

  describe(): SecretBackendInfo {
    return {
      kind: 'session',
      persistent: false,
      writable: true,
      available: true,
      recordCount: this.records.size,
    };
  }

  async put(namespace: string, id: string, value: string): Promise<string> {
    const timestamp = this.now();
    const entryKey = this.keyOf(namespace, id);
    const entry = this.records.get(entryKey);
    if (entry) {
      entry.value = value;
      entry.updatedAt = timestamp;
    } else {
      this.records.set(entryKey, { id, value, createdAt: timestamp, updatedAt: timestamp });
    }
    return id;
  }

  async get(namespace: string, id: string): Promise<string | null> {
    return this.records.get(this.keyOf(namespace, id))?.value ?? null;
  }

  async delete(namespace: string, id: string): Promise<boolean> {
    return this.records.delete(this.keyOf(namespace, id));
  }

  async list(
    namespace: string,
  ): Promise<Array<{ id: string; createdAt: number; updatedAt: number }>> {
    const prefix = `${namespace}\u0000`;
    return [...this.records.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, { id, createdAt, updatedAt }]) => ({ id, createdAt, updatedAt }));
  }

  async has(namespace: string, id: string): Promise<boolean> {
    return this.records.has(this.keyOf(namespace, id));
  }

  ref(namespace: string, id: string): string {
    return `session:${namespace}:${id}`;
  }

  /** Forget every record (manual lock / session cleanup, best-effort). */
  clear(): void {
    this.records.clear();
  }
}

/** A store that is permanently unavailable — used when no backend is configured. */
export class UnavailableSecretStore implements SecretStore {
  isAvailable(): boolean {
    return false;
  }

  describe(): SecretBackendInfo {
    return {
      kind: 'session',
      persistent: false,
      writable: false,
      available: false,
      recordCount: 0,
    };
  }

  async put(): Promise<string> {
    throw new SecretStoreError(
      SecretStoreErrorCodes.SECRET_STORE_LOCKED,
      'no secret backend is configured',
    );
  }

  async get(): Promise<string | null> {
    return null;
  }

  async delete(): Promise<boolean> {
    return false;
  }

  async list(): Promise<Array<{ id: string; createdAt: number; updatedAt: number }>> {
    return [];
  }

  async has(): Promise<boolean> {
    return false;
  }

  ref(namespace: string, id: string): string {
    return `session:${namespace}:${id}`;
  }
}
