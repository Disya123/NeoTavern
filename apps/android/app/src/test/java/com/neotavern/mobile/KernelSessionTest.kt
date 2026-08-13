package com.neotavern.mobile

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * JVM tests for the [KernelSession] state machine over a fake [NativeKernel]
 * — no android.* involved.
 */
class KernelSessionTest {

    private class FakeNativeKernel(
        private val openFailure: KernelException? = null,
        private val handshakeJson: String = HANDSHAKE_JSON,
    ) : NativeKernel {
        var opened = 0
        var closed = 0
        var freed = mutableListOf<Long>()
        var cancelled = mutableListOf<Long>()
        val callEnvelopes = mutableListOf<String>()
        var nextCallResponse = RESPONSE_OK
        var callFailure: KernelException? = null
        val streamStartEnvelopes = mutableListOf<String>()
        var streamStartFailure: KernelException? = null
        var nextStreamHandle = 100L
        var streamWaitResults = ArrayDeque<ByteArray?>()
        var streamWaitFailure: KernelException? = null

        override fun handshake(): String = handshakeJson

        override fun open(dataRoot: String): Long {
            openFailure?.let { throw it }
            opened++
            return 42L
        }

        override fun close(kernel: Long) {
            closed++
        }

        override fun call(kernel: Long, request: ByteArray): ByteArray {
            callEnvelopes += String(request, Charsets.UTF_8)
            callFailure?.let { throw it }
            return nextCallResponse.toByteArray(Charsets.UTF_8)
        }

        override fun streamStart(kernel: Long, request: ByteArray): Long {
            streamStartEnvelopes += String(request, Charsets.UTF_8)
            streamStartFailure?.let { throw it }
            return nextStreamHandle++
        }

        override fun streamWait(stream: Long, timeoutMs: Int): ByteArray? {
            streamWaitFailure?.let { throw it }
            return streamWaitResults.removeFirstOrNull()
        }

        override fun streamCancel(kernel: Long, stream: Long) {
            cancelled += stream
        }

        override fun streamFree(stream: Long) {
            freed += stream
        }
    }

    @Test
    fun `state machine transitions closed to open`() {
        val fake = FakeNativeKernel()
        val session = KernelSession(fake, "/tmp/data")
        assertEquals(KernelSessionState.CLOSED, session.currentState)
        assertFalse(session.isOpen)

        session.open()

        assertEquals(KernelSessionState.OPEN, session.currentState)
        assertTrue(session.isOpen)
        assertEquals(1, fake.opened)
    }

    @Test
    fun `call before open throws StateError`() {
        val fake = FakeNativeKernel()
        val session = KernelSession(fake, "/tmp/data")

        try {
            session.callEnvelope("{}")
            fail("expected SessionError.StateError")
        } catch (e: SessionError.StateError) {
            assertEquals(KernelSessionState.CLOSED, e.state)
            assertTrue(e.message.orEmpty().contains("call"))
        }
        assertTrue(fake.callEnvelopes.isEmpty())
    }

    @Test
    fun `open is idempotent`() {
        val fake = FakeNativeKernel()
        val session = KernelSession(fake, "/tmp/data")
        session.open()
        session.open()
        assertEquals(1, fake.opened)
        assertEquals(KernelSessionState.OPEN, session.currentState)
    }

    @Test
    fun `double close is idempotent and frees streams`() {
        val fake = FakeNativeKernel()
        val session = KernelSession(fake, "/tmp/data")
        session.open()
        val stream = session.startStream("""{"operationId":"generation.start"}""")

        session.close()
        session.close()

        assertEquals(1, fake.closed)
        assertEquals(listOf(stream), fake.freed)
        assertEquals(KernelSessionState.CLOSED, session.currentState)
    }

    @Test
    fun `close releases every registered stream before the kernel`() {
        val fake = FakeNativeKernel()
        val session = KernelSession(fake, "/tmp/data")
        session.open()
        val s1 = session.startStream("{}")
        val s2 = session.startStream("{}")

        session.close()

        assertEquals(listOf(s1, s2), fake.freed.sorted())
        assertEquals(1, fake.closed)
    }

    @Test
    fun `handshake parses to handshake fields`() {
        val fake = FakeNativeKernel()
        val session = KernelSession(fake, "/tmp/data")
        session.open()

        val handshake = JSONObject(session.handshake())

        assertEquals(1, handshake.getInt("ffiAbiVersion"))
        val schemaHash = handshake.getString("schemaHash")
        assertTrue(schemaHash.isNotBlank())
        val wire = handshake.getJSONObject("wireProtocol")
        assertEquals(1, wire.getInt("major"))
        assertEquals(0, wire.getInt("minor"))
        assertEquals("0.1.0-test", handshake.getString("appVersion"))
    }

