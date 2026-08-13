package com.neotavern.mobile

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * [SecretStore] backed by the Android Keystore (AES/GCM/NoPadding, 256-bit).
 *
 * - Keys live in the hardware-backed AndroidKeyStore under a single alias;
 *   plaintext never touches disk or logs.
 * - Values are stored as `base64(iv || ciphertext)` blobs in a private
 *   SharedPreferences file (no value content in keys or metadata).
 * - NO plaintext fallback: any keystore/cipher failure throws
 *   [SecretStoreUnavailableError]; the caller must surface the unavailability
 *   instead of degrading to plaintext (ТЗ security rule).
 * - A blob that fails authentication (e.g. key rotated/lost after restore)
 *   decrypts to `null` — the secret is gone, never wrong data.
 * - Secret values never appear in exceptions, logs or toString().
 */
class KeystoreSecretStore(context: Context) : SecretStore {

    private val prefs =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val keyStore: KeyStore = KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }

    init {
        if (!keyStore.containsAlias(KEY_ALIAS)) {
            generateKey()
        }
    }

    override fun put(key: String, value: String) {
        require(key.isNotBlank()) { "secret key must not be blank" }
        try {
            val blob = encrypt(value)
            prefs.edit().putString(prefKey(key), Base64.getEncoder().encodeToString(blob)).apply()
        } catch (e: SecretStoreUnavailableError) {
            throw e
        } catch (e: Exception) {
            throw SecretStoreUnavailableError("keystore encryption failed", e)
        }
    }

    override fun get(key: String): String? {
        val encoded = prefs.getString(prefKey(key), null) ?: return null
        return try {
            decrypt(Base64.getDecoder().decode(encoded))
        } catch (e: Exception) {
            // Key material lost (restore/rotation) or corruption: the value is
            // unrecoverable. Return null — never throw the ciphertext around.
            null
        }
    }

    override fun delete(key: String) {
        prefs.edit().remove(prefKey(key)).apply()
    }

    private fun generateKey() {
        try {
            val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER)
            generator.init(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(KEY_SIZE_BITS)
                    .build(),
            )
            generator.generateKey()
        } catch (e: Exception) {
            throw SecretStoreUnavailableError("unable to provision keystore key", e)
        }
    }

    private fun secretKey(): SecretKey {
        val entry = keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry
            ?: throw SecretStoreUnavailableError("keystore key entry missing")
        return entry.secretKey
    }

    private fun encrypt(value: String): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val ciphertext = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        // IV (12 bytes for GCM) is stored alongside the ciphertext; it is not secret.
        return cipher.iv + ciphertext
    }

    private fun decrypt(blob: ByteArray): String {
        if (blob.size <= IV_LENGTH) {
            throw SecretStoreUnavailableError("stored secret blob is truncated")
        }
        val iv = blob.copyOfRange(0, IV_LENGTH)
        val ciphertext = blob.copyOfRange(IV_LENGTH, blob.size)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(TAG_LENGTH_BITS, iv))
        return String(cipher.doFinal(ciphertext), Charsets.UTF_8)
    }

    private fun prefKey(key: String): String = "secret:$key"

    private companion object {
        const val PREFS_NAME = "neotavern_keystore_secrets"
        const val KEYSTORE_PROVIDER = "AndroidKeyStore"
        const val KEY_ALIAS = "neotavern_secret_key"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val KEY_SIZE_BITS = 256
        const val TAG_LENGTH_BITS = 128
        const val IV_LENGTH = 12
    }
}
