//! Live Product Wire chat workspace (Milestone C).
//!
//! Presentation consumes Product Wire only. Not production JNI. Not
//! `MainActivity` cutover. `PresentationChatActivity` is a harness around
//! this same route.

mod avatar;
mod compositor;
mod error;
mod fake_wire;
mod seed;
mod session;
mod shell_hit;
mod wire;

#[cfg(all(feature = "android-jni", target_os = "android"))]
mod android_jni;
#[cfg(all(feature = "android-jni", feature = "gpu", target_os = "android"))]
mod android_surface;

use neotavern_presentation_dioxus_shell::{dioxus_shell_from_flag, DioxusShellHost};

pub use avatar::{
    display_avatar_data_uri, display_avatar_from_bytes, AVATAR_DISPLAY_MAX_PX,
    AVATAR_DISPLAY_URI_MAX_CHARS,
};
pub use compositor::ChatCompositor;
pub use error::ChatRouteError;
pub use fake_wire::{FakeWire, DEMO_AVATAR_ASSET_ID, DEMO_CHARACTER_ID, DEMO_CHAT_ID};
pub use seed::{
    ensure_isolated_10k_workspace, is_isolated_10k_profile, isolated_message_content,
    seed_trace_line, IsolatedSeedReport, ISOLATED_10K_COUNT, ISOLATED_10K_PROFILE,
    ISOLATED_10K_TITLE,
};
pub use session::{ChatRouteState, ChatSession};
pub use shell_hit::{hit_test, next_sort, ShellAction, ShellHit, RAIL_PANELS, SORTS, TABS};
pub use wire::{ProductWire, StreamFrame, WireCall, PAGE_LIMIT};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveChatReport {
    pub dioxus_shell: bool,
    pub live_wire: bool,
    pub chat_workspace: bool,
    pub header: bool,
    pub viewport: bool,
    pub composer: bool,
    pub wire_messages: usize,
    pub issued_commands: usize,
    pub vdom_edits: usize,
    pub error_code: Option<String>,
}

impl LiveChatReport {
    pub fn line(&self) -> String {
        let error = self
            .error_code
            .as_deref()
            .map(|code| format!(" error={code}"))
            .unwrap_or_default();
        format!(
            "chat_route=true dioxus_shell={} live_wire={} data_component=chat-workspace header={} viewport={} composer={} wire_messages={} issued_commands={} vdom_edits={} main_activity=false production_jni=false production_cutover=false{error}",
            self.dioxus_shell,
            self.live_wire,
            self.header,
            self.viewport,
            self.composer,
            self.wire_messages,
            self.issued_commands,
            self.vdom_edits,
        )
    }
}

pub fn start_flagged_route(flag: Option<&str>) -> String {
    start_flagged_session(flag, FakeWire::demo(), None, None).map_or_else(
        |err| blocked_line(&err),
        |(session, report)| {
            let _ = session;
            report.line()
        },
    )
}

pub fn start_flagged_session<W: ProductWire>(
    flag: Option<&str>,
    mut wire: W,
    chat_id: Option<&str>,
    profile: Option<&str>,
) -> Result<(ChatSession<W>, LiveChatReport), ChatRouteError> {
    match dioxus_shell_from_flag(flag) {
        DioxusShellHost::Disabled => Err(ChatRouteError::FlagDisabled),
        DioxusShellHost::Flagged { .. } => {
            let seeded = if is_isolated_10k_profile(profile) {
                Some(ensure_isolated_10k_workspace(&mut wire)?)
            } else {
                None
            };
            let preferred = chat_id
                .filter(|id| !id.is_empty())
                .map(str::to_string)
                .or_else(|| seeded.as_ref().map(|row| row.chat_id.clone()));
            let session = ChatSession::open(wire, preferred.as_deref())?;
            let vdom_edits = session.mount_vdom();
            let report = LiveChatReport {
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
            };
            Ok((session, report))
        }
    }
}

pub fn blocked_line(err: &ChatRouteError) -> String {
    format!(
        "chat_route=false dioxus_shell=false live_wire=false reason={} main_activity=false production_jni=false production_cutover=false",
        err.reason_code()
    )
}
