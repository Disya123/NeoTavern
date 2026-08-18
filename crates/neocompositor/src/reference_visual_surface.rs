//! Trusted B-level VisualSurface producer (ADR-0050 / PERF-15).
//!
//! Independent high-frequency source: deforming two-bone textured mesh,
//! atlas, and alpha layers. Submits only through [`crate::visual_surface`].
//! Not Plugin SDK, not D1b checkerboard, not a solid synthetic fill.

use std::collections::VecDeque;

use crate::display_list::Rect;
use crate::epoch::PresentationTime;

pub const REFERENCE_VISUAL_SURFACE_PRODUCER: &str = "reference-visual-surface";
pub const WIRE_SURFACE_ID: &str = "vs.reference";
pub const PRODUCER_QUEUE_CAP: usize = 1;
pub const REFERENCE_SURFACE_WIDTH: u32 = 128;
pub const REFERENCE_SURFACE_HEIGHT: u32 = 128;
pub const ATLAS_SIZE: u32 = 128;
pub const LAYER_COUNT: usize = 3;
const SEGMENTS: usize = 8;
const BONE_LEN_0: f32 = 46.0;
const BONE_LEN_1: f32 = 40.0;
const RIBBON_HALF: f32 = 11.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ReferenceVertex {
    pub x: f32,
    pub y: f32,
    pub u: f32,
    pub v: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ReferenceLayer {
    pub alpha: f32,
    pub uv_min: [f32; 2],
    pub uv_max: [f32; 2],
}

#[derive(Clone, Debug, PartialEq)]
pub struct ReferenceSurfaceWork {
    pub sequence: u64,
    pub timestamp: PresentationTime,
    pub vertices: Vec<ReferenceVertex>,
    pub indices: Vec<u16>,
    pub layers: [ReferenceLayer; LAYER_COUNT],
    pub atlas_rgba: Vec<u8>,
    pub damage: Rect,
    pub width: u32,
    pub height: u32,
}

pub struct ReferenceVisualSurfaceProducer {
    queue: VecDeque<ReferenceSurfaceWork>,
    cap: usize,
    sequence: u64,
    prev_bounds: Option<Rect>,
    dropped: u64,
}

impl ReferenceVisualSurfaceProducer {
    pub fn new() -> Self {
        Self {
            queue: VecDeque::with_capacity(PRODUCER_QUEUE_CAP),
            cap: PRODUCER_QUEUE_CAP,
            sequence: 0,
            prev_bounds: None,
            dropped: 0,
        }
    }

    pub fn producer_name() -> &'static str {
        REFERENCE_VISUAL_SURFACE_PRODUCER
    }

    pub fn plugin_runtime() -> bool {
        false
    }

    pub fn direct_display_list_injection() -> bool {
        false
    }

    pub fn surface_frame_ingress() -> bool {
        true
    }

    pub fn queue_cap(&self) -> usize {
        self.cap
    }

    pub fn queued(&self) -> usize {
        self.queue.len()
    }

    pub fn dropped(&self) -> u64 {
        self.dropped
    }

    pub fn tick(&mut self, timestamp: PresentationTime) -> &ReferenceSurfaceWork {
        self.sequence = self.sequence.saturating_add(1);
        let work = build_work(self.sequence, timestamp, &mut self.prev_bounds);
        if self.queue.len() >= self.cap {
            self.queue.clear();
            self.dropped = self.dropped.saturating_add(1);
        }
        self.queue.push_back(work);
        self.queue.back().expect("producer queued a frame")
    }

    pub fn take_latest(&mut self) -> Option<ReferenceSurfaceWork> {
        let latest = self.queue.pop_back();
        self.queue.clear();
        latest
    }
}

impl Default for ReferenceVisualSurfaceProducer {
    fn default() -> Self {
        Self::new()
    }
}

fn build_work(
    sequence: u64,
    timestamp: PresentationTime,
    prev_bounds: &mut Option<Rect>,
) -> ReferenceSurfaceWork {
    let t = sequence as f32 * 0.17;
    let (vertices, bounds) = deform_rig(t);
    let indices = ribbon_indices();
    let damage = match *prev_bounds {
        Some(prev) => union_rect(prev, bounds),
        None => bounds,
    };
    *prev_bounds = Some(bounds);
    let scroll = 0.03 * t.sin();
    ReferenceSurfaceWork {
        sequence,
        timestamp,
        vertices,
        indices,
        layers: [
            ReferenceLayer {
                alpha: 1.0,
                uv_min: [0.0, 0.0],
                uv_max: [0.5, 0.5],
            },
            ReferenceLayer {
                alpha: 0.55,
                uv_min: [0.5 + scroll, 0.0],
                uv_max: [1.0 + scroll, 0.5],
            },
            ReferenceLayer {
                alpha: 0.38,
                uv_min: [0.0, 0.5],
                uv_max: [0.5, 1.0],
            },
        ],
        atlas_rgba: paint_atlas(),
        damage,
        width: REFERENCE_SURFACE_WIDTH,
        height: REFERENCE_SURFACE_HEIGHT,
    }
}

