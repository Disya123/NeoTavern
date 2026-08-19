//! GPU Vello diagnostics: fresh targets, unique UI base_color, error scopes.

use vello::peniko::Color;
use vello::Scene;

use crate::vello_gpu::coarse_bin_count;

/// Diagnostic UI clear. Not a product token. If this is what you see, Vello
/// submitted and wrote `base_color` but not scene paths.
pub const UI_BASE_COLOR: Color = Color::from_rgb8(0x3d, 0x5c, 0xff);
pub const UI_BASE_RGBA: [u8; 4] = [0x3d, 0x5c, 0xff, 0xff];
pub const RECT_RGBA: [u8; 4] = [0xe3, 0x8a, 0x62, 0xff];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SampleClass {
    BlackNoSubmit,
    BaseColorOnly,
    RetainedRect,
    PathsWrote,
}

impl SampleClass {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BlackNoSubmit => "black_no_submit",
            Self::BaseColorOnly => "base_color_only",
            Self::RetainedRect => "retained_rect",
            Self::PathsWrote => "paths_wrote",
        }
    }
}

pub fn approx_rgba(px: [u8; 4], want: [u8; 4]) -> bool {
    px.iter()
        .zip(want)
        .all(|(got, exp)| got.abs_diff(exp) <= 12)
}

pub fn classify_rgba(px: [u8; 4], base: [u8; 4]) -> SampleClass {
    if px == [0, 0, 0, 0] || (px[0] == 0 && px[1] == 0 && px[2] == 0 && px[3] < 8) {
        SampleClass::BlackNoSubmit
    } else if approx_rgba(px, base) {
        SampleClass::BaseColorOnly
    } else if base == UI_BASE_RGBA && approx_rgba(px, RECT_RGBA) {
        SampleClass::RetainedRect
    } else {
        SampleClass::PathsWrote
    }
}

pub fn classify_samples(samples: &[[u8; 4]], base: [u8; 4]) -> SampleClass {
    if samples
        .iter()
        .any(|px| classify_rgba(*px, base) == SampleClass::PathsWrote)
    {
        SampleClass::PathsWrote
    } else if samples
        .iter()
        .any(|px| classify_rgba(*px, base) == SampleClass::RetainedRect)
    {
        SampleClass::RetainedRect
    } else if samples
        .iter()
        .all(|px| classify_rgba(*px, base) == SampleClass::BlackNoSubmit)
    {
        SampleClass::BlackNoSubmit
    } else {
        SampleClass::BaseColorOnly
    }
}

pub fn resolution_ladder(full_w: u32, full_h: u32) -> Vec<(u32, u32, &'static str)> {
    let full_w = full_w.max(1);
    let full_h = full_h.max(1);
    vec![
        (320, 200, "320x200"),
        (640, 400, "640x400"),
        ((full_w / 2).max(1), (full_h / 2).max(1), "half"),
        (full_w, full_h, "full"),
    ]
}

pub fn tile_origins(full_w: u32, full_h: u32, tile_w: u32, tile_h: u32) -> Vec<(u32, u32, u32, u32)> {
    let tile_w = tile_w.max(1);
    let tile_h = tile_h.max(1);
    let mut out = Vec::new();
    let mut y = 0;
    while y < full_h {
        let mut x = 0;
        let th = (full_h - y).min(tile_h);
        while x < full_w {
            let tw = (full_w - x).min(tile_w);
            out.push((x, y, tw, th));
            x += tw;
        }
        y += th;
    }
    out
}

pub fn scene_with_tile_origin(full: &Scene, tile_x: u32, tile_y: u32) -> Scene {
    let mut tile = Scene::new();
    tile.append(
        full,
        Some(vello::kurbo::Affine::translate((
            -f64::from(tile_x),
            -f64::from(tile_y),
        ))),
    );
    tile
}

pub fn encoding_line(scene: &Scene, width: u32, height: u32) -> String {
    let encoding = scene.encoding();
    let tags = encoding.path_tags.len() as u32;
    let glyphs = encoding.resources.glyph_runs.len() as u32;
    let width_in_tiles = width.div_ceil(16);
    let height_in_tiles = height.div_ceil(16);
    let path_tag_wgs = tags.div_ceil(4 * 256);
    format!(
        "encoding paths={} segs={} tags={} clips={} open_clips={} glyphs={} bins={} tiles={}x{} flatten_wgs={} path_reduce_wgs={} large_path_scan={} empty={}",
        encoding.n_paths,
        encoding.n_path_segments,
        tags,
        encoding.n_clips,
        encoding.n_open_clips,
        glyphs,
        coarse_bin_count(width, height),
        width_in_tiles,
        height_in_tiles,
        tags.div_ceil(256),
        path_tag_wgs,
        u8::from(path_tag_wgs > 256),
        u8::from(encoding.is_empty()),
    )
}

