package com.neotavern.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PresentationRendererPolicyTest {

    private val canaryReady = PresentationRendererPolicy.Inputs(
        safeMode = false,
        killSwitch = false,
        crashLoop = false,
        touchExplorationEnabled = false,
        deviceQualified = true,
        canaryFlag = true,
    )

    @Test
    fun `touch exploration selects WebView before any Rust host`() {
        var rustHostCreated = false
        val decision = PresentationRendererPolicy.select(
            canaryReady.copy(touchExplorationEnabled = true),
        ) {
            rustHostCreated = true
        }
        assertEquals(PresentationRendererPolicy.Renderer.WEBVIEW, decision.renderer)
        assertEquals(PresentationRendererPolicy.REASON_TOUCH_EXPLORATION, decision.reason)
        assertFalse(decision.rustHostAllowed)
        assertFalse(rustHostCreated)
        assertEquals(
            "presentation_renderer=WEBVIEW reason=accessibility_touch_exploration rust_host_allowed=false",
            PresentationRendererPolicy.logLine(decision),
        )
    }

    @Test
    fun `canary on a qualified device without a11y may create the Rust host`() {
        var rustHostCreated = false
        val decision = PresentationRendererPolicy.select(canaryReady) {
            rustHostCreated = true
        }
        assertEquals(PresentationRendererPolicy.Renderer.DIOXUS, decision.renderer)
        assertTrue(decision.rustHostAllowed)
        assertTrue(rustHostCreated)
    }

    @Test
    fun `safe mode kill switch crash loop unqualified and flag off stay on WebView`() {
        val blockers = listOf(
            canaryReady.copy(safeMode = true) to PresentationRendererPolicy.REASON_SAFE_MODE,
            canaryReady.copy(killSwitch = true) to PresentationRendererPolicy.REASON_KILL_SWITCH,
            canaryReady.copy(crashLoop = true) to PresentationRendererPolicy.REASON_CRASH_LOOP,
            canaryReady.copy(deviceQualified = false) to PresentationRendererPolicy.REASON_UNQUALIFIED,
            canaryReady.copy(canaryFlag = false) to PresentationRendererPolicy.REASON_FLAG_OFF,
        )
        for ((inputs, reason) in blockers) {
            var rustHostCreated = false
            val decision = PresentationRendererPolicy.select(inputs) { rustHostCreated = true }
            assertEquals(reason, decision.reason)
            assertFalse(decision.rustHostAllowed)
            assertFalse(rustHostCreated)
        }
    }
}
