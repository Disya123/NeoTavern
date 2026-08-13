package com.neotavern.mobile

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.database.sqlite.SQLiteDatabase
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkInfo
import androidx.work.WorkManager
import java.io.File
import java.util.UUID
import java.util.concurrent.Callable
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Phase 8 background execution on a real device/emulator (ТЗ §8, §19,
 * §65, §66): foreground generation service + user stop, process-death
 * durability (interrupted → retry) and the WorkManager maintenance
 * dedup. Requires the JNI `neotavern_android_jni` library (built by
 * scripts/build-libs.sh into jniLibs and packaged into the APK).
 *
 * The three scenarios share ONE kernel handle through [KernelHost] —
 * the same process-wide registry the Activity, [GenerationService] and
 * [MaintenanceWorker] use — so the service pumps exactly the session this
 * test opens on its temp data root (a second writable kernel on the same
 * root is rejected by the data-root lease, §22 `DataRootInUse`).
 *
 * Runs nightly on the API 26 + 34 emulator matrix (nightly.yml
 * android-device); the APK is compiled on every PR by
 * `:app:assembleDebugAndroidTest` in ci.yml.
 */
@RunWith(AndroidJUnit4::class)
class BackgroundExecutionInstrumentedTest {

    private lateinit var context: Context
    private lateinit var dataRoot: File

    /** The shared holder for this test; reassigned across simulated restarts. */
    private lateinit var holder: KernelHolder

    @Before
    fun setUp() {
        context = InstrumentationRegistry.getInstrumentation().targetContext
        dataRoot = File(context.cacheDir, "phase8-bg-${UUID.randomUUID()}")
        assertTrue("temp data root created", dataRoot.mkdirs())
        grantPostNotifications()
        seedChatContext()
    }

    @After
    fun tearDown() {
        // Stop any live generation service; the service releases its own
        // holder reference on the way out.
        try {
            context.stopService(Intent(context, GenerationService::class.java))
        } catch (ignored: Throwable) {
            // Best-effort teardown.
        }
        // Drain any claim the test (or a service) left behind.
        for (claim in ForegroundExecutionCoordinator.claimedStreams()) {
            ForegroundExecutionCoordinator.unclaim(claim.wireStreamId)
        }
        // Release THIS test's reference, then wait for any still-holding
        // service to release its own: the holder must be fully released
        // (isReleased) so the NEXT test's KernelHost.holder() creates a
        // fresh holder on its own root — a live holder with a stale root
        // would be returned instead.
        if (::holder.isInitialized && !holder.isReleased) {
            try {
                holder.release()
            } catch (ignored: Throwable) {
                // release() never throws, but keep teardown defensive.
            }
        }
        if (::holder.isInitialized && !holder.isReleased) {
            await("holder released to zero", 10_000) { if (holder.isReleased) Unit else null }
        }
        if (::holder.isInitialized) {
            assertTrue("holder fully released before the next test", holder.isReleased)
        }
        dataRoot.deleteRecursively()
    }

    // ------------------------------------------------------------------
    // Test 1 — foreground service + notification + user stop (ТЗ §8, §87)
    // ------------------------------------------------------------------

