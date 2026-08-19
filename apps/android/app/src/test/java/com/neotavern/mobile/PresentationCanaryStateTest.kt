package com.neotavern.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PresentationCanaryStateTest {

    @Test
    fun `explicit 0 disables even when the persisted flag is on`() {
        assertFalse(PresentationCanaryState.canaryFlag("0", true))
        assertFalse(PresentationCanaryState.canaryFlag(" 0 ", true))
    }

    @Test
    fun `explicit 1 enables even when persisted is off`() {
        assertTrue(PresentationCanaryState.canaryFlag("1", false))
    }

    @Test
    fun `absent extra uses the persisted flag and defaults off`() {
        assertTrue(PresentationCanaryState.canaryFlag(null, true))
        assertFalse(PresentationCanaryState.canaryFlag(null, false))
        assertFalse(PresentationCanaryState.canaryFlag("", false))
        assertTrue(PresentationCanaryState.canaryFlag("true", true))
        assertFalse(PresentationCanaryState.canaryFlag("true", false))
    }

    @Test
    fun `crash loop trips at three failed starts`() {
        assertFalse(PresentationCanaryState.crashLoop(0))
        assertFalse(PresentationCanaryState.crashLoop(2))
        assertTrue(PresentationCanaryState.crashLoop(3))
        assertEquals(1, PresentationCanaryState.incrementFailures(0))
        assertEquals(3, PresentationCanaryState.incrementFailures(2))
        assertEquals(3, PresentationCanaryState.incrementFailures(3))
    }
}
