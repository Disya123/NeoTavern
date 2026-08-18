package com.neotavern.mobile

/**
 * Launch extras for the debug-only PERF-18/19/20 and shared-device
 * interop probe. Production [MainActivity] never reads these.
 */
object PresentationPerfLaunch {
    const val EXTRA_SCENARIO: String = "com.neotavern.mobile.PERF_SCENARIO"
    const val EXTRA_FRAMES: String = "com.neotavern.mobile.PERF_FRAMES"
    const val EXTRA_CAPTURE_FRAME: String = "com.neotavern.mobile.PERF_CAPTURE_FRAME"
    const val DEFAULT_SCENARIO: String = "perf18"
    const val DEFAULT_FRAMES: Int = 16
    const val DEFAULT_CAPTURE_FRAME: Int = 2
    const val MAX_FRAMES: Int = 7200

    fun parseScenario(extra: String?): String {
        val raw = extra?.trim().orEmpty().lowercase()
        return when (raw) {
            "perf18", "18" -> "perf18"
            "perf19", "19" -> "perf19"
            "perf20", "20" -> "perf20"
            "interop", "shared", "t18" -> "interop"
            "perf15", "15", "pressure" -> "perf15"
            "perf22", "22", "surface", "perf22-panel", "panel" -> "perf22"
            "perf22-poster", "poster" -> "perf22-poster"
            "perf22-fullscreen", "fullscreen" -> "perf22-fullscreen"
            "perf22-error", "error" -> "perf22-error"
            "recovery", "device-loss", "recovery-raster", "raster_composite" -> "recovery"
            "recovery-fling" -> "recovery-fling"
            "recovery-selection", "selection" -> "recovery-selection"
            "recovery-surface", "surface-recreation" -> "recovery-surface"
            "recovery-background", "background" -> "recovery-background"
            "perf01", "perf01-warm", "01", "01-warm" -> "perf01-warm"
            "perf01-cold", "01-cold" -> "perf01-cold"
            "perf02", "02", "streaming" -> "perf02"
            "perf03", "03", "triple-glass" -> "perf03"
            "perf04", "04", "nested-glass" -> "perf04"
            "perf05", "05", "image-pressure" -> "perf05"
            "perf11", "11", "paint-order" -> "perf11"
            "perf12", "12", "adversarial" -> "perf12"
            "perf13", "13", "reversal", "teleport" -> "perf13"
            "perf14", "14", "async-hit" -> "perf14"
            "perf16", "16", "cold-start" -> "perf16"
            "perf17", "17", "sticky" -> "perf17"
            "perf21", "21", "nested-scroll" -> "perf21"
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
