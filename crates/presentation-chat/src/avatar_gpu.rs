//! Sampled GPU avatar overlay. Same device/queue as NeoCompositor.
//!
//! Not a Vello Image brush and not a CPU full-frame raster. Header and card
//! share one cached texture per `asset_id`.

use std::collections::{HashMap, VecDeque};
use std::num::NonZeroU64;

use neotavern_neocompositor::ImagePaintOp;

use crate::avatar::AvatarThumb;

/// How many avatar textures the GPU cache may retain before the oldest are
/// evicted. One cached texture per `asset_id` is shared by header and card.
pub const AVATAR_GPU_MAX_ENTRIES: usize = 64;
/// Total GPU bytes budget for avatar textures (147 KiB per 192×192 thumbnail).
pub const AVATAR_GPU_MAX_BYTES: usize = 8 * 1024 * 1024;

const AVATAR_WGSL: &str = r#"
struct Uniform {
    dest: vec4<f32>,
    surface: vec2<f32>,
    radius: f32,
    // texture width / height — drives the cover-fit UV crop below.
    tex_aspect: f32,
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
    // Cover-fit: sample the largest centered texture region whose aspect
    // matches dest. A square 192px thumb then CROPS (React `object-fit:
    // cover`) into any slot rect — e.g. the 4:5 gallery avatar — instead of
    // stretching. For a texture already matching the dest aspect (the
    // wallpaper raster) the crop is the identity.
    var uv = in.uv;
    let dest_aspect = u.dest.z / max(u.dest.w, 1.0);
    if (u.tex_aspect > dest_aspect) {
        let w = dest_aspect / u.tex_aspect;
        uv.x = uv.x * w + (1.0 - w) * 0.5;
    } else {
        let h = u.tex_aspect / dest_aspect;
        uv.y = uv.y * h + (1.0 - h) * 0.5;
    }
    let half = u.dest.zw * 0.5;
    let radius = min(u.radius, min(half.x, half.y));
    let p = in.local - half;
    let b = max(half - vec2<f32>(radius), vec2<f32>(0.0));
    let q = abs(p) - b;
    let d = length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - radius;
    if (d > 0.5) {
        discard;
    }
    return textureSample(tex, samp, uv);
}
"#;

struct CachedAvatar {
    view: wgpu::TextureView,
    _texture: wgpu::Texture,
    /// width / height of the uploaded texture (drives the cover-fit crop).
    aspect: f32,
}

