package com.neotavern.mobile

import org.junit.Assert.assertEquals
import org.junit.Test

class M0D1aLaunchTest {

    @Test
    fun `blank extra uses the D1a 100-frame lifetime`() {
        assertEquals(100, M0D1aLaunch.parseFrames(null))
        assertEquals(100, M0D1aLaunch.parseFrames(""))
        assertEquals(100, M0D1aLaunch.parseFrames("  "))
    }

    @Test
    fun `numeric extra is clamped`() {
        assertEquals(1, M0D1aLaunch.parseFrames("1"))
        assertEquals(250, M0D1aLaunch.parseFrames("250"))
        assertEquals(1000, M0D1aLaunch.parseFrames("99999"))
        assertEquals(100, M0D1aLaunch.parseFrames("nope"))
    }

    @Test
    fun `refresh log line is stable for the D1a capture script`() {
        val line = M0D1aLaunch.refreshLogLine(
            phase = "apply",
            supported = "1:60.0:1080x2400",
            requestedHz = 60.0f,
            requestedModeId = 1,
            reason = "already-max",
            observedHz = 60.0f,
            observedModeId = 1,
        )
        assertEquals(
            "m0-d1a-refresh phase=apply supported=[1:60.0:1080x2400] requested_hz=60.0 " +
                "requested_mode=1 reason=already-max observed_hz=60.0 observed_mode=1",
            line,
        )
    }
}
