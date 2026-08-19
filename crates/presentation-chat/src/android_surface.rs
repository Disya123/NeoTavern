//! Live Vulkan SurfaceView host for Product Wire chat.
//!
//! One session: Wire → Dioxus → Blitz → presentation-session → NeoCompositor → wgpu.

use std::num::NonZeroUsize;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::Mutex;

use jni::objects::JObject;
use jni::JNIEnv;
use neotavern_neocompositor::{
    GpuFault, GpuRecovery, PlatformInputAdapter, PlatformPointerKind, PlatformPointerSample,
    PointerId, PresentationTime,
};
use neotavern_presentation_dioxus_shell::{
    chrome_metrics, install_product_shell, product_shell_app, ProductShellView, SafeAreaInsets,
};
use neotavern_presentation_m0_d2::produce_product_gpu_app_scaled;
use raw_window_handle::{
    AndroidDisplayHandle, AndroidNdkWindowHandle, RawDisplayHandle, RawWindowHandle,
};
use vello::{AaConfig, AaSupport, RenderParams, Renderer, RendererOptions};

use crate::compositor::ChatCompositor;
use crate::session::ChatSession;
use crate::shell_hit::{hit_test, ShellAction, ShellHit};
use crate::wire::ProductWire;

#[link(name = "android")]
extern "C" {
    fn ANativeWindow_fromSurface(
        env: *mut jni::sys::JNIEnv,
        surface: jni::sys::jobject,
    ) -> *mut std::ffi::c_void;
    fn ANativeWindow_release(window: *mut std::ffi::c_void);
}

#[link(name = "log")]
extern "C" {
    fn __android_log_write(
        prio: std::os::raw::c_int,
        tag: *const std::os::raw::c_char,
        text: *const std::os::raw::c_char,
    ) -> std::os::raw::c_int;
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
    var uv = in.uv;
    if (uv.y >= scroll.y && uv.y < scroll.z) {
        let src_y = uv.y + scroll.x;
        if (src_y < scroll.y || src_y >= scroll.z) {
            return vec4<f32>(0.082, 0.075, 0.067, 1.0);
        }
        uv.y = src_y;
    }
    let c = textureSample(tex, samp, uv);
    var rgb = c.rgb;
    if (scroll.w > 0.5) {
        let lo = rgb / 12.92;
        let hi = pow((rgb + 0.055) / 1.055, vec3<f32>(2.4));
        rgb = select(hi, lo, rgb <= vec3<f32>(0.04045));
    }
    return vec4<f32>(rgb, 1.0);
}
"#;

fn trace(msg: &str) {
    let Ok(tag) = std::ffi::CString::new("NeoTavern") else {
        return;
    };
    let Ok(text) = std::ffi::CString::new(msg) else {
        return;
    };
    unsafe {
        __android_log_write(4, tag.as_ptr(), text.as_ptr());
    }
}

struct GpuSurface {
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    pipeline: wgpu::RenderPipeline,
    #[allow(dead_code)]
    content: wgpu::Texture,
    content_view: wgpu::TextureView,
    resolve: wgpu::Texture,
    resolve_view: wgpu::TextureView,
    uniform: wgpu::Buffer,
    bind: wgpu::BindGroup,
    renderer: Renderer,
    window: *mut std::ffi::c_void,
    backend: String,
    srgb_target: bool,
}

unsafe impl Send for GpuSurface {}

struct PendingUi {
    pointer: i32,
    x: f32,
    y: f32,
    hit: ShellHit,
}

struct GpuHost {
    gpu: GpuSurface,
    compositor: Option<ChatCompositor>,
    recovery: GpuRecovery,
    input: PlatformInputAdapter,
    velocity: f64,
    last_y: Option<f32>,
    last_t: Option<u64>,
    devices: u32,
    density: f32,
    inset_physical: [f32; 4],
    shell_overlay: bool,
    hit_view: Option<ProductShellView>,
    pending_ui: Option<PendingUi>,
}

