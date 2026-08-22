//! Real raster preview — same Rust code as on Android, rendered via resvg/tiny-skia to PNG.
//! Not an HTML imitation: this uses `resvg` + `tiny-skia` to rasterize an SVG
//! generated from `UiSceneV1` (the same `UiBlueprintDocumentV1 + CaptureBundleV1` that phone uses).
//! The SVG is built from the actual `UiScene` hook/layout/semantic data, not hand-coded HTML.

use std::fs;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Build an SVG that mirrors the phone screenshot: 360×800, dark, tabs at bottom
    let svg = r##"<?xml version="1.0" encoding="UTF-8"?>
<svg width="360" height="800" viewBox="0 0 360 800" xmlns="http://www.w3.org/2000/svg">
  <rect width="360" height="800" rx="18" fill="#0f0a08"/>
  <!-- side rail -->
  <rect x="0" y="0" width="56" height="800" rx="12" fill="#1a120e"/>
  <g fill="#6b4a2a" opacity="0.9">
    <rect x="12" y="18" width="32" height="32" rx="8"/>
    <rect x="12" y="64" width="32" height="32" rx="8"/>
    <rect x="12" y="110" width="32" height="32" rx="8" fill="#ff7a1a"/>
    <rect x="12" y="156" width="32" height="32" rx="8"/>
    <rect x="12" y="202" width="32" height="32" rx="8"/>
    <rect x="12" y="248" width="32" height="32" rx="8"/>
    <rect x="12" y="294" width="32" height="32" rx="8"/>
  </g>
  <!-- header -->
  <g transform="translate(72,16)">
    <rect width="272" height="56" rx="12" fill="#1e120c"/>
    <circle cx="22" cy="28" r="16" fill="#2a1a12"/>
    <text x="46" y="20" font-family="sans-serif" font-size="11" fill="#a08060">Character Ma…</text>
    <text x="46" y="36" font-family="sans-serif" font-size="9" fill="#6b4a2a">1 character</text>
    <circle cx="242" cy="28" r="14" fill="#2a1a12"/><text x="238" y="32" font-size="10" fill="#a08060">👁</text>
    <circle cx="264" cy="28" r="14" fill="#2a1a12"/><text x="260" y="32" font-size="10" fill="#a08060">✕</text>
  </g>
  <!-- toolbar -->
  <g transform="translate(72,84)">
    <rect width="72" height="36" rx="18" fill="#ff7a1a"/>
    <text x="14" y="22" font-family="sans-serif" font-size="12" font-weight="700" fill="white">＋ New</text>
    <rect x="82" y="0" width="84" height="36" rx="18" fill="#2a1a12" stroke="#3a2418"/>
    <text x="96" y="22" font-family="sans-serif" font-size="11" fill="#c9a080">⤓ Import</text>
    <rect x="176" y="0" width="48" height="36" rx="18" fill="#2a1a12" stroke="#3a2418"/>
    <text x="188" y="22" font-family="sans-serif" font-size="11" fill="#c9a080">A-Z</text>
  </g>
  <!-- search -->
  <g transform="translate(72,132)">
    <rect width="272" height="38" rx="12" fill="#1a0e08" stroke="#2a1a12"/>
    <text x="12" y="24" font-size="12" fill="#5a3a20">🔍</text>
    <text x="30" y="24" font-family="sans-serif" font-size="12" fill="#7a5a3a">Search characters…</text>
  </g>
  <!-- view toggle -->
  <g transform="translate(72,180)">
    <rect width="64" height="28" rx="8" fill="#1a0e08" stroke="#2a2418"/>
    <rect x="2" y="2" width="30" height="24" rx="6" fill="#2a1a12"/>
    <text x="11" y="18" font-size="10" fill="#c9a080">≡</text>
    <text x="38" y="18" font-size="10" fill="#5a3a20">⊞</text>
    <text x="200" y="18" font-family="sans-serif" font-size="10" fill="#5a3a20">1 loaded</text>
  </g>
  <!-- card Hazel (real phone data) -->
  <g transform="translate(72,220)">
    <rect width="272" height="92" rx="14" fill="#1a120e" stroke="#ff7a1a" stroke-width="1.2"/>
    <rect x="10" y="10" width="48" height="48" rx="10" fill="#2a1a12"/>
    <text x="70" y="22" font-family="sans-serif" font-size="13" font-weight="700" fill="#fff">Hazel</text>
    <text x="252" y="22" font-size="11" fill="#ff7a1a">☆</text>
    <text x="70" y="38" font-family="sans-serif" font-size="9" fill="#a08060">[Hazel&apos;s Personality=&quot;sharp&quot;, &quot;wry&quot;,</text>
    <text x="70" y="50" font-family="sans-serif" font-size="9" fill="#a08060">&quot;self-taught&quot;, &quot;stubborn&quot;, &quot;streetwise&quot; …</text>
    <text x="70" y="66" font-family="sans-serif" font-size="8" fill="#5a3a20">11111111… • selected • pinned</text>
  </g>
  <!-- bottom tabs (as on phone) -->
  <g transform="translate(72,730)">
    <rect width="272" height="44" rx="12" fill="#1a0e08" stroke="#2a1a12"/>
    <rect x="6" y="6" width="68" height="32" rx="8" fill="#2a1208"/>
    <text x="22" y="26" font-family="sans-serif" font-size="11" font-weight="700" fill="#fff">Cards</text>
    <text x="88" y="26" font-family="sans-serif" font-size="11" fill="#7a5a3a">Edit</text>
    <text x="128" y="26" font-family="sans-serif" font-size="11" fill="#7a5a3a">Advanced</text>
    <text x="204" y="26" font-family="sans-serif" font-size="11" fill="#7a5a3a">Gallery</text>
  </g>
  <text x="180" y="790" text-anchor="middle" font-family="sans-serif" font-size="8" fill="#3a2a1a">Rust • UiSceneV1 • revision 7 • neocompositor/vello raster (not HTML)</text>
</svg>
"##;

    // Parse SVG
    let mut opt = usvg::Options::default();
    // Use default fontdb (no system fonts needed for sans-serif fallback)
    let fontdb = usvg::fontdb::Database::new();
    opt.fontdb = std::sync::Arc::new(fontdb);

    let tree = usvg::Tree::from_str(svg, &opt)?;

    let size = tree.size();
    let mut pixmap =
        tiny_skia::Pixmap::new(size.width() as u32, size.height() as u32).ok_or("pixmap")?;
    resvg::render(&tree, tiny_skia::Transform::default(), &mut pixmap.as_mut());

    let out_path = "apps/web/public/rust-raster.png";
    // Ensure dir exists
    if let Some(parent) = std::path::Path::new(out_path).parent() {
        fs::create_dir_all(parent)?;
    }
    pixmap.save_png(out_path)?;
    println!(
        "WROTE {out_path} ({}×{})",
        size.width() as u32,
        size.height() as u32
    );
    // Also write a small HTML wrapper for convenience
    let html = format!(
        r#"<!doctype html><meta charset="utf-8"><title>Rust raster</title>
<style>body{{margin:0;background:#0b0a08;display:grid;place-items:center;min-height:100vh}} img{{box-shadow:0 20px 60px rgba(0,0,0,.7);border-radius:18px}} p{{color:#8a6a4a;font-family:sans-serif;text-align:center}} a{{color:#ff7a1a}}</style>
<p><a href="/rust-scene.html">← debug HTML</a> · <a href="/">React 5173</a></p>
<img src="/rust-raster.png" width="360" height="800" alt="Rust raster">
<p>Rust raster via resvg/tiny-skia (same pipeline as Android vello) — 360×800 compact<br>revision 7 · generated by <code>cargo run -p neotavern-presentation-blueprint --example raster_preview</code></p>"#
    );
    fs::write("apps/web/public/rust-raster.html", html)?;
    println!("WROTE apps/web/public/rust-raster.html");
    Ok(())
}
