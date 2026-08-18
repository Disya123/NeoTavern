package com.neotavern.mobile

import java.nio.charset.StandardCharsets

/**
 * Payload-level Product Wire host for the flagged Dioxus chat route.
 *
 * Builds request envelopes with [EnvelopeBuilder] and executes them on an
 * already-open [KernelSession]. Presentation Rust never opens the kernel or
 * SQLite. PURE Kotlin (no android.*) so JVM tests can cover the envelope
 * path.
 */
class PresentationChatWire(
    private val session: KernelSession,
    private val envelopes: EnvelopeBuilder,
) {
    fun call(operationId: String, payloadJson: String): ByteArray {
        val envelope = envelopes.request(envelopes.newRequestId(), operationId, payloadJson)
        return session.callEnvelope(envelope).toByteArray(StandardCharsets.UTF_8)
    }

    fun startStream(operationId: String, payloadJson: String): Long {
        val envelope = envelopes.request(envelopes.newRequestId(), operationId, payloadJson)
        return session.startStream(envelope)
    }

    fun waitEvent(stream: Long, timeoutMs: Int): ByteArray? {
        return session.waitEvent(stream, timeoutMs)
    }

    fun cancelStream(stream: Long) {
        session.cancelStream(stream)
    }
}
