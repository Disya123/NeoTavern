package com.neotavern.mobile

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PresentationDeviceQualificationTest {

    @Test
    fun `AVD fingerprints are not physical`() {
        assertTrue(
            PresentationDeviceQualification.isEmulator(
                "generic/sdk_gphone64_arm64/emulator:35/AE3A.240806.005/123:userdebug/dev-keys",
                "sdk_gphone64_arm64",
                "ranchu",
                "sdk_gphone64_arm64",
            ),
        )
        assertTrue(
            PresentationDeviceQualification.isSoftwareRenderer("ranchu", "generic/sdk"),
        )
    }

    @Test
    fun `Xiaomi admission device is physical and can be qualified`() {
        assertFalse(
            PresentationDeviceQualification.isEmulator(
                "Xiaomi/mondrian/mondrian:15/AQ3A.240912.001/release-keys",
                "23122PCD1G",
                "qcom",
                "mondrian",
            ),
        )
        assertTrue(
            PresentationDeviceQualification.isQualified(
                physicalDevice = true,
                vulkanHardware = true,
                softwareRenderer = false,
            ),
        )
        assertFalse(
            PresentationDeviceQualification.isQualified(
                physicalDevice = false,
                vulkanHardware = true,
                softwareRenderer = false,
            ),
        )
        assertFalse(
            PresentationDeviceQualification.isQualified(
                physicalDevice = true,
                vulkanHardware = false,
                softwareRenderer = false,
            ),
        )
        assertFalse(
            PresentationDeviceQualification.isQualified(
                physicalDevice = true,
                vulkanHardware = true,
                softwareRenderer = true,
            ),
        )
    }
}
