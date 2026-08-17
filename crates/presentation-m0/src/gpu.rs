//! Shared wgpu Device/Queue + Vello raster + compositor-owned glass.

use std::num::NonZeroUsize;
#[cfg(target_os = "android")]
use std::os::raw::{c_char, c_int};

use vello::kurbo::{Affine, Rect as KurboRect, RoundedRect};
use vello::peniko::color::palette;
use vello::peniko::{BlendMode, Color, Compose, Fill, Mix};
use vello::wgpu::{
    self, BindGroupDescriptor, BindGroupEntry, BindGroupLayoutDescriptor, BindGroupLayoutEntry,
    BindingResource, BindingType, BlendComponent, BlendFactor, BlendState, BufferBindingType,
    BufferDescriptor, BufferUsages, ColorTargetState, ColorWrites, CommandEncoderDescriptor,
    Extent3d, FilterMode, FragmentState, FrontFace, LoadOp, MultisampleState, Operations, Origin3d,
    PipelineLayoutDescriptor, PrimitiveState, PrimitiveTopology, RenderPassColorAttachment,
    RenderPassDescriptor, RenderPipelineDescriptor, SamplerBindingType, SamplerDescriptor,
    ShaderStages, StoreOp, TexelCopyTextureInfo, TextureAspect, TextureDescriptor,
    TextureDimension, TextureFormat, TextureSampleType, TextureUsages, TextureViewDescriptor,
    TextureViewDimension, VertexState,
};
use vello::{AaConfig, AaSupport, RenderParams, Renderer, RendererOptions, Scene};

use crate::display_list::{
    ClipChainId, EffectKind, EffectNodeId, EffectScopeId, NeoDisplayList, PaintChunk,
    SpatialNodeId, StubPayload,
};
use crate::pass_graph::{compile_passes, CompiledPass};
use crate::timeline::{
    compositor_owned_bytes, encode_timeline, expected_first_frame, resolved_glass_roi,
    TimelineKind, ACCUMULATOR_LABEL, GLASS_SNAPSHOT_MAX, SNAPSHOT_LABEL, VELLO_LABEL,
};
use crate::verdict::{ProbeReport, SubstrateVerdict};

#[derive(Debug)]
pub enum GpuInitError {
    NoAdapter(String),
    Renderer(String),
}

impl GpuInitError {
    pub fn is_no_adapter(&self) -> bool {
        matches!(self, Self::NoAdapter(_))
    }
}

impl std::fmt::Display for GpuInitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoAdapter(msg) => write!(f, "no compatible wgpu adapter:{msg}"),
            Self::Renderer(msg) => write!(f, "vello renderer: {msg}"),
        }
    }
}

impl std::error::Error for GpuInitError {}

#[cfg(target_os = "android")]
#[link(name = "log")]
extern "C" {
    fn __android_log_write(prio: c_int, tag: *const c_char, text: *const c_char) -> c_int;
}

