package com.neotavern.mobile

/**
 * Deterministic InputConnection-shaped composer model (ADR-0051).
 * Physical Gboard may only `commitText`; this session is driven by a MockIme
 * so composing/cursor/delete APIs still have a conformance corpus.
 */
class PresentationChatImeSession {
    var text: String = ""
        private set
    var selectionStart: Int = 0
        private set
    var selectionEnd: Int = 0
        private set
    var composingStart: Int = -1
        private set
    var composingEnd: Int = -1
        private set
    val events: MutableList<String> = mutableListOf()
    var sendCount: Int = 0
        private set

    fun setComposingText(value: String, newCursorPosition: Int): Boolean {
        replaceComposing(value)
        composingStart = selectionStart - value.length
        composingEnd = selectionStart
        moveCursor(newCursorPosition)
        events.add(
            PresentationChatJourneyMarkers.ic(
                "setComposingText",
                "len=${value.length} cursor=$selectionStart composing=true",
                events.size.toLong() + 1,
            ),
        )
        recordSelection()
        return true
    }

    fun commitText(value: String, newCursorPosition: Int): Boolean {
        if (composingStart >= 0 && composingEnd >= composingStart) {
            replaceComposing(value)
            finishComposingInternal()
        } else {
            insert(value)
        }
        moveCursor(newCursorPosition)
        events.add(
            PresentationChatJourneyMarkers.ic(
                "commitText",
                "len=${value.length} cursor=$selectionStart",
                events.size.toLong() + 1,
            ),
        )
        recordSelection()
        return true
    }

    fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
        finishComposingInternal()
        val from = (selectionStart - beforeLength).coerceAtLeast(0)
        val to = (selectionEnd + afterLength).coerceAtMost(text.length)
        text = text.removeRange(from, to)
        selectionStart = from
        selectionEnd = from
        events.add(
            PresentationChatJourneyMarkers.ic(
                "deleteSurroundingText",
                "before=$beforeLength after=$afterLength",
                events.size.toLong() + 1,
            ),
        )
        recordSelection()
        return true
    }

    fun setSelection(start: Int, end: Int): Boolean {
        selectionStart = start.coerceIn(0, text.length)
        selectionEnd = end.coerceIn(0, text.length)
        events.add(
            PresentationChatJourneyMarkers.ic(
                "setSelection",
                "start=$selectionStart end=$selectionEnd",
                events.size.toLong() + 1,
            ),
        )
        return true
    }

    fun finishComposingText(): Boolean {
        finishComposingInternal()
        events.add(
            PresentationChatJourneyMarkers.ic(
                "finishComposingText",
                "composing=false",
                events.size.toLong() + 1,
            ),
        )
        return true
    }

    fun performEditorAction(editorAction: Int): Boolean {
        val code = PresentationChatJourneyMarkers.editorActionCode(editorAction)
        if (code == "SEND") {
            sendCount += 1
            finishComposingInternal()
        }
        events.add(
            PresentationChatJourneyMarkers.ic(
                "performEditorAction",
                "code=$code",
                events.size.toLong() + 1,
            ),
        )
        return true
    }

    fun corpusProven(): Boolean {
        val blob = events.joinToString("\n")
        return COMPOSING.containsMatchIn(blob) &&
            SELECTION.containsMatchIn(blob) &&
            DELETE.containsMatchIn(blob) &&
            COMMIT.containsMatchIn(blob) &&
            SEND.containsMatchIn(blob)
    }

    private fun replaceComposing(value: String) {
        if (composingStart >= 0 && composingEnd >= composingStart) {
            text = text.removeRange(composingStart, composingEnd)
            selectionStart = composingStart
            selectionEnd = composingStart
        }
        insert(value)
    }

    private fun insert(value: String) {
        val start = minOf(selectionStart, selectionEnd)
        val end = maxOf(selectionStart, selectionEnd)
        text = text.substring(0, start) + value + text.substring(end)
        selectionStart = start + value.length
        selectionEnd = selectionStart
    }

    private fun moveCursor(newCursorPosition: Int) {
        val pos = if (newCursorPosition > 0) {
            (selectionStart + newCursorPosition - 1).coerceIn(0, text.length)
        } else {
            selectionStart
        }
        selectionStart = pos
        selectionEnd = pos
    }

    private fun finishComposingInternal() {
        composingStart = -1
        composingEnd = -1
    }

    private fun recordSelection() {
        events.add(
            PresentationChatJourneyMarkers.ic(
                "updateSelection",
                "start=$selectionStart end=$selectionEnd",
                events.size.toLong() + 1,
            ),
        )
    }

    private companion object {
        val COMPOSING: Regex = Regex("gboard_ic action=setComposingText\\b")
        val SELECTION: Regex = Regex("gboard_ic action=(updateSelection|setSelection)\\b")
        val DELETE: Regex = Regex("gboard_ic action=deleteSurroundingText\\b")
        val COMMIT: Regex = Regex("gboard_ic action=commitText\\b")
        val SEND: Regex = Regex("gboard_ic action=performEditorAction code=SEND\\b")
    }
}

/**
 * Deterministic MockIme driver. Not physical Gboard; forces composing APIs.
 */
object PresentationChatMockIme {
    fun typeWordDeleteAndSend(session: PresentationChatImeSession) {
        session.setComposingText("h", 1)
        session.setComposingText("he", 1)
        session.commitText("hello", 1)
        session.deleteSurroundingText(1, 0)
        session.setComposingText("o", 1)
        session.commitText("o", 1)
        session.performEditorAction(PresentationChatJourneyMarkers.EDITOR_ACTION_SEND)
    }
}
