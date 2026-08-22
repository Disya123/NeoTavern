//! React golden design system packed for Blitz.
//!
//! Tokens, fonts, and Phosphor regular paths come from the React UI. Do not
//! substitute Dioxus defaults, similar icons, or a restyled type ramp.

use parley::fontique::{
    Blob, Collection, CollectionOptions, FontInfoOverride, GenericFamily, SourceCache,
};
use parley::FontContext;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

include!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/generated/phosphor.rs"
));

pub const PRODUCT_CSS: &str = include_str!("../generated/product.css");
pub const OUTFIT_VARIABLE_LATIN: &[u8] =
    include_bytes!("../generated/fonts/outfit-variable-latin.ttf");
pub const JETBRAINS_MONO_VARIABLE_LATIN: &[u8] =
    include_bytes!("../generated/fonts/jetbrains-mono-variable-latin.ttf");

/// CSS-pixel safe-area box matching `--nt-safe-area-*` on the React host.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SafeAreaInsets {
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
    pub left: f32,
}

pub fn inset_stylesheet(insets: SafeAreaInsets) -> String {
    format!(
        ":root {{ --nt-safe-area-top: {t}px; --nt-safe-area-right: {r}px; --nt-safe-area-bottom: {b}px; --nt-safe-area-left: {l}px; --nt-inset-top: {t}px; --nt-inset-right: {r}px; --nt-inset-bottom: {b}px; --nt-inset-left: {l}px; }}",
        t = insets.top,
        r = insets.right,
        b = insets.bottom,
        l = insets.left,
    )
}

/// Substitute the dynamic safe-area custom properties with concrete CSS pixels.
///
/// Only the `--nt-inset-*` / `--nt-safe-area-*` family is dynamic per device;
/// every `--st-*` token must already be flattened at pack time (see the test
/// `packed_sheet_keeps_react_tokens_and_module_classes`). We match the full
/// `var(--token)` form so a bare token occurrence is left untouched, and we
/// never touch other `var()` references, so a future token cannot be silently
/// mangled.
fn substitute_safe_area_tokens(css: &str, insets: SafeAreaInsets) -> String {
    let tokens: &[(&str, f32)] = &[
        ("var(--nt-inset-top)", insets.top),
        ("var(--nt-safe-area-top)", insets.top),
        ("var(--nt-inset-right)", insets.right),
        ("var(--nt-safe-area-right)", insets.right),
        ("var(--nt-inset-bottom)", insets.bottom),
        ("var(--nt-safe-area-bottom)", insets.bottom),
        ("var(--nt-inset-left)", insets.left),
        ("var(--nt-safe-area-left)", insets.left),
    ];
    let mut out = css.to_string();
    for (var, value) in tokens {
        out = out.replace(var, &format!("{}px", value));
    }
    out
}

fn parse_px_token(value: &str) -> Option<f32> {
    let trimmed = value.trim();
    let digits = trimmed.strip_suffix("px")?.trim();
    digits.parse::<f32>().ok()
}

