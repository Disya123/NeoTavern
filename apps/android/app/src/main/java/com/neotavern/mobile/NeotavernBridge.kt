package com.neotavern.mobile

import android.os.Handler
import android.webkit.JavascriptInterface
import android.webkit.WebView
import java.nio.charset.StandardCharsets
import java.util.concurrent.ExecutorService
import org.json.JSONObject

/**
 * Wire operations that open a durable event stream (they declare an
 * `eventSchemaId` in the canonical wire registry). Everything else is a unary
 * call. The set is frozen with the wire registry (Phase 5):
 * `generation.start`, `generation.retry`.
 */
private val STREAM_OPERATIONS: Set<String> = setOf("generation.start", "generation.retry")

/**
 * Native status codes (mobile-ffi `NT_ERR_*`) that carry PRODUCT semantics —
 * a stream-open failure with one of these is delivered as the
 * `{"kind":"error","error":{...}}` stream payload so the TS transport can
 * surface a ProductError (desktop parity), not a TransportError.
 *
 * 2 contract · 3 not found · 4 storage · 5 cancelled · 8 mismatch.
 * Transport-class failures (1 invalid-arg, 6 internal, 7 buffer) and every
 * session-level failure reject() instead.
 */
private val PRODUCT_STATUS_CODES: Set<Int> = setOf(2, 3, 4, 5, 8)

/**
 * Direction of a WebView callback delivery.
 */
enum class CallbackFrameKind { RESOLVE, REJECT }

/**
 * A `window.__neotavernMobileCallbacks` invocation to evaluate in the
 * WebView. PURE Kotlin (no android.*) — unit-tested on the JVM.
 *
 * Produces exactly the frozen bridge expressions:
 *
 * ```
 * window.__neotavernMobileCallbacks && window.__neotavernMobileCallbacks
 *   .resolve('<callbackId>', JSON.parse('<escaped envelope string literal>'))
 * ```
 *
 * (and the `reject` twin). The payload JSON is embedded through
 * [JsEscaping.escapeJsStringLiteral] — never interpolated raw — so attacker-
 * controlled `"` / `\` / control characters cannot break out of the literal.
 * The callback id is validated against a safe charset before it is placed
 * into the single-quoted literal.
 */
class CallbackFrame private constructor(
    val callbackId: String,
    val payloadJson: String,
    val kind: CallbackFrameKind,
) {

    /** The full JavaScript expression to pass to [WebView.evaluateJavascript]. */
    fun toJsExpression(): String {
        val method = if (kind == CallbackFrameKind.RESOLVE) "resolve" else "reject"
        return "window.__neotavernMobileCallbacks && window.__neotavernMobileCallbacks." +
            "$method('$callbackId', JSON.parse(" +
            JsEscaping.escapeJsStringLiteral(payloadJson) + "))"
    }

    companion object {
        private val SAFE_CALLBACK_ID = Regex("^[A-Za-z0-9._-]{1,128}$")

        /** A resolve delivery carrying `payloadJson` (an envelope or a stream payload object). */
        fun resolve(callbackId: String, payloadJson: String): CallbackFrame =
            CallbackFrame(validateId(callbackId), payloadJson, CallbackFrameKind.RESOLVE)

        /** A reject delivery carrying a transport-error JSON object. */
        fun reject(callbackId: String, payloadJson: String): CallbackFrame =
            CallbackFrame(validateId(callbackId), payloadJson, CallbackFrameKind.REJECT)

        private fun validateId(callbackId: String): String {
            require(SAFE_CALLBACK_ID.matches(callbackId)) {
                "unsafe callback id: ${callbackId.take(32)}"
            }
            return callbackId
        }
    }
}

