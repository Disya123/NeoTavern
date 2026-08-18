package com.neotavern.mobile

/**
 * Coalesces in-flight send callbacks. `chats.messages.create` is not
 * idempotent, so a repeated editor/button retry must not mint a second row.
 * PURE Kotlin so JVM tests cover it.
 */
class PresentationChatSendGate {
    @Volatile
    var inFlight: Boolean = false
        private set

    fun tryBegin(): Boolean {
        synchronized(this) {
            if (inFlight) {
                return false
            }
            inFlight = true
            return true
        }
    }

    fun end() {
        synchronized(this) {
            inFlight = false
        }
    }
}
