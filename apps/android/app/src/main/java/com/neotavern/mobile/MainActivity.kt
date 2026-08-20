package com.neotavern.mobile

import android.Manifest
import android.app.Activity
import android.app.ActivityManager
import android.app.ForegroundServiceStartNotAllowedException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import android.view.Choreographer
import android.view.Display
import android.view.Gravity
import android.view.View
import android.view.accessibility.AccessibilityManager
import android.webkit.ConsoleMessage
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import androidx.core.app.ActivityCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import java.io.IOException
import kotlin.math.roundToInt

/**
 * NeoTavern Android Host — Phase 5 local foundation + Phase 8 background
 * execution (ТЗ §8, §19, §65, §66).
 *
 * WebView is the guarded rollback / TalkBack host (`MainActivity`), not a
 * route fallback. Rail destinations render native Dioxus surfaces.
 * Plugin DOM islands stay CONTAINED in WebSurface (ADR-0054). Unknown
 * panel ids still open the Rust `NotYetMigrated` surface.
 *
 * Renders the packaged web UI (`assets/web/index.html`) in a hardened
 * WebView and exposes the in-process kernel through [NeotavernBridge]:
 *
 *  - the kernel opens over `<filesDir>/neotavern` on a single background
 *    executor owned by the process-wide [KernelHolder] (one kernel, one
 *    data-root lease — §22; the same holder is shared with
 *    [GenerationService] and [MaintenanceWorker]),
 *  - the JS bridge is installed BEFORE `loadUrl`,
 *  - when a generation stream opens, the bridge's [onStreamOpened] hook
 *    claims the stream in [ForegroundExecutionCoordinator] and starts the
 *    bounded dataSync [GenerationService] while the app is still in the
 *    foreground (ТЗ §87 — no eternal FGS); the service acquires its own
 *    holder refcount before this activity can be destroyed, so the kernel
 *    never dies mid-run,
 *  - on destroy the bridge closes (JS delivery stops, the claimed streams
 *    stay open) and the activity releases its holder refcount,
 *  - a guarded Dioxus canary may finish this activity before creating a
 *    WebView when [PresentationRendererPolicy] allows a Rust host; TalkBack
 *    / touch exploration, safe mode, kill switch, crash-loop, unqualified
 *    GPU, and a flag-off stay on WebView (ADR-0051).
 *
 * Security posture: javaScriptEnabled for the bundled UI, DOM storage on,
 * file access OFF (assets remain reachable via `file:///android_asset` or,
 * when M-1 Track B is opted in, `WebViewAssetLoader` HTTPS), mixed content
 * NEVER. INTERNET is in the manifest for optional remote HostConnect
 * (URL/QR) only — local mode never opens a socket. CAMERA is
 * optional for QR pairing (WebChromeClient permission bridge).
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var bridge: NeotavernBridge

    /** Process-wide kernel holder shared with the background components. */
    private lateinit var holder: KernelHolder

    /** Latest system-bar insets, published into the document as CSS vars. */
    @Volatile
    private var insetTopPx = 0
    @Volatile
    private var insetRightPx = 0
    @Volatile
    private var insetBottomPx = 0
    @Volatile
    private var insetLeftPx = 0

    /** Camera PermissionRequest waiting on the runtime CAMERA grant. */
    private var pendingCameraRequest: PermissionRequest? = null

    /** Track B intercepts only `appassets.androidplatform.net`; null on production file://. */
    private var assetLoader: WebViewAssetLoader? = null

    private var lastRefreshDecision: DisplayRefreshPolicy.Decision? = null

    private var requestedRefreshHz: Float? = null

    private var createElapsedMs = 0L

    private var frameCallback: Choreographer.FrameCallback? = null

    /** True when this launcher hands off to [PresentationChatActivity] without a WebView. */
    private var presentationHandoff = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        createElapsedMs = SystemClock.elapsedRealtime()
        if (tryHandoffDioxusCanary()) {
            return
        }
        WindowCompat.setDecorFitsSystemWindows(window, false)
        applyPreferredDisplayMode()

        val web = WebView(this)
        web.id = R.id.neotavern_webview
        web.setBackgroundColor(Color.parseColor("#151311"))
        // Edge-to-edge like Telegram: the document fills the display so
        // wallpaper AND scrollable content pass under the status bar.
        // Do not pad this view — CSS env() is 0 in Android WebView, so
        // WindowInsets are published as --nt-safe-area-* and chrome uses
        // --nt-inset-* (tokens.css).
        web.setFitsSystemWindows(false)
        val origin = MeasurementOrigin.parse(
            intent.getStringExtra(MeasurementOrigin.EXTRA),
        )
        if (origin == MeasurementOrigin.Profile.AssetLoader) {
            assetLoader = WebViewAssetLoader.Builder()
                .addPathHandler(
                    MeasurementOrigin.ASSET_PATH_PREFIX,
                    WebViewAssetLoader.AssetsPathHandler(this),
                )
                .build()
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? {
                val loader = assetLoader
                if (loader != null) {
                    val intercepted = loader.shouldInterceptRequest(request.url)
                    if (intercepted != null) return intercepted
                }
                return super.shouldInterceptRequest(view, request)
            }

            override fun onPageFinished(view: WebView, url: String) {
                Log.i(
                    TAG,
                    "m1-startup duration_ms=${SystemClock.elapsedRealtime() - createElapsedMs} url=$url",
                )
                ViewCompat.getRootWindowInsets(view)?.let { captureWindowInsets(it, view) }
                    ?: publishSafeAreaCss(view)
                publishMeasurementGlass(view)
                publishMeasurementFrames(view)
            }
        }
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.allowFileAccess = false
        web.settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        @Suppress("DEPRECATION")
        web.settings.allowUniversalAccessFromFileURLs =
            origin == MeasurementOrigin.Profile.File
        applyRequestedViewFrameRate(web)
        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean {
                val message = consoleMessage.message()
                if (message.startsWith(MeasurementFrames.LOG_PREFIX)) {
                    Log.i(TAG, message)
                    return true
                }
                return super.onConsoleMessage(consoleMessage)
            }

            override fun onPermissionRequest(request: PermissionRequest) {
                val wantsCamera = request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)
                if (!wantsCamera) {
                    request.deny()
                    return
                }
                if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                    return
                }
                pendingCameraRequest = request
                ActivityCompat.requestPermissions(
                    this@MainActivity,
                    arrayOf(Manifest.permission.CAMERA),
                    REQUEST_CAMERA,
                )
            }
        }

        val dataRoot = ManagedDataRoot(this).ensure().absolutePath
        holder = KernelHost.holder(dataRoot) { error ->
            // A failed open must not crash the process: the bridge keeps
            // serving, and every subsequent call rejects with a
            // session-state error the JS layer can surface.
            Log.e(TAG, "kernel open failed: ${error.message}")
        }
        // Non-blocking: acquire() schedules the kernel open on the holder's
        // background executor (ТЗ §13 — never open SQLite on the UI thread);
        // the first JS call arrives only after the open task has run.
        holder.acquire()
        bridge = NeotavernBridge(
            session = holder.session,
            executor = holder.executor,
            mainHandler = Handler(Looper.getMainLooper()),
            webView = web,
            onStreamOpened = ::onStreamOpened,
            onStreamTerminal = ::onStreamTerminal,
            safeAreaCss = {
                "{" +
                    "\"top\":\"${cssPx(insetTopPx)}\"," +
                    "\"right\":\"${cssPx(insetRightPx)}\"," +
                    "\"bottom\":\"${cssPx(insetBottomPx)}\"," +
                    "\"left\":\"${cssPx(insetLeftPx)}\"" +
                    "}"
            },
        )

        // Install the JS bridge BEFORE any page load.
        web.addJavascriptInterface(bridge, "__neotavernMobile")

        // Best-effort maintenance (backups.create): the initial run is
        // enqueued here (unique work name + KEEP, so a pending run is never
        // duplicated); the worker re-enqueues the follow-up run itself.
        MaintenanceScheduler.schedule(this)

        if (hasWebAsset("web/index.html")) {
            webView = web
            setContentView(web)
            applyStatusBarAppearance(web)
            attachInsetPublisher(web)
            val documentUrl = MeasurementOrigin.documentUrl(origin)
            Log.i(TAG, "m1-origin profile=${origin.name} url=$documentUrl")
            logMeasurementEnvironment()
            web.loadUrl(documentUrl)
        } else {
            // Defense in depth: Gradle already refuses assemble without
            // apps/web/dist/index.html. If a hand-built APK still lacks it,
            // show a plain error instead of a blank WebView.
            setContentView(TextView(this).apply {
                text = "NeoTavern web assets are missing from this APK.\n" +
                    "Build the web client (`pnpm --filter @neotavern/web build`) " +
                    "then reassemble — Gradle refuses assembleDebug without " +
                    "apps/web/dist/index.html."
                gravity = Gravity.CENTER
                setTextSize(16f)
                setPadding(48, 48, 48, 48)
            })
        }
    }

    /**
     * Bridge hook (Phase 8): a generation stream just opened. Claim it in the
     * process-wide [ForegroundExecutionCoordinator] and start the bounded
     * foreground service so the run keeps pumping after this activity leaves
     * the foreground. Runs on the main thread.
     */
    private fun onStreamOpened(stream: Pair<Long, String>) {
        val (handle, wireStreamId) = stream
        ForegroundExecutionCoordinator.claim(handle, wireStreamId)
        ensureNotificationPermission()
        try {
            startForegroundService(Intent(this, GenerationService::class.java))
        } catch (e: ForegroundServiceStartNotAllowedException) {
            // The first stream event raced with the app leaving the
            // foreground (API 31+): the stream stays with the in-process
            // bridge, whose pump keeps delivering to the WebView. A later
            // stream event retries the service start.
            Log.w(TAG, "foreground service start not allowed: ${e.message}")
        }
    }

    /**
     * Bridge hook (Phase 8): a generation stream reached its terminal state
     * while this activity's bridge was still the active pump (the app is in
     * the background but the activity was not destroyed). Unclaim the stream
     * and stop the background service so its notification is removed — the
     * run itself is already durable-terminal (§63).
     */
    private fun onStreamTerminal(wireStreamId: String) {
        ForegroundExecutionCoordinator.unclaim(wireStreamId)
        try {
            stopService(Intent(this, GenerationService::class.java))
        } catch (e: Exception) {
            // Best-effort: the service may already be gone.
            Log.w(TAG, "stop generation service failed: ${e.message}")
        }
    }

    /**
     * Runtime POST_NOTIFICATIONS request (API 33+) before the first
     * [GenerationService] start; the generation foreground notification is
     * gated on it. On older APIs the permission comes from the manifest.
     */
    private fun ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                REQUEST_POST_NOTIFICATIONS,
            )
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_CAMERA) return
        val request = pendingCameraRequest
        pendingCameraRequest = null
        if (request == null) return
        val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        if (granted) {
            request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
        } else {
            request.deny()
        }
    }

    override fun onDestroy() {
        if (presentationHandoff) {
            super.onDestroy()
            return
        }
        frameCallback?.let { callback ->
            Choreographer.getInstance().removeFrameCallback(callback)
            frameCallback = null
        }
        // Stop bridge deliveries only — the claimed streams stay open and are
        // pumped by GenerationService, which holds its own holder refcount, so
        // the kernel keeps running while the app is backgrounded.
        if (::bridge.isInitialized) {
            bridge.close()
        }
        if (::holder.isInitialized) {
            holder.release()
        }
        if (::webView.isInitialized) {
            try {
                webView.removeJavascriptInterface("__neotavernMobile")
                webView.stopLoading()
                webView.destroy()
            } catch (ignored: Exception) {
                // WebView may already be gone.
            }
        }
        super.onDestroy()
    }

    /**
     * Edge-to-edge WebView (Telegram-style): the document fills the display so
     * scrollable content can pass under the translucent status bar. Interactive
     * chrome reads `--nt-inset-*`. CSS `env(safe-area-inset-*)` is 0 in Android
     * WebView, and WebView often never dispatches WindowInsets to its own
     * listener, so we also read the decor view / root insets.
     *
     * Must run after setContentView — before that, DecorView is null and
     * API 30+ crashes (NPE) in WindowInsetsControllerCompat.
     */
    private fun attachInsetPublisher(web: WebView) {
        ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { _, insets ->
            captureWindowInsets(insets, web)
            insets
        }
        ViewCompat.setOnApplyWindowInsetsListener(web) { _, insets ->
            captureWindowInsets(insets, web)
            WindowInsetsCompat.CONSUMED
        }
        web.post {
            ViewCompat.getRootWindowInsets(web)?.let { captureWindowInsets(it, web) }
            ViewCompat.requestApplyInsets(window.decorView)
            ViewCompat.requestApplyInsets(web)
        }
    }

    private fun captureWindowInsets(insets: WindowInsetsCompat, web: WebView) {
        val bars = insets.getInsets(
            WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
        )
        val gestures = insets.getInsets(WindowInsetsCompat.Type.mandatorySystemGestures())
        var top = bars.top
        var right = bars.right
        var bottom = maxOf(bars.bottom, gestures.bottom)
        var left = bars.left
        // WebView often dispatches empty insets after DecorView already had
        // real system bars. Never regress a measured box back to 0.
        if (top <= 0) top = insetTopPx.coerceAtLeast(systemDimenPx("status_bar_height"))
        if (bottom <= 0) bottom = insetBottomPx.coerceAtLeast(systemDimenPx("navigation_bar_height"))
        insetTopPx = top
        insetRightPx = right
        insetBottomPx = bottom
        insetLeftPx = left
        Log.i(TAG, "safe-area physical px top=$top right=$right bottom=$bottom left=$left")
        if (top <= 0 && bottom <= 0) return
        publishSafeAreaCss(web)
    }

    private fun systemDimenPx(name: String): Int {
        val id = resources.getIdentifier(name, "dimen", "android")
        return if (id != 0) resources.getDimensionPixelSize(id) else 0
    }

    private fun cssPx(physicalPx: Int): String {
        val density = resources.displayMetrics.density.coerceAtLeast(1f)
        // Round (not truncate) so the WebView fallback safe-area matches the
        // Rust host's `round`-based chrome and avoids a ~1px rail/glass gap.
        val css = (physicalPx / density).roundToInt()
        return "${if (physicalPx > 0) css.coerceAtLeast(1) else 0}px"
    }

    private fun publishSafeAreaCss(web: WebView) {
        val top = cssPx(insetTopPx)
        val right = cssPx(insetRightPx)
        val bottom = cssPx(insetBottomPx)
        val left = cssPx(insetLeftPx)
        val js = (
            "(function(){var r=document.documentElement;if(!r||!r.style)return;" +
                "function set(n,v){r.style.setProperty(n,v,'important');}" +
                "set('--nt-safe-area-top','$top');" +
                "set('--nt-safe-area-right','$right');" +
                "set('--nt-safe-area-bottom','$bottom');" +
                "set('--nt-safe-area-left','$left');" +
                "set('--nt-inset-top','$top');" +
                "set('--nt-inset-right','$right');" +
                "set('--nt-inset-bottom','$bottom');" +
                "set('--nt-inset-left','$left');" +
                "})()"
            )
        web.evaluateJavascript(js, null)
    }

    /**
     * M-1 Track A: request the highest same-resolution refresh mode. The OS
     * may still present at 60 Hz (`ENVIRONMENT_BLOCKED`); that is logged, not
     * treated as a renderer failure.
     */
    private fun applyPreferredDisplayMode() {
        val currentDisplay = currentDisplayOrNull() ?: return
        val snapshots = currentDisplay.supportedModes.map { it.toSnapshot() }
        val current = currentDisplay.mode.toSnapshot()
        val decision = DisplayRefreshPolicy.chooseHighestRefresh(snapshots, current)
        lastRefreshDecision = decision
        requestedRefreshHz = decision.requestedRefreshHz
        val requestedId = decision.requestedModeId
        if (requestedId != null) {
            val params = window.attributes
            params.preferredDisplayModeId = requestedId
            window.attributes = params
        }
        logRefreshTelemetry("apply", currentDisplay, decision)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus) return
        val display = currentDisplayOrNull() ?: return
        logRefreshTelemetry("observed", display, lastRefreshDecision)
        logMeasurementThermal("observed")
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

    private fun logRefreshTelemetry(
        phase: String,
        display: Display,
        decision: DisplayRefreshPolicy.Decision?,
    ) {
        val supported = display.supportedModes.joinToString(",") { mode ->
            "${mode.modeId}:${mode.refreshRate}:${mode.physicalWidth}x${mode.physicalHeight}"
        }
        val requested = decision?.requestedRefreshHz?.toString() ?: "-"
        val reason = decision?.reason ?: "-"
        Log.i(
            TAG,
            "m1-refresh phase=$phase supported=[$supported] requested_hz=$requested " +
                "requested_mode=${decision?.requestedModeId ?: "-"} reason=$reason " +
                "observed_hz=${display.refreshRate} observed_mode=${display.mode.modeId}",
        )
    }

    private fun publishMeasurementGlass(web: WebView) {
        val profile = MeasurementGlass.parse(
            intent.getStringExtra(MeasurementGlass.EXTRA_MEASUREMENT_GLASS),
        )
        val js = MeasurementGlass.bootstrapJs(profile)
        if (js != null) {
            web.evaluateJavascript(js, null)
        }
        Log.i(TAG, "m1-glass profile=${profile.name}")
    }

    private fun publishMeasurementFrames(web: WebView) {
        if (!MeasurementFrames.enabled(intent.getStringExtra(MeasurementFrames.EXTRA))) return
        val hz = MeasurementFrames.clampExpectedHz(requestedRefreshHz)
        web.evaluateJavascript(MeasurementFrames.bootstrapJs(hz), null)
        startChoreographerSample(hz)
        Log.i(TAG, "m1-frames expected_hz=$hz sample_ms=${MeasurementFrames.SAMPLE_MS}")
    }

    private fun startChoreographerSample(expectedHz: Int) {
        frameCallback?.let { Choreographer.getInstance().removeFrameCallback(it) }
        val counter = FrameMissCounter(expectedHz)
        val startElapsed = SystemClock.elapsedRealtime()
        val callback = object : Choreographer.FrameCallback {
            override fun doFrame(frameTimeNanos: Long) {
                val nowMs = frameTimeNanos / 1_000_000.0
                counter.record(nowMs)
                if (SystemClock.elapsedRealtime() - startElapsed < MeasurementFrames.SAMPLE_MS) {
                    Choreographer.getInstance().postFrameCallback(this)
                } else {
                    Log.i(TAG, "m1-choreographer ${counter.toJson(nowMs)}")
                    frameCallback = null
                }
            }
        }
        frameCallback = callback
        Choreographer.getInstance().postFrameCallback(callback)
    }

    /**
     * API 35+: vote the WebView into the requested display refresh. This does
     * not change pixels; the OS may still present at 60 Hz.
     */
    private fun applyRequestedViewFrameRate(web: WebView) {
        if (Build.VERSION.SDK_INT < 35) {
            Log.i(TAG, "m1-refresh view_frame_rate=unsupported")
            return
        }
        val hz = requestedRefreshHz
        if (hz != null && hz > 0f) {
            web.setRequestedFrameRate(hz)
            Log.i(TAG, "m1-refresh view_frame_rate=$hz")
        } else {
            web.setRequestedFrameRate(View.REQUESTED_FRAME_RATE_CATEGORY_HIGH)
            Log.i(TAG, "m1-refresh view_frame_rate=HIGH")
        }
    }

    private fun logMeasurementEnvironment() {
        val pkg = WebViewCompat.getCurrentWebViewPackage(this)
        Log.i(
            TAG,
            "m1-env sdk=${Build.VERSION.SDK_INT} release=${Build.VERSION.RELEASE} " +
                "model=${Build.MODEL} webview=${pkg?.packageName}:${pkg?.versionName}",
        )
        val activityManager = getSystemService(ActivityManager::class.java)
        val memory = ActivityManager.MemoryInfo()
        activityManager?.getMemoryInfo(memory)
        Log.i(
            TAG,
            "m1-memory avail_mb=${memory.availMem / (1024L * 1024L)} " +
                "total_mb=${memory.totalMem / (1024L * 1024L)} low=${memory.lowMemory}",
        )
        logMeasurementThermal("apply")
    }

    private fun logMeasurementThermal(phase: String) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            Log.i(TAG, "m1-thermal phase=$phase status=unsupported")
            return
        }
        val status = getSystemService(PowerManager::class.java)?.currentThermalStatus
        Log.i(TAG, "m1-thermal phase=$phase status=$status")
    }

    private fun applyStatusBarAppearance(host: View) {
        WindowInsetsControllerCompat(window, host).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }
    }

    private fun hasWebAsset(relativePath: String): Boolean = try {
        assets.open(relativePath).close()
        true
    } catch (e: IOException) {
        false
    }

    /**
     * Selector runs before WebView, Kernel acquire, or presentation JNI.
     * Returns true when this activity finishes into [PresentationChatActivity].
     */
    private fun tryHandoffDioxusCanary(): Boolean {
        val prefs = PresentationCanaryPrefs(this)
        val extrasTrusted = PresentationCanaryState.extrasTrusted(
            (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0,
        )
        if (extrasTrusted && PresentationChatLaunch.isCanaryReset(
                intent.getStringExtra(PresentationChatLaunch.EXTRA_CANARY_RESET),
            )
        ) {
            prefs.resetGuards()
        }
        val flagExtra = intent.getStringExtra(PresentationChatLaunch.EXTRA_DIOXUS_SHELL)
        prefs.applyFlagExtra(flagExtra, extrasTrusted)
        Log.i(
            TAG,
            "presentation_canary_opt_in persisted=${prefs.canaryEnabled} extras_trusted=$extrasTrusted",
        )
        val chatId = PresentationChatLaunch.parseChatId(
            intent.getStringExtra(PresentationChatLaunch.EXTRA_CHAT_ID),
        )
        if (chatId.isNotEmpty()) {
            prefs.rememberChatId(chatId)
        }
        if (extrasTrusted && PresentationChatLaunch.isForceInitFailure(
                intent.getStringExtra(PresentationChatLaunch.EXTRA_FORCE_INIT_FAILURE),
            )
        ) {
            prefs.armKillSwitch()
            Log.i(
                TAG,
                "presentation_renderer=WEBVIEW reason=forced_init_failure rust_host_allowed=false",
            )
            return false
        }
        val touchExploration = getSystemService(AccessibilityManager::class.java)
            ?.isTouchExplorationEnabled == true
        val emulator = PresentationDeviceQualification.isEmulator(
            Build.FINGERPRINT,
            Build.MODEL,
            Build.HARDWARE,
            Build.PRODUCT,
        )
        val inputs = PresentationRendererPolicy.Inputs(
            safeMode = extrasTrusted && PresentationChatLaunch.isSafeMode(
                intent.getStringExtra(PresentationChatLaunch.EXTRA_SAFE_MODE),
            ),
            killSwitch = prefs.killSwitch,
            crashLoop = PresentationCanaryState.crashLoop(prefs.crashFailures),
            touchExplorationEnabled = touchExploration,
            deviceQualified = PresentationDeviceQualification.isQualified(
                physicalDevice = !emulator,
                vulkanHardware = packageManager.hasSystemFeature(
                    PackageManager.FEATURE_VULKAN_HARDWARE_LEVEL,
                ),
                softwareRenderer = PresentationDeviceQualification.isSoftwareRenderer(
                    Build.HARDWARE,
                    Build.FINGERPRINT,
                ),
            ),
            canaryFlag = PresentationCanaryState.canaryFlag(
                flagExtra,
                prefs.canaryEnabled,
                extrasTrusted,
            ),
        )
        val decision = PresentationRendererPolicy.decide(inputs)
        Log.i(TAG, PresentationRendererPolicy.logLine(decision))
        if (!decision.rustHostAllowed) {
            return false
        }
        presentationHandoff = true
        return try {
            PresentationCanaryHost.launch(this, intent, prefs.lastChatId)
            finish()
            true
        } catch (err: Throwable) {
            presentationHandoff = false
            prefs.armKillSwitch()
            Log.e(TAG, "dioxus canary host failed", err)
            Log.i(
                TAG,
                "presentation_renderer=WEBVIEW reason=init_failure rust_host_allowed=false",
            )
            false
        }
    }

    private companion object {
        const val TAG = "NeoTavern"
        const val REQUEST_POST_NOTIFICATIONS = 4101
        const val REQUEST_CAMERA = 4102
    }
}
