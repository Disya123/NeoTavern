//! Parley text engine (ADR-0057 platform spec §3): shaping, measurement and
//! caret geometry. One engine owns the golden font context (packed design
//! system faces); every text measurement and every caret position in the
//! frame pipeline comes from here — the snapshot never invents text
//! geometry (INV-2) and nothing outside this module shapes text.

use parley::layout::{Cluster, ClusterSide};
use parley::{
    Alignment, AlignmentOptions, FontContext, FontFamily, FontWeight, Layout, LayoutContext,
    StyleProperty,
};

use crate::scene::TextRun;
use crate::style::TextTokens;
use crate::theme::Theme;
/// Shaped, line-broken text. Owns the Parley layout so the snapshot can
/// answer caret and hit queries from the same data that paints (INV-2).
pub struct ShapedText {
    layout: Layout<[u8; 4]>,
    text: String,
    size_px: f32,
}

/// One caret position in text-local coordinates (CSS px, y down).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CaretGeometry {
    /// Byte index the caret belongs to.
    pub byte_index: usize,
    /// Caret x within the text block.
    pub x: f32,
    /// Top of the caret line.
    pub y_top: f32,
    /// Baseline of the caret line.
    pub y_baseline: f32,
    /// Bottom of the caret line.
    pub y_bottom: f32,
    /// Line alignment offset (leading side gap of the line box).
    pub line_offset: f32,
}

/// The engine: shared font database + layout scratch space, constructed
/// once per host.
pub struct TextEngine {
    font_ctx: FontContext,
    layout_ctx: LayoutContext<[u8; 4]>,
}

impl Default for TextEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl TextEngine {
    /// Uses the product font context: golden Outfit / Onest / JetBrains
    /// Mono, system fonts off (see the design system crate).
    pub fn new() -> Self {
        Self {
            font_ctx: neotavern_presentation_design_system::product_font_context(),
            layout_ctx: LayoutContext::new(),
        }
    }

    /// Shapes `runs` with the theme's type ramp and line-breaks at
    /// `max_width` (None → no wrapping). Font stacks, sizes and weights are
    /// theme-resolved tokens — never literals (AGENTS §14).
    pub fn shape(&mut self, runs: &[TextRun], theme: &Theme, max_width: Option<f32>) -> ShapedText {
        let (text, default_tokens) = if runs.is_empty() {
            (String::new(), TextTokens::body())
        } else {
            (
                runs.iter().map(|r| r.text.as_str()).collect::<String>(),
                runs[0].tokens.clone(),
            )
        };
        let default_size = theme.font_size(default_tokens.size);
        let default_weight = FontWeight::new(theme.font_weight(default_tokens.weight));
        let default_family = theme.font_family(default_tokens.stack).to_string();
        let mut builder = self
            .layout_ctx
            .ranged_builder(&mut self.font_ctx, &text, 1.0, true);
        builder.push_default(StyleProperty::FontSize(default_size));
        builder.push_default(StyleProperty::FontWeight(default_weight));
        builder.push_default(StyleProperty::FontFamily(FontFamily::Source(
            std::borrow::Cow::Owned(default_family),
        )));
        // Per-run overrides (color resolves at paint; size/weight/stack
        // affect shaping).
        let mut offset = 0usize;
        for run in runs {
            let len = run.text.len();
            if len > 0 && run.tokens.size != default_tokens.size {
                builder.push(
                    StyleProperty::FontSize(theme.font_size(run.tokens.size)),
                    offset..offset + len,
                );
            }
            if len > 0 && run.tokens.weight != default_tokens.weight {
                builder.push(
                    StyleProperty::FontWeight(FontWeight::new(
                        theme.font_weight(run.tokens.weight),
                    )),
                    offset..offset + len,
                );
            }
            if len > 0 && run.tokens.stack != default_tokens.stack {
                builder.push(
                    StyleProperty::FontFamily(FontFamily::Source(std::borrow::Cow::Owned(
                        theme.font_family(run.tokens.stack).to_string(),
                    ))),
                    offset..offset + len,
                );
            }
            offset += len;
        }
        let mut layout = builder.build(&text);
        layout.break_all_lines(max_width);
        layout.align(Alignment::Start, AlignmentOptions::default());
        ShapedText {
            layout,
            text,
            size_px: default_size,
        }
    }

    /// Unwrapped single-line measurement for intrinsic sizing.
    pub fn measure_width(&mut self, runs: &[TextRun], theme: &Theme) -> f32 {
        self.shape(runs, theme, None).width()
    }
}

impl ShapedText {
    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn byte_len(&self) -> usize {
        self.text.len()
    }

    pub fn width(&self) -> f32 {
        self.layout.width()
    }

    pub fn height(&self) -> f32 {
        self.layout.height()
    }

    pub fn line_count(&self) -> usize {
        self.layout.lines().count()
    }

