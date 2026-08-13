package com.neotavern.mobile

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM tests for the pure [ExtensionAvailability] probe (ТЗ §51, §86, §90,
 * §92) — no android.* imports anywhere in this test or the class under
 * test, matching the [CallbackFrame]/[JsEscaping] pattern.
 *
 * The probe is the single source of truth for the Android extension
 * surface: themes available (trusted built-in + declarative), plugins
 * declarative-only, no Node runtime, no arbitrary third-party JS in the
 * WebView. The web UI reads it as
 * `window.__neotavernMobile.extensionsAvailability()`.
 */
class ExtensionAvailabilityTest {

    /** The frozen probe contract — any change here is a breaking contract change. */
    private val frozenProbeJson =
        """{"themes":true,"plugins":"declarative-only","nodeRuntime":false,"arbitraryJsInWebView":false}"""

    @Test
    fun `probe JSON is byte-identical to the frozen contract`() {
        assertEquals(frozenProbeJson, ExtensionAvailability.JSON)
    }

    @Test
    fun `probe JSON declares the Android extension posture`() {
        // Byte-compare covers shape and values exactly; re-parsing proves the
        // constant is also well-formed JSON with the declared semantics.
        val probe = JSONObject(ExtensionAvailability.JSON)
        assertTrue("themes available", probe.getBoolean("themes"))
        assertEquals("plugins declarative-only", "declarative-only", probe.getString("plugins"))
        assertFalse("no local Node runtime", probe.getBoolean("nodeRuntime"))
        assertFalse("no arbitrary JS in the WebView", probe.getBoolean("arbitraryJsInWebView"))
    }
}
