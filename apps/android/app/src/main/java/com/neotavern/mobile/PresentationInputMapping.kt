package com.neotavern.mobile

/**
 * Pure MotionEvent → compositor sample mapping (no android.view.*).
 * Debug/flagged hosts expand events here; production [MainActivity] does not
 * call this. Coordinates stay screen-space. No global inverse scroll.
 */
object PresentationInputMapping {
    const val ACTION_DOWN: Int = 0
    const val ACTION_UP: Int = 1
    const val ACTION_MOVE: Int = 2
    const val ACTION_CANCEL: Int = 3
    const val ACTION_POINTER_DOWN: Int = 5
    const val ACTION_POINTER_UP: Int = 6
    const val ACTION_MASK: Int = 0xff
    const val ACTION_POINTER_INDEX_SHIFT: Int = 8
    const val ACTION_POINTER_INDEX_MASK: Int = 0xff00
    const val QUEUE_CAP: Int = 64
    const val EDGE_RESERVE: Int = 8
    const val EVENT_TIME_NANOS_SDK: Int = 34

    enum class Kind {
        Down,
        Move,
        Up,
        Cancel,
    }

    data class Sample(
        val pointerId: Int,
        val kind: Kind,
        val x: Float,
        val y: Float,
        val timeNanos: Long,
    )

    data class MotionFrame(
        val action: Int,
        val pointerCount: Int,
        val eventTimeNanos: Long,
        val pointerIds: IntArray,
        val xs: FloatArray,
        val ys: FloatArray,
        val historicalTimesNanos: LongArray = LongArray(0),
        val historicalXs: FloatArray = FloatArray(0),
        val historicalYs: FloatArray = FloatArray(0),
    )

    data class QueueStats(
        val pushed: Int,
        val accepted: Int,
        val coalescedMoves: Int,
        val droppedMoves: Int,
        val droppedEdges: Int,
        val highWater: Int,
        val current: Int,
    )

    fun presentationTimeFromVsync(frameTimeNanos: Long): Long = frameTimeNanos

    /**
     * `MotionEvent.getEventTimeNanos()` exists from API 34. Older devices
     * keep millisecond `eventTime` scaled to nanos so the compositor clock
     * stays duration-based across 60/90/120 Hz.
     */
    fun sampleTimeNanos(eventTimeMs: Long, eventTimeNanos: Long, sdkInt: Int): Long =
        if (sdkInt >= EVENT_TIME_NANOS_SDK) eventTimeNanos else eventTimeMs * 1_000_000L

    fun expand(frame: MotionFrame, out: MutableList<Sample>) {
        val count = minOf(frame.pointerCount, frame.pointerIds.size, frame.xs.size, frame.ys.size)
        if (count == 0) return
        val masked = frame.action and ACTION_MASK
        val index = (frame.action and ACTION_POINTER_INDEX_MASK) shr ACTION_POINTER_INDEX_SHIFT
        if (masked == ACTION_MOVE) {
            val history = frame.historicalTimesNanos.size
            for (h in 0 until history) {
                val time = frame.historicalTimesNanos[h]
                for (p in 0 until count) {
                    val base = h * count + p
                    if (base >= frame.historicalXs.size || base >= frame.historicalYs.size) return
                    out.add(
                        Sample(
                            pointerId = frame.pointerIds[p],
                            kind = Kind.Move,
                            x = frame.historicalXs[base],
                            y = frame.historicalYs[base],
                            timeNanos = time,
                        ),
                    )
                }
            }
            for (p in 0 until count) {
                out.add(
                    Sample(
                        pointerId = frame.pointerIds[p],
                        kind = Kind.Move,
                        x = frame.xs[p],
                        y = frame.ys[p],
                        timeNanos = frame.eventTimeNanos,
                    ),
                )
            }
            return
        }
        val kind = when (masked) {
            ACTION_DOWN, ACTION_POINTER_DOWN -> Kind.Down
            ACTION_UP, ACTION_POINTER_UP -> Kind.Up
            ACTION_CANCEL -> Kind.Cancel
            else -> return
        }
        if (masked == ACTION_CANCEL) {
            for (p in 0 until count) {
                out.add(
                    Sample(
                        pointerId = frame.pointerIds[p],
                        kind = Kind.Cancel,
                        x = frame.xs[p],
                        y = frame.ys[p],
                        timeNanos = frame.eventTimeNanos,
                    ),
                )
            }
            return
        }
        val p = index.coerceIn(0, (count - 1).coerceAtLeast(0))
        out.add(
            Sample(
                pointerId = frame.pointerIds[p],
                kind = kind,
                x = frame.xs[p],
                y = frame.ys[p],
                timeNanos = frame.eventTimeNanos,
            ),
        )
    }

