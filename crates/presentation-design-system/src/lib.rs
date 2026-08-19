//! React golden design system packed for Blitz.
//!
//! Tokens, fonts, and Phosphor regular paths come from the React UI. Do not
//! substitute Dioxus defaults, similar icons, or a restyled type ramp.

use parley::fontique::{
    Blob, Collection, CollectionOptions, FontInfoOverride, GenericFamily, SourceCache,
};
use parley::FontContext;
use std::sync::Arc;

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

fn bake_insets(css: &str, insets: SafeAreaInsets) -> String {
    let baked = css
        .replace("var(--nt-inset-top)", &format!("{}px", insets.top))
        .replace("var(--nt-safe-area-top)", &format!("{}px", insets.top))
        .replace("var(--nt-inset-right)", &format!("{}px", insets.right))
        .replace("var(--nt-safe-area-right)", &format!("{}px", insets.right))
        .replace("var(--nt-inset-bottom)", &format!("{}px", insets.bottom))
        .replace(
            "var(--nt-safe-area-bottom)",
            &format!("{}px", insets.bottom),
        )
        .replace("var(--nt-inset-left)", &format!("{}px", insets.left))
        .replace("var(--nt-safe-area-left)", &format!("{}px", insets.left));
    collapse_calc_px_sum(&collapse_max_px(&baked))
}

fn parse_px_token(value: &str) -> Option<f32> {
    value.trim().strip_suffix("px")?.trim().parse().ok()
}

fn collapse_two_arg_fn(css: &str, name: &str, combine: fn(f32, f32) -> f32) -> String {
    let needle = format!("{name}(");
    let mut out = String::with_capacity(css.len());
    let mut rest = css;
    while let Some(idx) = rest.find(&needle) {
        out.push_str(&rest[..idx]);
        let after = &rest[idx + needle.len()..];
        if let Some(close) = after.find(')') {
            let inner = after[..close].trim();
            if let Some((left, right)) = inner.split_once(',') {
                if let (Some(a), Some(b)) = (parse_px_token(left), parse_px_token(right)) {
                    out.push_str(&format!("{}px", combine(a, b)));
                    rest = &after[close + 1..];
                    continue;
                }
            }
        }
        out.push_str(&needle);
        rest = after;
    }
    out.push_str(rest);
    out
}

fn collapse_max_px(css: &str) -> String {
    collapse_two_arg_fn(css, "max", f32::max)
}

fn collapse_calc_px_sum(css: &str) -> String {
    let needle = "calc(";
    let mut out = String::with_capacity(css.len());
    let mut rest = css;
    while let Some(idx) = rest.find(needle) {
        out.push_str(&rest[..idx]);
        let after = &rest[idx + needle.len()..];
        if let Some(close) = after.find(')') {
            let inner = after[..close].trim();
            if let Some((left, right)) = inner.split_once('+') {
                if let (Some(a), Some(b)) = (parse_px_token(left), parse_px_token(right)) {
                    out.push_str(&format!("{}px", a + b));
                    rest = &after[close + 1..];
                    continue;
                }
            }
        }
        out.push_str(needle);
        rest = after;
    }
    out.push_str(rest);
    out
}

pub fn product_stylesheets(insets: SafeAreaInsets) -> Vec<String> {
    vec![bake_insets(PRODUCT_CSS, insets), inset_stylesheet(insets)]
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
}
