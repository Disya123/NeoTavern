package com.neotavern.mobile

/**
 * Escapes a string into a JavaScript **double-quoted string literal**.
 *
 * PURE Kotlin (no android.*) so it can be unit-tested on the JVM. Used by the
 * WebView bridge to embed untrusted envelope/error JSON into
 * `JSON.parse(<literal>)` expressions — the payload must never be
 * interpolated raw, or a `"` or `\` inside it would break out of the literal
 * and execute arbitrary JS (ТЗ: arbitrary third-party JavaScript in the main
 * WebView is not supported).
 *
 * Escapes:
 *  - `\` and `"` (literal syntax),
 *  - `\n` `\r` `\t` `\b` `\f` (short escapes),
 *  - U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR (both invalid
 *    inside JS string literals and must be escaped even though they are not
 *    control characters),
 *  - every remaining code unit `< 0x20` as `\uXXXX`.
 *
 * The result includes the surrounding double quotes.
 */
object JsEscaping {

    fun escapeJsStringLiteral(s: String): String {
        if (s.isEmpty()) return "\"\""
        val out = StringBuilder(s.length + 16)
        out.append('"')
        for (ch in s) {
            when (ch) {
                '\\' -> out.append("\\\\")
                '"' -> out.append("\\\"")
                '\n' -> out.append("\\n")
                '\r' -> out.append("\\r")
                '\t' -> out.append("\\t")
                '\b' -> out.append("\\b")
                '\u000C' -> out.append("\\f")
                '\u2028' -> out.append("\\u2028")
                '\u2029' -> out.append("\\u2029")
                else -> {
                    if (ch < ' ') {
                        out.append("\\u")
                        out.append(ch.code.toString(16).padStart(4, '0'))
                    } else {
                        out.append(ch)
                    }
                }
            }
        }
        out.append('"')
        return out.toString()
    }
}