    pub fn font_size(&self) -> f32 {
        self.size_px
    }

    /// Iterates positioned glyph runs for painting. `PaintRun.origin` is
    /// the text-local origin of the run's first glyph (x along the line,
    /// y = the line's baseline).
    pub fn paint_runs(&self) -> impl Iterator<Item = PaintRun<'_>> + '_ {
        self.layout
            .lines()
            .flat_map(|line| {
                // LineMetrics is Copy — copy it out so the returned
                // iterator doesn't borrow `line` (E0515 otherwise).
                let metrics = *line.metrics();
                line.items().map(move |item| (metrics, item))
            })
            .filter_map(|(line_metrics, item)| match item {
                parley::PositionedLayoutItem::GlyphRun(run) => Some(PaintRun {
                    origin: (run.offset(), line_metrics.baseline),
                    line_top: line_metrics.baseline
                        - line_metrics.ascent
                        - line_metrics.leading * 0.5,
                    run,
                }),
                parley::PositionedLayoutItem::InlineBox(_) => None,
            })
    }

    /// Caret geometry for a byte index (text-local coordinates). Indices
    /// clamp to the text ends; interior indices land on cluster edges —
    /// start edge for a cluster start, end edge otherwise.
    pub fn caret_geometry(&self, byte_index: usize) -> CaretGeometry {
        let text_len = self.text.len();
        let index = byte_index.min(text_len);
        if text_len == 0 {
            // Empty text: a caret at the origin with the type ramp's line
            // height (parley yields a zero-size layout for empty content).
            return CaretGeometry {
                byte_index: 0,
                x: 0.0,
                y_top: 0.0,
                y_baseline: self.size_px * 1.25,
                y_bottom: self.size_px * 1.25,
                line_offset: 0.0,
            };
        }
        match Cluster::from_byte_index(&self.layout, index) {
            None => {
                // Past the last cluster → end-of-text caret on the last line.
                let line = self
                    .layout
                    .lines()
                    .next_back()
                    .expect("non-empty text has a line");
                let m = line.metrics();
                CaretGeometry {
                    byte_index: index,
                    x: self.layout.width(),
                    y_top: m.baseline - m.ascent - m.leading * 0.5,
                    y_baseline: m.baseline,
                    y_bottom: m.baseline + m.descent + m.leading * 0.5,
                    line_offset: m.offset,
                }
            }
            Some(cluster) => {
                let line = cluster.line();
                let m = line.metrics();
                let at_cluster_start = cluster.text_range().start == index;
                // Walk the line's positioned runs, accumulating visual
                // advances, until the run that contains the cluster.
                let mut caret_x = None;
                'outer: for item in cluster.line().items() {
                    let parley::PositionedLayoutItem::GlyphRun(run) = item else {
                        continue;
                    };
                    let mut x = run.offset();
                    for c in run.run().visual_clusters() {
                        let advance = c.advance();
                        if c.text_range().contains(&index)
                            || (index == c.text_range().end && index == text_len)
                        {
                            caret_x = Some(if at_cluster_start { x } else { x + advance });
                            break 'outer;
                        }
                        x += advance;
                    }
                }
                CaretGeometry {
                    byte_index: index,
                    x: caret_x.unwrap_or(self.layout.width()),
                    y_top: m.baseline - m.ascent - m.leading * 0.5,
                    y_baseline: m.baseline,
                    y_bottom: m.baseline + m.descent + m.leading * 0.5,
                    line_offset: m.offset,
                }
            }
        }
    }

    /// Byte index at a text-local point (caret positioning on click /
    /// selection drag). Snaps to the nearest cluster edge.
    pub fn byte_index_at_point(&self, x: f32, y: f32) -> Option<usize> {
        let (cluster, side) = Cluster::from_point(&self.layout, x, y)?;
        let range = cluster.text_range();
        Some(match side {
            ClusterSide::Left => range.start,
            ClusterSide::Right => range.end,
        })
    }

    /// Selection rects (text-local `(x, y, w, h)`) for a byte range: one
    /// rect per line slice — the same cluster walk the caret uses, so paint
    /// and hit cannot disagree (INV-2).
    pub fn selection_rects(&self, range: std::ops::Range<usize>) -> Vec<(f32, f32, f32, f32)> {
        let start = range.start.min(range.end);
        let end = range.start.max(range.end);
        let mut out = Vec::new();
        if start >= end {
            return out;
        }
        for line in self.layout.lines() {
            let m = line.metrics();
            let y = m.baseline - m.ascent - m.leading * 0.5;
            let h = m.line_height.max(m.ascent + m.descent + m.leading);
            let mut sel_start: Option<f32> = None;
            let mut sel_end = None;
            for item in line.items() {
                let parley::PositionedLayoutItem::GlyphRun(run) = item else {
                    continue;
                };
                let mut x = run.offset();
                for c in run.run().visual_clusters() {
                    let advance = c.advance();
                    let cr = c.text_range();
                    let touches = cr.end > start && cr.start < end;
                    if touches {
                        sel_start.get_or_insert(x);
                        sel_end = Some(x + advance);
                    }
                    x += advance;
                }
            }
            if let (Some(sx), Some(ex)) = (sel_start, sel_end) {
                out.push((sx, y, ex - sx, h));
            }
        }
        out
    }
}

