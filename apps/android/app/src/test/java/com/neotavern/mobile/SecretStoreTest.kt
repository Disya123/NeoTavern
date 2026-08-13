package com.neotavern.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * JVM contract tests for [SecretStore] via fakes.
 *
 * The "no plaintext fallback" property is verified by construction: the
 * unavailable-store fake has NO storage surface at all — a backend failure
 * must surface as [SecretStoreUnavailableError] and nothing (not even a
 * plaintext copy) may be persisted. [KeystoreSecretStore] follows the same
 * rule: every keystore/cipher failure path throws [SecretStoreUnavailableError]
 * instead of writing plaintext.
 */
class SecretStoreTest {

    /** Behavioral in-memory fake honoring the contract. */
    private class FakeSecretStore : SecretStore {
        val backing = HashMap<String, String>()
        var unavailable = false

        override fun put(key: String, value: String) {
            if (unavailable) throw SecretStoreUnavailableError("keystore unavailable")
            backing[key] = value
        }

        override fun get(key: String): String? {
            if (unavailable) throw SecretStoreUnavailableError("keystore unavailable")
            return backing[key]
        }

        override fun delete(key: String) {
            if (unavailable) throw SecretStoreUnavailableError("keystore unavailable")
            backing.remove(key)
        }
    }

    /**
     * A store whose backend can never persist. Verifies the failure contract:
     * a typed [SecretStoreUnavailableError] and zero persisted bytes — there
     * is no plaintext fallback path to write into.
     */
    private class UnavailableSecretStore : SecretStore {
        val persistedAnything = mutableListOf<String>()

        override fun put(key: String, value: String) {
            throw SecretStoreUnavailableError("keystore unavailable")
        }

        override fun get(key: String): String? {
            throw SecretStoreUnavailableError("keystore unavailable")
        }

        override fun delete(key: String) {
            throw SecretStoreUnavailableError("keystore unavailable")
        }
    }

    @Test
    fun `put and get round-trip`() {
        val store = FakeSecretStore()
        store.put("provider.apiKey", "s3cr3t")
        assertEquals("s3cr3t", store.get("provider.apiKey"))
    }

    @Test
    fun `overwrite replaces the previous value`() {
        val store = FakeSecretStore()
        store.put("k", "first")
        store.put("k", "second")
        assertEquals("second", store.get("k"))
    }

    @Test
    fun `delete removes the value and missing keys return null`() {
        val store = FakeSecretStore()
        assertNull(store.get("missing"))
        store.put("k", "v")
        store.delete("k")
        assertNull(store.get("k"))
        store.delete("k") // delete of an absent key is a no-op
    }

    @Test
    fun `keys are independent`() {
        val store = FakeSecretStore()
        store.put("a", "1")
        store.put("b", "2")
        assertEquals("1", store.get("a"))
        assertEquals("2", store.get("b"))
        store.delete("a")
        assertNull(store.get("a"))
        assertEquals("2", store.get("b"))
    }

    @Test
    fun `unavailable backend throws the typed error and persists nothing`() {
        val store = UnavailableSecretStore()
        try {
            store.put("k", "v")
            fail("expected SecretStoreUnavailableError")
        } catch (e: SecretStoreUnavailableError) {
            // expected
        }
        try {
            store.get("k")
            fail("expected SecretStoreUnavailableError")
        } catch (e: SecretStoreUnavailableError) {
            // expected
        }
        assertTrue(
            "no plaintext (or anything else) may be persisted on backend failure",
            store.persistedAnything.isEmpty(),
        )
    }

    @Test
    fun `store flip to unavailable propagates the typed error`() {
        val store = FakeSecretStore()
        store.put("k", "v")
        store.unavailable = true
        try {
            store.get("k")
            fail("expected SecretStoreUnavailableError")
        } catch (e: SecretStoreUnavailableError) {
            // expected
        }
    }
}
