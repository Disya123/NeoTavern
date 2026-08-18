package com.neotavern.mobile

import android.app.Activity
import android.os.Bundle
import android.view.MotionEvent
import android.widget.TextView

/**
 * Debug-only MotionEvent / Choreographer host. Not a launcher. Start with:
 *
 * `adb shell am start -n com.neotavern.mobile/.PresentationInputActivity`
 *
 * Does not change production WebView [MainActivity] or default JNI.
 */
class PresentationInputActivity : Activity() {
    private val adapter = PresentationInputAdapter()
    private lateinit var view: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        view = TextView(this)
        view.text = "input adapter (debug)"
        view.textSize = 16f
        view.setPadding(48, 48, 48, 48)
        setContentView(view)
        adapter.attach(view)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        val handled = adapter.onTouch(event)
        val stats = adapter.queue.stats()
        view.text =
            "vsync=${adapter.lastVsyncNanos}\nqueued=${stats.current} high=${stats.highWater} dropM=${stats.droppedMoves}"
        return handled || super.onTouchEvent(event)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus) {
            adapter.loseFocus()
        }
    }

    override fun onPause() {
        adapter.loseWindow()
        super.onPause()
    }

    override fun onDestroy() {
        adapter.stopFrameCallbacks()
        super.onDestroy()
    }
}
