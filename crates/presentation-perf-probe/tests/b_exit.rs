//! Host fixtures for PERF-15 / PERF-22 / physical device-loss.
//!
//! None of these tests stamp PASS. PERF-15 stays IMPLEMENTED without a real
//! VisualSurface path. CPU `on_device_lost` is not physical wgpu destroy.

use neotavern_presentation_perf_probe::Scenario;

#[test]
fn parses_b_exit_scenario_names() {
    assert_eq!(Scenario::parse("perf15"), Some(Scenario::Perf15));
    assert_eq!(Scenario::parse("perf22-error"), Some(Scenario::Perf22Error));
    assert_eq!(
        Scenario::parse("recovery-fling"),
        Some(Scenario::RecoveryFling)
    );
    assert_eq!(
        Scenario::parse("recovery-background"),
        Some(Scenario::RecoveryBackground)
    );
}

#[cfg(feature = "gpu")]
#[test]
fn perf15_host_run_refuses_visual_surface_and_skips_without_adapter() {
    match neotavern_presentation_perf_probe::run_scenario(Scenario::Perf15, 8, -1) {
        Ok(line) => {
            assert!(line.contains("perf15"), "{line}");
            assert!(line.contains("visual_surface=missing"), "{line}");
            assert!(line.contains("product_wire_surface=false"), "{line}");
            assert!(line.contains("fling_items=10000"), "{line}");
            assert!(line.contains("live_glass=true"), "{line}");
            assert!(line.contains("image_decode=true"), "{line}");
            assert!(!line.contains("visual_surface=present"), "{line}");
        }
        Err(err) => {
            assert!(
                err.contains("adapter") || err.contains("vello") || err.contains("gpu"),
                "{err}"
            );
        }
    }
}

#[cfg(feature = "gpu")]
#[test]
fn perf22_policies_are_independent_on_host() {
    for scenario in [
        Scenario::Perf22,
        Scenario::Perf22Poster,
        Scenario::Perf22Fullscreen,
        Scenario::Perf22Error,
    ] {
        match neotavern_presentation_perf_probe::run_scenario(scenario, 2, -1) {
            Ok(line) => {
                assert!(line.contains("capability_before_passes=true"), "{line}");
                assert!(line.contains("webview_hits=0"), "{line}");
                assert!(line.contains("image_readbacks=0"), "{line}");
                assert!(line.contains("same_epoch_rejected=true"), "{line}");
            }
            Err(err) => {
                assert!(
                    err.contains("adapter") || err.contains("vello") || err.contains("gpu"),
                    "{err}"
                );
            }
        }
    }
}

#[cfg(feature = "gpu")]
#[test]
fn recovery_host_run_destroys_wgpu_or_skips_without_adapter() {
    match neotavern_presentation_perf_probe::run_scenario(Scenario::Recovery, 3, -1) {
        Ok(line) => {
            assert!(line.contains("wgpu_destroyed=true"), "{line}");
            assert!(line.contains("wgpu_recreated=true"), "{line}");
            assert!(line.contains("stale_handle_rejected=true"), "{line}");
            assert!(line.contains("live_wgpu_devices=1"), "{line}");
            assert!(line.contains("device_epoch_bumps=1"), "{line}");
            assert!(line.contains("catch_up_burst=0"), "{line}");
        }
        Err(err) => {
            assert!(
                err.contains("adapter") || err.contains("vello") || err.contains("gpu"),
                "{err}"
            );
        }
    }
}

#[cfg(feature = "gpu")]
#[test]
fn surface_recreation_is_not_device_loss() {
    match neotavern_presentation_perf_probe::run_scenario(Scenario::RecoverySurface, 2, -1) {
        Ok(line) => {
            assert!(line.contains("wgpu_destroyed=false"), "{line}");
            assert!(line.contains("device_epoch_bumps=0"), "{line}");
            assert!(line.contains("surface_recreation=true"), "{line}");
        }
        Err(err) => panic!("{err}"),
    }
}
