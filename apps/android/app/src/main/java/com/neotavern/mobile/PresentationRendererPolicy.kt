package com.neotavern.mobile

/**
 * PURE selector for the Android presentation renderer (ADR-0051).
 * No android.* so JVM tests can prove TalkBack/touch exploration never
 * authorizes a Rust presentation host.
 */
object PresentationRendererPolicy {
    const val REASON_SAFE_MODE: String = "safe_mode"
    const val REASON_KILL_SWITCH: String = "kill_switch"
    const val REASON_CRASH_LOOP: String = "crash_loop"
    const val REASON_TOUCH_EXPLORATION: String = "accessibility_touch_exploration"
    const val REASON_UNQUALIFIED: String = "unqualified_device"
    const val REASON_FLAG_OFF: String = "flag_off"
    const val REASON_CANARY: String = "canary"

    enum class Renderer {
        WEBVIEW,
        DIOXUS,
    }

    data class Inputs(
        val safeMode: Boolean,
        val killSwitch: Boolean,
        val crashLoop: Boolean,
        val touchExplorationEnabled: Boolean,
        val deviceQualified: Boolean,
        val canaryFlag: Boolean,
    )

    data class Decision(
        val renderer: Renderer,
        val reason: String,
        val rustHostAllowed: Boolean,
    )

    fun decide(inputs: Inputs): Decision {
        if (inputs.safeMode) return webView(REASON_SAFE_MODE)
        if (inputs.killSwitch) return webView(REASON_KILL_SWITCH)
        if (inputs.crashLoop) return webView(REASON_CRASH_LOOP)
        if (inputs.touchExplorationEnabled) return webView(REASON_TOUCH_EXPLORATION)
        if (!inputs.deviceQualified) return webView(REASON_UNQUALIFIED)
        if (!inputs.canaryFlag) return webView(REASON_FLAG_OFF)
        return Decision(Renderer.DIOXUS, REASON_CANARY, rustHostAllowed = true)
    }

    /**
     * Apply [decide] and create a Rust host only when allowed.
     * Tests pass a probe [onCreateRustHost] to prove a11y never creates it.
     */
    fun select(inputs: Inputs, onCreateRustHost: () -> Unit): Decision {
        val decision = decide(inputs)
        if (decision.rustHostAllowed) {
            onCreateRustHost()
        }
        return decision
    }

    private fun webView(reason: String): Decision {
        return Decision(Renderer.WEBVIEW, reason, rustHostAllowed = false)
    }
}