unsafe impl Send for GpuHost {}

static HOST: Mutex<Option<GpuHost>> = Mutex::new(None);
static DIRTY: AtomicBool = AtomicBool::new(true);
static COMPOSITE_LOGGED: AtomicU64 = AtomicU64::new(0);
static SHELL_ACTION: Mutex<Option<ShellAction>> = Mutex::new(None);
static PENDING_INSETS: Mutex<Option<[f32; 4]>> = Mutex::new(None);

fn input_kind(kind: i32) -> PlatformPointerKind {
    match kind {
        0 => PlatformPointerKind::Down,
        1 => PlatformPointerKind::Up,
        3 => PlatformPointerKind::Cancel,
        _ => PlatformPointerKind::Move,
    }
}

fn native_window(env: &JNIEnv, surface: &JObject) -> *mut std::ffi::c_void {
    unsafe { ANativeWindow_fromSurface(env.get_raw(), surface.as_raw()) }
}

fn open_gpu(
    env: &JNIEnv,
    surface: &JObject,
    width: u32,
    height: u32,
) -> Result<GpuSurface, String> {
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
        label: Some("neocompositor-chat"),
        required_limits: adapter.limits(),
        ..Default::default()
    }))
    .map_err(|err| format!("device: {err}"))?;
    let cap = surface.get_capabilities(&adapter);
    let format = pick_surface_format(&cap.formats).ok_or("no swapchain format")?;
    let srgb_target = format_is_srgb(format);
    let config = wgpu::SurfaceConfiguration {
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        format,
        width: width.max(1),
        height: height.max(1),
        present_mode: wgpu::PresentMode::Fifo,
        alpha_mode: pick_alpha_mode(&cap.alpha_modes),
        view_formats: vec![],
        desired_maximum_frame_latency: 2,
    };
    surface.configure(&device, &config);
    let renderer = Renderer::new(
        &device,
        RendererOptions {
            use_cpu: true,
            antialiasing_support: AaSupport::area_only(),
            num_init_threads: NonZeroUsize::new(1),
            ..Default::default()
        },
    )
    .map_err(|err| format!("vello: {err}"))?;
    let content = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("neocompositor-content"),
        size: wgpu::Extent3d {
            width: config.width,
            height: config.height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::STORAGE_BINDING
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let content_view = content.create_view(&wgpu::TextureViewDescriptor::default());
    let resolve = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("neocompositor-resolve"),
        size: wgpu::Extent3d {
            width: config.width,
            height: config.height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::COPY_DST
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let resolve_view = resolve.create_view(&wgpu::TextureViewDescriptor::default());
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("neocompositor-blit"),
        source: wgpu::ShaderSource::Wgsl(BLIT_WGSL.into()),
    });
    let bind_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("neocompositor-bgl"),
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
                    min_binding_size: None,
                },
                count: None,
            },
        ],
    });
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("neocompositor-pl"),
        bind_group_layouts: &[Some(&bind_layout)],
        immediate_size: 0,
    });
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("neocompositor-blit-pipe"),
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
                format: config.format,
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
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        address_mode_u: wgpu::AddressMode::ClampToEdge,
        address_mode_v: wgpu::AddressMode::ClampToEdge,
        ..Default::default()
    });
    let uniform = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("neocompositor-scroll"),
        size: 16,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("neocompositor-bg"),
        layout: &bind_layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&resolve_view),
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
    clear_canvas_view(&device, &queue, &resolve_view);
    Ok(GpuSurface {
        device,
        queue,
        surface,
        config,
        pipeline,
        content,
        content_view,
        resolve,
        resolve_view,
        uniform,
        bind,
        renderer,
        window,
        backend: format!("{:?}", info.backend),
        srgb_target,
    })
}

fn format_is_srgb(format: wgpu::TextureFormat) -> bool {
    matches!(
        format,
        wgpu::TextureFormat::Rgba8UnormSrgb | wgpu::TextureFormat::Bgra8UnormSrgb
    )
}

