package com.neotavern.mobile

import org.junit.Assert.assertEquals
import org.junit.Test

class PresentationPerfLaunchTest {

    @Test
    fun `blank extra uses perf18 defaults`() {
        assertEquals("perf18", PresentationPerfLaunch.parseScenario(null))
        assertEquals(16, PresentationPerfLaunch.parseFrames(null))
        assertEquals(2, PresentationPerfLaunch.parseCaptureFrame(null))
    }

    @Test
    fun `numeric extras are clamped and capture can be disabled`() {
        assertEquals("perf19", PresentationPerfLaunch.parseScenario("19"))
        assertEquals("perf20", PresentationPerfLaunch.parseScenario("PERF20"))
        assertEquals(1, PresentationPerfLaunch.parseFrames("1"))
        assertEquals(1000, PresentationPerfLaunch.parseFrames("99999"))
        assertEquals(-1, PresentationPerfLaunch.parseCaptureFrame("-1"))
    }
}
