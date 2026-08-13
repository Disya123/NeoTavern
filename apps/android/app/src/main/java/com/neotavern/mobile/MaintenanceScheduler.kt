package com.neotavern.mobile

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * Enqueues the best-effort maintenance work ([MaintenanceWorker]) under the
 * unique name [MaintenancePolicy.UNIQUE_WORK_NAME].
 *
 * - [schedule] is the initial enqueue (host start): ~15 min from now,
 * - [enqueueNext] is the periodic follow-up called by the worker itself after
 *   a successful run: ~12 h later,
 * - [ExistingWorkPolicy.KEEP] guarantees at most ONE pending run: re-enqueues
 *   while a run is pending are no-ops, so duplicates are impossible,
 * - constraints require battery-not-low AND storage-not-low
 *   ([MaintenancePolicy.constraintsAllowed]); WorkManager decides the actual
 *   execution time — at-least-once delivery, no exact schedule promise (ТЗ
 *   §66).
 */
object MaintenanceScheduler {

    /** Initial best-effort enqueue (host start). */
    fun schedule(context: Context) {
        enqueue(context, MaintenancePolicy.schedule().initialDelayMillis)
    }

    /** Periodic follow-up, called by [MaintenanceWorker] after a successful run. */
    fun enqueueNext(context: Context) {
        enqueue(context, MaintenancePolicy.schedule().periodMillis)
    }

    private fun enqueue(context: Context, initialDelayMillis: Long) {
        val constraints = Constraints.Builder()
            .setRequiresBatteryNotLow(true)
            .setRequiresStorageNotLow(true)
            .build()
        val request = OneTimeWorkRequestBuilder<MaintenanceWorker>()
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, BACKOFF_SECONDS, TimeUnit.SECONDS)
            .apply {
                if (initialDelayMillis > 0) {
                    setInitialDelay(initialDelayMillis, TimeUnit.MILLISECONDS)
                }
            }
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            MaintenancePolicy.UNIQUE_WORK_NAME,
            ExistingWorkPolicy.KEEP,
            request,
        )
    }

    private const val BACKOFF_SECONDS = 30L
}
