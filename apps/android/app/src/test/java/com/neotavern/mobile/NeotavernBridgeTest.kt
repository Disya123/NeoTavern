package com.neotavern.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * JVM tests for the pure [CallbackFrame] bridge-expression builder — no
 * android.* imports anywhere in this test or the class under test.
 */
class NeotavernBridgeTest {

    @Test
    fun `resolve expression matches the frozen bridge protocol`() {
        val frame = CallbackFrame.resolve("cb-42", """{"kind":"ok","result":{}}""")
        assertEquals(
            "window.__neotavernMobileCallbacks && window.__neotavernMobileCallbacks" +
                ".resolve('cb-42', JSON.parse(\"{\\\"kind\\\":\\\"ok\\\",\\\"result\\\":{}}\"))",
            frame.toJsExpression(),
        )
    }

    @Test
    fun `reject expression uses the reject method`() {
        val frame = CallbackFrame.reject("cb-7", """{"code":"session-state","message":"closed"}""")
        assertTrue(frame.toJsExpression().startsWith("window.__neotavernMobileCallbacks && "))
        assertTrue(frame.toJsExpression().contains(".reject('cb-7', JSON.parse("))
        assertFalse(frame.toJsExpression().contains(".resolve("))
    }

    @Test
    fun `payload is embedded through an escaped literal never raw`() {
        val payload = """{"x":"a"b\c","q":"line1
line2"}"""
        val expression = CallbackFrame.resolve("cb-1", payload).toJsExpression()

        // The raw payload must not appear verbatim (quotes/backslashes/newline
        // would break out of the literal and execute arbitrary JS).
        assertFalse(expression.contains("a\"b\\c"))
        assertTrue(expression.contains("JSON.parse("))
        // The escape sequences are visible in the produced expression.
        assertTrue(expression.contains("\\n"))
        assertTrue(expression.contains("\\\""))
    }

    @Test
    fun `stream payload objects pass through as resolve payloads`() {
        val payload = """{"kind":"event","event":{"streamId":"s1","sequence":1,"type":"delta","payload":{}}}"""
        val expression = CallbackFrame.resolve("cb-3", payload).toJsExpression()
        assertTrue(expression.contains(".resolve('cb-3', JSON.parse("))
        assertTrue(expression.contains("\\\"kind\\\":\\\"event\\\""))
    }

    @Test
    fun `unsafe callback id is rejected`() {
        try {
            CallbackFrame.resolve("cb\"));evil();//", "{}")
            fail("expected IllegalArgumentException")
        } catch (e: IllegalArgumentException) {
            // expected
        }
    }

    @Test
    fun `empty payload still produces a parseable expression`() {
        val expression = CallbackFrame.resolve("cb-1", "").toJsExpression()
        // escapeJsStringLiteral("") is the two-character literal "" → JSON.parse("")).
        assertTrue(expression.contains("JSON.parse(\"\"))"))
    }
}
