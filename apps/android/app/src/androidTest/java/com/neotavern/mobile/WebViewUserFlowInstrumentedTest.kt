package com.neotavern.mobile

import android.content.Intent
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * WebView → JNI → Kernel user-flow (M6): the packaged UI's themed
 * HostConnect gate ("Use on this device") must reach `app-shell` over the
 * in-process kernel. Catalog / settings / composer are driven through
 * Theme SDK `data-*` hooks. Generation process-death starts a fake-provider
 * run through `window.__neotavernMobile.call` (the production JS→JNI path),
 * closes the shared kernel without `generation.cancel`, and asserts
 * interrupted → retry on the same data root.
 */
@RunWith(AndroidJUnit4::class)
class WebViewUserFlowInstrumentedTest {

    @Test
    fun hostConnectLocal_reachesAppShell_andSurvivesRecreate() {
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        try {
            ensureLocalShell(scenario)
            scenario.recreate()
            waitUntil("app-shell after recreate") {
                js(scenario, HAS_SHELL) == "yes"
            }
        } finally {
            scenario.close()
        }
    }

    @Test
    fun webView_isEdgeToEdge_andPublishesSafeAreaCss() {
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        try {
            waitUntil("host-connect or app-shell") {
                js(scenario, HOST_OR_SHELL) == "ready"
            }
            waitUntil("Android safe-area CSS vars") {
                val safeRaw = js(scenario, SAFE_AREA_TOP).replace("px", "").trim()
                val insetRaw = js(scenario, INSET_TOP).replace("px", "").trim()
                val safePx = safeRaw.toIntOrNull() ?: 0
                val insetPx = insetRaw.toIntOrNull() ?: 0
                var webTop = -1
                scenario.onActivity { activity ->
                    val web = activity.findViewById<WebView>(R.id.neotavern_webview)
                    val loc = IntArray(2)
                    web.getLocationOnScreen(loc)
                    webTop = loc[1]
                }
                webTop == 0 && safePx > 0 && insetPx > 0
            }
        } finally {
            scenario.close()
        }
    }

    @Test
    fun hostConnectLocal_catalogSettingsComposer_reachKernelUi() {
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        try {
            ensureLocalShell(scenario)
            waitUntil("home with Hazel composer") {
                js(scenario, HAS_HOME) == "yes" && js(scenario, COMPOSER_HAZEL) == "hazel"
            }

            val toggle = js(scenario, CLICK_MENU_TOGGLE)
            assertTrue("rail menu toggle, got $toggle", toggle == "expanded" || toggle == "already")
            waitUntil("characters rail item") {
                js(scenario, HAS_RAIL_CHARACTERS) == "yes"
            }

            val openedCatalog = js(scenario, CLICK_RAIL_CHARACTERS)
            assertTrue("characters rail clicked, got $openedCatalog", openedCatalog == "clicked")
            waitUntil("character-management lists Hazel") {
                js(scenario, HAZEL_IN_CATALOG) == "yes"
            }

            val openedSettings = js(scenario, CLICK_RAIL_SETTINGS)
            assertTrue("settings rail clicked, got $openedSettings", openedSettings == "clicked")
            waitUntil("settings-panel with change-host") {
                js(scenario, HAS_SETTINGS_HOST) == "yes"
            }

            scenario.recreate()
            waitUntil("app-shell after settings recreate") {
                js(scenario, HAS_SHELL) == "yes"
            }
        } finally {
            scenario.close()
        }
    }

