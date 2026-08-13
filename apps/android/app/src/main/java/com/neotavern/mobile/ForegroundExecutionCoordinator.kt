package com.neotavern.mobile

/**
 * One stream handed off from the WebView bridge to the background service.
 *
 * [streamHandle] is the opaque native handle opened through the shared
 * [KernelSession]; it stays valid until that session closes, so the service
 * can keep pumping [KernelSession.waitEvent] and cancel via
 * [KernelSession.cancelStream] across the handoff. [wireStreamId] is the id
 * learned from the first event envelope (used for idempotent claims and the
 * notification stop action); [claimedAtMillis] is the epoch-millis claim
 * time.
 */
data class ClaimedStream(
    val streamHandle: Long,
    val wireStreamId: String,
    val claimedAtMillis: Long,
)

/**
 * Singleton-ish process-wide registry of generation streams handed off from
 * the WebView bridge to the background service (ТЗ §8). Thread-safe.
 *
 * The registry is deliberately metadata-only: it records which native
 * stream handles are live in the background so [GenerationService] can pump
 * and cancel them without touching the (Host-owned) bridge internals. The
 * shared kernel itself lives in [KernelHolder], not here.
 *
 * Claim rules:
 *  - [claim] first-claim-wins: the first successful claim for a
 *    `wireStreamId` returns `true`; any later claim for the same id returns
 *    `false` (idempotent for the owner that already holds it);
 *  - [unclaim] removes a claim by wire stream id (no-op when absent);
 *  - [claimedStreams] returns an immutable snapshot (fresh copy, immutable
 *    elements), safe to read from any thread while claims change.
 */
object ForegroundExecutionCoordinator {

    private val lock = Any()

    /** wireStreamId → claim. */
    private val claims = HashMap<String, ClaimedStream>()

    /**
     * Attempts to claim `wireStreamId` for `streamHandle`.
     *
     * @return `true` when this call won the claim, `false` when the id is
     *   already claimed (first claim wins)
     */
    fun claim(streamHandle: Long, wireStreamId: String): Boolean = synchronized(lock) {
        if (wireStreamId in claims) {
            false
        } else {
            claims[wireStreamId] = ClaimedStream(
                streamHandle = streamHandle,
                wireStreamId = wireStreamId,
                claimedAtMillis = System.currentTimeMillis(),
            )
            true
        }
    }

    /** Removes the claim for `wireStreamId`, if any. */
    fun unclaim(wireStreamId: String) {
        synchronized(lock) {
            claims.remove(wireStreamId)
        }
    }

    /** Immutable snapshot of every current claim, in claim order. */
    fun claimedStreams(): List<ClaimedStream> = synchronized(lock) {
        claims.values.toList()
    }

    /** Whether `wireStreamId` is currently claimed. */
    fun isClaimed(wireStreamId: String): Boolean = synchronized(lock) {
        wireStreamId in claims
    }
}
