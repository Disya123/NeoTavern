fn main() {
    match neotavern_presentation_m0::gpu::run_static_d1a(100) {
        Ok(report) => {
            println!("gpu_ran={}", report.gpu_ran);
            println!(
                "adapter={} backend={}",
                report.adapter_name, report.adapter_backend
            );
            println!("software_adapter={}", report.software_adapter);
            println!("devices_created={}", report.devices_created);
            println!("cpu_readbacks={}", report.cpu_readbacks);
            println!("cross_device_copies={}", report.cross_device_copies);
            println!("same_device_roi_copies={}", report.same_device_roi_copies);
            println!("raster_passes={}", report.raster_passes);
            println!("glass_passes={}", report.glass_passes);
            println!("frames={}", report.frames);
            println!("ran_on_android={}", report.ran_on_android);
            println!("android_gpu_capture={}", report.android_gpu_capture);
            println!("api_timeline={}", report.api_timeline);
            println!("api_timeline_events={}", report.api_timeline_events);
            println!("first_frame_cpu_us={}", report.first_frame_cpu_us);
            println!(
                "compositor_texture_bytes={}",
                report.compositor_texture_bytes
            );
            println!("{}", report.to_log_line());
            println!("verdict={}", report.verdict.as_str());
            match report.verdict {
                neotavern_presentation_m0::SubstrateVerdict::Blocked { reason }
                | neotavern_presentation_m0::SubstrateVerdict::Patch { reason }
                | neotavern_presentation_m0::SubstrateVerdict::Replace { reason } => {
                    println!("reason={reason}");
                }
                neotavern_presentation_m0::SubstrateVerdict::Pass => {}
            }
        }
        Err(err) => {
            eprintln!("M0-D1a GPU probe failed to start: {err}");
            std::process::exit(2);
        }
    }
}
