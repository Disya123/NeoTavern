package com.neotavern.mobile

import android.os.SystemClock
import android.util.Log
import android.view.MotionEvent

/**
 * Programmatic MotionEvent fixture for the debug input-to-present host.
 * Not production input. Physical velocity matches PERF-20 (10_000 px/s).
 */
class PresentationInputFixture(
    private val activity: PresentationInputActivity,
    private val adapter: PresentationInputAdapter,
    private val warmupMs: Long,
    private val scrollMs: Long,
) {
    fun run(name: String) {
        try {
            waitForVsync()
            when (name) {
                "all" -> runAll()
                else -> runNamed(name)
            }
            log("i2p fixture done status=ok name=$name")
        } catch (err: InterruptedException) {
            Thread.currentThread().interrupt()
            log("i2p fixture done status=interrupted name=$name")
        } catch (err: Throwable) {
            log("i2p fixture done status=failed name=$name reason=${err.javaClass.simpleName}")
        }
    }

    private fun runAll() {
        runNamed("refresh_120")
        runNamed("scroll_fling")
        runNamed("nested_handoff")
        runNamed("sticky_fixed")
        runNamed("selection_autoscroll")
        runNamed("coalesced_move")
        runNamed("focus_cancel")
        runNamed("refresh_60")
        runNamed("refresh_90")
        runNamed("refresh_transition")
    }

    private fun runNamed(name: String) {
        phase(name, "start")
        when (name) {
            "scroll_fling" -> scrollFling()
            "nested_handoff" -> nestedHandoff()
            "sticky_fixed" -> stickyFixed()
            "selection_autoscroll" -> selectionAutoscroll()
            "coalesced_move" -> coalescedMove()
            "focus_cancel" -> focusCancel()
            "refresh_60" -> pacedRefresh(60f)
            "refresh_90" -> pacedRefresh(90f)
            "refresh_120" -> locked120()
            "refresh_transition" -> refreshTransition()
            else -> scrollFling()
        }
        phase(name, "end")
    }

    private fun locked120() {
        activity.runOnUiThread { activity.applyRefresh(120f) }
        sleep(250)
        val requested = activity.requestedHz() ?: 120f
        val observed = activity.observedHz()
        log("i2p display requestedHz=$requested observedHz=$observed scenario=refresh_120")
        warmupScroll(warmupMs)
        phase("continuous_scroll", "start")
        continuousScroll(scrollMs)
        phase("continuous_scroll", "end")
    }

    private fun pacedRefresh(hz: Float) {
        activity.runOnUiThread { activity.applyRefresh(hz) }
        sleep(250)
        log("i2p display requestedHz=$hz observedHz=${activity.observedHz()} scenario=refresh_${hz.toInt()}")
        continuousScroll(2_000)
        activity.runOnUiThread { activity.applyRefresh(120f) }
        sleep(250)
    }

    private fun refreshTransition() {
        activity.runOnUiThread { activity.applyRefresh(60f) }
        sleep(200)
        continuousScroll(800)
        activity.runOnUiThread { activity.applyRefresh(120f) }
        sleep(200)
        continuousScroll(800)
        activity.runOnUiThread { activity.applyRefresh(90f) }
        sleep(200)
        continuousScroll(800)
        activity.runOnUiThread { activity.applyRefresh(120f) }
        sleep(200)
    }

    private fun scrollFling() {
        val downTime = SystemClock.uptimeMillis()
        dispatch(downTime, downTime, MotionEvent.ACTION_DOWN, X, Y)
        var y = Y
        var t = downTime
        repeat(24) {
            t += 8
            y -= 80f
            dispatch(downTime, t, MotionEvent.ACTION_MOVE, X, y)
            sleep(8)
        }
        dispatch(downTime, t + 8, MotionEvent.ACTION_UP, X, y - 80f)
        sleep(120)
    }

    private fun nestedHandoff() {
        val downTime = SystemClock.uptimeMillis()
        dispatch(downTime, downTime, MotionEvent.ACTION_DOWN, X, Y)
        var x = X
        var t = downTime
        repeat(12) {
            t += 8
            x += 40f
            dispatch(downTime, t, MotionEvent.ACTION_MOVE, x, Y)
            sleep(8)
        }
        var y = Y
        repeat(12) {
            t += 8
            y -= 40f
            dispatch(downTime, t, MotionEvent.ACTION_MOVE, x, y)
            sleep(8)
        }
        dispatch(downTime, t + 8, MotionEvent.ACTION_UP, x, y)
        sleep(80)
    }

    private fun stickyFixed() {
        val downTime = SystemClock.uptimeMillis()
        dispatch(downTime, downTime, MotionEvent.ACTION_DOWN, 60f, 60f)
        dispatch(downTime, downTime + 16, MotionEvent.ACTION_UP, 60f, 60f)
        sleep(40)
        continuousScroll(600)
    }

    private fun selectionAutoscroll() {
        val downTime = SystemClock.uptimeMillis()
        val edgeY = 2_200f
        dispatch(downTime, downTime, MotionEvent.ACTION_DOWN, X, edgeY)
        var t = downTime
        repeat(20) {
            t += 8
            dispatch(downTime, t, MotionEvent.ACTION_MOVE, X, edgeY + it)
            sleep(8)
        }
        dispatch(downTime, t + 8, MotionEvent.ACTION_UP, X, edgeY)
        sleep(80)
    }

    private fun coalescedMove() {
        val downTime = SystemClock.uptimeMillis()
        val down = obtain(downTime, downTime, MotionEvent.ACTION_DOWN, X, Y)
        dispatchEvent(down)
        down.recycle()
        val move = obtain(downTime, downTime + 4, MotionEvent.ACTION_MOVE, X, Y - 10f)
        move.addBatch(downTime + 8, X, Y - 20f, 1f, 1f, 0)
        move.addBatch(downTime + 12, X, Y - 30f, 1f, 1f, 0)
        dispatchEvent(move)
        move.recycle()
        val up = obtain(downTime, downTime + 16, MotionEvent.ACTION_UP, X, Y - 30f)
        dispatchEvent(up)
        up.recycle()
        sleep(80)
    }

    private fun focusCancel() {
        val downTime = SystemClock.uptimeMillis()
        dispatch(downTime, downTime, MotionEvent.ACTION_DOWN, X, Y)
        sleep(16)
        activity.runOnUiThread { adapter.loseFocus(SystemClock.uptimeNanos()) }
        val cancel = obtain(downTime, SystemClock.uptimeMillis(), MotionEvent.ACTION_CANCEL, X, Y)
        dispatchEvent(cancel)
        cancel.recycle()
        sleep(80)
    }

    private fun warmupScroll(durationMs: Long) {
        phase("warmup", "start")
        continuousScroll(durationMs)
        phase("warmup", "end")
    }

    private fun continuousScroll(durationMs: Long) {
        val downTime = SystemClock.uptimeMillis()
        dispatch(downTime, downTime, MotionEvent.ACTION_DOWN, X, Y)
        val end = downTime + durationMs
        var y = Y
        var t = downTime
        while (SystemClock.uptimeMillis() < end && !Thread.currentThread().isInterrupted) {
            t += FRAME_MS
            y -= PX_PER_FRAME
            if (y < 80f) y = Y
            dispatch(downTime, t, MotionEvent.ACTION_MOVE, X, y)
            sleep(FRAME_MS)
        }
        dispatch(downTime, t + FRAME_MS, MotionEvent.ACTION_UP, X, y)
        sleep(FRAME_MS)
    }

    private fun waitForVsync() {
        val deadline = SystemClock.uptimeMillis() + 3_000
        while (SystemClock.uptimeMillis() < deadline && adapter.lastVsyncNanos == 0L) {
            sleep(16)
        }
    }

    private fun dispatch(downTime: Long, eventTime: Long, action: Int, x: Float, y: Float) {
        val event = obtain(downTime, eventTime, action, x, y)
        try {
            dispatchEvent(event)
        } finally {
            event.recycle()
        }
    }

    private fun dispatchEvent(event: MotionEvent) {
        val copy = MotionEvent.obtain(event)
        activity.runOnUiThread {
            try {
                activity.dispatchTouchEvent(copy)
            } finally {
                copy.recycle()
            }
        }
    }

    private fun obtain(downTime: Long, eventTime: Long, action: Int, x: Float, y: Float): MotionEvent =
        MotionEvent.obtain(downTime, eventTime, action, x, y, 0)

    private fun sleep(ms: Long) {
        if (ms <= 0L) return
        Thread.sleep(ms)
    }

    private fun phase(name: String, phase: String) {
        log(
            "i2p scenario=$name phase=$phase tNs=${SystemClock.uptimeNanos()} observedHz=${activity.observedHz()}",
        )
    }

    private fun log(line: String) {
        Log.i(PresentationInputAdapter.TAG, line)
    }

    companion object {
        private const val X = 540f
        private const val Y = 1_000f
        private const val FRAME_MS = 8L
        private const val PX_PER_FRAME = 80f
    }
}
