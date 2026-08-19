package com.neotavern.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PresentationChatJourneyMarkersTest {

    @Test
    fun `ime markers log lengths and actions never bodies`() {
        val composing = PresentationChatJourneyMarkers.ic(
            "setComposingText",
            "len=4 cursor=4 composing=true",
            3,
        )
        assertEquals(
            "gboard_ic action=setComposingText len=4 cursor=4 composing=true epoch=3 production_cutover=false",
            composing,
        )
        assertFalse(composing.contains("hello"))
        assertEquals(200, PresentationChatJourneyMarkers.MIN_IME_INSET_PX)
        assertEquals("SEND", PresentationChatJourneyMarkers.editorActionCode(4))
        assertEquals("2", PresentationChatJourneyMarkers.editorActionCode(2))
    }

    @Test
    fun `talkback markers are node ids and event types`() {
        val focus = PresentationChatJourneyMarkers.talkback(
            "event=TYPE_VIEW_ACCESSIBILITY_FOCUSED node=header nodeId=12",
            8,
        )
        val announce = PresentationChatJourneyMarkers.announce("stream_begin", "messages", 9)
        assertTrue(focus.contains("node=header"))
        assertTrue(focus.contains("nodeId=12"))
        assertFalse(focus.contains("Hazel"))
        assertEquals(
            "a11y_announce kind=stream_begin node=messages epoch=9 production_cutover=false",
            announce,
        )
    }
}