pub fn format_error_scopes(
    validation: Option<wgpu::Error>,
    oom: Option<wgpu::Error>,
    internal: Option<wgpu::Error>,
) -> String {
    fn one(label: &str, err: Option<wgpu::Error>) -> String {
        match err {
            Some(err) => format!("{label}={}", err.to_string().replace(' ', "_")),
            None => format!("{label}=ok"),
        }
    }
    format!(
        "{} {} {}",
        one("validation", validation),
        one("oom", oom),
        one("internal", internal),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unique_ui_base_is_not_product_canvas_or_rect() {
        assert_ne!(UI_BASE_RGBA, [0x15, 0x13, 0x11, 0xff]);
        assert_ne!(UI_BASE_RGBA, RECT_RGBA);
        assert_eq!(
            classify_rgba(UI_BASE_RGBA, UI_BASE_RGBA),
            SampleClass::BaseColorOnly
        );
        assert_eq!(
            classify_rgba(RECT_RGBA, UI_BASE_RGBA),
            SampleClass::RetainedRect
        );
        assert_eq!(
            classify_rgba(RECT_RGBA, [0x15, 0x13, 0x11, 0xff]),
            SampleClass::PathsWrote
        );
        assert_eq!(
            classify_rgba([0, 0, 0, 0], UI_BASE_RGBA),
            SampleClass::BlackNoSubmit
        );
        assert_eq!(
            classify_rgba([0x24, 0x21, 0x1e, 0xff], UI_BASE_RGBA),
            SampleClass::PathsWrote
        );
    }

    #[test]
    fn resolution_ladder_ends_at_full_surface() {
        let steps = resolution_ladder(1220, 2712);
        assert_eq!(steps[0], (320, 200, "320x200"));
        assert_eq!(steps[1], (640, 400, "640x400"));
        assert_eq!(steps[2], (610, 1356, "half"));
        assert_eq!(steps[3], (1220, 2712, "full"));
    }

    #[test]
    fn tile_origins_cover_the_surface_without_overlap() {
        let tiles = tile_origins(1220, 2712, 320, 200);
        let area: u64 = tiles
            .iter()
            .map(|(_, _, w, h)| u64::from(*w) * u64::from(*h))
            .sum();
        assert_eq!(area, 1220 * 2712);
        assert_eq!(tiles[0], (0, 0, 320, 200));
    }

    #[test]
    fn tile_origins_xiaomi_half_are_four_quadrants() {
        let tiles = tile_origins(1220, 2712, 610, 1356);
        assert_eq!(
            tiles,
            vec![
                (0, 0, 610, 1356),
                (610, 0, 610, 1356),
                (0, 1356, 610, 1356),
                (610, 1356, 610, 1356),
            ]
        );
    }

    #[test]
    fn tiled_append_offsets_transforms_without_changing_path_counts() {
        use vello::kurbo::{Affine, Rect};
        use vello::peniko::{Color, Fill};
        use vello::Scene;

        let mut full = Scene::new();
        full.fill(
            Fill::NonZero,
            Affine::IDENTITY,
            Color::from_rgb8(0xe3, 0x8a, 0x62),
            None,
            &Rect::new(0.0, 0.0, 100.0, 40.0),
        );
        full.fill(
            Fill::NonZero,
            Affine::translate((0.0, 200.0)),
            Color::from_rgb8(0x24, 0x21, 0x1e),
            None,
            &Rect::new(0.0, 0.0, 100.0, 40.0),
        );
        let src = full.encoding();
        let src_paths = src.n_paths;
        let src_clips = src.n_clips;
        let src_segments = src.n_path_segments;
        assert!(src_paths >= 2);

        for (x, y, _, _) in tile_origins(1220, 2712, 610, 1356) {
            let tile = scene_with_tile_origin(&full, x, y);
            let enc = tile.encoding();
            assert_eq!(enc.n_paths, src_paths);
            assert_eq!(enc.n_clips, src_clips);
            assert_eq!(enc.n_path_segments, src_segments);
            let translated = enc
                .transforms
                .iter()
                .find(|transform| (transform.translation[1] + y as f32).abs() < 0.6)
                .expect("tile_origin translation applied to a scene transform");
            assert!(
                (translated.translation[0] + x as f32).abs() < 0.6,
                "tile origin x={x} y={y} translation={:?}",
                translated.translation
            );
        }

        let seam = scene_with_tile_origin(&full, 0, 200);
        let ty = seam
            .encoding()
            .transforms
            .iter()
            .map(|transform| transform.translation[1])
            .min_by(|a, b| a.partial_cmp(b).unwrap())
            .unwrap();
        assert!(
            (ty + 200.0).abs() < 0.6 || seam.encoding().transforms.iter().any(|t| (t.translation[1] + 200.0).abs() < 0.6),
            "translate(0,-200) must appear in the tiled encoding, got {:?}",
            seam.encoding()
                .transforms
                .iter()
                .map(|t| t.translation)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn samples_prefer_paths_over_base_color() {
        let class = classify_samples(
            &[[0x3d, 0x5c, 0xff, 0xff], [0x24, 0x21, 0x1e, 0xff]],
            UI_BASE_RGBA,
        );
        assert_eq!(class, SampleClass::PathsWrote);
    }
}
