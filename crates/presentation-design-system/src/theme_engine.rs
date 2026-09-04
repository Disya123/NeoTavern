//! Native Live Theme Engine for Blitz and NeoCompositor.
//!
//! Provides Theme SDK Level 1 (Design Tokens) resolution, preset palettes for
//! bundled themes, manifest parsing, and dynamic stylesheet generation for
//! runtime theme switching without recompilation or binary restart.

use serde::{Deserialize, Serialize};

/// Core semantic design tokens (Theme SDK Level 1) for UI surfaces, accents,
/// borders, and typography.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThemeTokens {
    pub color_surface_canvas: String,
    pub color_surface_primary: String,
    pub color_surface_secondary: String,
    pub color_surface_tertiary: String,
    pub color_surface_overlay: String,
    pub color_surface_elevated: String,
    pub color_border: String,
    pub color_border_subtle: String,
    pub color_border_strong: String,
    pub color_accent: String,
    pub color_accent_hover: String,
    pub color_accent_text: String,
    pub color_accent_soft: String,
    pub color_accent_soft_text: String,
    pub color_text_primary: String,
    pub color_text_secondary: String,
    pub color_text_muted: String,
    pub radius_control: String,
    pub radius_card: String,
    pub radius_overlay: String,
}

impl Default for ThemeTokens {
    fn default() -> Self {
        Self::default_dark()
    }
}

impl ThemeTokens {
    /// Canonical NeoTavern Dark token set (matches `DEFAULT_DARK_TOKENS` in Theme SDK).
    pub fn default_dark() -> Self {
        Self {
            color_surface_canvas: "#151311".into(),
            color_surface_primary: "#1b1917".into(),
            color_surface_secondary: "#24211e".into(),
            color_surface_tertiary: "#302c28".into(),
            color_surface_overlay: "#292522".into(),
            color_surface_elevated: "#292522".into(),
            color_border: "#39342f".into(),
            color_border_subtle: "#2b2723".into(),
            color_border_strong: "#625a53".into(),
            color_accent: "#e38a62".into(),
            color_accent_hover: "#f09a73".into(),
            color_accent_text: "#2a130b".into(),
            color_accent_soft: "#492a20".into(),
            color_accent_soft_text: "#ffc4a8".into(),
            color_text_primary: "#f3eee8".into(),
            color_text_secondary: "#c5bbb2".into(),
            color_text_muted: "#998f87".into(),
            radius_control: "10px".into(),
            radius_card: "16px".into(),
            radius_overlay: "16px".into(),
        }
    }

    /// Parse a `#RGB` or `#RRGGBB` hex color into its `(r, g, b)` components.
    pub fn parse_hex_color(hex: &str) -> Option<(u8, u8, u8)> {
        let trimmed = hex.trim().strip_prefix('#')?;
        match trimmed.len() {
            3 => {
                let r = u8::from_str_radix(&trimmed[0..1].repeat(2), 16).ok()?;
                let g = u8::from_str_radix(&trimmed[1..2].repeat(2), 16).ok()?;
                let b = u8::from_str_radix(&trimmed[2..3].repeat(2), 16).ok()?;
                Some((r, g, b))
            }
            6 | 8 => {
                let r = u8::from_str_radix(&trimmed[0..2], 16).ok()?;
                let g = u8::from_str_radix(&trimmed[2..4], 16).ok()?;
                let b = u8::from_str_radix(&trimmed[4..6], 16).ok()?;
                Some((r, g, b))
            }
            _ => None,
        }
    }

    /// Convert a hex color string into a CSS `rgba(r,g,b,a)` literal.
    pub fn hex_to_rgba(hex: &str, alpha: f32) -> String {
        if let Some((r, g, b)) = Self::parse_hex_color(hex) {
            format!("rgba({},{},{},{:.2})", r, g, b, alpha)
        } else {
            hex.to_string()
        }
    }

