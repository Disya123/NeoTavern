package com.neotavern.mobile

import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.content.ContextCompat
import java.nio.charset.StandardCharsets
import java.util.Collections
import java.util.HashSet
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONObject

/**
 * Bounded foreground service (dataSync, ТЗ §87) that keeps pumping claimed
 * generation streams when the activity no longer delivers them.
 *
 * Phase 8 timing:
 *  - the activity's bridge hook claims each newly opened stream in
 *    [ForegroundExecutionCoordinator] and starts this service while the app
 *    is still in the foreground, so this service acquires its [KernelHolder]
 *    refcount BEFORE the activity's onDestroy — the kernel never dies
 *    mid-run,
 *  - [onStartCommand] shows the foreground notification and posts one pump
 *    task per claimed stream onto the holder's single-threaded executor; the
 *    tasks queue behind the activity's bridge pumps and take over the moment
 *    the bridge closes (activity destroyed) — delivery and pumping never
 *    overlap,
 *  - a pump maps `{kind:"event"}` payloads to the notification title (status
 *    only — NEVER message content, §85), and on terminal/error unclaims its
 *    stream; when every pump has drained the service removes the notification
 *    and stops itself,
 *  - the STOP action (notification button or broadcast with
 *    [NotificationState.ACTION_STOP]) cancels every claimed stream, unclaims
 *    them, removes the notification and stops the service.
 *
 * All kernel access happens on the holder's executor (the STOP cancel and the
 * teardown cancel are thread-safe [KernelSession] calls); the service never
 * blocks the main thread.
 */
class GenerationService : Service() {

    private val mainHandler = Handler(Looper.getMainLooper())
    private val pendingPumps = AtomicInteger(0)
    private val pumpingWireIds = Collections.synchronizedSet(HashSet<String>())

    /** Set once a STOP/teardown is requested; pumps exit at the next poll. */
    @Volatile
    private var stopped = false

    @Volatile
    private var holder: KernelHolder? = null

