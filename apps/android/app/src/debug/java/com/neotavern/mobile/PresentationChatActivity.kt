package com.neotavern.mobile

import android.app.Activity
import android.os.Bundle
import android.util.Log
import android.widget.TextView
import kotlin.concurrent.thread

/**
 * Debug-only flagged Dioxus chat workspace. Not a launcher. Start with:
 *
 * `adb shell am start -n com.neotavern.mobile/.PresentationChatActivity --es com.neotavern.mobile.NEOTA_DIOXUS_SHELL 1`
 *
 * Does not change production WebView [MainActivity] or default JNI.
 * Without the extra the route stays off.
 */
class PresentationChatActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val view = TextView(this)
        view.textSize = 16f
        view.setPadding(48, 48, 48, 48)
        setContentView(view)

        val flag = intent.getStringExtra(PresentationChatLaunch.EXTRA_DIOXUS_SHELL)
        if (!PresentationChatLaunch.isFlagged(flag)) {
            val line =
                "chat_route=false dioxus_shell=false reason=flag_off main_activity=false production_jni=false production_cutover=false"
            Log.i(TAG, line)
            view.text = line.replace(' ', '\n')
            return
        }

        view.text = "flagged chat route starting…"
        thread(name = "chat-route") {
            val line =
                try {
                    PresentationChatProbe.startRoute(PresentationChatLaunch.parseFlag(flag))
                } catch (err: Throwable) {
                    "chat_route=false dioxus_shell=true reason=load_failed:${err.javaClass.simpleName} main_activity=false production_jni=false production_cutover=false"
                }
            Log.i(TAG, line)
            runOnUiThread { view.text = line.replace(' ', '\n') }
        }
    }

    private companion object {
        const val TAG: String = "NeoTavern"
    }
}
