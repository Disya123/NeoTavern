package com.neotavern.mobile

import java.nio.charset.StandardCharsets

/** Lifecycle states of a [KernelSession]. */
enum class KernelSessionState {
    /** No kernel is open. `open()` may be called. */
    CLOSED,

    /** `open()` is executing the native kernel open. */
    OPENING,

    /** The kernel handle is live; calls, streams and close are allowed. */
    OPEN,

    /** `close()` is draining streams and releasing the kernel. */
    CLOSING,
}

/**
 * Typed failure of a [KernelSession] operation. Product-level failures are
 * never represented here — they travel as `kind:"error"` response envelopes
 * and are returned to the caller as data.
 */
sealed class SessionError(message: String, cause: Throwable? = null) : Exception(message, cause) {

    /** The operation is not allowed in the current session state. */
    class StateError(val state: KernelSessionState, operation: String) :
        SessionError("$operation is not allowed while the kernel session is $state")

    /** The native kernel could not be opened ([KernelException] from the JNI layer). */
    class OpenFailed(val code: Int, message: String, cause: Throwable?) :
        SessionError("kernel open failed (native code $code): $message", cause)

    /** A native kernel operation threw [KernelException] at the ABI boundary. */
    class KernelCallFailed(val code: Int, message: String, cause: Throwable?) :
        SessionError("native kernel operation failed (code $code): $message", cause)

    /** The native stream start returned a null handle (0). */
    class StreamStartFailed(val code: Int, message: String, cause: Throwable?) :
        SessionError("native stream start failed (code $code): $message", cause)

    /** The stream handle is not registered with this session. */
    class UnknownStream(val stream: Long) :
        SessionError("stream $stream is not registered with this session")
}

/**
 * PURE Kotlin state machine around a [NativeKernel] — no android.* imports,
 * fully JVM-testable with a fake kernel.
 *
 * Lifecycle: `CLOSED → OPENING → OPEN → CLOSING → CLOSED`.
 *
 * - [open] is idempotent: calling it while already `OPEN` is a no-op.
 * - [close] is idempotent: closing an already-closed session is a no-op, and
 *   it always releases every registered stream handle before releasing the
 *   kernel (the streams registry is freed on close).
 * - [cancelStream] is idempotent: cancelling an unknown or already-released
 *   stream is a no-op.
 * - [handshake] is stateless on the native side and allowed in any state.
 * - Every state transition and registry mutation is guarded by a single lock,
 *   so the bridge may drive the session from one background executor without
 *   interleaving.
 *
 * All payloads crossing the boundary are the serialized wire envelopes
 * (byte-identical to the TauriTransport request envelope): a call accepts the
 * request envelope JSON and returns the response envelope JSON; a stream
 * accepts the request envelope JSON and yields raw notice payload bytes via
 * [waitEvent] (null = timeout).
 */
class KernelSession(private val native: NativeKernel, private val dataRoot: String) {

    private val lock = Any()

    private var state: KernelSessionState = KernelSessionState.CLOSED
    private var kernelHandle: Long = 0L

    /** Opaque native stream handles opened through this session. */
    private val streams = HashSet<Long>()

    /** The current lifecycle state (thread-safe snapshot). */
    val currentState: KernelSessionState
        get() = synchronized(lock) { state }

    /** Whether the session is in the `OPEN` state. */
    val isOpen: Boolean
        get() = synchronized(lock) { state == KernelSessionState.OPEN }

    /**
     * Opens the kernel over the session data root.
     *
     * Idempotent: no-op when already open. Throws [SessionError.StateError]
     * if called while opening/closing, or [SessionError.OpenFailed] when the
     * native layer rejects the open.
     */
    fun open() {
        synchronized(lock) {
            when (state) {
                KernelSessionState.OPEN -> return
                KernelSessionState.OPENING, KernelSessionState.CLOSING ->
                    throw SessionError.StateError(state, "open")
                KernelSessionState.CLOSED -> Unit
            }
            state = KernelSessionState.OPENING
            val handle = try {
                native.open(dataRoot)
            } catch (e: KernelException) {
                state = KernelSessionState.CLOSED
                throw SessionError.OpenFailed(e.code, e.message ?: "open rejected", e)
            }
            if (handle == 0L) {
                state = KernelSessionState.CLOSED
                throw SessionError.OpenFailed(0, "native open returned a null handle", null)
            }
            kernelHandle = handle
            state = KernelSessionState.OPEN
        }
    }

    /**
     * Returns the native kernel handshake JSON (see [NativeKernel.handshake]).
     * Stateless — allowed in any session state.
     */
    fun handshake(): String = try {
        native.handshake()
    } catch (e: KernelException) {
        throw SessionError.KernelCallFailed(e.code, e.message ?: "handshake failed", e)
    }