    @Test(timeout = 120_000)
    fun foregroundService_pumpsGeneration_andUserStopEndsIt() {
        // The shared holder comes from setUp (seedChatContext acquires and
        // opens it); this test owns exactly one refcount for it.
        val builder = EnvelopeBuilder.fromHandshake(holder.session.handshake())
        val requestId = builder.newRequestId()
        val startEnvelope = builder.request(requestId, "generation.start", startGenerationPayload())
        val streamHandle = holder.session.startStream(startEnvelope)

        // Learn the durable run id from the first committed event; the
        // service owns the pump from here on (no second waitEvent).
        val runId = awaitFirstEventRunId(streamHandle, 20_000)

        // Hand the stream to the background: first claim wins, later claims
        // for the same id are rejected (idempotent).
        assertTrue("stream claimed", ForegroundExecutionCoordinator.claim(streamHandle, requestId))
        assertFalse(
            "duplicate claim rejected",
            ForegroundExecutionCoordinator.claim(streamHandle, requestId),
        )
        assertTrue(
            "claim visible to the service",
            ForegroundExecutionCoordinator.isClaimed(requestId),
        )

        context.startForegroundService(Intent(context, GenerationService::class.java))

        val notificationManager =
            context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val notification = await("generation notification visible", 30_000) {
            notificationManager.activeNotifications
                .firstOrNull { it.notification.channelId == NotificationState.CHANNEL_ID }
        }
        assertEquals("generation channel", NotificationState.CHANNEL_ID, notification.notification.channelId)
        assertEquals("generation notification id", NotificationState.NOTIFICATION_ID, notification.id)

        // The user presses Stop: the same implicit, package-scoped broadcast
        // the notification's Stop action targets (NotificationHelper builds
        // the PendingIntent from Intent(ACTION_STOP).setPackage(...)). The
        // service listens with a context-registered RECEIVER_NOT_EXPORTED
        // receiver — an explicit component would not reach it.
        context.sendBroadcast(
            Intent(NotificationState.ACTION_STOP).setPackage(context.packageName),
        )

        // The service cancels the run, drains the terminal, removes the
        // notification and unclaims the stream.
        await("notification removed and stream unclaimed after STOP", 30_000) {
            val stillActive = notificationManager.activeNotifications
                .any { it.notification.channelId == NotificationState.CHANNEL_ID }
            if (stillActive) {
                null
            } else if (ForegroundExecutionCoordinator.isClaimed(requestId)) {
                null
            } else {
                Unit
            }
        }

        // The durable run reached the cancelled terminal state. The status is
        // verified from a FRESH session on the same root: the service releases
        // its holder ref on stop (asynchronously on the shared executor), so
        // releasing the test's ref and waiting for the executor to drain
        // guarantees the last session is closed before the root is reopened.
        holder.release()
        await("holder fully released after service stop", 10_000) {
            if (holder.isReleased && holder.executor.isTerminated) Unit else null
        }
        holder = KernelHost.holder(dataRoot.absolutePath)
        holder.acquire()
        awaitOpen("fresh session open")
        assertEquals("run cancelled", "cancelled", runStatus(holder, runId))
    }

    // ------------------------------------------------------------------
    // Test 2 — process-death durability: interrupted → retry (ТЗ §63)
    // ------------------------------------------------------------------

    @Test(timeout = 120_000)
    fun processDeath_interruptedThenRetryCompletes() {
        val builder = EnvelopeBuilder.fromHandshake(holder.session.handshake())

        // Slow generation so the close lands mid-stream.
        val startEnvelope = builder.request(
            builder.newRequestId(),
            "generation.start",
            startGenerationPayload(steps = 32, delayMs = 200),
        )
        val streamHandle = holder.session.startStream(startEnvelope)
        val runId = awaitFirstEventRunId(streamHandle, 20_000)

        // Simulated process death: close the session WITHOUT cancelling the
        // run. The kernel's orderly shutdown commits progress and clears the
        // run's lease, so startup recovery on the next open marks the run
        // interrupted immediately (no lease-expiry wait).
        holder.release()
        assertTrue("holder released to zero", holder.isReleased)

        // Reopen a NEW holder on the same data root — the process-wide
        // registry replaces the released holder.
        holder = KernelHost.holder(dataRoot.absolutePath)
        holder.acquire()
        awaitOpen("reopened session open")

        // Startup recovery marked the stale run interrupted; its committed
        // deltas are durable.
        assertEquals("run interrupted after process death", "interrupted", runStatus(holder, runId))

        // generation.retry starts attempt 2 from the stored snapshot.
        val retryEnvelope = builder.request(
            builder.newRequestId(),
            "generation.retry",
            JSONObject().put("sourceRunId", runId).toString(),
        )
        val retryHandle = holder.session.startStream(retryEnvelope)
        val retryRunId = awaitFirstEventRunId(retryHandle, 20_000)
        drainUntilTerminal(retryHandle, 30_000)

        // Attempt 2 completed with a message.
        val retryResponse = generationGet(holder, retryRunId)
        assertEquals("retry completed", "completed", retryResponse.getString("status"))
        assertEquals("retry is attempt 2", 2, retryResponse.getInt("attempt"))
        assertEquals("retry references the source run", runId, retryResponse.optString("sourceRunId"))
        assertTrue("retry produced a message", retryResponse.has("messageId"))
    }

    // ------------------------------------------------------------------
    // Test 3 — maintenance dedup via the system scheduler (ТЗ §65, §66)
    // ------------------------------------------------------------------

