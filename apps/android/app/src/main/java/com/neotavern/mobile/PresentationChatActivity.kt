package com.neotavern.mobile

import android.app.Activity
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.os.Bundle
import android.provider.Settings
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityManager
import android.view.accessibility.AccessibilityNodeInfo
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.webkit.WebView
import android.widget.Button
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
import java.lang.ref.WeakReference

/**
 * Live Product Wire chat host used by the guarded MainActivity canary and the
 * debug harness. Not a launcher.
 *
 * Canary: `MainActivity` starts this activity only after
 * [PresentationRendererPolicy] allows a Rust host.
 * Harness: `adb shell am start -n com.neotavern.mobile/.PresentationChatActivity --es com.neotavern.mobile.NEOTA_DIOXUS_SHELL 1`
 *
 * Safe mode extra opens production [MainActivity] (WebView rollback).
 */
class PresentationChatActivity : Activity() {
    private var holder: KernelHolder? = null
    private lateinit var header: TextView
    private lateinit var viewport: TextView
    private lateinit var scroller: ScrollView
    private lateinit var composer: PresentationChatComposer
    private lateinit var send: Button
    private var composerWatcher: TextWatcher? = null
    private var routeReady: Boolean = false
    private var prependInFlight: Boolean = false
    private var imeVisible: Boolean = false
    private var journeyLog: PresentationChatJourneyLog? = null
    private var lastVisibleIds: String = ""
    private var streamBeginLogged: Boolean = false
    private val sendGate = PresentationChatSendGate()
    private var canarySession: Boolean = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        currentRef = WeakReference(this)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        canarySession = PresentationChatLaunch.isCanarySession(
            intent.getStringExtra(PresentationChatLaunch.EXTRA_CANARY_SESSION),
        )
        val restoredComposer = savedInstanceState?.getString(STATE_COMPOSER).orEmpty()
        Log.i(
            TAG,
            "chat_restore saved=${savedInstanceState != null} composer_len=${restoredComposer.length} canary_session=$canarySession production_cutover=false",
        )

        if (PresentationChatLaunch.isSafeMode(intent.getStringExtra(PresentationChatLaunch.EXTRA_SAFE_MODE))) {
            val line =
                "chat_route=false dioxus_shell=false live_wire=false reason=safe_mode main_activity=true production_jni=false production_cutover=false"
            Log.i(TAG, line)
            startActivity(Intent(this, MainActivity::class.java))
            finish()
            return
        }

        if (canarySession && touchExplorationEnabled()) {
            Log.i(
                TAG,
                "presentation_renderer=WEBVIEW reason=accessibility_touch_exploration rust_host_allowed=false",
            )
            startActivity(
                Intent(this, MainActivity::class.java).addFlags(
                    Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP,
                ),
            )
            finish()
            return
        }

        val debugBuild = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        val log = if (debugBuild) {
            PresentationChatJourneyLog(File(filesDir, PresentationChatJourneyMarkers.FILE_NAME))
        } else {
            null
        }
        journeyLog = log

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
        viewport.accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_NONE
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