fn pick_surface_format(formats: &[wgpu::TextureFormat]) -> Option<wgpu::TextureFormat> {
    const PREFER: &[wgpu::TextureFormat] = &[
        wgpu::TextureFormat::Rgba8Unorm,
        wgpu::TextureFormat::Bgra8Unorm,
    ];
    for want in PREFER {
        if formats.contains(want) {
            return Some(*want);
        }
    }
    formats
        .iter()
        .copied()
        .find(|format| {
            matches!(
                format,
                wgpu::TextureFormat::Rgba8UnormSrgb | wgpu::TextureFormat::Bgra8UnormSrgb
            )
        })
        .or_else(|| formats.first().copied())
}

fn pick_alpha_mode(modes: &[wgpu::CompositeAlphaMode]) -> wgpu::CompositeAlphaMode {
    if modes.contains(&wgpu::CompositeAlphaMode::Opaque) {
        wgpu::CompositeAlphaMode::Opaque
    } else {
        modes
            .first()
            .copied()
            .unwrap_or(wgpu::CompositeAlphaMode::Opaque)
    }
}

fn host_line(
    backend: &str,
    product_wire: &str,
    devices: u32,
    density: f32,
    swapchain: wgpu::TextureFormat,
) -> String {
    format!(
        "host=neocompositor-surfaceview backend={backend} product_wire={product_wire} producer=dioxus+blitz devices={devices} density={density} swapchain={swapchain:?} srgb={} readbacks=0 xdev=0",
        u8::from(format_is_srgb(swapchain))
    )
}

fn raster_scene(gpu: &mut GpuSurface, scene: &vello::Scene) -> Result<(), String> {
    gpu.renderer
        .render_to_texture(
            &gpu.device,
            &gpu.queue,
            scene,
            &gpu.content_view,
            &RenderParams {
                base_color: vello::peniko::Color::from_rgb8(0x15, 0x13, 0x11),
                width: gpu.config.width,
                height: gpu.config.height,
                antialiasing_method: AaConfig::Area,
            },
        )
        .map_err(|err| format!("vello raster: {err}"))?;
    let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
    static VELLO_WROTE: AtomicU8 = AtomicU8::new(0);
    let wrote = match VELLO_WROTE.load(Ordering::SeqCst) {
        0 => {
            let px = peek_content_once(gpu);
            let wrote = px[3] > 0;
            VELLO_WROTE.store(u8::from(wrote) + 1, Ordering::SeqCst);
            if !wrote {
                trace("vello_wrote_empty keeping_canvas");
            }
            wrote
        }
        2 => true,
        _ => false,
    };
    if wrote {
        resolve_content(gpu);
    } else {
        clear_canvas_view(&gpu.device, &gpu.queue, &gpu.resolve_view);
    }
    Ok(())
}

fn canvas_clear_color() -> wgpu::Color {
    wgpu::Color {
        r: 0x15 as f64 / 255.0,
        g: 0x13 as f64 / 255.0,
        b: 0x11 as f64 / 255.0,
        a: 1.0,
    }
}

fn clear_canvas_view(device: &wgpu::Device, queue: &wgpu::Queue, view: &wgpu::TextureView) {
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("neocompositor-canvas"),
    });
    {
        let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("neocompositor-canvas"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(canvas_clear_color()),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
    }
    queue.submit(Some(encoder.finish()));
}

fn resolve_content(gpu: &GpuSurface) {
    let mut encoder = gpu
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("neocompositor-resolve"),
        });
    encoder.copy_texture_to_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &gpu.content,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyTextureInfo {
            texture: &gpu.resolve,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::Extent3d {
            width: gpu.config.width,
            height: gpu.config.height,
            depth_or_array_layers: 1,
        },
    );
    gpu.queue.submit(Some(encoder.finish()));
    let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
}

