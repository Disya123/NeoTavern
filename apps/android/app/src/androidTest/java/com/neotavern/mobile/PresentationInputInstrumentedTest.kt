package com.neotavern.mobile

import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.atomic.AtomicReference

/**
 * Debug-host MotionEvent / Choreographer adapter on a real device/emulator.
 * Does **not** launch [MainActivity] or touch production JNI / WebView.
 * Physical input-to-present Perfetto is a later adjudication.
 */
@RunWith(AndroidJUnit4::class)
class PresentationInputInstrumentedTest {

    @Test
    fun downKeepsScreenCoordinatesPointerIdAndEventTime() {
        val adapter = adapterOnMain()
        val downTime = SystemClock.uptimeMillis()
        val event = MotionEvent.obtain(downTime, downTime + 8, MotionEvent.ACTION_DOWN, 42f, 63f, 0)
        try {
            assertTrue(adapter.onTouch(event))
            val samples = adapter.queue.drain()
            assertEquals(1, samples.size)
            assertEquals(0, samples[0].pointerId)
            assertEquals(PresentationInputMapping.Kind.Down, samples[0].kind)
            assertEquals(42f, samples[0].x, 0.01f)
            assertEquals(63f, samples[0].y, 0.01f)
            assertEquals(
                PresentationInputAdapter.sampleTimeNanos(event),
                samples[0].timeNanos,
            )
        } finally {
            event.recycle()
            stop(adapter)
        }
    }

    @Test
    fun pointerIndexRemapKeepsAndroidId() {
        val adapter = adapterOnMain()
        val downTime = SystemClock.uptimeMillis()
        val event = twoPointers(
            downTime,
            MotionEvent.ACTION_POINTER_DOWN or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT),
            intArrayOf(2, 7),
            floatArrayOf(10f, 40f),
            floatArrayOf(11f, 41f),
        )
        try {
            adapter.onTouch(event)
            val samples = adapter.queue.drain()
            assertEquals(1, samples.size)
            assertEquals(7, samples[0].pointerId)
            assertEquals(PresentationInputMapping.Kind.Down, samples[0].kind)
        } finally {
            event.recycle()
            stop(adapter)
        }
    }

    @Test
    fun historicalMoveKeepsOriginalTimestamps() {
        val adapter = adapterOnMain()
        val downTime = SystemClock.uptimeMillis()
        val move = MotionEvent.obtain(downTime, downTime + 4, MotionEvent.ACTION_MOVE, 1f, 1f, 0)
        try {
            move.addBatch(downTime + 8, 2f, 3f, 1f, 1f, 0)
            adapter.onTouch(move)
            val samples = adapter.queue.drain()
            assertTrue(samples.size >= 2)
            assertTrue(samples.all { it.kind == PresentationInputMapping.Kind.Move })
            assertTrue(samples.last().timeNanos >= samples.first().timeNanos)
            assertEquals(2f, samples.last().x, 0.01f)
        } finally {
            move.recycle()
            stop(adapter)
        }
    }

    @Test
    fun tenThousandMovesStayBoundedAndKeepDownUp() {
        val adapter = adapterOnMain()
        val downTime = SystemClock.uptimeMillis()
        dispatch(adapter, downTime, MotionEvent.ACTION_DOWN, 0f, 0f)
        repeat(10_000) { i ->
            dispatch(adapter, downTime + 1 + i, MotionEvent.ACTION_MOVE, 0f, i.toFloat())
        }
        dispatch(adapter, downTime + 20_000, MotionEvent.ACTION_UP, 0f, 10_000f)
        val stats = adapter.queue.stats()
        assertTrue(stats.highWater <= PresentationInputMapping.QUEUE_CAP)
        assertEquals(0, stats.droppedEdges)
        val drained = adapter.queue.drain()
        assertTrue(drained.any { it.kind == PresentationInputMapping.Kind.Down })
        assertTrue(drained.any { it.kind == PresentationInputMapping.Kind.Up })
        stop(adapter)
    }

    @Test
    fun choreographerFrameTimeMapsToPresentationTime() {
        val adapter = adapterOnMain()
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            adapter.startFrameCallbacks()
        }
        val deadline = SystemClock.uptimeMillis() + 500
        while (SystemClock.uptimeMillis() < deadline && adapter.lastVsyncNanos == 0L) {
            Thread.sleep(16)
        }
        val vsync = adapter.lastVsyncNanos
        assertTrue("Choreographer callback", vsync > 0)
        assertEquals(vsync, PresentationInputMapping.presentationTimeFromVsync(vsync))
        stop(adapter)
    }

    @Test
    fun focusLossSynthesizesCancelWithoutMainActivity() {
        val adapter = adapterOnMain()
        val downTime = SystemClock.uptimeMillis()
        dispatch(adapter, downTime, MotionEvent.ACTION_DOWN, 12f, 24f)
        adapter.loseFocus(1_000_000L)
        val kinds = adapter.queue.drain().map { it.kind }
        assertTrue(kinds.contains(PresentationInputMapping.Kind.Down))
        assertTrue(kinds.contains(PresentationInputMapping.Kind.Cancel))
        stop(adapter)
    }

    @Test
    fun debugActivityReceivesTouchAndDoesNotOpenMainActivity() {
        val scenario = ActivityScenario.launch(PresentationInputActivity::class.java)
        try {
            scenario.onActivity { activity ->
                assertTrue(activity is PresentationInputActivity)
                assertTrue(activity.javaClass.name.endsWith("PresentationInputActivity"))
                val downTime = SystemClock.uptimeMillis()
                val down = MotionEvent.obtain(
                    downTime,
                    downTime,
                    MotionEvent.ACTION_DOWN,
                    8f,
                    9f,
                    0,
                )
                try {
                    activity.dispatchTouchEvent(down)
                } finally {
                    down.recycle()
                }
            }
        } finally {
            scenario.close()
        }
    }

    private fun adapterOnMain(): PresentationInputAdapter {
        val box = AtomicReference<PresentationInputAdapter>()
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            box.set(PresentationInputAdapter())
        }
        return box.get()
    }

    private fun stop(adapter: PresentationInputAdapter) {
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            adapter.stopFrameCallbacks()
        }
    }

    private fun dispatch(
        adapter: PresentationInputAdapter,
        eventTime: Long,
        action: Int,
        x: Float,
        y: Float,
    ) {
        val event = MotionEvent.obtain(eventTime, eventTime, action, x, y, 0)
        try {
            adapter.onTouch(event)
        } finally {
            event.recycle()
        }
    }

    private fun twoPointers(
        downTime: Long,
        action: Int,
        ids: IntArray,
        xs: FloatArray,
        ys: FloatArray,
    ): MotionEvent {
        val props = Array(ids.size) { i ->
            MotionEvent.PointerProperties().apply {
                id = ids[i]
                toolType = MotionEvent.TOOL_TYPE_FINGER
            }
        }
        val coords = Array(ids.size) { i ->
            MotionEvent.PointerCoords().apply {
                x = xs[i]
                y = ys[i]
                pressure = 1f
                size = 1f
            }
        }
        return MotionEvent.obtain(
            downTime,
            downTime,
            action,
            ids.size,
            props,
            coords,
            0,
            0,
            1f,
            1f,
            0,
            0,
            InputDevice.SOURCE_TOUCHSCREEN,
            0,
        )
    }
}