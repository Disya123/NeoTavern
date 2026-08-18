use anyrender::{HostTextCluster, HostTextFragment, HostTextGlyph, HostTextLine, HostTextRun, PaintScene};
use blitz_dom::{BaseDocument, node::TextBrush, util::ToColorColor};
use kurbo::{Affine, Rect, Stroke};
use parley::{Affinity, Cursor, Layout, Line, PositionedLayoutItem, Selection};
use peniko::Fill;
use style::values::computed::TextDecorationLine;

use crate::color::{Color, ToColorColor as _};
use crate::{FONT_EMBOLDEN_ENABLED, SELECTION_COLOR};

/// Draw the backgrounds of inline elements (e.g. `<span style="background: ...">`).
///
/// Each glyph run carries the node id of the innermost inline element it belongs to
/// (via its brush). We look up that node's `background-color` and, if non-transparent,
/// fill a rectangle covering the run's advance and its font's ascent/descent so that the
/// background sits behind the text.
///
/// The inline root's own background is painted separately (as a normal block box), so
/// runs belonging to the root are skipped to avoid drawing it twice.
pub(crate) fn draw_inline_backgrounds<'a>(
    scene: &mut impl PaintScene,
    lines: impl Iterator<Item = Line<'a, TextBrush>>,
    doc: &BaseDocument,
    transform: Affine,
    inline_root_id: usize,
) {
    for line in lines {
        for item in line.items() {
            let PositionedLayoutItem::GlyphRun(glyph_run) = item else {
                continue;
            };

            let node_id = glyph_run.style().brush.id;
            if node_id == inline_root_id {
                continue;
            }

            let Some(styles) = doc.get_node(node_id).and_then(|node| node.primary_styles()) else {
                continue;
            };

            let current_color = styles.clone_color();
            let bg_color = styles
                .get_background()
                .background_color
                .resolve_to_absolute(&current_color)
                .as_srgb_color();
            if bg_color == Color::TRANSPARENT {
                continue;
            }

            let metrics = glyph_run.run().metrics();
            let x = glyph_run.offset() as f64;
            let w = glyph_run.advance() as f64;
            let baseline = glyph_run.baseline() as f64;
            let y0 = baseline - metrics.ascent as f64;
            let y1 = baseline + metrics.descent as f64;
            let rect = Rect::new(x, y0, x + w, y1);

            scene.fill(Fill::NonZero, transform, bg_color, None, &rect);
        }
    }
}

pub(crate) fn stroke_text<'a>(
    scene: &mut impl PaintScene,
    lines: impl Iterator<Item = Line<'a, TextBrush>>,
    doc: &BaseDocument,
    transform: Affine,
    scale: f64,
) {
    for line in lines {
        for item in line.items() {
            if let PositionedLayoutItem::GlyphRun(glyph_run) = item {
                let run = glyph_run.run();
                let font = run.font();
                let font_size = run.font_size();
                let metrics = run.metrics();
                let style = glyph_run.style();
                let synthesis = run.synthesis();
                let glyph_xform = synthesis
                    .skew()
                    .map(|angle| Affine::skew(angle.to_radians().tan() as f64, 0.0));

                // Styles
                let styles = doc
                    .get_node(style.brush.id)
                    .unwrap()
                    .primary_styles()
                    .unwrap();
                let itext_styles = styles.get_inherited_text();
                let text_styles = styles.get_text();
                let text_color = itext_styles.color.as_color_color();
                let text_decoration_color = text_styles
                    .text_decoration_color
                    .as_absolute()
                    .map(ToColorColor::as_color_color)
                    .unwrap_or(text_color);
                let text_decoration_brush = anyrender::Paint::from(text_decoration_color);
                let text_decoration_line = text_styles.text_decoration_line;
                let has_underline = text_decoration_line.contains(TextDecorationLine::UNDERLINE);
                let has_strikethrough =
                    text_decoration_line.contains(TextDecorationLine::LINE_THROUGH);

                let embolden = if FONT_EMBOLDEN_ENABLED {
                    let fs = font_size as f64 / scale;
                    kurbo::Vec2::new((0.015125 * fs).min(0.3), (0.0121 * fs).min(0.3))
                } else {
                    kurbo::Vec2::default()
                };

                scene.draw_glyphs(
                    font,
                    font_size,
                    !FONT_EMBOLDEN_ENABLED, // hint
                    run.normalized_coords(),
                    embolden,
                    Fill::NonZero,
                    &anyrender::Paint::from(text_color),
                    1.0, // alpha
                    transform,
                    glyph_xform,
                    glyph_run.positioned_glyphs().map(|glyph| anyrender::Glyph {
                        id: glyph.id as _,
                        x: glyph.x,
                        y: glyph.y,
                    }),
                );

                let mut draw_decoration_line =
                    |offset: f32, size: f32, brush: &anyrender::Paint| {
                        let x = glyph_run.offset() as f64;
                        let w = glyph_run.advance() as f64;
                        let y = (glyph_run.baseline() - offset + size / 2.0) as f64;
                        let line = kurbo::Line::new((x, y), (x + w, y));
                        scene.stroke(&Stroke::new(size as f64), transform, brush, None, &line)
                    };

                if has_underline {
                    let offset = metrics.underline_offset;
                    let size = metrics.underline_size;

                    // TODO: intercept line when crossing an descending character like "gqy"
                    draw_decoration_line(offset, size, &text_decoration_brush);
                }
                if has_strikethrough {
                    let offset = metrics.strikethrough_offset;
                    let size = metrics.strikethrough_size;

                    draw_decoration_line(offset, size, &text_decoration_brush);
                }
            }
        }
    }
}

