package com.neotavern.mobile

import android.os.Build
import android.os.SystemClock
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
    interface NativeSink {
        fun tryPush(pointer: Int, kind: Int, x: Float, y: Float, timeNanos: Long)

        fun loseFocus(timeNanos: Long)
    }

    val queue = PresentationInputQueue()
    var nativeSink: NativeSink? = null
    @Volatile
    var lastPeriodNanos: Long = 8_333_333L
        private set
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
    @Volatile
    var lastNextVsyncId: Long = 0L
        private set
    @Volatile
    var lastNextPresentDeadline: Long = 0L
        private set
    private var posted = false
    private val nextSeq = AtomicLong(1)
    private var vsyncCallback: Choreographer.VsyncCallback? = null
    /**
     * Compositor [HandlerThread] FrameTimeline is the present token.
     * UI Choreographer vsync IDs are a different stream on Xiaomi and
     * must not be used for `sequence → targetVsyncId → actual present`.
     */
    @Volatile
    var compositorOwnsTimeline: Boolean = false
        private set
    @Volatile
    var lastConsumeNs: Long = 0L
        private set

    init {
        if (Build.VERSION.SDK_INT >= 33) {
            vsyncCallback =
                Choreographer.VsyncCallback { data ->
                    if (!compositorOwnsTimeline) {
                        val timeline = data.preferredFrameTimeline
                        val nextTimeline =
                            data.frameTimelines
                                .filter { it.vsyncId > timeline.vsyncId }
                                .minByOrNull { it.vsyncId }
                        applyFrameTimeline(
                            frameTimeNanos = data.frameTimeNanos,
                            vsyncId = timeline.vsyncId,
                            deadlineNanos = timeline.deadlineNanos,
                            expectedPresentNanos = timeline.expectedPresentationTimeNanos,
                            nextVsyncId = nextTimeline?.vsyncId ?: (timeline.vsyncId + 1L),
                            nextPresentDeadline =
                                nextTimeline?.expectedPresentationTimeNanos
                                    ?: (timeline.expectedPresentationTimeNanos + lastPeriodNanos),
                        )
                    }
                    val callback = vsyncCallback
                    if (posted && callback != null) {
                        choreographer.postVsyncCallback(callback)
                    }
                }
        }
    }

    fun setRefreshPeriodNanos(periodNanos: Long) {
        if (periodNanos > 0L) lastPeriodNanos = periodNanos
    }

    fun applyCompositorFrameTimeline(
        frameTimeNanos: Long,
        vsyncId: Long,
        deadlineNanos: Long,
        expectedPresentNanos: Long,
        nextVsyncId: Long,
        nextPresentDeadline: Long,
    ) {
        compositorOwnsTimeline = true
        applyFrameTimeline(
            frameTimeNanos,
            vsyncId,
            deadlineNanos,
            expectedPresentNanos,
            nextVsyncId,
            nextPresentDeadline,
        )
    }

    private fun applyFrameTimeline(
        frameTimeNanos: Long,
        vsyncId: Long,
        deadlineNanos: Long,
        expectedPresentNanos: Long,
        nextVsyncId: Long,
        nextPresentDeadline: Long,
    ) {
        lastVsyncNanos = PresentationInputMapping.presentationTimeFromVsync(frameTimeNanos)
        lastVsyncId = vsyncId
        lastDeadlineNanos = deadlineNanos
        lastExpectedPresentNanos = expectedPresentNanos
        lastNextVsyncId = nextVsyncId
        lastNextPresentDeadline = nextPresentDeadline
    }

    fun markCompositorPresented(consumeNs: Long) {
        lastConsumeNs = consumeNs
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
        val enqueueNs = SystemClock.uptimeNanos()
        val presentedCurrent = lastConsumeNs > 0L && enqueueNs >= lastConsumeNs
        val vsyncStep =
            if (lastNextVsyncId != 0L && lastVsyncId != 0L) {
                (lastNextVsyncId - lastVsyncId).coerceAtLeast(1L)
            } else {
                1L
            }
        val currentVsyncId =
            if (presentedCurrent && lastNextVsyncId != 0L) lastNextVsyncId else lastVsyncId
        val nextVsyncId =
            if (presentedCurrent && lastNextVsyncId != 0L) lastNextVsyncId + vsyncStep
            else if (lastNextVsyncId != 0L) lastNextVsyncId
            else if (lastVsyncId == 0L) 0L
            else lastVsyncId + 1L
        val currentDeadline =
            if (presentedCurrent && lastNextPresentDeadline != 0L) lastNextPresentDeadline
            else lastExpectedPresentNanos
        val nextDeadline =
            if (presentedCurrent && lastNextPresentDeadline != 0L) {
                lastNextPresentDeadline + lastPeriodNanos
            } else if (lastNextPresentDeadline != 0L) lastNextPresentDeadline
            else if (lastExpectedPresentNanos == 0L) 0L
            else lastExpectedPresentNanos + lastPeriodNanos
        val inputCutoff =
            if (presentedCurrent) lastDeadlineNanos + lastPeriodNanos else lastDeadlineNanos
        Trace.beginSection("nt.input.enqueue")
        try {
            for (sample in samples) {
                val seq = nextSeq.getAndIncrement()
                queue.tryPush(sample)
                nativeSink?.tryPush(
                    sample.pointerId,
                    jniKind(sample.kind),
                    sample.x,
                    sample.y,
                    sample.timeNanos,
                )
                val target =
                    PresentationInputMapping.assignFrameTarget(
                        eventTime = sample.timeNanos,
                        inputCutoff = inputCutoff,
                        callbackTime = lastVsyncNanos,
                        currentVsyncId = currentVsyncId,
                        currentPresentDeadline = currentDeadline,
                        nextVsyncId = nextVsyncId,
                        nextPresentDeadline = nextDeadline,
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
                        " pointer=${sample.pointerId} kind=${sample.kind} enqueueNs=$enqueueNs callbackVsyncId=$currentVsyncId",
                )
            }
        } finally {
            Trace.endSection()
        }
        return true
    }

    fun loseFocus(timeNanos: Long = lastVsyncNanos) {
        queue.cancelAll(timeNanos)
        nativeSink?.loseFocus(timeNanos)
    }

    fun loseWindow(timeNanos: Long = lastVsyncNanos) {
        queue.cancelAll(timeNanos)
        nativeSink?.loseFocus(timeNanos)
    }

    fun recreateSurface(timeNanos: Long = lastVsyncNanos) {
        queue.cancelAll(timeNanos)
        nativeSink?.loseFocus(timeNanos)
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

        fun jniKind(kind: PresentationInputMapping.Kind): Int =
            when (kind) {
                PresentationInputMapping.Kind.Down -> 0
                PresentationInputMapping.Kind.Up -> 1
                PresentationInputMapping.Kind.Cancel -> 3
                PresentationInputMapping.Kind.Move -> 2
            }

        const val TAG: String = "NeoTavernI2P"
    }
}
