package com.neotavern.mobile

/**
 * JNI surface bound to the `neotavern_android_jni` native library
 * (`libneotavern_android_jni.so`, built by scripts/build-libs.sh into
 * `app/src/main/jniLibs/<abi>/`).
 *
 * The frozen Phase 5 JNI contract fixes the binding class to
 * `com.neotavern.mobile.KernelBridge` with the static native methods below
 * (JNI symbol names `Java_com_neotavern_mobile_KernelBridge_<name>`). The
 * `@JvmStatic` annotations put the native declarations on `KernelBridge`
 * itself (not the `Companion` class), which is what the native symbols bind
 * to; `System.loadLibrary` runs once when the class is first referenced.
 *
 * Signature table (frozen):
 *  - `nativeHandshake(): String` — handshake JSON
 *    `{ffiAbiVersion, schemaHash, wireProtocol:{major,minor}, appVersion}`
 *  - `nativeOpen(dataRoot: String): Long` — kernel handle; `0` = failure,
 *    native throws [KernelException]
 *  - `nativeClose(kernel: Long)`
 *  - `nativeCall(kernel: Long, request: ByteArray): ByteArray` — response
 *    envelope, byte-identical to the tauri-local adapter's
 *  - `nativeStreamStart(kernel: Long, request: ByteArray): Long` — stream
 *    handle
 *  - `nativeStreamWait(stream: Long, timeoutMs: Int): ByteArray?` — stream
 *    callback payload (`{kind:"event"|"terminal",...}`) or `null` on timeout
 *  - `nativeStreamCancel(kernel: Long, stream: Long)`
 *  - `nativeStreamFree(stream: Long)`
 */
class KernelBridge private constructor() {
    companion object {
        init {
            System.loadLibrary("neotavern_android_jni")
        }

        @JvmStatic
        external fun nativeHandshake(): String

        @JvmStatic
        external fun nativeOpen(dataRoot: String): Long

        @JvmStatic
        external fun nativeClose(kernel: Long)

        @JvmStatic
        external fun nativeCall(kernel: Long, request: ByteArray): ByteArray

        @JvmStatic
        external fun nativeStreamStart(kernel: Long, request: ByteArray): Long

        @JvmStatic
        external fun nativeStreamWait(stream: Long, timeoutMs: Int): ByteArray?

        @JvmStatic
        external fun nativeStreamCancel(kernel: Long, stream: Long)

        @JvmStatic
        external fun nativeStreamFree(stream: Long)
    }
}

/** [NativeKernel] backed by the JNI [KernelBridge]. */
object JniNativeKernel : NativeKernel {

    override fun handshake(): String = KernelBridge.nativeHandshake()

    override fun open(dataRoot: String): Long = KernelBridge.nativeOpen(dataRoot)

    override fun close(kernel: Long): Unit = KernelBridge.nativeClose(kernel)

    override fun call(kernel: Long, request: ByteArray): ByteArray =
        KernelBridge.nativeCall(kernel, request)

    override fun streamStart(kernel: Long, request: ByteArray): Long =
        KernelBridge.nativeStreamStart(kernel, request)

    override fun streamWait(stream: Long, timeoutMs: Int): ByteArray? =
        KernelBridge.nativeStreamWait(stream, timeoutMs)

    override fun streamCancel(kernel: Long, stream: Long): Unit =
        KernelBridge.nativeStreamCancel(kernel, stream)

    override fun streamFree(stream: Long): Unit = KernelBridge.nativeStreamFree(stream)
}
