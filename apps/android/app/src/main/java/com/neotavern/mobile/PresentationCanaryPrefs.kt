package com.neotavern.mobile

import android.content.Context

/**
 * Persisted canary kill switch, crash-loop counter, debug opt-in, and last
 * chat id. SharedPreferences only — no JNI, no Kernel.
 *
 * Opt-in / guard writes use [commit] so a force-stop right after
 * `NEOTA_DIOXUS_SHELL=1` still sees the flag on the next icon launch.
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
        prefs.edit().putBoolean(PresentationCanaryState.KEY_KILL_SWITCH, true).commit()
    }

    fun setCanaryEnabled(enabled: Boolean) {
        prefs.edit().putBoolean(PresentationCanaryState.KEY_CANARY_ENABLED, enabled).commit()
    }

    fun rememberChatId(chatId: String) {
        if (chatId.isEmpty()) {
            return
        }
        prefs.edit().putString(PresentationCanaryState.KEY_LAST_CHAT_ID, chatId).commit()
    }

    fun noteDioxusStart() {
        prefs.edit()
            .putInt(
                PresentationCanaryState.KEY_CRASH_FAILURES,
                PresentationCanaryState.incrementFailures(crashFailures),
            )
            .commit()
    }

    fun noteSuccess() {
        prefs.edit().putInt(PresentationCanaryState.KEY_CRASH_FAILURES, 0).commit()
    }

    fun applyFlagExtra(extra: String?, extraTrusted: Boolean) {
        val next = PresentationCanaryState.persistFromExtra(extra, extraTrusted) ?: return
        setCanaryEnabled(next)
    }

    fun resetGuards() {
        prefs.edit()
            .putBoolean(PresentationCanaryState.KEY_KILL_SWITCH, false)
            .putInt(PresentationCanaryState.KEY_CRASH_FAILURES, 0)
            .commit()
    }
}
