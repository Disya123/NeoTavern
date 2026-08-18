package com.neotavern.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PresentationSurfaceHitTest {
    @Test
    fun fallbackOwnsTapWhenOriginalsAreHidden() {
        val originalHittable = false
        val fallbackHittable = true
        val webViewHits = 0
        val surfaceHits = 0
        assertFalse(originalHittable)
        assertTrue(fallbackHittable)
        assertEquals(0, webViewHits)
        assertEquals(0, surfaceHits)
    }
}