fn peek_content_once(gpu: &GpuSurface) -> [u8; 4] {
    static LOGGED: AtomicBool = AtomicBool::new(false);
    let padded = 256u64;
    let buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("neocompositor-peek"),
        size: padded,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut encoder = gpu
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("neocompositor-peek"),
        });
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: &gpu.content,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(256),
                rows_per_image: Some(1),
            },
        },
        wgpu::Extent3d {
            width: 1,
            height: 1,
            depth_or_array_layers: 1,
        },
    );
    gpu.queue.submit(Some(encoder.finish()));
    let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
    let slice = buffer.slice(..4);
    let (sender, receiver) = std::sync::mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |result| {
        let _ = sender.send(result);
    });
    let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
    let px = match receiver.try_recv() {
        Ok(Ok(())) => {
            let data = slice.get_mapped_range();
            [data[0], data[1], data[2], data[3]]
        }
        other => {
            if !LOGGED.swap(true, Ordering::SeqCst) {
                trace(&format!("content_px peek_failed {other:?}"));
            }
            [0, 0, 0, 0]
        }
    };
    if !LOGGED.swap(true, Ordering::SeqCst) {
        trace(&format!(
            "content_px r={} g={} b={} a={}",
            px[0], px[1], px[2], px[3]
        ));
    }
    px
}

fn blit(gpu: &GpuSurface, scroll_y: f32, header: f32, composer_top: f32) -> Result<(), String> {
    let height = gpu.config.height.max(1) as f32;
    let offset = scroll_y / height;
    let header_uv = header / height;
    let composer_uv = composer_top / height;
    let mut uniform = [0u8; 16];
    uniform[0..4].copy_from_slice(&offset.to_le_bytes());
    uniform[4..8].copy_from_slice(&header_uv.to_le_bytes());
    uniform[8..12].copy_from_slice(&composer_uv.to_le_bytes());
    let srgb = if gpu.srgb_target { 1.0f32 } else { 0.0 };
    uniform[12..16].copy_from_slice(&srgb.to_le_bytes());
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
            label: Some("neocompositor-enc"),
        });
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("neocompositor-blit"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(canvas_clear_color()),
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
    gpu.queue.submit(Some(encoder.finish()));
    frame.present();
    Ok(())
}

fn recover_fault(host: &mut GpuHost, err: &str) {
    let fault = if err.contains("lost") {
        GpuFault::SurfaceLost
    } else if err.contains("outdated") {
        GpuFault::SurfaceOutdated
    } else if err.contains("timeout") {
        GpuFault::Timeout
    } else {
        GpuFault::SurfaceOutdated
    };
    let _ = host.recovery.notify_fault(fault);
}

pub fn mark_dirty() {
    DIRTY.store(true, Ordering::SeqCst);
}

pub fn attach(env: &JNIEnv, surface: &JObject, width: i32, height: i32, density: f32) -> String {
    detach();
    let width = if width > 0 { width as u32 } else { 1 };
    let height = if height > 0 { height as u32 } else { 1 };
    let density = if density >= 1.0 { density } else { 1.0 };
    match open_gpu(env, surface, width, height) {
        Ok(gpu) => {
            let backend = gpu.backend.clone();
            let mut recovery = GpuRecovery::new();
            let _ = recovery.initialize();
            let pending = PENDING_INSETS
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .take()
                .unwrap_or([0.0; 4]);
            let host = GpuHost {
                gpu,
                compositor: None,
                recovery,
                input: PlatformInputAdapter::new(),
                velocity: 0.0,
                last_y: None,
                last_t: None,
                devices: 1,
                density,
                inset_physical: pending,
                shell_overlay: true,
                hit_view: None,
                pending_ui: None,
            };
            DIRTY.store(true, Ordering::SeqCst);
            let line = host_line(
                &backend,
                "live",
                host.devices,
                density,
                host.gpu.config.format,
            );
            *HOST.lock().unwrap_or_else(|p| p.into_inner()) = Some(host);
            trace(&line);
            line
        }
        Err(err) => {
            let line = format!(
                "host=neocompositor-surfaceview attach_failed reason={}",
                err.replace(' ', "_")
            );
            trace(&line);
            line
        }
    }
}

