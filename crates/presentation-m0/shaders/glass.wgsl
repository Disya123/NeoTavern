struct VsOut {
    @builtin(position) clip_pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

struct Params {
    roi: vec4<f32>,
    target_px: vec2<f32>,
    snapshot_px: vec2<f32>,
    opacity: f32,
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
}

@group(0) @binding(0) var backdrop: texture_2d<f32>;
@group(0) @binding(1) var backdrop_samp: sampler;
@group(0) @binding(2) var<uniform> params: Params;

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VsOut {
    var corners = array<vec2<f32>, 4>(
        vec2<f32>(0.0, 0.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 1.0),
    );
    let c = corners[vid];
    let px = params.roi.xy + c * params.roi.zw;
    let ndc = vec2<f32>(
        px.x / params.target_px.x * 2.0 - 1.0,
        1.0 - px.y / params.target_px.y * 2.0,
    );
    var out: VsOut;
    out.clip_pos = vec4<f32>(ndc, 0.0, 1.0);
    out.uv = vec2<f32>(
        c.x * params.roi.z / params.snapshot_px.x,
        c.y * params.roi.w / params.snapshot_px.y,
    );
    return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let texel = vec2<f32>(1.0) / params.snapshot_px;
    var acc = textureSample(backdrop, backdrop_samp, in.uv);
    acc += textureSample(backdrop, backdrop_samp, in.uv + vec2<f32>(texel.x * 2.0, 0.0));
    acc += textureSample(backdrop, backdrop_samp, in.uv - vec2<f32>(texel.x * 2.0, 0.0));
    acc += textureSample(backdrop, backdrop_samp, in.uv + vec2<f32>(0.0, texel.y * 2.0));
    acc += textureSample(backdrop, backdrop_samp, in.uv - vec2<f32>(0.0, texel.y * 2.0));
    acc = acc / 5.0;
    let tint = vec4<f32>(0.82, 0.90, 1.0, 0.55);
    var out = mix(acc, tint, 0.35);
    out.a = clamp(out.a * params.opacity, 0.0, 1.0);
    return out;
}