/// Collapse one CSS math expression (`calc`/`max`/`min`/`clamp`) whose every
/// operand is already a px literal. Returns the computed px string, or `None`
/// when any operand is unresolved (e.g. `100%`, a `var()`, or a non-px unit) so
/// the original text is preserved untouched instead of being corrupted.
fn collapse_one_math_expr(name: &str, inner: &str) -> Option<String> {
    match name {
        "clamp" => {
            // clamp(MIN, PREFERRED, MAX) → max(MIN, min(PREFERRED, MAX)).
            let mut parts = inner.split(',').filter(|p| !p.trim().is_empty());
            let min = parse_px_token(parts.next()?)?;
            let preferred = parse_px_token(parts.next()?)?;
            let max = parse_px_token(parts.next()?)?;
            let clamped = min.max(preferred.min(max));
            Some(format!("{}px", clamped))
        }
        "calc" => {
            // Split on + / - keeping the operator attached to the next term.
            let mut terms: Vec<f32> = Vec::new();
            let mut current = String::new();
            let mut expect_term = true;
            for ch in inner.chars() {
                if ch == '+' || ch == '-' {
                    if !expect_term {
                        let term = current.trim();
                        if term.is_empty() {
                            return None;
                        }
                        terms.push(parse_px_token(term)?);
                        current.clear();
                        expect_term = true;
                    } else {
                        // unary sign on the first term
                        current.push(ch);
                    }
                } else {
                    current.push(ch);
                    expect_term = false;
                }
            }
            let last = current.trim();
            if last.is_empty() {
                return None;
            }
            terms.push(parse_px_token(last)?);
            let total: f32 = terms.iter().sum();
            Some(format!("{}px", total))
        }
        "max" | "min" => {
            let mut acc: Option<f32> = None;
            for part in inner.split(',') {
                let v = parse_px_token(part)?;
                acc = Some(match acc {
                    None => v,
                    Some(a) => {
                        if name == "max" {
                            a.max(v)
                        } else {
                            a.min(v)
                        }
                    }
                });
            }
            acc.map(|v| format!("{}px", v))
        }
        _ => None,
    }
}

/// Structured, paren-balanced collapse of `calc()/max()/min()/clamp()`.
///
/// Unlike the previous naive string `.replace`, this walks the source with a
/// parenthesis stack and evaluates only fully-resolved expressions, leaving any
/// construct that still contains `var()`, `%`, non-px units, or comment text
/// byte-for-byte intact. It skips `/* … */` comments so comment prose such as
/// `max(8px, 9px)` is never touched, and it guards against `minmax(` being
/// mistaken for `min(`. Nested expressions collapse by re-scanning the interior
/// when the outer one is not yet resolvable.
fn collapse_css_math(css: &str) -> String {
    const FUNCS: &[&str] = &["calc(", "max(", "min(", "clamp("];
    let mut current = css.to_string();
    // Bounded fixed-point: N expressions deep at most.
    for _ in 0..16 {
        let mut changed = false;
        let mut out = String::with_capacity(current.len());
        let mut rest = current.as_str();
        'scan: while let Some(idx) = rest.find(|c| matches!(c, 'c' | 'm' | '/')) {
            // Skip comment blocks entirely.
            if rest[idx..].starts_with("/*") {
                if let Some(end) = rest[idx + 2..].find("*/") {
                    out.push_str(&rest[..idx + 2 + end + 2]);
                    rest = &rest[idx + 2 + end + 2..];
                    continue 'scan;
                } else {
                    out.push_str(rest);
                    rest = "";
                    break 'scan;
                }
            }
            let prefix = &rest[idx..];
            let matched = FUNCS.iter().find(|f| {
                let name = f.trim_end_matches('(');
                prefix.starts_with(*f) && !prefix.starts_with(&format!("{name}max("))
            });
            let Some(func) = matched else {
                out.push_str(&rest[..idx + 1]);
                rest = &rest[idx + 1..];
                continue 'scan;
            };
            let name = func.trim_end_matches('(');
            // `open` points at the `(`; we have already "seen" it, so start the
            // depth counter at 1 and scan the inside only.
            let open = idx + name.len();
            let mut depth = 1;
            let mut close = None;
            for (i, ch) in rest[open + 1..].char_indices() {
                match ch {
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 {
                            close = Some(open + 1 + i);
                            break;
                        }
                    }
                    _ => {}
                }
            }
            let Some(close) = close else {
                // Unbalanced paren: emit the function head and keep scanning
                // past it so one malformed expression (e.g. an empty `calc(`
                // in the packed source) does not prevent collapsing the rest.
                out.push_str(&rest[..open + 1]);
                rest = &rest[open + 1..];
                continue 'scan;
            };
            let inner = &rest[open + 1..close];
            match collapse_one_math_expr(name, inner) {
                Some(collapsed) => {
                    out.push_str(&rest[..idx]);
                    out.push_str(&collapsed);
                    rest = &rest[close + 1..];
                    changed = true;
                }
                None => {
                    // Not (yet) resolvable: emit the function head and keep
                    // scanning its interior so nested expressions can collapse.
                    out.push_str(&rest[..open + 1]);
                    rest = &rest[open + 1..];
                }
            }
        }
        out.push_str(rest);
        if !changed {
            return out;
        }
        current = out;
    }
    current
}