    @Test(timeout = 180_000)
    fun hostConnectLocal_generationViaBridge_processDeathInterruptedThenRetry() {
        grantPostNotifications()
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        var recoverySession: KernelSession? = null
        try {
            ensureLocalShell(scenario)
            waitUntil("home with Hazel composer") {
                js(scenario, HAS_HOME) == "yes" && js(scenario, COMPOSER_HAZEL) == "hazel"
            }

            var productionHolder: KernelHolder? = null
            scenario.onActivity { activity ->
                productionHolder = KernelHost.holder(
                    ManagedDataRoot(activity).ensure().absolutePath,
                )
            }
            val liveHolder = checkNotNull(productionHolder) { "production KernelHolder missing" }
            assertTrue("production kernel is open", liveHolder.session.isOpen)

            waitUntil("bridge callback surface") {
                js(scenario, PATCH_CALLBACKS) == "ok"
            }

            val listEnvelope = unaryViaBridge(
                scenario,
                "characters.list",
                JSONObject().put("limit", 50),
            )
            assertEquals("characters.list ok", "ok", listEnvelope.getString("kind"))
            val items = listEnvelope.getJSONObject("result").getJSONArray("items")
            var hazelId: String? = null
            for (i in 0 until items.length()) {
                val row = items.getJSONObject(i)
                if (row.optString("name").contains("Hazel", ignoreCase = true)) {
                    hazelId = row.getString("id")
                    break
                }
            }
            assertTrue("Hazel in characters.list", hazelId != null)

            val chatEnvelope = unaryViaBridge(
                scenario,
                "chats.create",
                JSONObject()
                    .put("characterId", hazelId)
                    .put("title", "M6 process-death"),
            )
            assertEquals("chats.create ok", "ok", chatEnvelope.getString("kind"))
            val chatId = chatEnvelope.getJSONObject("result").getString("id")

            val streamCallbackId = startStreamViaBridge(
                scenario,
                "generation.start",
                JSONObject()
                    .put("chatId", chatId)
                    .put("message", "Hello from the WebView process-death test")
                    .put("provider", "fake")
                    .put("model", "steps=32;delay-ms=200;tokens-per-step=24"),
            )
            val runId = awaitStreamId(scenario, streamCallbackId, 25_000)

            // Process-death simulation: drop the FGS claim so onDestroy does
            // not generation.cancel, then close the activity. KernelHolder
            // hitting zero closes the session without cancelling the run —
            // the same recovery BackgroundExecutionInstrumentedTest covers
            // on a temp root, here on the UI data root through the JS bridge.
            for (claim in ForegroundExecutionCoordinator.claimedStreams()) {
                ForegroundExecutionCoordinator.unclaim(claim.wireStreamId)
            }
            try {
                context.stopService(Intent(context, GenerationService::class.java))
            } catch (_: Throwable) {
                // Best-effort: the service may not have started yet.
            }
            scenario.close()
            await("production holder released and executor terminated", 20_000) {
                if (liveHolder.isReleased && liveHolder.executor.isTerminated) Unit else null
            }
            SystemClock.sleep(500)

            val dataRoot = ManagedDataRoot(context).ensure().absolutePath
            val reopened = KernelSession(JniNativeKernel, dataRoot)
            recoverySession = reopened
            var lastOpenError: Exception? = null
            val openDeadline = SystemClock.elapsedRealtime() + 20_000
            while (SystemClock.elapsedRealtime() < openDeadline) {
                try {
                    reopened.open()
                    lastOpenError = null
                    break
                } catch (e: Exception) {
                    lastOpenError = e
                    SystemClock.sleep(500)
                }
            }
            if (!reopened.isOpen) {
                throw AssertionError(
                    "kernel reopen after UI process-death failed: $lastOpenError",
                    lastOpenError,
                )
            }
            assertEquals(
                "run interrupted after UI-path process death",
                "interrupted",
                runStatus(reopened, runId),
            )

            val builder = EnvelopeBuilder.fromHandshake(reopened.handshake())
            val retryEnvelope = builder.request(
                builder.newRequestId(),
                "generation.retry",
                JSONObject().put("sourceRunId", runId).toString(),
            )
            val retryHandle = reopened.startStream(retryEnvelope)
            val retryRunId = awaitFirstEventRunId(reopened, retryHandle, 20_000)
            drainUntilTerminal(reopened, retryHandle, 30_000)
            val retryResponse = generationGet(reopened, retryRunId)
            assertEquals("retry completed", "completed", retryResponse.getString("status"))
            assertEquals("retry is attempt 2", 2, retryResponse.getInt("attempt"))
            assertTrue("retry produced a message", retryResponse.has("messageId"))
        } finally {
            try {
                context.stopService(Intent(context, GenerationService::class.java))
            } catch (_: Throwable) {
                // Best-effort teardown.
            }
            for (claim in ForegroundExecutionCoordinator.claimedStreams()) {
                ForegroundExecutionCoordinator.unclaim(claim.wireStreamId)
            }
            try {
                scenario.close()
            } catch (_: Throwable) {
                // Already closed on the happy path.
            }
            val holder = recoverySession
            if (holder != null) {
                try {
                    holder.close()
                } catch (_: Throwable) {
                    // Best-effort teardown.
                }
            }
        }
    }

