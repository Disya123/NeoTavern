use neotavern_presentation_dioxus_shell::{
    assert_registered_command, dioxus_shell_from_flag, expected_projection, load_canonical_fixture,
    mount_virtual_dom, project_canonical, DioxusShellHost,
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
