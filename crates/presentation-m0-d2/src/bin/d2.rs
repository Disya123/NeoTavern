fn main() {
    match neotavern_presentation_m0_d2::run_dynamic_d2(1000) {
        Ok(report) => {
            println!("gpu_ran={}", report.gpu.gpu_ran);
            println!(
                "adapter={} backend={}",
                report.gpu.adapter_name, report.gpu.adapter_backend
            );
            println!("software_adapter={}", report.gpu.software_adapter);
            println!("devices_created={}", report.gpu.devices_created);
            println!("cpu_readbacks={}", report.gpu.cpu_readbacks);
            println!("cross_device_copies={}", report.gpu.cross_device_copies);
            println!(
                "same_device_roi_copies={}",
                report.gpu.same_device_roi_copies
            );
            println!("raster_passes={}", report.gpu.raster_passes);
            println!("glass_passes={}", report.gpu.glass_passes);
            println!("moving_sample_blits={}", report.gpu.moving_sample_blits);
            println!("pass_compiles={}", report.gpu.pass_compiles);
            println!("vello_rebuilds={}", report.gpu.vello_rebuilds);
            println!("layout_rebuilds={}", report.gpu.layout_rebuilds);
            println!("ui_rebuilds={}", report.gpu.ui_rebuilds);
            println!("paint_scene_rebuilds={}", report.paint_scene_rebuilds);
            println!("producer_source={}", report.producer.source);
            println!("glass_from_hook={}", report.producer.glass_hooks);
            println!("patch_lines={}", report.patch_lines);
            println!("rebase_anyrender_0111={}", report.rebase_anyrender_0111);
            println!("blitz_newer={}", report.blitz_newer);
            println!("sampled_generation={}", report.gpu.sampled_generation);
            println!(
                "damage={}x{}+{}x{}",
                report.gpu.damage_x, report.gpu.damage_y, report.gpu.damage_w, report.gpu.damage_h
            );
            println!("capture_timeline={}", report.gpu.capture_timeline);
            println!("frames={}", report.gpu.frames);
            println!("ran_on_android={}", report.gpu.ran_on_android);
            println!("android_gpu_capture={}", report.gpu.android_gpu_capture);
            println!("api_timeline={}", report.gpu.api_timeline);
            println!(
                "compositor_texture_bytes={}",
                report.gpu.compositor_texture_bytes
            );
            println!("{}", report.to_d2_log_line());
            println!("verdict={}", report.gpu.verdict.as_str());
            match report.gpu.verdict {
                neotavern_presentation_m0::SubstrateVerdict::Blocked { reason }
                | neotavern_presentation_m0::SubstrateVerdict::Patch { reason }
                | neotavern_presentation_m0::SubstrateVerdict::Replace { reason } => {
                    println!("reason={reason}");
                }
                neotavern_presentation_m0::SubstrateVerdict::Pass => {}
            }
        }
        Err(err) => {
            eprintln!("M0-D2 GPU probe failed to start: {err}");
            std::process::exit(2);
        }
    }
}
