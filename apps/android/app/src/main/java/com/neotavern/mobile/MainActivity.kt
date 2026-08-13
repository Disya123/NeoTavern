package com.neotavern.mobile

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.TextView
import java.io.IOException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * NeoTavern Android Host — Phase 5 local foundation.
 *
 * Renders the packaged web UI (`assets/web/index.html`) in a hardened
 * WebView and exposes the in-process kernel through [NeotavernBridge]:
 *
 *  - the kernel opens over `<filesDir>/neotavern` on a single background
 *    executor (no Node, no localhost server — JNI only, ТЗ Фаза 5),
 *  - the JS bridge is installed BEFORE `loadUrl`,
 *  - on destroy the session closes on the same executor (streams are freed,
 *    the kernel releases its data-root lease).
 *
 * Security posture: javaScriptEnabled for the bundled UI, DOM storage on,
 * file access OFF (assets remain reachable via `file:///android_asset`),
 * mixed content NEVER, no INTERNET permission in the manifest, no
 * foreground service, no HTTP.
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var bridge: NeotavernBridge
    private lateinit var session: KernelSession

    /** Serializes every kernel operation: open, calls, stream pumps, close. */
    private val executor: ExecutorService = Executors.newSingleThreadExecutor()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.allowFileAccess = false
        web.settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW

        val dataRoot = ManagedDataRoot(this).ensure()
        session = KernelSession(JniNativeKernel, dataRoot.absolutePath)
        bridge = NeotavernBridge(session, executor, Handler(Looper.getMainLooper()), web)

        // Install the JS bridge BEFORE any page load; open the kernel in the
        // background so the first JS call never blocks on native startup.
        web.addJavascriptInterface(bridge, "__neotavernMobile")
        executor.execute {
            try {
                session.open()
            } catch (e: SessionError) {
                // A failed open must not crash the process: the bridge keeps
                // serving, and every subsequent call rejects with a
                // session-state error the JS layer can surface.
                Log.e(TAG, "kernel open failed: ${e.message}")
            }
        }

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

    override fun onDestroy() {
        // Stop bridge deliveries first, then drain the session on the same
        // executor (in-flight calls finish before close) and release it.
        bridge.close()
        executor.execute {
            try {
                session.close()
            } finally {
                executor.shutdown()
            }
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

    private fun hasWebAsset(relativePath: String): Boolean = try {
        assets.open(relativePath).close()
        true
    } catch (e: IOException) {
        false
    }

    private companion object {
        const val TAG = "NeoTavern"
    }
}