    data class FrameTarget(
        val eventTime: Long,
        val inputCutoff: Long,
        val callbackTime: Long,
        val targetVsyncId: Long,
        val targetPresentDeadline: Long,
        val eligibleForCurrentVsync: Boolean,
    )

    data class CoalescedLatencyTimes(
        val newestEventTime: Long,
        val oldestHistoricalEventTime: Long,
    )

    /**
     * Input after [inputCutoff] is not eligible for the current vsync and
     * must target the next FrameTimeline cookie. That can make raw
     * input-to-present longer than one refresh without an application miss.
     */
    fun assignFrameTarget(
        eventTime: Long,
        inputCutoff: Long,
        callbackTime: Long,
        currentVsyncId: Long,
        currentPresentDeadline: Long,
        nextVsyncId: Long,
        nextPresentDeadline: Long,
    ): FrameTarget {
        val eligible = eventTime <= inputCutoff
        return FrameTarget(
            eventTime = eventTime,
            inputCutoff = inputCutoff,
            callbackTime = callbackTime,
            targetVsyncId = if (eligible) currentVsyncId else nextVsyncId,
            targetPresentDeadline =
                if (eligible) currentPresentDeadline else nextPresentDeadline,
            eligibleForCurrentVsync = eligible,
        )
    }

    fun coalescedLatencyTimes(frame: MotionFrame): CoalescedLatencyTimes {
        val oldest = frame.historicalTimesNanos.minOrNull() ?: frame.eventTimeNanos
        return CoalescedLatencyTimes(
            newestEventTime = frame.eventTimeNanos,
            oldestHistoricalEventTime = oldest,
        )
    }

    fun deadlineMiss(
        rendererControlled: Boolean,
        actualPresentTime: Long,
        targetPresentDeadline: Long,
    ): Boolean = rendererControlled && actualPresentTime > targetPresentDeadline

    fun inputToPresent(actualPresentTime: Long, eventTime: Long): Long =
        actualPresentTime - eventTime

    fun gestureAge(actualPresentTime: Long, oldestHistoricalEventTime: Long): Long =
        actualPresentTime - oldestHistoricalEventTime

    /**
     * §14: a frame leaves the renderer-controlled denominator only with a
     * traced OS/driver/external reason. `unknown` stays application-caused.
     */
    fun rendererControlledForDenominator(
        rendererControlled: Boolean,
        exclusionReason: String?,
    ): Boolean {
        if (!rendererControlled) {
            val reason = exclusionReason?.trim().orEmpty()
            if (reason.isEmpty() || reason == "unknown") return true
            return false
        }
        return true
    }

