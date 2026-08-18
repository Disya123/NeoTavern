//! Debug input-to-present session. Not production JNI, not MainActivity.
//!
//! UI thread only `try_push`es. A compositor thread drains, samples, and
//! presents a retained texture to the window swapchain (no producer/layout/
//! shaping/raster after warm-up).

use std::sync::Arc;

use neotavern_neocompositor::{
    AffineCoeffs, ClipId, CompositorFastPath, EpochClock, HitTestId, HitTestItem, HitTestSnapshot,
    Insets, LogicalRect, PlatformInputAdapter, PlatformPointerKind, PlatformPointerSample, Point,
    PointerFlags, PointerId, PresentationTime, PropertyTreeBuilder, RasterDecision, SceneEpoch,
    ScrollId, ScrollRange, Size, SpatialId, SpatialKind, StableSemanticId, Vec2,
};

pub struct I2pScene {
    pub path: CompositorFastPath,
    pub root_scroll: ScrollId,
}

pub fn bind_scroll_scene() -> I2pScene {
    let mut builder = PropertyTreeBuilder::new();
    let root_scroll = builder.alloc_scroll();
    let viewport = LogicalRect::new(0.0, 0.0, 1080.0, 2400.0);
    let root = builder.alloc_spatial(None, AffineCoeffs::IDENTITY, SpatialKind::ReferenceFrame);
    let scroll_kind = SpatialKind::Scroll {
        scroll_id: root_scroll,
        scrollport: viewport,
        content_extent: LogicalRect::new(0.0, 0.0, 1080.0, 20_000.0),
    };
    let scroll_node = builder.alloc_spatial(Some(root), AffineCoeffs::IDENTITY, scroll_kind);
    let message = builder.alloc_spatial(
        Some(scroll_node),
        AffineCoeffs::translate(0.0, 800.0),
        SpatialKind::ReferenceFrame,
    );
    let sticky = builder.alloc_spatial(
        Some(scroll_node),
        AffineCoeffs::IDENTITY,
        SpatialKind::Sticky {
            scroll_id: root_scroll,
            normal_origin: Point::new(0.0, 0.0),
            constraint_rect: viewport,
            insets: Insets::default(),
            valid_scroll_range: ScrollRange {
                min: Vec2::new(0.0, 0.0),
                max: Vec2::new(0.0, 16_000.0),
            },
            size: Size::new(1080.0, 80.0),
        },
    );
    let fixed = builder.alloc_spatial(
        Some(root),
        AffineCoeffs::translate(24.0, 24.0),
        SpatialKind::Fixed {
            containing_block: root,
        },
    );
    let clip = builder.alloc_clip(None, root, LogicalRect::new(0.0, 0.0, 1080.0, 20_000.0));
    let snapshot = Arc::new(builder.commit(SceneEpoch(1)).expect("i2p scene"));
    let items = vec![
        hit(
            1,
            10,
            message,
            clip,
            LogicalRect::new(0.0, 0.0, 1080.0, 400.0),
            Some(root_scroll),
        ),
        hit(
            2,
            11,
            sticky,
            clip,
            LogicalRect::new(0.0, 0.0, 1080.0, 80.0),
            Some(root_scroll),
        ),
        hit(
            3,
            12,
            fixed,
            clip,
            LogicalRect::new(0.0, 0.0, 120.0, 120.0),
            None,
        ),
    ];
    let mut path = CompositorFastPath::new();
    path.bind_snapshot(snapshot);
    path.bind_hit_test(Arc::new(HitTestSnapshot::commit(SceneEpoch(1), items)))
        .expect("i2p hit-test");
    path.present(PresentationTime::from_nanos(0));
    I2pScene { path, root_scroll }
}

fn hit(
    id: u32,
    target: u64,
    spatial: SpatialId,
    clip: ClipId,
    bounds: LogicalRect,
    scroll: Option<ScrollId>,
) -> HitTestItem {
    HitTestItem {
        id: HitTestId(id),
        target: StableSemanticId(target),
        generation: 1,
        local_bounds: bounds,
        spatial,
        clip,
        paint_order: id,
        scroll_target: scroll,
        pointer_flags: PointerFlags::PARTICIPATES,
    }
}

