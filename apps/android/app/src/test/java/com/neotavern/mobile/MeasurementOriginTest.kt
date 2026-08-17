package com.neotavern.mobile

import org.junit.Assert.assertEquals
import org.junit.Test

class MeasurementOriginTest {

    @Test
    fun `blank extra stays on file so production origin does not change`() {
        assertEquals(MeasurementOrigin.Profile.File, MeasurementOrigin.parse(null))
        assertEquals(MeasurementOrigin.Profile.File, MeasurementOrigin.parse(""))
        assertEquals(MeasurementOrigin.Profile.File, MeasurementOrigin.parse(" file "))
        assertEquals(
            MeasurementOrigin.FILE_DOCUMENT_URL,
            MeasurementOrigin.documentUrl(MeasurementOrigin.Profile.File),
        )
    }

    @Test
    fun `asset-loader extra uses the packaged HTTPS host the SPA already recognizes`() {
        assertEquals(MeasurementOrigin.Profile.AssetLoader, MeasurementOrigin.parse("asset-loader"))
        assertEquals(MeasurementOrigin.Profile.AssetLoader, MeasurementOrigin.parse("B"))
        val url = MeasurementOrigin.documentUrl(MeasurementOrigin.Profile.AssetLoader)
        assertEquals(MeasurementOrigin.ASSET_LOADER_DOCUMENT_URL, url)
        assertEquals(
            "https://appassets.androidplatform.net/assets/web/index.html",
            url,
        )
    }

    @Test
    fun `unknown extra fails closed to file`() {
        assertEquals(MeasurementOrigin.Profile.File, MeasurementOrigin.parse("rewrite"))
    }
}
