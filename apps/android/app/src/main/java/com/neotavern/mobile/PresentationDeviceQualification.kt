package com.neotavern.mobile

/**
 * PURE GateP-style device qualification. Emulators and software renderers
 * are not canary-qualified. No android.* so JVM tests can cover fingerprints.
 */
object PresentationDeviceQualification {
    fun isEmulator(
        fingerprint: String,
        model: String,
        hardware: String,
        product: String,
    ): Boolean {
        val fp = fingerprint.lowercase()
        val m = model.lowercase()
        val h = hardware.lowercase()
        val p = product.lowercase()
        return fp.startsWith("generic") ||
            fp.contains("unknown") ||
            m.contains("sdk") ||
            m.contains("emulator") ||
            m.contains("android sdk") ||
            h.contains("goldfish") ||
            h.contains("ranchu") ||
            p.contains("sdk") ||
            p.contains("emulator")
    }

    fun isSoftwareRenderer(hardware: String, fingerprint: String): Boolean {
        val h = hardware.lowercase()
        val fp = fingerprint.lowercase()
        return h.contains("goldfish") ||
            h.contains("ranchu") ||
            h.contains("swiftshader") ||
            fp.contains("robolectric")
    }

    fun isQualified(
        physicalDevice: Boolean,
        vulkanHardware: Boolean,
        softwareRenderer: Boolean,
    ): Boolean {
        return physicalDevice && vulkanHardware && !softwareRenderer
    }
}
