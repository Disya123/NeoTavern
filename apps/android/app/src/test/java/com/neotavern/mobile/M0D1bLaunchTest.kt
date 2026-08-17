package com.neotavern.mobile

import org.junit.Assert.assertEquals
import org.junit.Test

class M0D1bLaunchTest {

    @Test
    fun `blank extra uses the D1b 1000-frame lifetime`() {
        assertEquals(1000, M0D1bLaunch.parseFrames(null))
        assertEquals(1000, M0D1bLaunch.parseFrames(""))
        assertEquals(120, M0D1bLaunch.parseCaptureFrame(null))
        assertEquals(120, M0D1bLaunch.parseCaptureFrame(""))
    }

    @Test
    fun `numeric extras are clamped and capture can be disabled`() {
        assertEquals(1, M0D1bLaunch.parseFrames("1"))
        assertEquals(1000, M0D1bLaunch.parseFrames("99999"))
        assertEquals(-1, M0D1bLaunch.parseCaptureFrame("-1"))
        assertEquals(120, M0D1bLaunch.parseCaptureFrame("120"))
        assertEquals(999, M0D1bLaunch.parseCaptureFrame("99999"))
    }
}
