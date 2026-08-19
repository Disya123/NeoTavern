package com.neotavern.mobile

/**
 * PURE persisted-canary rules (ADR-0051). No android.* so JVM tests can
 * cover debug opt-in, crash-loop, and extra trust without a device.
 *
 * Debug extras may set or clear the app-private opt-in. Release ignores
 * extras and waits for a signed rollout config.
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

    fun extrasTrusted(debuggable: Boolean): Boolean {
        return debuggable
    }

    /**
     * Debug extra `1` persists on, extra `0` persists off.
     * Untrusted extras (release) and absent extras do not change storage.
     */
    fun persistFromExtra(extra: String?, extraTrusted: Boolean): Boolean? {
        if (!extraTrusted) {
            return null
        }
        return when (PresentationChatLaunch.parseFlag(extra)) {
            PresentationChatLaunch.FLAG_ON -> true
            PresentationChatLaunch.FLAG_OFF -> false
            else -> null
        }
    }

    /**
     * Debug: extra `1`/`0` wins this launch; otherwise the persisted opt-in.
     * Release: extras are ignored; only a signed rollout config can enable.
     */
    fun canaryFlag(
        extra: String?,
        persisted: Boolean,
        extraTrusted: Boolean,
        signedRollout: Boolean = false,
    ): Boolean {
        if (extraTrusted) {
            val parsed = PresentationChatLaunch.parseFlag(extra)
            if (parsed == PresentationChatLaunch.FLAG_OFF) {
                return false
            }
            if (parsed == PresentationChatLaunch.FLAG_ON) {
                return true
            }
            return persisted
        }
        return signedRollout
    }

    fun incrementFailures(current: Int): Int {
        if (current >= MAX_CRASH_LOOP) {
            return MAX_CRASH_LOOP
        }
        return current + 1
    }
}
