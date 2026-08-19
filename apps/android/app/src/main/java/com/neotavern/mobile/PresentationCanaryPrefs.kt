package com.neotavern.mobile

import android.content.Context

/**
 * Persisted canary kill switch, crash-loop counter, flag, and last chat id.
 * SharedPreferences only — no JNI, no Kernel.
 */
class PresentationCanaryPrefs(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(
        PresentationCanaryState.PREFS_NAME,
        Context.MODE_PRIVATE,
    )

    val killSwitch: Boolean
        get() = prefs.getBoolean(PresentationCanaryState.KEY_KILL_SWITCH, false)

    val crashFailures: Int
        get() = prefs.getInt(PresentationCanaryState.KEY_CRASH_FAILURES, 0)

    val canaryEnabled: Boolean
        get() = prefs.getBoolean(PresentationCanaryState.KEY_CANARY_ENABLED, false)

    val lastChatId: String
        get() = prefs.getString(PresentationCanaryState.KEY_LAST_CHAT_ID, "").orEmpty()

    fun armKillSwitch() {
        prefs.edit().putBoolean(PresentationCanaryState.KEY_KILL_SWITCH, true).apply()
    }

    fun setCanaryEnabled(enabled: Boolean) {
        prefs.edit().putBoolean(PresentationCanaryState.KEY_CANARY_ENABLED, enabled).apply()
    }

    fun rememberChatId(chatId: String) {
        if (chatId.isEmpty()) {
            return
        }
        prefs.edit().putString(PresentationCanaryState.KEY_LAST_CHAT_ID, chatId).apply()
    }

    fun noteDioxusStart() {
        prefs.edit()
            .putInt(
                PresentationCanaryState.KEY_CRASH_FAILURES,
                PresentationCanaryState.incrementFailures(crashFailures),
            )
            .apply()
    }

    fun noteSuccess() {
        prefs.edit().putInt(PresentationCanaryState.KEY_CRASH_FAILURES, 0).apply()
    }

    fun applyFlagExtra(extra: String?) {
        when (PresentationChatLaunch.parseFlag(extra)) {
            PresentationChatLaunch.FLAG_ON -> setCanaryEnabled(true)
            PresentationChatLaunch.FLAG_OFF -> setCanaryEnabled(false)
        }
    }

    fun resetGuards() {
        prefs.edit()
            .putBoolean(PresentationCanaryState.KEY_KILL_SWITCH, false)
            .putInt(PresentationCanaryState.KEY_CRASH_FAILURES, 0)
            .apply()
    }
}
