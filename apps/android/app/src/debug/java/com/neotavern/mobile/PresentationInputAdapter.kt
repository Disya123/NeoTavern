package com.neotavern.mobile

import android.os.Build
import android.view.Choreographer
import android.view.MotionEvent
import android.view.View

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
    private var posted = false

    fun startFrameCallbacks() {
        if (posted) return
        posted = true
        choreographer.postFrameCallback(this)
    }

    fun stopFrameCallbacks() {
        posted = false
        choreographer.removeFrameCallback(this)
    }

    override fun doFrame(frameTimeNanos: Long) {
        lastVsyncNanos = PresentationInputMapping.presentationTimeFromVsync(frameTimeNanos)
        if (posted) {
            choreographer.postFrameCallback(this)
        }
    }

    fun onTouch(event: MotionEvent): Boolean {
        val samples = ArrayList<PresentationInputMapping.Sample>(8)
        PresentationInputMapping.expand(fromMotionEvent(event), samples)
        for (sample in samples) {
            queue.tryPush(sample)
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
    }
}
