package com.neotavern.mobile

import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Refcounted owner of the ONE shared [KernelSession] and its single-thread
 * executor (ТЗ §8 — Android background execution).
 *
 * The WebView host (Activity) and the background components
 * (GenerationService, MaintenanceWorker) must share a single kernel handle:
 * a second writable kernel on the same data root is rejected by the
 * exclusive data-root lease (§22 `DataRootInUse`). This holder is created
 * once by the host and handed to every component that needs the kernel.
 *
 * Semantics:
 *  - [acquire] increments the reference count and opens the session —
 *    [KernelSession.open] is idempotent, so N acquires perform exactly one
 *    native open;
 *  - [release] decrements the count; when it reaches zero the session is
 *    closed and the executor shut down — **permanently**. A released holder
 *    must not be acquired again ([acquire] throws [IllegalStateException]).
 *    [release] itself never throws: a native close failure is swallowed so
 *    teardown on the UI thread can never crash the process;
 *  - every mutation is guarded by a single lock; the count can never go
 *    negative (releases past zero are no-ops).
 *
 * Callers post kernel work to [executor]; the stream handles opened through
 * [session] stay registered until the session closes, so a run started by
 * the Activity can be pumped and cancelled from the service across a
 * handoff as long as the count never reaches zero in between.
 */
class KernelHolder(
    private val native: NativeKernel,
    private val dataRoot: String,
    private val onOpenError: ((Throwable) -> Unit)? = null,
) {

    private val lock = Any()

    /** Live owner references. */
    private var refCount = 0

    /** Whether the holder has been released to zero (single-use). */
    private var released = false

    /** Serializes every kernel operation: open, calls, stream pumps, close. */
    val executor: ExecutorService = Executors.newSingleThreadExecutor()

    /** The one shared kernel session over [dataRoot], owned by this holder. */
    val session: KernelSession = KernelSession(native, dataRoot)

    /**
     * Whether the holder has been released to zero: the session is closed
     * and the executor shut down. The holder is single-use — after this is
     * `true`, [acquire] throws [IllegalStateException] and the process-wide
     * provider must construct a new holder.
     */
    val isReleased: Boolean
        get() = synchronized(lock) { released }

    /**
     * Registers one owner and schedules the kernel open.
     *
     * Thread-safe and idempotent per owner: each caller pairs one [acquire]
     * with one [release]. The session open runs ON THE HOLDER EXECUTOR (never
     * the caller's thread — ТЗ §13: no blocking native work on the UI/main
     * thread), queued before any work the caller posts afterwards, so FIFO
     * ordering guarantees the kernel is open before the caller's own executor
     * work runs. [KernelSession.open] is idempotent, so N acquires perform
     * exactly one native open. An open failure is reported through
     * [onOpenError] (the session stays closed; later calls reject with a
     * session-state error the caller surfaces).
     *
     * @throws IllegalStateException when the holder was already released to zero
     */
    fun acquire() {
        synchronized(lock) {
            check(!released) { "KernelHolder is released; it cannot be acquired again" }
            refCount++
        }
        executor.execute {
            // The holder may have been released to zero while this task was
            // queued (release() closes synchronously on the caller's thread):
            // never reopen a closed session.
            if (isReleased) return@execute
            try {
                session.open()
            } catch (t: Throwable) {
                onOpenError?.invoke(t)
            }
        }
    }

    /**
     * Releases one owner; when the count reaches zero, closes the session
     * and shuts the executor down — exactly once.
     *
     * Never throws: a native close failure is deliberately swallowed — the
     * kernel handle is released regardless and the holder must stay safe to
     * call from teardown paths. Releases past zero are no-ops, so a sloppy
     * caller cannot drive the count negative.
     */
    fun release() {
        val shouldClose = synchronized(lock) {
            if (refCount > 0) refCount--
            val atZero = refCount == 0 && !released
            if (atZero) released = true
            atZero
        }
        if (shouldClose) {
            try {
                session.close()
            } catch (ignored: Throwable) {
                // MUST NOT throw: the session already transitioned to CLOSED
                // internally; the executor is torn down regardless.
            }
            executor.shutdown()
        }
    }
}
