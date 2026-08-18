package com.neotavern.mobile

/**
 * Launch extras for the debug-only Milestone C chat route. No android.* so
 * JVM unit tests can cover parsing. Production [MainActivity] never reads
 * these. `NEOTA_DIOXUS_SHELL=1` is required; it is not a cutover switch.
 */
object PresentationChatLaunch {
    const val EXTRA_DIOXUS_SHELL: String = "com.neotavern.mobile.NEOTA_DIOXUS_SHELL"
    const val EXTRA_CHAT_ID: String = "com.neotavern.mobile.NEOTA_CHAT_ID"
    const val EXTRA_SAFE_MODE: String = "com.neotavern.mobile.NEOTA_SAFE_MODE"
    const val EXTRA_CHAT_PROFILE: String = "com.neotavern.mobile.NEOTA_CHAT_PROFILE"
    const val FLAG_ON: String = "1"
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

    fun parseProfile(extra: String?): String {
        return extra?.trim().orEmpty()
    }

    fun isIsolated10k(extra: String?): Boolean {
        return parseProfile(extra) == PROFILE_ISOLATED_10K
    }
}
