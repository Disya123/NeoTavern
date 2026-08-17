//! First-frame wgpu API timeline for the D1a probe.
//!
//! This is a **host-recorded command log** with named resources. It is not an
//! AGI/RenderDoc GPU capture and MUST NOT flip `android_gpu_capture`. RFC 4.6
//! treats it as partial evidence of pass/resource order at the API the probe
//! submitted.

use crate::display_list::{ClipChainId, GlassBoundary, NeoDisplayList, Rect};
use crate::pass_graph::{compile_passes, CompiledPass, GraphError};

/// Max glass ROI copy into the sampleable snapshot (D1a ROIs are 140×80).
pub const GLASS_SNAPSHOT_MAX: u32 = 256;

pub const ACCUMULATOR_LABEL: &str = "m0-d1a-accumulator";
pub const VELLO_LABEL: &str = "m0-d1a-vello";
pub const SNAPSHOT_LABEL: &str = "m0-d1a-glass-roi";

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
    },
}

impl TimelineKind {
    pub fn token(&self) -> String {
        match self {
            Self::ClearAccumulator => "clear".to_string(),
            Self::RasterToVello { .. } => "raster".to_string(),
            Self::BlitVelloToAccumulator => "blit".to_string(),
            Self::RoiCopyAccumulatorToSnapshot { barrier, .. } => format!("roi:{barrier}"),
            Self::GlassSampleSnapshotWriteAccumulator { barrier, .. } => {
                format!("glass:{barrier}")
            }
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
    let Some(roi) = resolved_glass_roi(
        list,
        barrier.roi,
        barrier.clip_chain,
        list.width,
        list.height,
    ) else {
        return Vec::new();
    };
    vec![
        TimelineKind::RoiCopyAccumulatorToSnapshot {
            barrier: barrier.id.0,
            x: roi.x,
            y: roi.y,
            w: roi.w,
            h: roi.h,
        },
        TimelineKind::GlassSampleSnapshotWriteAccumulator {
            barrier: barrier.id.0,
            x: roi.x,
            y: roi.y,
            w: roi.w,
            h: roi.h,
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
        }
    }
    Ok(events)
}

/// Compact D1a golden: wallpaper → glass A → UI → scoped UI → glass B → overlay.
pub const D1A_GOLDEN_TIMELINE: &str =
    "clear,raster,blit,roi:1,glass:1,raster,blit,raster,blit,roi:2,glass:2,raster,blit";

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
}
