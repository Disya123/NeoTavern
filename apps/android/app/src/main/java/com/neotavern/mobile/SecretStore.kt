package com.neotavern.mobile

/**
 * Typed failure of a [SecretStore]. Thrown when the secure storage backend is
 * unavailable (keystore misconfiguration, hardware-backed key unreachable,
 * key material lost).
 *
 * Deliberately the ONLY failure mode: a store MUST NOT fall back to writing
 * plaintext when its backend is unavailable (ТЗ: "молча сохранять secrets в
 * plaintext при недоступности secure storage" is forbidden).
 */
class SecretStoreUnavailableError(message: String, cause: Throwable? = null) :
    Exception(message, cause)

/**
 * Encrypted key-value secret storage contract.
 *
 * Implementations MUST:
 *  - store only ciphertext (never the raw value — not even transiently
 *    logged or committed to disk in plaintext),
 *  - throw [SecretStoreUnavailableError] when the secure backend is
 *    unavailable — there is NO plaintext fallback,
 *  - never include secret values in log output, exception messages or
 *    toString().
 *
 * PURE interface (no android.*) so the contract can be exercised on the JVM
 * with a fake implementation.
 */
interface SecretStore {

    /** Encrypts and stores `value` under `key` (overwriting any prior value). */
    fun put(key: String, value: String)

    /** Returns the decrypted value for `key`, or `null` when absent/corrupt. */
    fun get(key: String): String?

    /** Removes the entry for `key` (no-op when absent). */
    fun delete(key: String)
}