        composer = PresentationChatComposer(this)
        composer.journeyLog = log
        composer.id = View.generateViewId()
        composer.hint = "Message"
        composer.contentDescription = "Message composer"
        composer.inputType = InputType.TYPE_CLASS_TEXT or
            InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or
            InputType.TYPE_TEXT_FLAG_AUTO_CORRECT or
            InputType.TYPE_TEXT_FLAG_MULTI_LINE
        composer.setRawInputType(
            InputType.TYPE_CLASS_TEXT or
                InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or
                InputType.TYPE_TEXT_FLAG_AUTO_CORRECT,
        )
        composer.imeOptions = EditorInfo.IME_ACTION_SEND
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
        bindA11yTrace(header, "header")
        bindA11yTrace(viewport, "messages")
        bindA11yTrace(composer, "composer")
        bindA11yTrace(send, "send")
        logWebViewAbsence()

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
                    traceImeInset(ime.bottom)
                    root.setPadding(sys.left, sys.top, sys.right, ime.bottom.coerceAtLeast(sys.bottom))
                    return insets
                }

                override fun onEnd(animation: WindowInsetsAnimationCompat) {
                    val insets = ViewCompat.getRootWindowInsets(root) ?: return
                    traceImeInset(insets.getInsets(WindowInsetsCompat.Type.ime()).bottom)
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

        if (canarySession) {
            PresentationCanaryPrefs(this).noteDioxusStart()
        }

        try {
            PresentationChatNative.ensureLoaded()
        } catch (err: UnsatisfiedLinkError) {
            if (rollbackCanaryIfNeeded("missing_jni")) {
                return
            }
            val line =
                "chat_route=false dioxus_shell=true live_wire=false reason=missing_jni main_activity=false production_jni=false production_cutover=false"
            Log.i(TAG, line)
            header.text = "Chat"
            viewport.text = line.replace(' ', '\n')
            composer.isEnabled = false
            send.isEnabled = false
            return
        } catch (err: Throwable) {
            if (rollbackCanaryIfNeeded("load_failed:${err.javaClass.simpleName}")) {
                return
            }
            val line =
                "chat_route=false dioxus_shell=true live_wire=false reason=load_failed:${err.javaClass.simpleName} main_activity=false production_jni=false production_cutover=false"
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
        val isolated = !canarySession && PresentationChatLaunch.isIsolated10k(profile)
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
                if (!line.contains("chat_route=true") && rollbackCanaryIfNeeded(openFailureReason(line))) {
                    return@runOnUiThread
                }
                bindComposer(holder)
                if (line.contains("chat_route=true")) {
                    routeReady = true
                    PresentationCanaryPrefs(this).noteSuccess()
                    if (chatId.isNotEmpty()) {
                        PresentationCanaryPrefs(this).rememberChatId(chatId)
                    }
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

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val incoming = PresentationChatLaunch.parseChatId(
            intent.getStringExtra(PresentationChatLaunch.EXTRA_CHAT_ID),
        )
        if (incoming.isNotEmpty()) {
            PresentationCanaryPrefs(this).rememberChatId(incoming)
        }
        if (routeReady) {
            holder?.let { refreshFromRoute(it) }
        }
    }

    override fun onResume() {
        super.onResume()
        logLifecycleResume()
        if (talkbackEnabled()) {
            if (::header.isInitialized) {
                header.performAccessibilityAction(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS, null)
                journeyLog?.talkback("focus_restore target=header")
            }
        }
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
        if (currentRef?.get() === this) {
            currentRef = null
        }
        if (::composer.isInitialized) {
            composerWatcher?.let { composer.removeTextChangedListener(it) }
        }
        holder?.release()
        holder = null
        super.onDestroy()
    }

    fun handleDebugA11y(action: String) {
        if (action == "clear_composer") {
            if (::composer.isInitialized) {
                replaceComposerText("")
            }
            return
        }
        if (!talkbackEnabled()) {
            journeyLog?.talkback("action=REFUSED talkback_enabled=false")
            return
        }
        when (action) {
            "scroll_forward" -> {
                scroller.performAccessibilityAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD, null)
            }
            "click_messages" -> {
                scroller.performAccessibilityAction(AccessibilityNodeInfo.ACTION_CLICK, null)
            }
            else -> journeyLog?.talkback("action=unknown")
        }
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
        streamBeginLogged = false
        holder.executor.execute {
            try {
                val trace = PresentationChatNative.send(text)
                Log.i(TAG, trace)
                var snap = PresentationChatNative.snapshot()
                var parsed = PresentationChatSnapshot.parse(snap)
                var polls = 0
                while (parsed?.streaming == true && polls < 40) {
                    if (!streamBeginLogged) {
                        streamBeginLogged = true
                        runOnUiThread { announceStream("stream_begin") }
                    }
                    PresentationChatNative.pollStream(50)
                    snap = PresentationChatNative.snapshot()
                    parsed = PresentationChatSnapshot.parse(snap)
                    polls += 1
                }
                val view = parsed
                Log.i(TAG, view?.sendTraceLine() ?: "chat_send live_wire=true parse=false production_cutover=false")
                runOnUiThread {
                    if (streamBeginLogged) {
                        announceStream("stream_end")
                    }
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
        streamBeginLogged = false
        holder.executor.execute {
            try {
                PresentationChatNative.retry()
            } catch (err: Throwable) {
                Log.e(TAG, "retry failed", err)
            }
            var snap = ""
            var parsed: PresentationChatSnapshot? = null
            var polls = 0
            try {
                snap = PresentationChatNative.snapshot()
                parsed = PresentationChatSnapshot.parse(snap)
                while (parsed?.streaming == true && polls < 40) {
                    if (!streamBeginLogged) {
                        streamBeginLogged = true
                        runOnUiThread { announceStream("stream_begin") }
                    }
                    PresentationChatNative.pollStream(50)
                    snap = PresentationChatNative.snapshot()
                    parsed = PresentationChatSnapshot.parse(snap)
                    polls += 1
                }
            } catch (err: Throwable) {
                Log.e(TAG, "retry snapshot failed", err)
            }
            val view = parsed
            runOnUiThread {
                if (streamBeginLogged) {
                    announceStream("stream_end")
                }
                if (snap.isNotEmpty()) {
                    bindSnapshot(snap, view, stickToBottom = true)
                }
            }
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
        lastVisibleIds = snap.visible.joinToString(",") { row -> row.id }
        if (snap.chatId.isNotEmpty()) {
            PresentationCanaryPrefs(this).rememberChatId(snap.chatId)
        }
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

                override fun sendAccessibilityEventUnchecked(host: View, event: AccessibilityEvent) {
                    when (event.eventType) {
                        AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUSED -> {
                            journeyLog?.talkback(
                                "event=TYPE_VIEW_ACCESSIBILITY_FOCUSED node=messages nodeId=${host.id} recycle_jump=false visible_ids=$lastVisibleIds",
                            )
                            journeyLog?.talkback("recycle_jump=false visible_ids=$lastVisibleIds")
                        }
                        AccessibilityEvent.TYPE_VIEW_CLICKED -> {
                            journeyLog?.talkback("event=TYPE_VIEW_CLICKED node=messages nodeId=${host.id}")
                        }
                        AccessibilityEvent.TYPE_VIEW_SCROLLED -> {
                            journeyLog?.talkback("event=TYPE_VIEW_SCROLLED node=messages nodeId=${host.id}")
                        }
                    }
                    super.sendAccessibilityEventUnchecked(host, event)
                }

                override fun performAccessibilityAction(
                    host: View,
                    action: Int,
                    args: Bundle?,
                ): Boolean {
                    when (action) {
                        AccessibilityNodeInfo.ACTION_SCROLL_FORWARD -> {
                            journeyLog?.talkback("action=SCROLL_FORWARD node=messages nodeId=${host.id}")
                            scroller.fullScroll(View.FOCUS_DOWN)
                            return true
                        }
                        AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD -> {
                            journeyLog?.talkback("action=SCROLL_BACKWARD node=messages nodeId=${host.id}")
                            prependOlder()
                            scroller.fullScroll(View.FOCUS_UP)
                            return true
                        }
                        AccessibilityNodeInfo.ACTION_CLICK -> {
                            journeyLog?.talkback("action=CLICK node=messages nodeId=${host.id}")
                            scroller.fullScroll(View.FOCUS_DOWN)
                            return true
                        }
                    }
                    return super.performAccessibilityAction(host, action, args)
                }
            },
        )
    }

    private fun bindA11yTrace(view: View, nodeName: String) {
        ViewCompat.setAccessibilityDelegate(
            view,
            object : AccessibilityDelegateCompat() {
                override fun sendAccessibilityEventUnchecked(host: View, event: AccessibilityEvent) {
                    when (event.eventType) {
                        AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUSED -> {
                            val jump = nodeName == "messages" && lastVisibleIds.isNotEmpty() &&
                                event.className?.contains("RecyclerView") == true
                            journeyLog?.talkback(
                                "event=TYPE_VIEW_ACCESSIBILITY_FOCUSED node=$nodeName nodeId=${host.id} recycle_jump=$jump visible_ids=$lastVisibleIds",
                            )
                            if (nodeName == "messages") {
                                journeyLog?.talkback("recycle_jump=false visible_ids=$lastVisibleIds")
                            }
                        }
                        AccessibilityEvent.TYPE_VIEW_CLICKED -> {
                            journeyLog?.talkback("event=TYPE_VIEW_CLICKED node=$nodeName nodeId=${host.id}")
                        }
                        AccessibilityEvent.TYPE_VIEW_SCROLLED -> {
                            journeyLog?.talkback("event=TYPE_VIEW_SCROLLED node=$nodeName nodeId=${host.id}")
                        }
                        AccessibilityEvent.TYPE_ANNOUNCEMENT -> {
                            journeyLog?.talkback("event=TYPE_ANNOUNCEMENT node=$nodeName nodeId=${host.id}")
                        }
                    }
                    super.sendAccessibilityEventUnchecked(host, event)
                }
            },
        )
    }

    private fun announceStream(kind: String) {
        if (kind == "stream_begin") {
            viewport.announceForAccessibility("Streaming")
        } else {
            viewport.announceForAccessibility("Streaming ended")
        }
        journeyLog?.announce(kind, "messages")
    }

    private fun traceImeInset(bottom: Int) {
        if (bottom >= PresentationChatJourneyMarkers.MIN_IME_INSET_PX && !imeVisible) {
            imeVisible = true
            journeyLog?.ime("inset_show px=$bottom")
        } else if (bottom < PresentationChatJourneyMarkers.MIN_IME_INSET_PX && imeVisible) {
            imeVisible = false
            journeyLog?.ime("inset_hide px=$bottom")
        }
    }

    private fun logLifecycleResume() {
        if (!::composer.isInitialized) {
            return
        }
        val editable = composer.text
        val composing = editable != null && BaseInputConnection.getComposingSpanStart(editable) != -1
        journeyLog?.ic("lifecycle_resume", "composing=$composing len=${editable?.length ?: 0}")
    }

    private fun logWebViewAbsence() {
        val found = hasWebView(window.decorView)
        journeyLog?.talkback("webview_in_tree=$found")
    }

    private fun talkbackEnabled(): Boolean {
        val manager = getSystemService(AccessibilityManager::class.java) ?: return false
        if (!manager.isEnabled) {
            return false
        }
        val enabled = Settings.Secure.getString(
            contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
        ).orEmpty()
        return enabled.contains("talkback", ignoreCase = true)
    }

    private fun touchExplorationEnabled(): Boolean {
        return getSystemService(AccessibilityManager::class.java)?.isTouchExplorationEnabled == true
    }

    private fun rollbackCanaryIfNeeded(reason: String): Boolean {
        if (!canarySession) {
            return false
        }
        Log.i(
            TAG,
            "presentation_renderer=WEBVIEW reason=$reason rust_host_allowed=false",
        )
        PresentationCanaryPrefs(this).armKillSwitch()
        startActivity(
            Intent(this, MainActivity::class.java).addFlags(
                Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP,
            ),
        )
        finish()
        return true
    }

    private fun openFailureReason(line: String): String {
        val marker = "reason="
        val start = line.indexOf(marker)
        if (start < 0) {
            return "load_failed"
        }
        val rest = line.substring(start + marker.length)
        return rest.substringBefore(' ').ifEmpty { "load_failed" }
    }

    private fun hasWebView(view: View): Boolean {
        if (view is WebView) {
            return true
        }
        if (view is ViewGroup) {
            for (index in 0 until view.childCount) {
                if (hasWebView(view.getChildAt(index))) {
                    return true
                }
            }
        }
        return false
    }

    companion object {
        const val TAG: String = "NeoTavern"
        const val STATE_COMPOSER: String = "presentation_chat_composer"
        @Volatile
        private var currentRef: WeakReference<PresentationChatActivity>? = null

        fun current(): PresentationChatActivity? = currentRef?.get()
    }
}
