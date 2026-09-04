//! Debug JNI for `libneotavern_presentation_chat.so`.
//!
//! Kotlin `PresentationChatWire` holds KernelSession + EnvelopeBuilder.
//! This crate never links `runtime-kernel`.

use std::collections::{HashMap, VecDeque};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Mutex;

use contracts_generated::generated::{
    decode_event_envelope, decode_generation_event, decode_response_envelope, EventEnvelope,
    GenerationEvent, ResponseEnvelope,
};
use jni::objects::{GlobalRef, JByteArray, JClass, JObject, JString, JValue};
use jni::sys::{jboolean, jfloat, jint, jlong, jstring};
use jni::{JNIEnv, JavaVM};
use serde_json::{json, Value};

use crate::error::ChatRouteError;
use crate::session::ChatSession;
use crate::wire::{ProductWire, StreamFrame, WireCall};
use crate::{blocked_line, start_flagged_session, LiveChatReport};

struct JniProductWire {
    vm: JavaVM,
    host: GlobalRef,
    native_handles: HashMap<String, i64>,
    pending: HashMap<String, VecDeque<StreamFrame>>,
}

impl JniProductWire {
    fn with_env<T>(
        &self,
        f: impl FnOnce(&mut JNIEnv<'_>) -> Result<T, ChatRouteError>,
    ) -> Result<T, ChatRouteError> {
        let mut env = self
            .vm
            .attach_current_thread()
            .map_err(|err| ChatRouteError::Transport(format!("{err:?}")))?;
        f(&mut env)
    }

    fn check_exception(env: &mut JNIEnv<'_>) -> Result<(), ChatRouteError> {
        match env.exception_check() {
            Ok(true) => {
                let _ = env.exception_describe();
                let _ = env.exception_clear();
                Err(ChatRouteError::Transport("jni exception".into()))
            }
            Ok(false) => Ok(()),
            Err(err) => Err(ChatRouteError::Transport(format!("{err:?}"))),
        }
    }

    fn decode_call(operation_id: &str, bytes: &[u8]) -> Result<WireCall, ChatRouteError> {
        match decode_response_envelope(bytes) {
            Ok(ResponseEnvelope::Ok {
                request_id, result, ..
            }) => Ok(WireCall {
                request_id,
                operation_id: operation_id.to_string(),
                result,
            }),
            Ok(ResponseEnvelope::Error { error, .. }) => Err(ChatRouteError::Product(error)),
            Err(err) => Err(ChatRouteError::Wire(err.message)),
        }
    }

    fn parse_frame(bytes: &[u8]) -> Result<StreamFrame, ChatRouteError> {
        let value: Value = serde_json::from_slice(bytes)?;
        match value.get("kind").and_then(Value::as_str) {
            Some("terminal") => Ok(StreamFrame::Terminal),
            Some("error") => {
                if let Some(error) = value.get("error") {
                    if let Ok(ResponseEnvelope::Error { error, .. }) =
                        decode_response_envelope(&serde_json::to_vec(error)?)
                    {
                        return Ok(StreamFrame::Error(error));
                    }
                    if let Ok(dto) = serde_json::from_value::<
                        contracts_generated::generated::ErrorDto,
                    >(error.clone())
                    {
                        return Ok(StreamFrame::Error(dto));
                    }
                }
                Err(ChatRouteError::Transport("malformed stream error".into()))
            }
            Some("event") => {
                let event = value
                    .get("event")
                    .ok_or_else(|| ChatRouteError::Transport("missing event".into()))?;
                let envelope = decode_event_envelope(&serde_json::to_vec(event)?)
                    .map_err(|err| ChatRouteError::Wire(err.message))?;
                Ok(StreamFrame::Event {
                    sequence: Some(envelope.sequence),
                    event: Box::new(generation_from_envelope(&envelope)?),
                })
            }
            _ => Err(ChatRouteError::Transport("unknown stream frame".into())),
        }
    }

    fn wait_native(
        &self,
        env: &mut JNIEnv<'_>,
        handle: i64,
        timeout_ms: u32,
    ) -> Result<Option<Vec<u8>>, ChatRouteError> {
        let result = env
            .call_method(
                self.host.as_obj(),
                "waitEvent",
                "(JI)[B",
                &[JValue::Long(handle), JValue::Int(timeout_ms as i32)],
            )
            .map_err(|err| ChatRouteError::Transport(format!("{err:?}")))?;
        Self::check_exception(env)?;
        let obj = result
            .l()
            .map_err(|err| ChatRouteError::Transport(format!("{err:?}")))?;
        if obj.is_null() {
            return Ok(None);
        }
        let array = JByteArray::from(obj);
        env.convert_byte_array(&array)
            .map(Some)
            .map_err(|err| ChatRouteError::Transport(format!("{err:?}")))
    }
}

impl ProductWire for JniProductWire {
    fn call(&mut self, operation_id: &str, payload: Value) -> Result<WireCall, ChatRouteError> {
        let payload_json = serde_json::to_string(&payload)?;
        let bytes = self.with_env(|env| {
            let j_op = env
                .new_string(operation_id)
                .map_err(|err| ChatRouteError::Transport(format!("{err:?}")))?;
            let j_payload = env
                .new_string(&payload_json)
                .map_err(|err| ChatRouteError::Transport(format!("{err:?}")))?;
            let result = env
                .call_method(
                    self.host.as_obj(),
                    "call",
                    "(Ljava/lang/String;Ljava/lang/String;)[B",
                    &[JValue::Object(&j_op), JValue::Object(&j_payload)],
                )
                .map_err(|err| ChatRouteError::Transport(format!("{err:?}")))?;
            Self::check_exception(env)?;
            let obj = result
                .l()
                .map_err(|err| ChatRouteError::Transport(format!("{err:?}")))?;
            let array = JByteArray::from(obj);
            env.convert_byte_array(&array)
                .map_err(|err| ChatRouteError::Transport(format!("{err:?}")))
        })?;
        Self::decode_call(operation_id, &bytes)
    }

