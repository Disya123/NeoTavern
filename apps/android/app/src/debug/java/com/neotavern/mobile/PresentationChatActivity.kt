package com.neotavern.mobile

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.view.AccessibilityDelegateCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.accessibility.AccessibilityNodeInfoCompat
import java.io.File

/**
 * Debug harness around the live Product Wire chat route. Not a launcher.
 *
 * `adb shell am start -n com.neotavern.mobile/.PresentationChatActivity --es com.neotavern.mobile.NEOTA_DIOXUS_SHELL 1`
 *
 * Safe mode extra opens production [MainActivity] (WebView rollback).
 */
class PresentationChatActivity : Activity() {
    private var holder: KernelHolder? = null
    private lateinit var header: TextView
    private lateinit var viewport: TextView
    private lateinit var scroller: ScrollView
    private lateinit var composer: EditText
    private lateinit var send: Button
    private var composerWatcher: TextWatcher? = null
    private var routeReady: Boolean = false
    private var prependInFlight: Boolean = false
    private var imeLogged: Boolean = false
    private val sendGate = PresentationChatSendGate()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val restoredComposer = savedInstanceState?.getString(STATE_COMPOSER).orEmpty()
        Log.i(
            TAG,
            "chat_restore saved=${savedInstanceState != null} composer_len=${restoredComposer.length} production_cutover=false",
        )

        if (PresentationChatLaunch.isSafeMode(intent.getStringExtra(PresentationChatLaunch.EXTRA_SAFE_MODE))) {
            val line =
                "chat_route=false dioxus_shell=false live_wire=false reason=safe_mode main_activity=true production_jni=false production_cutover=false"
            Log.i(TAG, line)
            startActivity(Intent(this, MainActivity::class.java))
            finish()
            return
        }

        val root = LinearLayout(this)
        root.orientation = LinearLayout.VERTICAL
        root.contentDescription = "Chat workspace"

        header = TextView(this)
        header.id = View.generateViewId()
        header.textSize = 16f
        header.setPadding(48, 48, 48, 16)
        header.contentDescription = "Chat header"
        header.isFocusable = true

        viewport = TextView(this)
        viewport.id = View.generateViewId()
        viewport.textSize = 16f
        viewport.setPadding(48, 16, 48, 24)
        viewport.setTextIsSelectable(true)
        viewport.contentDescription = "Chat messages"
        viewport.accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        viewport.isFocusable = true