    fun formatI2pCookies(
        eventTime: Long,
        inputCutoff: Long,
        callbackTime: Long,
        targetVsyncId: Long,
        targetPresentDeadline: Long,
        actualPresentTime: String,
        eligibleForCurrentVsync: Boolean,
        rendererControlled: String,
        exclusionReason: String,
        newestEventTime: Long,
        oldestHistoricalEventTime: Long,
    ): String =
        "eventTime=$eventTime inputCutoff=$inputCutoff callbackTime=$callbackTime " +
            "targetVsyncId=$targetVsyncId targetPresentDeadline=$targetPresentDeadline " +
            "actualPresentTime=$actualPresentTime eligibleForCurrentVsync=$eligibleForCurrentVsync " +
            "rendererControlled=$rendererControlled exclusionReason=$exclusionReason " +
            "newestEventTime=$newestEventTime oldestHistoricalEventTime=$oldestHistoricalEventTime"
}

class PresentationInputQueue(
    private val cap: Int = PresentationInputMapping.QUEUE_CAP,
    private val edgeReserve: Int = PresentationInputMapping.EDGE_RESERVE,
) {
    private val slots = ArrayList<PresentationInputMapping.Sample>(cap)
    private val tracked = LinkedHashMap<Int, PresentationInputMapping.Sample>()
    private var pushed = 0
    private var accepted = 0
    private var coalescedMoves = 0
    private var droppedMoves = 0
    private var droppedEdges = 0
    private var highWater = 0

    fun tryPush(sample: PresentationInputMapping.Sample): String {
        pushed += 1
        if (sample.kind == PresentationInputMapping.Kind.Move) {
            val lastMove = slots.indexOfLast {
                it.pointerId == sample.pointerId && it.kind == PresentationInputMapping.Kind.Move
            }
            if (lastMove >= 0) {
                slots[lastMove] = sample
                track(sample)
                coalescedMoves += 1
                accepted += 1
                return "coalesced"
            }
            val moveCount = slots.count { it.kind == PresentationInputMapping.Kind.Move }
            if (slots.size >= cap || moveCount >= cap - edgeReserve) {
                val oldestMove = slots.indexOfFirst { it.kind == PresentationInputMapping.Kind.Move }
                if (oldestMove >= 0) {
                    slots.removeAt(oldestMove)
                    droppedMoves += 1
                } else {
                    droppedMoves += 1
                    return "dropped-move"
                }
            }
        } else if (slots.size >= cap) {
            val oldestMove = slots.indexOfFirst { it.kind == PresentationInputMapping.Kind.Move }
            if (oldestMove >= 0) {
                slots.removeAt(oldestMove)
                droppedMoves += 1
            } else {
                droppedEdges += 1
                return "dropped-edge"
            }
        }
        if (slots.size >= cap) {
            if (sample.kind == PresentationInputMapping.Kind.Move) {
                droppedMoves += 1
                return "dropped-move"
            }
            droppedEdges += 1
            return "dropped-edge"
        }
        slots.add(sample)
        track(sample)
        accepted += 1
        highWater = maxOf(highWater, slots.size)
        return "queued"
    }

    fun cancelAll(timeNanos: Long) {
        val live = tracked.values.toList()
        for (last in live) {
            tryPush(
                PresentationInputMapping.Sample(
                    pointerId = last.pointerId,
                    kind = PresentationInputMapping.Kind.Cancel,
                    x = last.x,
                    y = last.y,
                    timeNanos = timeNanos,
                ),
            )
        }
    }

    fun drain(): List<PresentationInputMapping.Sample> {
        val out = slots.toList()
        slots.clear()
        return out
    }

    fun stats(): PresentationInputMapping.QueueStats =
        PresentationInputMapping.QueueStats(
            pushed = pushed,
            accepted = accepted,
            coalescedMoves = coalescedMoves,
            droppedMoves = droppedMoves,
            droppedEdges = droppedEdges,
            highWater = highWater,
            current = slots.size,
        )

    private fun track(sample: PresentationInputMapping.Sample) {
        when (sample.kind) {
            PresentationInputMapping.Kind.Down, PresentationInputMapping.Kind.Move ->
                tracked[sample.pointerId] = sample
            PresentationInputMapping.Kind.Up, PresentationInputMapping.Kind.Cancel ->
                tracked.remove(sample.pointerId)
        }
    }
}
