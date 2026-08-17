package com.neotavern.mobile

import org.junit.Assert.assertEquals
import org.junit.Test

class M0D2LaunchTest {

    @Test
    fun `blank extra uses the D2 1000-frame lifetime`() {
        assertEquals(1000, M0D2Launch.parseFrames(null))
        assertEquals(1000, M0D2Launch.parseFrames(""))
        assertEquals(120, M0D2Launch.parseCaptureFrame(null))
        assertEquals(120, M0D2Launch.parseCaptureFrame(""))
    }

    @Test
    fun `numeric extras are clamped and capture can be disabled`() {
        assertEquals(1, M0D2Launch.parseFrames("1"))
        assertEquals(1000, M0D2Launch.parseFrames("99999"))
        assertEquals(-1, M0D2Launch.parseCaptureFrame("-1"))
        assertEquals(120, M0D2Launch.parseCaptureFrame("120"))
        assertEquals(999, M0D2Launch.parseCaptureFrame("99999"))
    }
}
