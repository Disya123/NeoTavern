package com.neotavern.mobile

/**
 * Launch extras for the Rust App Shell host ([PresentationChatActivity]).
 * The home-screen icon opens this activity with the Dioxus shell on by
 * default. Pass `NEOTA_DIOXUS_SHELL=0` to disable the shell for harness
 * tests. WebView is not a route fallback.
 */
object PresentationChatLaunch {
    const val EXTRA_DIOXUS_SHELL: String = "com.neotavern.mobile.NEOTA_DIOXUS_SHELL"
    const val EXTRA_CHAT_ID: String = "com.neotavern.mobile.NEOTA_CHAT_ID"
    const val EXTRA_SAFE_MODE: String = "com.neotavern.mobile.NEOTA_SAFE_MODE"
    const val EXTRA_CHAT_PROFILE: String = "com.neotavern.mobile.NEOTA_CHAT_PROFILE"
    const val EXTRA_FORCE_INIT_FAILURE: String = "com.neotavern.mobile.NEOTA_FORCE_INIT_FAILURE"
    const val EXTRA_CANARY_SESSION: String = "com.neotavern.mobile.NEOTA_CANARY_SESSION"
    const val EXTRA_CANARY_RESET: String = "com.neotavern.mobile.NEOTA_CANARY_RESET"
    const val FLAG_ON: String = "1"
    const val FLAG_OFF: String = "0"
    const val PROFILE_ISOLATED_10K: String = "isolated-10k"
    const val ISOLATED_DATA_ROOT: String = "neotavern-isolated-10k"

    fun parseFlag(extra: String?): String {
        return extra?.trim().orEmpty()
    }

    fun isFlagged(extra: String?): Boolean {
        return parseFlag(extra) == FLAG_ON
    }

    fun parseChatId(extra: String?): String {
        return extra?.trim().orEmpty()
    }

    fun isSafeMode(extra: String?): Boolean {
        return parseFlag(extra) == FLAG_ON
    }

    fun isForceInitFailure(extra: String?): Boolean {
        return parseFlag(extra) == FLAG_ON
    }

    fun isCanarySession(extra: String?): Boolean {
        return parseFlag(extra) == FLAG_ON
    }

    fun isCanaryReset(extra: String?): Boolean {
        return parseFlag(extra) == FLAG_ON
    }

    fun isFlagOff(extra: String?): Boolean {
        return parseFlag(extra) == FLAG_OFF
    }

    fun parseProfile(extra: String?): String {
        return extra?.trim().orEmpty()
    }

    fun isIsolated10k(extra: String?): Boolean {
        return parseProfile(extra) == PROFILE_ISOLATED_10K
    }
}
