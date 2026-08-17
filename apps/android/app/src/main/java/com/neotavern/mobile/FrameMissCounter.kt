package com.neotavern.mobile

import java.util.Locale
import kotlin.math.roundToInt

/**
 * Shared M-1 miss heuristic for the native Choreographer sampler.
 * PURE Kotlin (no android.*) so the 1.5× budget rule is unit-tested on the JVM.
 * The injected rAF script in [MeasurementFrames] uses the same constants.
 */
class FrameMissCounter(expectedHz: Int) {
    private val expectedHz = expectedHz.coerceIn(MeasurementFrames.MIN_HZ, MeasurementFrames.MAX_HZ)
    private val budgetMs = 1000.0 / this.expectedHz.toDouble()
    private var startMs = Double.NaN
    private var lastMs = Double.NaN
    private var frames = 0
    private var misses = 0
    private var streak = 0
    private var longest = 0

    fun record(nowMs: Double) {
        frames += 1
        if (lastMs.isNaN()) {
            startMs = nowMs
            lastMs = nowMs
            return
        }
        val dt = nowMs - lastMs
        lastMs = nowMs
        if (dt > budgetMs * MeasurementFrames.MISS_BUDGET_FACTOR) {
            val skipped = (dt / budgetMs).roundToInt() - 1
            if (skipped > 0) {
                misses += skipped
                streak += skipped
                if (streak > longest) longest = streak
            }
        } else {
            streak = 0
        }
    }

    fun toJson(nowMs: Double): String {
        val durationMs = if (startMs.isNaN()) 0.0 else nowMs - startMs
        val callbackHz = if (durationMs <= 0.0) 0.0 else frames / (durationMs / 1000.0)
        return "{" +
            "\"expected_hz\":$expectedHz," +
            "\"duration_ms\":${durationMs.roundToInt()}," +
            "\"frames\":$frames," +
            "\"callback_hz\":${String.format(Locale.US, "%.2f", callbackHz)}," +
            "\"misses\":$misses," +
            "\"longest_streak\":$longest" +
            "}"
    }
}
