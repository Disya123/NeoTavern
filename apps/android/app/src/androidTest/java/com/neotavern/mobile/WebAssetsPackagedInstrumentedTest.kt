package com.neotavern.mobile

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.nio.charset.StandardCharsets

/**
 * ТЗ §11.4 / §18.3: the installed app APK must contain the production web UI
 * at `assets/web/index.html`. This is the on-device half of the packaging
 * gate (CI also unzips debug and release APKs). It is NOT a full user-flow
 * E2E — that lives in [WebViewUserFlowInstrumentedTest] (catalog / settings /
 * composer and generation process-death on the JS→JNI path).
 */
@RunWith(AndroidJUnit4::class)
class WebAssetsPackagedInstrumentedTest {

    @Test
    fun packagedWebIndexHtml_isPresentAndLooksLikeHtml() {
        val assets = InstrumentationRegistry.getInstrumentation().targetContext.assets
        val bytes = assets.open("web/index.html").use { it.readBytes() }
        assertTrue("web/index.html must not be empty", bytes.isNotEmpty())
        val text = String(bytes, StandardCharsets.UTF_8)
        val looksLikeHtml =
            text.contains("<html", ignoreCase = true) ||
                text.contains("<!DOCTYPE", ignoreCase = true)
        assertTrue("web/index.html must be an HTML document, got: ${text.take(80)}", looksLikeHtml)
    }
}
