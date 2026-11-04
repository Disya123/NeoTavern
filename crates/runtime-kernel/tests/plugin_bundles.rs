//! Integration tests for the plugin bundle store (ADR-0066 P2b).
//!
//! These exercise the store the way a host will: verify a source directory against
//! declared digests, publish it, read it back in ranges, and refuse everything that
//! tries to escape or to smuggle unverified bytes.

use std::fs;
use std::path::Path;

use runtime_kernel::plugin_bundles::{
    bundle_dir, install_bundle, is_safe_relative, list_versions, read_bundle_file, remove_bundle,
    BundleError, BundleFile, BundleRequest, MAX_READ_BYTES,
};

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest as _, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn write(root: &Path, relative: &str, bytes: &[u8]) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("parent");
    }
    fs::write(path, bytes).expect("write");
}

fn request<P: AsRef<str>, D: AsRef<str>>(plugin_id: &str, files: &[(P, D)]) -> BundleRequest {
    BundleRequest {
        plugin_id: plugin_id.to_string(),
        version: "1.0.0".to_string(),
        files: files
            .iter()
            .map(|(path, digest)| BundleFile {
                path: path.as_ref().to_string(),
                sha256: digest.as_ref().to_string(),
            })
            .collect(),
    }
}

#[test]
fn installs_a_verified_bundle_and_reads_it_back_in_ranges() {
    let root = tempfile::tempdir().expect("tempdir");
    let source = root.path().join("source");
    let payload = vec![7u8; 10_000];
    write(&source, "ui/app.js", b"export const activate = () => {};");
    write(&source, "native/windows-x64/agent.exe", &payload);
    let files = [
        (
            "ui/app.js",
            sha256_hex(b"export const activate = () => {};"),
        ),
        (
            "native/windows-x64/agent.exe",
            sha256_hex(payload.as_slice()),
        ),
    ];

    let installed = install_bundle(root.path(), &source, &request("author.plugin", &files[..]))
        .expect("install");
    assert_eq!(installed.files.len(), 2);
    let expected_total = b"export const activate = () => {};".len() as u64 + payload.len() as u64;
    assert_eq!(installed.total_bytes, expected_total);
    assert!(bundle_dir(root.path(), "author.plugin", "1.0.0").is_dir());

    let (first, size, eof) = read_bundle_file(
        root.path(),
        "author.plugin",
        "1.0.0",
        "native/windows-x64/agent.exe",
        0,
        4096,
    )
    .expect("read");
    assert_eq!(size, payload.len() as u64);
    assert_eq!(first.len(), 4096);
    assert!(!eof);

    let (tail, _, eof) = read_bundle_file(
        root.path(),
        "author.plugin",
        "1.0.0",
        "native/windows-x64/agent.exe",
        9_000,
        4096,
    )
    .expect("tail read");
    assert_eq!(tail.len(), 1_000);
    assert!(eof, "the last read must report eof so the caller stops");
}

#[test]
fn a_digest_mismatch_publishes_nothing() {
    let root = tempfile::tempdir().expect("tempdir");
    let source = root.path().join("source");
    write(&source, "ui/app.js", b"tampered");
    let files = [("ui/app.js", sha256_hex(b"original"))];

    let error = install_bundle(root.path(), &source, &request("author.plugin", &files))
        .expect_err("mismatch must fail");
    assert!(matches!(error, BundleError::DigestMismatch { .. }));
    assert_eq!(error.code(), "BUNDLE_DIGEST_MISMATCH");
    assert!(
        !bundle_dir(root.path(), "author.plugin", "1.0.0").exists(),
        "a refused bundle must leave no directory behind"
    );
}

#[test]
fn traversal_and_absolute_paths_are_refused_before_copying() {
    let root = tempfile::tempdir().expect("tempdir");
    let source = root.path().join("source");
    fs::create_dir_all(&source).expect("source");
    let digest = sha256_hex(b"x");

    for path in [
        "../escape.js",
        "/etc/passwd",
        "C:/Windows/system32",
        "ui\\app.js",
    ] {
        assert!(!is_safe_relative(path), "{path} must be unsafe");
        let files = [(path, digest.as_str())];
        let error = install_bundle(root.path(), &source, &request("author.plugin", &files))
            .expect_err("unsafe path must fail");
        assert_eq!(error, BundleError::UnsafePath(path.to_string()));
    }
    assert!(!root.path().join("plugin-bundles").exists());
}

#[test]
fn a_missing_file_is_named_and_nothing_is_published() {
    let root = tempfile::tempdir().expect("tempdir");
    let source = root.path().join("source");
    fs::create_dir_all(&source).expect("source");
    let files = [("ui/missing.js", sha256_hex(b"x"))];

    let error = install_bundle(root.path(), &source, &request("author.plugin", &files))
        .expect_err("missing file must fail");
    assert_eq!(error, BundleError::Missing("ui/missing.js".to_string()));
    assert!(!bundle_dir(root.path(), "author.plugin", "1.0.0").exists());
}

#[test]
fn reinstalling_replaces_the_version_and_removal_is_idempotent() {
    let root = tempfile::tempdir().expect("tempdir");
    let source = root.path().join("source");
    write(&source, "ui/app.js", b"v1");
    let digest_v1 = sha256_hex(b"v1");
    install_bundle(
        root.path(),
        &source,
        &request("author.plugin", &[("ui/app.js", digest_v1.as_str())]),
    )
    .expect("first install");

    write(&source, "ui/app.js", b"v2");
    let digest_v2 = sha256_hex(b"v2");
    install_bundle(
        root.path(),
        &source,
        &request("author.plugin", &[("ui/app.js", digest_v2.as_str())]),
    )
    .expect("second install");
    let (bytes, _, _) =
        read_bundle_file(root.path(), "author.plugin", "1.0.0", "ui/app.js", 0, 64).expect("read");
    assert_eq!(bytes, b"v2", "the new version must replace the old bytes");

    assert_eq!(
        list_versions(root.path(), "author.plugin").expect("versions"),
        vec!["1.0.0".to_string()]
    );
    assert!(remove_bundle(root.path(), "author.plugin", Some("1.0.0")).expect("remove"));
    assert!(!remove_bundle(root.path(), "author.plugin", Some("1.0.0")).expect("idempotent"));
    assert!(list_versions(root.path(), "author.plugin")
        .expect("versions")
        .is_empty());
}

#[test]
fn reads_are_bounded_and_reject_unknown_plugins() {
    let root = tempfile::tempdir().expect("tempdir");
    let source = root.path().join("source");
    let payload = vec![1u8; (MAX_READ_BYTES + 10_000) as usize];
    write(&source, "assets/model.bin", &payload);
    let digest = sha256_hex(&payload);
    install_bundle(
        root.path(),
        &source,
        &request("author.plugin", &[("assets/model.bin", digest.as_str())]),
    )
    .expect("install");

    let (bytes, _, eof) = read_bundle_file(
        root.path(),
        "author.plugin",
        "1.0.0",
        "assets/model.bin",
        0,
        u64::MAX,
    )
    .expect("read");
    assert_eq!(bytes.len(), MAX_READ_BYTES as usize);
    assert!(!eof, "a capped read must not claim eof");

    let error = read_bundle_file(root.path(), "author.plugin", "1.0.0", "../x", 0, 16)
        .expect_err("traversal read");
    assert!(matches!(error, BundleError::UnsafePath(_)));

    let error = read_bundle_file(root.path(), "../evil", "1.0.0", "ui/app.js", 0, 16)
        .expect_err("bad plugin id");
    assert!(matches!(error, BundleError::InvalidPluginId(_)));
}
