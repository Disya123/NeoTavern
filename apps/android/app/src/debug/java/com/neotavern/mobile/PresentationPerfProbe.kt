package com.neotavern.mobile

/**
 * JNI surface for `libneotavern_presentation_perf_probe.so` (debug jniLibs).
 * Production [KernelBridge] does not load this library.
 */
object PresentationPerfProbe {
    init {
        System.loadLibrary("neotavern_presentation_perf_probe")
    }

    @JvmStatic
    external fun runScenario(scenario: String, frames: Int, captureFrame: Int): String
}
