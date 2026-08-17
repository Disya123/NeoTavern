package com.neotavern.mobile

/**
 * Launch extras for the debug-only M0-D2 producer-path probe. No android.*
 * so JVM unit tests can cover parsing. Production [MainActivity] never reads
 * these.
 */
object M0D2Launch {
    const val EXTRA_FRAMES: String = "com.neotavern.mobile.M0_D2_FRAMES"
    const val EXTRA_CAPTURE_FRAME: String = "com.neotavern.mobile.M0_D2_CAPTURE_FRAME"
    const val DEFAULT_FRAMES: Int = 1000
    const val DEFAULT_CAPTURE_FRAME: Int = 120
    const val MAX_FRAMES: Int = 1000

    fun parseFrames(extra: String?): Int {
        val raw = extra?.trim().orEmpty()
        if (raw.isEmpty()) {
            return DEFAULT_FRAMES
        }
        val parsed = raw.toIntOrNull() ?: return DEFAULT_FRAMES
        return parsed.coerceIn(1, MAX_FRAMES)
    }

    /** Negative means no RenderDoc capture. Default is generation 120. */
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
