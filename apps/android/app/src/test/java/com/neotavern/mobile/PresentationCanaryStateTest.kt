package com.neotavern.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PresentationCanaryStateTest {

    @Test
    fun `debug extra 0 disables even when the persisted flag is on`() {
        assertFalse(PresentationCanaryState.canaryFlag("0", true, extraTrusted = true))
        assertFalse(PresentationCanaryState.canaryFlag(" 0 ", true, extraTrusted = true))
        assertEquals(false, PresentationCanaryState.persistFromExtra("0", extraTrusted = true))
    }

    @Test
    fun `debug extra 1 enables even when persisted is off`() {
        assertTrue(PresentationCanaryState.canaryFlag("1", false, extraTrusted = true))
        assertEquals(true, PresentationCanaryState.persistFromExtra("1", extraTrusted = true))
    }

    @Test
    fun `debug launcher without extra uses the persisted opt-in`() {
        assertTrue(PresentationCanaryState.canaryFlag(null, true, extraTrusted = true))
        assertFalse(PresentationCanaryState.canaryFlag(null, false, extraTrusted = true))
        assertFalse(PresentationCanaryState.canaryFlag("", false, extraTrusted = true))
        assertTrue(PresentationCanaryState.canaryFlag("true", true, extraTrusted = true))
        assertFalse(PresentationCanaryState.canaryFlag("true", false, extraTrusted = true))
        assertNull(PresentationCanaryState.persistFromExtra(null, extraTrusted = true))
        assertNull(PresentationCanaryState.persistFromExtra("", extraTrusted = true))
    }

    @Test
    fun `release ignores extras and waits for signed rollout`() {
        assertFalse(PresentationCanaryState.extrasTrusted(debuggable = false))
        assertTrue(PresentationCanaryState.extrasTrusted(debuggable = true))
        assertFalse(PresentationCanaryState.canaryFlag("1", false, extraTrusted = false))
        assertFalse(PresentationCanaryState.canaryFlag("1", true, extraTrusted = false))
        assertFalse(PresentationCanaryState.canaryFlag("0", true, extraTrusted = false))
        assertFalse(PresentationCanaryState.canaryFlag(null, true, extraTrusted = false))
        assertTrue(
            PresentationCanaryState.canaryFlag(
                extra = "1",
                persisted = false,
                extraTrusted = false,
                signedRollout = true,
            ),
        )
        assertNull(PresentationCanaryState.persistFromExtra("1", extraTrusted = false))
        assertNull(PresentationCanaryState.persistFromExtra("0", extraTrusted = false))
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
