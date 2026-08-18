//! Debug-only JNI for `libneotavern_presentation_perf_probe.so`.

use std::panic::{catch_unwind, AssertUnwindSafe};

use jni::objects::{JClass, JObject, JString};
use jni::sys::{jfloat, jint, jlong, jstring};
use jni::JNIEnv;

use crate::i2p;
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

fn to_jstring(env: &mut JNIEnv, text: String) -> jstring {
    match env.new_string(&text) {
        Ok(s) => JString::into_raw(s),
        Err(_) => std::ptr::null_mut(),
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
    to_jstring(&mut env, text)
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_PresentationI2pProbe_attachSurface(
    mut env: JNIEnv,
    _class: JClass,
    surface: JObject,
    width: jint,
    height: jint,
) -> jstring {
    let text = catch_unwind(AssertUnwindSafe(|| {
        i2p::attach(&env, &surface, width, height)
    }))
    .unwrap_or_else(|_| "i2p attach failed reason=panic".into());
    to_jstring(&mut env, text)
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_PresentationI2pProbe_detachSurface(
    mut env: JNIEnv,
    _class: JClass,
) -> jstring {
    let text = catch_unwind(AssertUnwindSafe(i2p::detach))
        .unwrap_or_else(|_| "i2p detach failed reason=panic".into());
    to_jstring(&mut env, text)
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_PresentationI2pProbe_tryPush(
    _env: JNIEnv,
    _class: JClass,
    pointer: jint,
    kind: jint,
    x: jfloat,
    y: jfloat,
    time_nanos: jlong,
) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        i2p::try_push(pointer, kind, x, y, time_nanos);
    }));
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_PresentationI2pProbe_loseFocus(
    _env: JNIEnv,
    _class: JClass,
    time_nanos: jlong,
) {
    let _ = catch_unwind(AssertUnwindSafe(|| i2p::lose_focus(time_nanos)));
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_PresentationI2pProbe_presentFrame(
    mut env: JNIEnv,
    _class: JClass,
    vsync_id: jlong,
    callback_time: jlong,
    deadline: jlong,
    expected_present: jlong,
) -> jstring {
    let text = catch_unwind(AssertUnwindSafe(|| {
        i2p::present_frame(vsync_id, callback_time, deadline, expected_present)
    }))
    .unwrap_or_else(|_| "i2p present failed reason=panic".into());
    to_jstring(&mut env, text)
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_PresentationChatProbe_startRoute(
    mut env: JNIEnv,
    _class: JClass,
    flag: JString,
) -> jstring {
    let value = env
        .get_string(&flag)
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let text = catch_unwind(AssertUnwindSafe(|| crate::start_chat_route(Some(&value))))
        .unwrap_or_else(|_| {
            "chat_route=false dioxus_shell=false reason=panic main_activity=false production_jni=false production_cutover=false"
                .to_string()
        });
    to_jstring(&mut env, text)
}
