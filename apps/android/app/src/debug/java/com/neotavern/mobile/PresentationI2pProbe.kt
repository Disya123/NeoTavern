package com.neotavern.mobile

/**
 * JNI surface for the debug input-to-present present loop.
 * Loads [libneotavern_presentation_perf_probe.so] — not production JNI.
 */
object PresentationI2pProbe {
    init {
        System.loadLibrary("neotavern_presentation_perf_probe")
    }

    @JvmStatic
    external fun attachSurface(surface: android.view.Surface, width: Int, height: Int): String

    @JvmStatic
    external fun detachSurface(): String

    @JvmStatic
    external fun tryPush(pointer: Int, kind: Int, x: Float, y: Float, timeNanos: Long)

    @JvmStatic
    external fun loseFocus(timeNanos: Long)

    @JvmStatic
    external fun presentFrame(
        vsyncId: Long,
        callbackTime: Long,
        deadline: Long,
        expectedPresent: Long,
    ): String
}
