package com.neotavern.mobile

/**
 * Launch extras for the debug-only M0-D1a paint probe. No android.* so JVM
 * unit tests can cover parsing. Production [MainActivity] never reads these.
 */
object M0D1aLaunch {
    const val EXTRA_FRAMES: String = "com.neotavern.mobile.M0_D1A_FRAMES"
    const val DEFAULT_FRAMES: Int = 100
    const val MAX_FRAMES: Int = 1000

    fun parseFrames(extra: String?): Int {
        val raw = extra?.trim().orEmpty()
        if (raw.isEmpty()) {
            return DEFAULT_FRAMES
        }
        val parsed = raw.toIntOrNull() ?: return DEFAULT_FRAMES
        return parsed.coerceIn(1, MAX_FRAMES)
    }

    fun refreshLogLine(
        phase: String,
        supported: String,
        requestedHz: Float?,
        requestedModeId: Int?,
        reason: String,
        observedHz: Float,
        observedModeId: Int,
    ): String {
        val requested = requestedHz?.toString() ?: "-"
        return "m0-d1a-refresh phase=$phase supported=[$supported] requested_hz=$requested " +
            "requested_mode=${requestedModeId ?: "-"} reason=$reason " +
            "observed_hz=$observedHz observed_mode=$observedModeId"
    }
}
