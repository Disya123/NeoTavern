package com.neotavern.mobile

import android.os.Build
import android.os.Trace
import android.util.Log
import android.view.Choreographer
import android.view.MotionEvent
import android.view.View
import java.util.concurrent.atomic.AtomicLong

/**
 * Debug/flagged-shell MotionEvent + Choreographer adapter.
 * Not wired to production [MainActivity] or default JNI.
 *
 * Kotlin only forwards raw screen coordinates and `eventTimeNanos`.
 * Hit-test / sticky / fixed correction happens in NeoCompositor.
 */
class PresentationInputAdapter(
    private val choreographer: Choreographer = Choreographer.getInstance(),
) : Choreographer.FrameCallback {
    val queue = PresentationInputQueue()
    @Volatile
    var lastVsyncNanos: Long = 0L
        private set
    @Volatile
    var lastVsyncId: Long = 0L
        private set
    @Volatile
    var lastDeadlineNanos: Long = 0L
        private set
    /** FrameTimeline expected present is a deadline cookie, not SF actual present. */
    @Volatile
    var lastExpectedPresentNanos: Long = 0L
        private set
    @Volatile
    var lastEligibleForCurrentVsync: Boolean = false
        private set
    @Volatile
    var lastTargetVsyncId: Long = 0L
        private set
    private var posted = false
    private val nextSeq = AtomicLong(1)
    private var vsyncCallback: Choreographer.VsyncCallback? = null

    init {
        if (Build.VERSION.SDK_INT >= 33) {
            vsyncCallback =
                Choreographer.VsyncCallback { data ->
                    lastVsyncNanos =
                        PresentationInputMapping.presentationTimeFromVsync(data.frameTimeNanos)
                    val timeline = data.preferredFrameTimeline
                    lastVsyncId = timeline.vsyncId
                    lastDeadlineNanos = timeline.deadlineNanos
                    lastExpectedPresentNanos = timeline.expectedPresentationTimeNanos
                    val callback = vsyncCallback
                    if (posted && callback != null) {
                        choreographer.postVsyncCallback(callback)
                    }
                }
        }
    }

    fun startFrameCallbacks() {
        if (posted) return
        posted = true
        val callback = vsyncCallback
        if (callback != null) {
            choreographer.postVsyncCallback(callback)
        } else {
            choreographer.postFrameCallback(this)
        }
    }

    fun stopFrameCallbacks() {
        posted = false
        val callback = vsyncCallback
        if (callback != null) {
            choreographer.removeVsyncCallback(callback)
        } else {
            choreographer.removeFrameCallback(this)
        }
    }

    override fun doFrame(frameTimeNanos: Long) {
        lastVsyncNanos = PresentationInputMapping.presentationTimeFromVsync(frameTimeNanos)
        lastVsyncId = 0L
        if (posted) {
            choreographer.postFrameCallback(this)
        }
    }

    fun onTouch(event: MotionEvent): Boolean {
        val frame = fromMotionEvent(event)
        val samples = ArrayList<PresentationInputMapping.Sample>(8)
        PresentationInputMapping.expand(frame, samples)
        val coalesced = PresentationInputMapping.coalescedLatencyTimes(frame)
        val nextVsyncId = if (lastVsyncId == 0L) 0L else lastVsyncId + 1L
        Trace.beginSection("nt.input.enqueue")
        try {
            for (sample in samples) {
                val seq = nextSeq.getAndIncrement()
                queue.tryPush(sample)
                val target =
                    PresentationInputMapping.assignFrameTarget(
                        eventTime = sample.timeNanos,
                        inputCutoff = lastDeadlineNanos,
                        callbackTime = lastVsyncNanos,
                        currentVsyncId = lastVsyncId,
                        currentPresentDeadline = lastExpectedPresentNanos,
                        nextVsyncId = nextVsyncId,
                        nextPresentDeadline = 0L,
                    )
                lastEligibleForCurrentVsync = target.eligibleForCurrentVsync
                lastTargetVsyncId = target.targetVsyncId
                Log.i(
                    TAG,
                    "i2p seq=$seq " +
                        PresentationInputMapping.formatI2pCookies(
                            eventTime = target.eventTime,
                            inputCutoff = target.inputCutoff,
                            callbackTime = target.callbackTime,
                            targetVsyncId = target.targetVsyncId,
                            targetPresentDeadline = target.targetPresentDeadline,
                            actualPresentTime = "pending",
                            eligibleForCurrentVsync = target.eligibleForCurrentVsync,
                            rendererControlled = "pending",
                            exclusionReason = "pending",
                            newestEventTime = coalesced.newestEventTime,
                            oldestHistoricalEventTime = coalesced.oldestHistoricalEventTime,
                        ) +
                        " pointer=${sample.pointerId} kind=${sample.kind}",
                )
            }
        } finally {
            Trace.endSection()
        }
        return true
    }

    fun loseFocus(timeNanos: Long = lastVsyncNanos) {
        queue.cancelAll(timeNanos)
    }

    fun loseWindow(timeNanos: Long = lastVsyncNanos) {
        queue.cancelAll(timeNanos)
    }

    fun recreateSurface(timeNanos: Long = lastVsyncNanos) {
        queue.cancelAll(timeNanos)
    }

    fun attach(view: View) {
        view.setOnTouchListener { _, event -> onTouch(event) }
        view.addOnAttachStateChangeListener(
            object : View.OnAttachStateChangeListener {
                override fun onViewAttachedToWindow(v: View) = startFrameCallbacks()

                override fun onViewDetachedFromWindow(v: View) {
                    stopFrameCallbacks()
                    recreateSurface()
                }
            },
        )
    }

    companion object {
        fun fromMotionEvent(event: MotionEvent): PresentationInputMapping.MotionFrame {
            val count = event.pointerCount
            val ids = IntArray(count) { event.getPointerId(it) }
            val xs = FloatArray(count) { event.getX(it) }
            val ys = FloatArray(count) { event.getY(it) }
            val history = event.historySize
            val historicalTimes = LongArray(history) { historicalSampleTimeNanos(event, it) }
            val historicalXs = FloatArray(history * count)
            val historicalYs = FloatArray(history * count)
            for (h in 0 until history) {
                for (p in 0 until count) {
                    val base = h * count + p
                    historicalXs[base] = event.getHistoricalX(p, h)
                    historicalYs[base] = event.getHistoricalY(p, h)
                }
            }
            return PresentationInputMapping.MotionFrame(
                action = event.action,
                pointerCount = count,
                eventTimeNanos = sampleTimeNanos(event),
                pointerIds = ids,
                xs = xs,
                ys = ys,
                historicalTimesNanos = historicalTimes,
                historicalXs = historicalXs,
                historicalYs = historicalYs,
            )
        }

        fun sampleTimeNanos(event: MotionEvent): Long =
            PresentationInputMapping.sampleTimeNanos(
                event.eventTime,
                if (Build.VERSION.SDK_INT >= 34) event.eventTimeNanos else 0L,
                Build.VERSION.SDK_INT,
            )

        fun historicalSampleTimeNanos(event: MotionEvent, pos: Int): Long =
            PresentationInputMapping.sampleTimeNanos(
                event.getHistoricalEventTime(pos),
                if (Build.VERSION.SDK_INT >= 34) event.getHistoricalEventTimeNanos(pos) else 0L,
                Build.VERSION.SDK_INT,
            )

        const val TAG: String = "NeoTavernI2P"
    }
}
