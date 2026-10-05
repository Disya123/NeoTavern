//! Native theme contract, Phase-1 form (ADR-0057 platform spec §4).
//!
//! Themes are **data**: a mapping from semantic tokens to concrete values.
//! This module ships the Phase-1 built-in mapping sourced from the React
//! golden design tokens (`--st-*` in the packed design system) so the pilot
//! renders with the product's visual identity without any CSS. A full
//! data-driven theme container (tokens + component skins + slot shells,
//! loaded from theme packages) is Phase-2 work; the resolution *seam* below
//! is what stays.
//!
//! The scene side never sees concrete values: it hands tokens to
//! [`Theme::resolve`]-style accessors at layout/paint time, once per frame.

use crate::style::{
    ColorToken, ControlHeightToken, FontSizeToken, FontStackToken, FontWeightToken, RadiusToken,
    SpacingToken,
};

/// Concrete sRGB color, 0..=1 per channel, straight alpha.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rgba {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

impl Rgba {
    pub const fn rgb(r: f32, g: f32, b: f32) -> Self {
        Self { r, g, b, a: 1.0 }
    }
}

/// Phase-1 built-in theme: the React golden tokens as data.
///
/// Deliberately constructed from the golden `--st-*` values (see
/// `crates/presentation-design-system/generated/product.css`) so the pilot
/// and the legacy contour share one visual identity. Do not hand-tune
/// individual values here; change the packed tokens upstream.
#[derive(Clone, Debug)]
pub struct Theme {
    colors: fnv_map::Map<ColorToken, Rgba>,
    spacing: fnv_map::Map<SpacingToken, f32>,
    radii: fnv_map::Map<RadiusToken, f32>,
    control_heights: fnv_map::Map<ControlHeightToken, f32>,
    font_sizes: fnv_map::Map<FontSizeToken, f32>,
    font_weights: fnv_map::Map<FontWeightToken, f32>,
    font_stacks: fnv_map::Map<FontStackToken, &'static str>,
}

/// Tiny insertion-ordered map for a fixed token set (avoid a HashMap dep in
/// the core; iteration order is definition order, which keeps the debug
/// snapshot digest deterministic).
mod fnv_map {
    pub type Map<K, V> = Vec<(K, V)>;

    pub fn get<'a, K: PartialEq, V>(map: &'a Map<K, V>, key: &K) -> Option<&'a V> {
        map.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
}

fn srgb(hex: u32) -> Rgba {
    let r = ((hex >> 16) & 0xff) as f32 / 255.0;
    let g = ((hex >> 8) & 0xff) as f32 / 255.0;
    let b = (hex & 0xff) as f32 / 255.0;
    Rgba::rgb(r, g, b)
}

impl Theme {
    /// The Phase-1 built-in: React golden tokens (dark shell).
    pub fn golden_dark() -> Self {
        Self {
            colors: vec![
                (ColorToken::TextPrimary, srgb(0xf3eee8)),
                (ColorToken::TextSecondary, srgb(0xc5bbb2)),
                (ColorToken::TextMuted, srgb(0x998f87)),
                (ColorToken::TextInverse, srgb(0x211b17)),
                (ColorToken::SurfaceCanvas, srgb(0x151311)),
                (ColorToken::SurfacePrimary, srgb(0x1b1917)),
                (ColorToken::SurfaceSecondary, srgb(0x24211e)),
                (ColorToken::SurfaceTertiary, srgb(0x302c28)),
                (ColorToken::SurfaceElevated, srgb(0x292522)),
                (ColorToken::Accent, srgb(0xe38a62)),
                (ColorToken::AccentText, srgb(0x2a130b)),
                (ColorToken::Border, srgb(0x39342f)),
                (ColorToken::BorderSubtle, srgb(0x2b2723)),
                (ColorToken::Danger, srgb(0xf0837d)),
                (ColorToken::Success, srgb(0x63c98d)),
                (ColorToken::Warning, srgb(0xe0a35c)),
                (ColorToken::StreamingText, srgb(0xf3eee8)),
            ],
            // 4 px base ramp (the React `--st-space-*` scale).
            spacing: vec![
                (SpacingToken::None, 0.0),
                (SpacingToken::Xxs, 2.0),
                (SpacingToken::Xs, 4.0),
                (SpacingToken::Sm, 8.0),
                (SpacingToken::Md, 12.0),
                (SpacingToken::Lg, 16.0),
                (SpacingToken::Xl, 24.0),
                (SpacingToken::Xxl, 32.0),
            ],
            radii: vec![
                (RadiusToken::None, 0.0),
                (RadiusToken::Control, 10.0), // --st-radius-control
                (RadiusToken::Card, 16.0),    // --st-radius-card
            ],
            control_heights: vec![
                (ControlHeightToken::Control, 44.0),      // --st-control-height
                (ControlHeightToken::ControlLarge, 52.0), // --st-control-height-large
            ],
            font_sizes: vec![
                (FontSizeToken::Caption, 12.0),
                (FontSizeToken::Body, 15.0),
                (FontSizeToken::BodyLarge, 17.0),
                (FontSizeToken::Title, 20.0),
            ],
            font_weights: vec![
                (FontWeightToken::Regular, 400.0),
                (FontWeightToken::Medium, 500.0),
                (FontWeightToken::Semibold, 600.0),
            ],
            // Parley family names; `product_font_context()` maps them to the
            // packed golden faces (Outfit / Onest / JetBrains Mono).
            font_stacks: vec![
                (FontStackToken::Sans, "sans-serif"),
                (FontStackToken::Mono, "monospace"),
            ],
        }
    }

