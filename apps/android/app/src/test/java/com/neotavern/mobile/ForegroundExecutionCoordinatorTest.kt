package com.neotavern.mobile

import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * JVM tests for the [ForegroundExecutionCoordinator] claim registry —
 * first-claim-wins, unclaim/claim round-trips, immutable snapshots and a
 * concurrent smoke test.
 */
class ForegroundExecutionCoordinatorTest {

    @Before
    fun clearClaims() {
        // The coordinator is a process-wide singleton; JUnit reuses the JVM
        // across tests, so each test starts from an empty registry.
        for (claim in ForegroundExecutionCoordinator.claimedStreams()) {
            ForegroundExecutionCoordinator.unclaim(claim.wireStreamId)
        }
    }

    @Test
    fun `first claim wins and a second claim of the same id is rejected`() {
        assertTrue(ForegroundExecutionCoordinator.claim(streamHandle = 100L, wireStreamId = "s1"))
        assertFalse(ForegroundExecutionCoordinator.claim(streamHandle = 200L, wireStreamId = "s1"))

        assertTrue(ForegroundExecutionCoordinator.isClaimed("s1"))
        assertEquals(
            listOf(100L to "s1"),
            ForegroundExecutionCoordinator.claimedStreams().map { it.streamHandle to it.wireStreamId },
        )
        assertEquals(100L, ForegroundExecutionCoordinator.claimedStreams().single().streamHandle)
    }

    @Test
    fun `unclaim then claim succeeds for the same id`() {
        ForegroundExecutionCoordinator.claim(streamHandle = 100L, wireStreamId = "s1")
        ForegroundExecutionCoordinator.unclaim("s1")
        assertFalse(ForegroundExecutionCoordinator.isClaimed("s1"))

        assertTrue(ForegroundExecutionCoordinator.claim(streamHandle = 300L, wireStreamId = "s1"))
        assertTrue(ForegroundExecutionCoordinator.isClaimed("s1"))
        assertEquals(300L, ForegroundExecutionCoordinator.claimedStreams().single().streamHandle)
    }

    @Test
    fun `claimedStreams is an immutable snapshot`() {
        ForegroundExecutionCoordinator.claim(streamHandle = 100L, wireStreamId = "s1")
        ForegroundExecutionCoordinator.claim(streamHandle = 200L, wireStreamId = "s2")

        val snapshot = ForegroundExecutionCoordinator.claimedStreams()
        assertEquals(listOf("s1", "s2"), snapshot.map { it.wireStreamId })

        // Later registry mutations do not leak into the earlier snapshot.
        ForegroundExecutionCoordinator.unclaim("s1")
        ForegroundExecutionCoordinator.claim(streamHandle = 300L, wireStreamId = "s3")

        assertEquals(listOf("s1", "s2"), snapshot.map { it.wireStreamId })
        assertEquals(listOf("s2", "s3"), ForegroundExecutionCoordinator.claimedStreams().map { it.wireStreamId })
    }

    @Test
    fun `concurrent claims yield exactly one winner per wire stream id`() {
        val ids = (0 until 50).map { "stream-$it" }
        val threadCount = 4
        val executor = Executors.newFixedThreadPool(threadCount)
        val start = CountDownLatch(1)
        val done = CountDownLatch(threadCount)
        val results = ConcurrentLinkedQueue<Pair<String, Boolean>>()

        repeat(threadCount) { t ->
            executor.execute {
                start.await()
                for ((i, id) in ids.withIndex()) {
                    val handle = 1000L + t * 100L + i
                    results.add(id to ForegroundExecutionCoordinator.claim(handle, id))
                }
                done.countDown()
            }
        }

        start.countDown()
        assertTrue("all claimers finished", done.await(10, TimeUnit.SECONDS))
        executor.shutdown()

        for (id in ids) {
            val winners = results.count { it.first == id && it.second }
            assertEquals("exactly one winner for $id", 1, winners)
        }
    }
}