fn bake_insets(css: &str, insets: SafeAreaInsets) -> String {
    let substituted = substitute_safe_area_tokens(css, insets);
    collapse_css_math(&substituted)
}

pub fn product_stylesheets(insets: SafeAreaInsets) -> Vec<String> {
    product_stylesheets_from_css(PRODUCT_CSS, insets)
}

/// Bake safe-area insets into an arbitrary already-packed stylesheet.
///
/// This is the pure core of [`product_stylesheets`] and is also used by the
/// dev hot-stylesheet path, so a runtime-loaded sheet passes through exactly
/// the same token/safe-area flattening as the compile-time embedded one.
pub fn product_stylesheets_from_css(css: &str, insets: SafeAreaInsets) -> Vec<String> {
    vec![bake_insets(css, insets), inset_stylesheet(insets)]
}

/// Env switch that turns on runtime stylesheet hot-reload (dev only).
///
/// When set (any value except `0`/empty), `product_stylesheets_dev` reads the
/// packed `product.css` from disk instead of the compile-time embedded copy,
/// so CSS/token edits apply without recompiling any Rust crate. When unset
/// the behavior is byte-identical to [`product_stylesheets`].
pub const DEV_HOT_STYLES_ENV: &str = "NEOTA_DEV_HOT_STYLES";

/// Optional override for the hot stylesheet path (absolute or relative).
///
/// Defaults to `<this crate>/generated/product.css` (the pack output). Tests
/// point this at a temp file.
pub const DEV_HOT_STYLES_PATH_ENV: &str = "NEOTA_DEV_HOT_STYLES_PATH";

/// Default location of the hot-reloadable stylesheet: the pack output in this
/// crate's `generated/` directory.
pub fn default_hot_stylesheet_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("generated")
        .join("product.css")
}

/// Resolve the hot stylesheet path honoring `NEOTA_DEV_HOT_STYLES_PATH`.
pub fn hot_stylesheet_path() -> PathBuf {
    std::env::var(DEV_HOT_STYLES_PATH_ENV)
        .ok()
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(default_hot_stylesheet_path)
}

#[derive(Default)]
struct HotStyleCache {
    mtime: Option<SystemTime>,
    css: Option<String>,
}

static HOT_STYLE_CACHE: OnceLock<Mutex<HotStyleCache>> = OnceLock::new();

/// Read the current hot stylesheet from [`hot_stylesheet_path`], re-reading
/// from disk only when the file's mtime changed since the last read.
///
/// Returns `None` when the file is missing so callers fall back to the
/// compile-time embedded sheet instead of rendering un-styled.
pub fn load_hot_stylesheet() -> Option<String> {
    load_hot_stylesheet_from(&hot_stylesheet_path())
}

/// Same as [`load_hot_stylesheet`] but against an explicit path (testable in
/// isolation without touching the pack output).
pub fn load_hot_stylesheet_from(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta.modified().ok();
    let mut cache = HOT_STYLE_CACHE
        .get_or_init(Default::default)
        .lock()
        .unwrap();
    if cache.mtime == mtime {
        return cache.css.clone();
    }
    let css = std::fs::read_to_string(path).ok()?;
    *cache = HotStyleCache {
        mtime,
        css: Some(css.clone()),
    };
    Some(css)
}

/// Drop the cached hot stylesheet so the next read re-reads the file.
///
/// Needed when a filesystem reports a coarse mtime (same-timestamp writes) or
/// when tests switch between two hot paths.
pub fn reset_hot_stylesheet_cache() {
    if let Some(cache) = HOT_STYLE_CACHE.get() {
        if let Ok(mut guard) = cache.lock() {
            *guard = HotStyleCache::default();
        }
    }
}

