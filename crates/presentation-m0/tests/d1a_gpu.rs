#![cfg(feature = "gpu")]

use neotavern_presentation_m0::gpu::{run_static_d1a, ProbeGpu};
use neotavern_presentation_m0::{compile_passes, static_d1a_scene};

#[test]
fn d1a_gpu_shared_device_or_skip() {
    match ProbeGpu::try_new(320, 200) {
        Err(err) if err.is_no_adapter() => {
            eprintln!("SKIP: no wgpu adapter (not an M0-D1a PASS): {err}");
        }
        Err(err) => panic!("GPU init failed: {err}"),
        Ok(mut gpu) => {
            let list = static_d1a_scene();
            let passes = compile_passes(&list).expect("D1a graph");
            assert_eq!(passes.iter().filter(|pass| pass.is_glass()).count(), 2);
            gpu.render_list(&list, 0).expect("first frame");
            let report = gpu.report(1);
            assert_eq!(report.devices_created, 1);
            assert_eq!(report.cpu_readbacks, 0);
            assert_eq!(report.cross_device_copies, 0);
            assert!(report.same_device_roi_copies >= 2);
            assert!(report.glass_passes >= 2);
            assert_eq!(
                report.api_timeline,
                neotavern_presentation_m0::D1A_GOLDEN_TIMELINE
            );
            assert!(!report.android_gpu_capture);
            assert_eq!(report.verdict.as_str(), "BLOCKED");
        }
    }
}

#[test]
fn d1a_100_frame_lifetime_or_skip() {
    match run_static_d1a(100) {
        Err(err) if err.is_no_adapter() => {
            eprintln!("SKIP: no wgpu adapter (not an M0-D1a PASS): {err}");
        }
        Err(err) => panic!("100-frame probe failed: {err}"),
        Ok(report) => {
            assert!(report.gpu_ran);
            assert_eq!(report.frames, 100);
            assert_eq!(report.devices_created, 1);
            assert_eq!(report.cpu_readbacks, 0);
            assert_eq!(report.cross_device_copies, 0);
            assert_eq!(report.glass_passes, 200);
            assert_eq!(report.raster_passes, 400);
            assert_eq!(
                report.api_timeline,
                neotavern_presentation_m0::D1A_GOLDEN_TIMELINE
            );
            assert!(report.api_timeline_events >= 13);
            assert!(report.compositor_texture_bytes > 0);
            assert!(!report.android_gpu_capture);
            assert_eq!(report.verdict.as_str(), "BLOCKED");
        }
    }
}
