package com.neotavern.mobile

/**
 * JNI surface for the live Product Wire chat route.
 * Loads [libneotavern_presentation_chat.so] — not production kernel JNI.
 */
object PresentationChatNative {
    init {
        System.loadLibrary("neotavern_presentation_chat")
    }

    @JvmStatic
    external fun openRoute(
        flag: String,
        chatId: String,
        profile: String,
        wire: PresentationChatWire,
    ): String

    @JvmStatic
    external fun snapshot(): String

    @JvmStatic
    external fun saveDraft(text: String): String

    @JvmStatic
    external fun send(text: String): String

    @JvmStatic
    external fun retry(): String

    @JvmStatic
    external fun prepend(): String

    @JvmStatic
    external fun pollStream(timeoutMs: Int): String

    @JvmStatic
    external fun discardDraft(): String

    @JvmStatic
    external fun commitDraft(): String

    @JvmStatic
    external fun cancelGeneration(): String
}
