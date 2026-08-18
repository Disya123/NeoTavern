package com.neotavern.mobile

/**
 * Launch extras for the debug-only PERF-18/19/20 probe. Production
 * [MainActivity] never reads these.
 */
object PresentationPerfLaunch {
    const val EXTRA_SCENARIO: String = "com.neotavern.mobile.PERF_SCENARIO"
    const val EXTRA_FRAMES: String = "com.neotavern.mobile.PERF_FRAMES"
    const val EXTRA_CAPTURE_FRAME: String = "com.neotavern.mobile.PERF_CAPTURE_FRAME"
    const val DEFAULT_SCENARIO: String = "perf18"
    const val DEFAULT_FRAMES: Int = 16
    const val DEFAULT_CAPTURE_FRAME: Int = 2
    const val MAX_FRAMES: Int = 1000

    fun parseScenario(extra: String?): String {
        val raw = extra?.trim().orEmpty().lowercase()
        return when (raw) {
            "perf18", "18" -> "perf18"
            "perf19", "19" -> "perf19"
            "perf20", "20" -> "perf20"
            else -> DEFAULT_SCENARIO
        }
    }

    fun parseFrames(extra: String?): Int {
        val raw = extra?.trim().orEmpty()
        if (raw.isEmpty()) {
            return DEFAULT_FRAMES
        }
        val parsed = raw.toIntOrNull() ?: return DEFAULT_FRAMES
        return parsed.coerceIn(1, MAX_FRAMES)
    }

    fun parseCaptureFrame(extra: String?): Int {
        val raw = extra?.trim().orEmpty()
        if (raw.isEmpty()) {
            return DEFAULT_CAPTURE_FRAME
        }
        val parsed = raw.toIntOrNull() ?: return DEFAULT_CAPTURE_FRAME
        if (parsed < 0) {
            return -1
        }
        return parsed.coerceIn(0, MAX_FRAMES - 1)
    }
}
