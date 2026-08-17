//! Feature/header contract for the probe-only RenderDoc capture. Not D1a PASS.

use std::fs;

#[test]
fn android_jni_does_not_enable_renderdoc_capture() {
    let toml = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml")).unwrap();
    assert!(toml.contains("android-jni = [\"gpu\"]"));
    assert!(!toml.contains("android-jni = [\"gpu\", \"renderdoc-capture\"]"));
    assert!(toml.contains("renderdoc-capture = [\"gpu\", \"dep:ash\"]"));
}

#[test]
fn vendored_renderdoc_header_is_pinned() {
    let header = concat!(env!("CARGO_MANIFEST_DIR"), "/third_party/renderdoc_app.h");
    let bytes = fs::read(header).unwrap();
    assert_eq!(bytes.len(), 36480);
    let pin = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tools/renderdoc.pin.json"
    ))
    .unwrap();
    assert!(pin.contains("b7005e7dc34c3635046868bbd76d81b9b055aede0f56daa0bd39fedee0639ffb"));
    assert!(pin.contains("crates/presentation-m0/third_party/renderdoc_app.h"));
}

#[test]
fn capture_source_binds_wgpu_vulkan_device_not_null() {
    let src = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/renderdoc_capture.rs"
    ))
    .unwrap();
    assert!(src.contains("const IDX_START: usize = 19;"));
    assert!(src.contains("const IDX_END: usize = 21;"));
    assert!(src.contains("capture_device=wgpu-vulkan"));
    assert!(src.contains("as_hal::<VulkanApi>"));
    assert!(src.contains("StartFrameCapture"));
    assert!(src.contains("start(ptrs.rdoc_device, ptr::null_mut())"));
    assert!(!src.contains("start(ptr::null_mut()"));
}
