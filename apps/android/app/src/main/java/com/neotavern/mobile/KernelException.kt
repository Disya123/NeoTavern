package com.neotavern.mobile

/**
 * Thrown by the native `neotavern_android_jni` boundary when a kernel
 * operation fails at the ABI level.
 *
 * [code] is the stable native status code (`NT_ERR_*` from the mobile-ffi C
 * ABI: 1 invalid arg, 2 contract, 3 not found, 4 storage, 5 cancelled,
 * 6 internal, 7 buffer, 8 mismatch); [message] is a human-readable
 * description produced by the native layer.
 *
 * Product-level failures never come here: they arrive as `kind:"error"`
 * response envelopes and are forwarded to the caller as data, mirroring the
 * RemoteBackend split between product and transport errors.
 */
class KernelException(val code: Int, message: String) : Exception(message)
