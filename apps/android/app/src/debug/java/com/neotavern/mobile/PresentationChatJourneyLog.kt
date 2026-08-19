package com.neotavern.mobile

import android.util.Log
import java.io.File
import java.util.concurrent.atomic.AtomicLong

/**
 * Debug-only marker sink for Gboard InputConnection and TalkBack events.
 * Writes the same line to logcat and [PresentationChatJourneyMarkers.FILE_NAME].
 */
class PresentationChatJourneyLog(private val file: File) {
    private val epoch = AtomicLong(0)

    fun nextEpoch(): Long = epoch.incrementAndGet()

    @Synchronized
    fun write(line: String) {
        Log.i(TAG, line)
        file.appendText(line + "\n")
    }

    fun ic(action: String, fields: String) {
        write(PresentationChatJourneyMarkers.ic(action, fields, nextEpoch()))
    }

    fun ime(fields: String) {
        write(PresentationChatJourneyMarkers.ime(fields, nextEpoch()))
    }

    fun talkback(fields: String) {
        write(PresentationChatJourneyMarkers.talkback(fields, nextEpoch()))
    }

    fun announce(kind: String, node: String) {
        write(PresentationChatJourneyMarkers.announce(kind, node, nextEpoch()))
    }

    private companion object {
        const val TAG: String = "NeoTavern"
    }
}
