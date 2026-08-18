//! Flagged Android chat workspace route (Milestone C start).
//!
//! Requires `NEOTA_DIOXUS_SHELL=1`. The sole screen is the Product Wire
//! chat workspace (header / viewport / composer). Not `MainActivity`, not
//! production JNI, not a cutover.

use crate::{
    dioxus_shell_from_flag, issue_commands, load_canonical_fixture, mount_product_chat,
    product_chat_from_fixture, DioxusShellHost, ShellError,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatRouteReport {
    pub dioxus_shell: bool,
    pub chat_workspace: bool,
    pub header: bool,
    pub viewport: bool,
    pub composer: bool,
    pub wire_messages: usize,
    pub issued_commands: usize,
    pub vdom_edits: usize,
}

impl ChatRouteReport {
    pub fn line(&self) -> String {
        format!(
            "chat_route=true dioxus_shell={} data_component=chat-workspace header={} viewport={} composer={} wire_messages={} issued_commands={} vdom_edits={} main_activity=false production_jni=false production_cutover=false",
            self.dioxus_shell,
            self.header,
            self.viewport,
            self.composer,
            self.wire_messages,
            self.issued_commands,
            self.vdom_edits,
        )
    }
}

pub fn flagged_chat_route(flag: Option<&str>) -> Result<ChatRouteReport, ShellError> {
    match dioxus_shell_from_flag(flag) {
        DioxusShellHost::Disabled => Err(ShellError::FlagDisabled),
        DioxusShellHost::Flagged { .. } => {
            let fixture = load_canonical_fixture()?;
            let issued = issue_commands(&fixture.commands)?;
            let view = product_chat_from_fixture(&fixture, 0);
            let vdom_edits = mount_product_chat(view);
            Ok(ChatRouteReport {
                dioxus_shell: true,
                chat_workspace: true,
                header: true,
                viewport: true,
                composer: true,
                wire_messages: fixture.messages.len(),
                issued_commands: issued.len(),
                vdom_edits,
            })
        }
    }
}

pub fn chat_route_line(flag: Option<&str>) -> String {
    match flagged_chat_route(flag) {
        Ok(report) => report.line(),
        Err(ShellError::FlagDisabled) => {
            "chat_route=false dioxus_shell=false reason=flag_off main_activity=false production_jni=false production_cutover=false"
                .into()
        }
        Err(err) => format!(
            "chat_route=false dioxus_shell=false reason={} main_activity=false production_jni=false production_cutover=false",
            err.to_string().replace(' ', "_")
        ),
    }
}