    /// Computes the semi-transparent background for the primary navigation rail.
    pub fn rail_background(&self, alpha: f32) -> String {
        Self::hex_to_rgba(&self.color_surface_canvas, alpha)
    }

    /// Computes the semi-transparent background for floating panels.
    pub fn panel_background(&self, alpha: f32) -> String {
        Self::hex_to_rgba(&self.color_surface_secondary, alpha)
    }
}

/// Built-in theme token presets for bundled themes.
pub fn builtin_theme_tokens(id: &str) -> Option<ThemeTokens> {
    match id {
        "wii-u-dark" | "neotavern.wii-u-dark" => Some(ThemeTokens {
            color_surface_canvas: "#0b1015".into(),
            color_surface_primary: "#121820".into(),
            color_surface_secondary: "#19212c".into(),
            color_surface_tertiary: "#222d3b".into(),
            color_surface_overlay: "#1c2532".into(),
            color_surface_elevated: "#1c2532".into(),
            color_border: "#273545".into(),
            color_border_subtle: "#1a2430".into(),
            color_border_strong: "#3b4f66".into(),
            color_accent: "#00a0e9".into(),
            color_accent_hover: "#33b3ed".into(),
            color_accent_text: "#ffffff".into(),
            color_accent_soft: "#0d354a".into(),
            color_accent_soft_text: "#7fd5f6".into(),
            color_text_primary: "#eef5fb".into(),
            color_text_secondary: "#b8cad8".into(),
            color_text_muted: "#7d93a6".into(),
            radius_control: "12px".into(),
            radius_card: "18px".into(),
            radius_overlay: "18px".into(),
        }),
        "kde-plasma" | "neotavern.kde-plasma" => Some(ThemeTokens {
            color_surface_canvas: "#1b1e20".into(),
            color_surface_primary: "#232629".into(),
            color_surface_secondary: "#2a2e32".into(),
            color_surface_tertiary: "#31363b".into(),
            color_surface_overlay: "#2a2e32".into(),
            color_surface_elevated: "#31363b".into(),
            color_border: "#3a4045".into(),
            color_border_subtle: "#2c3135".into(),
            color_border_strong: "#4f575e".into(),
            color_accent: "#3daee9".into(),
            color_accent_hover: "#56bcf2".into(),
            color_accent_text: "#ffffff".into(),
            color_accent_soft: "#1b3b4f".into(),
            color_accent_soft_text: "#9ad6f6".into(),
            color_text_primary: "#fcfcfc".into(),
            color_text_secondary: "#bdc3c7".into(),
            color_text_muted: "#7f8c8d".into(),
            radius_control: "6px".into(),
            radius_card: "8px".into(),
            radius_overlay: "8px".into(),
        }),
        "amoled" | "neotavern.amoled" => Some(ThemeTokens {
            color_surface_canvas: "#000000".into(),
            color_surface_primary: "#000000".into(),
            color_surface_secondary: "#0a0a0a".into(),
            color_surface_tertiary: "#111111".into(),
            color_surface_overlay: "#0a0a0a".into(),
            color_surface_elevated: "#0a0a0a".into(),
            color_border: "#1f1f1f".into(),
            color_border_subtle: "#141414".into(),
            color_border_strong: "#3a3a3a".into(),
            color_accent: "#ffffff".into(),
            color_accent_hover: "#ffffff".into(),
            color_accent_text: "#000000".into(),
            color_accent_soft: "#1a1a1a".into(),
            color_accent_soft_text: "#ffffff".into(),
            color_text_primary: "#ffffff".into(),
            color_text_secondary: "#b8b8b8".into(),
            color_text_muted: "#8a8a8a".into(),
            radius_control: "10px".into(),
            radius_card: "16px".into(),
            radius_overlay: "16px".into(),
        }),
        "dracula" | "neotavern.dracula" => Some(ThemeTokens {
            color_surface_canvas: "#282a36".into(),
            color_surface_primary: "#21222c".into(),
            color_surface_secondary: "#343746".into(),
            color_surface_tertiary: "#44475a".into(),
            color_surface_overlay: "#343746".into(),
            color_surface_elevated: "#44475a".into(),
            color_border: "#44475a".into(),
            color_border_subtle: "#383a59".into(),
            color_border_strong: "#6272a4".into(),
            color_accent: "#bd93f9".into(),
            color_accent_hover: "#caa9fa".into(),
            color_accent_text: "#282a36".into(),
            color_accent_soft: "#453b66".into(),
            color_accent_soft_text: "#e0d4fc".into(),
            color_text_primary: "#f8f8f2".into(),
            color_text_secondary: "#bfbfbf".into(),
            color_text_muted: "#6272a4".into(),
            radius_control: "10px".into(),
            radius_card: "16px".into(),
            radius_overlay: "16px".into(),
        }),
        _ => None,
    }
}

