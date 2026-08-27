//! Live Product Wire chat workspace (Milestone C).
//!
//! Presentation consumes Product Wire only. Not production JNI. Not
//! `MainActivity` cutover. `PresentationChatActivity` is a harness around
//! this same route.

mod avatar;
mod compositor;
mod error;
mod fake_wire;
mod macros;
mod seed;
mod session;
mod shell_hit;
mod wire;

#[cfg(all(feature = "android-jni", target_os = "android"))]
mod android_jni;
#[cfg(all(feature = "android-jni", feature = "gpu", target_os = "android"))]
mod android_surface;
/// GPU avatar overlay, now shared by the Android host and the cross-platform
/// `PresentSurface` host (`desktop-host`). Compiled whenever `gpu` is on;
/// only Android feeds it at build time.
#[cfg(feature = "gpu")]
#[cfg_attr(
    not(all(feature = "android-jni", target_os = "android")),
    allow(dead_code)
)]
mod avatar_gpu;
#[cfg(feature = "gpu")]
#[cfg_attr(
    not(all(feature = "android-jni", target_os = "android")),
    allow(dead_code)
)]
mod vello_diag;
#[cfg(feature = "gpu")]
#[cfg_attr(
    not(all(feature = "android-jni", target_os = "android")),
    allow(dead_code)
)]
mod vello_gpu;

use neotavern_presentation_dioxus_shell::{dioxus_shell_from_flag, DioxusShellHost};

pub use avatar::{
    display_avatar_data_uri, display_avatar_from_bytes, premultiplied_cover_thumbnail,
    thumbnail_from_bytes, wallpaper_cover_thumbnail, AvatarThumb, AVATAR_DISPLAY_MAX_PX,
    AVATAR_DISPLAY_URI_MAX_CHARS, THUMBNAIL_INPUT_MAX_BYTES, WALLPAPER_ASSET_ID,
    WALLPAPER_DISPLAY_MAX_PX,
};
pub use compositor::ChatCompositor;
pub use error::ChatRouteError;
pub mod hit_rects;
pub use fake_wire::{
    FakeWire, DEMO_AVATAR_ASSET_ID, DEMO_CHARACTER_ID, DEMO_CHAT_ID, DEMO_LOREBOOK_ID,
};
pub use hit_rects::{HitRect, HitRects, MessageActionKind, QuickIntent, TapIntent, TOUCH_SLOP_CSS};
pub use seed::{
    ensure_isolated_10k_workspace, is_isolated_10k_profile, isolated_message_content,
    seed_trace_line, IsolatedSeedReport, ISOLATED_10K_COUNT, ISOLATED_10K_PROFILE,
    ISOLATED_10K_TITLE,
};
pub use session::{ChatRouteState, ChatSession, LastExport};
pub use shell_hit::{
    chat_origin_x, hit_test, is_compact, next_gallery_columns, next_gallery_sort, next_sort,
    panel_css_width, sidebar_occupied_css, ShellAction, ShellHit, PANEL_WIDTH_DEFAULT,
    PANEL_WIDTH_MAX, PANEL_WIDTH_MIN, RAIL_PANELS, RAIL_WIDTH, SORTS, TABS,
};
#[cfg(feature = "gpu")]
#[doc(hidden)]
pub use vello_gpu::peek_texture_rgba;
#[cfg(feature = "gpu")]
pub use vello_gpu::PresentSurface;
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