pub fn detach() -> String {
    let mut slot = HOST.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(host) = slot.take() {
        unsafe {
            if !host.gpu.window.is_null() {
                ANativeWindow_release(host.gpu.window);
            }
        }
    }
    "host=neocompositor-surfaceview detach=ok".into()
}

pub fn set_safe_area(top: f32, right: f32, bottom: f32, left: f32) {
    let next = [top.max(0.0), right.max(0.0), bottom.max(0.0), left.max(0.0)];
    let mut slot = HOST.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(host) = slot.as_mut() {
        if host.inset_physical != next {
            host.inset_physical = next;
            DIRTY.store(true, Ordering::SeqCst);
        }
        return;
    }
    *PENDING_INSETS.lock().unwrap_or_else(|p| p.into_inner()) = Some(next);
}

pub fn take_shell_action() -> Option<ShellAction> {
    SHELL_ACTION
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take()
}

pub fn try_push(pointer: i32, kind: i32, x: f32, y: f32, time_nanos: i64) {
    let mut slot = HOST.lock().unwrap_or_else(|p| p.into_inner());
    let Some(host) = slot.as_mut() else {
        return;
    };
    let kind = input_kind(kind);
    let time = u64::try_from(time_nanos.max(0)).unwrap_or(0);
    let density = host.density.max(1.0);
    let css_x = x / density;
    let css_y = y / density;
    if kind == PlatformPointerKind::Down {
        if let Some(view) = host.hit_view.as_ref() {
            if let Some(hit) = hit_test(view, css_x, css_y) {
                host.pending_ui = Some(PendingUi {
                    pointer,
                    x: css_x,
                    y: css_y,
                    hit,
                });
                host.velocity = 0.0;
                return;
            }
        }
        host.last_y = Some(y);
        host.last_t = Some(time);
        host.velocity = 0.0;
        if let Some(compositor) = host.compositor.as_mut() {
            compositor.note_scroll(true);
        }
    } else if kind == PlatformPointerKind::Move {
        if let Some(pending) = host.pending_ui.as_ref() {
            if (css_x - pending.x).abs() > 16.0 || (css_y - pending.y).abs() > 16.0 {
                host.pending_ui = None;
            } else {
                return;
            }
        }
        if let (Some(prev_y), Some(prev_t)) = (host.last_y, host.last_t) {
            let dt = time.saturating_sub(prev_t).max(1) as f64 / 1_000_000_000.0;
            host.velocity = f64::from(prev_y - y) / dt;
        }
        host.last_y = Some(y);
        host.last_t = Some(time);
    } else {
        if let Some(pending) = host.pending_ui.take() {
            if pending.pointer == pointer
                && (css_x - pending.x).abs() <= 16.0
                && (css_y - pending.y).abs() <= 16.0
            {
                if let ShellHit::Action(action) = pending.hit {
                    *SHELL_ACTION.lock().unwrap_or_else(|p| p.into_inner()) = Some(action);
                    DIRTY.store(true, Ordering::SeqCst);
                }
            }
            return;
        }
        host.last_y = None;
        host.last_t = None;
        if let Some(compositor) = host.compositor.as_mut() {
            compositor.note_scroll(false);
        }
        mark_dirty();
    }
    let _ = host.input.try_push(PlatformPointerSample {
        pointer: PointerId(u64::try_from(pointer.max(0)).unwrap_or(0)),
        kind,
        x,
        y,
        time_nanos: time,
    });
}

pub fn lose_focus(time_nanos: i64) {
    let mut slot = HOST.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(host) = slot.as_mut() {
        host.input
            .lose_focus(u64::try_from(time_nanos.max(0)).unwrap_or(0));
        host.velocity = 0.0;
        if let Some(compositor) = host.compositor.as_mut() {
            compositor.note_scroll(false);
        }
    }
}