/// Development stylesheet source: when `NEOTA_DEV_HOT_STYLES` is set, the
/// packed sheet is re-read from disk (mtime-cached) so CSS/token edits apply
/// without recompiling Rust. Production path (env unset) is byte-identical to
/// [`product_stylesheets`].
pub fn product_stylesheets_dev(insets: SafeAreaInsets) -> Vec<String> {
    let hot = std::env::var(DEV_HOT_STYLES_ENV)
        .ok()
        .filter(|v| !v.is_empty() && v != "0")
        .and_then(|_| load_hot_stylesheet());
    match hot {
        Some(css) => product_stylesheets_from_css(&css, insets),
        None => product_stylesheets(insets),
    }
}

/// Measure the rendered advance width of `text` in the golden Outfit font at
/// `font_size_px`, using the real Parley shaper (no fixed-advance heuristic).
///
/// Returns `None` only when the shaper produced no measurable width (empty input
/// or an unavailable font context); callers should then keep the full string
/// rather than guess a cut point. The contexts are cached process-wide so
/// repeated title measurement does not re-register the font each call.
pub fn measure_text_width(text: &str, font_size_px: f32) -> Option<f32> {
    use parley::{FontContext, FontFamily, Layout, LayoutContext, StyleProperty};
    use std::borrow::Cow;
    use std::sync::{Mutex, OnceLock};

    static FONT_CTX: OnceLock<Mutex<FontContext>> = OnceLock::new();
    static LAYOUT_CTX: OnceLock<Mutex<LayoutContext<[u8; 4]>>> = OnceLock::new();
    let font_ctx = FONT_CTX.get_or_init(|| Mutex::new(product_font_context()));
    let layout_ctx = LAYOUT_CTX.get_or_init(|| Mutex::new(LayoutContext::new()));
    let mut fcx = font_ctx.lock().ok()?;
    let mut lcx = layout_ctx.lock().ok()?;
    let mut builder = lcx.ranged_builder(&mut fcx, text, 1.0, true);
    builder.push_default(StyleProperty::FontSize(font_size_px));
    // `sans-serif` is mapped to the golden Outfit face by `product_font_context`.
    builder.push_default(StyleProperty::FontFamily(FontFamily::Source(
        Cow::Borrowed("sans-serif"),
    )));
    let mut layout: Layout<[u8; 4]> = builder.build(text);
    layout.break_all_lines(None);
    let width = layout.width();
    if width <= 0.0 || !width.is_finite() {
        None
    } else {
        Some(width)
    }
}

/// Trim `text` so its real Outfit advance fits `max_css_px`, appending `…`
/// when it must be cut. Uses [`measure_text_width`] (Parley) instead of a fixed
/// `font_size * 0.52` guess.
pub fn ellipsize_to_width(text: &str, max_css_px: f32, font_size_px: f32) -> String {
    let max_css_px = max_css_px.max(0.0);
    if text.is_empty() {
        return String::new();
    }
    let Some(width) = measure_text_width(text, font_size_px) else {
        return text.to_string();
    };
    if width <= max_css_px {
        return text.to_string();
    }
    let chars: Vec<char> = text.chars().collect();
    let mut lo = 1usize;
    let mut hi = chars.len();
    let mut best = 1usize;
    while lo <= hi {
        let mid = (lo + hi) / 2;
        let mut candidate: String = chars[..mid].iter().collect();
        candidate.push('…');
        let w = measure_text_width(&candidate, font_size_px).unwrap_or(f32::INFINITY);
        if w <= max_css_px {
            best = mid;
            lo = mid + 1;
        } else {
            hi = mid.saturating_sub(1);
        }
    }
    let mut out: String = chars[..best].iter().collect();
    out.push('…');
    out
}

fn register_family(
    ctx: &mut FontContext,
    bytes: &[u8],
    family_name: &'static str,
) -> Vec<parley::fontique::FamilyId> {
    let registered = ctx.collection.register_fonts(
        Blob::new(Arc::new(bytes.to_vec())),
        Some(FontInfoOverride {
            family_name: Some(family_name),
            ..FontInfoOverride::default()
        }),
    );
    registered.into_iter().map(|(id, _)| id).collect()
}

