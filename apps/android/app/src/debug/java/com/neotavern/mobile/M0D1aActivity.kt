package com.neotavern.mobile

import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.Display
import android.widget.TextView
import kotlin.concurrent.thread

/**
 * Debug-only M0-D1a paint-seam probe. Not in the launcher. Start with:
 *
 * `adb shell am start -n com.neotavern.mobile/.M0D1aActivity`
 *
 * Optional extra `com.neotavern.mobile.M0_D1A_FRAMES` (default 100).
 * Logs `m0-d1a-refresh` then one `m0-d1a` line under tag `NeoTavern`.
 * Does not change production WebView [MainActivity].
 */
class M0D1aActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val view = TextView(this)
        view.text = "M0-D1a probe running…"
        view.textSize = 16f
        view.setPadding(48, 48, 48, 48)
        setContentView(view)
        logRefreshTelemetry()

        val frames = M0D1aLaunch.parseFrames(intent.getStringExtra(M0D1aLaunch.EXTRA_FRAMES))
        thread(name = "m0-d1a") {
            val line =
                try {
                    M0D1aProbe.runStatic(frames)
                } catch (err: Throwable) {
                    "m0-d1a gpu_ran=false ran_on_android=true capture=false verdict=BLOCKED reason=load_failed:${err.javaClass.simpleName}"
                }
            Log.i(TAG, line)
            runOnUiThread { view.text = line.replace(' ', '\n') }
        }
    }

    private fun logRefreshTelemetry() {
        val currentDisplay = currentDisplayOrNull() ?: return
        val snapshots = currentDisplay.supportedModes.map { it.toSnapshot() }
        val current = currentDisplay.mode.toSnapshot()
        val decision = DisplayRefreshPolicy.chooseHighestRefresh(snapshots, current)
        val requestedId = decision.requestedModeId
        if (requestedId != null) {
            val params = window.attributes
            params.preferredDisplayModeId = requestedId
            window.attributes = params
        }
        val supported = currentDisplay.supportedModes.joinToString(",") { mode ->
            "${mode.modeId}:${mode.refreshRate}:${mode.physicalWidth}x${mode.physicalHeight}"
        }
        Log.i(
            TAG,
            M0D1aLaunch.refreshLogLine(
                phase = "apply",
                supported = supported,
                requestedHz = decision.requestedRefreshHz,
                requestedModeId = decision.requestedModeId,
                reason = decision.reason,
                observedHz = currentDisplay.refreshRate,
                observedModeId = currentDisplay.mode.modeId,
            ),
        )
    }

    private fun currentDisplayOrNull(): Display? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            display
        } else {
            @Suppress("DEPRECATION")
            windowManager.defaultDisplay
        }
    }

    private fun Display.Mode.toSnapshot(): DisplayRefreshPolicy.Mode =
        DisplayRefreshPolicy.Mode(
            id = modeId,
            refreshRateHz = refreshRate,
            width = physicalWidth,
            height = physicalHeight,
        )

    private companion object {
        const val TAG: String = "NeoTavern"
    }
}
