package com.neotavern.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PresentationChatLaunchTest {

    @Test
    fun `blank extra keeps the Dioxus chat route disabled`() {
        assertFalse(PresentationChatLaunch.isFlagged(null))
        assertFalse(PresentationChatLaunch.isFlagged(""))
        assertFalse(PresentationChatLaunch.isFlagged("0"))
        assertFalse(PresentationChatLaunch.isFlagged("true"))
        assertEquals("", PresentationChatLaunch.parseFlag(null))
    }

    @Test
    fun `only the explicit 1 extra enables the flagged chat route`() {
        assertTrue(PresentationChatLaunch.isFlagged("1"))
        assertTrue(PresentationChatLaunch.isFlagged(" 1 "))
        assertFalse(PresentationChatLaunch.isFlagged("NEOTA_DIOXUS_SHELL=1"))
    }
}
