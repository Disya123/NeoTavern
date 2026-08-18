package com.neotavern.mobile

/**
 * JNI surface for the debug Milestone C chat route.
 * Loads [libneotavern_presentation_perf_probe.so] — not production JNI.
 */
object PresentationChatProbe {
    init {
        System.loadLibrary("neotavern_presentation_perf_probe")
    }

    @JvmStatic
    external fun startRoute(flag: String): String
}