    private fun ensureLocalShell(scenario: ActivityScenario<MainActivity>) {
        waitUntil("host-connect or app-shell") {
            js(scenario, HOST_OR_SHELL) == "ready"
        }
        if (js(scenario, HAS_HOST_CONNECT) == "yes") {
            assertTrue(
                "Theme SDK card chrome on the gate",
                js(scenario, HAS_THEMED_GATE) == "yes",
            )
            val clicked = js(scenario, CLICK_LOCAL)
            assertTrue("local action present, got $clicked", clicked == "clicked")
            waitUntil("app-shell after local connect") {
                js(scenario, HAS_SHELL) == "yes"
            }
        }
        assertTrue("app shell visible", js(scenario, HAS_SHELL) == "yes")
    }

    private fun js(scenario: ActivityScenario<MainActivity>, expression: String): String {
        val raw = jsRaw(scenario, expression)
        return decodeJsResult(raw)
    }

    private fun jsRaw(scenario: ActivityScenario<MainActivity>, expression: String): String {
        val box = ArrayBlockingQueue<String>(1)
        scenario.onActivity { activity ->
            val web = activity.findViewById<WebView>(R.id.neotavern_webview)
            web.evaluateJavascript(expression) { value -> box.offer(value ?: "null") }
        }
        return box.poll(8, TimeUnit.SECONDS) ?: "null"
    }

    private fun decodeJsResult(raw: String): String {
        if (raw == "null") return "null"
        return try {
            val value = JSONTokener(raw).nextValue()
            value?.toString() ?: "null"
        } catch (_: Exception) {
            raw.trim().trim('"')
        }
    }

    /** Decode an evaluateJavascript inbox probe: object, JSON string, or `pending`. */
    private fun parseInbox(raw: String): JSONObject? {
        if (raw == "null") return null
        val value = try {
            JSONTokener(raw).nextValue()
        } catch (_: Exception) {
            return null
        }
        return when (value) {
            is JSONObject -> value
            is String -> if (value == "pending") null else JSONObject(value)
            else -> null
        }
    }

    private fun waitUntil(label: String, timeoutMs: Long = 30_000, probe: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + timeoutMs
        while (SystemClock.elapsedRealtime() < deadline) {
            try {
                if (probe()) return
            } catch (_: RuntimeException) {
                // Activity may still be creating the WebView.
            }
            SystemClock.sleep(250)
        }
        fail("timed out waiting for $label")
    }

    private fun unaryViaBridge(
        scenario: ActivityScenario<MainActivity>,
        operationId: String,
        payload: JSONObject,
    ): JSONObject {
        val requestId = UUID.randomUUID().toString()
        val callbackId = "nt-test-$requestId"
        val dispatched = js(
            scenario,
            dispatchJs(requestId, callbackId, operationId, payload),
        )
        assertEquals("bridge call dispatched", callbackId, dispatched)
        var envelope: JSONObject? = null
        waitUntil("unary $operationId") {
            val parsed = parseInbox(jsRaw(scenario, inboxJs(callbackId)))
            if (parsed == null) {
                false
            } else {
                envelope = parsed
                true
            }
        }
        val result = checkNotNull(envelope) { "$operationId produced no envelope" }
        assertTrue(
            "$operationId was not rejected",
            result.optString("kind") != "reject",
        )
        return result
    }