    private var stopReceiver: BroadcastReceiver? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        stopReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                if (intent?.action == NotificationState.ACTION_STOP) {
                    stopGeneration()
                }
            }
        }
        // RECEIVER_NOT_EXPORTED: only this app (same UID) and the system can
        // trigger a stop of the generation foreground service. ContextCompat
        // maps the flag to the plain 2-arg registration below API 33.
        ContextCompat.registerReceiver(
            this,
            stopReceiver,
            IntentFilter(NotificationState.ACTION_STOP),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val claims = ForegroundExecutionCoordinator.claimedStreams()
        if (claims.isEmpty()) {
            // Defensive: started without any claimed stream (the coordinator
            // is process-local and empty after a process restart). Nothing to
            // pump — stop without touching the holder.
            stopSelf()
            return START_NOT_STICKY
        }
        var h = holder
        if (h == null) {
            h = obtainHolder()
            if (h == null) {
                // The kernel could not be opened; nothing to pump.
                stopSelf()
                return START_NOT_STICKY
            }
            holder = h
        }
        NotificationHelper.showForeground(this)
        startPumping(h, claims)
        return START_NOT_STICKY
    }

    /**
     * Takes a holder refcount for this service from the process-wide
     * [KernelHost] (the same live holder the activity uses). Returns `null`
     * when the holder cannot be used. The kernel open itself is scheduled on
     * the holder executor by [KernelHolder.acquire] (never the main thread);
     * an open failure surfaces later as a session-state error, which the
     * pump loop maps to the "failed" notification and ends the service.
     */
    private fun obtainHolder(): KernelHolder? {
        return try {
            val h = KernelHost.holder(ManagedDataRoot(this).ensure().absolutePath)
            h.acquire()
            h
        } catch (e: IllegalStateException) {
            // The holder was released to zero between holder() and acquire()
            // (teardown race); KernelHost builds a fresh one on the next call.
            null
        }
    }

    /** Posts one pump task per claimed stream not already being pumped. */
    private fun startPumping(h: KernelHolder, claims: List<ClaimedStream>) {
        for (claim in claims) {
            if (!pumpingWireIds.add(claim.wireStreamId)) continue // already pumping
            pendingPumps.incrementAndGet()
            h.executor.execute { pumpStream(h, claim) }
        }
    }

    /**
     * Pumps one claimed stream: waits up to [STREAM_POLL_MS] for the next
     * payload, maps its kind to the notification title (status only) and
     * unclaims on terminal/error. Ends on STOP/teardown or a session-level
     * failure (the durable run stays recoverable via `generation.retry`).
     */
    private fun pumpStream(h: KernelHolder, claim: ClaimedStream) {
        var done = false
        try {
            while (!done && !stopped) {
                val payload = try {
                    h.session.waitEvent(claim.streamHandle, STREAM_POLL_MS)
                } catch (e: SessionError) {
                    // Session-level failure (e.g. the session closed
                    // underneath): surface "failed" and end this pump.
                    NotificationHelper.updateTitle(this, "error")
                    done = true
                    break
                } catch (e: KernelException) {
                    NotificationHelper.updateTitle(this, "error")
                    done = true
                    break
                }
                if (payload == null) continue // poll timeout — not end-of-stream

                val kind = try {
                    JSONObject(String(payload, StandardCharsets.UTF_8)).optString("kind", "event")
                } catch (e: Exception) {
                    // Non-JSON payload: defensive pass-through as an event.
                    "event"
                }
                NotificationHelper.updateTitle(this, kind)
                if (NotificationState.isTerminal(kind)) {
                    done = true
                }
            }
        } finally {
            ForegroundExecutionCoordinator.unclaim(claim.wireStreamId)
            pumpingWireIds.remove(claim.wireStreamId)
            if (pendingPumps.decrementAndGet() == 0) {
                finishService()
            }
        }
    }

    /** Removes the foreground notification and stops the service (idempotent). */
    private fun finishService() {
        mainHandler.post {
            NotificationHelper.cancelForeground(this)
            stopSelf()
        }
    }

    /**
     * STOP action: cancel every claimed stream (direct — [KernelSession]
     * cancellation is thread-safe and idempotent; the pumps drain on the next
     * waitEvent), unclaim all, remove the notification and stop the service.
     */
    private fun stopGeneration() {
        val h = holder
        stopped = true
        if (h != null) {
            for (claim in ForegroundExecutionCoordinator.claimedStreams()) {
                try {
                    h.session.cancelStream(claim.streamHandle)
                } catch (e: SessionError) {
                    // Cancel is best-effort and idempotent.
                }
            }
        }
        for (claim in ForegroundExecutionCoordinator.claimedStreams()) {
            ForegroundExecutionCoordinator.unclaim(claim.wireStreamId)
        }
        NotificationHelper.cancelForeground(this)
        stopSelf()
    }

    override fun onDestroy() {
        stopReceiver?.let { unregisterReceiver(it) }
        stopReceiver = null
        val h = holder
        holder = null
        stopped = true
        if (h != null) {
            // Cancel any remaining claimed streams (idempotent), unclaim all,
            // then release the refcount — queued behind the pumps on the
            // shared executor, so the final close (session.close + executor
            // shutdown) happens off the main thread.
            h.executor.execute {
                for (claim in ForegroundExecutionCoordinator.claimedStreams()) {
                    try {
                        h.session.cancelStream(claim.streamHandle)
                    } catch (e: SessionError) {
                        // Best-effort drain.
                    }
                }
                for (claim in ForegroundExecutionCoordinator.claimedStreams()) {
                    ForegroundExecutionCoordinator.unclaim(claim.wireStreamId)
                }
                h.release()
            }
        }
        super.onDestroy()
    }

    private companion object {
        const val STREAM_POLL_MS = 1000
    }
}
