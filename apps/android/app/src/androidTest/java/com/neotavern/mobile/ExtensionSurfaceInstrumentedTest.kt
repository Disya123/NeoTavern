package com.neotavern.mobile

import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Extension-surface availability on a real device/emulator (ТЗ §51, §86,
 * §90, §92): `window.__neotavernMobile.extensionsAvailability()` must report
 * the frozen probe JSON — Android accepts only trusted built-in + declarative
 * theme contributions, there is NO plugin execution surface and no Node
 * runtime, and arbitrary third-party JavaScript is never loaded into the
 * main WebView.
 *
 * The bridge is constructed exactly like [MainActivity] does (kernel session,
 * single-thread executor, main handler, WebView), but the session is NOT
 * opened: [NeotavernBridge.extensionsAvailability] is a constant probe that
 * never touches the kernel, so this test needs no JNI library and no kernel
 * open. The WebView is created through
 * [android.app.Instrumentation.runOnMainSync] (WebView construction requires
 * the main thread's Looper) and is never asked to load a page.
 *
 * The WebView hardening posture — javaScriptEnabled for the bundled UI,
 * allowFileAccess off, mixedContentMode NEVER, exactly one JS interface
 * (`__neotavernMobile`, registered in [MainActivity] BEFORE `loadUrl`) — is
 * configured in [MainActivity] and covered by code review: Android's WebView
 * exposes no API to enumerate registered JS interfaces, and a fresh test
 * WebView only shows framework defaults, so an automated settings assertion
 * would be either meaningless or flaky. The probe itself is asserted here on
 * device; the frozen byte contract is additionally JVM-tested in
 * [ExtensionAvailabilityTest].
 */
@RunWith(AndroidJUnit4::class)
class ExtensionSurfaceInstrumentedTest {

    @Test
    fun extensionsAvailability_returnsFrozenProbeJson_viaTheBridge() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext

        // WebView creation must run on the main thread (it builds a Handler
        // on the current Looper); the sanctioned runOnMainSync is not flaky
        // UI-thread gymnastics — it is the framework's own synchronization.
        var webView: WebView? = null
        instrumentation.runOnMainSync { webView = WebView(context) }

        val executor: ExecutorService = Executors.newSingleThreadExecutor()
        val bridge = try {
            NeotavernBridge(
                session = KernelSession(
                    JniNativeKernel,
                    File(context.cacheDir, "extension-surface-${UUID.randomUUID()}").absolutePath,
                ),
                executor = executor,
                mainHandler = Handler(Looper.getMainLooper()),
                webView = checkNotNull(webView) { "WebView creation failed on the main thread" },
            )
        } finally {
            executor.shutdown()
        }

        try {
            // Byte-identical to the frozen probe contract (same constant the
            // JVM test locks down).
            assertEquals(ExtensionAvailability.JSON, bridge.extensionsAvailability())

            // The declared shape, parsed on device.
            val probe = JSONObject(bridge.extensionsAvailability())
            assertTrue("themes available", probe.getBoolean("themes"))
            assertEquals("plugins declarative-only", "declarative-only", probe.getString("plugins"))
            assertFalse("no local Node runtime", probe.getBoolean("nodeRuntime"))
            assertFalse("no arbitrary JS in the WebView", probe.getBoolean("arbitraryJsInWebView"))

            // The probe is part of the JS bridge surface (same expose pattern
            // as backgroundExecutionAvailable), not a plain Kotlin method —
            // the annotation is what makes it callable from the WebView.
            val method = NeotavernBridge::class.java.getMethod("extensionsAvailability")
            assertTrue(
                "extensionsAvailability must be exposed via @JavascriptInterface",
                method.isAnnotationPresent(JavascriptInterface::class.java),
            )
        } finally {
            bridge.close()
        }
    }
}
