package com.neotavern.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM tests for the [MaintenancePolicy] constants, schedule hints and
 * constraint rule.
 */
class MaintenancePolicyTest {

    @Test
    fun `constants match the contract`() {
        assertEquals("neotavern-maintenance", MaintenancePolicy.UNIQUE_WORK_NAME)
        assertEquals("backups.create", MaintenancePolicy.OPERATION_ID)
    }

    @Test
    fun `schedule hints are 15 minutes then 12 hours`() {
        val schedule = MaintenancePolicy.schedule()
        assertEquals(15 * 60_000L, schedule.initialDelayMillis)
        assertEquals(12 * 3600_000L, schedule.periodMillis)
    }

    @Test
    fun `constraints require both battery and storage to be healthy`() {
        assertFalse(MaintenancePolicy.constraintsAllowed(batteryNotLow = false, storageNotLow = true))
        assertFalse(MaintenancePolicy.constraintsAllowed(batteryNotLow = true, storageNotLow = false))
        assertFalse(MaintenancePolicy.constraintsAllowed(batteryNotLow = false, storageNotLow = false))
        assertTrue(MaintenancePolicy.constraintsAllowed(batteryNotLow = true, storageNotLow = true))
    }
}