    fn start_stream(
        &mut self,
        operation_id: &str,
        payload: Value,
    ) -> Result<String, ChatRouteError> {
        let payload_json = serde_json::to_string(&payload)?;
        let native = self.with_env(|env| {
            let j_op = env
                .new_string(operation_id)
                .map_err(|err| ChatRouteError::Transport(format!("{err:?}")))?;
            let j_payload = env
                .new_string(&payload_json)
                .map_err(|err| ChatRouteError::Transport(format!("{err:?}")))?;
            let result = env
                .call_method(
                    self.host.as_obj(),
                    "startStream",
                    "(Ljava/lang/String;Ljava/lang/String;)J",
                    &[JValue::Object(&j_op), JValue::Object(&j_payload)],
                )
                .map_err(|err| ChatRouteError::Transport(format!("{err:?}")))?;
            Self::check_exception(env)?;
            result
                .j()
                .map_err(|err| ChatRouteError::Transport(format!("{err:?}")))
        })?;
        if native == 0 {
            return Err(ChatRouteError::Transport("stream start returned 0".into()));
        }
        for _ in 0..32 {
            let bytes = self.with_env(|env| self.wait_native(env, native, 50))?;
            let Some(bytes) = bytes else {
                continue;
            };
            let frame = Self::parse_frame(&bytes)?;
            match &frame {
                StreamFrame::Error(error) => {
                    return Err(ChatRouteError::Product(error.clone()));
                }
                StreamFrame::Event { .. } | StreamFrame::Terminal => {
                    let key = stream_key_from_frame(&bytes).unwrap_or_else(|| format!("s{native}"));
                    self.native_handles.insert(key.clone(), native);
                    self.pending
                        .entry(key.clone())
                        .or_default()
                        .push_back(frame);
                    return Ok(key);
                }
                StreamFrame::Timeout => {}
            }
        }
        let key = format!("s{native}");
        self.native_handles.insert(key.clone(), native);
        Ok(key)
    }

    fn poll_stream(
        &mut self,
        handle: &str,
        timeout_ms: u32,
    ) -> Result<StreamFrame, ChatRouteError> {
        if let Some(pending) = self.pending.get_mut(handle) {
            if let Some(frame) = pending.pop_front() {
                return Ok(frame);
            }
        }
        let Some(&native) = self.native_handles.get(handle) else {
            return Ok(StreamFrame::Timeout);
        };
        let bytes = self.with_env(|env| self.wait_native(env, native, timeout_ms))?;
        match bytes {
            None => Ok(StreamFrame::Timeout),
            Some(bytes) => Self::parse_frame(&bytes),
        }
    }

