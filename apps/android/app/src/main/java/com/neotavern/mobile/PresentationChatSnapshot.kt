package com.neotavern.mobile

import org.json.JSONException
import org.json.JSONObject

/**
 * Host-side view of the live Product Wire chat snapshot. Display only — no
 * Kernel, storage, or network. PURE Kotlin (org.json) so JVM tests cover it.
 *
 * [messageCount] is the Kernel `chats.get` count, never a local `+= 1`.
 */
data class PresentationChatSnapshot(
    val chatId: String,
    val title: String,
    val messageCount: Int,
    val kernelMessageCount: Int,
    val pageLen: Int,
    val composer: String,
    val error: String?,
    val streaming: Boolean,
    val requestId: String?,
    val operationId: String?,
    val durableMessageId: String?,
    val sceneEpoch: Long,
    val sendAccepted: Boolean,
    val visible: List<VisibleRow>,
) {
    data class VisibleRow(
        val id: String,
        val role: String,
        val content: String,
    )

    fun headerText(): String {
        return "$title ($messageCount)"
    }

    fun rowsText(): String {
        val lines = ArrayList<String>(visible.size + 2)
        if (streaming) {
            lines.add("streaming")
        }
        error?.let { lines.add("error: $it") }
        for (row in visible) {
            lines.add("${row.role}: ${row.content}")
        }
        return lines.joinToString("\n\n")
    }

    /** Debug line for send. Never includes composer or message bodies. */
    fun sendTraceLine(): String {
        return "chat_send live_wire=true requestId=${requestId ?: "-"} " +
            "operationId=${operationId ?: "-"} durableMessageId=${durableMessageId ?: "-"} " +
            "kernelMessageCount=$kernelMessageCount pageLen=$pageLen sceneEpoch=$sceneEpoch " +
            "sendAccepted=$sendAccepted error=${error ?: "none"} production_cutover=false"
    }

    companion object {
        fun parse(json: String): PresentationChatSnapshot? {
            val trimmed = json.trim()
            if (!trimmed.startsWith("{")) {
                return null
            }
            return try {
                val obj = JSONObject(trimmed)
                val visible = ArrayList<VisibleRow>()
                val array = obj.optJSONArray("visible")
                if (array != null) {
                    for (index in 0 until array.length()) {
                        val row = array.getJSONObject(index)
                        visible.add(
                            VisibleRow(
                                id = row.optString("id"),
                                role = row.optString("role"),
                                content = row.optString("content"),
                            ),
                        )
                    }
                }
                val error =
                    if (obj.isNull("error")) {
                        null
                    } else {
                        obj.optString("error").ifBlank { null }
                    }
                val messageCount = obj.optInt("messageCount")
                PresentationChatSnapshot(
                    chatId = obj.optString("chatId"),
                    title = obj.optString("title"),
                    messageCount = messageCount,
                    kernelMessageCount = obj.optInt("kernelMessageCount", messageCount),
                    pageLen = obj.optInt("pageLen"),
                    composer = obj.optString("composer"),
                    error = error,
                    streaming = obj.optBoolean("streaming"),
                    requestId = obj.optionalString("requestId"),
                    operationId = obj.optionalString("operationId"),
                    durableMessageId = obj.optionalString("durableMessageId"),
                    sceneEpoch = obj.optLong("sceneEpoch"),
                    sendAccepted = obj.optBoolean("sendAccepted"),
                    visible = visible,
                )
            } catch (_: JSONException) {
                null
            }
        }

        private fun JSONObject.optionalString(key: String): String? {
            if (isNull(key)) {
                return null
            }
            return optString(key).ifBlank { null }
        }
    }
}
