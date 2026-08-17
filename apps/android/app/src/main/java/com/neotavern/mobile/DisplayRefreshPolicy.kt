package com.neotavern.mobile

/**
 * Chooses a [preferredDisplayModeId][android.view.WindowManager.LayoutParams.preferredDisplayModeId]
 * candidate. PURE Kotlin (no android.*) so M-1 refresh selection is unit-tested
 * on the JVM without Robolectric.
 *
 * Matching is by physical pixel size: a 120 Hz mode at a different resolution
 * is not a substitute for the current panel mode. Among same-size modes the
 * highest refresh rate wins; ties keep the current mode id when it is already
 * maximal, otherwise the lowest id for a stable choice.
 */
object DisplayRefreshPolicy {

    data class Mode(
        val id: Int,
        val refreshRateHz: Float,
        val width: Int,
        val height: Int,
    )

    data class Decision(
        val requestedModeId: Int?,
        val requestedRefreshHz: Float?,
        val selected: Mode?,
        val supportedRatesHz: List<Float>,
        val reason: String,
    )

    fun chooseHighestRefresh(modes: List<Mode>, current: Mode): Decision {
        val supported = modes.map { it.refreshRateHz }.distinct().sorted()
        if (modes.isEmpty()) {
            return Decision(
                requestedModeId = null,
                requestedRefreshHz = null,
                selected = null,
                supportedRatesHz = emptyList(),
                reason = "no-modes",
            )
        }
        val sameSize = modes.filter { it.width == current.width && it.height == current.height }
        if (sameSize.isEmpty()) {
            return Decision(
                requestedModeId = current.id,
                requestedRefreshHz = current.refreshRateHz,
                selected = current,
                supportedRatesHz = supported,
                reason = "no-matching-resolution",
            )
        }
        val maxHz = sameSize.maxOf { it.refreshRateHz }
        val atMax = sameSize.filter { almostEqualHz(it.refreshRateHz, maxHz) }
        val selected = atMax.find { it.id == current.id } ?: atMax.minBy { it.id }
        val reason =
            if (almostEqualHz(selected.refreshRateHz, current.refreshRateHz)) "already-max"
            else "higher-refresh"
        return Decision(
            requestedModeId = selected.id,
            requestedRefreshHz = selected.refreshRateHz,
            selected = selected,
            supportedRatesHz = supported,
            reason = reason,
        )
    }

    private fun almostEqualHz(a: Float, b: Float): Boolean = kotlin.math.abs(a - b) < 0.05f
}
