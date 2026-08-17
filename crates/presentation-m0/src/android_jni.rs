//! Debug-only JNI entries for M0-D1a / M0-D1b probes.
//!
//! Loaded as `libneotavern_presentation_m0.so` by `M0D1aActivity` /
//! `M0D1bActivity`. Not part of the production kernel JNI library.

use std::panic::{catch_unwind, AssertUnwindSafe};

use jni::objects::{JClass, JString};
use jni::sys::{jint, jstring};
use jni::JNIEnv;

use crate::gpu::{run_dynamic_d1b_with_capture, run_static_d1a};

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_M0D1aProbe_runStatic(
    env: JNIEnv,
    _class: JClass,
    frames: jint,
) -> jstring {
    let text = catch_unwind(AssertUnwindSafe(|| {
        let frames = u64::try_from(frames.max(1)).unwrap_or(1).min(1000);
        match run_static_d1a(frames) {
            Ok(report) => report.to_log_line(),
            Err(err) => format!(
                "m0-d1a gpu_ran=false ran_on_android=true capture=false verdict=BLOCKED reason=init_failed:{err}"
            ),
        }
    }))
    .unwrap_or_else(|_| {
        "m0-d1a gpu_ran=false ran_on_android=true capture=false verdict=BLOCKED reason=panic"
            .to_string()
    });
    match env.new_string(&text) {
        Ok(s) => JString::into_raw(s),
        Err(_) => std::ptr::null_mut(),
    }
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_M0D1bProbe_runDynamic(
    env: JNIEnv,
    _class: JClass,
    frames: jint,
    capture_frame: jint,
) -> jstring {
    let text = catch_unwind(AssertUnwindSafe(|| {
        let frames = u64::try_from(frames.max(1)).unwrap_or(1).min(1000);
        let capture = capture_frame >= 0;
        match run_dynamic_d1b_with_capture(frames, capture) {
            Ok(report) => report.to_d1b_log_line(),
            Err(err) => format!(
                "m0-d1b gpu_ran=false ran_on_android=true capture=false verdict=BLOCKED reason=init_failed:{err}"
            ),
        }
    }))
    .unwrap_or_else(|_| {
        "m0-d1b gpu_ran=false ran_on_android=true capture=false verdict=BLOCKED reason=panic"
            .to_string()
    });
    match env.new_string(&text) {
        Ok(s) => JString::into_raw(s),
        Err(_) => std::ptr::null_mut(),
    }
}
