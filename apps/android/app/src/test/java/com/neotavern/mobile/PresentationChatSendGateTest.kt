package com.neotavern.mobile

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PresentationChatSendGateTest {

    @Test
    fun `a second callback is coalesced until end`() {
        val gate = PresentationChatSendGate()
        assertTrue(gate.tryBegin())
        assertTrue(gate.inFlight)
        assertFalse(gate.tryBegin())
        gate.end()
        assertTrue(gate.tryBegin())
        gate.end()
    }
}
