package com.neotavern.mobile

import android.app.Activity
import android.content.Context
import android.content.Intent

/**
 * Starts [PresentationChatActivity] for a guarded canary session.
 * Does not load presentation JNI and does not acquire the Kernel.
 */
object PresentationCanaryHost {
    fun launch(activity: Activity, source: Intent, lastChatId: String): Boolean {
        val chat = Intent(activity, PresentationChatActivity::class.java)
        chat.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        chat.putExtra(PresentationChatLaunch.EXTRA_DIOXUS_SHELL, PresentationChatLaunch.FLAG_ON)
        chat.putExtra(PresentationChatLaunch.EXTRA_CANARY_SESSION, PresentationChatLaunch.FLAG_ON)
        val chatId = PresentationChatLaunch.parseChatId(
            source.getStringExtra(PresentationChatLaunch.EXTRA_CHAT_ID),
        ).ifEmpty { lastChatId }
        if (chatId.isNotEmpty()) {
            chat.putExtra(PresentationChatLaunch.EXTRA_CHAT_ID, chatId)
        }
        val profile = PresentationChatLaunch.parseProfile(
            source.getStringExtra(PresentationChatLaunch.EXTRA_CHAT_PROFILE),
        )
        if (profile.isNotEmpty()) {
            chat.putExtra(PresentationChatLaunch.EXTRA_CHAT_PROFILE, profile)
        }
        activity.startActivity(chat)
        return true
    }

    fun openLauncherIntent(context: Context, chatId: String): Intent {
        val open = Intent(context, MainActivity::class.java)
        open.flags = Intent.FLAG_ACTIVITY_NEW_TASK or
            Intent.FLAG_ACTIVITY_CLEAR_TOP or
            Intent.FLAG_ACTIVITY_SINGLE_TOP
        if (chatId.isNotEmpty()) {
            open.putExtra(PresentationChatLaunch.EXTRA_CHAT_ID, chatId)
        }
        return open
    }
}
