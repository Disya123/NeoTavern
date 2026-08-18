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
use jni::sys::{jint, jstring};
use jni::{JNIEnv, JavaVM};
use serde_json::{json, Value};

use crate::error::ChatRouteError;
use crate::session::ChatSession;
use crate::wire::{ProductWire, StreamFrame};
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

    fn decode_result(bytes: &[u8]) -> Result<Value, ChatRouteError> {
        match decode_response_envelope(bytes) {
            Ok(ResponseEnvelope::Ok { result, .. }) => Ok(result),
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
                Ok(StreamFrame::Event(Box::new(generation_from_envelope(
                    &envelope,
                )?)))
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
    fn call(&mut self, operation_id: &str, payload: Value) -> Result<Value, ChatRouteError> {
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
        Self::decode_result(&bytes)
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
                StreamFrame::Event(_) | StreamFrame::Terminal => {
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
        wire_messages: session.state().messages.len(),
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
    host: JObject,
) -> jstring {
    let flag_value = read_string(&mut env, &flag);
    let chat_value = read_string(&mut env, &chat_id);
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
        let (session, report) = start_flagged_session(Some(&flag_value), wire, preferred)?;
        let line = report.line();
        *ROUTE
            .lock()
            .map_err(|_| ChatRouteError::Transport("route_poisoned".into()))? = Some(session);
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
        Ok(session_line(session))
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
        let _ = session.poll_stream(timeout_ms.max(0) as u32)?;
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
