package com.neotavern.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM tests for the pure [JsEscaping] JS string-literal escaper.
 *
 * The round-trip tests decode the produced literal with a small evaluator
 * that mirrors JS string-literal semantics, proving the bridge expression
 * `JSON.parse(<literal>)` yields exactly the original payload text — no
 * breakout, no corruption.
 */
class JsEscapingTest {

    @Test
    fun `empty string escapes to an empty literal`() {
        assertEquals("\"\"", JsEscaping.escapeJsStringLiteral(""))
    }

    @Test
    fun `quotes are escaped`() {
        assertEquals("\"a\\\"b\"", JsEscaping.escapeJsStringLiteral("a\"b"))
        assertEquals("\"\\\"\\\"\"", JsEscaping.escapeJsStringLiteral("\"\""))
    }

    @Test
    fun `backslashes are escaped`() {
        assertEquals("\"a\\\\b\"", JsEscaping.escapeJsStringLiteral("a\\b"))
        assertEquals("\"\\\\\\\\\"", JsEscaping.escapeJsStringLiteral("\\\\"))
        assertEquals("\"\\\\\\\"\"", JsEscaping.escapeJsStringLiteral("\\\""))
    }

    @Test
    fun `control characters use short escapes`() {
        assertEquals("\"\\n\"", JsEscaping.escapeJsStringLiteral("\n"))
        assertEquals("\"\\r\"", JsEscaping.escapeJsStringLiteral("\r"))
        assertEquals("\"\\t\"", JsEscaping.escapeJsStringLiteral("\t"))
        assertEquals("\"\\b\"", JsEscaping.escapeJsStringLiteral("\b"))
        assertEquals("\"\\f\"", JsEscaping.escapeJsStringLiteral("\u000C"))
    }

    @Test
    fun `remaining control characters use unicode escapes`() {
        assertEquals("\"\\u0000\"", JsEscaping.escapeJsStringLiteral("\u0000"))
        assertEquals("\"\\u0001\"", JsEscaping.escapeJsStringLiteral("\u0001"))
        assertEquals("\"\\u001f\"", JsEscaping.escapeJsStringLiteral("\u001F"))
    }

    @Test
    fun `line and paragraph separators are escaped`() {
        assertEquals("\"\\u2028\"", JsEscaping.escapeJsStringLiteral("\u2028"))
        assertEquals("\"\\u2029\"", JsEscaping.escapeJsStringLiteral("\u2029"))
        assertEquals("\"a\\u2028b\"", JsEscaping.escapeJsStringLiteral("a\u2028b"))
    }

    @Test
    fun `plain text passes through unchanged`() {
        assertEquals("\"hello world\"", JsEscaping.escapeJsStringLiteral("hello world"))
        assertEquals("\"café 日本語 🎉\"", JsEscaping.escapeJsStringLiteral("café 日本語 🎉"))
    }

    @Test
    fun `round trip of attacker-controlled payload`() {
        val payload = "{\"x\":\"a\\\"b\\\\c\\nd\\u0001\",\"q\":\"\\\"quoted\\\"\"}"
        val literal = JsEscaping.escapeJsStringLiteral(payload)
        assertTrue(literal.startsWith("\""))
        assertTrue(literal.endsWith("\""))
        // The raw payload must never appear verbatim inside the literal (it contains quotes/backslashes).
        assertFalse(literal.contains("a\\\"b\\\\c"))
        assertEquals(payload, decodeJsStringLiteral(literal))
    }

    @Test
    fun `round trip of envelope shaped payload`() {
        val payload = """{"kind":"ok","requestId":"req-1","result":{"items":[{"name":"эникей"}]}}"""
        assertEquals(payload, decodeJsStringLiteral(JsEscaping.escapeJsStringLiteral(payload)))
    }

    @Test
    fun `round trip of terminal control characters`() {
        val payload = "line1\nline2\r\n\u0000end"
        assertEquals(payload, decodeJsStringLiteral(JsEscaping.escapeJsStringLiteral(payload)))
    }

    /**
     * Evaluates a JS double-quoted string literal (the subset [JsEscaping]
     * produces) to its string value — mirrors what `JSON.parse(<literal>)`
     * sees as its argument.
     */
    private fun decodeJsStringLiteral(literal: String): String {
        require(literal.length >= 2 && literal.first() == '"' && literal.last() == '"') {
            "not a quoted literal: $literal"
        }
        val body = literal.substring(1, literal.length - 1)
        val out = StringBuilder(body.length)
        var i = 0
        while (i < body.length) {
            val c = body[i]
            if (c != '\\') {
                out.append(c)
                i++
                continue
            }
            i++
            val e = body[i]
            when (e) {
                '\\' -> out.append('\\')
                '"' -> out.append('"')
                'n' -> out.append('\n')
                'r' -> out.append('\r')
                't' -> out.append('\t')
                'b' -> out.append('\b')
                'f' -> out.append('\u000C')
                'u' -> {
                    val hex = body.substring(i + 1, i + 5)
                    out.append(hex.toInt(16).toChar())
                    i += 4
                }
                else -> error("unexpected escape sequence: \\$e")
            }
            i++
        }
        return out.toString()
    }
}