/**
 * The object installed on the WebView as `window.__neotavernMobile` via
 * `addJavascriptInterface` (BEFORE `loadUrl`).
 *
 * Bridge protocol (frozen, Phase 5):
 *  - [handshake] returns the native handshake JSON synchronously
 *    (`{ffiAbiVersion, schemaHash, wireProtocol:{major,minor}, appVersion}`);
 *  - [call] is fire-and-forget: the request envelope is dispatched on the
 *    background [executor]; the response envelope (unary) or the stream
 *    payload objects (workflow operations) are delivered back on the UI
 *    thread by evaluating the `window.__neotavernMobileCallbacks`
 *    resolve/reject expressions built by [CallbackFrame];
 *  - stream open product failures are delivered as
 *    `{"kind":"error","error":{code,params}}` payloads (synthesized from the
 *    native status code — the frozen native surface has no product-DTO
 *    channel for stream start); transport failures and mid-stream wait
 *    failures reject() with `{"code","message"}`;
 *  - [cancelStream] maps a wire stream id (learned from event envelopes, or
 *    the request id before the first event) back to the native handle and
 *    cancels the durable run.
 *
 * Phase 8 (background execution) additive hooks — the frozen Phase 5 method
 * table is unchanged:
 *  - [onStreamOpened] fires once per stream, on the main thread, when the
 *    first event carrying a wire stream id arrives. The host uses it to claim
 *    the stream in [ForegroundExecutionCoordinator] and start the bounded
 *    [GenerationService] while the app is still in the foreground, so the
 *    background service can take over pumping the stream after this bridge
 *    closes;
 *  - [onStreamTerminal] fires once per stream, on the main thread, when the
 *    stream reaches its terminal state (terminal/error payload) — the host
 *    ends the background service even when this bridge is still the active
 *    pump (activity alive but backgrounded), so the foreground notification
 *    reflects the real operation state (§8);
 *  - [backgroundExecutionAvailable] is the host capability probe (ТЗ §60).
 *
 * All native work happens on the single-threaded [executor]; [close] stops
 * pumps and drops new deliveries (called before the activity releases the
 * session — the claimed streams themselves stay open for the service).
 */
