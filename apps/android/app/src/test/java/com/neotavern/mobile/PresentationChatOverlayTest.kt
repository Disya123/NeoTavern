package com.neotavern.mobile

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PresentationChatOverlayTest {
    @Test
    fun `character manager destroys native chat chrome`() {
        assertFalse(PresentationChatOverlay.attachNativeChrome(false))
    }

    @Test
    fun `chat route keeps native chat chrome`() {
        assertTrue(PresentationChatOverlay.attachNativeChrome(true))
    }
}
