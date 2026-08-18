//! GPU path for the trusted reference VisualSurface producer.
//! Renders a deforming textured mesh into a sampleable surface. Not Plugin SDK.

use neotavern_neocompositor::{
    ReferenceSurfaceWork, SurfaceContent, SurfaceFence, SurfaceFrame, SurfaceId, TypedGpuHandle,
    DEFAULT_FORMAT, REFERENCE_SURFACE_HEIGHT, REFERENCE_SURFACE_WIDTH,
};
use vello::wgpu::{
    self, BindGroupDescriptor, BindGroupEntry, BindGroupLayoutDescriptor, BindGroupLayoutEntry,
    BindingResource, BindingType, BlendComponent, BlendFactor, BlendState, BufferBindingType,
    BufferDescriptor, BufferUsages, ColorTargetState, ColorWrites, CommandEncoderDescriptor,
    Extent3d, FilterMode, FragmentState, FrontFace, LoadOp, MultisampleState, Operations, Origin3d,
    PipelineLayoutDescriptor, PrimitiveState, PrimitiveTopology, RenderPassColorAttachment,
    RenderPassDescriptor, RenderPipelineDescriptor, SamplerBindingType, SamplerDescriptor,
    ShaderStages, StoreOp, TexelCopyBufferLayout, TexelCopyTextureInfo, TextureAspect,
    TextureDescriptor, TextureDimension, TextureFormat, TextureSampleType, TextureUsages,
    TextureViewDescriptor, TextureViewDimension, VertexState, VertexStepMode,
};

use crate::gpu::{GpuInitError, ProbeGpu};