/// Extract theme tokens from a Theme SDK manifest (`theme.json`).
pub fn parse_theme_tokens_from_manifest(manifest: &serde_json::Value) -> Option<ThemeTokens> {
    let tokens_obj = manifest
        .get("tokens")
        .and_then(|t| t.get("dark").or(Some(t)))?;
    let mut tokens = ThemeTokens::default_dark();

    let get_str = |key: &str| -> Option<String> {
        tokens_obj
            .get(key)
            .or_else(|| tokens_obj.get(&format!("--st-{}", key)))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    };

    if let Some(v) = get_str("color-surface-canvas") {
        tokens.color_surface_canvas = v;
    }
    if let Some(v) = get_str("color-surface-primary") {
        tokens.color_surface_primary = v;
    }
    if let Some(v) = get_str("color-surface-secondary") {
        tokens.color_surface_secondary = v;
    }
    if let Some(v) = get_str("color-surface-tertiary") {
        tokens.color_surface_tertiary = v;
    }
    if let Some(v) = get_str("color-surface-overlay") {
        tokens.color_surface_overlay = v;
    }
    if let Some(v) = get_str("color-surface-elevated") {
        tokens.color_surface_elevated = v;
    }
    if let Some(v) = get_str("color-border") {
        tokens.color_border = v;
    }
    if let Some(v) = get_str("color-border-subtle") {
        tokens.color_border_subtle = v;
    }
    if let Some(v) = get_str("color-border-strong") {
        tokens.color_border_strong = v;
    }
    if let Some(v) = get_str("color-accent") {
        tokens.color_accent = v;
    }
    if let Some(v) = get_str("color-accent-hover") {
        tokens.color_accent_hover = v;
    }
    if let Some(v) = get_str("color-accent-text") {
        tokens.color_accent_text = v;
    }
    if let Some(v) = get_str("color-accent-soft") {
        tokens.color_accent_soft = v;
    }
    if let Some(v) = get_str("color-accent-soft-text") {
        tokens.color_accent_soft_text = v;
    }
    if let Some(v) = get_str("color-text-primary") {
        tokens.color_text_primary = v;
    }
    if let Some(v) = get_str("color-text-secondary") {
        tokens.color_text_secondary = v;
    }
    if let Some(v) = get_str("color-text-muted") {
        tokens.color_text_muted = v;
    }
    if let Some(v) = get_str("radius-control") {
        tokens.radius_control = v;
    }
    if let Some(v) = get_str("radius-card") {
        tokens.radius_card = v;
    }
    if let Some(v) = get_str("radius-overlay") {
        tokens.radius_overlay = v;
    }

    Some(tokens)
}

/// Resolves theme tokens by ID: checks manifest first, falls back to built-in presets,
/// and defaults to `ThemeTokens::default_dark()`.
pub fn resolve_theme_tokens(id: &str, manifest: Option<&serde_json::Value>) -> ThemeTokens {
    if let Some(m) = manifest {
        if let Some(parsed) = parse_theme_tokens_from_manifest(m) {
            return parsed;
        }
    }
    builtin_theme_tokens(id).unwrap_or_else(ThemeTokens::default_dark)
}

