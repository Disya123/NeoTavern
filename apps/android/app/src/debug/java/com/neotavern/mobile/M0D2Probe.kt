package com.neotavern.mobile

/**
 * JNI surface for `libneotavern_presentation_m0_d2.so` (debug jniLibs only).
 * Production [KernelBridge] does not load this library.
 */
object M0D2Probe {
    init {
        System.loadLibrary("neotavern_presentation_m0_d2")
    }

    @JvmStatic
    external fun runDynamic(frames: Int, captureFrame: Int): String
}
