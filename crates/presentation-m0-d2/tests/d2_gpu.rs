#![cfg(feature = "gpu")]

use neotavern_presentation_m0::gpu::ProbeGpu;
use neotavern_presentation_m0::scene_d1b::{
    sampled_generation_is_current, D1B_CAPTURE_FRAME, D1B_FRAMES,
};
use neotavern_presentation_m0::{compile_passes, D1B_MOTION_TIMELINE_G120};
use neotavern_presentation_m0_d2::{
    produce_dynamic_list, run_dynamic_d2, D2_BLITZ_NEWER, D2_PATCH_LINES, D2_PRODUCER_SOURCE,
    D2_REBASE_ANYRENDER_0111,
};

#[test]
fn d2_gpu_moving_after_producer_seam_or_skip() {
    match ProbeGpu::try_new_d2(320, 200) {
        Err(err) if err.is_no_adapter() => {
            eprintln!("SKIP: no wgpu adapter (not an M0-D2 PASS): {err}");
        }
        Err(err) => panic!("GPU init failed: {err}"),
        Ok(mut gpu) => {
            let (list, producer) = produce_dynamic_list().expect("producer+moving");
            assert_eq!(producer.source, D2_PRODUCER_SOURCE);
            assert_eq!(producer.glass_hooks, 2);
            let passes = compile_passes(&list).expect("D2 graph");
            gpu.pass_compiles = 1;
            gpu.paint_scene_rebuilds = 0;
            gpu.render_compiled(&list, &passes, 0).expect("first frame");
            let report = gpu.report(1);
            assert_eq!(report.devices_created, 1);
            assert_eq!(report.cpu_readbacks, 0);
            assert_eq!(report.cross_device_copies, 0);
            assert_eq!(report.moving_sample_blits, 1);
            assert_eq!(report.pass_compiles, 1);
            assert_eq!(report.paint_scene_rebuilds, 0);
            assert_eq!(report.layout_rebuilds, 0);
            assert!(sampled_generation_is_current(report.sampled_generation, 0));
            assert!(report.api_timeline.contains("moving:g0"));
            assert!(report.api_timeline.contains("glass:2:g0"));
            let moving = report.api_timeline.find("moving:g0").unwrap();
            let glass_b = report.api_timeline.find("glass:2:g0").unwrap();
            assert!(moving < glass_b);
            assert!(!report.android_gpu_capture);
            assert_eq!(report.verdict.as_str(), "BLOCKED");
        }
    }
}

#[test]
fn d2_motion_frame_120_skips_layout_and_paint_scene_or_skip() {
    match ProbeGpu::try_new_d2(320, 200) {
        Err(err) if err.is_no_adapter() => {
            eprintln!("SKIP: no wgpu adapter (not an M0-D2 PASS): {err}");
        }
        Err(err) => panic!("GPU init failed: {err}"),
        Ok(mut gpu) => {
            let (list, _) = produce_dynamic_list().expect("producer+moving");
            let passes = compile_passes(&list).expect("D2 graph");
            gpu.pass_compiles = 1;
            gpu.paint_scene_rebuilds = 0;
            gpu.render_compiled(&list, &passes, 0).expect("bake");
            let bake = gpu.report(1);
            gpu.render_compiled(&list, &passes, D1B_CAPTURE_FRAME)
                .expect("g120");
            let report = gpu.report(D1B_CAPTURE_FRAME + 1);
            assert_eq!(report.pass_compiles, 1);
            assert_eq!(report.vello_rebuilds, bake.vello_rebuilds);
            assert_eq!(report.paint_scene_rebuilds, 0);
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
fn d2_1000_frame_lifetime_or_skip() {
    match run_dynamic_d2(D1B_FRAMES) {
        Err(err) if err.is_no_adapter() => {
            eprintln!("SKIP: no wgpu adapter (not an M0-D2 PASS): {err}");
        }
        Err(err) => panic!("1000-frame D2 probe failed: {err}"),
        Ok(report) => {
            assert!(report.gpu.gpu_ran);
            assert_eq!(report.gpu.frames, D1B_FRAMES);
            assert_eq!(report.gpu.devices_created, 1);
            assert_eq!(report.gpu.cpu_readbacks, 0);
            assert_eq!(report.gpu.cross_device_copies, 0);
            assert_eq!(report.gpu.pass_compiles, 1);
            assert_eq!(report.paint_scene_rebuilds, 0);
            assert_eq!(report.gpu.layout_rebuilds, 0);
            assert_eq!(report.gpu.ui_rebuilds, 0);
            assert_eq!(report.gpu.render_thread_polls, 0);
            assert_eq!(report.gpu.capture_only_polls, 0);
            assert_eq!(report.gpu.moving_sample_blits, D1B_FRAMES);
            assert_eq!(report.gpu.glass_passes, 2 + (D1B_FRAMES - 1));
            assert_eq!(report.gpu.same_device_roi_copies, 2 + (D1B_FRAMES - 1));
            assert_eq!(report.gpu.raster_passes, report.gpu.vello_rebuilds);
            assert!(report.gpu.vello_rebuilds > 0);
            assert_eq!(report.gpu.compositor_texture_bytes, 1_046_528);
            assert!(sampled_generation_is_current(
                report.gpu.sampled_generation,
                D1B_FRAMES - 1
            ));
            assert!(report.gpu.api_timeline.contains("moving:g0"));
            assert!(report.gpu.api_timeline.contains("glass:2:g0"));
            assert_eq!(report.gpu.capture_timeline, D1B_MOTION_TIMELINE_G120);
            assert_eq!(report.producer.source, D2_PRODUCER_SOURCE);
            assert_eq!(report.producer.glass_hooks, 2);
            assert_eq!(report.patch_lines, D2_PATCH_LINES);
            assert_eq!(report.rebase_anyrender_0111, D2_REBASE_ANYRENDER_0111);
            assert_eq!(report.blitz_newer, D2_BLITZ_NEWER);
            assert!(!report.gpu.android_gpu_capture);
            assert_eq!(report.gpu.verdict.as_str(), "BLOCKED");
            let line = report.to_d2_log_line();
            assert!(line.starts_with("m0-d2 "));
            assert!(line.contains("pass_compiles=1"));
            assert!(line.contains("paint_scene_rebuilds=0"));
            assert!(line.contains("layout_rebuilds=0"));
            assert!(line.contains(&format!("producer_source={D2_PRODUCER_SOURCE}")));
            assert!(line.contains("glass_from_hook=2"));
            assert!(line.contains("patch_lines=65"));
            assert!(line.contains("rebase_anyrender_0111=PASS"));
            assert!(line.contains("blitz_newer=NOT_AVAILABLE"));
        }
    }
}
