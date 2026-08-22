//! Env-switch end-to-end for the dev hot stylesheet path.
//!
//! Lives in its own integration test binary (single test) so the
//! process-global `NEOTA_DEV_HOT_STYLES*` env mutation never races with other
//! tests in the same process.

use std::path::PathBuf;

use neotavern_presentation_design_system::{
    product_stylesheets, product_stylesheets_dev, reset_hot_stylesheet_cache, SafeAreaInsets,
    DEV_HOT_STYLES_ENV, DEV_HOT_STYLES_PATH_ENV,
};

#[test]
fn env_switch_serves_file_over_embedded() {
    let dir = std::env::temp_dir().join(format!("nt-hot-styles-env-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path: PathBuf = dir.join("product.css");
    std::fs::write(&path, ":root { color: #00cc00; }").unwrap();

    // Switch on + point at the temp file → the file content wins over embedded.
    std::env::set_var(DEV_HOT_STYLES_PATH_ENV, &path);
    std::env::set_var(DEV_HOT_STYLES_ENV, "1");
    reset_hot_stylesheet_cache();
    let dev = product_stylesheets_dev(SafeAreaInsets::default());
    assert!(
        dev[0].contains("color: #00cc00"),
        "env-switched sheet must come from the file, got {:?}",
        dev[0]
    );

    // Switch off → byte-identical to the embedded path again.
    std::env::remove_var(DEV_HOT_STYLES_ENV);
    reset_hot_stylesheet_cache();
    let back = product_stylesheets_dev(SafeAreaInsets::default());
    assert_eq!(
        back,
        product_stylesheets(SafeAreaInsets::default()),
        "disabled hot path must be byte-identical to embedded"
    );

    std::env::remove_var(DEV_HOT_STYLES_PATH_ENV);
    reset_hot_stylesheet_cache();
    std::fs::remove_dir_all(&dir).ok();
}
