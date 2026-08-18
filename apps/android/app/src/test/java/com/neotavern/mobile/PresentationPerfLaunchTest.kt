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
        assertEquals("interop", PresentationPerfLaunch.parseScenario("T18"))
        assertEquals("perf15", PresentationPerfLaunch.parseScenario("15"))
        assertEquals("perf22", PresentationPerfLaunch.parseScenario("perf22-panel"))
        assertEquals("perf22-poster", PresentationPerfLaunch.parseScenario("poster"))
        assertEquals("recovery", PresentationPerfLaunch.parseScenario("device-loss"))
        assertEquals("recovery-surface", PresentationPerfLaunch.parseScenario("surface-recreation"))
        assertEquals("perf01-warm", PresentationPerfLaunch.parseScenario("01"))
        assertEquals("perf01-cold", PresentationPerfLaunch.parseScenario("perf01-cold"))
        assertEquals("perf12", PresentationPerfLaunch.parseScenario("adversarial"))
        assertEquals("perf16", PresentationPerfLaunch.parseScenario("cold-start"))
        assertEquals(1, PresentationPerfLaunch.parseFrames("1"))
        assertEquals(7200, PresentationPerfLaunch.parseFrames("99999"))
        assertEquals(-1, PresentationPerfLaunch.parseCaptureFrame("-1"))
    }
}