pub fn kind_from_i32(kind: i32) -> PlatformPointerKind {
    match kind {
        0 => PlatformPointerKind::Down,
        1 => PlatformPointerKind::Up,
        3 => PlatformPointerKind::Cancel,
        _ => PlatformPointerKind::Move,
    }
}

pub fn push_sample(
    adapter: &PlatformInputAdapter,
    pointer: i32,
    kind: i32,
    x: f32,
    y: f32,
    time_nanos: i64,
) {
    let _ = adapter.try_push(PlatformPointerSample {
        pointer: PointerId(u64::try_from(pointer.max(0)).unwrap_or(0)),
        kind: kind_from_i32(kind),
        x,
        y,
        time_nanos: u64::try_from(time_nanos.max(0)).unwrap_or(0),
    });
}

pub struct I2pCpu {
    pub input: PlatformInputAdapter,
    pub scene: I2pScene,
    pub clock: EpochClock,
    pub warmup_frames: u64,
}

impl I2pCpu {
    pub fn new() -> Self {
        Self {
            input: PlatformInputAdapter::new(),
            scene: bind_scroll_scene(),
            clock: EpochClock::new(),
            warmup_frames: 0,
        }
    }

    pub fn drain_present_with(
        &mut self,
        adapter: &PlatformInputAdapter,
        frame_time_nanos: u64,
    ) -> I2pFrame {
        drain_adapter(
            adapter,
            &mut self.scene,
            &mut self.clock,
            &mut self.warmup_frames,
            frame_time_nanos,
        )
    }

    pub fn drain_present(&mut self, frame_time_nanos: u64) -> I2pFrame {
        let I2pCpu {
            input,
            scene,
            clock,
            warmup_frames,
        } = self;
        drain_adapter(input, scene, clock, warmup_frames, frame_time_nanos)
    }
}

fn drain_adapter(
    adapter: &PlatformInputAdapter,
    scene: &mut I2pScene,
    clock: &mut EpochClock,
    warmup_frames: &mut u64,
    frame_time_nanos: u64,
) -> I2pFrame {
    adapter.on_vsync(frame_time_nanos);
    let (_n, outcome) = adapter
        .drain(&mut scene.path)
        .unwrap_or_else(|_| (0, scene.path.present(adapter.presentation_time())));
    if *warmup_frames < 8 {
        *warmup_frames = warmup_frames.saturating_add(1);
    }
    let compositor_only = *warmup_frames >= 8 && outcome.raster == RasterDecision::CompositeOnly;
    let scroll = scene
        .path
        .visual_offset(scene.root_scroll)
        .unwrap_or_default();
    let stats = adapter.stats();
    I2pFrame {
        frame_id: clock.next_frame().0,
        scroll_y: scroll.y as f32,
        producer: if compositor_only {
            0
        } else {
            scene.path.producer_requests()
        },
        layout: 0,
        shaping: 0,
        raster: if compositor_only {
            0
        } else {
            scene.path.raster_invalidations()
        },
        high_water: stats.high_water,
        dropped_edges: stats.dropped_edges,
    }
}

#[derive(Clone, Debug)]
pub struct I2pFrame {
    pub frame_id: u64,
    pub scroll_y: f32,
    pub producer: u64,
    pub layout: u64,
    pub shaping: u64,
    pub raster: u64,
    pub high_water: usize,
    pub dropped_edges: u64,
}

#[cfg(all(feature = "gpu", target_os = "android"))]
mod gpu {
    use super::{push_sample, I2pCpu, I2pFrame, PlatformInputAdapter};
    use std::num::NonZeroU64;
    use std::ptr::NonNull;
    use std::sync::Mutex;

    use raw_window_handle::{
        AndroidDisplayHandle, AndroidNdkWindowHandle, RawDisplayHandle, RawWindowHandle,
    };
    use wgpu::util::DeviceExt;

    #[link(name = "android")]
    extern "C" {
        fn ANativeWindow_fromSurface(
            env: *mut jni::sys::JNIEnv,
            surface: jni::sys::jobject,
        ) -> *mut std::ffi::c_void;
        fn ANativeWindow_release(window: *mut std::ffi::c_void);
        fn ANativeWindow_getWidth(window: *mut std::ffi::c_void) -> i32;
        fn ANativeWindow_getHeight(window: *mut std::ffi::c_void) -> i32;
    }

