package com.neotavern.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM tests for [EnvelopeBuilder]: the golden request envelope must be
 * byte-identical to the TypeScript `buildRequestEnvelope` output (field
 * order `wireProtocol{major,minor}`, `schemaHash`, `requestId`,
 * `operationId`, `payload`; compact JSON, no spaces), plus handshake
 * parsing and v4 request ids.
 */
class EnvelopeBuilderTest {

    /** Same fixed id the web-side transport tests use. */
    private val FIXED_REQUEST_ID = "00000000-0000-4000-8000-000000000001"

    private val WIRE_SCHEMA_HASH = "b53337280f25a15e4698c423791f15eace1de0a2721ff4c550913334a81df783"

    private val builder = EnvelopeBuilder(
        protocolMajor = 1,
        protocolMinor = 0,
        schemaHash = WIRE_SCHEMA_HASH,
    )

    @Test
    fun `request builds the golden envelope byte-identically`() {
        val envelope = builder.request(FIXED_REQUEST_ID, "meta.get", "{}")

        // JSON.stringify-compact: no spaces anywhere, exact property order.
        assertEquals(
            """{"wireProtocol":{"major":1,"minor":0},"schemaHash":"$WIRE_SCHEMA_HASH","requestId":"$FIXED_REQUEST_ID","operationId":"meta.get","payload":{}}""",
            envelope,
        )
    }

    @Test
    fun `request embeds the payload as a nested JSON value, not a string`() {
        val envelope = builder.request(
            FIXED_REQUEST_ID,
            "characters.get",
            """{"characterId":"00000000-0000-4000-8000-000000000001"}""",
        )

        assertEquals(
            """{"wireProtocol":{"major":1,"minor":0},"schemaHash":"$WIRE_SCHEMA_HASH","requestId":"$FIXED_REQUEST_ID","operationId":"characters.get","payload":{"characterId":"00000000-0000-4000-8000-000000000001"}}""",
            envelope,
        )
    }

    @Test
    fun `fromHandshake reads protocol and schema hash from the handshake json`() {
        val handshake =
            """{"ffiAbiVersion":1,"schemaHash":"0123456789abcdef","wireProtocol":{"major":1,"minor":0},"appVersion":"0.1.0-test"}"""

        val fromHandshake = EnvelopeBuilder.fromHandshake(handshake)

        val envelope = fromHandshake.request(FIXED_REQUEST_ID, "meta.get", "{}")
        assertEquals(
            """{"wireProtocol":{"major":1,"minor":0},"schemaHash":"0123456789abcdef","requestId":"$FIXED_REQUEST_ID","operationId":"meta.get","payload":{}}""",
            envelope,
        )
    }

    @Test
    fun `newRequestId returns RFC 4122 v4 uuids`() {
        val pattern = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

        val a = builder.newRequestId()
        val b = builder.newRequestId()

        assertTrue("v4 pattern: $a", pattern.matches(a))
        assertTrue("v4 pattern: $b", pattern.matches(b))
        assertTrue(a != b)
    }
}