/// Draw selection highlight rectangles for the given byte range in a layout.
/// Uses Parley's Selection type for accurate geometry calculation.
pub(crate) fn draw_text_selection(
    scene: &mut impl PaintScene,
    layout: &Layout<TextBrush>,
    transform: Affine,
    selection_start: usize,
    selection_end: usize,
) {
    let anchor = Cursor::from_byte_index(layout, selection_start, Affinity::Downstream);
    let focus = Cursor::from_byte_index(layout, selection_end, Affinity::Downstream);
    let selection = Selection::new(anchor, focus);

    selection.geometry_with(layout, |rect, _line_idx| {
        let rect = kurbo::Rect::new(rect.x0, rect.y0, rect.x1, rect.y1);
        scene.fill(Fill::NonZero, transform, SELECTION_COLOR, None, &rect);
    });
}

/// Replay Parley's already-shaped layout. Does not call the shaper.
pub(crate) fn emit_host_text_fragment(
    scene: &mut impl PaintScene,
    layout: &Layout<TextBrush>,
    node_id: usize,
    transform: Affine,
) {
    scene.host_text_fragment(collect_host_text(layout, node_id, transform));
}

fn collect_host_text(
    layout: &Layout<TextBrush>,
    node_id: usize,
    transform: Affine,
) -> HostTextFragment {
    let local = kurbo::Rect::new(0.0, 0.0, layout.width() as f64, layout.height() as f64);
    let mut runs = Vec::new();
    let mut clusters = Vec::new();
    let mut lines = Vec::new();
    let mut logical_keys = Vec::new();
    let mut visual_keys = Vec::new();
    let mut run_id = 0u64;
    let mut logical_end = 0u32;

    let sx = affine_scale_x(transform).abs().max(1e-6);
    let sy = affine_scale_y(transform).abs().max(1e-6);

    for line in layout.lines() {
        let metrics = line.metrics();
        let range = line.text_range();
        let local_origin_x = metrics.offset + metrics.inline_min_coord;
        let (origin_x, origin_y) = map_xy(transform, local_origin_x, metrics.baseline);
        lines.push(HostTextLine {
            logical_start: range.start as u32,
            logical_end: range.end as u32,
            origin_x,
            origin_y,
            width: metrics.advance * sx,
            ascent: metrics.ascent * sy,
            descent: metrics.descent * sy,
            baseline: origin_y,
        });
        logical_end = logical_end.max(range.end as u32);

        let mut visual_x = local_origin_x;
        for run in line.runs() {
            let font_key = font_key(run.font());
            let rtl = run.is_rtl();
            let mut glyphs = Vec::new();
            for cluster in run.visual_clusters() {
                let cluster_range = cluster.text_range();
                let emoji = cluster.is_emoji();
                let mut gx = visual_x;
                for glyph in cluster.glyphs() {
                    let (x, y) = map_xy(transform, gx + glyph.x, metrics.baseline + glyph.y);
                    glyphs.push(HostTextGlyph {
                        glyph_id: glyph.id,
                        cluster: cluster_range.start as u32,
                        x,
                        y,
                        advance: glyph.advance * sx,
                        font_key,
                        color_emoji: emoji,
                    });
                    gx += glyph.advance;
                }
                visual_x += cluster.advance();
            }

            let text_range = run.text_range();
            runs.push(HostTextRun {
                run_id,
                logical_start: text_range.start as u32,
                logical_end: text_range.end as u32,
                visual_order: run_id as u32,
                bidi_level: if rtl { 1 } else { 0 },
                rtl,
                glyphs,
            });
            run_id = run_id.saturating_add(1);

            for cluster in run.clusters() {
                let cluster_range = cluster.text_range();
                let ligature = cluster.is_ligature_start() || cluster.is_ligature_continuation();
                let combining = cluster.glyphs().any(|glyph| glyph.advance == 0.0)
                    && cluster.glyphs().count() > 1
                    && !ligature;
                clusters.push(HostTextCluster {
                    logical_start: cluster_range.start as u32,
                    logical_end: cluster_range.end as u32,
                    caret_stop: !cluster.is_ligature_continuation(),
                    ligature,
                    combining,
                });
                logical_keys.push(cluster_range.start);
            }
            for cluster in run.visual_clusters() {
                visual_keys.push(cluster.text_range().start);
            }
        }
    }

    let logical_to_visual = logical_keys
        .iter()
        .map(|key| {
            visual_keys
                .iter()
                .position(|visual| visual == key)
                .unwrap_or(0) as u32
        })
        .collect();
    let visual_to_logical = visual_keys
        .iter()
        .map(|key| {
            logical_keys
                .iter()
                .position(|logical| logical == key)
                .unwrap_or(0) as u32
        })
        .collect();

    HostTextFragment {
        node_id: node_id as u64,
        bounds: transform.transform_rect_bbox(local),
        logical_end,
        runs,
        clusters,
        lines,
        logical_to_visual,
        visual_to_logical,
    }
}

fn font_key(font: &parley::FontData) -> u64 {
    let bytes: &[u8] = font.data.as_ref();
    bytes.as_ptr() as u64 ^ ((bytes.len() as u64) << 1)
}

fn map_xy(transform: Affine, x: f32, y: f32) -> (f32, f32) {
    let point = transform * kurbo::Point::new(f64::from(x), f64::from(y));
    (point.x as f32, point.y as f32)
}

fn affine_scale_x(transform: Affine) -> f32 {
    let origin = transform * kurbo::Point::ORIGIN;
    let axis = transform * kurbo::Point::new(1.0, 0.0);
    (axis.x - origin.x) as f32
}

fn affine_scale_y(transform: Affine) -> f32 {
    let origin = transform * kurbo::Point::ORIGIN;
    let axis = transform * kurbo::Point::new(0.0, 1.0);
    (axis.y - origin.y) as f32
}
