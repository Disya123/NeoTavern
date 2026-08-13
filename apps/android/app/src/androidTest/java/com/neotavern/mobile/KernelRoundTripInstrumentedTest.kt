package com.neotavern.mobile

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

/**
 * End-to-end kernel round trip on a real device/emulator: the JNI
 * `neotavern_android_jni` library must be present (built by
 * scripts/build-libs.sh into jniLibs and packaged into the APK).
 *
 * Exercises the same wire envelopes the transports use (byte-identical to
 * the TauriTransport request envelope): open → handshake → meta.get →
 * characters.create → characters.list → close → NEW session on the same
 * data root → durability after a simulated process death.
 */
@RunWith(AndroidJUnit4::class)
class KernelRoundTripInstrumentedTest {

    private lateinit var dataRoot: File
    private lateinit var session: KernelSession

    @Before
    fun setUp() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        dataRoot = File(context.cacheDir, "kernel-roundtrip-${UUID.randomUUID()}")
        assertTrue("temp data root created", dataRoot.mkdirs())
    }

    @After
    fun tearDown() {
        if (::session.isInitialized) {
            try {
                session.close()
            } catch (ignored: Throwable) {
                // Best-effort teardown; a failing close must not mask the test result.
            }
        }
        dataRoot.deleteRecursively()
    }

    @Test
    fun metaGet_createList_roundTrip_andDurabilityAfterReopen() {
        // --- First "process": open, handshake, unary round trips. -----------
        session = KernelSession(JniNativeKernel, dataRoot.absolutePath)
        session.open()

        val handshake = JSONObject(session.handshake())
        val schemaHash = handshake.getString("schemaHash")
        assertTrue("schemaHash present", schemaHash.isNotBlank())

        // meta.get envelope round trip with a valid-v4 requestId and an echo check.
        val metaRequestId = UUID.randomUUID().toString()
        val metaResponse = JSONObject(
            session.callEnvelope(requestEnvelope(schemaHash, "meta.get", JSONObject(), metaRequestId)),
        )
        assertEquals("ok", metaResponse.getString("kind"))
        assertEquals(metaRequestId, metaResponse.getString("requestId"))
        val metaResult = metaResponse.getJSONObject("result")
        val productWire = metaResult.getJSONObject("productWire")
        assertEquals(1, productWire.getInt("major"))
        assertEquals(0, productWire.getInt("minor"))

        // characters.create with a minimal valid payload (only name required).
        val createResponse = JSONObject(
            session.callEnvelope(
                requestEnvelope(
                    schemaHash,
                    "characters.create",
                    JSONObject().put("name", "Instrumented Char"),
                ),
            ),
        )
        assertEquals("ok", createResponse.getString("kind"))
        val created = createResponse.getJSONObject("result")
        val createdId = created.getString("id")
        assertEquals("Instrumented Char", created.getString("name"))

        // characters.list contains the created character.
        val listResponse = JSONObject(
            session.callEnvelope(requestEnvelope(schemaHash, "characters.list", JSONObject())),
        )
        assertEquals("ok", listResponse.getString("kind"))
        val items = listResponse.getJSONObject("result").getJSONArray("items")
        assertTrue("created character listed", containsName(items, "Instrumented Char"))

        // --- Simulated process death: close releases the lease + handle. ----
        session.close()

        // --- Second "process": NEW session on the same data root. ----------
        session = KernelSession(JniNativeKernel, dataRoot.absolutePath)
        session.open()

        val listResponse2 = JSONObject(
            session.callEnvelope(requestEnvelope(schemaHash, "characters.list", JSONObject())),
        )
        assertEquals("ok", listResponse2.getString("kind"))
        val items2 = listResponse2.getJSONObject("result").getJSONArray("items")
        assertTrue(
            "created character survived the simulated process death",
            containsName(items2, "Instrumented Char"),
        )
        assertTrue("created id matches across reopen", containsId(items2, createdId))
    }

    /** Builds a wire request envelope, byte-identical to the TauriTransport shape. */
    private fun requestEnvelope(
        schemaHash: String,
        operationId: String,
        payload: JSONObject,
        requestId: String = UUID.randomUUID().toString(),
    ): String = JSONObject()
        .put(
            "wireProtocol",
            JSONObject().put("major", 1).put("minor", 0),
        )
        .put("schemaHash", schemaHash)
        .put("requestId", requestId)
        .put("operationId", operationId)
        .put("payload", payload)
        .toString()

    private fun containsName(items: JSONArray, name: String): Boolean {
        for (i in 0 until items.length()) {
            if (items.getJSONObject(i).getString("name") == name) return true
        }
        return false
    }

    private fun containsId(items: JSONArray, id: String): Boolean {
        for (i in 0 until items.length()) {
            if (items.getJSONObject(i).getString("id") == id) return true
        }
        return false
    }
}
