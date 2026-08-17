package com.neotavern.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DisplayRefreshPolicyTest {

    private fun mode(id: Int, hz: Float, width: Int = 1080, height: Int = 2400) =
        DisplayRefreshPolicy.Mode(id, hz, width, height)

    @Test
    fun `empty mode list requests nothing`() {
        val current = mode(1, 60f)
        val decision = DisplayRefreshPolicy.chooseHighestRefresh(emptyList(), current)
        assertNull(decision.requestedModeId)
        assertEquals("no-modes", decision.reason)
    }

    @Test
    fun `picks 120 Hz at the same physical size`() {
        val current = mode(1, 60f)
        val decision = DisplayRefreshPolicy.chooseHighestRefresh(
            listOf(current, mode(2, 120f), mode(3, 90f)),
            current,
        )
        assertEquals(2, decision.requestedModeId)
        assertEquals(120f, decision.requestedRefreshHz)
        assertEquals("higher-refresh", decision.reason)
        assertEquals(listOf(60f, 90f, 120f), decision.supportedRatesHz)
    }

    @Test
    fun `ignores a higher rate at a different resolution`() {
        val current = mode(1, 60f, 1080, 2400)
        val otherPanel = mode(9, 120f, 1440, 3200)
        val decision = DisplayRefreshPolicy.chooseHighestRefresh(
            listOf(current, otherPanel),
            current,
        )
        assertEquals(1, decision.requestedModeId)
        assertEquals("already-max", decision.reason)
    }

    @Test
    fun `keeps current id when it is already the max rate`() {
        val current = mode(4, 120f)
        val decision = DisplayRefreshPolicy.chooseHighestRefresh(
            listOf(mode(1, 60f), current),
            current,
        )
        assertEquals(4, decision.requestedModeId)
        assertEquals("already-max", decision.reason)
    }

    @Test
    fun `falls back to current when no mode matches the panel size`() {
        val current = mode(1, 60f, 1080, 2400)
        val decision = DisplayRefreshPolicy.chooseHighestRefresh(
            listOf(mode(2, 120f, 720, 1600)),
            current,
        )
        assertEquals(1, decision.requestedModeId)
        assertEquals("no-matching-resolution", decision.reason)
    }
}