class NeotavernBridge(
    private val session: KernelSession,
    private val executor: ExecutorService,
    private val mainHandler: Handler,
    private val webView: WebView,
    private val onStreamOpened: ((Pair<Long, String>) -> Unit)? = null,
    private val onStreamTerminal: ((String) -> Unit)? = null,
) {

    /** Set by the host on teardown; stops pumps and drops pending deliveries. */
    @Volatile
    private var closed = false

    /** Native handles currently pumping (cap [MAX_CONCURRENT_STREAMS]). */
    private val activeStreams = HashSet<Long>()

    /** Wire stream id (from event envelopes) → native handle. */
    private val streamByWireId = HashMap<String, Long>()

    /** Request id (from the opening envelope) → native handle, before the first event. */
    private val streamByRequestId = HashMap<String, Long>()

    @JavascriptInterface
    fun handshake(): String = session.handshake()

    /**
     * Host capability probe (ТЗ §60): the Android host supports background
     * execution of generation streams via the bounded foreground service
     * ([GenerationService], Phase 8). Additive — the frozen Phase 5 surface
     * is unchanged.
     */
    @JavascriptInterface
    fun backgroundExecutionAvailable(): Boolean = true

    @JavascriptInterface
    fun call(requestId: String, envelopeJson: String, callbackId: String) {
        if (closed) return
        executor.execute {
            if (closed) return@execute
            try {
                val operationId = operationIdOf(envelopeJson)
                if (operationId in STREAM_OPERATIONS) {
                    startStreamAndPump(requestId, envelopeJson, callbackId)
                } else {
                    val response = session.callEnvelope(envelopeJson)
                    deliver(CallbackFrame.resolve(callbackId, response))
                }
            } catch (e: SessionError) {
                deliver(CallbackFrame.reject(callbackId, transportErrorJson(e)))
            } catch (e: KernelException) {
                deliver(CallbackFrame.reject(callbackId, transportErrorJson(e)))
            } catch (e: Exception) {
                deliver(CallbackFrame.reject(callbackId, transportErrorJson(e)))
            }
        }
    }

    @JavascriptInterface
    fun cancelStream(streamId: String) {
        if (closed) return
        executor.execute {
            if (closed) return@execute
            val handle = streamByWireId.remove(streamId) ?: streamByRequestId.remove(streamId)
            if (handle != null) {
                try {
                    session.cancelStream(handle)
                } catch (e: SessionError) {
                    // Cancel is best-effort and idempotent; the session already
                    // released or will release the handle on close.
                }
            }
        }
    }

    /** Stops pumps and drops pending deliveries. Call on teardown BEFORE closing the session. */
    fun close() {
        closed = true
    }

    private fun startStreamAndPump(requestId: String, envelopeJson: String, callbackId: String) {
        if (activeStreams.size >= MAX_CONCURRENT_STREAMS) {
            deliver(CallbackFrame.reject(callbackId, streamLimitErrorJson()))
            return
        }
        val handle = try {
            session.startStream(envelopeJson)
        } catch (e: SessionError.KernelCallFailed) {
            deliverStreamStartFailure(callbackId, e.code, e.message ?: "stream start failed")
            return
        } catch (e: SessionError) {
            deliver(CallbackFrame.reject(callbackId, transportErrorJson(e)))
            return
        } catch (e: KernelException) {
            deliverStreamStartFailure(callbackId, e.code, e.message ?: "stream start failed")
            return
        }
        streamByRequestId[requestId] = handle
        activeStreams.add(handle)
        pump(handle, callbackId)
    }

    /** Stream-open failure: product-class statuses become `{kind:"error"}` payloads, the rest reject(). */
    private fun deliverStreamStartFailure(callbackId: String, code: Int, message: String) {
        if (code in PRODUCT_STATUS_CODES) {
            deliver(CallbackFrame.resolve(callbackId, streamProductErrorJson(code, message)))
        } else {
            val error = JSONObject()
                .put("code", "kernel-error")
                .put("message", "stream start failed (native code $code): $message")
            deliver(CallbackFrame.reject(callbackId, error.toString()))
        }
    }

    /**
     * Stream pump: polls the native stream every [STREAM_POLL_MS]; forwards
     * payload objects verbatim; stops on `{kind:"terminal"}` (and on any
     * non-event kind, defensively). Native wait failures reject() — the
     * durable run stays recoverable via `generation.get` / `generation.events`.
     */
    private fun pump(handle: Long, callbackId: String) {
        var done = false
        while (!done && !closed) {
            val payload = try {
                session.waitEvent(handle, STREAM_POLL_MS)
            } catch (e: SessionError) {
                deliver(CallbackFrame.reject(callbackId, transportErrorJson(e)))
                break
            } catch (e: KernelException) {
                deliver(CallbackFrame.reject(callbackId, transportErrorJson(e)))
                break
            }
            if (payload == null) continue // poll timeout — not end-of-stream

            val payloadJson = String(payload, StandardCharsets.UTF_8)
            val kind = try {
                JSONObject(payloadJson).optString("kind")
            } catch (e: Exception) {
                // Not a JSON object; native always sends {kind:...}, so this is
                // a defensive pass-through as an event.
                deliver(CallbackFrame.resolve(callbackId, payloadJson))
                continue
            }
            when (kind) {
                "event" -> {
                    val wireStreamId = registerWireStreamId(payloadJson, handle)
                    if (wireStreamId != null) {
                        notifyStreamOpened(handle, wireStreamId)
                    }
                    deliver(CallbackFrame.resolve(callbackId, payloadJson))
                }
                "terminal" -> {
                    notifyStreamTerminal(handle)
                    deliver(CallbackFrame.resolve(callbackId, payloadJson))
                    done = true
                }
                else -> {
                    // "error" payloads and anything unknown: deliver and end the pump.
                    notifyStreamTerminal(handle)
                    deliver(CallbackFrame.resolve(callbackId, payloadJson))
                    done = true
                }
            }
        }
        activeStreams.remove(handle)
        streamByRequestId.entries.removeAll { it.value == handle }
        streamByWireId.entries.removeAll { it.value == handle }
    }

    /**
     * Remembers the wire stream id so a later [cancelStream] can find the
     * native handle. Returns the wire id only when it was newly registered
     * (the first event of the stream), so the host hook fires once per stream.
     */
    private fun registerWireStreamId(payloadJson: String, handle: Long): String? {
        return try {
            val event = JSONObject(payloadJson).getJSONObject("event")
            val wireStreamId = event.getString("streamId")
            if (wireStreamId.isNotEmpty() && wireStreamId !in streamByWireId) {
                streamByWireId[wireStreamId] = handle
                wireStreamId
            } else {
                null
            }
        } catch (e: Exception) {
            // Event envelope without a streamId: the consumer cannot cancel this stream early.
            null
        }
    }

    /**
     * Notifies the host that a stream just opened (first event with a wire
     * stream id). Delivered on the main thread; a failing host hook must
     * never break the stream pump.
     */
    private fun notifyStreamOpened(handle: Long, wireStreamId: String) {
        val listener = onStreamOpened ?: return
        mainHandler.post {
            if (closed) return@post
            try {
                listener(handle to wireStreamId)
            } catch (e: Exception) {
                // Best-effort host hook; the pump keeps delivering either way.
            }
        }
    }

    /**
     * Notifies the host that a stream reached its terminal state (terminal or
     * error payload), so the host can end the background service even while
     * the activity is still alive and its bridge pump is the active pump.
     * Delivered on the main thread; a failing host hook never breaks the
     * pump teardown.
     */
    private fun notifyStreamTerminal(handle: Long) {
        val listener = onStreamTerminal ?: return
        val wireStreamId = synchronized(streamByWireId) {
            streamByWireId.entries.firstOrNull { it.value == handle }?.key
        }
        if (wireStreamId == null) return
        mainHandler.post {
            if (closed) return@post
            try {
                listener(wireStreamId)
            } catch (e: Exception) {
                // Best-effort host hook.
            }
        }
    }

    /** Extracts `operationId` from the request envelope; null when unparseable. */
    private fun operationIdOf(envelopeJson: String): String? = try {
        JSONObject(envelopeJson).optString("operationId", "").takeIf { it.isNotEmpty() }
    } catch (e: Exception) {
        null
    }

    /** Posts the callback expression to the UI thread (dropped when closed/destroyed). */
    private fun deliver(frame: CallbackFrame) {
        if (closed) return
        mainHandler.post {
            if (closed) return@post
            try {
                webView.evaluateJavascript(frame.toJsExpression(), null)
            } catch (e: Exception) {
                // WebView already destroyed or the JS bridge torn down: nothing to deliver to.
            }
        }
    }

    /** Synthesized product-error payload for a stream-open failure (see class docs). */
    private fun streamProductErrorJson(code: Int, message: String): String {
        val error = JSONObject()
            .put("code", wireCodeForNativeStatus(code))
            .put("params", JSONObject().put("message", message))
        return JSONObject()
            .put("kind", "error")
            .put("error", error)
            .toString()
    }

    /** Maps a native status code to the canonical wire code (best-effort; NT_ERR_STORAGE is ambiguous). */
    private fun wireCodeForNativeStatus(code: Int): String = when (code) {
        2, 8 -> "CONTRACT_VIOLATION"
        3 -> "NOT_FOUND"
        4 -> "INTERNAL" // NT_ERR_STORAGE: StorageFailure for a stream start (DataRootInUse only occurs at open)
        5 -> "CANCELLED"
        else -> "INTERNAL"
    }

    /** Stable `{"code","message"}` payload for reject() deliveries (transport-level). */
    private fun transportErrorJson(e: Throwable): String {
        val code = when (e) {
            is SessionError.StateError -> "session-state"
            is SessionError.OpenFailed -> "kernel-open-failed"
            is SessionError.StreamStartFailed -> "stream-start-failed"
            is SessionError.UnknownStream -> "unknown-stream"
            is SessionError.KernelCallFailed -> "kernel-call-failed"
            is KernelException -> "kernel-error"
            else -> "internal"
        }
        return JSONObject()
            .put("code", code)
            .put("message", e.message ?: e.javaClass.simpleName)
            .toString()
    }

    private fun streamLimitErrorJson(): String = JSONObject()
        .put("code", "stream-limit")
        .put("message", "too many concurrent streams (max $MAX_CONCURRENT_STREAMS)")
        .toString()

    private companion object {
        const val MAX_CONCURRENT_STREAMS = 8
        const val STREAM_POLL_MS = 200
    }
}
