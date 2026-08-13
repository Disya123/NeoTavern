package com.neotavern.mobile

/**
 * Policy for the background maintenance work (ТЗ §8, §65, §66): the single
 * periodic kernel-side backup, executed through the system scheduler
 * (WorkManager — no own scheduler, no exact-schedule promise).
 *
 * The work itself is the frozen wire operation [OPERATION_ID]
 * (`backups.create`); the kernel has no maintenance operation, so nothing
 * is added. Timing is best-effort by design: WorkManager decides the actual
 * run time from [Schedule] hints plus its own constraints.
 */
object MaintenancePolicy {

    /** WorkManager unique work name — one maintenance job process-wide. */
    const val UNIQUE_WORK_NAME = "neotavern-maintenance"

    /** The wire operation the maintenance job executes. */
    const val OPERATION_ID = "backups.create"

    /** Best-effort timing hints for the periodic maintenance job. */
    data class Schedule(val initialDelayMillis: Long, val periodMillis: Long)

    /**
     * Recommended schedule: first run ~15 minutes after install, then every
     * ~12 hours. These are hints, not promises — WorkManager may delay the
     * actual execution (battery/Doze, backoff, constraints).
     */
    fun schedule(): Schedule = Schedule(initialDelayMillis = 15 * 60_000L, periodMillis = 12 * 3600_000L)

    /**
     * Whether the system-scheduler constraints for running maintenance are
     * satisfied: BOTH the battery must not be low AND storage must not be
     * low.
     */
    fun constraintsAllowed(batteryNotLow: Boolean, storageNotLow: Boolean): Boolean =
        batteryNotLow && storageNotLow
}
