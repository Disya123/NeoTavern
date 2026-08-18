package com.neotavern.mobile

/**
 * Launch extras for the debug-only Milestone C chat route. No android.* so
 * JVM unit tests can cover parsing. Production [MainActivity] never reads
 * these. `NEOTA_DIOXUS_SHELL=1` is required; it is not a cutover switch.
 */
object PresentationChatLaunch {
    const val EXTRA_DIOXUS_SHELL: String = "com.neotavern.mobile.NEOTA_DIOXUS_SHELL"
    const val FLAG_ON: String = "1"

    fun parseFlag(extra: String?): String {
        return extra?.trim().orEmpty()
    }

    fun isFlagged(extra: String?): Boolean {
        return parseFlag(extra) == FLAG_ON
    }
}