pub struct AvatarGpu {
    pipeline: wgpu::RenderPipeline,
    bgl: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    textures: HashMap<String, CachedAvatar>,
    /// LRU order: front = most-recently used, back = least-recently used.
    order: VecDeque<String>,
    sizes: HashMap<String, usize>,
    total_bytes: usize,
    device_epoch: u64,
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
        let make_pipeline = |label: &'static str, blend: wgpu::BlendState| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
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
                        blend: Some(blend),
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                multiview_mask: None,
                cache: None,
            })
        };
        let pipeline = make_pipeline(
            "avatar-pipe",
            wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING,
        );
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            ..Default::default()
        });
        Self {
            pipeline,
            bgl,
            sampler,
            textures: HashMap::new(),
            order: VecDeque::new(),
            sizes: HashMap::new(),
            total_bytes: 0,
            device_epoch: 0,
            ready_token: 0,
            target_format,
        }
    }

    pub fn ready_token(&self) -> u64 {
        self.ready_token
    }

    /// Returns the number of cached avatar textures.
    pub fn len(&self) -> usize {
        self.textures.len()
    }

    /// Whether the cache holds no textures.
    pub fn is_empty(&self) -> bool {
        self.textures.is_empty()
    }

    /// Total GPU bytes currently held by avatar textures.
    pub fn total_bytes(&self) -> usize {
        self.total_bytes
    }

    /// Invalidate every cached texture when the wgpu `Device` epoch changes.
    /// Textures belong to the old device/queue and would otherwise be sampled
    /// as `StaleEpoch` by `SharedGpuContext`. Returns the number of evicted
    /// entries.
    pub fn set_device_epoch(&mut self, epoch: u64) -> usize {
        if epoch == self.device_epoch {
            return 0;
        }
        let evicted = self.textures.len();
        self.textures.clear();
        self.order.clear();
        self.sizes.clear();
        self.total_bytes = 0;
        self.device_epoch = epoch;
        // Bump ready_token so the compositor re-uploads after the clear.
        if evicted > 0 {
            self.ready_token = self.ready_token.saturating_add(1);
        }
        evicted
    }

    /// Evict the least-recently used avatars until `bytes_to_free` have been
    /// released. Used by the pressure controller.
    pub fn evict_for_pressure(&mut self, bytes_to_free: usize) -> usize {
        let mut freed = 0usize;
        let mut evicted = 0usize;
        while freed < bytes_to_free {
            let Some(key) = self.order.pop_back() else {
                break;
            };
            if let Some(size) = self.sizes.remove(&key) {
                freed = freed.saturating_add(size);
                self.total_bytes = self.total_bytes.saturating_sub(size);
            }
            if self.textures.remove(&key).is_some() {
                evicted += 1;
            }
        }
        if evicted > 0 {
            self.ready_token = self.ready_token.saturating_add(1);
        }
        evicted
    }

    fn touch(&mut self, asset_id: &str) {
        if let Some(pos) = self.order.iter().position(|k| k == asset_id) {
            self.order.remove(pos);
            self.order.push_front(asset_id.to_string());
        }
    }

    fn make_room(&mut self, need_bytes: usize) {
        while (self.total_bytes.saturating_add(need_bytes) > AVATAR_GPU_MAX_BYTES
            || self.order.len() + 1 > AVATAR_GPU_MAX_ENTRIES)
            && !self.order.is_empty()
        {
            let Some(key) = self.order.pop_back() else {
                break;
            };
            if let Some(size) = self.sizes.remove(&key) {
                self.total_bytes = self.total_bytes.saturating_sub(size);
            }
            self.textures.remove(&key);
        }
    }

    pub fn upload(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        asset_id: &str,
        thumb: &AvatarThumb,
    ) -> bool {
        if self.textures.contains_key(asset_id) {
            self.touch(asset_id);
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
        let need_bytes = expected;
        self.make_room(need_bytes);
        // Full mip chain built on the CPU — downscaling PREMULTIPLIED RGBA is
        // linear-filter-correct, and wgpu 29 has no `generate_mipmaps` helper.
        // Thumbnails (192px) draw into slots from 32px to ~450px; without
        // mips the minification side aliases.
        let mip_levels = 32 - thumb.width.max(thumb.height).leading_zeros();
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("avatar-thumb"),
            size: wgpu::Extent3d {
                width: thumb.width,
                height: thumb.height,
                depth_or_array_layers: 1,
            },
            mip_level_count: mip_levels,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let mut level_w = thumb.width;
        let mut level_h = thumb.height;
        let mut current =
            image::RgbaImage::from_raw(thumb.width, thumb.height, thumb.premul_rgba.clone());
        for level in 0..mip_levels {
            let Some(image) = current.take() else { break };
            queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &texture,
                    mip_level: level,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                image.as_raw(),
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(level_w * 4),
                    rows_per_image: Some(level_h),
                },
                wgpu::Extent3d {
                    width: level_w,
                    height: level_h,
                    depth_or_array_layers: 1,
                },
            );
            if level + 1 < mip_levels {
                let next_w = (level_w / 2).max(1);
                let next_h = (level_h / 2).max(1);
                let next = image::imageops::resize(
                    &image,
                    next_w,
                    next_h,
                    image::imageops::FilterType::Triangle,
                );
                current = Some(next);
                level_w = next_w;
                level_h = next_h;
            }
        }
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let aspect = thumb.width as f32 / thumb.height as f32;
        self.textures.insert(
            asset_id.to_string(),
            CachedAvatar {
                view,
                _texture: texture,
                aspect,
            },
        );
        self.order.push_front(asset_id.to_string());
        self.sizes.insert(asset_id.to_string(), need_bytes);
        self.total_bytes = self.total_bytes.saturating_add(need_bytes);
        self.ready_token = self.ready_token.saturating_add(1);
        let _ = self.target_format;
        true
    }

    pub fn blit(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        target: &wgpu::TextureView,
        surface_w: u32,
        surface_h: u32,
        ops: &[ImagePaintOp],
    ) {
        self.blit_impl(device, queue, target, surface_w, surface_h, ops);
    }

    fn blit_impl(
        &mut self,
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
        // Promote visible avatars so the LRU keeps header/card shared handles hot.
        let to_touch: Vec<String> = ops
            .iter()
            .filter(|op| !op.dest.is_empty() && self.textures.contains_key(&op.asset_id))
            .map(|op| op.asset_id.clone())
            .collect();
        for id in to_touch {
            self.touch(&id);
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
                cached.aspect,
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
