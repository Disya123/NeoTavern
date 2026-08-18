package com.neotavern.mobile

import android.app.Activity
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.TextView
import kotlin.concurrent.thread

/**
 * Debug-only PERF-22 platform-surface host: real WebView, secure SurfaceView,
 * glass overlay, and fallback. Not a launcher. Does not change
 * [MainActivity] or production JNI.
 *
 * `adb shell am start -n com.neotavern.mobile/.PresentationSurfaceActivity \
 *   --es com.neotavern.mobile.PERF_SCENARIO perf22`
 */
class PresentationSurfaceActivity : Activity() {
    private lateinit var webView: WebView
    private lateinit var secureSurface: SurfaceView
    private lateinit var fallback: TextView
    private lateinit var glass: View
    private lateinit var status: TextView
    private var webViewHits = 0
    private var surfaceHits = 0
    private var fallbackHits = 0
    private var fixtureStarted = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val scenario =
            PresentationPerfLaunch.parseScenario(intent.getStringExtra(PresentationPerfLaunch.EXTRA_SCENARIO))
        val root = FrameLayout(this)

        webView = WebView(this)
        webView.setBackgroundColor(Color.RED)
        webView.loadDataWithBaseURL(
            null,
            "<html><body style='background:#c00;color:#fff'>webview-fixture</body></html>",
            "text/html",
            "utf-8",
            null,
        )
        webView.setOnTouchListener { _, event ->
            if (event.actionMasked == MotionEvent.ACTION_DOWN) {
                webViewHits += 1
                logHits("webview")
            }
            false
        }

        secureSurface = SurfaceView(this)
        secureSurface.holder.setFormat(PixelFormat.OPAQUE)
        secureSurface.setSecure(true)
        secureSurface.setOnTouchListener { _, event ->
            if (event.actionMasked == MotionEvent.ACTION_DOWN) {
                surfaceHits += 1
                logHits("surface")
            }
            false
        }

        fallback = TextView(this)
        fallback.text = "fallback-panel"
        fallback.setBackgroundColor(Color.argb(240, 32, 32, 48))
        fallback.setTextColor(Color.WHITE)
        fallback.gravity = Gravity.CENTER
        fallback.contentDescription = "perf22-fallback"
        fallback.setOnTouchListener { _, event ->
            if (event.actionMasked == MotionEvent.ACTION_DOWN) {
                fallbackHits += 1
                logHits("fallback")
            }
            true
        }

        glass = View(this)
        glass.setBackgroundColor(Color.argb(80, 180, 220, 255))
        glass.isClickable = false
        glass.isFocusable = false

        status = TextView(this)
        status.text = "surface fixture"
        status.setPadding(24, 24, 24, 24)

        val surfaceParams = FrameLayout.LayoutParams(400, 640, Gravity.START or Gravity.TOP)
        surfaceParams.leftMargin = 80
        surfaceParams.topMargin = 200
        val videoParams = FrameLayout.LayoutParams(400, 640, Gravity.START or Gravity.TOP)
        videoParams.leftMargin = 520
        videoParams.topMargin = 200

        root.addView(
            webView,
            surfaceParams,
        )
        root.addView(secureSurface, videoParams)
        root.addView(fallback, surfaceParams)
        root.addView(
            glass,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                160,
                Gravity.TOP,
            ),
        )
        root.addView(
            status,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM,
            ),
        )
        setContentView(root)
        hideOriginals()
        thread(name = "perf-22-gpu") {
            val line =
                try {
                    PresentationPerfProbe.runScenario(
                        scenario,
                        PresentationPerfLaunch.parseFrames(
                            intent.getStringExtra(PresentationPerfLaunch.EXTRA_FRAMES),
                        ),
                        PresentationPerfLaunch.parseCaptureFrame(
                            intent.getStringExtra(PresentationPerfLaunch.EXTRA_CAPTURE_FRAME),
                        ),
                    )
                } catch (err: Throwable) {
                    "$scenario gpu_ran=false ran_on_android=true capture=false verdict=BLOCKED reason=load_failed:${err.javaClass.simpleName}"
                }
            Log.i(TAG, line)
            runOnUiThread {
                status.text = line.replace(' ', '\n')
                maybeInjectTap()
            }
        }
    }

    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        Log.i(TAG, "perf15-trim level=$level")
    }

    private fun hideOriginals() {
        webView.visibility = View.INVISIBLE
        webView.isClickable = false
        webView.isFocusable = false
        secureSurface.visibility = View.INVISIBLE
        secureSurface.isClickable = false
        secureSurface.isFocusable = false
        fallback.visibility = View.VISIBLE
        fallback.isClickable = true
    }

    private fun maybeInjectTap() {
        if (fixtureStarted) return
        fixtureStarted = true
        fallback.post {
            val loc = IntArray(2)
            fallback.getLocationOnScreen(loc)
            val x = loc[0] + fallback.width / 2f
            val y = loc[1] + fallback.height / 2f
            val downTime = SystemClock.uptimeMillis()
            val down =
                MotionEvent.obtain(downTime, downTime, MotionEvent.ACTION_DOWN, x, y, 0)
            val up =
                MotionEvent.obtain(downTime, downTime + 16, MotionEvent.ACTION_UP, x, y, 0)
            fallback.dispatchTouchEvent(down)
            fallback.dispatchTouchEvent(up)
            down.recycle()
            up.recycle()
            logHits("injected")
        }
    }

    private fun logHits(source: String) {
        val line =
            "perf22-platform webview=android.webkit.WebView secure_surface=true fallback_visible=true " +
                "glass_overlay=true tap_hit=${if (fallbackHits > 0) "fallback" else source} " +
                "webview_hits=$webViewHits surface_hits=$surfaceHits fallback_hits=$fallbackHits " +
                "original_hittable=false"
        Log.i(TAG, line)
        status.text = line.replace(' ', '\n')
    }

    private companion object {
        const val TAG: String = "NeoTavern"
    }
}
