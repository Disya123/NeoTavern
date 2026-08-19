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

    @Test
    fun `chat id extra is trimmed and blank stays empty`() {
        assertEquals("", PresentationChatLaunch.parseChatId(null))
        assertEquals("", PresentationChatLaunch.parseChatId("  "))
        assertEquals(
            "7f3a2b4c-1d2e-4f5a-8b9c-0d1e2f3a4b5c",
            PresentationChatLaunch.parseChatId(" 7f3a2b4c-1d2e-4f5a-8b9c-0d1e2f3a4b5c "),
        )
    }

    @Test
    fun `safe mode extra is the explicit 1 value`() {
        assertFalse(PresentationChatLaunch.isSafeMode(null))
        assertFalse(PresentationChatLaunch.isSafeMode("true"))
        assertTrue(PresentationChatLaunch.isSafeMode("1"))
    }

    @Test
    fun `canary extras are explicit 1 values and 0 is flag off`() {
        assertTrue(PresentationChatLaunch.isForceInitFailure("1"))
        assertFalse(PresentationChatLaunch.isForceInitFailure(null))
        assertTrue(PresentationChatLaunch.isCanarySession("1"))
        assertTrue(PresentationChatLaunch.isCanaryReset("1"))
        assertTrue(PresentationChatLaunch.isFlagOff("0"))
        assertFalse(PresentationChatLaunch.isFlagOff("1"))
        assertFalse(PresentationChatLaunch.isFlagOff(null))
    }

    @Test
    fun `isolated 10k profile is an explicit extra`() {
        assertFalse(PresentationChatLaunch.isIsolated10k(null))
        assertFalse(PresentationChatLaunch.isIsolated10k("10k"))
        assertTrue(PresentationChatLaunch.isIsolated10k("isolated-10k"))
        assertEquals(
            PresentationChatLaunch.PROFILE_ISOLATED_10K,
            PresentationChatLaunch.parseProfile(" isolated-10k "),
        )
    }
}
