package com.neotavern.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM tests for the [NotificationState] constants and stream-state label
 * mapping.
 */
class NotificationStateTest {

    @Test
    fun `constants match the contract`() {
        assertEquals("neotavern_generation", NotificationState.CHANNEL_ID)
        assertEquals("Generation", NotificationState.CHANNEL_NAME)
        assertEquals("com.neotavern.mobile.action.STOP_GENERATION", NotificationState.ACTION_STOP)
        assertEquals(1001, NotificationState.NOTIFICATION_ID)
    }

    @Test
    fun `known stream kinds map to non-null labels`() {
        assertEquals("Generating", NotificationState.titleForStreamState("event"))
        assertEquals("Complete", NotificationState.titleForStreamState("terminal"))
        assertEquals("Failed", NotificationState.titleForStreamState("error"))
    }

    @Test
    fun `unknown stream kinds map to null`() {
        assertNull(NotificationState.titleForStreamState("bogus"))
        assertNull(NotificationState.titleForStreamState(""))
        assertNull(NotificationState.titleForStreamState("EVENT")) // case-sensitive
    }

    @Test
    fun `terminal detection covers terminal and error only`() {
        assertTrue(NotificationState.isTerminal("terminal"))
        assertTrue(NotificationState.isTerminal("error"))
        assertFalse(NotificationState.isTerminal("event"))
        assertFalse(NotificationState.isTerminal("bogus"))
        assertFalse(NotificationState.isTerminal(""))
    }
}
