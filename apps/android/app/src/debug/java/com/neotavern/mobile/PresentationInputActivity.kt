package com.neotavern.mobile

import android.app.Activity
import android.graphics.PixelFormat
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.os.Trace
import android.util.Log
import android.view.Choreographer
import android.view.Gravity
import android.view.MotionEvent
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView

/**
 * Debug-only MotionEvent / Choreographer / window-swapchain host.
 * Not a launcher. Start with:
 *
 * `adb shell am start -n com.neotavern.mobile/.PresentationInputActivity`
 *
 * Does not change production WebView [MainActivity] or default JNI.
 * `Choreographer#doFrame` is not display present.
 */
class PresentationInputActivity : Activity(), SurfaceHolder.Callback {
    private val adapter = PresentationInputAdapter()
    private lateinit var surfaceView: SurfaceView
    private lateinit var status: TextView
    private val compositorThread = HandlerThread("i2p-compositor")
    private var compositorHandler: Handler? = null
    private var presentPosted = false
    private var presentCallback: Choreographer.VsyncCallback? = null
    private var nativeReady = false
    private var fixtureThread: Thread? = null
    private var lastRequestedHz: Float? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        applyRefresh(extraNumber(EXTRA_HZ, 120f))
        compositorThread.start()
        compositorHandler = Handler(compositorThread.looper)

