/**
 * SecretStore error codes (ТЗ §SEC-01, §SEC-01.1).
 */
export const SecretStoreErrorCodes = {
  /** The store exists but is locked (portable store without passphrase). */
  SECRET_STORE_LOCKED: 'SECRET_STORE_LOCKED',
  /** Wrong passphrase / authentication failure (AEAD tag mismatch). */
  SECRET_STORE_AUTH_FAILED: 'SECRET_STORE_AUTH_FAILED',
  /** File exists but is not a valid secrets.enc (magic/version/parse). */
  SECRET_STORE_CORRUPT: 'SECRET_STORE_CORRUPT',
  /** Backend is read-only (env store). */
  SECRET_READ_ONLY: 'SECRET_READ_ONLY',
  /** Requested record does not exist. */
  SECRET_NOT_FOUND: 'SECRET_NOT_FOUND',
  /** Another unlock/rotate is in progress. */
  SECRET_STORE_BUSY: 'SECRET_STORE_BUSY',
} as const;

export type SecretStoreErrorCode =
  (typeof SecretStoreErrorCodes)[keyof typeof SecretStoreErrorCodes];

export class SecretStoreError extends Error {
  readonly code: SecretStoreErrorCode;

  constructor(code: SecretStoreErrorCode, message: string) {
    super(message);
    this.name = 'SecretStoreError';
    this.code = code;
  }
}
