package com.neotavern.mobile

/**
 * JNI surface for `libneotavern_presentation_m0.so` (debug jniLibs only).
 * Production [KernelBridge] does not load this library.
 */
object M0D1aProbe {
    init {
        System.loadLibrary("neotavern_presentation_m0")
    }

    @JvmStatic
    external fun runStatic(frames: Int): String
}
