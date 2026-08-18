package com.neotavern.mobile

import android.app.Activity
import android.os.Bundle
import android.util.Log
import android.widget.TextView
import kotlin.concurrent.thread

/**
 * Debug-only PERF-18/19/20 probe. Not in the launcher. Start with:
 *
 * `adb shell am start -n com.neotavern.mobile/.PresentationPerfActivity --es com.neotavern.mobile.PERF_SCENARIO perf18`
 *
 * Does not change production WebView [MainActivity].
 */
class PresentationPerfActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val view = TextView(this)
        view.text = "PERF probe running…"
        view.textSize = 16f
        view.setPadding(48, 48, 48, 48)
        setContentView(view)

        val scenario =
            PresentationPerfLaunch.parseScenario(intent.getStringExtra(PresentationPerfLaunch.EXTRA_SCENARIO))
        val frames = PresentationPerfLaunch.parseFrames(intent.getStringExtra(PresentationPerfLaunch.EXTRA_FRAMES))
        val captureFrame =
            PresentationPerfLaunch.parseCaptureFrame(
                intent.getStringExtra(PresentationPerfLaunch.EXTRA_CAPTURE_FRAME),
            )
        thread(name = "perf-18-20") {
            val line =
                try {
                    PresentationPerfProbe.runScenario(scenario, frames, captureFrame)
                } catch (err: Throwable) {
                    "$scenario gpu_ran=false ran_on_android=true capture=false verdict=BLOCKED reason=load_failed:${err.javaClass.simpleName}"
                }
            Log.i(TAG, line)
            runOnUiThread { view.text = line.replace(' ', '\n') }
        }
    }

    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        android.util.Log.i(TAG, "perf15-trim level=$level")
    }

    private companion object {
        const val TAG: String = "NeoTavern"
    }
}