fn deform_rig(t: f32) -> (Vec<ReferenceVertex>, Rect) {
    let shoulder = (64.0, 108.0);
    let a0 = -1.35 + 0.28 * t.sin();
    let elbow = offset(shoulder, a0, BONE_LEN_0);
    let a1 = a0 + 0.85 * (t * 1.7 + 0.4).sin();
    let wrist = offset(elbow, a1, BONE_LEN_1);
    let mut vertices = Vec::with_capacity((SEGMENTS + 1) * 2);
    let mut min_x = f32::MAX;
    let mut min_y = f32::MAX;
    let mut max_x = f32::MIN;
    let mut max_y = f32::MIN;
    for i in 0..=SEGMENTS {
        let u = i as f32 / SEGMENTS as f32;
        let (px, py, ang) = if u <= 0.5 {
            let s = u * 2.0;
            (
                lerp(shoulder.0, elbow.0, s),
                lerp(shoulder.1, elbow.1, s),
                a0,
            )
        } else {
            let s = (u - 0.5) * 2.0;
            (lerp(elbow.0, wrist.0, s), lerp(elbow.1, wrist.1, s), a1)
        };
        let nx = -ang.sin();
        let ny = ang.cos();
        let left = ReferenceVertex {
            x: px + nx * RIBBON_HALF,
            y: py + ny * RIBBON_HALF,
            u,
            v: 0.0,
        };
        let right = ReferenceVertex {
            x: px - nx * RIBBON_HALF,
            y: py - ny * RIBBON_HALF,
            u,
            v: 1.0,
        };
        grow(&mut min_x, &mut min_y, &mut max_x, &mut max_y, left);
        grow(&mut min_x, &mut min_y, &mut max_x, &mut max_y, right);
        vertices.push(left);
        vertices.push(right);
    }
    let bounds = Rect::new(
        min_x,
        min_y,
        (max_x - min_x).max(1.0),
        (max_y - min_y).max(1.0),
    );
    (vertices, bounds)
}

fn ribbon_indices() -> Vec<u16> {
    let mut indices = Vec::with_capacity(SEGMENTS * 6);
    for i in 0..SEGMENTS {
        let i0 = (i * 2) as u16;
        indices.extend_from_slice(&[i0, i0 + 1, i0 + 2, i0 + 1, i0 + 3, i0 + 2]);
    }
    indices
}

fn paint_atlas() -> Vec<u8> {
    let w = ATLAS_SIZE as usize;
    let mut pixels = vec![0u8; w * w * 4];
    for y in 0..w {
        for x in 0..w {
            let tile_x = x / 64;
            let tile_y = y / 64;
            let lx = (x % 64) as f32 / 63.0;
            let ly = (y % 64) as f32 / 63.0;
            let (r, g, b, a) = match (tile_x, tile_y) {
                (0, 0) => {
                    let d = ((lx - 0.35).hypot(ly - 0.4) * 1.4).min(1.0);
                    let spot = ((lx * 9.0).sin() * (ly * 7.0).cos() * 0.5 + 0.5) * 40.0;
                    (
                        (186.0 - d * 50.0 + spot) as u8,
                        (92.0 - d * 20.0) as u8,
                        (48.0 + (1.0 - d) * 30.0) as u8,
                        255,
                    )
                }
                (1, 0) => {
                    let stripe = ((lx + ly) * 8.0).sin().abs();
                    (
                        (40.0 + stripe * 90.0) as u8,
                        (120.0 + stripe * 80.0) as u8,
                        (200.0 - stripe * 40.0) as u8,
                        180,
                    )
                }
                (0, 1) => {
                    let veil = (1.0 - (lx - 0.5).hypot(ly - 0.5) * 1.6).clamp(0.0, 1.0);
                    (255, 220, 240, (veil * 160.0) as u8)
                }
                _ => {
                    let rim = (lx.max(ly)).powf(2.4);
                    (255, 240, 180, (rim * 200.0) as u8)
                }
            };
            let i = (y * w + x) * 4;
            pixels[i] = r;
            pixels[i + 1] = g;
            pixels[i + 2] = b;
            pixels[i + 3] = a;
        }
    }
    pixels
}

pub fn atlas_is_checkerboard(rgba: &[u8], width: u32, height: u32) -> bool {
    if width < 4 || height < 4 {
        return false;
    }
    let w = width as usize;
    let px = |x: usize, y: usize| -> [u8; 4] {
        let i = (y * w + x) * 4;
        [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
    };
    let a = px(0, 0);
    let b = px(1, 0);
    if a == b {
        return false;
    }
    for y in 0..4 {
        for x in 0..4 {
            let expect = if (x + y) % 2 == 0 { a } else { b };
            if px(x, y) != expect {
                return false;
            }
        }
    }
    true
}

fn offset(origin: (f32, f32), angle: f32, len: f32) -> (f32, f32) {
    (origin.0 + angle.cos() * len, origin.1 + angle.sin() * len)
}

fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

fn grow(min_x: &mut f32, min_y: &mut f32, max_x: &mut f32, max_y: &mut f32, v: ReferenceVertex) {
    *min_x = min_x.min(v.x);
    *min_y = min_y.min(v.y);
    *max_x = max_x.max(v.x);
    *max_y = max_y.max(v.y);
}

fn union_rect(a: Rect, b: Rect) -> Rect {
    let x = a.x.min(b.x);
    let y = a.y.min(b.y);
    let x1 = a.x1().max(b.x1());
    let y1 = a.y1().max(b.y1());
    Rect::new(x, y, x1 - x, y1 - y)
}
