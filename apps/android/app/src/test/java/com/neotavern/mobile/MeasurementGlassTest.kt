package com.neotavern.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MeasurementGlassTest {

    @Test
    fun `blank extra stays live so production visuals do not change`() {
        assertEquals(MeasurementGlass.Profile.Live, MeasurementGlass.parse(null))
        assertEquals(MeasurementGlass.Profile.Live, MeasurementGlass.parse(""))
        assertEquals(MeasurementGlass.Profile.Live, MeasurementGlass.parse(" live "))
        assertNull(MeasurementGlass.bootstrapJs(MeasurementGlass.Profile.Live))
    }

    @Test
    fun `off extra injects a constant attribute setter`() {
        assertEquals(MeasurementGlass.Profile.Off, MeasurementGlass.parse("off"))
        assertEquals(MeasurementGlass.Profile.Off, MeasurementGlass.parse("A0"))
        val js = MeasurementGlass.bootstrapJs(MeasurementGlass.Profile.Off)
        assertTrue(js!!.contains("data-nt-measurement-glass"))
        assertTrue(js.contains("setAttribute('data-nt-measurement-glass','off')"))
        assertTrue(!js.contains("off\" +"))
    }

    @Test
    fun `unknown extra fails closed to live`() {
        assertEquals(MeasurementGlass.Profile.Live, MeasurementGlass.parse("explode"))
    }
}
