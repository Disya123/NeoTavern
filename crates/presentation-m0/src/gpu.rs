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
    ShaderStages, StoreOp, TexelCopyBufferLayout, TexelCopyTextureInfo, TextureAspect,
    TextureDescriptor, TextureDimension, TextureFormat, TextureSampleType, TextureUsages,
    TextureViewDescriptor, TextureViewDimension, VertexState,
};
use vello::{AaConfig, AaSupport, RenderParams, Renderer, RendererOptions, Scene};

use crate::display_list::{
    ClipChainId, EffectKind, EffectNodeId, EffectScopeId, NeoDisplayList, NeoPaintOp, PaintChunk,
    SpatialNodeId, StubPayload,
};
use crate::pass_graph::{compile_passes, CompiledPass, InteractionPassKind};
use crate::timeline::{
    compositor_owned_bytes, compositor_owned_bytes_d1b, encode_timeline, expected_first_frame,
    expected_motion_frame, resolved_glass_roi, TimelineKind, ACCUMULATOR_LABEL,
    CAPTURE_GROUP_D1B_GLASS_PREFIX, CAPTURE_GROUP_D1B_ROI_PREFIX, CAPTURE_GROUP_D2_GLASS_PREFIX,
    CAPTURE_GROUP_D2_ROI_PREFIX, CAPTURE_GROUP_GLASS_PREFIX, CAPTURE_GROUP_ROI_PREFIX,
    CAPTURE_PASS_BLIT, CAPTURE_PASS_CLEAR, CAPTURE_PASS_D2_MOVING, CAPTURE_PASS_D2_OVERLAY,
    CAPTURE_PASS_D2_RESTORE, CAPTURE_PASS_GLASS, CAPTURE_PASS_MOVING, CAPTURE_PASS_OVERLAY,
    CAPTURE_PASS_RESTORE, GLASS_SNAPSHOT_MAX, MOVING_LABEL, MOVING_LABEL_D2, SNAPSHOT_LABEL,
    STATIC_PREFIX_LABEL, STATIC_PREFIX_LABEL_D2, VELLO_LABEL,
};
use crate::verdict::{ProbeReport, SubstrateVerdict};
use neotavern_neocompositor::{
    BoundBackend, DeviceEpoch, GpuCaps, GpuRecovery, HandleOwner, InteropPresentOutcome,
    SharedGpuContext, SharedGpuError, SharedHandleKind,
};

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

/// Debug-group / resource-name set. D1a/D1b goldens stay on `m0-d1b-*`;
/// D2 capture uses `m0-d2-*` so the Event Browser is distinguishable.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LabelMode {
    D1a,
    D1b,
    D2,
    Perf18,
    Perf19,
    Perf20,
    Perf15,
    Perf22,
    Recovery,
}

/// Evidence that the live wgpu device was destroyed and a new one opened.
/// CPU `LossDetected` without `wgpu_destroyed` is not physical device-loss.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PhysicalWgpuLoss {
    pub wgpu_destroyed: bool,
    pub wgpu_recreated: bool,
    pub device_epoch_before: u64,
    pub device_epoch_after: u64,
    pub live_wgpu_devices: u32,
    pub devices_created: u64,
    pub stale_handle_rejected: bool,
    pub identity_unchanged: bool,
    pub recovery_duration_us: u64,
}

#[cfg(target_os = "android")]
#[link(name = "log")]
extern "C" {
    fn __android_log_write(prio: c_int, tag: *const c_char, text: *const c_char) -> c_int;
}

pub(crate) fn probe_trace(msg: &str) {
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
    pub(crate) device: wgpu::Device,
    pub(crate) queue: wgpu::Queue,
    renderer: Renderer,
    accumulator: wgpu::Texture,
    vello_target: wgpu::Texture,
    snapshot: wgpu::Texture,
    moving: Option<wgpu::Texture>,
    pre_moving: Option<wgpu::Texture>,
    blit_pipeline: wgpu::RenderPipeline,
    glass_pipeline: wgpu::RenderPipeline,
    pub(crate) sampler: wgpu::Sampler,
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
    pub moving_sample_blits: u64,
    pub pass_compiles: u64,
    pub sampled_generation: u64,
    pub vello_rebuilds: u64,
    pub layout_rebuilds: u64,
    pub ui_rebuilds: u64,
    pub paint_scene_rebuilds: u64,
    pub render_thread_polls: u64,
    pub capture_only_polls: u64,
    last_damage: Option<crate::timeline::RoiPx>,
    capture_timeline: Vec<TimelineKind>,
    recording_capture: bool,
    pub software_adapter: bool,
    pub adapter_name: String,
    pub adapter_backend: String,
    timeline: Vec<TimelineKind>,
    recording_frame: bool,
    first_frame_cpu_us: u64,
    compositor_texture_bytes: u64,
    label_mode: LabelMode,
    capture_at: Option<u64>,
    pub(crate) shared: SharedGpuContext,
    raster_backend: BoundBackend,
    compositor_backend: BoundBackend,
    pub(crate) reference_vs: Option<crate::reference_visual_surface::ReferenceVsGpu>,
}

impl ProbeGpu {
    pub fn try_new(width: u32, height: u32) -> Result<Self, GpuInitError> {
        Self::try_new_inner(width, height, false, LabelMode::D1a)
    }

    pub fn try_new_labeled(
        width: u32,
        height: u32,
        label_mode: LabelMode,
    ) -> Result<Self, GpuInitError> {
        Self::try_new_inner(width, height, false, label_mode)
    }

