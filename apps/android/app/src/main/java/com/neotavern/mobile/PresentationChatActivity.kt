package com.neotavern.mobile

import android.app.Activity
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.os.Trace
import android.provider.Settings
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.util.Log
import android.view.Choreographer
import android.view.Gravity
import android.view.MotionEvent
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityManager
import android.view.accessibility.AccessibilityNodeInfo
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.webkit.WebView
import android.widget.Button
import android.widget.FrameLayout
import android.widget.TextView
import androidx.core.view.AccessibilityDelegateCompat
import androidx.core.view.OnApplyWindowInsetsListener
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowInsetsCompat
import java.io.File
import java.lang.ref.WeakReference

/**
 * Live Product Wire chat host. The visible renderer is NeoCompositor
 * [SurfaceView]; the snapshot TextView list is not the primary path.
 * An invisible platform IME bridge is retained for Gboard.
 */
class PresentationChatActivity : Activity(), SurfaceHolder.Callback {
    private var holder: KernelHolder? = null
    private lateinit var root: FrameLayout
    private lateinit var surfaceView: SurfaceView
    private lateinit var header: TextView
    private lateinit var messages: View
    private lateinit var composer: PresentationChatComposer
    private lateinit var send: Button
    private val adapter = PresentationInputAdapter()
    private val compositorThread = HandlerThread("neocompositor-chat")
    private var compositorHandler: Handler? = null
    private var presentPosted = false
    private var presentCallback: Choreographer.VsyncCallback? = null
    private var presentFrameCallback: Choreographer.FrameCallback? = null
    @Volatile
    private var nativeReady: Boolean = false
    private var lastSafeArea = floatArrayOf(0f, 0f, 0f, 0f)
    private var composerWatcher: TextWatcher? = null
    private var routeReady: Boolean = false
    private var prependInFlight: Boolean = false
    private var imeVisible: Boolean = false
    private var journeyLog: PresentationChatJourneyLog? = null
    private var lastVisibleIds: String = ""
    private var streamBeginLogged: Boolean = false
    private val sendGate = PresentationChatSendGate()
    private var canarySession: Boolean = false
    private var chatOverlayAttached: Boolean = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        currentRef = WeakReference(this)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        canarySession = PresentationChatLaunch.isCanarySession(
            intent.getStringExtra(PresentationChatLaunch.EXTRA_CANARY_SESSION),
        )
        val extrasTrusted = PresentationCanaryState.extrasTrusted(
            (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0,
        )
        PresentationCanaryPrefs(this).applyFlagExtra(
            intent.getStringExtra(PresentationChatLaunch.EXTRA_DIOXUS_SHELL),
            extrasTrusted,
        )
        val restoredComposer = savedInstanceState?.getString(STATE_COMPOSER).orEmpty()
        Log.i(
            TAG,
            "chat_restore saved=${savedInstanceState != null} composer_len=${restoredComposer.length} canary_session=$canarySession production_cutover=false",
        )

        if (PresentationChatLaunch.isSafeMode(intent.getStringExtra(PresentationChatLaunch.EXTRA_SAFE_MODE))) {
            Log.i(
                TAG,
                "chat_safe_mode=true renderer=rust webview_fallback=false production_cutover=false",
            )
        }

        if (canarySession && touchExplorationEnabled()) {
            Log.i(
                TAG,
                "presentation_renderer=RUST reason=accessibility_touch_exploration webview_fallback=false rust_host_allowed=true",
            )
        }

        val debugBuild = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        val log = if (debugBuild) {
            PresentationChatJourneyLog(File(filesDir, PresentationChatJourneyMarkers.FILE_NAME))
        } else {
            null
        }
        journeyLog = log

        compositorThread.start()
        compositorHandler = Handler(compositorThread.looper)

        root = FrameLayout(this)
        root.contentDescription = "Chat workspace"
        root.setBackgroundColor(Color.TRANSPARENT)
        window.setBackgroundDrawableResource(android.R.color.transparent)

        surfaceView = SurfaceView(this)
        surfaceView.holder.setFormat(PixelFormat.OPAQUE)
        surfaceView.holder.addCallback(this)

        header = TextView(this)
        header.id = View.generateViewId()
        header.alpha = 0.01f
        header.setBackgroundColor(Color.TRANSPARENT)
        header.contentDescription = "Chat header"
        header.isClickable = false
        header.isFocusable = true
        header.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES

        messages = View(this)
        messages.id = View.generateViewId()
        messages.alpha = 0.01f
        messages.setBackgroundColor(Color.TRANSPARENT)
        messages.contentDescription = "Chat messages"
        messages.isClickable = false
        messages.isFocusable = true
        messages.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES

        composer = PresentationChatComposer(this)
        composer.journeyLog = log
        composer.id = View.generateViewId()
        composer.hint = null
        composer.contentDescription = "Message composer"
        composer.alpha = 0.01f
        composer.setBackgroundColor(Color.TRANSPARENT)
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
        send.text = ""
        send.contentDescription = "Send"
        send.alpha = 0.01f
        send.setBackgroundColor(Color.TRANSPARENT)
        send.isFocusable = true

        header.accessibilityTraversalBefore = messages.id
        messages.accessibilityTraversalBefore = composer.id
        composer.accessibilityTraversalBefore = send.id

        root.addView(
            surfaceView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )
        send.text = ""
        composer.hint = null
        header.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        messages.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        composer.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        send.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        setContentView(root)

        adapter.nativeSink =
            object : PresentationInputAdapter.NativeSink {
                override fun tryPush(pointer: Int, kind: Int, x: Float, y: Float, timeNanos: Long) {
                    if (!nativeReady) return
                    try {
                        PresentationChatNative.tryPush(pointer, kind, x, y, timeNanos)
                    } catch (_: Throwable) {
                    }
                }

                override fun loseFocus(timeNanos: Long) {
                    if (!nativeReady) return
                    try {
                        PresentationChatNative.loseFocus(timeNanos)
                    } catch (_: Throwable) {
                    }
                }
            }
        adapter.attach(surfaceView)

        bindViewportActions()
        bindA11yTrace(header, "header")
        bindA11yTrace(messages, "messages")
        bindA11yTrace(composer, "composer")
        bindA11yTrace(send, "send")
        logWebViewAbsence()

        header.setOnLongClickListener {
            retryGeneration()
            true
        }

        bindSafeAreaInsets()

        ViewCompat.setWindowInsetsAnimationCallback(
            root,
            object : WindowInsetsAnimationCompat.Callback(
                WindowInsetsAnimationCompat.Callback.DISPATCH_MODE_CONTINUE_ON_SUBTREE,
            ) {
                override fun onProgress(
                    insets: WindowInsetsCompat,
                    runningAnimations: MutableList<WindowInsetsAnimationCompat>,
                ): WindowInsetsCompat {
                    traceImeInset(insets.getInsets(WindowInsetsCompat.Type.ime()).bottom)
                    compositorHandler?.post {
                        try {
                            flushSafeArea(stashSafeArea(insets))
                        } catch (_: Throwable) {
                        }
                    }
                    return insets
                }

                override fun onEnd(animation: WindowInsetsAnimationCompat) {
                    val insets = ViewCompat.getRootWindowInsets(root) ?: return
                    traceImeInset(insets.getInsets(WindowInsetsCompat.Type.ime()).bottom)
                }
            },
        )

        val extraFlag = intent.getStringExtra(PresentationChatLaunch.EXTRA_DIOXUS_SHELL)
        val flag = if (PresentationChatLaunch.isFlagOff(extraFlag)) {
            PresentationChatLaunch.FLAG_OFF
        } else {
            PresentationChatLaunch.FLAG_ON
        }
        if (!PresentationChatLaunch.isFlagged(flag)) {
            val line =
                "chat_route=false dioxus_shell=false live_wire=false reason=flag_off main_activity=false production_jni=false production_cutover=false"
            Log.i(TAG, line)
            header.contentDescription = "Chat header"
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
            composer.isEnabled = false
            send.isEnabled = false
            return
        }

        val softwareRaster = intent.getStringExtra(PresentationChatLaunch.EXTRA_SOFTWARE_RASTER_DEBUG)
        if (PresentationChatLaunch.isSoftwareRasterDebug(softwareRaster)) {
            PresentationChatNative.setSoftwareRasterDebug(true)
            Log.i(TAG, "software_raster_debug=1 renderer=vello-cpu")
        } else if (PresentationChatLaunch.isFlagOff(softwareRaster)) {
            PresentationChatNative.setSoftwareRasterDebug(false)
        }

        val profile = PresentationChatLaunch.parseProfile(
            intent.getStringExtra(PresentationChatLaunch.EXTRA_CHAT_PROFILE)
                ?: savedInstanceState?.getString(PresentationChatLaunch.EXTRA_CHAT_PROFILE),
        )
        val isolated = !canarySession && PresentationChatLaunch.isIsolated10k(profile)
        val dataRoot = if (isolated) {
            val isolatedRoot = File(applicationContext.filesDir, PresentationChatLaunch.ISOLATED_DATA_ROOT)
            if (!isolatedRoot.exists() && !isolatedRoot.mkdirs()) {
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
                    if (canarySession && chatId.isNotEmpty()) {
                        PresentationCanaryPrefs(this).rememberChatId(chatId)
                    }
                    savedInstanceState?.getString(STATE_COMPOSER)?.let { restored ->
                        if (restored.isNotEmpty()) {
                            holder.executor.execute { PresentationChatNative.saveDraft(restored) }
                        }
                    }
                    refreshFromRoute(holder)
                    compositorHandler?.post {
                        try {
                            val rebuilt = PresentationChatNative.rebuildScene()
                            Log.i(TAG, rebuilt)
                            syncChatOverlay()
                        } catch (err: Throwable) {
                            Log.e(TAG, "rebuildScene failed", err)
                        }
                    }
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
        if (canarySession && incoming.isNotEmpty()) {
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
        stopPresentLoop()
        adapter.stopFrameCallbacks()
        compositorHandler?.post {
            try {
                PresentationChatNative.detachSurface()
            } catch (_: Throwable) {
            }
        }
        compositorThread.quitSafely()
        holder?.release()
        holder = null
        super.onDestroy()
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

    override fun onTouchEvent(event: MotionEvent): Boolean {
        return adapter.onTouch(event) || super.onTouchEvent(event)
    }

    override fun surfaceCreated(holder: SurfaceHolder) = Unit

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
        val surface = holder.surface
        compositorHandler?.post {
            val line =
                try {
                    PresentationChatNative.detachSurface()
                    PresentationChatNative.attachSurface(
                        surface,
                        width,
                        height,
                        resources.displayMetrics.density,
                    )
                } catch (err: Throwable) {
                    "host=neocompositor-surfaceview attach_failed reason=${err.javaClass.simpleName}"
                }
            Log.i(TAG, line)
            nativeReady = line.contains("host=neocompositor-surfaceview") &&
                !line.contains("attach_failed")
            if (nativeReady) {
                val boxed = synchronized(lastSafeArea) { lastSafeArea.copyOf() }
                pushSafeArea(boxed[0], boxed[1], boxed[2], boxed[3])
                startPresentLoop()
                root.post { ViewCompat.requestApplyInsets(root) }
            }
        }
    }

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        nativeReady = false
        stopPresentLoop()
        compositorHandler?.post {
            try {
                PresentationChatNative.detachSurface()
            } catch (_: Throwable) {
            }
        }
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
                messages.performAccessibilityAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD, null)
            }
            "click_messages" -> {
                messages.performAccessibilityAction(AccessibilityNodeInfo.ACTION_CLICK, null)
            }
            else -> journeyLog?.talkback("action=unknown")
        }
    }

    private fun systemDimenPx(name: String): Int {
        val id = resources.getIdentifier(name, "dimen", "android")
        return if (id != 0) resources.getDimensionPixelSize(id) else 0
    }

    private fun bindSafeAreaInsets() {
        val forward = OnApplyWindowInsetsListener { _, insets ->
            val boxed = stashSafeArea(insets)
            compositorHandler?.post {
                try {
                    flushSafeArea(boxed)
                } catch (_: Throwable) {
                }
            }
            insets
        }
        ViewCompat.setOnApplyWindowInsetsListener(window.decorView, forward)
        ViewCompat.setOnApplyWindowInsetsListener(root, forward)
        ViewCompat.requestApplyInsets(root)
        root.post {
            ViewCompat.getRootWindowInsets(root)?.let { insets ->
                val boxed = stashSafeArea(insets)
                compositorHandler?.post {
                    try {
                        flushSafeArea(boxed)
                    } catch (_: Throwable) {
                    }
                }
            }
        }
    }

    private fun stashSafeArea(insets: WindowInsetsCompat): FloatArray {
        val sys = insets.getInsets(
            WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
        )
        val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
        val top = sys.top.coerceAtLeast(systemDimenPx("status_bar_height"))
        val bottom = if (ime.bottom > 0) {
            ime.bottom.coerceAtLeast(sys.bottom)
        } else {
            sys.bottom.coerceAtLeast(systemDimenPx("navigation_bar_height"))
        }
        val boxed = floatArrayOf(
            top.toFloat(),
            sys.right.toFloat(),
            bottom.toFloat(),
            sys.left.toFloat(),
        )
        synchronized(lastSafeArea) {
            boxed.copyInto(lastSafeArea)
        }
        Log.i(TAG, "safe-area physical px top=$top right=${sys.right} bottom=$bottom left=${sys.left}")
        return boxed
    }

    private fun flushSafeArea(boxed: FloatArray) {
        synchronized(lastSafeArea) {
            boxed.copyInto(lastSafeArea)
        }
        if (!nativeReady) {
            return
        }
        PresentationChatNative.setSafeArea(boxed[0], boxed[1], boxed[2], boxed[3])
    }

    private fun pushSafeArea(top: Float, right: Float, bottom: Float, left: Float) {
        flushSafeArea(floatArrayOf(top, right, bottom, left))
    }

    private fun startPresentLoop() {
        val handler = compositorHandler ?: return
        handler.post {
            if (presentPosted) return@post
            val choreographer = Choreographer.getInstance()
            if (Build.VERSION.SDK_INT >= 33) {
                val callback =
                    Choreographer.VsyncCallback { data ->
                        val timeline = data.preferredFrameTimeline
                        val nextTimeline =
                            data.frameTimelines
                                .filter { it.vsyncId > timeline.vsyncId }
                                .minByOrNull { it.vsyncId }
                        adapter.applyCompositorFrameTimeline(
                            data.frameTimeNanos,
                            timeline.vsyncId,
                            timeline.deadlineNanos,
                            timeline.expectedPresentationTimeNanos,
                            nextTimeline?.vsyncId ?: (timeline.vsyncId + 1L),
                            nextTimeline?.expectedPresentationTimeNanos
                                ?: (timeline.expectedPresentationTimeNanos + adapter.lastPeriodNanos),
                        )
                        Trace.beginSection("nt.chat.present")
                        val line =
                            try {
                                PresentationChatNative.presentFrame(
                                    timeline.vsyncId,
                                    data.frameTimeNanos,
                                    timeline.deadlineNanos,
                                    timeline.expectedPresentationTimeNanos,
                                )
                            } catch (err: Throwable) {
                                "host=neocompositor-surfaceview present_failed reason=${err.javaClass.simpleName}"
                            } finally {
                                Trace.endSection()
                            }
                        if (line.contains("present_failed") || line.contains("attach_failed")) {
                            Log.i(TAG, line)
                        }
                        syncChatOverlay()
                        adapter.markCompositorPresented(SystemClock.uptimeNanos())
                        if (presentPosted) {
                            presentCallback?.let { choreographer.postVsyncCallback(it) }
                        }
                    }
                presentCallback = callback
                presentPosted = true
                choreographer.postVsyncCallback(callback)
            } else {
                val callback =
                    Choreographer.FrameCallback { frameTimeNanos ->
                        Trace.beginSection("nt.chat.present")
                        try {
                            PresentationChatNative.presentFrame(0L, frameTimeNanos, 0L, 0L)
                        } catch (_: Throwable) {
                        } finally {
                            Trace.endSection()
                        }
                        syncChatOverlay()
                        adapter.markCompositorPresented(SystemClock.uptimeNanos())
                        if (presentPosted) {
                            presentFrameCallback?.let { choreographer.postFrameCallback(it) }
                        }
                    }
                presentFrameCallback = callback
                presentPosted = true
                choreographer.postFrameCallback(callback)
            }
        }
    }

    private fun stopPresentLoop() {
        presentPosted = false
        val vsync = presentCallback
        val frame = presentFrameCallback
        presentCallback = null
        presentFrameCallback = null
        compositorHandler?.post {
            val choreographer = Choreographer.getInstance()
            if (vsync != null && Build.VERSION.SDK_INT >= 33) {
                choreographer.removeVsyncCallback(vsync)
            }
            if (frame != null) {
                choreographer.removeFrameCallback(frame)
            }
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
                compositorHandler?.post {
                    try {
                        Log.i(TAG, PresentationChatNative.rebuildScene())
                    } catch (_: Throwable) {
                    }
                }
                runOnUiThread {
                    if (streamBeginLogged) {
                        announceStream("stream_end")
                    }
                    bindSnapshot(snap, view)
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
            compositorHandler?.post {
                try {
                    PresentationChatNative.rebuildScene()
                } catch (_: Throwable) {
                }
            }
            runOnUiThread {
                if (streamBeginLogged) {
                    announceStream("stream_end")
                }
                if (snap.isNotEmpty()) {
                    bindSnapshot(snap, view)
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
            compositorHandler?.post {
                try {
                    PresentationChatNative.rebuildScene()
                } catch (_: Throwable) {
                }
            }
            runOnUiThread {
                prependInFlight = false
                refreshFromRoute(holder)
            }
        }
    }

    private fun refreshFromRoute(holder: KernelHolder) {
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
                compositorHandler?.post {
                    try {
                        PresentationChatNative.rebuildScene()
                    } catch (_: Throwable) {
                    }
                }
                runOnUiThread { bindSnapshot(snap, view) }
            } catch (err: Throwable) {
                Log.e(TAG, "snapshot failed", err)
            }
        }
    }

    private fun bindSnapshot(_raw: String, snap: PresentationChatSnapshot?) {
        if (snap == null) {
            Log.i(TAG, "chat_snapshot live_wire=false parse=false production_cutover=false")
            return
        }
        header.contentDescription = "Chat header, ${snap.title}, ${snap.messageCount} messages"
        lastVisibleIds = snap.visible.joinToString(",") { row -> row.id }
        if (canarySession && snap.chatId.isNotEmpty()) {
            PresentationCanaryPrefs(this).rememberChatId(snap.chatId)
        }
        Log.i(
            TAG,
            "chat_snapshot live_wire=true host=neocompositor-surfaceview messageCount=${snap.messageCount} kernelMessageCount=${snap.kernelMessageCount} pageLen=${snap.pageLen} visible=${snap.visible.size} sceneEpoch=${snap.sceneEpoch} sendAccepted=${snap.sendAccepted} streaming=${snap.streaming} error=${snap.error ?: "none"} production_cutover=false",
        )
    }

    private fun bindViewportActions() {
        ViewCompat.setAccessibilityDelegate(
            messages,
            object : AccessibilityDelegateCompat() {
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
                        AccessibilityNodeInfo.ACTION_SCROLL_FORWARD,
                        AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD,
                        -> {
                            journeyLog?.talkback("action=SCROLL node=messages nodeId=${host.id}")
                            if (action == AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD) {
                                prependOlder()
                            }
                            return true
                        }
                        AccessibilityNodeInfo.ACTION_CLICK -> {
                            journeyLog?.talkback("action=CLICK node=messages nodeId=${host.id}")
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
                            journeyLog?.talkback(
                                "event=TYPE_VIEW_ACCESSIBILITY_FOCUSED node=$nodeName nodeId=${host.id} recycle_jump=false visible_ids=$lastVisibleIds",
                            )
                        }
                        AccessibilityEvent.TYPE_VIEW_CLICKED -> {
                            journeyLog?.talkback("event=TYPE_VIEW_CLICKED node=$nodeName nodeId=${host.id}")
                        }
                    }
                    super.sendAccessibilityEventUnchecked(host, event)
                }
            },
        )
    }

    private fun announceStream(kind: String) {
        if (kind == "stream_begin") {
            messages.announceForAccessibility("Streaming")
        } else {
            messages.announceForAccessibility("Streaming ended")
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
        Log.i(
            TAG,
            "presentation_renderer=RUST reason=$reason webview_fallback=false rust_host_allowed=true",
        )
        if (canarySession) {
            PresentationCanaryPrefs(this).armKillSwitch()
        }
        return false
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

    private fun syncChatOverlay() {
        val visible = try {
            PresentationChatNative.isChatRouteVisible()
        } catch (_: Throwable) {
            false
        }
        runOnUiThread { setChatOverlayAttached(PresentationChatOverlay.attachNativeChrome(visible)) }
    }

    private fun setChatOverlayAttached(attached: Boolean) {
        if (!::root.isInitialized || !::header.isInitialized) {
            return
        }
        if (attached == chatOverlayAttached) {
            return
        }
        if (attached) {
            attachChatOverlay()
        } else {
            destroyChatOverlay()
        }
    }

    private fun attachChatOverlay() {
        if (header.parent != null) {
            chatOverlayAttached = true
            return
        }
        header.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        messages.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        composer.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        send.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        composer.hint = "Message"
        send.text = "Send"
        root.addView(
            header,
            FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, 96, Gravity.TOP),
        )
        root.addView(
            messages,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )
        val composerParams = FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.WRAP_CONTENT,
            Gravity.BOTTOM,
        )
        composerParams.rightMargin = 160
        root.addView(composer, composerParams)
        root.addView(
            send,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM or Gravity.END,
            ),
        )
        chatOverlayAttached = true
    }

    private fun destroyChatOverlay() {
        if (header.parent != null) {
            root.removeView(header)
        }
        if (messages.parent != null) {
            root.removeView(messages)
        }
        if (composer.parent != null) {
            root.removeView(composer)
        }
        if (send.parent != null) {
            root.removeView(send)
        }
        header.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        messages.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        composer.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        send.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        composer.hint = null
        send.text = ""
        chatOverlayAttached = false
    }

    companion object {
        const val TAG: String = "NeoTavern"
        const val STATE_COMPOSER: String = "presentation_chat_composer"
        @Volatile
        private var currentRef: WeakReference<PresentationChatActivity>? = null

        fun current(): PresentationChatActivity? = currentRef?.get()
    }
}
