package com.neotavern.mobile

/**
 * M-1 rAF sampler. PURE Kotlin so enablement and the injected bootstrap are
 * unit-tested on the JVM. Off by default: a 30 s rAF loop would itself
 * perturb the thing we measure. Opt-in via [EXTRA] = `on`.
 *
 * The script logs one `console.info` line prefixed `m1-frames`. Expected Hz
 * is a clamped integer from the host refresh policy — never interpolated
 * from the activity extra.
 */
object MeasurementFrames {

    const val EXTRA = "com.neotavern.mobile.MEASUREMENT_FRAMES"

    const val SAMPLE_MS = 30_000

    const val MIN_HZ = 1

    const val MAX_HZ = 240

    const val LOG_PREFIX = "m1-frames"

    /** A frame later than this multiple of the vsync budget counts as missed. */
    const val MISS_BUDGET_FACTOR = 1.5

    fun enabled(extra: String?): Boolean {
        val value = extra?.trim()?.lowercase().orEmpty()
        return value == "on" || value == "1" || value == "true" || value == "frames"
    }

    fun clampExpectedHz(requestedHz: Float?): Int {
        val hz = requestedHz?.toInt() ?: 60
        return hz.coerceIn(MIN_HZ, MAX_HZ)
    }

    fun bootstrapJs(expectedHz: Int): String {
        val hz = expectedHz.coerceIn(MIN_HZ, MAX_HZ)
        return "(function(){" +
            "var expected=$hz;" +
            "var sampleMs=$SAMPLE_MS;" +
            "var start=performance.now();" +
            "var last=start;" +
            "var frames=0;" +
            "var misses=0;" +
            "var streak=0;" +
            "var longest=0;" +
            "var budget=1000/expected;" +
            "function tick(now){" +
            "frames++;" +
            "var dt=now-last;" +
            "last=now;" +
            "if(dt>budget*$MISS_BUDGET_FACTOR){" +
            "var n=Math.round(dt/budget)-1;" +
            "if(n>0){misses+=n;streak+=n;if(streak>longest)longest=streak;}" +
            "}else{streak=0;}" +
            "if(now-start<sampleMs)requestAnimationFrame(tick);" +
            "else console.info('$LOG_PREFIX '+JSON.stringify({" +
            "expected_hz:expected," +
            "duration_ms:Math.round(now-start)," +
            "frames:frames," +
            "callback_hz:+(frames/((now-start)/1000)).toFixed(2)," +
            "misses:misses," +
            "longest_streak:longest" +
            "}));" +
            "}" +
            "requestAnimationFrame(tick);" +
            "})()"
    }
}