    private fun startStreamViaBridge(
        scenario: ActivityScenario<MainActivity>,
        operationId: String,
        payload: JSONObject,
    ): String {
        val requestId = UUID.randomUUID().toString()
        val callbackId = "nt-test-$requestId"
        val dispatched = js(
            scenario,
            dispatchJs(requestId, callbackId, operationId, payload),
        )
        assertEquals("stream call dispatched", callbackId, dispatched)
        return callbackId
    }

    private fun awaitStreamId(
        scenario: ActivityScenario<MainActivity>,
        callbackId: String,
        timeoutMs: Long,
    ): String {
        var runId: String? = null
        waitUntil("generation stream id", timeoutMs) {
            val parsed = parseInbox(jsRaw(scenario, inboxJs(callbackId)))
            val id = parsed?.optString("streamId").orEmpty()
            if (id.isBlank()) {
                false
            } else {
                runId = id
                true
            }
        }
        return checkNotNull(runId) { "generation stream produced no streamId" }
    }

    private fun grantPostNotifications() {
        if (Build.VERSION.SDK_INT < 33) return
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val descriptor = InstrumentationRegistry.getInstrumentation().uiAutomation
            .executeShellCommand("pm grant ${context.packageName} android.permission.POST_NOTIFICATIONS")
        descriptor?.use { fd ->
            ParcelFileDescriptor.AutoCloseInputStream(fd).readBytes()
        }
    }

    private fun <T> await(
        description: String,
        timeoutMillis: Long,
        pollMillis: Long = 250L,
        block: () -> T?,
    ): T {
        val deadline = SystemClock.elapsedRealtime() + timeoutMillis
        while (SystemClock.elapsedRealtime() < deadline) {
            block()?.let { return it }
            SystemClock.sleep(pollMillis)
        }
        throw AssertionError("Timed out after ${timeoutMillis}ms waiting for: $description")
    }

    private fun generationGet(session: KernelSession, runId: String): JSONObject {
        val builder = EnvelopeBuilder.fromHandshake(session.handshake())
        val envelope = builder.request(
            builder.newRequestId(),
            "generation.get",
            JSONObject().put("workflowId", runId).toString(),
        )
        val response = JSONObject(session.callEnvelope(envelope))
        assertEquals("generation.get ok", "ok", response.getString("kind"))
        return response.getJSONObject("result")
    }

    private fun runStatus(session: KernelSession, runId: String): String =
        generationGet(session, runId).getString("status")

    private fun awaitFirstEventRunId(
        session: KernelSession,
        streamHandle: Long,
        timeoutMillis: Long,
    ): String {
        val deadline = SystemClock.elapsedRealtime() + timeoutMillis
        while (SystemClock.elapsedRealtime() < deadline) {
            val payload = session.waitEvent(streamHandle, 5_000) ?: continue
            val json = JSONObject(String(payload, Charsets.UTF_8))
            when (json.getString("kind")) {
                "event" -> return json.getJSONObject("event").getString("streamId")
                else -> throw AssertionError("stream ended before the first event: $json")
            }
        }
        throw AssertionError("Timed out waiting for the first stream event")
    }

    private fun drainUntilTerminal(
        session: KernelSession,
        streamHandle: Long,
        timeoutMillis: Long,
    ) {
        val deadline = SystemClock.elapsedRealtime() + timeoutMillis
        while (SystemClock.elapsedRealtime() < deadline) {
            val payload = session.waitEvent(streamHandle, 5_000) ?: continue
            val kind = JSONObject(String(payload, Charsets.UTF_8)).getString("kind")
            if (NotificationState.isTerminal(kind)) return
        }
        throw AssertionError("Timed out draining the stream to terminal")
    }