        scroller = ScrollView(this)
        scroller.isFillViewport = true
        scroller.addView(
            viewport,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ),
        )
        scroller.setOnScrollChangeListener { _, _, scrollY, _, oldScrollY ->
            if (routeReady && scrollY == 0 && oldScrollY > 0) {
                prependOlder()
            }
        }

        composer = EditText(this)
        composer.id = View.generateViewId()
        composer.hint = "Message"
        composer.contentDescription = "Message composer"
        composer.imeOptions = EditorInfo.IME_ACTION_SEND
        composer.inputType = InputType.TYPE_CLASS_TEXT or
            InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or
            InputType.TYPE_TEXT_FLAG_MULTI_LINE
        composer.setRawInputType(InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES)
        composer.gravity = Gravity.TOP
        composer.minLines = 2
        composer.setPadding(48, 24, 24, 48)
        savedInstanceState?.getString(STATE_COMPOSER)?.let { composer.setText(it) }

        send = Button(this)
        send.id = View.generateViewId()
        send.text = "Send"
        send.contentDescription = "Send"
        send.isFocusable = true

        header.accessibilityTraversalBefore = viewport.id
        viewport.accessibilityTraversalBefore = composer.id
        composer.accessibilityTraversalBefore = send.id

        val viewportParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            0,
            1f,
        )
        val composerParams = LinearLayout.LayoutParams(
            0,
            LinearLayout.LayoutParams.WRAP_CONTENT,
            1f,
        )
        val sendParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        )
        sendParams.gravity = Gravity.BOTTOM
        val composerRow = LinearLayout(this)
        composerRow.orientation = LinearLayout.HORIZONTAL
        composerRow.addView(composer, composerParams)
        composerRow.addView(send, sendParams)
        root.addView(
            header,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ),
        )
        root.addView(scroller, viewportParams)
        root.addView(
            composerRow,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ),
        )
        setContentView(root)

        bindViewportActions()

        header.setOnLongClickListener {
            retryGeneration()
            true
        }

        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            val sys = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(sys.left, sys.top, sys.right, ime.bottom.coerceAtLeast(sys.bottom))
            insets
        }
        ViewCompat.setWindowInsetsAnimationCallback(
            root,
            object : WindowInsetsAnimationCompat.Callback(
                WindowInsetsAnimationCompat.Callback.DISPATCH_MODE_CONTINUE_ON_SUBTREE,
            ) {
                override fun onProgress(
                    insets: WindowInsetsCompat,
                    runningAnimations: MutableList<WindowInsetsAnimationCompat>,
                ): WindowInsetsCompat {
                    val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
                    val sys = insets.getInsets(WindowInsetsCompat.Type.systemBars())
                    if (ime.bottom > 0 && !imeLogged) {
                        imeLogged = true
                        Log.i(TAG, "chat_ime inset=${ime.bottom} production_cutover=false")
                    }
                    root.setPadding(sys.left, sys.top, sys.right, ime.bottom.coerceAtLeast(sys.bottom))
                    return insets
                }
            },
        )

        val flag = intent.getStringExtra(PresentationChatLaunch.EXTRA_DIOXUS_SHELL)
        if (!PresentationChatLaunch.isFlagged(flag)) {
            val line =
                "chat_route=false dioxus_shell=false live_wire=false reason=flag_off main_activity=false production_jni=false production_cutover=false"
            Log.i(TAG, line)
            header.text = "Chat"
            viewport.text = line.replace(' ', '\n')
            composer.isEnabled = false
            send.isEnabled = false
            return
        }

        header.text = "Chat"
        viewport.text = "live Product Wire chat route starting…"
        val profile = PresentationChatLaunch.parseProfile(
            intent.getStringExtra(PresentationChatLaunch.EXTRA_CHAT_PROFILE)
                ?: savedInstanceState?.getString(PresentationChatLaunch.EXTRA_CHAT_PROFILE),
        )
        val isolated = PresentationChatLaunch.isIsolated10k(profile)
        val dataRoot = if (isolated) {
            val isolatedRoot = File(applicationContext.filesDir, PresentationChatLaunch.ISOLATED_DATA_ROOT)
            if (!isolatedRoot.exists() && !isolatedRoot.mkdirs()) {
                viewport.text = "unable to create isolated data root"
                composer.isEnabled = false
                send.isEnabled = false
                return
            }
            isolatedRoot.absolutePath
        } else {
            ManagedDataRoot(this).ensure().absolutePath
        }
        val holder = if (isolated) {
            KernelHolder(JniNativeKernel, dataRoot) { error ->
                Log.e(TAG, "isolated kernel open failed", error)
            }
        } else {
            KernelHost.holder(dataRoot) { error ->
                Log.e(TAG, "kernel open failed", error)
            }
        }
        this.holder = holder
        holder.acquire()
        val chatId = PresentationChatLaunch.parseChatId(
            intent.getStringExtra(PresentationChatLaunch.EXTRA_CHAT_ID)
                ?: savedInstanceState?.getString(PresentationChatLaunch.EXTRA_CHAT_ID),
        )
        val flagValue = PresentationChatLaunch.parseFlag(flag)
        if (isolated) {
            viewport.text = "isolated 10k Product Wire seed…"
            Log.i(TAG, "chat_profile=isolated-10k data_root_isolated=true production_cutover=false")
        }
        holder.executor.execute {
            val line = try {
                val envelopes = EnvelopeBuilder.fromHandshake(holder.session.handshake())
                val wire = PresentationChatWire(holder.session, envelopes)
                PresentationChatNative.openRoute(flagValue, chatId, profile, wire)
            } catch (err: UnsatisfiedLinkError) {
                "chat_route=false dioxus_shell=true live_wire=false reason=missing_jni main_activity=false production_jni=false production_cutover=false"
            } catch (err: Throwable) {
                "chat_route=false dioxus_shell=true live_wire=false reason=load_failed:${err.javaClass.simpleName} main_activity=false production_jni=false production_cutover=false"
            }
            Log.i(TAG, line)
            runOnUiThread {
                bindComposer(holder)
                if (line.contains("chat_route=true")) {
                    routeReady = true
                    savedInstanceState?.getString(STATE_COMPOSER)?.let { restored ->
                        if (restored.isNotEmpty()) {
                            holder.executor.execute { PresentationChatNative.saveDraft(restored) }
                        }
                    }
                    refreshFromRoute(holder)
                } else {
                    viewport.text = line.replace(' ', '\n')
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        if (routeReady) {
            holder?.let { refreshFromRoute(it) }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString(
            PresentationChatLaunch.EXTRA_CHAT_ID,
            PresentationChatLaunch.parseChatId(intent.getStringExtra(PresentationChatLaunch.EXTRA_CHAT_ID)),
        )
        outState.putString(
            PresentationChatLaunch.EXTRA_CHAT_PROFILE,
            PresentationChatLaunch.parseProfile(
                intent.getStringExtra(PresentationChatLaunch.EXTRA_CHAT_PROFILE),
            ),
        )
        if (::composer.isInitialized) {
            outState.putString(STATE_COMPOSER, composer.text?.toString().orEmpty())
        }
    }

    override fun onDestroy() {
        if (::composer.isInitialized) {
            composerWatcher?.let { composer.removeTextChangedListener(it) }
        }
        holder?.release()
        holder = null
        super.onDestroy()
    }

    private fun bindComposer(holder: KernelHolder) {
        composer.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEND) {
                sendComposer(holder)
                true
            } else {
                false
            }
        }
        send.setOnClickListener { sendComposer(holder) }
        val watcher = object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
                val text = s?.toString().orEmpty()
                holder.executor.execute {
                    try {
                        PresentationChatNative.saveDraft(text)
                    } catch (_: Throwable) {
                    }
                }
            }
        }
        composerWatcher = watcher
        composer.addTextChangedListener(watcher)
    }

    private fun sendComposer(holder: KernelHolder) {
        if (!routeReady) {
            return
        }
        if (!sendGate.tryBegin()) {
            Log.i(TAG, "chat_send coalesced in_flight=true production_cutover=false")
            return
        }
        val text = composer.text?.toString().orEmpty()
        holder.executor.execute {
            try {
                val trace = PresentationChatNative.send(text)
                Log.i(TAG, trace)
                var snap = PresentationChatNative.snapshot()
                var parsed = PresentationChatSnapshot.parse(snap)
                var polls = 0
                while (parsed?.streaming == true && polls < 40) {
                    PresentationChatNative.pollStream(50)
                    snap = PresentationChatNative.snapshot()
                    parsed = PresentationChatSnapshot.parse(snap)
                    polls += 1
                }
                val view = parsed
                Log.i(TAG, view?.sendTraceLine() ?: "chat_send live_wire=true parse=false production_cutover=false")
                runOnUiThread {
                    bindSnapshot(snap, view, stickToBottom = true)
                    view?.let { replaceComposerText(it.composer) }
                    send.isEnabled = true
                }
            } catch (err: Throwable) {
                Log.e(TAG, "send failed", err)
                runOnUiThread { send.isEnabled = true }
            } finally {
                sendGate.end()
            }
        }
    }

    private fun replaceComposerText(text: String) {
        if (!::composer.isInitialized) {
            return
        }
        composerWatcher?.let { composer.removeTextChangedListener(it) }
        if (composer.text?.toString() != text) {
            composer.setText(text)
            composer.setSelection(text.length)
        }
        composerWatcher?.let { composer.addTextChangedListener(it) }
    }

    private fun retryGeneration() {
        val holder = this.holder ?: return
        if (!routeReady) {
            return
        }
        holder.executor.execute {
            try {
                PresentationChatNative.retry()
            } catch (err: Throwable) {
                Log.e(TAG, "retry failed", err)
            }
            runOnUiThread { refreshFromRoute(holder) }
        }
    }

    private fun prependOlder() {
        val holder = this.holder ?: return
        if (!routeReady || prependInFlight) {
            return
        }
        prependInFlight = true
        holder.executor.execute {
            try {
                PresentationChatNative.prepend()
            } catch (err: Throwable) {
                Log.e(TAG, "prepend failed", err)
            }
            runOnUiThread {
                prependInFlight = false
                refreshFromRoute(holder, stickToBottom = false)
            }
        }
    }

    private fun refreshFromRoute(holder: KernelHolder, stickToBottom: Boolean = true) {
        holder.executor.execute {
            try {
                var snap = PresentationChatNative.snapshot()
                var parsed = PresentationChatSnapshot.parse(snap)
                var polls = 0
                while (parsed?.streaming == true && polls < 40) {
                    PresentationChatNative.pollStream(50)
                    snap = PresentationChatNative.snapshot()
                    parsed = PresentationChatSnapshot.parse(snap)
                    polls += 1
                }
                val view = parsed
                runOnUiThread { bindSnapshot(snap, view, stickToBottom) }
            } catch (err: Throwable) {
                Log.e(TAG, "snapshot failed", err)
            }
        }
    }

    private fun bindSnapshot(
        raw: String,
        snap: PresentationChatSnapshot?,
        stickToBottom: Boolean,
    ) {
        if (snap == null) {
            viewport.text = raw.replace(' ', '\n')
            Log.i(TAG, "chat_snapshot live_wire=false parse=false production_cutover=false")
            return
        }
        header.text = snap.headerText()
        header.contentDescription = "Chat header, ${snap.title}, ${snap.messageCount} messages"
        viewport.text = snap.rowsText()
        viewport.contentDescription = "Chat messages"
        Log.i(
            TAG,
            "chat_snapshot live_wire=true messageCount=${snap.messageCount} kernelMessageCount=${snap.kernelMessageCount} pageLen=${snap.pageLen} visible=${snap.visible.size} sceneEpoch=${snap.sceneEpoch} sendAccepted=${snap.sendAccepted} streaming=${snap.streaming} error=${snap.error ?: "none"} production_cutover=false",
        )
        if (stickToBottom) {
            scroller.post { scroller.fullScroll(View.FOCUS_DOWN) }
        }
    }

    private fun bindViewportActions() {
        ViewCompat.setAccessibilityDelegate(
            scroller,
            object : AccessibilityDelegateCompat() {
                override fun onInitializeAccessibilityNodeInfo(
                    host: View,
                    info: AccessibilityNodeInfoCompat,
                ) {
                    super.onInitializeAccessibilityNodeInfo(host, info)
                    info.addAction(AccessibilityNodeInfoCompat.AccessibilityActionCompat.ACTION_SCROLL_FORWARD)
                    info.addAction(AccessibilityNodeInfoCompat.AccessibilityActionCompat.ACTION_SCROLL_BACKWARD)
                    info.addAction(AccessibilityNodeInfoCompat.AccessibilityActionCompat.ACTION_CLICK)
                    info.isScrollable = true
                    info.contentDescription = "Chat messages"
                }

                override fun performAccessibilityAction(
                    host: View,
                    action: Int,
                    args: Bundle?,
                ): Boolean {
                    return when (action) {
                        AccessibilityNodeInfo.ACTION_SCROLL_FORWARD -> {
                            scroller.fullScroll(View.FOCUS_DOWN)
                            true
                        }
                        AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD -> {
                            prependOlder()
                            scroller.fullScroll(View.FOCUS_UP)
                            true
                        }
                        AccessibilityNodeInfo.ACTION_CLICK -> {
                            scroller.fullScroll(View.FOCUS_DOWN)
                            true
                        }
                        else -> super.performAccessibilityAction(host, action, args)
                    }
                }
            },
        )
    }

    private companion object {
        const val TAG: String = "NeoTavern"
        const val STATE_COMPOSER: String = "presentation_chat_composer"
    }
}