/// A positioned glyph run ready for vello painting.
pub struct PaintRun<'a> {
    /// Text-local origin of the run's first glyph: (x along the line,
    /// baseline y).
    pub origin: (f32, f32),
    /// Text-local top of the containing line.
    pub line_top: f32,
    pub run: parley::layout::GlyphRun<'a, [u8; 4]>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine() -> TextEngine {
        TextEngine::new()
    }

    #[test]
    fn shape_measures_and_breaks_lines() {
        let mut e = engine();
        let theme = Theme::golden_dark();
        let runs = vec![TextRun::plain(
            "hello scene platform — измерение ширины строки",
            TextTokens::body(),
        )];
        let wide = e.shape(&runs, &theme, Some(10_000.0));
        assert!(wide.width() > 100.0);
        assert_eq!(wide.line_count(), 1);
        let narrow = e.shape(&runs, &theme, Some(60.0));
        // `break_all_lines` is a soft maximum: a long unbreakable token may
        // still overflow the offered width, so the honest assertions are
        // "wrapped into more lines, tighter than the wide layout, taller".
        assert!(narrow.width() < wide.width());
        assert!(narrow.line_count() > 1);
        assert!(narrow.height() > wide.height());
        assert_eq!(narrow.text(), runs[0].text);
    }

    #[test]
    fn caret_geometry_walks_left_to_right() {
        let mut e = engine();
        let theme = Theme::golden_dark();
        let runs = vec![TextRun::plain("abc", TextTokens::body())];
        let shaped = e.shape(&runs, &theme, None);
        let c0 = shaped.caret_geometry(0);
        let c1 = shaped.caret_geometry(1);
        let c3 = shaped.caret_geometry(3);
        assert_eq!(c0.x, 0.0);
        assert!(c1.x > c0.x);
        assert!(c3.x > c1.x);
        assert!(c0.y_top < c0.y_baseline);
        assert!(c0.y_bottom > c0.y_baseline);
        let c9 = shaped.caret_geometry(9); // clamps
        assert_eq!(c9.byte_index, 3);
    }

    #[test]
    fn caret_on_empty_text_has_a_height() {
        let mut e = engine();
        let theme = Theme::golden_dark();
        let shaped = e.shape(&[], &theme, None);
        assert_eq!(shaped.byte_len(), 0);
        let c = shaped.caret_geometry(0);
        assert_eq!(c.x, 0.0);
        assert!(c.y_bottom > c.y_top);
    }

    #[test]
    fn multibyte_caret_never_panics_and_moves() {
        let mut e = engine();
        let theme = Theme::golden_dark();
        let runs = vec![TextRun::plain("日本語🙂", TextTokens::body())];
        let shaped = e.shape(&runs, &theme, None);
        let mut last_x = -1.0;
        for i in 0..=shaped.byte_len() {
            let g = shaped.caret_geometry(i);
            assert!(g.x >= last_x, "caret x must not move backwards");
            last_x = g.x;
        }
    }

    #[test]
    fn point_hit_round_trips_byte_index() {
        let mut e = engine();
        let theme = Theme::golden_dark();
        let runs = vec![TextRun::plain("hello world", TextTokens::body())];
        let shaped = e.shape(&runs, &theme, None);
        let geom = shaped.caret_geometry(6); // start of "world"
        let found = shaped.byte_index_at_point(geom.x + 1.0, (geom.y_top + geom.y_bottom) / 2.0);
        assert_eq!(found, Some(6));
    }

    #[test]
    fn selection_rects_cover_lines() {
        let mut e = engine();
        let theme = Theme::golden_dark();
        let runs = vec![TextRun::plain(
            "first line and second chunk",
            TextTokens::body(),
        )];
        let shaped = e.shape(&runs, &theme, Some(80.0));
        assert!(shaped.line_count() >= 2);
        let rects = shaped.selection_rects(0..shaped.byte_len());
        assert!(!rects.is_empty());
        let total_w: f32 = rects.iter().map(|r| r.2).sum();
        assert!(total_w > 0.0);
        // A collapsed range produces no rects.
        assert!(shaped.selection_rects(4..4).is_empty());
    }

    #[test]
    fn measure_width_matches_shape() {
        let mut e = engine();
        let theme = Theme::golden_dark();
        let runs = vec![TextRun::plain("measurement", TextTokens::body())];
        let w = e.measure_width(&runs, &theme);
        assert!((w - e.shape(&runs, &theme, None).width()).abs() < 1e-6);
    }
}