    private companion object {
        const val HAS_HOST_CONNECT =
            "(document.querySelector('[data-component=\"host-connect\"]') ? 'yes' : 'no')"
        const val HAS_THEMED_GATE =
            "(document.querySelector('[data-component=\"host-connect\"] [data-component=\"card\"]') && document.querySelector('[data-component=\"host-connect\"] [data-component=\"segmented\"]') ? 'yes' : 'no')"
        const val HAS_SHELL =
            "(document.querySelector('[data-component=\"app-shell\"]') ? 'yes' : 'no')"
        const val HOST_OR_SHELL =
            "(document.querySelector('[data-component=\"host-connect\"],[data-component=\"app-shell\"]') ? 'ready' : 'wait')"
        const val CLICK_LOCAL =
            "(function(){ var b=document.querySelector('[data-action=\"use-on-this-device\"]'); if(b){ b.click(); return 'clicked'; } return 'missing'; })()"
        const val SAFE_AREA_TOP =
            "(getComputedStyle(document.documentElement).getPropertyValue('--nt-safe-area-top').trim())"
        const val INSET_TOP =
            "(getComputedStyle(document.documentElement).getPropertyValue('--nt-inset-top').trim())"
        const val HAS_HOME =
            "(document.querySelector('[data-component=\"home\"]') ? 'yes' : 'no')"
        const val COMPOSER_HAZEL =
            "(function(){ var t=document.querySelector('#home-message'); if(!t) return 'missing'; var ph=t.getAttribute('placeholder')||''; return /Hazel/i.test(ph) ? 'hazel' : (ph || 'empty'); })()"
        const val CLICK_MENU_TOGGLE =
            "(function(){ var b=document.querySelector('[data-action=\"menu-toggle\"]'); if(!b) return 'missing'; if(b.getAttribute('data-state')==='collapsed'){ b.click(); return 'expanded'; } return 'already'; })()"
        const val HAS_RAIL_CHARACTERS =
            "(document.querySelector('[data-item=\"characters\"] [data-part=\"item-control\"]') ? 'yes' : 'no')"
        const val CLICK_RAIL_CHARACTERS =
            "(function(){ var b=document.querySelector('[data-item=\"characters\"] [data-part=\"item-control\"]'); if(b){ b.click(); return 'clicked'; } return 'missing'; })()"
        const val CLICK_RAIL_SETTINGS =
            "(function(){ var b=document.querySelector('[data-item=\"settings\"] [data-part=\"item-control\"]'); if(b){ b.click(); return 'clicked'; } return 'missing'; })()"
        const val HAZEL_IN_CATALOG =
            "(document.querySelector('[data-component=\"character-management\"] [data-name=\"Hazel\"]') ? 'yes' : 'no')"
        const val HAS_SETTINGS_HOST =
            "(document.querySelector('[data-component=\"settings-panel\"] [data-action=\"change-host\"]') ? 'yes' : 'no')"
        const val PATCH_CALLBACKS =
            """(function(){
              if (window.__neotavernTestPatched) return 'ok';
              var orig = window.__neotavernMobileCallbacks;
              if (!orig) return 'no-callbacks';
              window.__neotavernTestInbox = {};
              window.__neotavernMobileCallbacks = {
                resolve: function(id, env) {
                  try {
                    if (env && env.kind === 'event' && env.event && env.event.streamId) {
                      window.__neotavernTestInbox[id] = { kind: 'stream', streamId: env.event.streamId };
                    } else if (env && env.kind !== 'terminal') {
                      window.__neotavernTestInbox[id] = env;
                    }
                  } catch (e) {}
                  orig.resolve(id, env);
                },
                reject: function(id, err) {
                  window.__neotavernTestInbox[id] = { kind: 'reject', error: err };
                  orig.reject(id, err);
                }
              };
              window.__neotavernTestPatched = true;
              return 'ok';
            })()"""

        fun dispatchJs(
            requestId: String,
            callbackId: String,
            operationId: String,
            payload: JSONObject,
        ): String =
            "(function(){" +
                "var hs=JSON.parse(window.__neotavernMobile.handshake());" +
                "var envelope=JSON.stringify({" +
                "wireProtocol:hs.wireProtocol," +
                "schemaHash:hs.schemaHash," +
                "requestId:'$requestId'," +
                "operationId:'$operationId'," +
                "payload:${payload.toString()}" +
                "});" +
                "window.__neotavernMobile.call('$requestId', envelope, '$callbackId');" +
                "return '$callbackId';" +
                "})()"

        fun inboxJs(callbackId: String): String =
            "(function(){ var v=window.__neotavernTestInbox && window.__neotavernTestInbox['$callbackId']; return v ? v : 'pending'; })()"
    }
}