    fn cancel_stream(&mut self, handle: &str) -> Result<(), ChatRouteError> {
        let Some(&native) = self.native_handles.get(handle) else {
            return Ok(());
        };
        self.with_env(|env| {
            env.call_method(
                self.host.as_obj(),
                "cancelStream",
                "(J)V",
                &[JValue::Long(native)],
            )
            .map_err(|err| ChatRouteError::Transport(format!("{err:?}")))?;
            Self::check_exception(env)
        })
    }
}

fn generation_from_envelope(envelope: &EventEnvelope) -> Result<GenerationEvent, ChatRouteError> {
    let bytes = serde_json::to_vec(&envelope.payload)?;
    if let Ok(event) = decode_generation_event(&bytes) {
        return Ok(event);
    }
    let mut merged = envelope.payload.clone();
    if let Value::Object(map) = &mut merged {
        map.insert("type".into(), json!(envelope.r#type));
    }
    decode_generation_event(&serde_json::to_vec(&merged)?)
        .map_err(|err| ChatRouteError::Wire(err.message))
}

fn stream_key_from_frame(bytes: &[u8]) -> Option<String> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    value
        .get("event")?
        .get("streamId")?
        .as_str()
        .map(str::to_string)
}

static ROUTE: Mutex<Option<ChatSession<JniProductWire>>> = Mutex::new(None);

fn to_jstring(env: &mut JNIEnv, text: String) -> jstring {
    match env.new_string(&text) {
        Ok(s) => JString::into_raw(s),
        Err(_) => std::ptr::null_mut(),
    }
}

fn read_string(env: &mut JNIEnv, value: &JString) -> String {
    env.get_string(value)
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn with_route<F>(f: F) -> String
where
    F: FnOnce(&mut ChatSession<JniProductWire>) -> Result<String, ChatRouteError>,
{
    match ROUTE.lock() {
        Ok(mut guard) => match guard.as_mut() {
            Some(session) => f(session).unwrap_or_else(|err| blocked_line(&err)),
            None => blocked_line(&ChatRouteError::Transport("route_not_open".into())),
        },
        Err(_) => blocked_line(&ChatRouteError::Transport("route_poisoned".into())),
    }
}

fn session_line(session: &ChatSession<JniProductWire>) -> String {
    let vdom_edits = session.mount_vdom();
    LiveChatReport {
        dioxus_shell: true,
        live_wire: true,
        chat_workspace: true,
        header: true,
        viewport: true,
        composer: true,
        wire_messages: session.kernel_message_count(),
        issued_commands: session.issued_commands().len(),
        vdom_edits,
        error_code: session
            .state()
            .last_error
            .as_ref()
            .map(|err| err.code.clone()),
    }
    .line()
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_PresentationChatNative_openRoute(
    mut env: JNIEnv,
    _class: JClass,
    flag: JString,
    chat_id: JString,
    profile: JString,
    host: JObject,
) -> jstring {
    let flag_value = read_string(&mut env, &flag);
    let chat_value = read_string(&mut env, &chat_id);
    let profile_value = read_string(&mut env, &profile);
    let text = catch_unwind(AssertUnwindSafe(|| {
        let vm = env
            .get_java_vm()
            .map_err(|err| ChatRouteError::Transport(format!("{err:?}")))?;
        let host = env
            .new_global_ref(&host)
            .map_err(|err| ChatRouteError::Transport(format!("{err:?}")))?;
        let wire = JniProductWire {
            vm,
            host,
            native_handles: HashMap::new(),
            pending: HashMap::new(),
        };
        let preferred = if chat_value.is_empty() {
            None
        } else {
            Some(chat_value.as_str())
        };
        let profile = if profile_value.is_empty() {
            None
        } else {
            Some(profile_value.as_str())
        };
        let (session, report) = start_flagged_session(Some(&flag_value), wire, preferred, profile)?;
        let line = report.line();
        *ROUTE
            .lock()
            .map_err(|_| ChatRouteError::Transport("route_poisoned".into()))? = Some(session);
        #[cfg(feature = "gpu")]
        crate::android_surface::mark_dirty();
        Ok::<String, ChatRouteError>(line)
    }))
    .unwrap_or_else(|_| Err(ChatRouteError::Transport("panic".into())))
    .unwrap_or_else(|err| blocked_line(&err));
    to_jstring(&mut env, text)
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_PresentationChatNative_snapshot(
    mut env: JNIEnv,
    _class: JClass,
) -> jstring {
    let text = with_route(|session| Ok(session.snapshot_json()));
    to_jstring(&mut env, text)
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_PresentationChatNative_saveDraft(
    mut env: JNIEnv,
    _class: JClass,
    text: JString,
) -> jstring {
    let value = read_string(&mut env, &text);
    let line = with_route(|session| {
        session.set_composer_text(value)?;
        Ok(session_line(session))
    });
    to_jstring(&mut env, line)
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_PresentationChatNative_send(
    mut env: JNIEnv,
    _class: JClass,
    text: JString,
) -> jstring {
    let value = read_string(&mut env, &text);
    let line = with_route(|session| {
        session.send(Some(&value))?;
        #[cfg(feature = "gpu")]
        {
            crate::android_surface::mark_dirty();
            let _ = crate::android_surface::bind_from_session(session);
        }
        Ok(session.send_trace_line())
    });
    to_jstring(&mut env, line)
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_PresentationChatNative_retry(
    mut env: JNIEnv,
    _class: JClass,
) -> jstring {
    let line = with_route(|session| {
        session.retry()?;
        Ok(session_line(session))
    });
    to_jstring(&mut env, line)
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_PresentationChatNative_prepend(
    mut env: JNIEnv,
    _class: JClass,
) -> jstring {
    let line = with_route(|session| {
        session.prepend()?;
        #[cfg(feature = "gpu")]
        crate::android_surface::mark_dirty();
        Ok(session_line(session))
    });
    to_jstring(&mut env, line)
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_PresentationChatNative_pollStream(
    mut env: JNIEnv,
    _class: JClass,
    timeout_ms: jint,
) -> jstring {
    let line = with_route(|session| {
        match session.poll_stream(timeout_ms.max(0) as u32)? {
            crate::wire::StreamFrame::Timeout => {}
            _ => {
                #[cfg(feature = "gpu")]
                crate::android_surface::mark_dirty();
            }
        }
        Ok(session_line(session))
    });
    to_jstring(&mut env, line)
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_PresentationChatNative_discardDraft(
    mut env: JNIEnv,
    _class: JClass,
) -> jstring {
    let line = with_route(|session| {
        session.discard_draft()?;
        Ok(session_line(session))
    });
    to_jstring(&mut env, line)
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_PresentationChatNative_cancelGeneration(
    mut env: JNIEnv,
    _class: JClass,
) -> jstring {
    let line = with_route(|session| {
        session.cancel_generation()?;
        Ok(session_line(session))
    });
    to_jstring(&mut env, line)
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_PresentationChatNative_commitDraft(
    mut env: JNIEnv,
    _class: JClass,
) -> jstring {
    let line = with_route(|session| {
        session.commit_draft()?;
        Ok(session_line(session))
    });
    to_jstring(&mut env, line)
}

fn gpu_bind_line() -> String {
    #[cfg(feature = "gpu")]
    {
        crate::android_surface::mark_dirty();
        return with_route(|session| Ok(crate::android_surface::bind_from_session(session)));
    }
    #[cfg(not(feature = "gpu"))]
    "host=neocompositor-surfaceview bind_failed reason=gpu_disabled".into()
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_PresentationChatNative_attachSurface(
    env: JNIEnv,
    _class: JClass,
    surface: JObject,
    width: jint,
    height: jint,
    density: jfloat,
) -> jstring {
    let mut env = env;
    #[cfg(feature = "gpu")]
    let text = {
        let attach = crate::android_surface::attach(&env, &surface, width, height, density);
        let bound = gpu_bind_line();
        if bound.contains("product_wire=live") {
            bound
        } else {
            attach
        }
    };
    #[cfg(not(feature = "gpu"))]
    let text = "host=neocompositor-surfaceview attach_failed reason=gpu_disabled".to_string();
    to_jstring(&mut env, text)
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_PresentationChatNative_setSafeArea(
    env: JNIEnv,
    _class: JClass,
    top: jfloat,
    right: jfloat,
    bottom: jfloat,
    left: jfloat,
) -> jstring {
    let mut env = env;
    #[cfg(feature = "gpu")]
    {
        crate::android_surface::set_safe_area(top, right, bottom, left);
        return to_jstring(&mut env, gpu_bind_line());
    }
    #[cfg(not(feature = "gpu"))]
    to_jstring(
        &mut env,
        "host=neocompositor-surfaceview bind_failed reason=gpu_disabled".into(),
    )
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_PresentationChatNative_detachSurface(
    mut env: JNIEnv,
    _class: JClass,
) -> jstring {
    #[cfg(feature = "gpu")]
    let text = crate::android_surface::detach();
    #[cfg(not(feature = "gpu"))]
    let text = "host=neocompositor-surfaceview detach=ok".to_string();
    to_jstring(&mut env, text)
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_PresentationChatNative_presentFrame(
    mut env: JNIEnv,
    _class: JClass,
    vsync_id: jlong,
    callback_time: jlong,
    deadline: jlong,
    expected_present: jlong,
) -> jstring {
    #[cfg(feature = "gpu")]
    let text = {
        let pending = crate::android_surface::take_shell_action();
        let tap_intent = crate::android_surface::take_host_intent();
        if pending.is_some()
            || tap_intent.is_some()
            || (crate::android_surface::is_dirty() && !crate::android_surface::is_scrolling())
        {
            let _ = with_route(|session| {
                if let Some(action) = pending {
                    session.apply_shell_action(action);
                }
                // Layout-resolved taps вЂ” the same intents the desktop host
                // dispatches in `pointer_up` (hit_rects decision table).
                if let Some(intent) = tap_intent {
                    match intent {
                        crate::hit_rects::TapIntent::Quick(quick) => match quick {
                            crate::hit_rects::QuickIntent::Send => {
                                if let Err(err) = session.send(None) {
                                    eprintln!("[jni] composer send error: {err}");
                                }
                            }
                            crate::hit_rects::QuickIntent::ComposerSettings => session
                                .apply_shell_action(crate::ShellAction::SetPanel(
                                    "settings".into(),
                                )),
                            crate::hit_rects::QuickIntent::ComposerReset => {
                                let _ = session.set_composer_text(String::new());
                            }
                            crate::hit_rects::QuickIntent::ComposerContext => {
                                session.toggle_context_panel();
                            }
                            crate::hit_rects::QuickIntent::ScrollLatest => {
                                session.scroll_chat_by(1.0e6);
                            }
                            crate::hit_rects::QuickIntent::HeaderSearch => {
                                session.toggle_header_search();
                            }
                        },
                        crate::hit_rects::TapIntent::MessageAction { kind, row_id } => {
                            use crate::hit_rects::MessageActionKind;
                            match kind {
                                MessageActionKind::Delete => session.delete_message(&row_id),
                                MessageActionKind::Rollback => session.rollback_to_message(&row_id),
                                MessageActionKind::Regenerate => {
                                    session.regenerate_message(&row_id)
                                }
                                MessageActionKind::SwipePrevious => {
                                    session.swipe_variant(&row_id, -1)
                                }
                                MessageActionKind::SwipeNext => session.swipe_variant(&row_id, 1),
                                // Platform clipboard bridge is not wired yet;
                                // skip honestly instead of faking a "copied"
                                // state.
                                MessageActionKind::Copy => {
                                    eprintln!(
                                        "[jni] copy skipped reason=clipboard_bridge_pending row={row_id}"
                                    );
                                }
                                MessageActionKind::Edit => {
                                    if session.view().details_message_id.as_deref() == Some(&row_id) {
                                        session.set_message_details_mode("edit");
                                    } else {
                                        session.start_message_edit(&row_id);
                                    }
                                }
                                MessageActionKind::EditSave => session.submit_message_edit(),
                                MessageActionKind::EditCancel => session.cancel_message_edit(),
                                MessageActionKind::History => session.open_message_history(&row_id),
                                MessageActionKind::HistoryClose => session.close_message_history(),
                                MessageActionKind::Checkpoint => {
                                    session.create_message_snapshot(&row_id, true)
                                }
                                MessageActionKind::Branch => {
                                    session.create_message_snapshot(&row_id, false)
                                }
                                MessageActionKind::Context => {
                                    session.toggle_message_context(&row_id)
                                }
                                MessageActionKind::Prompt => {
                                    session.open_prompt_plan_for_message(&row_id)
                                }
                                MessageActionKind::Steps => {
                                    session.open_run_transcript_for_message(&row_id)
                                }
                                MessageActionKind::DeleteCheckpoint => {
                                    session.open_checkpoint_delete(&row_id)
                                }
                                MessageActionKind::Details => {
                                    session.open_message_details(&row_id)
                                }
                                MessageActionKind::DetailsClose => {
                                    session.close_message_details()
                                }
                                MessageActionKind::DetailsModeActions => {
                                    session.set_message_details_mode("actions")
                                }
                                MessageActionKind::DetailsModeDetails => {
                                    session.set_message_details_mode("details")
                                }
                                MessageActionKind::DetailsModeEdit => {
                                    session.set_message_details_mode("edit")
                                }
                                MessageActionKind::DetailsSaveEdit => {
                                    session.submit_message_details_edit()
                                }
                            }
                        }
                        // Declarative custom intents: same authority-free
                        // trace default as the desktop host.
                        crate::hit_rects::TapIntent::Custom { name } => {
                            session.custom_intent(&name);
                        }
                        crate::hit_rects::TapIntent::None => {}
                    }
                }
                Ok(crate::android_surface::bind_from_session(session))
            });
        } else if crate::android_surface::is_avatar_overlay() {
            let _ = crate::android_surface::composite_avatar_overlay();
        }
        crate::android_surface::present_frame(vsync_id, callback_time, deadline, expected_present)
    };
    #[cfg(not(feature = "gpu"))]
    let text = "host=neocompositor-surfaceview present_failed reason=gpu_disabled".to_string();
    to_jstring(&mut env, text)
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_PresentationChatNative_tryPush(
    _env: JNIEnv,
    _class: JClass,
    pointer: jint,
    kind: jint,
    x: jfloat,
    y: jfloat,
    time_nanos: jlong,
) {
    #[cfg(feature = "gpu")]
    crate::android_surface::try_push(pointer, kind, x, y, time_nanos);
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_PresentationChatNative_loseFocus(
    _env: JNIEnv,
    _class: JClass,
    time_nanos: jlong,
) {
    #[cfg(feature = "gpu")]
    crate::android_surface::lose_focus(time_nanos);
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_PresentationChatNative_rebuildScene(
    mut env: JNIEnv,
    _class: JClass,
) -> jstring {
    to_jstring(&mut env, gpu_bind_line())
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_PresentationChatNative_isChatRouteVisible(
    _env: JNIEnv,
    _class: JClass,
) -> jboolean {
    #[cfg(feature = "gpu")]
    {
        return u8::from(crate::android_surface::chat_route_visible());
    }
    #[cfg(not(feature = "gpu"))]
    0
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_PresentationChatNative_scrollTelemetry(
    mut env: JNIEnv,
    _class: JClass,
) -> jstring {
    #[cfg(feature = "gpu")]
    let text = crate::android_surface::telemetry();
    #[cfg(not(feature = "gpu"))]
    let text = "composite_only_frames=0 layout_rebuilds_on_scroll=0 paint_rebuilds_on_scroll=0"
        .to_string();
    to_jstring(&mut env, text)
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_PresentationChatNative_setSoftwareRasterDebug(
    _env: JNIEnv,
    _class: JClass,
    enabled: jboolean,
) {
    #[cfg(feature = "gpu")]
    crate::vello_gpu::set_software_raster_debug(Some(enabled != 0));
    #[cfg(not(feature = "gpu"))]
    let _ = enabled;
}

#[no_mangle]
pub extern "system" fn Java_com_neotavern_mobile_PresentationChatNative_evictForPressure(
    mut env: JNIEnv,
    _class: JClass,
    bytes: jint,
) -> jstring {
    let want = bytes.max(0) as usize;
    let mut evicted_gpu = 0usize;
    let mut evicted_cpu = 0usize;
    #[cfg(feature = "gpu")]
    {
        // GPU avatar cache.
        if let Ok(mut slot) = crate::android_surface::HOST.lock() {
            if let Some(host) = slot.as_mut() {
                evicted_gpu = host.gpu.avatars.evict_for_pressure(want);
            }
        }
        // CPU avatar cache in the route session.
        if let Ok(mut route) = ROUTE.lock() {
            if let Some(session) = route.as_mut() {
                evicted_cpu = session.evict_avatars_for_pressure(want);
            }
        }
    }
    let line = format!("pressure_evict bytes={want} gpu={evicted_gpu} cpu={evicted_cpu}");
    to_jstring(&mut env, line)
}