    pub fn color(&self, t: ColorToken) -> Rgba {
        *fnv_map::get(&self.colors, &t).expect("theme covers every ColorToken")
    }

    pub fn spacing(&self, t: SpacingToken) -> f32 {
        *fnv_map::get(&self.spacing, &t).expect("theme covers every SpacingToken")
    }

    pub fn radius(&self, t: RadiusToken) -> f32 {
        *fnv_map::get(&self.radii, &t).expect("theme covers every RadiusToken")
    }

    pub fn control_height(&self, t: ControlHeightToken) -> f32 {
        *fnv_map::get(&self.control_heights, &t).expect("theme covers every ControlHeightToken")
    }

    pub fn font_size(&self, t: FontSizeToken) -> f32 {
        *fnv_map::get(&self.font_sizes, &t).expect("theme covers every FontSizeToken")
    }

    pub fn font_weight(&self, t: FontWeightToken) -> f32 {
        *fnv_map::get(&self.font_weights, &t).expect("theme covers every FontWeightToken")
    }

    pub fn font_family(&self, t: FontStackToken) -> &'static str {
        fnv_map::get(&self.font_stacks, &t).expect("theme covers every FontStackToken")
    }
}

impl Default for Theme {
    fn default() -> Self {
        Self::golden_dark()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn theme_resolves_every_token_without_panicking() {
        // The expect()s in the accessors are the test: every token used by
        // scene styles must resolve in the built-in theme.
        let t = Theme::golden_dark();
        for token in [
            ColorToken::TextPrimary,
            ColorToken::SurfaceCanvas,
            ColorToken::Accent,
            ColorToken::Danger,
        ] {
            let c = t.color(token);
            assert!((0.0..=1.0).contains(&c.r));
            assert!((0.0..=1.0).contains(&c.g));
            assert!((0.0..=1.0).contains(&c.b));
            assert_eq!(c.a, 1.0);
        }
        assert_eq!(t.spacing(SpacingToken::Sm), 8.0);
        assert_eq!(t.radius(RadiusToken::Control), 10.0);
        assert_eq!(t.control_height(ControlHeightToken::Control), 44.0);
        assert!(t.font_size(FontSizeToken::Body) > 0.0);
        assert!(t.font_weight(FontWeightToken::Semibold) >= 500.0);
        assert_eq!(t.font_family(FontStackToken::Sans), "sans-serif");
    }

    #[test]
    fn golden_tokens_match_the_packed_css_values() {
        // Regression guard against silent drift from the React goldens.
        let t = Theme::golden_dark();
        assert_eq!(t.color(ColorToken::Accent), srgb(0xe38a62));
        assert_eq!(t.color(ColorToken::SurfaceCanvas), srgb(0x151311));
        assert_eq!(t.color(ColorToken::BorderSubtle), srgb(0x2b2723));
        assert_eq!(t.control_height(ControlHeightToken::ControlLarge), 52.0);
    }
}