/// Parley context with Outfit / JetBrains Mono only. System fonts stay off so
/// Android Roboto cannot replace the golden typeface.
pub fn product_font_context() -> FontContext {
    let mut ctx = FontContext {
        source_cache: SourceCache::new_shared(),
        collection: Collection::new(CollectionOptions {
            shared: false,
            system_fonts: false,
        }),
    };
    let outfit = register_family(&mut ctx, OUTFIT_VARIABLE_LATIN, "Outfit Variable");
    let _ = register_family(&mut ctx, OUTFIT_VARIABLE_LATIN, "Outfit");
    let mono = register_family(
        &mut ctx,
        JETBRAINS_MONO_VARIABLE_LATIN,
        "JetBrains Mono Variable",
    );
    let _ = register_family(&mut ctx, JETBRAINS_MONO_VARIABLE_LATIN, "JetBrains Mono");
    for generic in [
        GenericFamily::SansSerif,
        GenericFamily::SystemUi,
        GenericFamily::UiSansSerif,
    ] {
        ctx.collection
            .append_generic_families(generic, outfit.iter().copied());
    }
    ctx.collection
        .append_generic_families(GenericFamily::Monospace, mono.iter().copied());
    ctx
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packed_sheet_keeps_all_react_tokens() {
        assert!(PRODUCT_CSS.contains(".PersonasPanel_personaCard"));
        assert!(PRODUCT_CSS.contains(".LorebookPanel_booksTab"));
        assert!(PRODUCT_CSS.contains(".BackgroundsPanel_"));
        assert!(PRODUCT_CSS.contains(".SettingsPanel_"));
        assert!(PRODUCT_CSS.contains(".PluginsPage_"));
        assert!(PRODUCT_CSS.contains(".MessageMarkdown_root"));
        assert!(PRODUCT_CSS.contains(".ChatWorkspace_page"));
        assert!(phosphor_path("Crown").is_some());
        assert!(phosphor_path("Lock").is_some());
        assert!(phosphor_path("PencilSimple").is_some());
        assert!(phosphor_path("ShieldCheck").is_some());
        assert!(phosphor_path("GearSix").is_some());
        assert!(phosphor_path("PaperPlaneRight").is_some());
        assert!(phosphor_path("MagicWand").is_some());
    }

    #[test]
    fn packed_sheet_keeps_react_tokens_and_module_classes() {
        assert!(PRODUCT_CSS.contains("--st-color-accent: #e38a62"));
        assert!(PRODUCT_CSS.contains("--st-color-surface-canvas: #151311"));
        assert!(PRODUCT_CSS.contains("--st-radius-control: 10px"));
        assert!(PRODUCT_CSS.contains("border-radius: 10px"));
        assert!(
            !PRODUCT_CSS.contains("var(--st-radius-control)"),
            "Blitz does not apply UA custom properties; pack must flatten --st-* tokens"
        );
        assert!(
            !PRODUCT_CSS.contains("padding: var(--st-"),
            "token aliases such as --st-chat-message-* must flatten to CSS pixels"
        );
        assert!(!PRODUCT_CSS.contains("border-radius: var(--st-"));
        assert!(!PRODUCT_CSS.contains("background: var(--st-color-"));
        assert!(!PRODUCT_CSS.contains("color: var(--st-color-"));
        assert!(PRODUCT_CSS.contains("#e38a62"));
        assert!(PRODUCT_CSS.contains("--st-shell-rail-width: 60px"));
        assert!(PRODUCT_CSS.contains("'Outfit Variable'"));
        assert!(PRODUCT_CSS.contains(".AppShell_shell"));
        assert!(PRODUCT_CSS.contains(".Sidebar_railButtonActive"));
        assert!(PRODUCT_CSS.contains(".CharacterManagementPanel_emptyState"));
        assert!(PRODUCT_CSS.contains(".PersonasPanel_personaCard"));
        assert!(PRODUCT_CSS.contains(".LorebookPanel_booksTab"));
        assert!(PRODUCT_CSS.contains(".BackgroundsPanel_"));
        assert!(PRODUCT_CSS.contains(".SettingsPanel_"));
        assert!(
            PRODUCT_CSS.contains(".AiSettings_tabBody") || PRODUCT_CSS.contains(".AiSettings_")
        );
        assert!(PRODUCT_CSS.contains(".PluginsPage_"));
        assert!(PRODUCT_CSS.contains(".MessageMarkdown_root"));
        assert!(PRODUCT_CSS.contains(".ChatWorkspace_composer"));
        assert!(PRODUCT_CSS.contains(".MessageBubble_rowAssistant"));
        assert!(PRODUCT_CSS.contains("[data-component='button']"));
        assert!(PRODUCT_CSS.contains("[data-component='tabs']"));
        assert!(phosphor_path("UsersThree").is_some());
        assert!(phosphor_path("Plus").is_some());
        assert_eq!(OUTFIT_VARIABLE_LATIN.len(), 70192);
        assert_eq!(JETBRAINS_MONO_VARIABLE_LATIN.len(), 96940);
    }

    #[test]
    fn product_fonts_register_without_system_discovery() {
        let mut ctx = product_font_context();
        assert!(ctx.collection.family_id("Outfit Variable").is_some());
        assert!(ctx
            .collection
            .family_id("JetBrains Mono Variable")
            .is_some());
    }

    #[test]
    fn parley_measures_title_and_ellipsizes() {
        let text = "Character Management";
        let w = measure_text_width(text, 20.0).expect("parley measure");
        assert!(w > 0.0 && w.is_finite());
        // Wide budget keeps the full string.
        let full = ellipsize_to_width(text, w + 200.0, 20.0);
        assert_eq!(full, text);
        // Half-width budget trims to the longest prefix that still fits.
        let budget = w * 0.5;
        let trimmed = ellipsize_to_width(text, budget, 20.0);
        assert!(trimmed.ends_with('…'));
        assert_ne!(trimmed, text);
        let trimmed_w = measure_text_width(&trimmed, 20.0).expect("measure trimmed");
        // Allow a small rounding slack past the budget.
        assert!(trimmed_w <= budget + 2.0, "{trimmed_w} <= {}", budget + 2.0);
        // A tiny budget still returns a (non-empty) ellipsized string, never panics.
        let tiny = ellipsize_to_width(text, 10.0, 20.0);
        assert!(tiny.ends_with('…'));
    }

    #[test]
    fn insets_bake_env_and_custom_properties_to_css_pixels() {
        let css = product_stylesheets(SafeAreaInsets {
            top: 41.0,
            right: 0.0,
            bottom: 24.0,
            left: 0.0,
        });
        let joined = css.join("\n");
        assert!(joined.contains("--nt-inset-top: 41px"));
        assert!(joined.contains("--nt-inset-bottom: 24px"));
        assert!(!joined.contains("var(--nt-inset-top)"));
        assert!(!joined.contains("env(safe-area-inset-top"));
        assert!(joined.contains("padding-top: 41px"));
        assert!(joined.contains("padding-bottom: 32px") || joined.contains("padding-bottom: 24px"));
        assert!(!joined.contains("max(8px, 41px)"));
        assert!(!joined.contains("padding-block-start"));
        assert!(!joined.contains("min-block-size"));
        assert!(!joined.contains("color-mix("));
        assert!(!joined.contains("rgba(21, 19, 17,"));
        assert!(!joined.contains("var(--tabs-"));
        assert!(joined.contains("background: #e38a62"));
        assert!(joined.contains("border-radius: 16px"));
        assert!(joined.contains("border-radius: 10px"));
    }

    #[test]
    fn packed_sheet_is_physical_dark_tokens_for_blitz() {
        assert!(!PRODUCT_CSS.contains("color-mix("));
        assert!(!PRODUCT_CSS.contains("color-scheme: light"));
        assert!(!PRODUCT_CSS.contains("rgba(21, 19, 17,"));
        assert!(!PRODUCT_CSS.contains("padding-block-start"));
        assert!(!PRODUCT_CSS.contains("min-block-size"));
        assert!(!PRODUCT_CSS.contains("var(--st-radius-control)"));
        assert!(!PRODUCT_CSS.contains("var(--tabs-segment-padding)"));
        assert!(PRODUCT_CSS.contains("background: #e38a62"));
        assert!(PRODUCT_CSS.contains("background: #24211e"));
        assert!(PRODUCT_CSS.contains("background: #151311"));
        assert!(PRODUCT_CSS.contains("border-radius: 10px"));
        assert!(PRODUCT_CSS.contains("border-radius: 16px"));
        assert!(PRODUCT_CSS.contains("style, script, template"));
        assert!(PRODUCT_CSS.contains("text-overflow: ellipsis"));
        assert!(
            !PRODUCT_CSS.contains("calc(100vw - 0)") && !PRODUCT_CSS.contains("calc(100% - 0)"),
            "flatten must not collapse --shell-rail-current-width to 0"
        );
        assert!(PRODUCT_CSS.contains("calc(100% - 60px)"));
        assert!(!PRODUCT_CSS.contains("position: fixed"));
        assert!(!PRODUCT_CSS.contains("position: sticky"));
    }

    // Golden corpus: the structured evaluator must collapse exactly the
    // expressions React emits and never corrupt unresolved ones.

    #[test]
    fn collapse_max_two_args() {
        let css = "padding-top: max(8px, var(--nt-inset-top));";
        let baked = bake_insets(
            css,
            SafeAreaInsets {
                top: 41.0,
                ..Default::default()
            },
        );
        assert_eq!(baked, "padding-top: 41px;");
    }

    #[test]
    fn collapse_nested_calc_inside_max() {
        let css = "padding: max(8px, calc(12px + var(--nt-inset-top)));";
        let baked = bake_insets(
            css,
            SafeAreaInsets {
                top: 41.0,
                ..Default::default()
            },
        );
        assert_eq!(baked, "padding: 53px;");
    }

    #[test]
    fn collapse_max_three_args_fixed_point() {
        let css = "height: max(8px, var(--nt-inset-top), 24px);";
        let baked = bake_insets(
            css,
            SafeAreaInsets {
                top: 41.0,
                ..Default::default()
            },
        );
        assert_eq!(baked, "height: 41px;");
    }

    #[test]
    fn collapse_min_keeps_smallest() {
        let css = "inset: min(var(--nt-inset-bottom), 32px);";
        let baked = bake_insets(
            css,
            SafeAreaInsets {
                bottom: 24.0,
                ..Default::default()
            },
        );
        assert_eq!(baked, "inset: 24px;");
    }

    #[test]
    fn collapse_clamp_with_px_only() {
        let css = "width: clamp(8px, var(--nt-inset-left), 60px);";
        let baked = bake_insets(
            css,
            SafeAreaInsets {
                left: 0.0,
                ..Default::default()
            },
        );
        assert_eq!(baked, "width: 8px;");
    }

    #[test]
    fn leaves_unresolved_units_intact() {
        let css = "width: calc(100% - var(--nt-inset-top));";
        let baked = bake_insets(
            css,
            SafeAreaInsets {
                top: 41.0,
                ..Default::default()
            },
        );
        // `100%` is not a px literal, so the whole expression is preserved.
        assert_eq!(baked, "width: calc(100% - 41px);");
    }

    #[test]
    fn leaves_unknown_var_intact() {
        let css = "padding: max(8px, var(--st-unknown-token));";
        let baked = bake_insets(
            css,
            SafeAreaInsets {
                top: 41.0,
                ..Default::default()
            },
        );
        assert_eq!(baked, "padding: max(8px, var(--st-unknown-token));");
    }

    #[test]
    fn does_not_corrupt_rgba_or_comments() {
        let css = "color: rgba(21, 19, 17, 0.5); /* max(8px, 9px) comment */";
        let baked = bake_insets(
            css,
            SafeAreaInsets {
                top: 41.0,
                ..Default::default()
            },
        );
        assert_eq!(
            baked,
            "color: rgba(21, 19, 17, 0.5); /* max(8px, 9px) comment */"
        );
    }

    #[test]
    fn golden_react_origin_snippet_bakes_without_corruption() {
        // Mirrors a realistic React card header padding expression.
        let css = ".x { padding: max(8px, var(--nt-safe-area-top)) max(8px, var(--nt-safe-area-right)) 8px max(8px, var(--nt-safe-area-left)); }";
        let baked = bake_insets(
            css,
            SafeAreaInsets {
                top: 41.0,
                right: 0.0,
                bottom: 24.0,
                left: 12.0,
            },
        );
        assert_eq!(baked, ".x { padding: 41px 8px 8px 12px; }");
    }
}

