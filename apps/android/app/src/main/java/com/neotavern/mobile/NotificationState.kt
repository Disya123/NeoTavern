package com.neotavern.mobile

/**
 * Constants and pure label mapping for the generation foreground
 * notification (ТЗ §8). PURE Kotlin — no android.* imports, JVM-testable.
 *
 * Privacy (§85): the notification NEVER includes chat or message content.
 * Only the opaque channel/action identifiers and generic state labels live
 * here; the service (Host-owned) supplies its own neutral title/body text.
 */
object NotificationState {

    /** Notification channel id for generation progress. */
    const val CHANNEL_ID = "neotavern_generation"

    /** User-visible channel name. */
    const val CHANNEL_NAME = "Generation"

    /** Action id for the notification's "stop generation" action. */
    const val ACTION_STOP = "com.neotavern.mobile.action.STOP_GENERATION"

    /** Stable notification id for the generation foreground notification. */
    const val NOTIFICATION_ID = 1001

    /**
     * Maps a stream payload `kind` (from `{"kind":...}`) to the neutral
     * notification title label, or `null` for unknown kinds.
     *
     * - `"event"` → `"Generating"`
     * - `"terminal"` → `"Complete"`
     * - `"error"` → `"Failed"`
     */
    fun titleForStreamState(kind: String): String? = when (kind) {
        "event" -> "Generating"
        "terminal" -> "Complete"
        "error" -> "Failed"
        else -> null
    }

    /**
     * Whether `kind` ends the stream: `true` for `"terminal"` and `"error"`
     * (the notification should be dismissed), `false` otherwise.
     */
    fun isTerminal(kind: String): Boolean = kind == "terminal" || kind == "error"
}