    pub fn try_new_d1b(width: u32, height: u32) -> Result<Self, GpuInitError> {
        Self::try_new_inner(width, height, true, LabelMode::D1b)
    }

    pub fn try_new_d2(width: u32, height: u32) -> Result<Self, GpuInitError> {
        Self::try_new_inner(width, height, true, LabelMode::D2)
    }

    fn try_new_inner(
        width: u32,
        height: u32,
        with_moving: bool,
        label_mode: LabelMode,
    ) -> Result<Self, GpuInitError> {
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
        let compositor_texture_bytes = if with_moving {
            compositor_owned_bytes_d1b(width, height)
        } else {
            compositor_owned_bytes(width, height)
        };
        let mut shared = SharedGpuContext::open(GpuCaps::host_default())
            .map_err(|err| GpuInitError::Renderer(format!("shared gpu context: {err}")))?;
        let raster_backend = shared
            .bind_raster()
            .map_err(|err| GpuInitError::Renderer(format!("bind raster backend: {err}")))?;
        let compositor_backend = shared
            .bind_compositor()
            .map_err(|err| GpuInitError::Renderer(format!("bind compositor backend: {err}")))?;
        if raster_backend.identity != compositor_backend.identity {
            return Err(GpuInitError::Renderer(
                "vello and compositor bound different device identities".into(),
            ));
        }
        shared
            .alloc(HandleOwner::Compositor, SharedHandleKind::Accumulator)
            .map_err(|err| GpuInitError::Renderer(format!("shared accumulator: {err}")))?;
        shared
            .alloc(HandleOwner::Glass, SharedHandleKind::GlassRoi)
            .map_err(|err| GpuInitError::Renderer(format!("shared glass roi: {err}")))?;
        shared
            .alloc(HandleOwner::Surface, SharedHandleKind::Surface)
            .map_err(|err| GpuInitError::Renderer(format!("shared surface: {err}")))?;
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
        let moving = if with_moving {
            let size_px = crate::scene_d1b::MOVING_SIZE;
            let tex = device.create_texture(&TextureDescriptor {
                label: Some(match label_mode {
                    LabelMode::D2 => MOVING_LABEL_D2,
                    _ => MOVING_LABEL,
                }),
                size: Extent3d {
                    width: size_px,
                    height: size_px,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: TextureDimension::D2,
                format: TextureFormat::Rgba8Unorm,
                usage: TextureUsages::TEXTURE_BINDING
                    | TextureUsages::COPY_SRC
                    | TextureUsages::COPY_DST,
                view_formats: &[],
            });
            upload_moving_checker(&queue, &tex, size_px);
            Some(tex)
        } else {
            None
        };
        let pre_moving = if with_moving {
            Some(device.create_texture(&TextureDescriptor {
                label: Some(match label_mode {
                    LabelMode::D2 => STATIC_PREFIX_LABEL_D2,
                    _ => STATIC_PREFIX_LABEL,
                }),
                size,
                mip_level_count: 1,
                sample_count: 1,
                dimension: TextureDimension::D2,
                format: TextureFormat::Rgba8Unorm,
                usage: TextureUsages::TEXTURE_BINDING
                    | TextureUsages::COPY_SRC
                    | TextureUsages::COPY_DST
                    | TextureUsages::RENDER_ATTACHMENT,
                view_formats: &[],
            }))
        } else {
            None
        };

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
            moving,
            pre_moving,
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
            moving_sample_blits: 0,
            pass_compiles: 0,
            sampled_generation: 0,
            vello_rebuilds: 0,
            layout_rebuilds: 0,
            ui_rebuilds: 0,
            paint_scene_rebuilds: 0,
            render_thread_polls: 0,
            capture_only_polls: 0,
            last_damage: None,
            capture_timeline: Vec::new(),
            recording_capture: false,
            software_adapter,
            adapter_name: info.name,
            adapter_backend,
            timeline: Vec::new(),
            recording_frame: false,
            first_frame_cpu_us: 0,
            compositor_texture_bytes,
            label_mode,
            // CPU capture timeline at D1b/D2 generation 120. RenderDoc still
            // requires `capture=true` in `run_dynamic_list_at`.
            capture_at: match label_mode {
                LabelMode::D1b | LabelMode::D2 => Some(crate::scene_d1b::D1B_CAPTURE_FRAME),
                _ => None,
            },
            shared,
            raster_backend,
            compositor_backend,
            reference_vs: None,
        })
    }

    /// Destroy the live wgpu device and open a replacement on the **same**
    /// [`SharedGpuContext`]. CPU `on_device_lost` alone is not physical.
    pub fn inject_physical_wgpu_loss(&mut self) -> Result<PhysicalWgpuLoss, GpuInitError> {
        let stale_handle = self
            .shared
            .raster_tile()
            .map_err(|err| GpuInitError::Renderer(format!("stale handle before loss: {err}")))?;
        let old_epoch = self.shared.device_epoch();
        let identity = self.shared.identity();
        let old_created = self.devices_created;
        let width = self.width;
        let height = self.height;
        let with_moving = self.moving.is_some();
        let label_mode = self.label_mode;
        let pass_compiles = self.pass_compiles;
        let raster_passes = self.raster_passes;
        let glass_passes = self.glass_passes;
        let cpu_readbacks = self.cpu_readbacks;
        let cross_device_copies = self.cross_device_copies;

        self.device.destroy();
        let mut fresh = Self::try_new_inner(width, height, with_moving, label_mode)?;
        std::mem::swap(&mut self.device, &mut fresh.device);
        std::mem::swap(&mut self.queue, &mut fresh.queue);
        std::mem::swap(&mut self.renderer, &mut fresh.renderer);
        std::mem::swap(&mut self.accumulator, &mut fresh.accumulator);
        std::mem::swap(&mut self.vello_target, &mut fresh.vello_target);
        std::mem::swap(&mut self.snapshot, &mut fresh.snapshot);
        std::mem::swap(&mut self.moving, &mut fresh.moving);
        std::mem::swap(&mut self.pre_moving, &mut fresh.pre_moving);
        std::mem::swap(&mut self.blit_pipeline, &mut fresh.blit_pipeline);
        std::mem::swap(&mut self.glass_pipeline, &mut fresh.glass_pipeline);
        std::mem::swap(&mut self.sampler, &mut fresh.sampler);
        std::mem::swap(&mut self.params_buf, &mut fresh.params_buf);
        std::mem::swap(&mut self.blit_bgl, &mut fresh.blit_bgl);
        std::mem::swap(&mut self.glass_bgl, &mut fresh.glass_bgl);
        self.software_adapter = fresh.software_adapter;
        self.adapter_name = fresh.adapter_name.clone();
        self.adapter_backend = fresh.adapter_backend.clone();
        self.compositor_texture_bytes = fresh.compositor_texture_bytes;
        drop(fresh);

        let mut recovery = GpuRecovery::new();
        recovery
            .initialize()
            .map_err(|err| GpuInitError::Renderer(format!("recovery init: {err:?}")))?;
        let new_epoch = self
            .shared
            .on_device_lost(&mut recovery)
            .map_err(|err| GpuInitError::Renderer(format!("shared device lost: {err}")))?;
        let stale_handle_rejected = matches!(
            self.shared.sample_tile(stale_handle),
            Err(SharedGpuError::StaleEpoch)
        );
        self.reference_vs = None;
        self.raster_backend.epoch = new_epoch;
        self.compositor_backend.epoch = new_epoch;
        self.shared
            .alloc(HandleOwner::Compositor, SharedHandleKind::Accumulator)
            .map_err(|err| GpuInitError::Renderer(format!("shared accumulator: {err}")))?;
        self.shared
            .alloc(HandleOwner::Glass, SharedHandleKind::GlassRoi)
            .map_err(|err| GpuInitError::Renderer(format!("shared glass roi: {err}")))?;
        self.shared
            .alloc(HandleOwner::Surface, SharedHandleKind::Surface)
            .map_err(|err| GpuInitError::Renderer(format!("shared surface: {err}")))?;
        self.devices_created = old_created.saturating_add(1);
        self.pass_compiles = pass_compiles;
        self.raster_passes = raster_passes;
        self.glass_passes = glass_passes;
        self.cpu_readbacks = cpu_readbacks;
        self.cross_device_copies = cross_device_copies;
        if identity != self.shared.identity() {
            return Err(GpuInitError::Renderer(
                "shared device identity changed during wgpu recreate".into(),
            ));
        }
        Ok(PhysicalWgpuLoss {
            wgpu_destroyed: true,
            wgpu_recreated: true,
            device_epoch_before: old_epoch.0,
            device_epoch_after: new_epoch.0,
            live_wgpu_devices: 1,
            devices_created: self.devices_created,
            stale_handle_rejected,
            identity_unchanged: true,
            recovery_duration_us: recovery.last_recovery_duration_us(),
        })
    }

    pub fn device_epoch(&self) -> DeviceEpoch {
        self.shared.device_epoch()
    }

    pub fn upload_decoded_image(
        &mut self,
        rgba: &[u8],
        width: u32,
        height: u32,
    ) -> Result<(), GpuInitError> {
        if rgba.len() != (width as usize) * (height as usize) * 4 {
            return Err(GpuInitError::Renderer(
                "decoded image byte length mismatch".into(),
            ));
        }
        let w = width.min(GLASS_SNAPSHOT_MAX);
        let h = height.min(GLASS_SNAPSHOT_MAX);
        self.queue.write_texture(
            TexelCopyTextureInfo {
                texture: &self.snapshot,
                mip_level: 0,
                origin: Origin3d::ZERO,
                aspect: TextureAspect::All,
            },
            rgba,
            TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(w * 4),
                rows_per_image: Some(h),
            },
            Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
        );
        Ok(())
    }

    fn restore_label(&self) -> &'static str {
        match self.label_mode {
            LabelMode::D2 => CAPTURE_PASS_D2_RESTORE,
            _ => CAPTURE_PASS_RESTORE,
        }
    }

    fn moving_pass_label(&self) -> &'static str {
        match self.label_mode {
            LabelMode::D2 => CAPTURE_PASS_D2_MOVING,
            _ => CAPTURE_PASS_MOVING,
        }
    }

    fn overlay_pass_label(&self) -> &'static str {
        match self.label_mode {
            LabelMode::D2 => CAPTURE_PASS_D2_OVERLAY,
            _ => CAPTURE_PASS_OVERLAY,
        }
    }

    fn follow_roi_prefix(&self) -> &'static str {
        match self.label_mode {
            LabelMode::D2 => CAPTURE_GROUP_D2_ROI_PREFIX,
            LabelMode::Perf18
            | LabelMode::Perf19
            | LabelMode::Perf20
            | LabelMode::Perf15
            | LabelMode::Perf22
            | LabelMode::Recovery => "perf18-roi-read",
            _ => CAPTURE_GROUP_D1B_ROI_PREFIX,
        }
    }

    fn follow_glass_prefix(&self) -> &'static str {
        match self.label_mode {
            LabelMode::D2 => CAPTURE_GROUP_D2_GLASS_PREFIX,
            LabelMode::Perf18
            | LabelMode::Perf19
            | LabelMode::Perf20
            | LabelMode::Perf15
            | LabelMode::Perf22
            | LabelMode::Recovery => "perf18-glass",
            _ => CAPTURE_GROUP_D1B_GLASS_PREFIX,
        }
    }

    fn is_perf(&self) -> bool {
        matches!(
            self.label_mode,
            LabelMode::Perf18
                | LabelMode::Perf19
                | LabelMode::Perf20
                | LabelMode::Perf15
                | LabelMode::Perf22
                | LabelMode::Recovery
        )
    }

    fn push_perf18_effect_labels(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        open_scopes: &[EffectScopeId],
    ) -> bool {
        if (self.label_mode != LabelMode::Perf18
            && self.label_mode != LabelMode::Perf15
            && self.label_mode != LabelMode::Perf22)
            || open_scopes.is_empty()
        {
            return false;
        }
        encoder.push_debug_group("perf18-effect-opacity");
        encoder.push_debug_group("perf18-transform");
        encoder.push_debug_group("perf18-rounded-clip");
        encoder.push_debug_group("perf18-group-target");
        true
    }

    fn pop_perf18_effect_labels(&self, encoder: &mut wgpu::CommandEncoder, nested: bool) {
        if !nested {
            return;
        }
        encoder.pop_debug_group();
        encoder.pop_debug_group();
        encoder.pop_debug_group();
        encoder.pop_debug_group();
    }

    pub fn first_frame_timeline(&self) -> &[TimelineKind] {
        &self.timeline
    }

    pub fn render_list(&mut self, list: &NeoDisplayList, frame: u64) -> Result<(), GpuInitError> {
        let passes =
            compile_passes(list).map_err(|err| GpuInitError::Renderer(format!("{err:?}")))?;
        self.pass_compiles = self.pass_compiles.saturating_add(1);
        self.render_compiled(list, &passes, frame)
    }

    pub fn render_compiled(
        &mut self,
        list: &NeoDisplayList,
        passes: &[CompiledPass],
        frame: u64,
    ) -> Result<(), GpuInitError> {
        self.render_compiled_inner(list, passes, frame, None)
    }

    pub fn render_compiled_losing_after_raster(
        &mut self,
        list: &NeoDisplayList,
        passes: &[CompiledPass],
        frame: u64,
    ) -> Result<PhysicalWgpuLoss, GpuInitError> {
        let mut report = None;
        self.render_compiled_inner(
            list,
            passes,
            frame,
            Some(&mut |gpu| {
                report = Some(gpu.inject_physical_wgpu_loss()?);
                Ok(())
            }),
        )?;
        report.ok_or_else(|| GpuInitError::Renderer("no raster pass before device loss".into()))
    }

    fn render_compiled_inner(
        &mut self,
        list: &NeoDisplayList,
        passes: &[CompiledPass],
        frame: u64,
        mut after_raster: Option<&mut dyn FnMut(&mut Self) -> Result<(), GpuInitError>>,
    ) -> Result<(), GpuInitError> {
        let d1b = crate::scene_d1b::list_has_moving_sample(list);
        self.recording_frame = frame == 0 && !self.is_perf();
        self.recording_capture = self.capture_at == Some(frame) && (d1b || self.is_perf());
        if self.recording_frame {
            self.timeline.clear();
        }
        if self.recording_capture {
            self.capture_timeline.clear();
        }
        self.tick_shared_interop()?;

        if d1b && frame > 0 {
            self.restore_static_prefix()?;
            self.moving_blit(frame)?;
            if let Some(CompiledPass::Glass {
                barrier,
                open_scopes,
            }) = passes.iter().rev().find(|pass| pass.is_glass())
            {
                let opacity = group_opacity(list, open_scopes);
                let ordinal = crate::scene_d1b::glass_ordinal(list, barrier.id);
                let roi = crate::scene_d1b::glass_b_follow_roi_in(frame, barrier.roi);
                self.glass_pass(
                    list,
                    ordinal,
                    true,
                    roi,
                    barrier.clip_chain,
                    opacity,
                    open_scopes,
                    frame,
                )?;
            }
            self.overlay_blit_from_cache()?;
            if self.recording_capture {
                let expected = expected_motion_frame(list, frame);
                if self.capture_timeline != expected {
                    return Err(GpuInitError::Renderer(format!(
                        "motion timeline diverged: got={} expected={}",
                        encode_timeline(&self.capture_timeline),
                        encode_timeline(&expected)
                    )));
                }
            }
            return Ok(());
        }

        self.clear_accumulator()?;
        for pass in passes {
            match pass {
                CompiledPass::Raster {
                    chunks,
                    open_scopes,
                } => {
                    let chunk_count = u32::try_from(chunks.len()).unwrap_or(u32::MAX);
                    self.raster_pass(list, chunks, open_scopes, chunk_count)?;
                    self.raster_passes += 1;
                    if let Some(hook) = after_raster.take() {
                        hook(self)?;
                    }
                }
                CompiledPass::Glass {
                    barrier,
                    open_scopes,
                } => {
                    let opacity = group_opacity(list, open_scopes);
                    let follow = d1b && crate::scene_d1b::is_last_glass(list, barrier.id);
                    let roi = if follow {
                        crate::scene_d1b::glass_b_follow_roi_in(frame, barrier.roi)
                    } else {
                        barrier.roi
                    };
                    let ordinal = crate::scene_d1b::glass_ordinal(list, barrier.id);
                    self.glass_pass(
                        list,
                        ordinal,
                        follow,
                        roi,
                        barrier.clip_chain,
                        opacity,
                        open_scopes,
                        frame,
                    )?;
                }
                CompiledPass::MovingSample { .. } => {
                    self.snapshot_static_prefix()?;
                    self.moving_blit(frame)?;
                }
                CompiledPass::Interaction { kind, .. } => {
                    if self.label_mode == LabelMode::Perf19
                        && *kind == InteractionPassKind::Selection
                    {
                        self.selection_underlay_pass(list)?;
                    }
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

    fn record(&mut self, event: TimelineKind) {
        if self.recording_frame {
            self.timeline.push(event.clone());
        }
        if self.recording_capture {
            self.capture_timeline.push(event);
        }
    }

    fn clear_accumulator(&mut self) -> Result<(), GpuInitError> {
        let acc_view = self
            .accumulator
            .create_view(&TextureViewDescriptor::default());
        let mut encoder = self
            .device
            .create_command_encoder(&CommandEncoderDescriptor {
                label: Some("m0-d1a-clear"),
            });
        encoder.begin_render_pass(&RenderPassDescriptor {
            label: Some(CAPTURE_PASS_CLEAR),
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
        self.record(TimelineKind::ClearAccumulator);
        Ok(())
    }

    fn snapshot_static_prefix(&mut self) -> Result<(), GpuInitError> {
        let Some(pre_moving) = self.pre_moving.as_ref() else {
            return Ok(());
        };
        let mut encoder = self
            .device
            .create_command_encoder(&CommandEncoderDescriptor {
                label: Some("m0-d1b-snapshot-static"),
            });
        encoder.copy_texture_to_texture(
            TexelCopyTextureInfo {
                texture: &self.accumulator,
                mip_level: 0,
                origin: Origin3d::ZERO,
                aspect: TextureAspect::All,
            },
            TexelCopyTextureInfo {
                texture: pre_moving,
                mip_level: 0,
                origin: Origin3d::ZERO,
                aspect: TextureAspect::All,
            },
            Extent3d {
                width: self.width,
                height: self.height,
                depth_or_array_layers: 1,
            },
        );
        self.queue.submit([encoder.finish()]);
        Ok(())
    }

    fn restore_static_prefix(&mut self) -> Result<(), GpuInitError> {
        let Some(pre_moving) = self.pre_moving.as_ref() else {
            return Err(GpuInitError::Renderer(
                "D1b static prefix was not cached".to_string(),
            ));
        };
        let mut encoder = self
            .device
            .create_command_encoder(&CommandEncoderDescriptor {
                label: Some(self.restore_label()),
            });
        encoder.push_debug_group(self.restore_label());
        encoder.copy_texture_to_texture(
            TexelCopyTextureInfo {
                texture: pre_moving,
                mip_level: 0,
                origin: Origin3d::ZERO,
                aspect: TextureAspect::All,
            },
            TexelCopyTextureInfo {
                texture: &self.accumulator,
                mip_level: 0,
                origin: Origin3d::ZERO,
                aspect: TextureAspect::All,
            },
            Extent3d {
                width: self.width,
                height: self.height,
                depth_or_array_layers: 1,
            },
        );
        encoder.pop_debug_group();
        self.queue.submit([encoder.finish()]);
        self.record(TimelineKind::RestoreStaticPrefix);
        Ok(())
    }

    fn overlay_blit_from_cache(&mut self) -> Result<(), GpuInitError> {
        let src_view = self
            .vello_target
            .create_view(&TextureViewDescriptor::default());
        let acc_view = self
            .accumulator
            .create_view(&TextureViewDescriptor::default());
        let overlay = self.overlay_pass_label();
        let bind = self.device.create_bind_group(&BindGroupDescriptor {
            label: Some(overlay),
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
                label: Some(overlay),
            });
        encoder.push_debug_group(overlay);
        {
            let mut rp = encoder.begin_render_pass(&RenderPassDescriptor {
                label: Some(overlay),
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
        encoder.pop_debug_group();
        self.queue.submit([encoder.finish()]);
        self.record(TimelineKind::OverlayBlitFromCache);
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
        self.vello_rebuilds += 1;
        self.record(TimelineKind::RasterToVello { chunk_count });

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
        let nested_perf18 = self.push_perf18_effect_labels(&mut encoder, open_scopes);
        if self.label_mode == LabelMode::Perf19 {
            let glyph = chunks.iter().any(|chunk| {
                matches!(
                    chunk.payload,
                    StubPayload::TransparentGlyphs
                        | StubPayload::ColorEmoji
                        | StubPayload::SyntaxGlyphs
                )
            });
            encoder.push_debug_group(if glyph {
                "perf19-glyphs"
            } else {
                "perf19-background"
            });
        }
        encoder.push_debug_group(CAPTURE_PASS_BLIT);
        {
            let mut rp = encoder.begin_render_pass(&RenderPassDescriptor {
                label: Some(CAPTURE_PASS_BLIT),
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
        encoder.pop_debug_group();
        self.pop_perf18_effect_labels(&mut encoder, nested_perf18);
        if self.label_mode == LabelMode::Perf19 {
            encoder.pop_debug_group();
        }
        self.queue.submit([encoder.finish()]);
        self.record(TimelineKind::BlitVelloToAccumulator);
        Ok(())
    }

    fn moving_blit(&mut self, frame: u64) -> Result<(), GpuInitError> {
        let Some(moving) = self.moving.as_ref() else {
            return Err(GpuInitError::Renderer(
                "D1b moving sample texture was not allocated".to_string(),
            ));
        };
        let bounds = crate::scene_d1b::moving_bounds(frame);
        let x = bounds.x.max(0.0).floor() as u32;
        let y = bounds.y.max(0.0).floor() as u32;
        let w = crate::scene_d1b::MOVING_SIZE;
        let h = crate::scene_d1b::MOVING_SIZE;
        if x + w > self.width || y + h > self.height {
            return Err(GpuInitError::Renderer(format!(
                "moving sample dest out of bounds x={x} y={y} {w}x{h} target={}x{}",
                self.width, self.height
            )));
        }
        let generation = frame;
        let moving_label = self.moving_pass_label();
        let group = format!("{moving_label}:g{generation}");
        let mut encoder = self
            .device
            .create_command_encoder(&CommandEncoderDescriptor {
                label: Some(moving_label),
            });
        encoder.push_debug_group(&group);
        encoder.copy_texture_to_texture(
            TexelCopyTextureInfo {
                texture: moving,
                mip_level: 0,
                origin: Origin3d::ZERO,
                aspect: TextureAspect::All,
            },
            TexelCopyTextureInfo {
                texture: &self.accumulator,
                mip_level: 0,
                origin: Origin3d { x, y, z: 0 },
                aspect: TextureAspect::All,
            },
            Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
        );
        encoder.pop_debug_group();
        self.queue.submit([encoder.finish()]);
        self.moving_sample_blits += 1;
        self.record(TimelineKind::MovingSampleBlit {
            x,
            y,
            w,
            h,
            generation,
        });
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn glass_pass(
        &mut self,
        list: &NeoDisplayList,
        barrier: u32,
        follow: bool,
        roi: crate::display_list::Rect,
        clip: ClipChainId,
        opacity: f32,
        open_scopes: &[EffectScopeId],
        frame: u64,
    ) -> Result<(), GpuInitError> {
        let Some(px) = resolved_glass_roi(list, roi, clip, self.width, self.height) else {
            if self.label_mode == LabelMode::Perf18 {
                return Err(GpuInitError::Renderer(
                    "perf18 glass ROI resolved empty after world clip".into(),
                ));
            }
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
        let nested_perf18 = self.push_perf18_effect_labels(&mut encoder, open_scopes);
        let roi_group = if self.is_perf() {
            format!("perf18-backdrop-barrier:{barrier}")
        } else if follow {
            format!("{}:{barrier}", self.follow_roi_prefix())
        } else {
            format!("{CAPTURE_GROUP_ROI_PREFIX}:{barrier}")
        };
        encoder.push_debug_group(&roi_group);
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
        encoder.pop_debug_group();
        self.same_device_roi_copies += 1;
        self.last_damage = Some(px);
        if follow {
            self.sampled_generation = frame;
        }
        self.record(TimelineKind::RoiCopyAccumulatorToSnapshot {
            barrier,
            x,
            y,
            w,
            h,
        });

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
        let glass_group = if self.is_perf() {
            format!("perf18-glass:{barrier}:g{frame}")
        } else if follow {
            format!("{}:{barrier}:g{frame}", self.follow_glass_prefix())
        } else {
            format!("{CAPTURE_GROUP_GLASS_PREFIX}:{barrier}")
        };
        encoder.push_debug_group(&glass_group);
        {
            let mut rp = encoder.begin_render_pass(&RenderPassDescriptor {
                label: Some(CAPTURE_PASS_GLASS),
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
        encoder.pop_debug_group();
        self.pop_perf18_effect_labels(&mut encoder, nested_perf18);
        self.queue.submit([encoder.finish()]);
        self.glass_passes += 1;
        self.record(TimelineKind::GlassSampleSnapshotWriteAccumulator {
            barrier,
            x,
            y,
            w,
            h,
            generation: if follow { Some(frame) } else { None },
        });
        Ok(())
    }

    fn selection_underlay_pass(&mut self, list: &NeoDisplayList) -> Result<(), GpuInitError> {
        let mut scene = Scene::new();
        for op in list.ops.iter() {
            let NeoPaintOp::Selection(selection) = op else {
                continue;
            };
            for rect in selection.rects.iter() {
                scene.fill(
                    Fill::NonZero,
                    Affine::IDENTITY,
                    Color::from_rgb8(80, 160, 255),
                    None,
                    &KurboRect::new(
                        f64::from(rect.x),
                        f64::from(rect.y),
                        f64::from(rect.x1()),
                        f64::from(rect.y1()),
                    ),
                );
            }
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
        let src_view = self
            .vello_target
            .create_view(&TextureViewDescriptor::default());
        let acc_view = self
            .accumulator
            .create_view(&TextureViewDescriptor::default());
        let bind = self.device.create_bind_group(&BindGroupDescriptor {
            label: Some("perf19-selection-underlay"),
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
                label: Some("perf19-selection-underlay"),
            });
        encoder.push_debug_group("perf19-selection-underlay");
        {
            let mut rp = encoder.begin_render_pass(&RenderPassDescriptor {
                label: Some("perf19-selection-underlay"),
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
        encoder.pop_debug_group();
        self.queue.submit([encoder.finish()]);
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
            moving_sample_blits: self.moving_sample_blits,
            pass_compiles: self.pass_compiles,
            sampled_generation: self.sampled_generation,
            vello_rebuilds: self.vello_rebuilds,
            layout_rebuilds: self.layout_rebuilds,
            ui_rebuilds: self.ui_rebuilds,
            paint_scene_rebuilds: self.paint_scene_rebuilds,
            render_thread_polls: self.render_thread_polls,
            capture_only_polls: self.capture_only_polls,
            damage_x: self.last_damage.map(|roi| roi.x).unwrap_or(0),
            damage_y: self.last_damage.map(|roi| roi.y).unwrap_or(0),
            damage_w: self.last_damage.map(|roi| roi.w).unwrap_or(0),
            damage_h: self.last_damage.map(|roi| roi.h).unwrap_or(0),
            capture_timeline: encode_timeline(&self.capture_timeline),
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

    fn tick_shared_interop(&mut self) -> Result<(), GpuInitError> {
        let tile = self
            .shared
            .raster_tile()
            .map_err(|err| GpuInitError::Renderer(format!("shared raster tile: {err}")))?;
        self.shared
            .sample_tile(tile)
            .map_err(|err| GpuInitError::Renderer(format!("shared sample tile: {err}")))?;
        match self.shared.present() {
            Ok(InteropPresentOutcome::Presented { .. }) => {}
            Ok(outcome) => {
                return Err(GpuInitError::Renderer(format!(
                    "shared present not ready: {outcome:?}"
                )));
            }
            Err(err) => {
                return Err(GpuInitError::Renderer(format!("shared present: {err}")));
            }
        }
        self.shared.complete_oldest();
        let tel = self.shared.telemetry();
        self.cpu_readbacks = tel.image_readbacks;
        self.cross_device_copies = tel.cross_device_copies;
        Ok(())
    }

    pub fn shared_backends_match(&self) -> bool {
        self.raster_backend.identity == self.compositor_backend.identity
            && self.raster_backend.epoch == self.compositor_backend.epoch
    }

    pub fn shared_telemetry(&self) -> neotavern_neocompositor::InteropTelemetry {
        self.shared.telemetry()
    }

    pub fn shared_gpu(&self) -> &SharedGpuContext {
        &self.shared
    }
}

fn probe_instance() -> wgpu::Instance {
    let backends = wgpu::Backends::from_env().unwrap_or_default();
    // Release NDK builds have `debug_assertions=false`, so `from_build_config()`
    // omits DEBUG. Without it wgpu does not enable VK_EXT_debug_utils and
    // AGI/RenderDoc never see `m0-d1a-*` pass/resource labels. Do not OR
    // VALIDATION here: Khronos VVL stacked on a capture layer is a known
    // crash source.
    let flags = wgpu::InstanceFlags::from_build_config().with_env()
        | wgpu::InstanceFlags::ALLOW_UNDERLYING_NONCOMPLIANT_ADAPTER
        | wgpu::InstanceFlags::DEBUG;
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
    let rect = crate::timeline::world_clip_rect(list, id);
    KurboRect::new(
        f64::from(rect.x),
        f64::from(rect.y),
        f64::from(rect.x1()),
        f64::from(rect.y1()),
    )
}

fn encode_chunk(scene: &mut Scene, list: &NeoDisplayList, chunk: &PaintChunk) {
    if chunk.payload == StubPayload::MovingSample {
        return;
    }
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
        StubPayload::VectorUi
        | StubPayload::TransparentGlyphs
        | StubPayload::SyntaxGlyphs
        | StubPayload::Decoration => Color::from_rgb8(240, 220, 180),
        StubPayload::ColorEmoji => Color::from_rgb8(255, 180, 40),
        StubPayload::Overlay => Color::from_rgb8(220, 72, 72),
        StubPayload::MovingSample => unreachable!("filtered before encode_chunk raster"),
    };
    let shape = match chunk.payload {
        StubPayload::Wallpaper => KurboRect::new(
            f64::from(chunk.bounds.x),
            f64::from(chunk.bounds.y),
            f64::from(chunk.bounds.x1()),
            f64::from(chunk.bounds.y1()),
        ),
        StubPayload::MovingSample => unreachable!("filtered before encode_chunk raster"),
        StubPayload::VectorUi
        | StubPayload::Overlay
        | StubPayload::TransparentGlyphs
        | StubPayload::ColorEmoji
        | StubPayload::SyntaxGlyphs
        | StubPayload::Decoration => {
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
        // Offscreen probe has no swapchain present. A NULL/wildcard
        // StartFrameCapture matches HWUI GLES. Feature `renderdoc-capture`
        // binds the first measured frame to wgpu-hal's Vulkan VkDevice
        // (RenderDoc key = instance dispatch table of that device).
        #[cfg(all(feature = "renderdoc-capture", target_os = "android"))]
        if frame == 0 {
            let _rdoc = crate::renderdoc_capture::FrameGuard::begin_for_device(&gpu.device);
            gpu.render_list(&list, frame)?;
            let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
            if let Some(started) = started {
                gpu.first_frame_cpu_us =
                    u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX);
                probe_trace("first_frame_done");
            }
            continue;
        }
        gpu.render_list(&list, frame)?;
        if let Some(started) = started {
            gpu.first_frame_cpu_us =
                u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX);
            probe_trace("first_frame_done");
        }
    }
    Ok(gpu.report(frames))
}

pub fn run_dynamic_d1b(frames: u64) -> Result<ProbeReport, GpuInitError> {
    run_dynamic_d1b_with_capture(frames, false)
}

pub fn run_dynamic_d1b_with_capture(
    frames: u64,
    capture: bool,
) -> Result<ProbeReport, GpuInitError> {
    run_dynamic_list(
        &crate::scene_d1b::static_d1b_scene(),
        frames,
        capture,
        "/data/data/com.neotavern.mobile/files/m0-d1b",
        LabelMode::D1b,
    )
}

/// Compile-once compositor motion over an already-produced display list.
/// Callers must not rebuild layout or `paint_scene` inside this loop.
pub fn run_dynamic_list(
    list: &NeoDisplayList,
    frames: u64,
    capture: bool,
    capture_dir: &str,
    labels: LabelMode,
) -> Result<ProbeReport, GpuInitError> {
    run_dynamic_list_at(
        list,
        frames,
        capture,
        capture_dir,
        labels,
        crate::scene_d1b::D1B_CAPTURE_FRAME,
    )
}

/// Same as [`run_dynamic_list`] with an explicit RenderDoc capture frame.
pub fn run_dynamic_list_at(
    list: &NeoDisplayList,
    frames: u64,
    capture: bool,
    capture_dir: &str,
    labels: LabelMode,
    capture_frame: u64,
) -> Result<ProbeReport, GpuInitError> {
    probe_trace(&format!(
        "run_dynamic_list frames={frames} capture={capture} capture_frame={capture_frame} labels={labels:?}"
    ));
    let passes = compile_passes(list).map_err(|err| GpuInitError::Renderer(format!("{err:?}")))?;
    let mut gpu = match labels {
        LabelMode::D2 => ProbeGpu::try_new_d2(list.width, list.height)?,
        LabelMode::D1b => ProbeGpu::try_new_d1b(list.width, list.height)?,
        LabelMode::D1a
        | LabelMode::Perf18
        | LabelMode::Perf19
        | LabelMode::Perf20
        | LabelMode::Perf15
        | LabelMode::Perf22
        | LabelMode::Recovery => ProbeGpu::try_new_inner(list.width, list.height, false, labels)?,
    };
    gpu.pass_compiles = 1;
    gpu.paint_scene_rebuilds = 0;
    gpu.layout_rebuilds = 0;
    if capture {
        gpu.capture_at = Some(capture_frame);
    }
    probe_trace(&format!(
        "gpu_ready adapter={} backend={} software={}",
        gpu.adapter_name.replace(' ', "_"),
        gpu.adapter_backend,
        gpu.software_adapter
    ));
    let bytes_at_init = gpu.compositor_texture_bytes;
    for frame in 0..frames {
        if frame == 0 {
            probe_trace("first_frame_begin");
        }
        let started = if frame == 0 {
            Some(std::time::Instant::now())
        } else {
            None
        };
        let capturing = capture && frame == capture_frame;
        #[cfg(all(feature = "renderdoc-capture", target_os = "android"))]
        if capturing {
            let _rdoc = crate::renderdoc_capture::FrameGuard::begin_for_device_path(
                &gpu.device,
                capture_dir,
            );
            gpu.render_compiled(list, &passes, frame)?;
            gpu.capture_only_polls = gpu.capture_only_polls.saturating_add(1);
            let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
            probe_trace("capture_only_poll=true render_thread_poll=false");
            if let Some(started) = started {
                gpu.first_frame_cpu_us =
                    u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX);
            }
            continue;
        }
        let _ = capturing;
        let _ = capture_dir;
        gpu.render_compiled(list, &passes, frame)?;
        if let Some(started) = started {
            gpu.first_frame_cpu_us =
                u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX);
            probe_trace("first_frame_done");
        }
    }
    if gpu.compositor_texture_bytes != bytes_at_init {
        return Err(GpuInitError::Renderer(
            "compositor texture high-water grew during the run".to_string(),
        ));
    }
    if !gpu.shared_backends_match() {
        return Err(GpuInitError::Renderer(
            "vello and compositor device identities differ".into(),
        ));
    }
    Ok(gpu.report(frames))
}

fn upload_moving_checker(queue: &wgpu::Queue, texture: &wgpu::Texture, size: u32) {
    let row_bytes = size * 4;
    let mut pixels = vec![0u8; (size * size * 4) as usize];
    for y in 0..size {
        for x in 0..size {
            let cell = ((x / 8) + (y / 8)) % 2 == 0;
            let i = ((y * size + x) * 4) as usize;
            let gx = (x * 255 / size.max(1)) as u8;
            let gy = (y * 255 / size.max(1)) as u8;
            if cell {
                pixels[i] = gx;
                pixels[i + 1] = 48;
                pixels[i + 2] = gy;
            } else {
                pixels[i] = 32;
                pixels[i + 1] = gx;
                pixels[i + 2] = 200;
            }
            pixels[i + 3] = 255;
        }
    }
    queue.write_texture(
        TexelCopyTextureInfo {
            texture,
            mip_level: 0,
            origin: Origin3d::ZERO,
            aspect: TextureAspect::All,
        },
        &pixels,
        TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(row_bytes),
            rows_per_image: Some(size),
        },
        Extent3d {
            width: size,
            height: size,
            depth_or_array_layers: 1,
        },
    );
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