        val root = FrameLayout(this)
        surfaceView = SurfaceView(this)
        surfaceView.holder.setFormat(PixelFormat.OPAQUE)
        surfaceView.holder.addCallback(this)
        status = TextView(this)
        status.text = "input adapter (debug)"
        status.textSize = 14f
        status.setPadding(32, 32, 32, 32)
        val statusParams =
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.TOP,
            )
        root.addView(
            surfaceView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )
        root.addView(status, statusParams)
        setContentView(root)
        adapter.nativeSink =
            object : PresentationInputAdapter.NativeSink {
                override fun tryPush(pointer: Int, kind: Int, x: Float, y: Float, timeNanos: Long) {
                    if (!nativeReady) return
                    try {
                        PresentationI2pProbe.tryPush(pointer, kind, x, y, timeNanos)
                    } catch (_: UnsatisfiedLinkError) {
                        nativeReady = false
                    } catch (_: Throwable) {
                    }
                }

                override fun loseFocus(timeNanos: Long) {
                    if (!nativeReady) return
                    try {
                        PresentationI2pProbe.loseFocus(timeNanos)
                    } catch (_: UnsatisfiedLinkError) {
                        nativeReady = false
                    } catch (_: Throwable) {
                    }
                }
            }
        adapter.attach(surfaceView)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        val handled = adapter.onTouch(event)
        val stats = adapter.queue.stats()
        status.text =
            "callbackTime=${adapter.lastVsyncNanos}\ncallbackVsyncId=${adapter.lastVsyncId}\ninputCutoff=${adapter.lastDeadlineNanos}\ntargetVsyncId=${adapter.lastTargetVsyncId}\neligibleForCurrentVsync=${adapter.lastEligibleForCurrentVsync}\nqueued=${stats.current} high=${stats.highWater} dropM=${stats.droppedMoves}\nnative=$nativeReady hz=${observedHz()}"
        return handled || super.onTouchEvent(event)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus) {
            adapter.loseFocus()
        }
    }

    override fun onPause() {
        adapter.loseWindow()
        super.onPause()
    }

    override fun onDestroy() {
        fixtureThread?.interrupt()
        stopPresentLoop()
        adapter.stopFrameCallbacks()
        compositorThread.quitSafely()
        super.onDestroy()
    }

    override fun surfaceCreated(holder: SurfaceHolder) = Unit

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
        val surface = holder.surface
        compositorHandler?.post {
            val line =
                try {
                    PresentationI2pProbe.detachSurface()
                    PresentationI2pProbe.attachSurface(surface, width, height)
                } catch (err: Throwable) {
                    "i2p attach failed reason=${err.javaClass.simpleName}"
                }
            Log.i(PresentationInputAdapter.TAG, line)
            nativeReady = line.startsWith("i2p attach ok")
            if (nativeReady) startPresentLoop()
            runOnUiThread {
                status.text = line.replace(' ', '\n')
                maybeStartFixture()
            }
        }
    }

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        nativeReady = false
        stopPresentLoop()
        compositorHandler?.post {
            try {
                PresentationI2pProbe.detachSurface()
            } catch (_: Throwable) {
            }
        }
    }

    fun applyRefresh(targetHz: Float?) {
        val currentDisplay = display ?: return
        val currentMode = currentDisplay.mode
        val current =
            DisplayRefreshPolicy.Mode(
                currentMode.modeId,
                currentMode.refreshRate,
                currentMode.physicalWidth,
                currentMode.physicalHeight,
            )
        val modes =
            currentDisplay.supportedModes.map { mode ->
                DisplayRefreshPolicy.Mode(
                    mode.modeId,
                    mode.refreshRate,
                    mode.physicalWidth,
                    mode.physicalHeight,
                )
            }
        val decision =
            if (targetHz == null) {
                DisplayRefreshPolicy.chooseHighestRefresh(modes, current)
            } else {
                DisplayRefreshPolicy.chooseNearestRefresh(modes, current, targetHz)
            }
        lastRequestedHz = decision.requestedRefreshHz
        val periodHz = decision.requestedRefreshHz ?: current.refreshRateHz
        adapter.setRefreshPeriodNanos((1_000_000_000.0 / periodHz.toDouble()).toLong())
        val modeId = decision.requestedModeId ?: return
        val params = window.attributes
        params.preferredDisplayModeId = modeId
        params.preferredRefreshRate = decision.requestedRefreshHz ?: periodHz
        window.attributes = params
        Log.i(
            PresentationInputAdapter.TAG,
            "i2p display requestedHz=${decision.requestedRefreshHz} observedHz=${observedHz()} " +
                "modeId=$modeId reason=${decision.reason} supported=${decision.supportedRatesHz}",
        )
    }

    fun observedHz(): Float = display?.mode?.refreshRate ?: display?.refreshRate ?: 0f

    fun requestedHz(): Float? = lastRequestedHz

    private fun startPresentLoop() {
        if (Build.VERSION.SDK_INT < 33) {
            Log.i(PresentationInputAdapter.TAG, "i2p present skipped reason=sdk_below_33")
            return
        }
        val handler = compositorHandler ?: return
        handler.post {
            if (presentPosted) return@post
            val choreographer = Choreographer.getInstance()
            val callback =
                Choreographer.VsyncCallback { data ->
                    val timeline = data.preferredFrameTimeline
                    val nextTimeline =
                        data.frameTimelines
                            .filter { it.vsyncId > timeline.vsyncId }
                            .minByOrNull { it.vsyncId }
                    adapter.applyCompositorFrameTimeline(
                        data.frameTimeNanos,
                        timeline.vsyncId,
                        timeline.deadlineNanos,
                        timeline.expectedPresentationTimeNanos,
                        nextTimeline?.vsyncId ?: (timeline.vsyncId + 1L),
                        nextTimeline?.expectedPresentationTimeNanos
                            ?: (timeline.expectedPresentationTimeNanos + adapter.lastPeriodNanos),
                    )
                    Trace.beginSection("nt.input.present")
                    val line =
                        try {
                            PresentationI2pProbe.presentFrame(
                                timeline.vsyncId,
                                data.frameTimeNanos,
                                timeline.deadlineNanos,
                                timeline.expectedPresentationTimeNanos,
                            )
                        } catch (err: Throwable) {
                            "i2p present failed reason=${err.javaClass.simpleName}"
                        } finally {
                            Trace.endSection()
                        }
                    Log.i(PresentationInputAdapter.TAG, line)
                    adapter.markCompositorPresented(SystemClock.uptimeNanos())
                    if (presentPosted) {
                        presentCallback?.let { choreographer.postVsyncCallback(it) }
                    }
                }
            presentCallback = callback
            presentPosted = true
            choreographer.postVsyncCallback(callback)
        }
    }

    private fun stopPresentLoop() {
        presentPosted = false
        val callback = presentCallback
        presentCallback = null
        compositorHandler?.post {
            if (callback != null && Build.VERSION.SDK_INT >= 33) {
                Choreographer.getInstance().removeVsyncCallback(callback)
            }
        }
    }

    private fun maybeStartFixture() {
        if (fixtureThread != null) return
        val name = intent.getStringExtra(EXTRA_FIXTURE) ?: return
        val warmupMs = extraNumber(EXTRA_WARMUP_MS, 2_000f).toLong()
        val scrollMs = extraNumber(EXTRA_SCROLL_MS, 60_000f).toLong()
        val runner = PresentationInputFixture(this, adapter, warmupMs, scrollMs)
        fixtureThread =
            Thread({ runner.run(name) }, "i2p-fixture").also { it.start() }
    }

    private fun extraNumber(name: String, default: Float): Float {
        val boxed = intent.extras?.get(name) ?: return default
        return when (boxed) {
            is Number -> boxed.toFloat()
            is String -> boxed.toFloatOrNull() ?: default
            else -> default
        }
    }

    companion object {
        const val EXTRA_FIXTURE: String = "com.neotavern.mobile.I2P_FIXTURE"
        const val EXTRA_HZ: String = "com.neotavern.mobile.I2P_HZ"
        const val EXTRA_WARMUP_MS: String = "com.neotavern.mobile.I2P_WARMUP_MS"
        const val EXTRA_SCROLL_MS: String = "com.neotavern.mobile.I2P_SCROLL_MS"
    }
}