    const BLIT_WGSL: &str = r#"
struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> }
@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> scroll: vec4<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> VsOut {
    var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
    let pos = p[i];
    var out: VsOut;
    out.pos = vec4<f32>(pos, 0.0, 1.0);
    out.uv = vec2<f32>(pos.x * 0.5 + 0.5, 1.0 - (pos.y * 0.5 + 0.5));
    return out;
}
@fragment fn fs(in: VsOut) -> @location(0) vec4<f32> {
    let uv = vec2<f32>(in.uv.x, fract(in.uv.y + scroll.x));
    return textureSample(tex, samp, uv);
}
"#;

    #[allow(dead_code)]
    struct I2pGpu {
        device: wgpu::Device,
        queue: wgpu::Queue,
        surface: wgpu::Surface<'static>,
        config: wgpu::SurfaceConfiguration,
        pipeline: wgpu::RenderPipeline,
        sampler: wgpu::Sampler,
        content: wgpu::TextureView,
        uniform: wgpu::Buffer,
        bind: wgpu::BindGroup,
        window: *mut std::ffi::c_void,
        backend: String,
    }

    struct I2pSession {
        cpu: I2pCpu,
        gpu: I2pGpu,
    }

    unsafe impl Send for I2pSession {}

    static INPUT: std::sync::OnceLock<PlatformInputAdapter> = std::sync::OnceLock::new();
    static SESSION: Mutex<Option<I2pSession>> = Mutex::new(None);

    fn input_adapter() -> &'static PlatformInputAdapter {
        INPUT.get_or_init(PlatformInputAdapter::new)
    }

    fn native_window(env: &jni::JNIEnv, surface: &jni::objects::JObject) -> *mut std::ffi::c_void {
        unsafe { ANativeWindow_fromSurface(env.get_raw(), surface.as_raw()) }
    }

    fn make_stripes(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = vec![0u8; (width * height * 4) as usize];
        for y in 0..height {
            let stripe = ((y / 32) % 2) == 0;
            for x in 0..width {
                let i = ((y * width + x) * 4) as usize;
                if stripe {
                    bytes[i] = 40;
                    bytes[i + 1] = 90;
                    bytes[i + 2] = 180;
                    bytes[i + 3] = 255;
                } else {
                    bytes[i] = 20;
                    bytes[i + 1] = 20;
                    bytes[i + 2] = 28;
                    bytes[i + 3] = 255;
                }
            }
        }
        bytes
    }

    fn open_gpu(
        env: &jni::JNIEnv,
        surface: &jni::objects::JObject,
        width: u32,
        height: u32,
    ) -> Result<I2pGpu, String> {
        let window = native_window(env, surface);
        if window.is_null() {
            return Err("ANativeWindow_fromSurface returned null".into());
        }
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::VULKAN | wgpu::Backends::GL,
            flags: wgpu::InstanceFlags::from_build_config()
                | wgpu::InstanceFlags::ALLOW_UNDERLYING_NONCOMPLIANT_ADAPTER
                | wgpu::InstanceFlags::DEBUG,
            memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
            backend_options: wgpu::BackendOptions::from_env_or_default(),
            display: None,
        });
        let raw_window = NonNull::new(window).ok_or("null window")?;
        let target = wgpu::SurfaceTargetUnsafe::RawHandle {
            raw_display_handle: Some(RawDisplayHandle::Android(AndroidDisplayHandle::new())),
            raw_window_handle: RawWindowHandle::AndroidNdk(AndroidNdkWindowHandle::new(raw_window)),
        };
        let surface = unsafe { instance.create_surface_unsafe(target) }
            .map_err(|err| format!("surface: {err}"))?;
        let mut adapters = pollster::block_on(instance.enumerate_adapters(wgpu::Backends::all()));
        adapters.sort_by_key(|adapter| {
            let info = adapter.get_info();
            (
                u8::from(info.backend != wgpu::Backend::Vulkan),
                u8::from(matches!(info.device_type, wgpu::DeviceType::Cpu)),
            )
        });
        let adapter = adapters
            .into_iter()
            .find(|adapter| {
                let name = adapter.get_info().name.to_ascii_lowercase();
                if name.contains("goldfish")
                    || name.contains("gfxstream")
                    || name.contains("swiftshader")
                {
                    return false;
                }
                adapter.is_surface_supported(&surface)
            })
            .ok_or_else(|| "no surface-capable Vulkan/GLES adapter".to_string())?;
        let info = adapter.get_info();
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("i2p"),
            required_limits: adapter.limits(),
            ..Default::default()
        }))
        .map_err(|err| format!("device: {err}"))?;
        let cap = surface.get_capabilities(&adapter);
        let format = cap
            .formats
            .iter()
            .copied()
            .find(|format| {
                matches!(
                    format,
                    wgpu::TextureFormat::Bgra8Unorm
                        | wgpu::TextureFormat::Bgra8UnormSrgb
                        | wgpu::TextureFormat::Rgba8Unorm
                        | wgpu::TextureFormat::Rgba8UnormSrgb
                )
            })
            .or_else(|| cap.formats.first().copied())
            .ok_or("no swapchain format")?;
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: width.max(1),
            height: height.max(1),
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode: cap
                .alpha_modes
                .first()
                .copied()
                .unwrap_or(wgpu::CompositeAlphaMode::Opaque),
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &config);
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("i2p-blit"),
            source: wgpu::ShaderSource::Wgsl(BLIT_WGSL.into()),
        });
        let bind_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("i2p-bgl"),
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
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: NonZeroU64::new(16),
                    },
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("i2p-pl"),
            bind_group_layouts: &[Some(&bind_layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("i2p-pipe"),
            layout: Some(&pipeline_layout),
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
                    format,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });
        let content_size = wgpu::Extent3d {
            width: width.max(1),
            height: (height.max(1)).saturating_mul(4),
            depth_or_array_layers: 1,
        };
        let content = device.create_texture_with_data(
            &queue,
            &wgpu::TextureDescriptor {
                label: Some("i2p-content"),
                size: content_size,
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            },
            wgpu::util::TextureDataOrder::LayerMajor,
            &make_stripes(content_size.width, content_size.height),
        );
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            address_mode_u: wgpu::AddressMode::Repeat,
            address_mode_v: wgpu::AddressMode::Repeat,
            ..Default::default()
        });
        let uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("i2p-scroll"),
            size: 16,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let content_view = content.create_view(&wgpu::TextureViewDescriptor::default());
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("i2p-bg"),
            layout: &bind_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&content_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: uniform.as_entire_binding(),
                },
            ],
        });
        Ok(I2pGpu {
            device,
            queue,
            surface,
            config,
            pipeline,
            sampler,
            content: content_view,
            uniform,
            bind,
            window,
            backend: format!("{:?}", info.backend),
        })
    }

    fn monotonic_ns() -> u64 {
        #[repr(C)]
        struct Timespec {
            tv_sec: i64,
            tv_nsec: i64,
        }
        extern "C" {
            fn clock_gettime(clk_id: i32, tp: *mut Timespec) -> i32;
        }
        const CLOCK_MONOTONIC: i32 = 1;
        let mut ts = Timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        unsafe {
            if clock_gettime(CLOCK_MONOTONIC, &mut ts) != 0 {
                return 0;
            }
        }
        (ts.tv_sec as u64)
            .saturating_mul(1_000_000_000)
            .saturating_add(ts.tv_nsec as u64)
    }

    fn gpu_present(gpu: &I2pGpu, scroll_y: f32) -> Result<u64, String> {
        let offset = scroll_y / (gpu.config.height.max(1) as f32 * 4.0);
        let mut uniform = [0u8; 16];
        uniform[..4].copy_from_slice(&offset.to_le_bytes());
        gpu.queue.write_buffer(&gpu.uniform, 0, &uniform);
        let frame = match gpu.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(frame)
            | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
            wgpu::CurrentSurfaceTexture::Timeout => return Err("acquire_timeout".into()),
            wgpu::CurrentSurfaceTexture::Occluded => return Err("acquire_occluded".into()),
            wgpu::CurrentSurfaceTexture::Outdated => return Err("acquire_outdated".into()),
            wgpu::CurrentSurfaceTexture::Lost => return Err("acquire_lost".into()),
            wgpu::CurrentSurfaceTexture::Validation => return Err("acquire_validation".into()),
        };
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("i2p-enc"),
            });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("i2p-blit"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&gpu.pipeline);
            pass.set_bind_group(0, &gpu.bind, &[]);
            pass.draw(0..3, 0..1);
        }
        let submit_ns = monotonic_ns();
        gpu.queue.submit(Some(encoder.finish()));
        frame.present();
        Ok(submit_ns)
    }

    pub fn attach(
        env: &jni::JNIEnv,
        surface: &jni::objects::JObject,
        width: i32,
        height: i32,
    ) -> String {
        let width = if width > 0 { width as u32 } else { 1 };
        let height = if height > 0 { height as u32 } else { 1 };
        match open_gpu(env, surface, width, height) {
            Ok(gpu) => {
                let backend = gpu.backend.clone();
                *SESSION.lock().unwrap_or_else(|p| p.into_inner()) = Some(I2pSession {
                    cpu: I2pCpu::new(),
                    gpu,
                });
                format!("i2p attach ok driver={backend} clock=monotonic")
            }
            Err(err) => format!("i2p attach failed reason={}", err.replace(' ', "_")),
        }
    }

    pub fn detach() -> String {
        let mut slot = SESSION.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(session) = slot.take() {
            unsafe {
                if !session.gpu.window.is_null() {
                    ANativeWindow_release(session.gpu.window);
                }
            }
        }
        "i2p detach ok".into()
    }

    pub fn try_push(pointer: i32, kind: i32, x: f32, y: f32, time_nanos: i64) {
        push_sample(input_adapter(), pointer, kind, x, y, time_nanos);
    }

    pub fn lose_focus(time_nanos: i64) {
        input_adapter().lose_focus(u64::try_from(time_nanos.max(0)).unwrap_or(0));
    }

    pub fn present_frame(
        vsync_id: i64,
        callback_time: i64,
        deadline: i64,
        expected_present: i64,
    ) -> String {
        let mut slot = SESSION.lock().unwrap_or_else(|p| p.into_inner());
        let Some(session) = slot.as_mut() else {
            return "i2p present failed reason=no_session".into();
        };
        let consume_ns = monotonic_ns();
        let frame: I2pFrame = session.cpu.drain_present_with(
            input_adapter(),
            u64::try_from(callback_time.max(0)).unwrap_or(0),
        );
        let gpu_submit = match gpu_present(&session.gpu, frame.scroll_y) {
            Ok(ns) => ns,
            Err(err) => return format!("i2p present failed reason={}", err.replace(' ', "_")),
        };
        format!(
            "i2p present frameId={} targetVsyncId={} callbackTime={} inputCutoff={} targetPresentDeadline={} consumeNs={} gpuSubmit={} actualPresentTime=pending driver={} producer={} layout={} shaping={} raster={} highWater={} dropE={} compositorOnly={} clock=monotonic",
            frame.frame_id,
            vsync_id,
            callback_time,
            deadline,
            expected_present,
            consume_ns,
            gpu_submit,
            session.gpu.backend,
            frame.producer,
            frame.layout,
            frame.shaping,
            frame.raster,
            frame.high_water,
            frame.dropped_edges,
            u8::from(frame.raster == 0 && frame.producer == 0),
        )
    }

    #[allow(dead_code)]
    pub fn native_size(env: &jni::JNIEnv, surface: &jni::objects::JObject) -> (i32, i32) {
        let window = native_window(env, surface);
        if window.is_null() {
            return (0, 0);
        }
        let size = unsafe {
            (
                ANativeWindow_getWidth(window),
                ANativeWindow_getHeight(window),
            )
        };
        unsafe { ANativeWindow_release(window) };
        size
    }
}

#[cfg(all(feature = "gpu", target_os = "android"))]
pub use gpu::{attach, detach, lose_focus, present_frame, try_push};
