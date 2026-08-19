package com.neotavern.mobile

/**
 * Native chat composer / Send / header overlay is a TalkBack IME bridge for
 * the chat route only. Character Manager and other sidebar panels must not
 * keep those views in the hierarchy (they leak Message/Send labels into
 * screenshots and uiautomator dumps).
 */
object PresentationChatOverlay {
    fun attachNativeChrome(chatRouteVisible: Boolean): Boolean = chatRouteVisible
}
