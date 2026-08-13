package com.neotavern.mobile

import java.util.UUID
import org.json.JSONObject

/**
 * Builds `wire.request.envelope` JSON byte-identical to the TypeScript
 * [wireEnvelope builder](apps/web/src/api/wireEnvelope.ts) — the single
 * source of framing shared by every local transport (Tauri IPC, mobile
 * WebView bridge, background service), so the kernel adapter cannot tell
 * which shell produced a call (ТЗ §6.3/§15.1).
 *
 * The TS builder preserves property order through `JSON.stringify`, so a
 * request here serializes the same compact bytes for the same
 * requestId/operationId/payload:
 *
 * ```
 * {"wireProtocol":{"major":1,"minor":0},"schemaHash":"...","requestId":"...","operationId":"...","payload":...}
 * ```
 *
 * Fields are emitted in exactly that order: `wireProtocol{major,minor}`,
 * `schemaHash`, `requestId`, `operationId`, `payload`. The envelope is a
 * fixed-shape string assembled directly, so byte-identity never depends on a
 * JSON library's key ordering (the reference org.json used by unit tests is
 * HashMap-backed; the Android-framework org.json is insertion-ordered). The
 * payload is embedded as a nested JSON value (not a string) and must
 * therefore be a valid JSON object — every request schema in the wire
 * registry (`wire.request.*`) is an object, so callers pass e.g. `{}` or
 * `{"chatId":"..."}`.
 *
 * PURE Kotlin (org.json, which is also a unit-test dependency) — no
 * android.* imports.
 */
class EnvelopeBuilder(
    private val protocolMajor: Int,
    private val protocolMinor: Int,
    private val schemaHash: String,
) {

    /**
     * Serializes one request envelope for `operationId` with `payloadJson`.
     *
     * The envelope is a FIXED-SHAPE JSON string assembled directly (not via a
     * JSON library): byte-identity with the TypeScript builder must not
     * depend on any library's key ordering (the reference org.json used by
     * unit tests is HashMap-backed and does not preserve insertion order,
     * while the Android-framework org.json does). The identifier strings
     * ([schemaHash], [requestId], [operationId]) are contract-safe charsets
     * (lowercase hex, v4 UUID, `[a-z0-9._-]`) and need no escaping; the
     * payload is embedded verbatim as a nested JSON value (every
     * `wire.request.*` schema is a JSON object).
     */
    fun request(requestId: String, operationId: String, payloadJson: String): String {
        return "{\"wireProtocol\":{\"major\":$protocolMajor,\"minor\":$protocolMinor}," +
            "\"schemaHash\":\"$schemaHash\"," +
            "\"requestId\":\"$requestId\"," +
            "\"operationId\":\"$operationId\"," +
            "\"payload\":$payloadJson}"
    }

    /** A fresh RFC 4122 version-4 UUID (lowercase, hyphenated — matches `crypto.randomUUID()`). */
    fun newRequestId(): String = UUID.randomUUID().toString()

    companion object {
        /**
         * Builds a builder from the native kernel handshake JSON
         * (`{ffiAbiVersion, schemaHash, wireProtocol:{major,minor}, appVersion}`),
         * reading exactly the two fields the envelope needs.
         *
         * @throws org.json.JSONException when a field is missing or malformed
         */
        fun fromHandshake(handshakeJson: String): EnvelopeBuilder {
            val handshake = JSONObject(handshakeJson)
            val wireProtocol = handshake.getJSONObject("wireProtocol")
            return EnvelopeBuilder(
                protocolMajor = wireProtocol.getInt("major"),
                protocolMinor = wireProtocol.getInt("minor"),
                schemaHash = handshake.getString("schemaHash"),
            )
        }
    }
}
