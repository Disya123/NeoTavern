package com.neotavern.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PresentationInputMappingTest {

    @Test
    fun `eventTimeNanos is the sample timestamp`() {
        val out = ArrayList<PresentationInputMapping.Sample>()
        PresentationInputMapping.expand(
            PresentationInputMapping.MotionFrame(
                action = PresentationInputMapping.ACTION_DOWN,
                pointerCount = 1,
                eventTimeNanos = 1234L,
                pointerIds = intArrayOf(3),
                xs = floatArrayOf(10f),
                ys = floatArrayOf(20f),
            ),
            out,
        )
        assertEquals(1, out.size)
        assertEquals(1234L, out[0].timeNanos)
        assertEquals(3, out[0].pointerId)
        assertEquals(PresentationInputMapping.Kind.Down, out[0].kind)
    }

    @Test
    fun `historical moves keep original timestamps`() {
        val out = ArrayList<PresentationInputMapping.Sample>()
        PresentationInputMapping.expand(
            PresentationInputMapping.MotionFrame(
                action = PresentationInputMapping.ACTION_MOVE,
                pointerCount = 1,
                eventTimeNanos = 30L,
                pointerIds = intArrayOf(1),
                xs = floatArrayOf(3f),
                ys = floatArrayOf(4f),
                historicalTimesNanos = longArrayOf(10L, 20L),
                historicalXs = floatArrayOf(1f, 2f),
                historicalYs = floatArrayOf(1f, 2f),
            ),
            out,
        )
        assertEquals(3, out.size)
        assertEquals(10L, out[0].timeNanos)
        assertEquals(20L, out[1].timeNanos)
        assertEquals(30L, out[2].timeNanos)
    }

    @Test
    fun `pointer index remap keeps android id`() {
        val out = ArrayList<PresentationInputMapping.Sample>()
        PresentationInputMapping.expand(
            PresentationInputMapping.MotionFrame(
                action = PresentationInputMapping.ACTION_POINTER_DOWN or
                    (1 shl PresentationInputMapping.ACTION_POINTER_INDEX_SHIFT),
                pointerCount = 2,
                eventTimeNanos = 5L,
                pointerIds = intArrayOf(2, 7),
                xs = floatArrayOf(10f, 40f),
                ys = floatArrayOf(11f, 41f),
            ),
            out,
        )
        assertEquals(1, out.size)
        assertEquals(7, out[0].pointerId)
        assertEquals(PresentationInputMapping.Kind.Down, out[0].kind)
    }

    @Test
    fun `ten thousand moves stay bounded and never drop edges`() {
        val queue = PresentationInputQueue()
        assertEquals("queued", queue.tryPush(down(1, 0f, 0f, 0L)))
        repeat(10_000) { i ->
            queue.tryPush(move(1, 0f, i.toFloat(), (i + 1).toLong()))
        }
        assertEquals("queued", queue.tryPush(up(1, 0f, 10_000f, 11_000L)))
        val stats = queue.stats()
        assertTrue(stats.highWater <= PresentationInputMapping.QUEUE_CAP)
        assertTrue(stats.coalescedMoves + stats.droppedMoves > 0)
        assertEquals(0, stats.droppedEdges)
        val drained = queue.drain()
        assertTrue(drained.any { it.kind == PresentationInputMapping.Kind.Down })
        assertTrue(drained.any { it.kind == PresentationInputMapping.Kind.Up })
    }

    @Test
    fun `choreographer frame time maps 1-1`() {
        assertEquals(16_666_667L, PresentationInputMapping.presentationTimeFromVsync(16_666_667L))
    }

    @Test
    fun `input after cutoff targets the next vsync`() {
        val target =
            PresentationInputMapping.assignFrameTarget(
                eventTime = 3_000L,
                inputCutoff = 2_000L,
                callbackTime = 1_500L,
                currentVsyncId = 440L,
                currentPresentDeadline = 8_333_333L,
                nextVsyncId = 441L,
                nextPresentDeadline = 16_666_666L,
            )
        assertEquals(false, target.eligibleForCurrentVsync)
        assertEquals(441L, target.targetVsyncId)
        assertEquals(16_666_666L, target.targetPresentDeadline)
    }

    @Test
    fun `coalesced primary latency uses newest sample`() {
        val times =
            PresentationInputMapping.coalescedLatencyTimes(
                PresentationInputMapping.MotionFrame(
                    action = PresentationInputMapping.ACTION_MOVE,
                    pointerCount = 1,
                    eventTimeNanos = 30L,
                    pointerIds = intArrayOf(1),
                    xs = floatArrayOf(3f),
                    ys = floatArrayOf(4f),
                    historicalTimesNanos = longArrayOf(10L, 20L),
                    historicalXs = floatArrayOf(1f, 2f),
                    historicalYs = floatArrayOf(1f, 2f),
                ),
            )
        assertEquals(30L, times.newestEventTime)
        assertEquals(10L, times.oldestHistoricalEventTime)
        assertEquals(970L, PresentationInputMapping.inputToPresent(1_000L, times.newestEventTime))
        assertEquals(990L, PresentationInputMapping.gestureAge(1_000L, times.oldestHistoricalEventTime))
    }

    @Test
    fun `deadline miss is renderer controlled late present`() {
        assertEquals(true, PresentationInputMapping.deadlineMiss(true, 9_000L, 8_000L))
        assertEquals(false, PresentationInputMapping.deadlineMiss(false, 9_000L, 8_000L))
        assertEquals(false, PresentationInputMapping.deadlineMiss(true, 7_000L, 8_000L))
    }

    @Test
    fun `unknown exclusion stays application caused`() {
        assertEquals(
            true,
            PresentationInputMapping.rendererControlledForDenominator(false, "unknown"),
        )
        assertEquals(
            true,
            PresentationInputMapping.rendererControlledForDenominator(false, null),
        )
        assertEquals(
            false,
            PresentationInputMapping.rendererControlledForDenominator(false, "os_stall"),
        )
    }

    @Test
    fun `i2p cookies keep the §14 field names`() {
        val line =
            PresentationInputMapping.formatI2pCookies(
                eventTime = 1L,
                inputCutoff = 2L,
                callbackTime = 3L,
                targetVsyncId = 4L,
                targetPresentDeadline = 5L,
                actualPresentTime = "pending",
                eligibleForCurrentVsync = false,
                rendererControlled = "pending",
                exclusionReason = "pending",
                newestEventTime = 1L,
                oldestHistoricalEventTime = 0L,
            )
        assertTrue(line.contains("eventTime=1"))
        assertTrue(line.contains("inputCutoff=2"))
        assertTrue(line.contains("callbackTime=3"))
        assertTrue(line.contains("targetVsyncId=4"))
        assertTrue(line.contains("targetPresentDeadline=5"))
        assertTrue(line.contains("actualPresentTime=pending"))
        assertTrue(line.contains("eligibleForCurrentVsync=false"))
        assertTrue(line.contains("rendererControlled=pending"))
        assertTrue(line.contains("exclusionReason=pending"))
    }

    @Test
    fun `pre-API 34 eventTime is scaled to nanos`() {
        assertEquals(
            16_000_000L,
            PresentationInputMapping.sampleTimeNanos(16L, 99L, 26),
        )
        assertEquals(
            99L,
            PresentationInputMapping.sampleTimeNanos(16L, 99L, 34),
        )
    }

    @Test
    fun `cancel covers every pointer in the frame`() {
        val out = ArrayList<PresentationInputMapping.Sample>()
        PresentationInputMapping.expand(
            PresentationInputMapping.MotionFrame(
                action = PresentationInputMapping.ACTION_CANCEL,
                pointerCount = 2,
                eventTimeNanos = 9L,
                pointerIds = intArrayOf(3, 8),
                xs = floatArrayOf(1f, 2f),
                ys = floatArrayOf(3f, 4f),
            ),
            out,
        )
        assertEquals(2, out.size)
        assertEquals(PresentationInputMapping.Kind.Cancel, out[0].kind)
        assertEquals(8, out[1].pointerId)
    }

    private fun down(id: Int, x: Float, y: Float, t: Long) =
        PresentationInputMapping.Sample(id, PresentationInputMapping.Kind.Down, x, y, t)

    private fun move(id: Int, x: Float, y: Float, t: Long) =
        PresentationInputMapping.Sample(id, PresentationInputMapping.Kind.Move, x, y, t)

    private fun up(id: Int, x: Float, y: Float, t: Long) =
        PresentationInputMapping.Sample(id, PresentationInputMapping.Kind.Up, x, y, t)
}