pub fn bind_from_session<W: ProductWire>(session: &mut ChatSession<W>) -> String {
    let mut slot = HOST.lock().unwrap_or_else(|p| p.into_inner());
    let Some(host) = slot.as_mut() else {
        mark_dirty();
        return "host=neocompositor-surfaceview bind_pending reason=no_surface".into();
    };
    match catch_unwind(AssertUnwindSafe(|| bind_host(host, session))) {
        Ok(Ok(line)) => line,
        Ok(Err(err)) => format!(
            "host=neocompositor-surfaceview bind_failed reason={}",
            err.replace(' ', "_")
        ),
        Err(_) => "host=neocompositor-surfaceview bind_failed reason=panic".into(),
    }
}

fn shell_without_avatars(mut shell: ProductShellView) -> ProductShellView {
    for item in &mut shell.characters {
        item.avatar_data_uri = None;
    }
    if let Some(draft) = shell.selected_draft.as_mut() {
        draft.avatar_data_uri = None;
    }
    shell
}

fn produce_product_scene(
    width: u32,
    height: u32,
    density: f32,
    insets: SafeAreaInsets,
) -> Result<(neotavern_presentation_m0_d2::ProducerOutput, vello::Scene), String> {
    catch_unwind(AssertUnwindSafe(|| {
        produce_product_gpu_app_scaled(product_shell_app, width, height, density, insets)
    }))
    .unwrap_or_else(|_| Err("produce_panic".into()))
}

fn produce_and_raster(
    host: &mut GpuHost,
    width: u32,
    height: u32,
    density: f32,
    insets: SafeAreaInsets,
) -> Result<neotavern_presentation_m0_d2::ProducerOutput, String> {
    let (produced, scene) = produce_product_scene(width, height, density, insets)?;
    trace(&format!(
        "vello_scene paths={} empty={}",
        scene.encoding().n_paths,
        scene.encoding().is_empty()
    ));
    raster_scene(&mut host.gpu, &scene)?;
    Ok(produced)
}

fn bind_host<W: ProductWire>(
    host: &mut GpuHost,
    session: &mut ChatSession<W>,
) -> Result<String, String> {
    if let Some(compositor) = host.compositor.as_mut() {
        compositor.note_scroll(false);
    }
    let width = host.gpu.config.width;
    let height = host.gpu.config.height;
    session.set_surface_size(width, height, host.density);
    session.set_safe_area_physical(
        host.inset_physical[0],
        host.inset_physical[1],
        host.inset_physical[2],
        host.inset_physical[3],
    );
    let shell = session.shell_view();
    host.shell_overlay = shell.sidebar_open;
    host.hit_view = Some(shell.clone());
    install_product_shell(shell.clone());
    let produced = match produce_and_raster(host, width, height, host.density, session.insets()) {
        Ok(produced) => produced,
        Err(err) => {
            trace(&format!(
                "product_bind retry_without_avatars reason={}",
                err.replace(' ', "_")
            ));
            let stripped = shell_without_avatars(shell);
            host.hit_view = Some(stripped.clone());
            install_product_shell(stripped);
            produce_and_raster(host, width, height, host.density, session.insets())?
        }
    };
    trace(&format!(
        "product_paint cmds={} rasters={}",
        produced.report.paint_commands, produced.report.raster_images
    ));
    match host.compositor.as_mut() {
        Some(compositor) => {
            compositor.bind_list(produced.list);
        }
        None => {
            host.compositor = Some(ChatCompositor::from_list_scaled(
                session.compositor_height_index(),
                width,
                height,
                produced.list,
                host.density,
            ));
        }
    }
    DIRTY.store(false, Ordering::SeqCst);
    let line = host_line(
        &host.gpu.backend,
        "live",
        host.devices,
        host.density,
        host.gpu.config.format,
    );
    trace(&line);
    Ok(line)
}

