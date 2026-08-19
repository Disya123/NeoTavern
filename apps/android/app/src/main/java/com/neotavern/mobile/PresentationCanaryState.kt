package com.neotavern.mobile

/**
 * PURE persisted-canary rules (ADR-0051). No android.* so JVM tests can
 * cover flag persistence, crash-loop, and extra `0`/`1` without a device.
 */
object PresentationCanaryState {
    const val PREFS_NAME: String = "neotavern_presentation_canary"
    const val KEY_KILL_SWITCH: String = "kill_switch"
    const val KEY_CRASH_FAILURES: String = "crash_failures"
    const val KEY_CANARY_ENABLED: String = "canary_enabled"
    const val KEY_LAST_CHAT_ID: String = "last_chat_id"
    const val MAX_CRASH_LOOP: Int = 3

    fun crashLoop(failures: Int): Boolean {
        return failures >= MAX_CRASH_LOOP
    }

    /**
     * Extra `1` enables, extra `0` disables. An absent extra uses the
     * persisted flag. Default persisted is off (WebView).
     */
    fun canaryFlag(extra: String?, persisted: Boolean): Boolean {
        val parsed = extra?.trim().orEmpty()
        if (parsed == PresentationChatLaunch.FLAG_OFF) {
            return false
        }
        if (parsed == PresentationChatLaunch.FLAG_ON) {
            return true
        }
        return persisted
    }

    fun incrementFailures(current: Int): Int {
        if (current >= MAX_CRASH_LOOP) {
            return MAX_CRASH_LOOP
        }
        return current + 1
    }
}
