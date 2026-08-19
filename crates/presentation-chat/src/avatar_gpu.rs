//! Sampled GPU avatar overlay. Same device/queue as NeoCompositor.
//!
//! Not a Vello Image brush and not a CPU full-frame raster. Header and card
//! share one cached texture per `asset_id`.

use std::collections::HashMap;
use std::num::NonZeroU64;

use neotavern_neocompositor::ImagePaintOp;

use crate::avatar::AvatarThumb;

const AVATAR_WGSL: &str = r#"
struct Uniform {
    dest: vec4<f32>,
    surface: vec2<f32>,
    radius: f32,
    _pad: f32,
}
struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32>, @location(1) local: vec2<f32> }
@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> u: Uniform;
@vertex fn vs(@builtin(vertex_index) i: u32) -> VsOut {
    var p = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
        vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0)
    );
    let uv = p[i];
    let px = u.dest.xy + uv * u.dest.zw;
    var out: VsOut;
    out.pos = vec4<f32>(px.x / u.surface.x * 2.0 - 1.0, 1.0 - px.y / u.surface.y * 2.0, 0.0, 1.0);
    out.uv = uv;
    out.local = uv * u.dest.zw;
    return out;
}
@fragment fn fs(in: VsOut) -> @location(0) vec4<f32> {
    let half = u.dest.zw * 0.5;
    let radius = min(u.radius, min(half.x, half.y));
    let p = in.local - half;
    let b = max(half - vec2<f32>(radius), vec2<f32>(0.0));
    let q = abs(p) - b;
    let d = length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - radius;
    if (d > 0.5) {
        discard;
    }
    return textureSample(tex, samp, in.uv);
}
"#;

struct CachedAvatar {
    view: wgpu::TextureView,
    _texture: wgpu::Texture,
}

pub struct AvatarGpu {
    pipeline: wgpu::RenderPipeline,
    bgl: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    textures: HashMap<String, CachedAvatar>,
    ready_token: u64,
    target_format: wgpu::TextureFormat,
}

impl AvatarGpu {
    pub fn new(device: &wgpu::Device, target_format: wgpu::TextureFormat) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("avatar-overlay"),
            source: wgpu::ShaderSource::Wgsl(AVATAR_WGSL.into()),
        });
        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("avatar-bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: NonZeroU64::new(32),
                    },
                    count: None,
                },
            ],
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("avatar-pll"),
            bind_group_layouts: &[Some(&bgl)],
            immediate_size: 0,
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("avatar-pipe"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: target_format,
                    blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            ..Default::default()
        });
        Self {
            pipeline,
            bgl,
            sampler,
            textures: HashMap::new(),
            ready_token: 0,
            target_format,
        }
    }

    pub fn ready_token(&self) -> u64 {
        self.ready_token
    }

    pub fn upload(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        asset_id: &str,
        thumb: &AvatarThumb,
    ) -> bool {
        if self.textures.contains_key(asset_id) {
            return false;
        }
        if thumb.width == 0 || thumb.height == 0 {
            return false;
        }
        let expected = (thumb.width as usize)
            .saturating_mul(thumb.height as usize)
            .saturating_mul(4);
        if thumb.premul_rgba.len() != expected {
            return false;
        }
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("avatar-thumb"),
            size: wgpu::Extent3d {
                width: thumb.width,
                height: thumb.height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &thumb.premul_rgba,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(thumb.width * 4),
                rows_per_image: Some(thumb.height),
            },
            wgpu::Extent3d {
                width: thumb.width,
                height: thumb.height,
                depth_or_array_layers: 1,
            },
        );
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        self.textures.insert(
            asset_id.to_string(),
            CachedAvatar {
                view,
                _texture: texture,
            },
        );
        self.ready_token = self.ready_token.saturating_add(1);
        let _ = self.target_format;
        true
    }

    pub fn blit(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        target: &wgpu::TextureView,
        surface_w: u32,
        surface_h: u32,
        ops: &[ImagePaintOp],
    ) {
        if ops.is_empty() {
            return;
        }
        let mut draws: Vec<(wgpu::BindGroup, wgpu::Buffer)> = Vec::new();
        for op in ops {
            if op.dest.is_empty() {
                continue;
            }
            let Some(cached) = self.textures.get(&op.asset_id) else {
                continue;
            };
            let uniform = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("avatar-uniform"),
                size: 32,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            let data = [
                op.dest.x,
                op.dest.y,
                op.dest.width,
                op.dest.height,
                surface_w as f32,
                surface_h as f32,
                op.clip_radius,
                0.0,
            ];
            queue.write_buffer(&uniform, 0, &f32_bytes(&data));
            let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("avatar-bg"),
                layout: &self.bgl,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&cached.view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(&self.sampler),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: uniform.as_entire_binding(),
                    },
                ],
            });
            draws.push((bind, uniform));
        }
        if draws.is_empty() {
            return;
        }
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("avatar-overlay"),
        });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("avatar-overlay"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: target,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Store,
                    },
                    depth_slice: None,
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&self.pipeline);
            for (bind, _) in &draws {
                pass.set_bind_group(0, bind, &[]);
                pass.draw(0..6, 0..1);
            }
        }
        queue.submit(Some(encoder.finish()));
    }
}

fn f32_bytes(data: &[f32; 8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (i, value) in data.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&value.to_le_bytes());
    }
    out
}