#[cfg(test)]
mod hot_styles_tests {
    use super::*;

    /// STY-1: the from-css core and the embedded path must produce identical
    /// sheets for the same insets, so hot reload cannot drift from pack output.
    #[test]
    fn from_css_matches_embedded() {
        let insets = SafeAreaInsets {
            top: 41.0,
            right: 0.0,
            bottom: 24.0,
            left: 12.0,
        };
        assert_eq!(
            product_stylesheets(insets),
            product_stylesheets_from_css(PRODUCT_CSS, insets)
        );
    }

    /// STY-2: with the env switch off the dev path behaves like the embedded
    /// path (production surface stays byte-identical).
    #[test]
    fn dev_path_without_env_matches_embedded() {
        // Ensure no leftover env from another (parallel) test in the same binary.
        std::env::remove_var(DEV_HOT_STYLES_ENV);
        std::env::remove_var(DEV_HOT_STYLES_PATH_ENV);
        reset_hot_stylesheet_cache();
        let insets = SafeAreaInsets::default();
        assert_eq!(product_stylesheets(insets), product_stylesheets_dev(insets));
    }

    /// STY-3: a dirty hot path is cached after the first read (two reads, same
    /// content), forcing a cache reset re-reads the changed file, and a missing
    /// file returns `None`. Uses explicit paths only — no process-global env —
    /// so it cannot race with other parallel tests.
    #[test]
    fn hot_stylesheet_from_path_caches_and_reloads() {
        let dir = std::env::temp_dir().join(format!(
            "nt-hot-styles-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("product.css");
        std::fs::write(&path, ":root { color: #aa0000; }").unwrap();
        reset_hot_stylesheet_cache();

        let first = load_hot_stylesheet_from(&path).expect("first read");
        assert!(first.contains("color: #aa0000"));
        // Second read without touching the file hits the cache.
        let second = load_hot_stylesheet_from(&path).expect("cached read");
        assert_eq!(first, second, "unchanged file must be served from cache");

        // Change the file and reset the cache → the new content is served.
        std::fs::write(&path, ":root { color: #bb0000; }").unwrap();
        reset_hot_stylesheet_cache();
        let third = load_hot_stylesheet_from(&path).expect("re-read");
        assert!(
            third.contains("color: #bb0000"),
            "re-read must pick up the new file"
        );

        // Missing file → None (callers fall back to the embedded sheet).
        std::fs::remove_file(&path).ok();
        reset_hot_stylesheet_cache();
        assert!(load_hot_stylesheet_from(&path).is_none());

        reset_hot_stylesheet_cache();
        std::fs::remove_dir_all(&dir).ok();
    }

    /// STY-4: the hot sheet still goes through the same safe-area baking as the
    /// embedded sheet (`product_stylesheets_from_css` is that shared core).
    #[test]
    fn from_css_bakes_safe_area_like_embedded() {
        let css = ":root { padding-top: max(8px, var(--nt-safe-area-top)); }";
        let baked = product_stylesheets_from_css(
            css,
            SafeAreaInsets {
                top: 41.0,
                ..Default::default()
            },
        );
        assert!(
            baked[0].contains("padding-top: 41px;"),
            "from-css must bake insets like the embedded path, got {:?}",
            baked[0]
        );
    }
}
