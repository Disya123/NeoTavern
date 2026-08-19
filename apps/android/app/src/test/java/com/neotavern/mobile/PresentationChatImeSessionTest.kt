package com.neotavern.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PresentationChatImeSessionTest {

    @Test
    fun `MockIme drives composing cursor delete commit and SEND`() {
        val session = PresentationChatImeSession()
        PresentationChatMockIme.typeWordDeleteAndSend(session)
        val blob = session.events.joinToString("\n")
        assertTrue(blob.contains("setComposingText"))
        assertTrue(blob.contains("deleteSurroundingText"))
        assertTrue(blob.contains("commitText"))
        assertTrue(blob.contains("performEditorAction code=SEND"))
        assertTrue(session.corpusProven())
        assertEquals(1, session.sendCount)
        assertEquals("hello", session.text)
    }

    @Test
    fun `physical Gboard commitText-only is not this conformance corpus`() {
        val session = PresentationChatImeSession()
        session.commitText("a", 1)
        session.deleteSurroundingText(1, 0)
        session.commitText("b", 1)
        session.performEditorAction(PresentationChatJourneyMarkers.EDITOR_ACTION_SEND)
        assertEquals(false, session.corpusProven())
    }
}
