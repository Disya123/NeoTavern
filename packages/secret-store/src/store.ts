/**
 * SecretStore port (ТЗ §SEC-01).
 *
 * The store is namespace-isolated, holds versioned records and exposes
 * enumerate/revoke plus verifiable backend metadata WITHOUT ever revealing a
 * secret value through metadata calls. Secret values never enter the main
 * database, prompts, diagnostics, logs, exports or crash reports — the main
 * database stores only an opaque reference produced by `ref()`.
 */

/** A stored secret record (metadata + value). */
export interface SecretRecord {
  /** Opaque record id inside the store (unique per namespace). */
  id: string;
  value: string;
  createdAt: number;
  updatedAt: number;
}

/** Verifiable backend metadata — never includes secret values. */
export interface SecretBackendInfo {
  /** Backend kind: 'portable' | 'session' | 'env'. */
  kind: 'portable' | 'session' | 'env';
  /** Whether records survive a process restart. */
  persistent: boolean;
  /** Whether the backend accepts writes. */
  writable: boolean;
  /** Portable file format version, when the backend has one. */
  formatVersion?: number;
  /** KDF identifier of the on-disk format, when applicable. */
  kdf?: string;
  /** Whether the store is currently unlocked/usable. */
  available: boolean;
  /** Record count across all namespaces (content-free). */
  recordCount: number;
}

export interface SecretStore {
  /** True when the backend is usable (unlocked, not locked). */
  isAvailable(): boolean;
  /** Metadata about the backend, without any secret values. */
  describe(): SecretBackendInfo;
  /** Store (create or overwrite) a record. Returns the stored record id. */
  put(namespace: string, id: string, value: string): Promise<string>;
  /** Read a record's value. Resolves null when missing. */
  get(namespace: string, id: string): Promise<string | null>;
  /** Delete a record. Returns true when a record was removed. */
  delete(namespace: string, id: string): Promise<boolean>;
  /** Metadata-only list for a namespace — no values. */
  list(namespace: string): Promise<Array<{ id: string; createdAt: number; updatedAt: number }>>;
  /** True when a record exists. */
  has(namespace: string, id: string): Promise<boolean>;
  /** Opaque reference to persist outside the store (e.g. in the main DB). */
  ref(namespace: string, id: string): string;
}

/** Reference prefixes — kept in sync with `parseSecretRef`. */
export const SECRET_REF_PREFIXES = ['portable:', 'session:', 'env:'] as const;

export type SecretRefKind = (typeof SECRET_REF_PREFIXES)[number] extends `${infer K}:` ? K : never;

export interface ParsedSecretRef {
  kind: SecretRefKind;
  namespace: string;
  id: string;
}

/**
 * Parse an opaque reference persisted outside the store. Returns null for
 * strings that are not store references (e.g. legacy plaintext values or
 * unrelated data).
 */
export function parseSecretRef(ref: string): ParsedSecretRef | null {
  const index = ref.indexOf(':');
  if (index <= 0) return null;
  const kind = ref.slice(0, index) as SecretRefKind;
  if (!SECRET_REF_PREFIXES.includes(`${kind}:` as (typeof SECRET_REF_PREFIXES)[number]))
    return null;
  const namespace = ref.slice(index + 1);
  const lastColon = namespace.lastIndexOf(':');
  if (lastColon <= 0 || lastColon === namespace.length - 1) return null;
  return { kind, namespace: namespace.slice(0, lastColon), id: namespace.slice(lastColon + 1) };
}

/** Build the opaque reference string for a (namespace, id) pair. */
export function makeSecretRef(kind: SecretRefKind, namespace: string, id: string): string {
  return `${kind}:${namespace}:${id}`;
}
