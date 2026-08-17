//! First-frame wgpu API timeline for the D1a probe.
//!
//! This is a **host-recorded command log** with named resources. It is not an
//! AGI/RenderDoc GPU capture and MUST NOT flip `android_gpu_capture`. RFC 4.5
//! treats it as partial evidence of pass/resource order at the API the probe
//! submitted.

use crate::display_list::{ClipChainId, GlassBoundary, NeoDisplayList, Rect};
use crate::pass_graph::{compile_passes, CompiledPass, GraphError};

/// Max glass ROI copy into the sampleable snapshot (D1a ROIs are 140×80).
pub const GLASS_SNAPSHOT_MAX: u32 = 256;

pub const ACCUMULATOR_LABEL: &str = "m0-d1a-accumulator";
pub const VELLO_LABEL: &str = "m0-d1a-vello";
pub const SNAPSHOT_LABEL: &str = "m0-d1a-glass-roi";

/// Labels a GPU capture must show. They do not admit D1a PASS by themselves.
pub const CAPTURE_PASS_CLEAR: &str = "m0-d1a-clear-acc";
pub const CAPTURE_PASS_BLIT: &str = "m0-d1a-blit-pass";
pub const CAPTURE_PASS_GLASS: &str = "m0-d1a-glass-pass";
pub const CAPTURE_GROUP_ROI_PREFIX: &str = "m0-d1a-roi-read";
pub const CAPTURE_GROUP_GLASS_PREFIX: &str = "m0-d1a-glass";
pub const MOVING_LABEL: &str = "m0-d1b-moving";
pub const STATIC_PREFIX_LABEL: &str = "m0-d1b-static-prefix";
pub const CAPTURE_PASS_MOVING: &str = "m0-d1b-moving-blit";
pub const CAPTURE_PASS_RESTORE: &str = "m0-d1b-restore-static";
pub const CAPTURE_PASS_OVERLAY: &str = "m0-d1b-overlay-blit";
pub const CAPTURE_GROUP_D1B_ROI_PREFIX: &str = "m0-d1b-roi-read";
pub const CAPTURE_GROUP_D1B_GLASS_PREFIX: &str = "m0-d1b-glass";
pub const MOVING_LABEL_D2: &str = "m0-d2-moving";
pub const STATIC_PREFIX_LABEL_D2: &str = "m0-d2-static-prefix";
pub const CAPTURE_PASS_D2_MOVING: &str = "m0-d2-moving-blit";
pub const CAPTURE_PASS_D2_RESTORE: &str = "m0-d2-restore-static";
pub const CAPTURE_PASS_D2_OVERLAY: &str = "m0-d2-overlay-blit";
pub const CAPTURE_GROUP_D2_ROI_PREFIX: &str = "m0-d2-roi-read";
pub const CAPTURE_GROUP_D2_GLASS_PREFIX: &str = "m0-d2-glass";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RoiPx {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TimelineKind {
    ClearAccumulator,
    RasterToVello {
        chunk_count: u32,
    },
    BlitVelloToAccumulator,
    RoiCopyAccumulatorToSnapshot {
        barrier: u32,
        x: u32,
        y: u32,
        w: u32,
        h: u32,
    },
    GlassSampleSnapshotWriteAccumulator {
        barrier: u32,
        x: u32,
        y: u32,
        w: u32,
        h: u32,
        generation: Option<u64>,
    },
    MovingSampleBlit {
        x: u32,
        y: u32,
        w: u32,
        h: u32,
        generation: u64,
    },
    RestoreStaticPrefix,
    OverlayBlitFromCache,
}

impl TimelineKind {
    pub fn token(&self) -> String {
        match self {
            Self::ClearAccumulator => "clear".to_string(),
            Self::RasterToVello { .. } => "raster".to_string(),
            Self::BlitVelloToAccumulator => "blit".to_string(),
            Self::RoiCopyAccumulatorToSnapshot { barrier, .. } => format!("roi:{barrier}"),
            Self::GlassSampleSnapshotWriteAccumulator {
                barrier,
                generation: Some(gen),
                ..
            } if *barrier == 2 => format!("glass:{barrier}:g{gen}"),
            Self::GlassSampleSnapshotWriteAccumulator { barrier, .. } => {
                format!("glass:{barrier}")
            }
            Self::MovingSampleBlit { generation, .. } => format!("moving:g{generation}"),
            Self::RestoreStaticPrefix => "restore".to_string(),
            Self::OverlayBlitFromCache => "overlay".to_string(),
        }
    }

    pub fn reads_accumulator(&self) -> bool {
        matches!(self, Self::RoiCopyAccumulatorToSnapshot { .. })
    }

    pub fn samples_snapshot(&self) -> bool {
        matches!(self, Self::GlassSampleSnapshotWriteAccumulator { .. })
    }

    pub fn writes_accumulator(&self) -> bool {
        matches!(
            self,
            Self::ClearAccumulator
                | Self::BlitVelloToAccumulator
                | Self::GlassSampleSnapshotWriteAccumulator { .. }
                | Self::MovingSampleBlit { .. }
                | Self::RestoreStaticPrefix
                | Self::OverlayBlitFromCache
        )
    }
}

pub fn encode_timeline(events: &[TimelineKind]) -> String {
    events
        .iter()
        .map(TimelineKind::token)
        .collect::<Vec<_>>()
        .join(",")
}

pub fn compositor_owned_bytes(width: u32, height: u32) -> u64 {
    let rgba = |w: u32, h: u32| u64::from(w) * u64::from(h) * 4;
    rgba(width, height).saturating_mul(2) + rgba(GLASS_SNAPSHOT_MAX, GLASS_SNAPSHOT_MAX)
}

pub fn compositor_owned_bytes_d1b(width: u32, height: u32) -> u64 {
    let rgba = |w: u32, h: u32| u64::from(w) * u64::from(h) * 4;
    compositor_owned_bytes(width, height)
        + u64::from(crate::scene_d1b::MOVING_SIZE) * u64::from(crate::scene_d1b::MOVING_SIZE) * 4
        + rgba(width, height)
}

pub fn resolved_glass_roi(
    list: &NeoDisplayList,
    roi: Rect,
    clip: ClipChainId,
    target_w: u32,
    target_h: u32,
) -> Option<RoiPx> {
    let clip_rect = list
        .clips
        .iter()
        .find(|node| node.id == clip)
        .map(|node| node.rect)
        .unwrap_or(roi);
    let x = roi.x.max(clip_rect.x).max(0.0).floor() as u32;
    let y = roi.y.max(clip_rect.y).max(0.0).floor() as u32;
    let x1 = roi.x1().min(clip_rect.x1()).min(target_w as f32).ceil() as u32;
    let y1 = roi.y1().min(clip_rect.y1()).min(target_h as f32).ceil() as u32;
    if x1 <= x || y1 <= y {
        return None;
    }
    Some(RoiPx {
        x,
        y,
        w: (x1 - x).min(GLASS_SNAPSHOT_MAX),
        h: (y1 - y).min(GLASS_SNAPSHOT_MAX),
    })
}

fn glass_events(list: &NeoDisplayList, barrier: &GlassBoundary) -> Vec<TimelineKind> {
    let ordinal = crate::scene_d1b::glass_ordinal(list, barrier.id);
    let follow = crate::scene_d1b::is_last_glass(list, barrier.id)
        && crate::scene_d1b::list_has_moving_sample(list);
    let roi_rect = if follow {
        crate::scene_d1b::glass_b_follow_roi_in(0, barrier.roi)
    } else {
        barrier.roi
    };
    let Some(roi) = resolved_glass_roi(list, roi_rect, barrier.clip_chain, list.width, list.height)
    else {
        return Vec::new();
    };
    vec![
        TimelineKind::RoiCopyAccumulatorToSnapshot {
            barrier: ordinal,
            x: roi.x,
            y: roi.y,
            w: roi.w,
            h: roi.h,
        },
        TimelineKind::GlassSampleSnapshotWriteAccumulator {
            barrier: ordinal,
            x: roi.x,
            y: roi.y,
            w: roi.w,
            h: roi.h,
            generation: if follow { Some(0) } else { None },
        },
    ]
}

/// Expected first-frame API order from the compiled pass graph.
pub fn expected_first_frame(list: &NeoDisplayList) -> Result<Vec<TimelineKind>, GraphError> {
    let passes = compile_passes(list)?;
    let mut events = vec![TimelineKind::ClearAccumulator];
    for pass in passes {
        match pass {
            CompiledPass::Raster { chunks, .. } => {
                events.push(TimelineKind::RasterToVello {
                    chunk_count: u32::try_from(chunks.len()).unwrap_or(u32::MAX),
                });
                events.push(TimelineKind::BlitVelloToAccumulator);
            }
            CompiledPass::Glass { barrier, .. } => {
                events.extend(glass_events(list, &barrier));
            }
            CompiledPass::MovingSample { chunk, .. } => {
                let x = chunk.bounds.x.max(0.0).floor() as u32;
                let y = chunk.bounds.y.max(0.0).floor() as u32;
                let w = chunk.bounds.width.ceil() as u32;
                let h = chunk.bounds.height.ceil() as u32;
                events.push(TimelineKind::MovingSampleBlit {
                    x,
                    y,
                    w,
                    h,
                    generation: 0,
                });
            }
        }
    }
    Ok(events)
}

/// Compact D1a golden: wallpaper → glass A → UI → scoped UI → glass B → overlay.
pub const D1A_GOLDEN_TIMELINE: &str =
    "clear,raster,blit,roi:1,glass:1,raster,blit,raster,blit,roi:2,glass:2,raster,blit";

/// D1b golden: same cut with a compositor moving blit before glass B (frame 0 / g0).
pub const D1B_GOLDEN_TIMELINE: &str =
    "clear,raster,blit,roi:1,glass:1,raster,blit,raster,blit,moving:g0,roi:2,glass:2:g0,raster,blit";

/// Motion-only path recorded at the capture generation (no Vello rebuild).
pub const D1B_MOTION_TIMELINE_G120: &str = "restore,moving:g120,roi:2,glass:2:g120,overlay";

pub fn expected_motion_frame(list: &NeoDisplayList, frame: u64) -> Vec<TimelineKind> {
    let moving = crate::scene_d1b::moving_bounds(frame);
    let x = moving.x.max(0.0).floor() as u32;
    let y = moving.y.max(0.0).floor() as u32;
    let w = crate::scene_d1b::MOVING_SIZE;
    let h = crate::scene_d1b::MOVING_SIZE;
    let last = crate::scene_d1b::last_glass(list);
    let ordinal = last
        .map(|barrier| crate::scene_d1b::glass_ordinal(list, barrier.id))
        .unwrap_or(2);
    let roi_rect = crate::scene_d1b::last_glass_follow_roi(list, frame);
    let clip = last
        .map(|barrier| barrier.clip_chain)
        .unwrap_or(crate::display_list::ClipChainId(0));
    let Some(roi) = resolved_glass_roi(list, roi_rect, clip, list.width, list.height) else {
        return Vec::new();
    };
    vec![
        TimelineKind::RestoreStaticPrefix,
        TimelineKind::MovingSampleBlit {
            x,
            y,
            w,
            h,
            generation: frame,
        },
        TimelineKind::RoiCopyAccumulatorToSnapshot {
            barrier: ordinal,
            x: roi.x,
            y: roi.y,
            w: roi.w,
            h: roi.h,
        },
        TimelineKind::GlassSampleSnapshotWriteAccumulator {
            barrier: ordinal,
            x: roi.x,
            y: roi.y,
            w: roi.w,
            h: roi.h,
            generation: Some(frame),
        },
        TimelineKind::OverlayBlitFromCache,
    ]
}

pub fn two_glass_passes_sample_accumulator(events: &[TimelineKind]) -> bool {
    let copies: Vec<_> = events
        .iter()
        .filter(|event| event.reads_accumulator())
        .collect();
    let glasses: Vec<_> = events
        .iter()
        .filter(|event| event.samples_snapshot())
        .collect();
    if copies.len() != 2 || glasses.len() != 2 {
        return false;
    }
    matches!(
        (copies[0], glasses[0], copies[1], glasses[1]),
        (
            TimelineKind::RoiCopyAccumulatorToSnapshot { barrier: 1, .. },
            TimelineKind::GlassSampleSnapshotWriteAccumulator { barrier: 1, .. },
            TimelineKind::RoiCopyAccumulatorToSnapshot { barrier: 2, .. },
            TimelineKind::GlassSampleSnapshotWriteAccumulator { barrier: 2, .. },
        )
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene_d1a::static_d1a_scene;

    #[test]
    fn d1a_expected_timeline_is_the_golden_cut() {
        let scene = static_d1a_scene();
        let events = expected_first_frame(&scene).expect("valid D1a list");
        assert_eq!(encode_timeline(&events), D1A_GOLDEN_TIMELINE);
        assert!(two_glass_passes_sample_accumulator(&events));
        assert_eq!(
            compositor_owned_bytes(scene.width, scene.height),
            u64::from(scene.width) * u64::from(scene.height) * 8
                + u64::from(GLASS_SNAPSHOT_MAX) * u64::from(GLASS_SNAPSHOT_MAX) * 4
        );
    }

    #[test]
    fn glass_a_roi_is_140x80_before_ui() {
        let scene = static_d1a_scene();
        let events = expected_first_frame(&scene).expect("valid D1a list");
        let first_copy = events
            .iter()
            .find_map(|event| match event {
                TimelineKind::RoiCopyAccumulatorToSnapshot {
                    barrier: 1,
                    x,
                    y,
                    w,
                    h,
                } => Some((*x, *y, *w, *h)),
                _ => None,
            })
            .expect("glass A copy");
        assert_eq!(first_copy, (24, 40, 140, 80));
    }

    #[test]
    fn glass_b_keeps_a_bounded_roi() {
        let scene = static_d1a_scene();
        let events = expected_first_frame(&scene).expect("valid D1a list");
        let second = events
            .iter()
            .find_map(|event| match event {
                TimelineKind::GlassSampleSnapshotWriteAccumulator {
                    barrier: 2, w, h, ..
                } => Some((*w, *h)),
                _ => None,
            })
            .expect("glass B sample");
        assert!(second.0 <= GLASS_SNAPSHOT_MAX);
        assert!(second.1 <= GLASS_SNAPSHOT_MAX);
        assert_eq!(second, (140, 80));
    }

    #[test]
    fn d1b_expected_timeline_inserts_moving_before_glass_b() {
        let scene = crate::scene_d1b::static_d1b_scene();
        let events = expected_first_frame(&scene).expect("valid D1b list");
        assert_eq!(encode_timeline(&events), D1B_GOLDEN_TIMELINE);
        assert!(two_glass_passes_sample_accumulator(&events));
        let moving = events
            .iter()
            .position(|event| matches!(event, TimelineKind::MovingSampleBlit { .. }));
        let glass_b = events.iter().position(|event| {
            matches!(
                event,
                TimelineKind::RoiCopyAccumulatorToSnapshot { barrier: 2, .. }
            )
        });
        assert!(moving.expect("moving") < glass_b.expect("glass B"));
    }

    #[test]
    fn d1b_motion_timeline_at_g120_skips_vello() {
        let scene = crate::scene_d1b::static_d1b_scene();
        let events = expected_motion_frame(&scene, crate::scene_d1b::D1B_CAPTURE_FRAME);
        assert_eq!(encode_timeline(&events), D1B_MOTION_TIMELINE_G120);
        assert!(!encode_timeline(&events).contains("raster"));
    }

    #[test]
    fn capture_labels_name_clear_blit_glass_and_roi_reads() {
        assert_eq!(CAPTURE_PASS_CLEAR, "m0-d1a-clear-acc");
        assert_eq!(CAPTURE_PASS_BLIT, "m0-d1a-blit-pass");
        assert_eq!(CAPTURE_PASS_GLASS, "m0-d1a-glass-pass");
        assert_eq!(CAPTURE_GROUP_ROI_PREFIX, "m0-d1a-roi-read");
        assert_eq!(ACCUMULATOR_LABEL, "m0-d1a-accumulator");
        assert_eq!(SNAPSHOT_LABEL, "m0-d1a-glass-roi");
        assert_eq!(CAPTURE_PASS_MOVING, "m0-d1b-moving-blit");
        assert_eq!(CAPTURE_GROUP_D1B_ROI_PREFIX, "m0-d1b-roi-read");
        assert_eq!(CAPTURE_GROUP_D1B_GLASS_PREFIX, "m0-d1b-glass");
        assert_eq!(CAPTURE_PASS_RESTORE, "m0-d1b-restore-static");
        assert_eq!(CAPTURE_GROUP_D2_ROI_PREFIX, "m0-d2-roi-read");
        assert_eq!(CAPTURE_GROUP_D2_GLASS_PREFIX, "m0-d2-glass");
        assert_eq!(CAPTURE_PASS_D2_MOVING, "m0-d2-moving-blit");
        assert_eq!(CAPTURE_PASS_D2_RESTORE, "m0-d2-restore-static");
        assert_eq!(CAPTURE_PASS_D2_OVERLAY, "m0-d2-overlay-blit");
        assert_eq!(
            D1B_MOTION_TIMELINE_G120,
            "restore,moving:g120,roi:2,glass:2:g120,overlay"
        );
    }
}
