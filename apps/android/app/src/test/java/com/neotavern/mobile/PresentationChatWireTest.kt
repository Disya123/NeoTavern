package com.neotavern.mobile

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PresentationChatWireTest {

    private class FakeNativeKernel : NativeKernel {
        val callEnvelopes = mutableListOf<String>()
        var nextCallResponse =
            """{"kind":"ok","requestId":"00000000-0000-4000-8000-000000000001","result":{"id":"00000000-0000-4000-8000-000000000002"}}"""
        var nextStreamHandle = 7L

        override fun handshake(): String = HANDSHAKE_JSON

        override fun open(dataRoot: String): Long = 1L

        override fun close(kernel: Long) {}

        override fun call(kernel: Long, request: ByteArray): ByteArray {
            callEnvelopes += String(request, Charsets.UTF_8)
            return nextCallResponse.toByteArray(Charsets.UTF_8)
        }

        override fun streamStart(kernel: Long, request: ByteArray): Long = nextStreamHandle

        override fun streamWait(stream: Long, timeoutMs: Int): ByteArray? = null

        override fun streamCancel(kernel: Long, stream: Long) {}

        override fun streamFree(stream: Long) {}
    }

    @Test
    fun `call wraps the payload in a request envelope and returns the response bytes`() {
        val fake = FakeNativeKernel()
        val session = KernelSession(fake, "/tmp/data")
        session.open()
        val wire = PresentationChatWire(session, EnvelopeBuilder.fromHandshake(HANDSHAKE_JSON))

        val bytes = wire.call("chats.get", """{"chatId":"7f3a2b4c-1d2e-4f5a-8b9c-0d1e2f3a4b5c"}""")
        val sent = JSONObject(fake.callEnvelopes.single())

        assertEquals("chats.get", sent.getString("operationId"))
        assertEquals(
            "7f3a2b4c-1d2e-4f5a-8b9c-0d1e2f3a4b5c",
            sent.getJSONObject("payload").getString("chatId"),
        )
        assertTrue(JSONObject(String(bytes, Charsets.UTF_8)).getString("kind") == "ok")
    }

    @Test
    fun `startStream uses the same envelope framing`() {
        val fake = FakeNativeKernel()
        val session = KernelSession(fake, "/tmp/data")
        session.open()
        val wire = PresentationChatWire(session, EnvelopeBuilder.fromHandshake(HANDSHAKE_JSON))

        val handle = wire.startStream(
            "generation.start",
            """{"chatId":"7f3a2b4c-1d2e-4f5a-8b9c-0d1e2f3a4b5c","message":"hi"}""",
        )

        assertEquals(7L, handle)
    }

    private companion object {
        const val HANDSHAKE_JSON =
            """{"ffiAbiVersion":1,"schemaHash":"0123456789abcdef","wireProtocol":{"major":1,"minor":0},"appVersion":"0.1.0-test"}"""
    }
}
