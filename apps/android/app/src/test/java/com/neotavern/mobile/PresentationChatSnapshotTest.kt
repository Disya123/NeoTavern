package com.neotavern.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PresentationChatSnapshotTest {

    @Test
    fun `non json status lines are not a snapshot`() {
        assertNull(
            PresentationChatSnapshot.parse(
                "chat_route=false dioxus_shell=false live_wire=false reason=flag_off",
            ),
        )
    }

    @Test
    fun `visible window and header come from the live route snapshot`() {
        val snap = PresentationChatSnapshot.parse(
            """
            {
              "chatId":"7f3a2b4c-1d2e-4f5a-8b9c-0d1e2f3a4b5c",
              "title":"Live wire chat",
              "messageCount":2,
              "composer":"draft",
              "error":null,
              "streaming":false,
              "visible":[
                {"id":"a","role":"user","content":"**hello**"},
                {"id":"b","role":"assistant","content":"![photo](asset:thumb)"}
              ]
            }
            """.trimIndent(),
        )
        requireNotNull(snap)
        assertEquals("7f3a2b4c-1d2e-4f5a-8b9c-0d1e2f3a4b5c", snap.chatId)
        assertEquals("Live wire chat (2)", snap.headerText())
        assertEquals("draft", snap.composer)
        assertFalse(snap.streaming)
        assertEquals(2, snap.visible.size)
        assertTrue(snap.rowsText().contains("user: **hello**"))
        assertTrue(snap.rowsText().contains("assistant: ![photo](asset:thumb)"))
    }

    @Test
    fun `streaming and error stay in the viewport text`() {
        val snap = PresentationChatSnapshot.parse(
            """{"title":"Chat","messageCount":1,"error":"WIRE_FAILED","streaming":true,"visible":[]}""",
        )
        requireNotNull(snap)
        assertTrue(snap.streaming)
        assertEquals("WIRE_FAILED", snap.error)
        assertTrue(snap.rowsText().contains("streaming"))
        assertTrue(snap.rowsText().contains("error: WIRE_FAILED"))
    }
}
