//! Compile-once GPU motion over the D2 producer display list.

use neotavern_presentation_m0::gpu::{run_dynamic_list, GpuInitError, LabelMode};
use neotavern_presentation_m0::scene_d1b::list_has_moving_sample;
use neotavern_presentation_m0::ProbeReport;

use crate::{
    produce_dynamic_list, ProducerReport, D2_BLITZ_NEWER, D2_CAPTURE_DIR, D2_PATCH_LINES,
    D2_PRODUCER_SOURCE, D2_REBASE_ANYRENDER_0111,
};

pub struct DynamicD2Report {
    pub gpu: ProbeReport,
    pub producer: ProducerReport,
    pub paint_scene_rebuilds: u64,
    pub patch_lines: u64,
    pub rebase_anyrender_0111: &'static str,
    pub blitz_newer: &'static str,
}

impl DynamicD2Report {
    pub fn to_d2_log_line(&self) -> String {
        format!(
            "m0-d2 gpu_ran={} adapter={} backend={} software={} devices={} readbacks={} xdev={} roi_copies={} raster={} glass={} moving_blits={} pass_compiles={} vello_rebuilds={} layout_rebuilds={} ui_rebuilds={} paint_scene_rebuilds={} sampled_gen={} damage={}x{}+{}x{} frames={} ran_on_android={} capture={} timeline={} capture_timeline={} render_polls={} capture_polls={} acc_bytes={} producer_source={} glass_from_hook={} patch_lines={} rebase_anyrender_0111={} blitz_newer={} verdict={} reason={}",
            self.gpu.gpu_ran,
            self.gpu.adapter_name.replace(' ', "_"),
            self.gpu.adapter_backend,
            self.gpu.software_adapter,
            self.gpu.devices_created,
            self.gpu.cpu_readbacks,
            self.gpu.cross_device_copies,
            self.gpu.same_device_roi_copies,
            self.gpu.raster_passes,
            self.gpu.glass_passes,
            self.gpu.moving_sample_blits,
            self.gpu.pass_compiles,
            self.gpu.vello_rebuilds,
            self.gpu.layout_rebuilds,
            self.gpu.ui_rebuilds,
            self.paint_scene_rebuilds,
            self.gpu.sampled_generation,
            self.gpu.damage_x,
            self.gpu.damage_y,
            self.gpu.damage_w,
            self.gpu.damage_h,
            self.gpu.frames,
            self.gpu.ran_on_android,
            self.gpu.android_gpu_capture,
            if self.gpu.api_timeline.is_empty() {
                "-"
            } else {
                self.gpu.api_timeline.as_str()
            },
            if self.gpu.capture_timeline.is_empty() {
                "-"
            } else {
                self.gpu.capture_timeline.as_str()
            },
            self.gpu.render_thread_polls,
            self.gpu.capture_only_polls,
            self.gpu.compositor_texture_bytes,
            self.producer.source,
            self.producer.glass_hooks,
            self.patch_lines,
            self.rebase_anyrender_0111,
            self.blitz_newer,
            self.gpu.verdict.as_str(),
            self.gpu.verdict.reason().unwrap_or("").replace(' ', "_")
        )
    }
}

pub fn run_dynamic_d2(frames: u64) -> Result<DynamicD2Report, GpuInitError> {
    run_dynamic_d2_with_capture(frames, false)
}

pub fn run_dynamic_d2_with_capture(
    frames: u64,
    capture: bool,
) -> Result<DynamicD2Report, GpuInitError> {
    let (list, producer) = produce_dynamic_list().map_err(GpuInitError::Renderer)?;
    if producer.source != D2_PRODUCER_SOURCE {
        return Err(GpuInitError::Renderer(
            "D2 producer source is not VirtualDom → Blitz paint_scene".to_string(),
        ));
    }
    if producer.glass_hooks != 2 {
        return Err(GpuInitError::Renderer(format!(
            "D2 paint hook must emit two glass barriers, got {}",
            producer.glass_hooks
        )));
    }
    if !list_has_moving_sample(&list) {
        return Err(GpuInitError::Renderer(
            "moving sample missing after producer paint seam".to_string(),
        ));
    }
    let gpu = run_dynamic_list(&list, frames, capture, D2_CAPTURE_DIR, LabelMode::D2)?;
    Ok(DynamicD2Report {
        gpu,
        producer,
        paint_scene_rebuilds: 0,
        patch_lines: D2_PATCH_LINES,
        rebase_anyrender_0111: D2_REBASE_ANYRENDER_0111,
        blitz_newer: D2_BLITZ_NEWER,
    })
}