const VERTEX_ATTRS: [wgpu::VertexAttribute; 2] =
    wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x2];

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct GpuVertex {
    pos: [f32; 2],
    uv: [f32; 2],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct LayerParams {
    uv_min: [f32; 2],
    uv_max: [f32; 2],
    misc: [f32; 4],
}

pub(crate) struct ReferenceVsGpu {
    atlas: wgpu::Texture,
    target: wgpu::Texture,
    pipeline: wgpu::RenderPipeline,
    bgl: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    vertex: wgpu::Buffer,
    index: wgpu::Buffer,
    uniforms: [wgpu::Buffer; 3],
    handle: TypedGpuHandle,
    atlas_uploaded: bool,
}

impl ProbeGpu {
    pub fn render_reference_visual_surface(
        &mut self,
        surface: SurfaceId,
        generation: u64,
        work: &ReferenceSurfaceWork,
    ) -> Result<SurfaceFrame, GpuInitError> {
        if work.width != REFERENCE_SURFACE_WIDTH || work.height != REFERENCE_SURFACE_HEIGHT {
            return Err(GpuInitError::Renderer(
                "reference visual surface size mismatch".into(),
            ));
        }
        self.ensure_reference_vs()?;
        let Some(gpu) = self.reference_vs.as_mut() else {
            return Err(GpuInitError::Renderer(
                "reference visual surface gpu missing".into(),
            ));
        };
        if !gpu.atlas_uploaded {
            self.queue.write_texture(
                TexelCopyTextureInfo {
                    texture: &gpu.atlas,
                    mip_level: 0,
                    origin: Origin3d::ZERO,
                    aspect: TextureAspect::All,
                },
                &work.atlas_rgba,
                TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(work.width * 4),
                    rows_per_image: Some(work.height),
                },
                Extent3d {
                    width: work.width,
                    height: work.height,
                    depth_or_array_layers: 1,
                },
            );
            gpu.atlas_uploaded = true;
        }
        let mut verts = Vec::with_capacity(work.vertices.len());
        let sx = 2.0 / work.width as f32;
        let sy = 2.0 / work.height as f32;
        for v in &work.vertices {
            verts.push(GpuVertex {
                pos: [v.x * sx - 1.0, 1.0 - v.y * sy],
                uv: [v.u, v.v],
            });
        }
        self.queue
            .write_buffer(&gpu.vertex, 0, bytemuck::cast_slice(&verts));
        self.queue
            .write_buffer(&gpu.index, 0, bytemuck::cast_slice(&work.indices));
        for (i, layer) in work.layers.iter().enumerate() {
            let params = LayerParams {
                uv_min: layer.uv_min,
                uv_max: layer.uv_max,
                misc: [layer.alpha, 0.0, 0.0, 0.0],
            };
            self.queue
                .write_buffer(&gpu.uniforms[i], 0, bytemuck::bytes_of(&params));
        }
        let atlas_view = gpu.atlas.create_view(&TextureViewDescriptor::default());
        let target_view = gpu.target.create_view(&TextureViewDescriptor::default());
        let binds: Vec<wgpu::BindGroup> = gpu
            .uniforms
            .iter()
            .map(|uniform| {
                self.device.create_bind_group(&BindGroupDescriptor {
                    label: Some("perf15-reference-vs-bg"),
                    layout: &gpu.bgl,
                    entries: &[
                        BindGroupEntry {
                            binding: 0,
                            resource: BindingResource::TextureView(&atlas_view),
                        },
                        BindGroupEntry {
                            binding: 1,
                            resource: BindingResource::Sampler(&gpu.sampler),
                        },
                        BindGroupEntry {
                            binding: 2,
                            resource: uniform.as_entire_binding(),
                        },
                    ],
                })
            })
            .collect();
        let mut encoder = self
            .device
            .create_command_encoder(&CommandEncoderDescriptor {
                label: Some("perf15-reference-visual-surface"),
            });
        encoder.push_debug_group("perf15-reference-visual-surface");
        {
            let mut rp = encoder.begin_render_pass(&RenderPassDescriptor {
                label: Some("perf15-reference-vs-layers"),
                color_attachments: &[Some(RenderPassColorAttachment {
                    view: &target_view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: Operations {
                        load: LoadOp::Clear(wgpu::Color {
                            r: 0.0,
                            g: 0.0,
                            b: 0.0,
                            a: 0.0,
                        }),
                        store: StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            rp.set_pipeline(&gpu.pipeline);
            rp.set_vertex_buffer(0, gpu.vertex.slice(..));
            rp.set_index_buffer(gpu.index.slice(..), wgpu::IndexFormat::Uint16);
            let n = u32::try_from(work.indices.len()).unwrap_or(0);
            for bind in &binds {
                rp.set_bind_group(0, bind, &[]);
                rp.draw_indexed(0..n, 0, 0..1);
            }
        }
        encoder.pop_debug_group();
        self.queue.submit([encoder.finish()]);
        let handle = gpu.handle;
        Ok(SurfaceFrame {
            surface,
            generation,
            sequence: work.sequence,
            timestamp: work.timestamp,
            content: SurfaceContent::Sampleable {
                handle,
                width: work.width,
                height: work.height,
                format: DEFAULT_FORMAT.texture_format,
                usage: DEFAULT_FORMAT.usage,
                bytes: (work.width as usize) * (work.height as usize) * 4,
            },
            damage: Some(work.damage),
            fence: Some(SurfaceFence {
                ready: true,
                device_epoch: self.shared.device_epoch(),
            }),
        })
    }

    fn ensure_reference_vs(&mut self) -> Result<(), GpuInitError> {
        if self.reference_vs.is_some() {
            return Ok(());
        }
        let handle = self
            .shared
            .alloc_surface()
            .map_err(|err| GpuInitError::Renderer(format!("alloc surface: {err}")))?;
        let size = Extent3d {
            width: REFERENCE_SURFACE_WIDTH,
            height: REFERENCE_SURFACE_HEIGHT,
            depth_or_array_layers: 1,
        };
        let atlas = self.device.create_texture(&TextureDescriptor {
            label: Some("perf15-reference-vs-atlas"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: TextureDimension::D2,
            format: TextureFormat::Rgba8Unorm,
            usage: TextureUsages::TEXTURE_BINDING | TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let target = self.device.create_texture(&TextureDescriptor {
            label: Some("perf15-reference-vs-target"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: TextureDimension::D2,
            format: TextureFormat::Rgba8Unorm,
            usage: TextureUsages::RENDER_ATTACHMENT
                | TextureUsages::TEXTURE_BINDING
                | TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let sampler = self.device.create_sampler(&SamplerDescriptor {
            label: Some("perf15-reference-vs-sampler"),
            mag_filter: FilterMode::Linear,
            min_filter: FilterMode::Linear,
            ..Default::default()
        });
        let bgl = self
            .device
            .create_bind_group_layout(&BindGroupLayoutDescriptor {
                label: Some("perf15-reference-vs-bgl"),
                entries: &[
                    BindGroupLayoutEntry {
                        binding: 0,
                        visibility: ShaderStages::FRAGMENT,
                        ty: BindingType::Texture {
                            sample_type: TextureSampleType::Float { filterable: true },
                            view_dimension: TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    BindGroupLayoutEntry {
                        binding: 1,
                        visibility: ShaderStages::FRAGMENT,
                        ty: BindingType::Sampler(SamplerBindingType::Filtering),
                        count: None,
                    },
                    BindGroupLayoutEntry {
                        binding: 2,
                        visibility: ShaderStages::FRAGMENT,
                        ty: BindingType::Buffer {
                            ty: BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                ],
            });
        let layout = self
            .device
            .create_pipeline_layout(&PipelineLayoutDescriptor {
                label: Some("perf15-reference-vs-layout"),
                bind_group_layouts: &[Some(&bgl)],
                immediate_size: 0,
            });
        let shader = self.device.create_shader_module(wgpu::include_wgsl!(
            "../shaders/reference_visual_surface.wgsl"
        ));
        let pipeline = self
            .device
            .create_render_pipeline(&RenderPipelineDescriptor {
                label: Some("perf15-reference-vs"),
                layout: Some(&layout),
                vertex: VertexState {
                    module: &shader,
                    entry_point: Some("vs_main"),
                    compilation_options: Default::default(),
                    buffers: &[wgpu::VertexBufferLayout {
                        array_stride: std::mem::size_of::<GpuVertex>() as u64,
                        step_mode: VertexStepMode::Vertex,
                        attributes: &VERTEX_ATTRS,
                    }],
                },
                fragment: Some(FragmentState {
                    module: &shader,
                    entry_point: Some("fs_main"),
                    compilation_options: Default::default(),
                    targets: &[Some(ColorTargetState {
                        format: TextureFormat::Rgba8Unorm,
                        blend: Some(BlendState {
                            color: BlendComponent {
                                src_factor: BlendFactor::One,
                                dst_factor: BlendFactor::OneMinusSrcAlpha,
                                operation: wgpu::BlendOperation::Add,
                            },
                            alpha: BlendComponent {
                                src_factor: BlendFactor::One,
                                dst_factor: BlendFactor::OneMinusSrcAlpha,
                                operation: wgpu::BlendOperation::Add,
                            },
                        }),
                        write_mask: ColorWrites::ALL,
                    })],
                }),
                primitive: PrimitiveState {
                    topology: PrimitiveTopology::TriangleList,
                    front_face: FrontFace::Ccw,
                    ..Default::default()
                },
                depth_stencil: None,
                multisample: MultisampleState::default(),
                multiview_mask: None,
                cache: None,
            });
        let vertex = self.device.create_buffer(&BufferDescriptor {
            label: Some("perf15-reference-vs-vertex"),
            size: 64 * std::mem::size_of::<GpuVertex>() as u64,
            usage: BufferUsages::VERTEX | BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let index = self.device.create_buffer(&BufferDescriptor {
            label: Some("perf15-reference-vs-index"),
            size: 256,
            usage: BufferUsages::INDEX | BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let uniforms = std::array::from_fn(|i| {
            self.device.create_buffer(&BufferDescriptor {
                label: Some(match i {
                    0 => "perf15-reference-vs-layer0",
                    1 => "perf15-reference-vs-layer1",
                    _ => "perf15-reference-vs-layer2",
                }),
                size: std::mem::size_of::<LayerParams>() as u64,
                usage: BufferUsages::UNIFORM | BufferUsages::COPY_DST,
                mapped_at_creation: false,
            })
        });
        self.reference_vs = Some(ReferenceVsGpu {
            atlas,
            target,
            pipeline,
            bgl,
            sampler,
            vertex,
            index,
            uniforms,
            handle,
            atlas_uploaded: false,
        });
        Ok(())
    }
}
