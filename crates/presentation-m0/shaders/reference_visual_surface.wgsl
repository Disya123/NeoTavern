struct VsIn {
    @location(0) pos: vec2<f32>,
    @location(1) uv: vec2<f32>,
}

struct VsOut {
    @builtin(position) clip_pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

struct LayerParams {
    uv_min: vec2<f32>,
    uv_max: vec2<f32>,
    misc: vec4<f32>,
}

@group(0) @binding(0) var atlas_tex: texture_2d<f32>;
@group(0) @binding(1) var atlas_samp: sampler;
@group(0) @binding(2) var<uniform> layer: LayerParams;

@vertex
fn vs_main(input: VsIn) -> VsOut {
    var out: VsOut;
    out.clip_pos = vec4<f32>(input.pos, 0.0, 1.0);
    out.uv = input.uv;
    return out;
}

@fragment
fn fs_main(input: VsOut) -> @location(0) vec4<f32> {
    let uv = mix(layer.uv_min, layer.uv_max, input.uv);
    let sample = textureSample(atlas_tex, atlas_samp, uv);
    let alpha = sample.a * layer.misc.x;
    return vec4<f32>(sample.rgb * alpha, alpha);
}
