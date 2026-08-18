use neotavern_presentation_dioxus_shell::{
    assert_registered_command, chat_route_line, dioxus_shell_from_flag, expected_projection,
    flagged_chat_route, load_canonical_fixture, mixed_height_catalog, mount_product_chat,
    mount_virtual_dom, product_chat_from_fixture, project_canonical, DioxusShellHost, ShellError,
    PRODUCT_PATH_ITEMS,
};
use std::fs;
use std::path::PathBuf;

#[test]
fn default_host_is_disabled() {
    assert_eq!(dioxus_shell_from_flag(None), DioxusShellHost::Disabled);
    assert_eq!(
        dioxus_shell_from_flag(Some("1")),
        DioxusShellHost::Flagged { feature_flag: true }
    );
}

#[test]
fn rejects_unregistered_commands() {
    let err = assert_registered_command("presentation.bypassSqlite").unwrap_err();
    assert!(format!("{err}").contains("Product Wire"));
}

#[test]
fn rust_projection_matches_shared_golden_fixture() {
    let fixture = load_canonical_fixture().expect("fixture");
    let projection = project_canonical(&fixture).expect("projection");
    assert_eq!(projection, expected_projection());
}

#[test]
fn builds_a_dioxus_virtualdom_from_the_wire_view_model() {
    let fixture = load_canonical_fixture().expect("fixture");
    let projection = project_canonical(&fixture).expect("projection");
    let edits = mount_virtual_dom(&projection.title, projection.message_ids.len());
    assert!(edits > 0, "VirtualDom rebuild must emit mutations");
}

#[test]
fn cargo_toml_does_not_depend_on_kernel_storage_or_network() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    let text = fs::read_to_string(manifest).expect("Cargo.toml");
    for forbidden in [
        "runtime-kernel",
        "neotavern-runtime-kernel",
        "neotavern-storage",
        "reqwest",
        "hyper",
        "tokio",
        "rusqlite",
        "android-jni",
    ] {
        assert!(
            !text.contains(forbidden),
            "Dioxus Product Wire shell must not depend on {forbidden}"
        );
    }
}

#[test]
fn product_path_catalog_is_ten_thousand_wire_messages() {
    let fixture = mixed_height_catalog(PRODUCT_PATH_ITEMS);
    let projection = project_canonical(&fixture).expect("wire");
    assert_eq!(projection.message_ids.len(), PRODUCT_PATH_ITEMS as usize);
    assert_eq!(
        dioxus_shell_from_flag(Some("1")),
        DioxusShellHost::Flagged { feature_flag: true }
    );
    let view = product_chat_from_fixture(&fixture, 0);
    let edits = mount_product_chat(view);
    assert!(edits > 0);
}

#[test]
fn flagged_chat_route_requires_dioxus_shell_flag() {
    let err = flagged_chat_route(None).unwrap_err();
    assert!(matches!(err, ShellError::FlagDisabled));
    let blocked = chat_route_line(None);
    assert!(blocked.contains("chat_route=false"));
    assert!(blocked.contains("reason=flag_off"));
    assert!(blocked.contains("main_activity=false"));
    assert!(blocked.contains("production_cutover=false"));
}

#[test]
fn flagged_chat_route_mounts_canonical_workspace() {
    let report = flagged_chat_route(Some("1")).expect("flagged route");
    assert!(report.dioxus_shell);
    assert!(report.chat_workspace);
    assert!(report.header);
    assert!(report.viewport);
    assert!(report.composer);
    assert!(report.wire_messages > 0);
    assert!(report.issued_commands > 0);
    assert!(report.vdom_edits > 0);
    let line = report.line();
    assert!(line.contains("data_component=chat-workspace"));
    assert!(line.contains("main_activity=false"));
    assert!(line.contains("production_jni=false"));
    assert!(line.contains("production_cutover=false"));
}
