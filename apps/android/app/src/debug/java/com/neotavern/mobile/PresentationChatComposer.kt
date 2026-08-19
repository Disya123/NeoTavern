package com.neotavern.mobile

import android.content.Context
import android.graphics.Rect
import android.os.Build
import android.os.LocaleList
import android.text.InputType
import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.view.inputmethod.InputMethodManager
import android.widget.EditText

/**
 * Debug composer that traces Gboard InputConnection calls without logging text.
 */
class PresentationChatComposer(context: Context) : EditText(context) {
    var journeyLog: PresentationChatJourneyLog? = null

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
        val base = super.onCreateInputConnection(outAttrs) ?: return null
        outAttrs.inputType = InputType.TYPE_CLASS_TEXT or
            InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or
            InputType.TYPE_TEXT_FLAG_AUTO_CORRECT
        outAttrs.imeOptions = EditorInfo.IME_ACTION_SEND
        outAttrs.actionId = EditorInfo.IME_ACTION_SEND
        if (Build.VERSION.SDK_INT >= 24) {
            outAttrs.hintLocales = LocaleList.forLanguageTags("en-US")
        }
        val log = journeyLog ?: return base
        return PresentationChatImeConnection(base, log)
    }

    override fun onFocusChanged(gainFocus: Boolean, direction: Int, previouslyFocusedRect: Rect?) {
        super.onFocusChanged(gainFocus, direction, previouslyFocusedRect)
        journeyLog?.ime("focus=$gainFocus")
        if (gainFocus) {
            post {
                val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
                imm?.showSoftInput(this, InputMethodManager.SHOW_IMPLICIT)
            }
        }
    }

    override fun onSelectionChanged(selStart: Int, selEnd: Int) {
        super.onSelectionChanged(selStart, selEnd)
        journeyLog?.ic("updateSelection", "start=$selStart end=$selEnd")
    }
}

internal class PresentationChatImeConnection(
    target: InputConnection,
    private val log: PresentationChatJourneyLog,
) : InputConnectionWrapper(target, true) {
    override fun setComposingText(text: CharSequence?, newCursorPosition: Int): Boolean {
        log.ic(
            "setComposingText",
            "len=${text?.length ?: 0} cursor=$newCursorPosition composing=true",
        )
        return super.setComposingText(text, newCursorPosition)
    }

    override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
        log.ic("commitText", "len=${text?.length ?: 0} cursor=$newCursorPosition")
        return super.commitText(text, newCursorPosition)
    }

    override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
        log.ic("deleteSurroundingText", "before=$beforeLength after=$afterLength")
        return super.deleteSurroundingText(beforeLength, afterLength)
    }

    override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean {
        log.ic("deleteSurroundingText", "before=$beforeLength after=$afterLength")
        return super.deleteSurroundingTextInCodePoints(beforeLength, afterLength)
    }

    override fun setSelection(start: Int, end: Int): Boolean {
        log.ic("setSelection", "start=$start end=$end")
        return super.setSelection(start, end)
    }

    override fun performEditorAction(editorAction: Int): Boolean {
        val code = PresentationChatJourneyMarkers.editorActionCode(editorAction)
        log.ic("performEditorAction", "code=$code")
        return super.performEditorAction(editorAction)
    }

    override fun finishComposingText(): Boolean {
        log.ic("finishComposingText", "composing=false")
        return super.finishComposingText()
    }

    override fun sendKeyEvent(event: KeyEvent?): Boolean {
        if (event != null && event.action == KeyEvent.ACTION_DOWN) {
            when (event.keyCode) {
                KeyEvent.KEYCODE_DEL ->
                    log.ic("deleteSurroundingText", "before=1 after=0")
                KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER ->
                    return performEditorAction(EditorInfo.IME_ACTION_SEND)
            }
        }
        return super.sendKeyEvent(event)
    }
}
