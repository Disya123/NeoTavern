package com.neotavern.mobile

import org.junit.Assert.assertTrue
import org.junit.Test

class FrameMissCounterTest {

    @Test
    fun `first frame is not a miss`() {
        val counter = FrameMissCounter(60)
        counter.record(0.0)
        val json = counter.toJson(0.0)
        assertTrue(json.contains("\"frames\":1"))
        assertTrue(json.contains("\"misses\":0"))
        assertTrue(json.contains("\"longest_streak\":0"))
    }

    @Test
    fun `on-time 60 Hz frames report zero misses`() {
        val counter = FrameMissCounter(60)
        var t = 0.0
        repeat(60) {
            counter.record(t)
            t += 16.0
        }
        val json = counter.toJson(t - 16.0)
        assertTrue(json.contains("\"misses\":0"))
        assertTrue(json.contains("\"expected_hz\":60"))
    }

    @Test
    fun `a 50 ms gap at 60 Hz counts skipped frames and the streak`() {
        val counter = FrameMissCounter(60)
        counter.record(0.0)
        counter.record(16.0)
        counter.record(66.0)
        val json = counter.toJson(66.0)
        assertTrue(json.contains("\"misses\":2"))
        assertTrue(json.contains("\"longest_streak\":2"))
    }

    @Test
    fun `callback hz uses US decimal formatting`() {
        val counter = FrameMissCounter(120)
        counter.record(0.0)
        counter.record(10.0)
        val json = counter.toJson(10.0)
        assertTrue(json.contains("\"callback_hz\":200.00"))
    }
}
