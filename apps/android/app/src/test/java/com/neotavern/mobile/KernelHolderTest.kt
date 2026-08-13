package com.neotavern.mobile

import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM tests for the [KernelHolder] refcount lifecycle over a fake
 * [NativeKernel] — no android.* involved.
 *
 * The kernel open is scheduled on the holder executor (ТЗ §13 — never on the
 * caller's thread), so tests await the open with a bounded poll instead of
 * asserting synchronously.
 */
class KernelHolderTest {

    /** Records native open/close calls; can be configured to fail either. */
    private class FakeNativeKernel : NativeKernel {
        @Volatile
        var opened = 0

        @Volatile
        var closed = 0

        var openFailure: KernelException? = null
        var closeFailure: KernelException? = null

        override fun handshake(): String = "{}"

        override fun open(dataRoot: String): Long {
            openFailure?.let { throw it }
            opened++
            return 1L
        }

        override fun close(kernel: Long) {
            closed++
            closeFailure?.let { throw it }
        }

        override fun call(kernel: Long, request: ByteArray): ByteArray = ByteArray(0)

        override fun streamStart(kernel: Long, request: ByteArray): Long = 0L

        override fun streamWait(stream: Long, timeoutMs: Int): ByteArray? = null

        override fun streamCancel(kernel: Long, stream: Long) = Unit

        override fun streamFree(stream: Long) = Unit
    }

    /** Bounded poll for the async native open to complete. */
    private fun awaitOpen(holder: KernelHolder, timeoutMs: Long = 5000) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (!holder.session.isOpen && System.currentTimeMillis() < deadline) {
            Thread.sleep(10)
        }
        assertTrue("kernel session did not open within $timeoutMs ms", holder.session.isOpen)
    }

    @Test
    fun `two acquires open the session exactly once`() {
        val fake = FakeNativeKernel()
        val holder = KernelHolder(fake, "/tmp/data")

        holder.acquire()
        holder.acquire()
        awaitOpen(holder)

        assertEquals(1, fake.opened)
        assertTrue(holder.session.isOpen)
        assertFalse(holder.executor.isShutdown)
    }

    @Test
    fun `release to zero closes the session once and shuts the executor down`() {
        val fake = FakeNativeKernel()
        val holder = KernelHolder(fake, "/tmp/data")
        holder.acquire()
        holder.acquire()
        awaitOpen(holder)

        holder.release()
        // Still one owner: session stays open, executor keeps running.
        assertTrue(holder.session.isOpen)
        assertFalse(holder.executor.isShutdown)
        assertFalse(holder.isReleased)
        assertEquals(0, fake.closed)

        holder.release()

        assertEquals(1, fake.closed)
        assertTrue(holder.executor.isShutdown)
        assertFalse(holder.session.isOpen)
        assertTrue(holder.isReleased)
    }

    @Test
    fun `release never throws even when the native close throws`() {
        val fake = FakeNativeKernel()
        fake.closeFailure = KernelException(9, "native close exploded")
        val holder = KernelHolder(fake, "/tmp/data")
        holder.acquire()
        awaitOpen(holder)

        // Must not propagate — the teardown path stays crash-safe.
        holder.release()
        holder.release() // releases past zero are no-ops

        assertEquals(1, fake.closed)
        assertTrue(holder.executor.isShutdown)
    }

    @Test
    fun `acquire after the holder was released to zero throws`() {
        val fake = FakeNativeKernel()
        val holder = KernelHolder(fake, "/tmp/data")
        holder.acquire()
        awaitOpen(holder)
        holder.release()

        assertThrows(IllegalStateException::class.java) { holder.acquire() }
        assertEquals(1, fake.opened) // no revival attempt
    }

    @Test
    fun `failed open is reported through onOpenError and never reopens a closed holder`() {
        val fake = FakeNativeKernel()
        fake.openFailure = KernelException(8, "schema mismatch")
        val reported = AtomicReference<Throwable?>()
        val holder = KernelHolder(fake, "/tmp/data") { t -> reported.set(t) }

        holder.acquire()

        // The async open fails: the session stays closed and the failure is
        // delivered to the host-provided logger hook (never thrown on the
        // caller's thread).
        val deadline = System.currentTimeMillis() + 5000
        while (reported.get() == null && System.currentTimeMillis() < deadline) {
            Thread.sleep(10)
        }
        val failure = reported.get() as? SessionError.OpenFailed
        assertTrue("expected SessionError.OpenFailed, got ${reported.get()}", failure != null)
        assertEquals(8, failure!!.code)
        assertFalse(holder.session.isOpen)
        assertEquals(0, fake.opened)

        // A release after a failed open still tears down cleanly and the
        // queued open task never reopens the released session.
        holder.release()
        holder.release() // no-op past zero
        assertTrue(holder.executor.isShutdown)
        assertEquals(0, fake.closed) // session was never OPEN, so close is a no-op
        assertTrue(holder.isReleased)
    }
}
