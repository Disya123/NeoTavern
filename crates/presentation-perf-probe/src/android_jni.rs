//! Debug-only JNI for `libneotavern_presentation_perf_probe.so`.

use std::panic::{catch_unwind, AssertUnwindSafe};

use jni::objects::{JClass, JString};
use jni::sys::jstring;
use jni::JNIEnv;

use crate::{run_scenario, Scenario};

fn run(scenario: &str, frames: i32, capture_frame: i32) -> String {
    let Some(parsed) = Scenario::parse(scenario) else {
        return format!(
            "perf gpu_ran=false ran_on_android=true capture=false verdict=BLOCKED reason=unknown_scenario:{scenario}"
        );
    };
    match run_scenario(parsed, frames.max(1) as u64, capture_frame) {
        Ok(line) => line,
        Err(err) => format!(
            "{} gpu_ran=false ran_on_android=true capture=false verdict=BLOCKED reason={}",
            parsed.as_str(),
            err.replace(' ', "_")
        ),
    }
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_PresentationPerfProbe_runScenario(
    mut env: JNIEnv,
    _class: JClass,
    scenario: JString,
    frames: jni::sys::jint,
    capture_frame: jni::sys::jint,
) -> jstring {
    let name = env
        .get_string(&scenario)
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "unknown".into());
    let text =
        catch_unwind(AssertUnwindSafe(|| run(&name, frames, capture_frame))).unwrap_or_else(|_| {
            "perf gpu_ran=false ran_on_android=true capture=false verdict=BLOCKED reason=panic"
                .to_string()
        });
    match env.new_string(&text) {
        Ok(s) => JString::into_raw(s),
        Err(_) => std::ptr::null_mut(),
    }
}