    @Test(timeout = 90_000)
    fun maintenanceWork_uniqueDeduped_withBatteryAndStorageConstraints() {
        val workManager = WorkManager.getInstance(context)

        // schedule() enqueues exactly one unique work with the maintenance
        // constraints (battery + storage, both required).
        MaintenanceScheduler.schedule(context)
        val first = await("unique maintenance work enqueued", 30_000) {
            workInfos(workManager).takeIf { it.size == 1 }
        }
        assertEquals("exactly one unique work", 1, first.size)
        val constraints = first[0].constraints
        assertTrue("battery-not-low constraint", constraints.requiresBatteryNotLow())
        assertTrue("storage-not-low constraint", constraints.requiresStorageNotLow())

        // A second schedule() must NOT create a duplicate unique work
        // (ExistingWorkPolicy.KEEP dedup).
        MaintenanceScheduler.schedule(context)
        val again = await("still exactly one unique work after re-schedule", 30_000) {
            workInfos(workManager).takeIf { it.size == 1 }
        }
        assertEquals("no duplicate unique work", 1, again.size)

        // Terminal state: on a well-provisioned emulator the work runs
        // eventually and succeeds; the test must not wait the ~15 min
        // initial delay, so it cancels the pending work instead. Both
        // terminal outcomes are accepted; FAILED is not, and the unique
        // name is never duplicated. If a racing completion re-enqueues the
        // follow-up (ENQUEUED again), cancel again until it settles.
        val terminal = await("maintenance work terminal", 30_000) {
            val infos = workInfos(workManager)
            val state = infos.singleOrNull()?.state
            when (state) {
                WorkInfo.State.SUCCEEDED, WorkInfo.State.CANCELLED -> infos
                WorkInfo.State.ENQUEUED, WorkInfo.State.RUNNING, WorkInfo.State.BLOCKED -> {
                    workManager.cancelUniqueWork(MaintenancePolicy.UNIQUE_WORK_NAME)
                    null
                }
                else -> null
            }
        }
        assertEquals("one unique work at terminal", 1, terminal.size)
        assertNotEquals("never failed", WorkInfo.State.FAILED, terminal[0].state)
        assertTrue(
            "terminal state accepted",
            terminal[0].state == WorkInfo.State.SUCCEEDED ||
                terminal[0].state == WorkInfo.State.CANCELLED,
        )
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /**
     * Seeds a character + chat row so `generation.start` has a chat context
     * (the frozen wire registry has no `chats.create` op — rows are seeded
     * directly, exactly like the kernel test suites). Runs the migrations by
     * opening the kernel once, releases the lease, inserts via SQLite, then
     * reopens through [KernelHost].
     */
    private fun seedChatContext() {
        holder = KernelHost.holder(dataRoot.absolutePath)
        holder.acquire()
        // The open runs on the holder executor (ТЗ §13): wait for it so the
        // kernel actually creates the database before we seed it.
        awaitOpen("seed session open")
        holder.release()
        assertTrue("holder released for seeding", holder.isReleased)

        val dbFile = File(dataRoot, DB_FILE_NAME)
        assertTrue("kernel created the database on first open", dbFile.isFile)
        val db = SQLiteDatabase.openDatabase(dbFile.absolutePath, null, SQLiteDatabase.OPEN_READWRITE)
        try {
            db.execSQL(
                "INSERT INTO characters " +
                    "(id, name, description, avatar_asset_id, tags_json, ext_json, created_at, updated_at) " +
                    "VALUES (?, ?, NULL, NULL, '[]', '{}', ?, ?)",
                arrayOf(CHARACTER_ID, "Seeded Character", T0, T0),
            )
            db.execSQL(
                "INSERT INTO chats (id, title, character_id, created_at, updated_at) " +
                    "VALUES (?, ?, ?, ?, ?)",
                arrayOf(CHAT_ID, "Seeded Chat", CHARACTER_ID, T0, T0),
            )
        } finally {
            db.close()
        }

        holder = KernelHost.holder(dataRoot.absolutePath)
        holder.acquire()
        awaitOpen("reopened after seeding")
    }

    /** Bounded poll for the shared session (opened on the holder executor). */
    private fun awaitOpen(label: String) {
        await(label, 20_000) { if (holder.session.isOpen) Unit else null }
    }

    /**
     * Grants POST_NOTIFICATIONS (API 33+; the permission does not exist
     * before 33, where notifications need no grant). The shell-run
     * instrumentation can issue `pm grant` for its own target package.
     */
    private fun grantPostNotifications() {
        if (Build.VERSION.SDK_INT >= 33) {
            val descriptor = InstrumentationRegistry.getInstrumentation().uiAutomation
                .executeShellCommand("pm grant ${context.packageName} android.permission.POST_NOTIFICATIONS")
            if (descriptor != null) {
                descriptor.use { fd ->
                    ParcelFileDescriptor.AutoCloseInputStream(fd).readBytes()
                }
            }
        }
    }

    /**
     * Bounded polling: returns the first non-null [block] result before
     * [timeoutMillis] elapses, otherwise fails with [description].
     */
    private fun <T> await(
        description: String,
        timeoutMillis: Long,
        pollMillis: Long = 250L,
        block: () -> T?,
    ): T {
        val deadline = SystemClock.elapsedRealtime() + timeoutMillis
        while (SystemClock.elapsedRealtime() < deadline) {
            block()?.let { return it }
            SystemClock.sleep(pollMillis)
        }
        throw AssertionError("Timed out after ${timeoutMillis}ms waiting for: $description")
    }

    /**
     * The fake-provider generation request payload. The fake adapter is
     * configured through the `model` grammar `steps=N;delay-ms=M;
     * tokens-per-step=K` (crates/built-in-providers/src/fake.rs); the
     * delay keeps the run streaming so cancellation / process death land
     * mid-run.
     */
    private fun startGenerationPayload(steps: Int = 64, delayMs: Int = 200): String = JSONObject()
        .put("chatId", CHAT_ID)
        .put("message", "Hello from the background execution test")
        .put("provider", "fake")
        .put("model", "steps=$steps;delay-ms=$delayMs;tokens-per-step=24")
        .toString()

    /**
     * Waits for the first stream payload and returns the durable run id
     * from its event envelope (`event.streamId`). Fails loudly if the
     * stream ends before the first event — the test would be racing the
     * fake provider's completion.
     */
    private fun awaitFirstEventRunId(streamHandle: Long, timeoutMillis: Long): String {
        val deadline = SystemClock.elapsedRealtime() + timeoutMillis
        while (SystemClock.elapsedRealtime() < deadline) {
            val payload = holder.session.waitEvent(streamHandle, 5_000) ?: continue
            val json = JSONObject(String(payload, Charsets.UTF_8))
            when (json.getString("kind")) {
                "event" -> return json.getJSONObject("event").getString("streamId")
                else -> throw AssertionError("stream ended before the first event: $json")
            }
        }
        throw AssertionError("Timed out waiting for the first stream event")
    }

    /**
     * Pumps [streamHandle] until the `{kind:"terminal"}` framing arrives
     * (bounded). The terminal event itself is delivered first as an event
     * payload; the framing marks the end of the durable run.
     */
    private fun drainUntilTerminal(streamHandle: Long, timeoutMillis: Long) {
        val deadline = SystemClock.elapsedRealtime() + timeoutMillis
        while (SystemClock.elapsedRealtime() < deadline) {
            val payload = holder.session.waitEvent(streamHandle, 5_000) ?: continue
            val kind = JSONObject(String(payload, Charsets.UTF_8)).getString("kind")
            if (NotificationState.isTerminal(kind)) return
        }
        throw AssertionError("Timed out draining the stream to terminal")
    }

    /** `generation.get` → the run DTO, dispatched on the holder executor. */
    private fun generationGet(holder: KernelHolder, runId: String): JSONObject {
        val builder = EnvelopeBuilder.fromHandshake(holder.session.handshake())
        val envelope = builder.request(
            builder.newRequestId(),
            "generation.get",
            JSONObject().put("workflowId", runId).toString(),
        )
        val response = awaitOnExecutor(holder, envelope)
        assertEquals("generation.get ok", "ok", response.getString("kind"))
        return response.getJSONObject("result")
    }

    /** The run's `status` string, via the wire `generation.get` op. */
    private fun runStatus(holder: KernelHolder, runId: String): String =
        generationGet(holder, runId).getString("status")

    /**
     * Executes one unary call on [KernelHolder.executor] and blocks for the
     * response — kernel work must serialize with the service's pump, which
     * runs on the same single-thread executor.
     */
    private fun awaitOnExecutor(holder: KernelHolder, envelopeJson: String): JSONObject {
        val future = holder.executor.submit(Callable { holder.session.callEnvelope(envelopeJson) })
        return JSONObject(future.get(30, TimeUnit.SECONDS))
    }

    /** Current unique-work infos, blocking up to 10s for the future. */
    private fun workInfos(workManager: WorkManager): List<WorkInfo> =
        workManager.getWorkInfosForUniqueWork(MaintenancePolicy.UNIQUE_WORK_NAME)
            .get(10, TimeUnit.SECONDS)

    private companion object {
        /** SQLite file name inside a data root (storage `paths::DB_FILE_NAME`). */
        const val DB_FILE_NAME = "database.sqlite"

        /** Fixed wire-valid ids + timestamp, matching the kernel test seeds. */
        const val CHARACTER_ID = "00000000-0000-4000-8000-000000000002"
        const val CHAT_ID = "00000000-0000-4000-8000-000000000001"
        const val T0 = "2026-08-13T00:00:00Z"
    }
}