/// Generates a Blitz-compatible CSS stylesheet scoped to `[data-theme-id="{theme_id}"]`.
///
/// Overrides key component styles (surfaces, rail, panels, cards, buttons, badges)
/// with the active theme's token palette.
pub fn render_theme_stylesheet(
    theme_id: &str,
    tokens: &ThemeTokens,
    custom_css: Option<&str>,
) -> String {
    let rail_bg = tokens.rail_background(0.85);
    let panel_bg = tokens.panel_background(0.88);
    let mut out = format!(
        r#"/* Auto-generated Live Theme Engine stylesheet for {theme_id} */
[data-theme-id="{theme_id}"] {{
  --st-color-accent: {accent};
  --st-color-accent-hover: {accent_hover};
  --st-color-accent-text: {accent_text};
  --st-color-accent-soft: {accent_soft};
  --st-color-accent-soft-text: {accent_soft_text};
  --st-color-surface-canvas: {canvas};
  --st-color-surface-primary: {surface_pri};
  --st-color-surface-secondary: {surface_sec};
  --st-color-surface-tertiary: {surface_ter};
  --st-color-surface-overlay: {surface_overlay};
  --st-color-surface-elevated: {surface_elevated};
  --st-color-border: {border};
  --st-color-border-subtle: {border_subtle};
  --st-color-border-strong: {border_strong};
  --st-color-text-primary: {text_pri};
  --st-color-text-secondary: {text_sec};
  --st-color-text-muted: {text_muted};
}}
[data-theme-id="{theme_id}"] .Sidebar_rail {{
  background: {rail_bg};
  border-color: {border};
}}
[data-theme-id="{theme_id}"] .Sidebar_railButtonActive {{
  color: {accent};
  background: {accent_soft};
}}
[data-theme-id="{theme_id}"] .Sidebar_railButtonActive svg,
[data-theme-id="{theme_id}"] .Sidebar_railButtonActive path {{
  fill: {accent};
}}
[data-theme-id="{theme_id}"] .Sidebar_sidebar {{
  border-color: {border};
}}
[data-theme-id="{theme_id}"] .FloatingTabPanel_panel {{
  background: {panel_bg};
  border-color: {border};
}}
[data-theme-id="{theme_id}"] .SidebarPanelHeader_header {{
  border-color: {border};
}}
[data-theme-id="{theme_id}"] [data-component="button"][data-variant="primary"] {{
  color: {accent_text};
  background: {accent};
}}
[data-theme-id="{theme_id}"] [data-component="button"][data-variant="secondary"] {{
  color: {text_pri};
  background: {surface_ter};
  border-color: {border};
}}
[data-theme-id="{theme_id}"] [data-part="theme-row"][data-state="active"] {{
  border-color: {accent};
  background: {accent_soft};
}}
[data-theme-id="{theme_id}"] [data-part="theme-active-badge"] {{
  background: {accent};
  color: {accent_text};
}}
[data-theme-id="{theme_id}"] .ChatWorkspace_composer {{
  background: {surface_sec};
  border-color: {border};
}}
[data-theme-id="{theme_id}"] .MessageBubble_rowAssistant {{
  background: {surface_ter};
  border-color: {border};
}}
[data-theme-id="{theme_id}"] .MessageBubble_rowUser {{
  background: {accent_soft};
  border-color: {accent};
}}
"#,
        theme_id = theme_id,
        accent = tokens.color_accent,
        accent_hover = tokens.color_accent_hover,
        accent_text = tokens.color_accent_text,
        accent_soft = tokens.color_accent_soft,
        accent_soft_text = tokens.color_accent_soft_text,
        canvas = tokens.color_surface_canvas,
        surface_pri = tokens.color_surface_primary,
        surface_sec = tokens.color_surface_secondary,
        surface_ter = tokens.color_surface_tertiary,
        surface_overlay = tokens.color_surface_overlay,
        surface_elevated = tokens.color_surface_elevated,
        border = tokens.color_border,
        border_subtle = tokens.color_border_subtle,
        border_strong = tokens.color_border_strong,
        text_pri = tokens.color_text_primary,
        text_sec = tokens.color_text_secondary,
        text_muted = tokens.color_text_muted,
        rail_bg = rail_bg,
        panel_bg = panel_bg,
    );

    if let Some(custom) = custom_css {
        if !custom.trim().is_empty() {
            out.push_str("\n/* Custom theme CSS asset */\n");
            out.push_str(custom);
            out.push('\n');
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hex_parsing_supports_three_and_six_digits() {
        assert_eq!(ThemeTokens::parse_hex_color("#fff"), Some((255, 255, 255)));
        assert_eq!(ThemeTokens::parse_hex_color("#000"), Some((0, 0, 0)));
        assert_eq!(
            ThemeTokens::parse_hex_color("#151311"),
            Some((21, 19, 17))
        );
        assert_eq!(
            ThemeTokens::parse_hex_color("#e38a62"),
            Some((227, 138, 98))
        );
        assert_eq!(ThemeTokens::parse_hex_color("invalid"), None);
    }

    #[test]
    fn hex_to_rgba_formats_correctly() {
        assert_eq!(
            ThemeTokens::hex_to_rgba("#151311", 0.82),
            "rgba(21,19,17,0.82)"
        );
        assert_eq!(
            ThemeTokens::hex_to_rgba("#24211e", 0.88),
            "rgba(36,33,30,0.88)"
        );
    }

    #[test]
    fn builtin_presets_resolve_known_themes() {
        let wii_u = builtin_theme_tokens("wii-u-dark").expect("wii-u-dark preset");
        assert_eq!(wii_u.color_accent, "#00a0e9");

        let kde = builtin_theme_tokens("kde-plasma").expect("kde-plasma preset");
        assert_eq!(kde.color_accent, "#3daee9");

        let amoled = builtin_theme_tokens("amoled").expect("amoled preset");
        assert_eq!(amoled.color_surface_canvas, "#000000");

        assert!(builtin_theme_tokens("non-existent-theme").is_none());
    }

    #[test]
    fn parse_theme_tokens_from_manifest_json() {
        let manifest = json!({
            "id": "custom.cyberpunk",
            "name": "Cyberpunk Neon",
            "tokens": {
                "dark": {
                    "color-accent": "#fcee0a",
                    "color-surface-canvas": "#050505",
                    "color-border": "#ff003c"
                }
            }
        });
        let parsed = parse_theme_tokens_from_manifest(&manifest).expect("parsed manifest");
        assert_eq!(parsed.color_accent, "#fcee0a");
        assert_eq!(parsed.color_surface_canvas, "#050505");
        assert_eq!(parsed.color_border, "#ff003c");
        // Non-overridden fallback to default dark
        assert_eq!(parsed.color_text_primary, "#f3eee8");
    }

    #[test]
    fn render_theme_stylesheet_generates_scoped_rules() {
        let tokens = builtin_theme_tokens("wii-u-dark").unwrap();
        let css = render_theme_stylesheet("wii-u-dark", &tokens, Some(".custom { color: red; }"));
        assert!(css.contains(r#"[data-theme-id="wii-u-dark"]"#));
        assert!(css.contains("--st-color-accent: #00a0e9;"));
        assert!(css.contains(r#"[data-theme-id="wii-u-dark"] .Sidebar_rail"#));
        assert!(css.contains(r#"[data-theme-id="wii-u-dark"] .Sidebar_railButtonActive"#));
        assert!(css.contains(r#"[data-component="button"][data-variant="primary"]"#));
        assert!(css.contains(".custom { color: red; }"));
    }
}
