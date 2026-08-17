//! Substrate verdict for the M0-D1a probe.
//!
//! `PASS` / `PATCH` / `REPLACE` describe the **paint substrate API**, not Gate P
//! (`GateP:P0|P1|P2`) and not a Track D compositor GO. Headless success without
//! Android GPU capture is `Blocked`, not `Pass`. A recorded wgpu API timeline
//! is not a GPU capture and does not satisfy `android_gpu_capture`.

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SubstrateVerdict {
    /// Upstream Vello/wgpu API is enough for the D1a seam.
    Pass,
    /// A bounded, rebaseable fork/hook is required.
    Patch { reason: &'static str },
    /// The paint substrate cannot host the seam.
    Replace { reason: &'static str },
    /// Evidence is incomplete (no adapter, no Android capture, skipped GPU).
    Blocked { reason: &'static str },
}

impl SubstrateVerdict {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pass => "PASS",
            Self::Patch { .. } => "PATCH",
            Self::Replace { .. } => "REPLACE",
            Self::Blocked { .. } => "BLOCKED",
        }
    }

    pub fn reason(&self) -> Option<&'static str> {
        match self {
            Self::Pass => None,
            Self::Patch { reason } | Self::Replace { reason } | Self::Blocked { reason } => {
                Some(*reason)
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProbeReport {
    pub gpu_ran: bool,
    pub adapter_name: String,
    pub adapter_backend: String,
    pub software_adapter: bool,
    pub devices_created: u64,
    pub cpu_readbacks: u64,
    pub cross_device_copies: u64,
    pub same_device_roi_copies: u64,
    pub raster_passes: u64,
    pub glass_passes: u64,
    pub moving_sample_blits: u64,
    pub pass_compiles: u64,
    pub sampled_generation: u64,
    pub vello_rebuilds: u64,
    pub layout_rebuilds: u64,
    pub ui_rebuilds: u64,
    pub paint_scene_rebuilds: u64,
    pub render_thread_polls: u64,
    pub capture_only_polls: u64,
    pub damage_x: u32,
    pub damage_y: u32,
    pub damage_w: u32,
    pub damage_h: u32,
    pub capture_timeline: String,
    pub frames: u64,
    pub ran_on_android: bool,
    pub android_gpu_capture: bool,
    /// Compact first-frame API tokens (`clear,raster,blit,roi:1,glass:1,…`).
    pub api_timeline: String,
    pub api_timeline_events: u64,
    pub first_frame_cpu_us: u64,
    pub compositor_texture_bytes: u64,
    pub verdict: SubstrateVerdict,
}

impl ProbeReport {
    pub fn skipped(reason: &'static str) -> Self {
        Self {
            gpu_ran: false,
            adapter_name: String::new(),
            adapter_backend: String::new(),
            software_adapter: false,
            devices_created: 0,
            cpu_readbacks: 0,
            cross_device_copies: 0,
            same_device_roi_copies: 0,
            raster_passes: 0,
            glass_passes: 0,
            moving_sample_blits: 0,
            pass_compiles: 0,
            sampled_generation: 0,
            vello_rebuilds: 0,
            layout_rebuilds: 0,
            ui_rebuilds: 0,
            paint_scene_rebuilds: 0,
            render_thread_polls: 0,
            capture_only_polls: 0,
            damage_x: 0,
            damage_y: 0,
            damage_w: 0,
            damage_h: 0,
            capture_timeline: String::new(),
            frames: 0,
            ran_on_android: cfg!(target_os = "android"),
            android_gpu_capture: false,
            api_timeline: String::new(),
            api_timeline_events: 0,
            first_frame_cpu_us: 0,
            compositor_texture_bytes: 0,
            verdict: SubstrateVerdict::Blocked { reason },
        }
        .classify()
    }

    pub fn classify(mut self) -> Self {
        self.verdict = classify(&self);
        self
    }

    pub fn to_log_line(&self) -> String {
        let reason = self.verdict.reason().unwrap_or("");
        format!(
            "m0-d1a gpu_ran={} adapter={} backend={} software={} devices={} readbacks={} xdev={} roi_copies={} raster={} glass={} frames={} ran_on_android={} capture={} timeline={} timeline_events={} first_frame_cpu_us={} acc_bytes={} verdict={} reason={}",
            self.gpu_ran,
            self.adapter_name.replace(' ', "_"),
            self.adapter_backend,
            self.software_adapter,
            self.devices_created,
            self.cpu_readbacks,
            self.cross_device_copies,
            self.same_device_roi_copies,
            self.raster_passes,
            self.glass_passes,
            self.frames,
            self.ran_on_android,
            self.android_gpu_capture,
            if self.api_timeline.is_empty() {
                "-"
            } else {
                self.api_timeline.as_str()
            },
            self.api_timeline_events,
            self.first_frame_cpu_us,
            self.compositor_texture_bytes,
            self.verdict.as_str(),
            reason.replace(' ', "_")
        )
    }

    pub fn to_d1b_log_line(&self) -> String {
        format!(
            "m0-d1b gpu_ran={} adapter={} backend={} software={} devices={} readbacks={} xdev={} roi_copies={} raster={} glass={} moving_blits={} pass_compiles={} vello_rebuilds={} layout_rebuilds={} ui_rebuilds={} sampled_gen={} damage={}x{}+{}x{} frames={} ran_on_android={} capture={} timeline={} capture_timeline={} render_polls={} capture_polls={} acc_bytes={} verdict={} reason={}",
            self.gpu_ran,
            self.adapter_name.replace(' ', "_"),
            self.adapter_backend,
            self.software_adapter,
            self.devices_created,
            self.cpu_readbacks,
            self.cross_device_copies,
            self.same_device_roi_copies,
            self.raster_passes,
            self.glass_passes,
            self.moving_sample_blits,
            self.pass_compiles,
            self.vello_rebuilds,
            self.layout_rebuilds,
            self.ui_rebuilds,
            self.sampled_generation,
            self.damage_x,
            self.damage_y,
            self.damage_w,
            self.damage_h,
            self.frames,
            self.ran_on_android,
            self.android_gpu_capture,
            if self.api_timeline.is_empty() {
                "-"
            } else {
                self.api_timeline.as_str()
            },
            if self.capture_timeline.is_empty() {
                "-"
            } else {
                self.capture_timeline.as_str()
            },
            self.render_thread_polls,
            self.capture_only_polls,
            self.compositor_texture_bytes,
            self.verdict.as_str(),
            self.verdict.reason().unwrap_or("").replace(' ', "_")
        )
    }
}

pub fn classify(report: &ProbeReport) -> SubstrateVerdict {
    if !report.gpu_ran {
        return SubstrateVerdict::Blocked {
            reason: "no wgpu adapter ran; headless skip is not D1a PASS",
        };
    }
    if report.cpu_readbacks > 0 {
        return SubstrateVerdict::Replace {
            reason: "CPU readback was required to feed glass",
        };
    }
    if report.cross_device_copies > 0 {
        return SubstrateVerdict::Replace {
            reason: "cross-device texture copy was required",
        };
    }
    if report.devices_created != 1 {
        return SubstrateVerdict::Replace {
            reason: "raster and compositor did not share a single Device",
        };
    }
    if report.glass_passes < 2 {
        return SubstrateVerdict::Replace {
            reason: "scene did not execute two BackdropBarrier glass passes",
        };
    }
    if !report.ran_on_android {
        return SubstrateVerdict::Blocked {
            reason: "headless/desktop GPU ran; Android production backend is still required for D1a PASS",
        };
    }
    if !report.android_gpu_capture {
        return SubstrateVerdict::Blocked {
            reason: "Android GPU ran; GPU capture with pass/resource order is still required for D1a PASS",
        };
    }
    SubstrateVerdict::Pass
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base(gpu_ran: bool) -> ProbeReport {
        ProbeReport {
            gpu_ran,
            adapter_name: "test".into(),
            adapter_backend: "vulkan".into(),
            software_adapter: false,
            devices_created: 1,
            cpu_readbacks: 0,
            cross_device_copies: 0,
            same_device_roi_copies: 2,
            raster_passes: 4,
            glass_passes: 2,
            moving_sample_blits: 0,
            pass_compiles: 0,
            sampled_generation: 0,
            vello_rebuilds: 0,
            layout_rebuilds: 0,
            ui_rebuilds: 0,
            paint_scene_rebuilds: 0,
            render_thread_polls: 0,
            capture_only_polls: 0,
            damage_x: 0,
            damage_y: 0,
            damage_w: 0,
            damage_h: 0,
            capture_timeline: String::new(),
            frames: 100,
            ran_on_android: false,
            android_gpu_capture: false,
            api_timeline: String::new(),
            api_timeline_events: 0,
            first_frame_cpu_us: 0,
            compositor_texture_bytes: 0,
            verdict: SubstrateVerdict::Pass,
        }
    }

    #[test]
    fn desktop_gpu_without_android_is_blocked_not_pass() {
        let report = base(true).classify();
        assert_eq!(report.verdict.as_str(), "BLOCKED");
        assert!(report.to_log_line().starts_with("m0-d1a "));
    }

    #[test]
    fn android_gpu_without_capture_is_still_blocked() {
        let mut report = base(true);
        report.ran_on_android = true;
        let report = report.classify();
        assert_eq!(report.verdict.as_str(), "BLOCKED");
    }

    #[test]
    fn api_timeline_without_gpu_capture_is_still_blocked() {
        let mut report = base(true);
        report.ran_on_android = true;
        report.api_timeline = crate::D1A_GOLDEN_TIMELINE.to_string();
        report.api_timeline_events = 13;
        report.android_gpu_capture = false;
        let report = report.classify();
        assert_eq!(report.verdict.as_str(), "BLOCKED");
        assert!(report.to_log_line().contains("capture=false"));
        assert!(report.to_log_line().contains("timeline=clear,raster,blit"));
    }

    #[test]
    fn android_gpu_with_capture_and_counters_is_pass() {
        let mut report = base(true);
        report.ran_on_android = true;
        report.android_gpu_capture = true;
        let report = report.classify();
        assert_eq!(report.verdict.as_str(), "PASS");
    }

    #[test]
    fn d1b_log_line_carries_generation_and_poll_split() {
        let mut report = base(true);
        report.moving_sample_blits = 1000;
        report.pass_compiles = 1;
        report.vello_rebuilds = 4;
        report.sampled_generation = 999;
        report.capture_timeline = crate::D1B_MOTION_TIMELINE_G120.to_string();
        report.render_thread_polls = 0;
        report.capture_only_polls = 1;
        let line = report.to_d1b_log_line();
        assert!(line.starts_with("m0-d1b "));
        assert!(line.contains("moving_blits=1000"));
        assert!(line.contains("pass_compiles=1"));
        assert!(line.contains("vello_rebuilds=4"));
        assert!(line.contains("layout_rebuilds=0"));
        assert!(line.contains("ui_rebuilds=0"));
        assert!(line.contains("sampled_gen=999"));
        assert!(line.contains("capture_timeline=restore,moving:g120,roi:2,glass:2:g120,overlay"));
        assert!(line.contains("render_polls=0"));
        assert!(line.contains("capture_polls=1"));
        assert!(line.contains("capture=false"));
    }

    #[test]
    fn readback_is_replace() {
        let mut report = base(true);
        report.cpu_readbacks = 1;
        report.ran_on_android = true;
        report.android_gpu_capture = true;
        let report = report.classify();
        assert_eq!(report.verdict.as_str(), "REPLACE");
    }
}
