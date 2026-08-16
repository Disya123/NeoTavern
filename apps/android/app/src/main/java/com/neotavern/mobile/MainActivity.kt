package com.neotavern.mobile

import android.Manifest
import android.app.Activity
import android.app.ForegroundServiceStartNotAllowedException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.View
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import androidx.core.app.ActivityCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.io.IOException

/**
 * NeoTavern Android Host — Phase 5 local foundation + Phase 8 background
 * execution (ТЗ §8, §19, §65, §66).
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
 *    stay open) and the activity releases its holder refcount.
 *
 * Security posture: javaScriptEnabled for the bundled UI, DOM storage on,
 * file access OFF (assets remain reachable via `file:///android_asset`),
 * mixed content NEVER. INTERNET is in the manifest for optional remote
 * HostConnect (URL/QR) only — local mode never opens a socket. CAMERA is
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)

        val web = WebView(this)
        web.id = R.id.neotavern_webview
        web.setBackgroundColor(Color.parseColor("#151311"))
        // Edge-to-edge like Telegram: the document fills the display so
        // wallpaper AND scrollable content pass under the status bar.
        // Do not pad this view — CSS env() is 0 in Android WebView, so
        // WindowInsets are published as --nt-safe-area-* and chrome uses
        // --nt-inset-* (tokens.css).
        web.setFitsSystemWindows(false)
        web.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                ViewCompat.getRootWindowInsets(view)?.let { captureWindowInsets(it, view) }
                    ?: publishSafeAreaCss(view)
            }
        }
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.allowFileAccess = false
        web.settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        @Suppress("DEPRECATION")
        web.settings.allowUniversalAccessFromFileURLs = true
        web.webChromeClient = object : WebChromeClient() {
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
            web.loadUrl("file:///android_asset/web/index.html")
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
        // Stop bridge deliveries only — the claimed streams stay open and are
        // pumped by GenerationService, which holds its own holder refcount, so
        // the kernel keeps running while the app is backgrounded.
        bridge.close()
        holder.release()
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
        val css = (physicalPx / density).toInt()
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

    private companion object {
        const val TAG = "NeoTavern"
        const val REQUEST_POST_NOTIFICATIONS = 4101
        const val REQUEST_CAMERA = 4102
    }
}
