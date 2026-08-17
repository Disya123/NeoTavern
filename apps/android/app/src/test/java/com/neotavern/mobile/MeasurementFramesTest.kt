package com.neotavern.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MeasurementFramesTest {

    @Test
    fun `blank extra leaves the sampler off`() {
        assertFalse(MeasurementFrames.enabled(null))
        assertFalse(MeasurementFrames.enabled(""))
        assertFalse(MeasurementFrames.enabled("off"))
    }

    @Test
    fun `on extra enables the sampler`() {
        assertTrue(MeasurementFrames.enabled("on"))
        assertTrue(MeasurementFrames.enabled("FRAMES"))
    }

    @Test
    fun `expected hz is clamped and inlined as an integer`() {
        assertEquals(60, MeasurementFrames.clampExpectedHz(null))
        assertEquals(120, MeasurementFrames.clampExpectedHz(120.4f))
        assertEquals(1, MeasurementFrames.clampExpectedHz(-40f))
        assertEquals(240, MeasurementFrames.clampExpectedHz(9_000f))
        val js = MeasurementFrames.bootstrapJs(120)
        assertTrue(js.contains("var expected=120;"))
        assertTrue(js.contains("console.info('${MeasurementFrames.LOG_PREFIX} '"))
        assertFalse(js.contains("expected=\" +"))
    }
}