fn probe_trace(msg: &str) {
    #[cfg(target_os = "android")]
    {
        use std::ffi::CString;
        let Ok(tag) = CString::new("NeoTavern") else {
            return;
        };
        let Ok(text) = CString::new(msg) else {
            return;
        };
        unsafe {
            __android_log_write(4, tag.as_ptr(), text.as_ptr());
        }
    }
    let _ = msg;
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct GlassParams {
    roi: [f32; 4],
    target: [f32; 2],
    snapshot: [f32; 2],
    opacity: f32,
    _pad: [f32; 3],
}

pub struct ProbeGpu {
    device: wgpu::Device,
    queue: wgpu::Queue,
    renderer: Renderer,
    accumulator: wgpu::Texture,
    vello_target: wgpu::Texture,
    snapshot: wgpu::Texture,
    blit_pipeline: wgpu::RenderPipeline,
    glass_pipeline: wgpu::RenderPipeline,
    sampler: wgpu::Sampler,
    params_buf: wgpu::Buffer,
    blit_bgl: wgpu::BindGroupLayout,
    glass_bgl: wgpu::BindGroupLayout,
    width: u32,
    height: u32,
    pub cpu_readbacks: u64,
    pub cross_device_copies: u64,
    pub same_device_roi_copies: u64,
    pub devices_created: u64,
    pub raster_passes: u64,
    pub glass_passes: u64,
    pub software_adapter: bool,
    pub adapter_name: String,
    pub adapter_backend: String,
    timeline: Vec<TimelineKind>,
    recording_frame: bool,
    first_frame_cpu_us: u64,
    compositor_texture_bytes: u64,
}

impl ProbeGpu {
    pub fn try_new(width: u32, height: u32) -> Result<Self, GpuInitError> {
        let (device, queue, info) = open_probe_device()?;
        let software_adapter = matches!(info.device_type, wgpu::DeviceType::Cpu);
        let adapter_backend = format!("{:?}", info.backend);
        let renderer = Renderer::new(
            &device,
            RendererOptions {
                use_cpu: false,
                antialiasing_support: AaSupport::area_only(),
                num_init_threads: NonZeroUsize::new(1),
                ..Default::default()
            },
        )
        .map_err(|err| GpuInitError::Renderer(err.to_string()))?;

        let size = Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        };
        let compositor_texture_bytes = compositor_owned_bytes(width, height);
        let accumulator = device.create_texture(&TextureDescriptor {
            label: Some(ACCUMULATOR_LABEL),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: TextureDimension::D2,
            format: TextureFormat::Rgba8Unorm,
            usage: TextureUsages::RENDER_ATTACHMENT
                | TextureUsages::TEXTURE_BINDING
                | TextureUsages::COPY_SRC
                | TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let vello_target = device.create_texture(&TextureDescriptor {
            label: Some(VELLO_LABEL),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: TextureDimension::D2,
            format: TextureFormat::Rgba8Unorm,
            usage: TextureUsages::STORAGE_BINDING
                | TextureUsages::TEXTURE_BINDING
                | TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let snapshot = device.create_texture(&TextureDescriptor {
            label: Some(SNAPSHOT_LABEL),
            size: Extent3d {
                width: GLASS_SNAPSHOT_MAX,
                height: GLASS_SNAPSHOT_MAX,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: TextureDimension::D2,
            format: TextureFormat::Rgba8Unorm,
            usage: TextureUsages::TEXTURE_BINDING | TextureUsages::COPY_DST,
            view_formats: &[],
        });

        let sampler = device.create_sampler(&SamplerDescriptor {
            label: Some("m0-d1a-sampler"),
            mag_filter: FilterMode::Linear,
            min_filter: FilterMode::Linear,
            ..Default::default()
        });

        let blit_bgl = device.create_bind_group_layout(&BindGroupLayoutDescriptor {
            label: Some("m0-d1a-blit-bgl"),
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
            ],
        });
        let glass_bgl = device.create_bind_group_layout(&BindGroupLayoutDescriptor {
            label: Some("m0-d1a-glass-bgl"),
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
                    visibility: ShaderStages::VERTEX | ShaderStages::FRAGMENT,
                    ty: BindingType::Buffer {
                        ty: BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });

        let blit_layout = device.create_pipeline_layout(&PipelineLayoutDescriptor {
            label: Some("m0-d1a-blit-layout"),
            bind_group_layouts: &[Some(&blit_bgl)],
            immediate_size: 0,
        });
        let glass_layout = device.create_pipeline_layout(&PipelineLayoutDescriptor {
            label: Some("m0-d1a-glass-layout"),
            bind_group_layouts: &[Some(&glass_bgl)],
            immediate_size: 0,
        });

        let blit_shader = device.create_shader_module(wgpu::include_wgsl!("../shaders/blit.wgsl"));
        let glass_shader =
            device.create_shader_module(wgpu::include_wgsl!("../shaders/glass.wgsl"));

        let blit_pipeline = device.create_render_pipeline(&RenderPipelineDescriptor {
            label: Some("m0-d1a-blit"),
            layout: Some(&blit_layout),
            vertex: VertexState {
                module: &blit_shader,
                entry_point: Some("vs_main"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            fragment: Some(FragmentState {
                module: &blit_shader,
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
                topology: PrimitiveTopology::TriangleStrip,
                front_face: FrontFace::Ccw,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });
        let glass_pipeline = device.create_render_pipeline(&RenderPipelineDescriptor {
            label: Some("m0-d1a-glass"),
            layout: Some(&glass_layout),
            vertex: VertexState {
                module: &glass_shader,
                entry_point: Some("vs_main"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            fragment: Some(FragmentState {
                module: &glass_shader,
                entry_point: Some("fs_main"),
                compilation_options: Default::default(),
                targets: &[Some(ColorTargetState {
                    format: TextureFormat::Rgba8Unorm,
                    blend: Some(BlendState::REPLACE),
                    write_mask: ColorWrites::ALL,
                })],
            }),
            primitive: PrimitiveState {
                topology: PrimitiveTopology::TriangleStrip,
                front_face: FrontFace::Ccw,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });

        let params_buf = device.create_buffer(&BufferDescriptor {
            label: Some("m0-d1a-glass-params"),
            size: std::mem::size_of::<GlassParams>() as u64,
            usage: BufferUsages::UNIFORM | BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        Ok(Self {
            device,
            queue,
            renderer,
            accumulator,
            vello_target,
            snapshot,
            blit_pipeline,
            glass_pipeline,
            sampler,
            params_buf,
            blit_bgl,
            glass_bgl,
            width,
            height,
            cpu_readbacks: 0,
            cross_device_copies: 0,
            same_device_roi_copies: 0,
            devices_created: 1,
            raster_passes: 0,
            glass_passes: 0,
            software_adapter,
            adapter_name: info.name,
            adapter_backend,
            timeline: Vec::new(),
            recording_frame: false,
            first_frame_cpu_us: 0,
            compositor_texture_bytes,
        })
    }

    pub fn first_frame_timeline(&self) -> &[TimelineKind] {
        &self.timeline
    }

    pub fn render_list(&mut self, list: &NeoDisplayList, frame: u64) -> Result<(), GpuInitError> {
        self.recording_frame = frame == 0;
        if self.recording_frame {
            self.timeline.clear();
        }
        let passes =
            compile_passes(list).map_err(|err| GpuInitError::Renderer(format!("{err:?}")))?;
        let acc_view = self
            .accumulator
            .create_view(&TextureViewDescriptor::default());
        {
            let mut encoder = self
                .device
                .create_command_encoder(&CommandEncoderDescriptor {
                    label: Some("m0-d1a-clear"),
                });
            encoder.begin_render_pass(&RenderPassDescriptor {
                label: Some("m0-d1a-clear-acc"),
                color_attachments: &[Some(RenderPassColorAttachment {
                    view: &acc_view,
                    resolve_target: None,
                    ops: Operations {
                        load: LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: StoreOp::Store,
                    },
                    depth_slice: None,
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            self.queue.submit([encoder.finish()]);
        }
        if self.recording_frame {
            self.timeline.push(TimelineKind::ClearAccumulator);
        }

        for pass in passes {
            match pass {
                CompiledPass::Raster {
                    chunks,
                    open_scopes,
                } => {
                    let chunk_count = u32::try_from(chunks.len()).unwrap_or(u32::MAX);
                    self.raster_pass(list, &chunks, &open_scopes, chunk_count)?;
                    self.raster_passes += 1;
                }
                CompiledPass::Glass {
                    barrier,
                    open_scopes,
                } => {
                    let opacity = group_opacity(list, &open_scopes);
                    self.glass_pass(list, barrier.id.0, barrier.roi, barrier.clip_chain, opacity)?;
                    self.glass_passes += 1;
                }
            }
        }
        if self.recording_frame {
            let expected = expected_first_frame(list)
                .map_err(|err| GpuInitError::Renderer(format!("{err:?}")))?;
            if self.timeline != expected {
                return Err(GpuInitError::Renderer(format!(
                    "api timeline diverged from compiled pass graph: got={} expected={}",
                    encode_timeline(&self.timeline),
                    encode_timeline(&expected)
                )));
            }
        }
        Ok(())
    }

    fn raster_pass(
        &mut self,
        list: &NeoDisplayList,
        chunks: &[PaintChunk],
        open_scopes: &[EffectScopeId],
        chunk_count: u32,
    ) -> Result<(), GpuInitError> {
        let mut scene = Scene::new();
        let opacity = group_opacity(list, open_scopes);
        let grouped = (opacity - 1.0).abs() > f32::EPSILON;
        if grouped {
            scene.push_layer(
                Fill::NonZero,
                BlendMode::new(Mix::Normal, Compose::SrcOver),
                opacity,
                Affine::IDENTITY,
                &KurboRect::new(0.0, 0.0, f64::from(self.width), f64::from(self.height)),
            );
        }
        for chunk in chunks {
            encode_chunk(&mut scene, list, chunk);
        }
        if grouped {
            scene.pop_layer();
        }

        let view = self
            .vello_target
            .create_view(&TextureViewDescriptor::default());
        self.renderer
            .render_to_texture(
                &self.device,
                &self.queue,
                &scene,
                &view,
                &RenderParams {
                    base_color: palette::css::TRANSPARENT,
                    width: self.width,
                    height: self.height,
                    antialiasing_method: AaConfig::Area,
                },
            )
            .map_err(|err| GpuInitError::Renderer(err.to_string()))?;
        if self.recording_frame {
            self.timeline
                .push(TimelineKind::RasterToVello { chunk_count });
        }

        let src_view = self
            .vello_target
            .create_view(&TextureViewDescriptor::default());
        let acc_view = self
            .accumulator
            .create_view(&TextureViewDescriptor::default());
        let bind = self.device.create_bind_group(&BindGroupDescriptor {
            label: Some("m0-d1a-blit-bg"),
            layout: &self.blit_bgl,
            entries: &[
                BindGroupEntry {
                    binding: 0,
                    resource: BindingResource::TextureView(&src_view),
                },
                BindGroupEntry {
                    binding: 1,
                    resource: BindingResource::Sampler(&self.sampler),
                },
            ],
        });
        let mut encoder = self
            .device
            .create_command_encoder(&CommandEncoderDescriptor {
                label: Some("m0-d1a-blit"),
            });
        {
            let mut rp = encoder.begin_render_pass(&RenderPassDescriptor {
                label: Some("m0-d1a-blit-pass"),
                color_attachments: &[Some(RenderPassColorAttachment {
                    view: &acc_view,
                    resolve_target: None,
                    ops: Operations {
                        load: LoadOp::Load,
                        store: StoreOp::Store,
                    },
                    depth_slice: None,
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            rp.set_pipeline(&self.blit_pipeline);
            rp.set_bind_group(0, &bind, &[]);
            rp.draw(0..4, 0..1);
        }
        self.queue.submit([encoder.finish()]);
        if self.recording_frame {
            self.timeline.push(TimelineKind::BlitVelloToAccumulator);
        }
        Ok(())
    }

    fn glass_pass(
        &mut self,
        list: &NeoDisplayList,
        barrier: u32,
        roi: crate::display_list::Rect,
        clip: ClipChainId,
        opacity: f32,
    ) -> Result<(), GpuInitError> {
        let Some(px) = resolved_glass_roi(list, roi, clip, self.width, self.height) else {
            return Ok(());
        };
        let x = px.x;
        let y = px.y;
        let w = px.w;
        let h = px.h;

        let mut encoder = self
            .device
            .create_command_encoder(&CommandEncoderDescriptor {
                label: Some("m0-d1a-glass-copy"),
            });
        encoder.copy_texture_to_texture(
            TexelCopyTextureInfo {
                texture: &self.accumulator,
                mip_level: 0,
                origin: Origin3d { x, y, z: 0 },
                aspect: TextureAspect::All,
            },
            TexelCopyTextureInfo {
                texture: &self.snapshot,
                mip_level: 0,
                origin: Origin3d::ZERO,
                aspect: TextureAspect::All,
            },
            Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
        );
        self.same_device_roi_copies += 1;
        if self.recording_frame {
            self.timeline
                .push(TimelineKind::RoiCopyAccumulatorToSnapshot {
                    barrier,
                    x,
                    y,
                    w,
                    h,
                });
        }

        let params = GlassParams {
            roi: [x as f32, y as f32, w as f32, h as f32],
            target: [self.width as f32, self.height as f32],
            snapshot: [GLASS_SNAPSHOT_MAX as f32, GLASS_SNAPSHOT_MAX as f32],
            opacity,
            _pad: [0.0; 3],
        };
        self.queue
            .write_buffer(&self.params_buf, 0, bytemuck::bytes_of(&params));

        let snap_view = self.snapshot.create_view(&TextureViewDescriptor::default());
        let acc_view = self
            .accumulator
            .create_view(&TextureViewDescriptor::default());
        let bind = self.device.create_bind_group(&BindGroupDescriptor {
            label: Some("m0-d1a-glass-bg"),
            layout: &self.glass_bgl,
            entries: &[
                BindGroupEntry {
                    binding: 0,
                    resource: BindingResource::TextureView(&snap_view),
                },
                BindGroupEntry {
                    binding: 1,
                    resource: BindingResource::Sampler(&self.sampler),
                },
                BindGroupEntry {
                    binding: 2,
                    resource: self.params_buf.as_entire_binding(),
                },
            ],
        });
        {
            let mut rp = encoder.begin_render_pass(&RenderPassDescriptor {
                label: Some("m0-d1a-glass-pass"),
                color_attachments: &[Some(RenderPassColorAttachment {
                    view: &acc_view,
                    resolve_target: None,
                    ops: Operations {
                        load: LoadOp::Load,
                        store: StoreOp::Store,
                    },
                    depth_slice: None,
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            rp.set_pipeline(&self.glass_pipeline);
            rp.set_bind_group(0, &bind, &[]);
            rp.set_scissor_rect(x, y, w, h);
            rp.draw(0..4, 0..1);
        }
        self.queue.submit([encoder.finish()]);
        if self.recording_frame {
            self.timeline
                .push(TimelineKind::GlassSampleSnapshotWriteAccumulator {
                    barrier,
                    x,
                    y,
                    w,
                    h,
                });
        }
        Ok(())
    }

    pub fn report(&self, frames: u64) -> ProbeReport {
        ProbeReport {
            gpu_ran: true,
            adapter_name: self.adapter_name.clone(),
            adapter_backend: self.adapter_backend.clone(),
            software_adapter: self.software_adapter,
            devices_created: self.devices_created,
            cpu_readbacks: self.cpu_readbacks,
            cross_device_copies: self.cross_device_copies,
            same_device_roi_copies: self.same_device_roi_copies,
            raster_passes: self.raster_passes,
            glass_passes: self.glass_passes,
            frames,
            ran_on_android: cfg!(target_os = "android"),
            android_gpu_capture: false,
            api_timeline: encode_timeline(&self.timeline),
            api_timeline_events: self.timeline.len() as u64,
            first_frame_cpu_us: self.first_frame_cpu_us,
            compositor_texture_bytes: self.compositor_texture_bytes,
            verdict: SubstrateVerdict::Blocked {
                reason: "unclassified",
            },
        }
        .classify()
    }
}

fn probe_instance() -> wgpu::Instance {
    let backends = wgpu::Backends::from_env().unwrap_or_default();
    let flags = wgpu::InstanceFlags::from_build_config().with_env()
        | wgpu::InstanceFlags::ALLOW_UNDERLYING_NONCOMPLIANT_ADAPTER;
    wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends,
        flags,
        memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
        backend_options: wgpu::BackendOptions::from_env_or_default(),
        display: None,
    })
}

/// Prefer Vulkan even when the driver reports `Cpu` (some Android devices).
/// Default `request_adapter` ranking would pick GLES 3.0 instead, and Vello 0.9
/// needs compute. GLES remains a fallback if every Vulkan device fails.
///
/// Android emulator Goldfish/GFXStream Vulkan is skipped: Vello's first
/// `render_to_texture` `vkQueueSubmit` null-derefs in `vulkan.ranchu.so`
/// (`ResourceTracker::on_vkQueueSubmit`) on both SwiftShader and host NVIDIA.
fn adapter_sort_key(backend: wgpu::Backend, device_type: wgpu::DeviceType) -> (u8, u8) {
    let backend_rank = match backend {
        wgpu::Backend::Vulkan => 0,
        wgpu::Backend::Metal => 1,
        wgpu::Backend::Dx12 => 2,
        wgpu::Backend::Gl => 3,
        wgpu::Backend::BrowserWebGpu => 4,
        wgpu::Backend::Noop => 5,
    };
    let cpu_rank = u8::from(matches!(device_type, wgpu::DeviceType::Cpu));
    (backend_rank, cpu_rank)
}

fn skip_android_emulator_gfxstream_vulkan(info: &wgpu::AdapterInfo) -> bool {
    if info.backend != wgpu::Backend::Vulkan {
        return false;
    }
    let name = info.name.to_ascii_lowercase();
    name.contains("goldfish")
        || name.contains("gfxstream")
        || name.contains("swiftshader")
        || name.contains("android emulator")
}

fn open_device_on(adapter: &wgpu::Adapter) -> Result<(wgpu::Device, wgpu::Queue), String> {
    let required_features =
        adapter.features() & (wgpu::Features::CLEAR_TEXTURE | wgpu::Features::PIPELINE_CACHE);
    let request = |limits: wgpu::Limits| {
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("m0-d1a"),
            required_features,
            required_limits: limits,
            ..Default::default()
        }))
    };
    match request(wgpu::Limits::default()) {
        Ok(pair) => Ok(pair),
        Err(default_err) => request(adapter.limits()).map_err(|adapter_err| {
            format!("default_limits={default_err};adapter_limits={adapter_err}")
        }),
    }
}

fn open_probe_device() -> Result<(wgpu::Device, wgpu::Queue, wgpu::AdapterInfo), GpuInitError> {
    probe_trace("open_probe_device");
    let instance = probe_instance();
    let mut adapters = pollster::block_on(instance.enumerate_adapters(wgpu::Backends::all()));
    if adapters.is_empty() {
        let err = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            compatible_surface: None,
        }));
        let detail = match err {
            Ok(_) => "enumerate_adapters_empty".to_string(),
            Err(err) => err.to_string().replace(' ', "_"),
        };
        return Err(GpuInitError::NoAdapter(detail));
    }
    adapters.sort_by_key(|adapter| {
        let info = adapter.get_info();
        adapter_sort_key(info.backend, info.device_type)
    });
    let mut errors = Vec::new();
    for adapter in adapters {
        let info = adapter.get_info();
        if skip_android_emulator_gfxstream_vulkan(&info) {
            probe_trace(&format!(
                "skip_gfxstream_vulkan {}",
                info.name.replace(' ', "_")
            ));
            errors.push(format!(
                "{}:{:?}:{:?}:skipped_emulator_gfxstream_vulkan",
                info.name.replace(' ', "_"),
                info.backend,
                info.device_type
            ));
            continue;
        }
        match open_device_on(&adapter) {
            Ok((device, queue)) => {
                probe_trace(&format!(
                    "adapter_ok {} {:?} {:?}",
                    info.name.replace(' ', "_"),
                    info.backend,
                    info.device_type
                ));
                return Ok((device, queue, info));
            }
            Err(err) => errors.push(format!(
                "{}:{:?}:{:?}:{err}",
                info.name.replace(' ', "_"),
                info.backend,
                info.device_type
            )),
        }
    }
    Err(GpuInitError::NoAdapter(format!(
        "all_adapters_failed:{}",
        errors.join(";")
    )))
}

fn group_opacity(list: &NeoDisplayList, scopes: &[EffectScopeId]) -> f32 {
    let mut opacity = 1.0;
    for scope in scopes {
        if let Some(effect) = list
            .effects
            .iter()
            .find(|node| node.id == EffectNodeId(scope.0))
        {
            if let EffectKind::Opacity(value) = effect.kind {
                opacity *= value;
            }
        }
    }
    opacity
}

fn spatial_affine(list: &NeoDisplayList, id: SpatialNodeId) -> Affine {
    let mut chain = Vec::new();
    let mut current = Some(id);
    while let Some(node_id) = current {
        let Some(node) = list.spatial.iter().find(|node| node.id == node_id) else {
            break;
        };
        chain.push(node.transform);
        current = node.parent;
    }
    let mut out = Affine::IDENTITY;
    for coeffs in chain.into_iter().rev() {
        out *= Affine::new(coeffs.0);
    }
    out
}

fn clip_rect(list: &NeoDisplayList, id: ClipChainId) -> KurboRect {
    list.clips
        .iter()
        .find(|node| node.id == id)
        .map(|node| {
            KurboRect::new(
                f64::from(node.rect.x),
                f64::from(node.rect.y),
                f64::from(node.rect.x1()),
                f64::from(node.rect.y1()),
            )
        })
        .unwrap_or_else(|| KurboRect::new(0.0, 0.0, 1.0, 1.0))
}

fn encode_chunk(scene: &mut Scene, list: &NeoDisplayList, chunk: &PaintChunk) {
    let transform = spatial_affine(list, chunk.spatial_node);
    let clip = clip_rect(list, chunk.clip_chain);
    scene.push_clip_layer(Fill::NonZero, Affine::IDENTITY, &clip);
    if let Some(effect) = list
        .effects
        .iter()
        .find(|node| node.id == chunk.effect_node)
    {
        if let EffectKind::Opacity(value) = effect.kind {
            scene.push_layer(
                Fill::NonZero,
                BlendMode::new(Mix::Normal, Compose::SrcOver),
                value,
                Affine::IDENTITY,
                &clip,
            );
        }
    }
    let color = match chunk.payload {
        StubPayload::Wallpaper => Color::from_rgb8(32, 48, 72),
        StubPayload::VectorUi => Color::from_rgb8(240, 220, 180),
        StubPayload::Overlay => Color::from_rgb8(220, 72, 72),
    };
    let shape = match chunk.payload {
        StubPayload::Wallpaper => KurboRect::new(
            f64::from(chunk.bounds.x),
            f64::from(chunk.bounds.y),
            f64::from(chunk.bounds.x1()),
            f64::from(chunk.bounds.y1()),
        ),
        StubPayload::VectorUi | StubPayload::Overlay => {
            let rect = KurboRect::new(
                f64::from(chunk.bounds.x),
                f64::from(chunk.bounds.y),
                f64::from(chunk.bounds.x1()),
                f64::from(chunk.bounds.y1()),
            );
            scene.fill(
                Fill::NonZero,
                transform,
                color,
                None,
                &RoundedRect::from_rect(rect, 8.0),
            );
            scene.pop_layer();
            if matches!(
                list.effects
                    .iter()
                    .find(|node| node.id == chunk.effect_node)
                    .map(|node| node.kind),
                Some(EffectKind::Opacity(_))
            ) {
                scene.pop_layer();
            }
            return;
        }
    };
    scene.fill(Fill::NonZero, transform, color, None, &shape);
    if matches!(
        list.effects
            .iter()
            .find(|node| node.id == chunk.effect_node)
            .map(|node| node.kind),
        Some(EffectKind::Opacity(_))
    ) {
        scene.pop_layer();
    }
    scene.pop_layer();
}

pub fn run_static_d1a(frames: u64) -> Result<ProbeReport, GpuInitError> {
    probe_trace(&format!("run_static_d1a frames={frames}"));
    let list = crate::static_d1a_scene();
    let mut gpu = ProbeGpu::try_new(list.width, list.height)?;
    probe_trace(&format!(
        "gpu_ready adapter={} backend={} software={}",
        gpu.adapter_name.replace(' ', "_"),
        gpu.adapter_backend,
        gpu.software_adapter
    ));
    for frame in 0..frames {
        if frame == 0 {
            probe_trace("first_frame_begin");
        }
        let started = if frame == 0 {
            Some(std::time::Instant::now())
        } else {
            None
        };
        gpu.render_list(&list, frame)?;
        if let Some(started) = started {
            gpu.first_frame_cpu_us =
                u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX);
            probe_trace("first_frame_done");
        }
    }
    Ok(gpu.report(frames))
}

#[cfg(test)]
mod adapter_pick_tests {
    use super::adapter_sort_key;
    use vello::wgpu;

    #[test]
    fn vulkan_cpu_beats_gles_integrated() {
        let vk_cpu = adapter_sort_key(wgpu::Backend::Vulkan, wgpu::DeviceType::Cpu);
        let gl_igpu = adapter_sort_key(wgpu::Backend::Gl, wgpu::DeviceType::IntegratedGpu);
        assert!(vk_cpu < gl_igpu);
    }

    #[test]
    fn skips_goldfish_gfxstream_vulkan() {
        let info = wgpu::AdapterInfo {
            name: "Goldfish GFXStream (NVIDIA GeForce RTX 3060)".into(),
            vendor: 0,
            device: 0,
            device_type: wgpu::DeviceType::DiscreteGpu,
            driver: String::new(),
            driver_info: String::new(),
            backend: wgpu::Backend::Vulkan,
            transient_saves_memory: false,
            subgroup_min_size: 4,
            subgroup_max_size: 128,
            device_pci_bus_id: String::new(),
        };
        assert!(super::skip_android_emulator_gfxstream_vulkan(&info));
        let phone = wgpu::AdapterInfo {
            name: "Adreno (TM) 730".into(),
            ..info.clone()
        };
        assert!(!super::skip_android_emulator_gfxstream_vulkan(&phone));
    }

    #[test]
    fn vulkan_discrete_beats_vulkan_cpu() {
        let vk_dgpu = adapter_sort_key(wgpu::Backend::Vulkan, wgpu::DeviceType::DiscreteGpu);
        let vk_cpu = adapter_sort_key(wgpu::Backend::Vulkan, wgpu::DeviceType::Cpu);
        assert!(vk_dgpu < vk_cpu);
    }
}
