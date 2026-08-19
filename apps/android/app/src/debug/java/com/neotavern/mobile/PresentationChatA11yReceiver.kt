package com.neotavern.mobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Debug-only seam so the physical capture can fire accessibility scroll/click
 * while TalkBack is actually enabled. Does nothing if TalkBack is off.
 */
class PresentationChatA11yReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.getStringExtra(EXTRA_ACTION).orEmpty()
        PresentationChatActivity.current()?.handleDebugA11y(action)
    }

    companion object {
        const val ACTION: String = "com.neotavern.mobile.NEOTA_CHAT_A11Y"
        const val EXTRA_ACTION: String = "action"
    }
}
