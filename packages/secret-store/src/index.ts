/**
 * SecretStore port (ТЗ §SEC-01): versioned records, namespace/profile
 * isolation, enumerate/revoke and verifiable backend metadata without
 * revealing secrets. Backends: portable encrypted `secrets.enc`, session-only
 * memory and read-only environment.
 */
export * from './errors.js';
export * from './store.js';
export * from './memory.js';
export * from './file.js';
export * from './env.js';