    @Test
    fun `call round-trips the request envelope bytes and returns the response`() {
        val fake = FakeNativeKernel()
        fake.nextCallResponse = """{"kind":"ok","requestId":"req-9","result":{"ok":true}}"""
        val session = KernelSession(fake, "/tmp/data")
        session.open()

        val envelope = """{"wireProtocol":{"major":1,"minor":0},"schemaHash":"abc","requestId":"req-9","operationId":"meta.get","payload":{}}"""
        val response = session.callEnvelope(envelope)

        assertEquals(listOf(envelope), fake.callEnvelopes)
        assertEquals("""{"kind":"ok","requestId":"req-9","result":{"ok":true}}""", response)
    }

    @Test
    fun `call after close throws StateError`() {
        val fake = FakeNativeKernel()
        val session = KernelSession(fake, "/tmp/data")
        session.open()
        session.close()

        try {
            session.callEnvelope("{}")
            fail("expected SessionError.StateError")
        } catch (e: SessionError.StateError) {
            assertEquals(KernelSessionState.CLOSED, e.state)
        }
    }

    @Test
    fun `open failure surfaces as OpenFailed and returns to closed`() {
        val fake = FakeNativeKernel(openFailure = KernelException(8, "schema mismatch"))
        val session = KernelSession(fake, "/tmp/data")

        try {
            session.open()
            fail("expected SessionError.OpenFailed")
        } catch (e: SessionError.OpenFailed) {
            assertEquals(8, e.code)
        }
        assertEquals(KernelSessionState.CLOSED, session.currentState)
        assertEquals(0, fake.opened)
    }

    @Test
    fun `native call failure surfaces as KernelCallFailed`() {
        val fake = FakeNativeKernel()
        fake.callFailure = KernelException(6, "internal")
        val session = KernelSession(fake, "/tmp/data")
        session.open()

        try {
            session.callEnvelope("{}")
            fail("expected SessionError.KernelCallFailed")
        } catch (e: SessionError.KernelCallFailed) {
            assertEquals(6, e.code)
        }
    }

    @Test
    fun `stream wait returns payloads and null on timeout`() {
        val fake = FakeNativeKernel()
        fake.streamWaitResults.add(null)
        fake.streamWaitResults.add("""{"kind":"event","event":{"streamId":"s1","sequence":1,"type":"delta","payload":{}}}""".toByteArray())
        val session = KernelSession(fake, "/tmp/data")
        session.open()
        val stream = session.startStream("{}")

        assertNull(session.waitEvent(stream, 200))
        val payload = session.waitEvent(stream, 200)
        assertEquals(
            """{"kind":"event","event":{"streamId":"s1","sequence":1,"type":"delta","payload":{}}}""",
            String(payload!!, Charsets.UTF_8),
        )
    }

    @Test
    fun `waitEvent on unknown stream throws UnknownStream`() {
        val fake = FakeNativeKernel()
        val session = KernelSession(fake, "/tmp/data")
        session.open()
        session.startStream("{}")

        try {
            session.waitEvent(999L, 200)
            fail("expected SessionError.UnknownStream")
        } catch (e: SessionError.UnknownStream) {
            assertEquals(999L, e.stream)
        }
    }

    @Test
    fun `cancelStream is idempotent and ignores unknown streams`() {
        val fake = FakeNativeKernel()
        val session = KernelSession(fake, "/tmp/data")
        session.open()
        val stream = session.startStream("{}")

        session.cancelStream(stream)
        session.cancelStream(stream) // repeated cancel is a no-op at the session level
        session.cancelStream(12345L) // unknown stream is ignored

        assertEquals(listOf(stream, stream), fake.cancelled)
    }

    @Test
    fun `streams stay registered until close`() {
        val fake = FakeNativeKernel()
        val session = KernelSession(fake, "/tmp/data")
        session.open()
        val stream = session.startStream("{}")
        assertTrue(fake.freed.isEmpty())

        session.close()

        assertEquals(listOf(stream), fake.freed)
    }

    @Test
    fun `stream start failure surfaces as KernelCallFailed`() {
        val fake = FakeNativeKernel()
        fake.streamStartFailure = KernelException(3, "chat not found")
        val session = KernelSession(fake, "/tmp/data")
        session.open()

        try {
            session.startStream("{}")
            fail("expected SessionError.KernelCallFailed")
        } catch (e: SessionError.KernelCallFailed) {
            assertEquals(3, e.code)
        }
    }

    @Test
    fun `handshake is allowed before open`() {
        val fake = FakeNativeKernel()
        val session = KernelSession(fake, "/tmp/data")
        assertTrue(JSONObject(session.handshake()).getString("schemaHash").isNotBlank())
    }

    private companion object {
        const val HANDSHAKE_JSON =
            """{"ffiAbiVersion":1,"schemaHash":"0123456789abcdef","wireProtocol":{"major":1,"minor":0},"appVersion":"0.1.0-test"}"""
        const val RESPONSE_OK = """{"kind":"ok","requestId":"req-1","result":{}}"""
    }
}
