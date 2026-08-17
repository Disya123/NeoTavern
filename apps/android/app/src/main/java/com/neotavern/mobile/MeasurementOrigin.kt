package com.neotavern.mobile

/**
 * M-1 Track B switch. PURE Kotlin so parsing and document URLs are
 * unit-tested on the JVM. Production default is [Profile.File]
 * (`file:///android_asset/...`). [Profile.AssetLoader] is opt-in via
 * [EXTRA] and loads the same APK assets through
 * `https://appassets.androidplatform.net` — the SPA already treats that
 * host as a packaged WebView (`isPackagedWebView` in `routing.ts`).
 */
object MeasurementOrigin {

    const val EXTRA = "com.neotavern.mobile.MEASUREMENT_ORIGIN"

    const val FILE_DOCUMENT_URL = "file:///android_asset/web/index.html"

    const val ASSET_LOADER_HOST = "appassets.androidplatform.net"

    const val ASSET_PATH_PREFIX = "/assets/"

    const val ASSET_LOADER_DOCUMENT_URL =
        "https://$ASSET_LOADER_HOST${ASSET_PATH_PREFIX}web/index.html"

    enum class Profile {
        File,
        AssetLoader,
    }

    fun parse(extra: String?): Profile {
        val value = extra?.trim()?.lowercase().orEmpty()
        return when (value) {
            "", "file", "a", "default" -> Profile.File
            "https", "asset-loader", "assetloader", "b" -> Profile.AssetLoader
            else -> Profile.File
        }
    }

    fun documentUrl(profile: Profile): String =
        when (profile) {
            Profile.File -> FILE_DOCUMENT_URL
            Profile.AssetLoader -> ASSET_LOADER_DOCUMENT_URL
        }
}