pub fn present_frame(
    vsync_id: i64,
    callback_time: i64,
    deadline: i64,
    expected_present: i64,
) -> String {
    let mut slot = HOST.lock().unwrap_or_else(|p| p.into_inner());
    let Some(host) = slot.as_mut() else {
        return "host=neocompositor-surfaceview present_failed reason=no_session".into();
    };
    host.input
        .on_vsync(u64::try_from(callback_time.max(0)).unwrap_or(0));
    if let Some(compositor) = host.compositor.as_mut() {
        let _ = host.input.drain(compositor.session.path_mut());
        let dt_ns = 8_333_333;
        let time = PresentationTime::from_nanos(u64::try_from(callback_time.max(0)).unwrap_or(0));
        let _offset = compositor.compositor_tick(host.velocity, dt_ns, time);
        host.velocity *= 0.94;
        if host.velocity.abs() < 12.0 {
            host.velocity = 0.0;
        }
        let scroll = compositor
            .session
            .scroll_id()
            .and_then(|id| compositor.session.path().visual_offset(id))
            .map(|v| v.y as f32)
            .unwrap_or(0.0);
        let (header, composer_top) = if host.shell_overlay {
            (0.0, 0.0)
        } else {
            chrome_bands(host.gpu.config.width, host.gpu.config.height, host.density)
        };
        match blit(&host.gpu, scroll, header, composer_top) {
            Ok(()) => {
                let n = compositor.composite_only_frames;
                if n > 0 && n.is_multiple_of(30) && COMPOSITE_LOGGED.swap(n, Ordering::Relaxed) != n
                {
                    trace(&compositor.telemetry_line());
                }
                format!(
                    "host=neocompositor-surfaceview present vsync={vsync_id} deadline={deadline} expected={expected_present} {} backend={} devices=1 readbacks=0 xdev=0",
                    compositor.telemetry_line(),
                    host.gpu.backend,
                )
            }
            Err(err) => {
                recover_fault(host, &err);
                format!(
                    "host=neocompositor-surfaceview present_failed reason={}",
                    err.replace(' ', "_")
                )
            }
        }
    } else {
        match blit(&host.gpu, 0.0, 0.0, host.gpu.config.height as f32) {
            Ok(()) => host_line(
                &host.gpu.backend,
                "live",
                host.devices,
                host.density,
                host.gpu.config.format,
            ),
            Err(err) => {
                recover_fault(host, &err);
                format!(
                    "host=neocompositor-surfaceview present_failed reason={}",
                    err.replace(' ', "_")
                )
            }
        }
    }
}

pub fn telemetry() -> String {
    let slot = HOST.lock().unwrap_or_else(|p| p.into_inner());
    match slot.as_ref().and_then(|host| host.compositor.as_ref()) {
        Some(compositor) => compositor.telemetry_line(),
        None => {
            "composite_only_frames=0 layout_rebuilds_on_scroll=0 paint_rebuilds_on_scroll=0".into()
        }
    }
}

fn chrome_bands(width: u32, height: u32, density: f32) -> (f32, f32) {
    let density = density.max(1.0);
    let css_w = ((width as f32) / density).round().max(1.0) as u32;
    let css_h = ((height as f32) / density).round().max(1.0) as u32;
    let (_, header, viewport, _) = chrome_metrics(css_w, css_h);
    (
        header as f32 * density,
        (header.saturating_add(viewport)) as f32 * density,
    )
}

pub fn is_scrolling() -> bool {
    let slot = HOST.lock().unwrap_or_else(|p| p.into_inner());
    slot.as_ref()
        .map(|host| {
            host.velocity.abs() > 12.0
                || host
                    .compositor
                    .as_ref()
                    .map(ChatCompositor::is_scrolling)
                    .unwrap_or(false)
        })
        .unwrap_or(false)
}

pub fn is_dirty() -> bool {
    DIRTY.load(Ordering::SeqCst)
}

/// Native chat composer/Send overlay is only attached on the chat route.
pub fn chat_route_visible() -> bool {
    let slot = HOST.lock().unwrap_or_else(|p| p.into_inner());
    slot.as_ref()
        .map(|host| !host.shell_overlay)
        .unwrap_or(false)
}
