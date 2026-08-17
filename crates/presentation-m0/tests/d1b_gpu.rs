#![cfg(feature = "gpu")]

use neotavern_presentation_m0::gpu::{run_dynamic_d1b, ProbeGpu};
use neotavern_presentation_m0::scene_d1b::{
    sampled_generation_is_current, static_d1b_scene, D1B_BAKE_VELLO_PASSES, D1B_CAPTURE_FRAME,
    D1B_FRAMES,
};
use neotavern_presentation_m0::{compile_passes, D1B_GOLDEN_TIMELINE, D1B_MOTION_TIMELINE_G120};

#[test]
fn d1b_gpu_moving_before_glass_b_or_skip() {
    match ProbeGpu::try_new_d1b(320, 200) {
        Err(err) if err.is_no_adapter() => {
            eprintln!("SKIP: no wgpu adapter (not an M0-D1b PASS): {err}");
        }
        Err(err) => panic!("GPU init failed: {err}"),
        Ok(mut gpu) => {
            let list = static_d1b_scene();
            let passes = compile_passes(&list).expect("D1b graph");
            gpu.pass_compiles = 1;
            gpu.render_compiled(&list, &passes, 0).expect("first frame");
            let report = gpu.report(1);
            assert_eq!(report.devices_created, 1);
            assert_eq!(report.cpu_readbacks, 0);
            assert_eq!(report.cross_device_copies, 0);
            assert_eq!(report.moving_sample_blits, 1);
            assert_eq!(report.pass_compiles, 1);
            assert_eq!(report.vello_rebuilds, D1B_BAKE_VELLO_PASSES);
            assert!(sampled_generation_is_current(report.sampled_generation, 0));
            assert_eq!(report.api_timeline, D1B_GOLDEN_TIMELINE);
            assert!(!report.android_gpu_capture);
            assert_eq!(report.verdict.as_str(), "BLOCKED");
        }
    }
}

#[test]
fn d1b_motion_frame_120_skips_vello_or_skip() {
    match ProbeGpu::try_new_d1b(320, 200) {
        Err(err) if err.is_no_adapter() => {
            eprintln!("SKIP: no wgpu adapter (not an M0-D1b PASS): {err}");
        }
        Err(err) => panic!("GPU init failed: {err}"),
        Ok(mut gpu) => {
            let list = static_d1b_scene();
            let passes = compile_passes(&list).expect("D1b graph");
            gpu.pass_compiles = 1;
            gpu.render_compiled(&list, &passes, 0).expect("bake");
            let bake = gpu.report(1);
            gpu.render_compiled(&list, &passes, D1B_CAPTURE_FRAME)
                .expect("g120");
            let report = gpu.report(D1B_CAPTURE_FRAME + 1);
            assert_eq!(report.pass_compiles, 1);
            assert_eq!(report.vello_rebuilds, bake.vello_rebuilds);
            assert_eq!(report.vello_rebuilds, D1B_BAKE_VELLO_PASSES);
            assert_eq!(report.layout_rebuilds, 0);
            assert_eq!(report.ui_rebuilds, 0);
            assert_eq!(report.render_thread_polls, 0);
            assert_eq!(report.moving_sample_blits, 2);
            assert!(sampled_generation_is_current(
                report.sampled_generation,
                D1B_CAPTURE_FRAME
            ));
            assert_eq!(report.capture_timeline, D1B_MOTION_TIMELINE_G120);
            assert_ne!(
                (bake.damage_x, bake.damage_y),
                (report.damage_x, report.damage_y)
            );
            assert!(u64::from(report.damage_w) * u64::from(report.damage_h) < 320 * 200);
        }
    }
}

#[test]
fn d1b_1000_frame_lifetime_or_skip() {
    match run_dynamic_d1b(D1B_FRAMES) {
        Err(err) if err.is_no_adapter() => {
            eprintln!("SKIP: no wgpu adapter (not an M0-D1b PASS): {err}");
        }
        Err(err) => panic!("1000-frame D1b probe failed: {err}"),
        Ok(report) => {
            assert!(report.gpu_ran);
            assert_eq!(report.frames, D1B_FRAMES);
            assert_eq!(report.devices_created, 1);
            assert_eq!(report.cpu_readbacks, 0);
            assert_eq!(report.cross_device_copies, 0);
            assert_eq!(report.raster_passes, D1B_BAKE_VELLO_PASSES);
            assert_eq!(report.glass_passes, 2 + (D1B_FRAMES - 1));
            assert_eq!(report.same_device_roi_copies, 2 + (D1B_FRAMES - 1));
            assert_eq!(report.moving_sample_blits, D1B_FRAMES);
            assert_eq!(report.pass_compiles, 1);
            assert_eq!(report.vello_rebuilds, D1B_BAKE_VELLO_PASSES);
            assert_eq!(report.compositor_texture_bytes, 1_046_528);
            assert_eq!(report.layout_rebuilds, 0);
            assert_eq!(report.ui_rebuilds, 0);
            assert_eq!(report.render_thread_polls, 0);
            assert_eq!(report.capture_only_polls, 0);
            assert!(sampled_generation_is_current(
                report.sampled_generation,
                D1B_FRAMES - 1
            ));
            assert_eq!(report.api_timeline, D1B_GOLDEN_TIMELINE);
            assert_eq!(report.capture_timeline, D1B_MOTION_TIMELINE_G120);
            assert!(report.compositor_texture_bytes > 774_144);
            assert!(!report.android_gpu_capture);
            assert_eq!(report.verdict.as_str(), "BLOCKED");
        }
    }
}
