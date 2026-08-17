//! Debug-only JNI entries for the M0-D2 producer-path probe.
//!
//! Loaded as `libneotavern_presentation_m0_d2.so` by `M0D2Activity`.
//! Not part of the production kernel JNI library.

use std::panic::{catch_unwind, AssertUnwindSafe};

use jni::objects::{JClass, JString};
use jni::sys::{jint, jstring};
use jni::JNIEnv;

use crate::run_dynamic_d2_with_capture;

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_M0D2Probe_runDynamic(
    env: JNIEnv,
    _class: JClass,
    frames: jint,
    capture_frame: jint,
) -> jstring {
    let text = catch_unwind(AssertUnwindSafe(|| {
        let frames = u64::try_from(frames.max(1)).unwrap_or(1).min(1000);
        let capture = capture_frame >= 0;
        match run_dynamic_d2_with_capture(frames, capture) {
            Ok(report) => report.to_d2_log_line(),
            Err(err) => format!(
                "m0-d2 gpu_ran=false ran_on_android=true capture=false verdict=BLOCKED reason=init_failed:{err}"
            ),
        }
    }))
    .unwrap_or_else(|_| {
        "m0-d2 gpu_ran=false ran_on_android=true capture=false verdict=BLOCKED reason=panic"
            .to_string()
    });
    match env.new_string(&text) {
        Ok(s) => JString::into_raw(s),
        Err(_) => std::ptr::null_mut(),
    }
}
