//! Single source of the desktop/Android blit shader (image-pipeline audit
//! stage C wallpaper underlay). Both `vello_gpu::PresentSurface` and the
//! Android `android_surface` host compile THIS constant — there is no second
//! copy to drift away from.

/// Fullscreen-triangle blit: samples `resolve` into the swapchain, with the
/// NeoCompositor scroll blend window, a fixed wallpaper underlay, and optional
/// sRGB re-encode. The window is a 2D rect — `scroll[0] =
/// (offset_y, band_top, band_bottom, srgb)` — where `offset_y` is the drift
/// normalized to RASTER height and the band to swapchain height,
/// `scroll[1].xy = (band_left, band_right)` normalized to width — so split
/// layouts shift only the chat column. Uniform rows 2/3 are the wallpaper
/// underlay: `scroll[2] = (x0, y0, x1, y1)` dest rect in uv, `scroll[3] =
/// (enabled, overlay dim alpha, raster uv top, raster uv scale)`, and
/// `scroll[4] = (src_top, src_bottom, 0, 0)` — the uv window the drift may
/// occupy before the filler branch takes over. The scene rasters are taller
/// than the swapchain by the overscan strips (144fps scroll runway), so
/// every texture sample maps the screen uv into the middle raster window
/// (`doc_y = uv.y * scale + top`) before the shift; hosts without overscan
/// pass `(0.0, 1.0)` and reduce to the flat mapping. The wallpaper
/// (bindings 3/4) is sampled at the UNSHIFTED fragment uv inside the rect, so
/// the photo stays fixed while the scene scrolls over it, and the band's
/// out-of-range region composites the photo over the flat filler instead of
/// replacing it. With `enabled = 0` the underlay is fully transparent and the
/// shader reduces to the pre-wallpaper blit.
pub const BLIT_WGSL: &str = r#"
struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> }
@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> scroll: array<vec4<f32>, 5>;
@group(0) @binding(3) var wall_tex: texture_2d<f32>;
@group(0) @binding(4) var wall_samp: sampler;
@vertex fn vs(@builtin(vertex_index) i: u32) -> VsOut {
    var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
    let pos = p[i];
    var out: VsOut;
    out.pos = vec4<f32>(pos, 0.0, 1.0);
    out.uv = vec2<f32>(pos.x * 0.5 + 0.5, 1.0 - (pos.y * 0.5 + 0.5));
    return out;
}
@fragment fn fs(in: VsOut) -> @location(0) vec4<f32> {
    var uv = in.uv;
    let in_band = uv.y >= scroll[0].y && uv.y < scroll[0].z
        && uv.x >= scroll[1].x && uv.x < scroll[1].y;
    // Screen -> raster doc uv: the raster is taller than the swapchain by
    // the overscan strips, so the screen samples the middle window.
    let doc_y = uv.y * scroll[3].w + scroll[3].z;
    let src_y = doc_y + scroll[0].x;
    // The shift is safe while the sample stays inside the source window
    // (the baked overscan runway; the host's ack cap lands a re-produce
    // before it runs out). Past it the raster has no baked content and the
    // wallpaper filler branch below takes over.
    let shifted = in_band && src_y >= scroll[4].x && src_y < scroll[4].y;
    uv.y = select(doc_y, src_y, shifted);
    var wall = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    if (scroll[3].x > 0.5) {
        let wx = (in.uv.x - scroll[2].x) / max(scroll[2].z - scroll[2].x, 1e-6);
        let wy = (in.uv.y - scroll[2].y) / max(scroll[2].w - scroll[2].y, 1e-6);
        if (wx >= 0.0 && wx <= 1.0 && wy >= 0.0 && wy <= 1.0) {
            wall = textureSampleLevel(wall_tex, wall_samp, vec2<f32>(wx, wy), 0.0);
            // React parity: the dim gradient lives inside the wallpaper
            // element (fixed with the photo), never scrolls with the scene.
            let dim = clamp(scroll[3].y, 0.0, 1.0);
            wall = vec4(wall.rgb * (1.0 - dim)
                + vec3<f32>(0.0706, 0.0627, 0.0549) * dim, wall.a);
        }
    }
    let c = textureSampleLevel(tex, samp, uv, 0.0);
    var rgb = c.rgb + wall.rgb * (1.0 - c.a);
    if (in_band && !shifted) {
        rgb = wall.rgb + vec3<f32>(0.082, 0.075, 0.067) * (1.0 - wall.a);
    }
    if (scroll[0].w > 0.5) {
        let lo = rgb / 12.92;
        let hi = pow((rgb + 0.055) / 1.055, vec3<f32>(2.4));
        rgb = select(hi, lo, rgb <= vec3<f32>(0.04045));
    }
    return vec4<f32>(rgb, 1.0);
}
"#;
