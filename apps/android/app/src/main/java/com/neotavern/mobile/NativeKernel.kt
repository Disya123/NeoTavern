package com.neotavern.mobile

/**
 * Minimal native kernel surface used by [KernelSession].
 *
 * Mirrors the frozen Phase 5 JNI method table exposed by the
 * `neotavern_android_jni` native library (bound to the static methods of
 * `com.neotavern.mobile.KernelBridge`). Keeping this as an interface lets the
 * state machine in [KernelSession] be exercised on the JVM with a fake
 * implementation — no android.* or native code involved.
 *
 * Payloads are the SAME Product Wire Contract bytes the local/remote
 * transports use: every method below accepts or returns the serialized
 * `wire.request.envelope` / `wire.response.envelope` JSON (byte-identical to
 * the TauriTransport request envelope, ТЗ §6.3).
 */
interface NativeKernel {

    /**
     * Kernel handshake metadata as JSON:
     * `{ "ffiAbiVersion": 1, "schemaHash": "...", "wireProtocol": {"major":1,"minor":0}, "appVersion": "..." }`.
     * Stateless — safe to call before any kernel is open.
     */
    fun handshake(): String

    /**
     * Opens a kernel over `dataRoot` and returns the opaque kernel handle.
     *
     * Returns `0` on failure; the native side throws [KernelException] with
     * the native status code and message instead of returning a bogus handle.
     */
    fun open(dataRoot: String): Long

    /** Closes the kernel behind `kernel` and releases its data-root lease. Null-ish (0) is a no-op. */
    fun close(kernel: Long)

    /** Executes one unary wire operation; returns the serialized response envelope bytes. */
    fun call(kernel: Long, request: ByteArray): ByteArray

    /** Starts a durable generation stream; returns the opaque stream handle. */
    fun streamStart(kernel: Long, request: ByteArray): Long

    /**
     * Waits up to `timeoutMs` for the next notice of `stream`; returns its
     * payload bytes or `null` when the timeout elapses without a notice
     * (null is a poll timeout, never end-of-stream).
     */
    fun streamWait(stream: Long, timeoutMs: Int): ByteArray?

    /** Cancels the run behind `stream` (best-effort, idempotent). */
    fun streamCancel(kernel: Long, stream: Long)

    /** Frees the native resources behind `stream` (null-ish is a no-op). */
    fun streamFree(stream: Long)
}
