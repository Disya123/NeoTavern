package com.neotavern.mobile

/**
 * PURE formatter for Milestone C Gboard/TalkBack admission markers.
 * Lines carry action names, node ids, lengths, and epochs — never message
 * bodies or composing text.
 */
object PresentationChatJourneyMarkers {
    const val FILE_NAME: String = "neotavern-journey-markers.txt"
    const val MIN_IME_INSET_PX: Int = 200

    fun ic(action: String, fields: String, epoch: Long): String {
        return "gboard_ic action=$action ${fields.trim()} epoch=$epoch production_cutover=false".trim()
    }

    fun ime(fields: String, epoch: Long): String {
        return "gboard_ime ${fields.trim()} epoch=$epoch production_cutover=false"
    }

    fun talkback(fields: String, epoch: Long): String {
        return "talkback ${fields.trim()} epoch=$epoch production_cutover=false"
    }

    fun announce(kind: String, node: String, epoch: Long): String {
        return "a11y_announce kind=$kind node=$node epoch=$epoch production_cutover=false"
    }

    fun editorActionCode(editorAction: Int): String {
        return if (editorAction == EDITOR_ACTION_SEND) "SEND" else editorAction.toString()
    }

    const val EDITOR_ACTION_SEND: Int = 4
}
