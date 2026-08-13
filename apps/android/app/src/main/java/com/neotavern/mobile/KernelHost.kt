package com.neotavern.mobile

/**
 * Process-global sharing point for the single live [KernelHolder] (Phase 8).
 *
 * The kernel holds an exclusive data-root lease (§22 DataRootInUse), so at
 * most ONE live holder may exist in the process at a time — in particular a
 * recreated [MainActivity] must never open a second kernel while
 * [GenerationService] still owns the first one. Every host component
 * ([MainActivity], [GenerationService], [MaintenanceWorker]) obtains the
 * holder through [holder]:
 *
 *  - the registered holder is returned while it is alive (`!isReleased`),
 *  - a released holder (refcount zero: session closed, executor shut down)
 *    is replaced by a fresh one on the next call.
 *
 * The caller owns one refcount: acquire in onCreate/onStartCommand/doWork,
 * release in onDestroy/onStop/at the end of doWork. The dataRoot argument is
 * only used when a fresh holder has to be constructed (all production callers
 * pass `<filesDir>/neotavern`; the instrumented test injects its own root).
 */
object KernelHost {

    @Volatile
    private var current: KernelHolder? = null

    /** Returns the live process-wide holder, constructing a fresh one when none exists. */
    @Synchronized
    fun holder(
        dataRoot: String,
        onOpenError: ((Throwable) -> Unit)? = null,
    ): KernelHolder {
        val h = current
        if (h != null && !h.isReleased) return h
        val n = KernelHolder(JniNativeKernel, dataRoot, onOpenError)
        current = n
        return n
    }
}
