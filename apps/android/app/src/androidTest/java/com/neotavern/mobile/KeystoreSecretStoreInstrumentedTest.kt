package com.neotavern.mobile

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On-device Keystore round-trip (M6). JVM [SecretStoreTest] covers the
 * contract with fakes; this test exercises [KeystoreSecretStore] against
 * the real AndroidKeyStore on the emulator/device.
 */
@RunWith(AndroidJUnit4::class)
class KeystoreSecretStoreInstrumentedTest {

    @Test
    fun putGetDelete_roundTrip_doesNotLeavePlaintextInPrefs() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val store = KeystoreSecretStore(context)
        val key = "instrumented.provider.apiKey"

        store.delete(key)
        assertNull(store.get(key))

        store.put(key, "s3cr3t-value")
        assertEquals("s3cr3t-value", store.get(key))

        val prefs = context.getSharedPreferences("neotavern_keystore_secrets", 0)
        val stored = prefs.all.values.joinToString()
        assertTrue("plaintext must not appear in prefs", !stored.contains("s3cr3t-value"))

        store.delete(key)
        assertNull(store.get(key))
    }
}
