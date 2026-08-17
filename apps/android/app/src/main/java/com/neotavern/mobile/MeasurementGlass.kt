package com.neotavern.mobile

/**
 * M-1 Track A0 switch. PURE Kotlin so parsing and the injected bootstrap are
 * unit-tested on the JVM. Production default is [Profile.Live] (no DOM
 * mutation). [Profile.Off] is opt-in via the activity extra
 * [EXTRA_MEASUREMENT_GLASS] = `off`.
 */
object MeasurementGlass {

    const val EXTRA_MEASUREMENT_GLASS = "com.neotavern.mobile.MEASUREMENT_GLASS"

    const val DATA_ATTRIBUTE = "data-nt-measurement-glass"

    enum class Profile {
        Live,
        Off,
    }

    fun parse(extra: String?): Profile {
        val value = extra?.trim()?.lowercase().orEmpty()
        return when (value) {
            "", "live", "on", "a" -> Profile.Live
            "off", "static", "a0", "0" -> Profile.Off
            else -> Profile.Live
        }
    }

    /**
     * Sets or clears `data-nt-measurement-glass` on `documentElement`.
     * Attribute value is a compile-time constant — not interpolated from
     * untrusted input.
     */
    fun bootstrapJs(profile: Profile): String? {
        if (profile == Profile.Live) return null
        return "(function(){var r=document.documentElement;if(!r)return;" +
            "r.setAttribute('data-nt-measurement-glass','off');})()"
    }
}
