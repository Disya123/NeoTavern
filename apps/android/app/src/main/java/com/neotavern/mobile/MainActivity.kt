package com.neotavern.mobile

import android.Manifest
import android.app.Activity
import android.app.ForegroundServiceStartNotAllowedException
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.TextView
import androidx.core.app.ActivityCompat
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
 * mixed content NEVER, no INTERNET permission in the manifest, no HTTP, no
 * Node — JNI only (ТЗ §6.9). The only background components are the bounded
 * generation FGS and best-effort WorkManager maintenance.
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var bridge: NeotavernBridge

    /** Process-wide kernel holder shared with the background components. */
    private lateinit var holder: KernelHolder

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.allowFileAccess = false
        web.settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW

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
            web.loadUrl("file:///android_asset/web/index.html")
        } else {
            // Web assets are not packaged yet (Phase 5 gate): show a plain
            // error instead of a blank/error WebView page.
            setContentView(TextView(this).apply {
                text = "NeoTavern web assets are not packaged yet.\n" +
                    "Build apps/web and copy dist/* into " +
                    "app/src/main/assets/web/, then rebuild the APK."
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

    private fun hasWebAsset(relativePath: String): Boolean = try {
        assets.open(relativePath).close()
        true
    } catch (e: IOException) {
        false
    }

    private companion object {
        const val TAG = "NeoTavern"
        const val REQUEST_POST_NOTIFICATIONS = 4101
    }
}