    /**
     * Executes one unary wire operation. `envelopeJson` must be the serialized
     * `wire.request.envelope` (wireProtocol, schemaHash, requestId v4,
     * operationId, payload). Returns the serialized response envelope JSON,
     * which the caller forwards verbatim (ok envelope or product-error
     * envelope — never a thrown product error).
     *
     * @throws SessionError.StateError when the session is not open
     * @throws SessionError.KernelCallFailed on ABI-level failure
     */
    fun callEnvelope(envelopeJson: String): String {
        val handle = requireOpen("call")
        val response = try {
            native.call(handle, envelopeJson.toByteArray(StandardCharsets.UTF_8))
        } catch (e: KernelException) {
            throw SessionError.KernelCallFailed(e.code, e.message ?: "call failed", e)
        }
        return String(response, StandardCharsets.UTF_8)
    }

    /**
     * Opens a durable stream for a workflow operation (`generation.start`,
     * `generation.retry`). `envelopeJson` is the request envelope JSON.
     * Returns the opaque native stream handle, registered in the session
     * registry until [close] frees it.
     */
    fun startStream(envelopeJson: String): Long {
        val handle = requireOpen("startStream")
        val stream = try {
            native.streamStart(handle, envelopeJson.toByteArray(StandardCharsets.UTF_8))
        } catch (e: KernelException) {
            throw SessionError.KernelCallFailed(e.code, e.message ?: "stream start failed", e)
        }
        if (stream == 0L) {
            throw SessionError.StreamStartFailed(0, "native stream start returned a null handle", null)
        }
        synchronized(lock) {
            if (state != KernelSessionState.OPEN) {
                // Session closed while the native call was in flight (defensive).
                native.streamFree(stream)
                throw SessionError.StateError(state, "startStream")
            }
            streams.add(stream)
        }
        return stream
    }

    /**
     * Waits up to `timeoutMs` for the next notice of `stream`; returns the
     * payload bytes or `null` on timeout.
     *
     * @throws SessionError.StateError when the session is not open
     * @throws SessionError.UnknownStream when the handle is not registered
     */
    fun waitEvent(stream: Long, timeoutMs: Int): ByteArray? {
        requireOpen("waitEvent")
        synchronized(lock) {
            if (stream !in streams) throw SessionError.UnknownStream(stream)
        }
        return try {
            native.streamWait(stream, timeoutMs)
        } catch (e: KernelException) {
            throw SessionError.KernelCallFailed(e.code, e.message ?: "stream wait failed", e)
        }
    }

    /**
     * Requests cancellation of the run behind `stream`. Idempotent: unknown
     * streams and non-open sessions are no-ops. The native handle stays
     * registered until the session closes (cancel is not free).
     */
    fun cancelStream(stream: Long) {
        synchronized(lock) {
            if (state != KernelSessionState.OPEN) return
            if (stream !in streams) return
            val handle = kernelHandle
            try {
                native.streamCancel(handle, stream)
            } catch (e: KernelException) {
                throw SessionError.KernelCallFailed(e.code, e.message ?: "stream cancel failed", e)
            }
        }
    }

    /**
     * Closes the session: frees every registered stream handle, then closes
     * the kernel (releasing the data-root lease). Idempotent — closing an
     * already-closed session is a no-op.
     */
    fun close() {
        synchronized(lock) {
            when (state) {
                KernelSessionState.CLOSED, KernelSessionState.CLOSING -> return
                KernelSessionState.OPENING -> return
                KernelSessionState.OPEN -> Unit
            }
            state = KernelSessionState.CLOSING
            for (stream in streams) {
                try {
                    native.streamFree(stream)
                } catch (e: KernelException) {
                    // Best-effort drain: one bad handle must not block the rest.
                }
            }
            streams.clear()
            val handle = kernelHandle
            kernelHandle = 0L
            try {
                native.close(handle)
            } catch (e: KernelException) {
                // The kernel handle is being released regardless; surface the
                // failure to the caller but finish the transition to CLOSED.
                state = KernelSessionState.CLOSED
                throw SessionError.KernelCallFailed(e.code, e.message ?: "close failed", e)
            }
            state = KernelSessionState.CLOSED
        }
    }

    /** Returns the kernel handle while open, otherwise throws [SessionError.StateError]. */
    private fun requireOpen(operation: String): Long = synchronized(lock) {
        if (state != KernelSessionState.OPEN) {
            throw SessionError.StateError(state, operation)
        }
        kernelHandle
    }
}
