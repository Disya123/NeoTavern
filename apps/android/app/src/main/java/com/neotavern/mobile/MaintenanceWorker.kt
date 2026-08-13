package com.neotavern.mobile

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import org.json.JSONObject

/**
 * Best-effort maintenance run (ТЗ §65, §66): executes `backups.create` on the
 * shared kernel and re-enqueues the next run.
 *
 * At-least-once delivery: WorkManager may run this worker again after an
 * interruption; every run creates an INDEPENDENT backup, so duplicates are
 * safe. No exact schedule promise — WorkManager decides the actual execution
 * time (battery/storage constraints, doze, etc.).
 *
 * The kernel call is posted on the holder's single-threaded executor (all
 * kernel access stays serialized with the stream pumps). When the executor is
 * busy pumping live streams (a generation in progress), the call times out,
 * is cancelled and the work retries with bounded backoff until it can run.
 * Failures are bounded to [MAX_ATTEMPTS] runs; after that the work fails
 * (no follow-up is enqueued and the next host start re-enqueues the initial
 * run).
 */
class MaintenanceWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    override fun doWork(): Result {
        val appContext = applicationContext
        val holder = try {
            KernelHost.holder(ManagedDataRoot(appContext).ensure().absolutePath).also { it.acquire() }
        } catch (e: Exception) {
            // The holder died between obtain and acquire (teardown race); a
            // fresh one exists after the next KernelHost call.
            return retryOrFail()
        }
        return try {
            val response = executeBackup(holder) ?: return retryOrFail()
            val kind = try {
                JSONObject(response).optString("kind")
            } catch (e: Exception) {
                ""
            }
            when (kind) {
                "ok" -> {
                    MaintenanceScheduler.enqueueNext(appContext)
                    Result.success()
                }
                else -> retryOrFail() // product error envelope, malformed, or unknown
            }
        } finally {
            holder.release()
        }
    }

    /** Runs open → handshake → backups.create on the holder's executor; null on timeout/transport failure. */
    private fun executeBackup(holder: KernelHolder): String? {
        val task = holder.executor.submit<String> {
            holder.session.open() // idempotent — no-op when the activity keeps the session open
            val builder = EnvelopeBuilder.fromHandshake(holder.session.handshake())
            val envelope = builder.request(
                builder.newRequestId(),
                MaintenancePolicy.OPERATION_ID,
                "{}",
            )
            holder.session.callEnvelope(envelope)
        }
        return try {
            task.get(KERNEL_CALL_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            null
        } catch (e: TimeoutException) {
            // The executor is busy pumping live streams; drop the queued call
            // and let WorkManager retry later (bounded).
            task.cancel(true)
            null
        } catch (e: java.util.concurrent.CancellationException) {
            // The task was cancelled (timeout path) before it started.
            null
        } catch (e: ExecutionException) {
            // SessionError/KernelException from the kernel call itself.
            null
        }
    }

    /** Bounded retries: [MAX_ATTEMPTS] runs total, then failure. */
    private fun retryOrFail(): Result =
        if (runAttemptCount + 1 >= MAX_ATTEMPTS) Result.failure() else Result.retry()

    private companion object {
        const val MAX_ATTEMPTS = 3
        const val KERNEL_CALL_TIMEOUT_SECONDS = 45L
    }
}
