//! Live Vulkan SurfaceView host for Product Wire chat.
//!
//! One session: Wire → Dioxus → Blitz → presentation-session → NeoCompositor → wgpu.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::vello_diag::{
    classify_samples, encoding_line, format_error_scopes, resolution_ladder, scene_with_tile_origin,
    tile_origins, SampleClass, UI_BASE_COLOR, UI_BASE_RGBA,
};
use crate::vello_gpu::{
    adapter_sort_key, coarse_bin_count, create_storage_convert_pipeline, gpu_storage_to_sampled,
    opaque_rect_scene, peek_texture_rgba, plan_vello_target, production_host_line, renderer_name,
    request_vello_device, skip_emulator_vulkan, software_raster_debug_enabled,
    vello_renderer_options, ConvertMode, StorageConvert, VelloTargets,
};
use jni::objects::JObject;
use jni::JNIEnv;
use neotavern_neocompositor::{
    GpuCaps, GpuFault, GpuRecovery, HandleOwner, ImagePaintOp, PlatformInputAdapter,
    PlatformPointerKind, PlatformPointerSample, PointerId, PresentationTime, SharedGpuContext,
    SharedHandleKind,
};
use neotavern_presentation_dioxus_shell::{
    chrome_metrics, install_product_shell, product_shell_app, ProductShellView, SafeAreaInsets,
};
use neotavern_presentation_m0_d2::{
    attach_image_paints, image_paints_from_layout, ProductPaintLayout, ProductVelloSession,
    VelloFilter,
};
use raw_window_handle::{
    AndroidDisplayHandle, AndroidNdkWindowHandle, RawDisplayHandle, RawWindowHandle,
};
use vello::{AaConfig, RenderParams, Renderer};

use crate::avatar_gpu::AvatarGpu;
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
    #[allow(dead_code)]
    content_view: wgpu::TextureView,
    resolve: wgpu::Texture,
    resolve_view: wgpu::TextureView,
    uniform: wgpu::Buffer,
    bind: wgpu::BindGroup,
    renderer: Renderer,
    window: *mut std::ffi::c_void,
    backend: String,
    srgb_target: bool,
    convert: ConvertMode,
    convert_pipeline: Option<wgpu::ComputePipeline>,
    convert_bgl: Option<wgpu::BindGroupLayout>,
    storage_usages: wgpu::TextureUsages,
    sampled_usages: wgpu::TextureUsages,
    software_debug: bool,
    shader_bounds: bool,
    tile: Option<(u32, u32)>,
    device_epoch: u64,
    avatars: AvatarGpu,
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
    shared: SharedGpuContext,
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
    gpu_probed: bool,
    image_paints: Vec<ImagePaintOp>,
}

unsafe impl Send for GpuHost {}

static HOST: Mutex<Option<GpuHost>> = Mutex::new(None);
static DIRTY: AtomicBool = AtomicBool::new(true);
static AVATAR_OVERLAY: AtomicBool = AtomicBool::new(false);
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
        flags: wgpu::InstanceFlags::from_build_config().with_env()
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
        adapter_sort_key(info.backend, info.device_type)
    });
    let adapter = adapters
        .into_iter()
        .find(|adapter| {
            let info = adapter.get_info();
            if skip_emulator_vulkan(&info) {
                return false;
            }
            adapter.is_surface_supported(&surface)
        })
        .ok_or_else(|| "no surface-capable Vulkan/GLES adapter".to_string())?;
    let info = adapter.get_info();
    let (device, queue) = request_vello_device(&adapter)?;
    device.on_uncaptured_error(Arc::new(|err| {
        trace(&format!(
            "wgpu_uncaptured {}",
            err.to_string().replace([' ', '\n'], "_")
        ));
    }));
    let plan =
        plan_vello_target(adapter.get_texture_format_features(wgpu::TextureFormat::Rgba8Unorm))?;
    trace(&plan.log_line());
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
    let software_debug = software_raster_debug_enabled();
    let renderer = Renderer::new(&device, vello_renderer_options(software_debug))
        .map_err(|err| format!("vello: {err}"))?;
    let content = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("neocompositor-vello-storage"),
        size: wgpu::Extent3d {
            width: config.width,
            height: config.height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: plan.format,
        usage: plan.storage_usages,
        view_formats: &[],
    });
    let content_view = content.create_view(&wgpu::TextureViewDescriptor::default());
    let resolve = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("neocompositor-sampled"),
        size: wgpu::Extent3d {
            width: config.width,
            height: config.height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: plan.format,
            usage: plan.sampled_usages | wgpu::TextureUsages::COPY_SRC,
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
    let (convert_pipeline, convert_bgl) = if plan.convert == ConvertMode::Compute {
        let (pipeline, bgl) = create_storage_convert_pipeline(&device);
        (Some(pipeline), Some(bgl))
    } else {
        (None, None)
    };
    let avatars = AvatarGpu::new(&device, plan.format);
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
        convert: plan.convert,
        convert_pipeline,
        convert_bgl,
        storage_usages: plan.storage_usages,
        sampled_usages: plan.sampled_usages | wgpu::TextureUsages::COPY_SRC,
        software_debug,
        shader_bounds: false,
        tile: None,
        device_epoch: 0,
        avatars,
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

fn host_line(gpu: &GpuSurface, product_wire: &str, devices: u32, density: f32) -> String {
    production_host_line(
        &gpu.backend,
        product_wire,
        devices,
        density,
        gpu.config.format,
        gpu.device_epoch,
        gpu.software_debug,
    )
}

struct RasterReport {
    class: SampleClass,
    samples: [[u8; 4]; 3],
}

fn ui_base_clear_color() -> wgpu::Color {
    wgpu::Color {
        r: 0x3d as f64 / 255.0,
        g: 0x5c as f64 / 255.0,
        b: 1.0,
        a: 1.0,
    }
}

fn alloc_fresh_targets(
    gpu: &GpuSurface,
    width: u32,
    height: u32,
) -> (wgpu::Texture, wgpu::Texture, wgpu::TextureView, wgpu::TextureView) {
    let size = wgpu::Extent3d {
        width: width.max(1),
        height: height.max(1),
        depth_or_array_layers: 1,
    };
    let storage = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("vello-diag-storage"),
        size,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: gpu.storage_usages,
        view_formats: &[],
    });
    let sampled = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("vello-diag-sampled"),
        size,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: gpu.sampled_usages,
        view_formats: &[],
    });
    let storage_view = storage.create_view(&wgpu::TextureViewDescriptor::default());
    let sampled_view = sampled.create_view(&wgpu::TextureViewDescriptor::default());
    (storage, sampled, storage_view, sampled_view)
}

fn copy_sampled_to_resolve(gpu: &GpuSurface, sampled: &wgpu::Texture, width: u32, height: u32) {
    if width != gpu.config.width || height != gpu.config.height {
        clear_view_color(&gpu.device, &gpu.queue, &gpu.resolve_view, ui_base_clear_color());
    }
    let mut encoder = gpu
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("vello-diag-present-copy"),
        });
    encoder.copy_texture_to_texture(
        wgpu::TexelCopyTextureInfo {
            texture: sampled,
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
            width: width.min(gpu.config.width).max(1),
            height: height.min(gpu.config.height).max(1),
            depth_or_array_layers: 1,
        },
    );
    gpu.queue.submit(Some(encoder.finish()));
}

fn recreate_renderer(gpu: &mut GpuSurface, bounds: bool) -> Result<(), String> {
    vello::set_debug_shader_bounds_checks(bounds);
    gpu.renderer = Renderer::new(&gpu.device, vello_renderer_options(gpu.software_debug))
        .map_err(|err| format!("vello renderer: {err}"))?;
    gpu.shader_bounds = bounds;
    trace(&format!(
        "vello_gpu shader_bounds={} use_cpu={}",
        u8::from(bounds),
        u8::from(gpu.software_debug)
    ));
    Ok(())
}

fn raster_fresh(
    gpu: &mut GpuSurface,
    scene: &vello::Scene,
    stage: &str,
    width: u32,
    height: u32,
    base_color: vello::peniko::Color,
    present: bool,
    capture: bool,
) -> Result<RasterReport, String> {
    let width = width.max(1);
    let height = height.max(1);
    trace(&format!(
        "vello_gpu stage={stage} renderer={} use_cpu={} shader_bounds={} paths={} empty={} bins={} convert={:?} target={}x{} {}",
        renderer_name(gpu.software_debug),
        u8::from(gpu.software_debug),
        u8::from(gpu.shader_bounds),
        scene.encoding().n_paths,
        u8::from(scene.encoding().is_empty()),
        coarse_bin_count(width, height),
        gpu.convert,
        width,
        height,
        encoding_line(scene, width, height),
    ));
    let (storage, sampled, storage_view, sampled_view) = alloc_fresh_targets(gpu, width, height);
    if capture {
        unsafe {
            gpu.device.start_graphics_debugger_capture();
        }
    }
    let g_internal = gpu.device.push_error_scope(wgpu::ErrorFilter::Internal);
    let g_oom = gpu.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let g_validation = gpu.device.push_error_scope(wgpu::ErrorFilter::Validation);
    let render = gpu.renderer.render_to_texture(
        &gpu.device,
        &gpu.queue,
        scene,
        &storage_view,
        &RenderParams {
            base_color,
            width,
            height,
            antialiasing_method: AaConfig::Area,
        },
    );
    let render_ok = render.is_ok();
    if let Err(err) = &render {
        trace(&format!(
            "vello_gpu stage={stage} render_to_texture={}",
            err.to_string().replace(' ', "_")
        ));
    }
    if render_ok {
        gpu_storage_to_sampled(
            &gpu.device,
            &gpu.queue,
            VelloTargets {
                storage: &storage,
                sampled: &sampled,
                storage_view: &storage_view,
                sampled_view: &sampled_view,
                size: wgpu::Extent3d {
                    width,
                    height,
                    depth_or_array_layers: 1,
                },
                dest_origin: wgpu::Origin3d::ZERO,
            },
            StorageConvert {
                mode: gpu.convert,
                pipeline: gpu.convert_pipeline.as_ref(),
                layout: gpu.convert_bgl.as_ref(),
            },
        );
    }
    let (tx, rx) = std::sync::mpsc::channel();
    gpu.queue.on_submitted_work_done(move || {
        let _ = tx.send(());
    });
    let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
    let submit_done = u8::from(rx.try_recv().is_ok());
    let validation = pollster::block_on(g_validation.pop());
    let oom = pollster::block_on(g_oom.pop());
    let internal = pollster::block_on(g_internal.pop());
    trace(&format!(
        "vello_gpu stage={stage} render_ok={} submit_done={} {}",
        u8::from(render_ok),
        submit_done,
        format_error_scopes(validation, oom, internal),
    ));
    if capture {
        unsafe {
            gpu.device.stop_graphics_debugger_capture();
        }
    }
    let cx = width / 2;
    let cy = height / 2;
    let samples = [
        peek_texture_rgba(&gpu.device, &gpu.queue, &sampled, 0, 0),
        peek_texture_rgba(&gpu.device, &gpu.queue, &sampled, cx, cy),
        peek_texture_rgba(
            &gpu.device,
            &gpu.queue,
            &sampled,
            width.saturating_sub(1).min(80),
            height.saturating_sub(1).min(80),
        ),
    ];
    let rgba = base_color.to_rgba8();
    let base_rgba = [rgba.r, rgba.g, rgba.b, rgba.a];
    let class = classify_samples(&samples, base_rgba);
    trace(&format!(
        "vello_gpu stage={stage} sample={} p00={:?} center={:?} p80={:?}",
        class.as_str(),
        samples[0],
        samples[1],
        samples[2],
    ));
    if present && render_ok {
        copy_sampled_to_resolve(gpu, &sampled, width, height);
    }
    Ok(RasterReport {
        class,
        samples,
    })
}

fn raster_tiled(
    gpu: &mut GpuSurface,
    scene: &vello::Scene,
    tile_w: u32,
    tile_h: u32,
) -> Result<RasterReport, String> {
    let full_w = gpu.config.width;
    let full_h = gpu.config.height;
    clear_view_color(
        &gpu.device,
        &gpu.queue,
        &gpu.resolve_view,
        ui_base_clear_color(),
    );
    trace(&format!(
        "vello_gpu stage=ui-tiled tile={}x{} surface={}x{} tiles={} {}",
        tile_w,
        tile_h,
        full_w,
        full_h,
        tile_origins(full_w, full_h, tile_w, tile_h).len(),
        encoding_line(scene, tile_w, tile_h),
    ));
    let mut last = RasterReport {
        class: SampleClass::BaseColorOnly,
        samples: [UI_BASE_RGBA; 3],
    };
    for (x, y, tw, th) in tile_origins(full_w, full_h, tile_w, tile_h) {
        let tile_scene = scene_with_tile_origin(scene, x, y);
        let (storage, sampled, storage_view, sampled_view) = alloc_fresh_targets(gpu, tw, th);
        let render = gpu.renderer.render_to_texture(
            &gpu.device,
            &gpu.queue,
            &tile_scene,
            &storage_view,
            &RenderParams {
                base_color: UI_BASE_COLOR,
                width: tw,
                height: th,
                antialiasing_method: AaConfig::Area,
            },
        );
        if let Err(err) = &render {
            trace(&format!(
                "vello_gpu stage=ui-tiled origin={x},{y} render_to_texture={}",
                err.to_string().replace(' ', "_")
            ));
            continue;
        }
        gpu_storage_to_sampled(
            &gpu.device,
            &gpu.queue,
            VelloTargets {
                storage: &storage,
                sampled: &sampled,
                storage_view: &storage_view,
                sampled_view: &sampled_view,
                size: wgpu::Extent3d {
                    width: tw,
                    height: th,
                    depth_or_array_layers: 1,
                },
                dest_origin: wgpu::Origin3d::ZERO,
            },
            StorageConvert {
                mode: gpu.convert,
                pipeline: gpu.convert_pipeline.as_ref(),
                layout: gpu.convert_bgl.as_ref(),
            },
        );
        let mut encoder = gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("vello-diag-tile-copy"),
            });
        encoder.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &sampled,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyTextureInfo {
                texture: &gpu.resolve,
                mip_level: 0,
                origin: wgpu::Origin3d { x, y, z: 0 },
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::Extent3d {
                width: tw,
                height: th,
                depth_or_array_layers: 1,
            },
        );
        gpu.queue.submit(Some(encoder.finish()));
        last = RasterReport {
            class: SampleClass::PathsWrote,
            samples: last.samples,
        };
    }
    let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
    last.samples = [
        peek_texture_rgba(&gpu.device, &gpu.queue, &gpu.resolve, 0, 0),
        peek_texture_rgba(
            &gpu.device,
            &gpu.queue,
            &gpu.resolve,
            full_w / 2,
            full_h / 2,
        ),
        peek_texture_rgba(
            &gpu.device,
            &gpu.queue,
            &gpu.resolve,
            full_w.saturating_sub(1).min(80),
            full_h.saturating_sub(1).min(80),
        ),
    ];
    last.class = classify_samples(&last.samples, UI_BASE_RGBA);
    trace(&format!(
        "vello_gpu stage=ui-tiled sample={} center={:?}",
        last.class.as_str(),
        last.samples[1],
    ));
    Ok(last)
}

fn canvas_clear_color() -> wgpu::Color {
    wgpu::Color {
        r: 0x15 as f64 / 255.0,
        g: 0x13 as f64 / 255.0,
        b: 0x11 as f64 / 255.0,
        a: 1.0,
    }
}

fn clear_view_color(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    view: &wgpu::TextureView,
    color: wgpu::Color,
) {
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
                    load: wgpu::LoadOp::Clear(color),
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

fn clear_canvas_view(device: &wgpu::Device, queue: &wgpu::Queue, view: &wgpu::TextureView) {
    clear_view_color(device, queue, view, canvas_clear_color());
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
    encoder.push_debug_group("neocompositor-blit");
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
    encoder.pop_debug_group();
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

fn attach_failed(err: impl std::fmt::Display) -> String {
    let line = format!(
        "host=neocompositor-surfaceview attach_failed reason={}",
        err.to_string().replace(' ', "_")
    );
    trace(&line);
    line
}

fn bind_shared_device(gpu: &mut GpuSurface) -> Result<SharedGpuContext, String> {
    let mut shared = SharedGpuContext::open(GpuCaps {
        compute: true,
        timestamp_queries: false,
        max_texture_dimension_2d: 4096,
    })
    .map_err(|err| err.to_string())?;
    let raster = shared.bind_raster().map_err(|err| err.to_string())?;
    let compositor = shared.bind_compositor().map_err(|err| err.to_string())?;
    if raster.identity != compositor.identity || raster.epoch != compositor.epoch {
        return Err("raster and compositor bound different DeviceEpoch".into());
    }
    shared
        .alloc(HandleOwner::Raster, SharedHandleKind::RasterTile)
        .map_err(|err| err.to_string())?;
    shared
        .alloc(HandleOwner::Surface, SharedHandleKind::Surface)
        .map_err(|err| err.to_string())?;
    gpu.device_epoch = shared.device_epoch().0;
    Ok(shared)
}

pub fn attach(env: &JNIEnv, surface: &JObject, width: i32, height: i32, density: f32) -> String {
    detach();
    let width = if width > 0 { width as u32 } else { 1 };
    let height = if height > 0 { height as u32 } else { 1 };
    let density = if density >= 1.0 { density } else { 1.0 };
    match open_gpu(env, surface, width, height) {
        Ok(mut gpu) => {
            let shared = match bind_shared_device(&mut gpu) {
                Ok(shared) => shared,
                Err(err) => return attach_failed(err),
            };
            let devices = shared.telemetry().devices;
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
                shared,
                input: PlatformInputAdapter::new(),
                velocity: 0.0,
                last_y: None,
                last_t: None,
                devices,
                density,
                inset_physical: pending,
                shell_overlay: true,
                hit_view: None,
                pending_ui: None,
                gpu_probed: false,
                image_paints: Vec::new(),
            };
            DIRTY.store(true, Ordering::SeqCst);
            let line = host_line(&host.gpu, "live", host.devices, density);
            *HOST.lock().unwrap_or_else(|p| p.into_inner()) = Some(host);
            trace(&line);
            line
        }
        Err(err) => attach_failed(err),
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

fn overlay_avatars<W: ProductWire>(
    host: &mut GpuHost,
    session: &ChatSession<W>,
    mut produced: neotavern_presentation_m0_d2::ProducerOutput,
    layout: ProductPaintLayout,
) -> neotavern_presentation_m0_d2::ProducerOutput {
    produced.list.generation = session.scene_epoch();
    for (asset_id, thumb) in session.avatar_thumbs() {
        let uploaded = host
            .gpu
            .avatars
            .upload(&host.gpu.device, &host.gpu.queue, asset_id, thumb);
        if uploaded {
            trace(&format!("avatar_gpu uploaded asset={asset_id}"));
        }
    }
    let paints = image_paints_from_layout(&layout, host.density, host.gpu.avatars.ready_token());
    host.gpu.avatars.blit(
        &host.gpu.device,
        &host.gpu.queue,
        &host.gpu.resolve_view,
        host.gpu.config.width,
        host.gpu.config.height,
        &paints,
    );
    produced.list = attach_image_paints(produced.list, &paints);
    host.image_paints = paints;
    AVATAR_OVERLAY.store(false, Ordering::SeqCst);
    produced
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

fn bisect_b_filters() -> [(&'static str, VelloFilter); 6] {
    [
        ("background", VelloFilter::background()),
        ("sidebar_rects", VelloFilter::rects()),
        (
            "glyphs",
            VelloFilter {
                fills: true,
                glyphs: true,
                clips: false,
                layers: false,
                shadows: false,
                max_ops: None,
            },
        ),
        (
            "clips",
            VelloFilter {
                fills: true,
                glyphs: true,
                clips: true,
                layers: false,
                shadows: false,
                max_ops: None,
            },
        ),
        (
            "layers",
            VelloFilter {
                fills: true,
                glyphs: true,
                clips: true,
                layers: true,
                shadows: false,
                max_ops: None,
            },
        ),
        ("shadows", VelloFilter::full()),
    ]
}

fn prefix_writes(
    session: &mut ProductVelloSession,
    gpu: &mut GpuSurface,
    width: u32,
    height: u32,
    max_ops: u32,
) -> Result<bool, String> {
    if max_ops == 0 {
        return Ok(false);
    }
    let (produced, scene, diag) = session.paint(VelloFilter::full().with_max_ops(max_ops))?;
    trace(&format!(
        "vello_gpu bisect_prefix max_ops={} list_ops={} {}",
        max_ops,
        produced.list.ops.len(),
        diag.line(),
    ));
    let report = raster_fresh(
        gpu,
        &scene,
        "ui-prefix",
        width,
        height,
        UI_BASE_COLOR,
        false,
        false,
    )?;
    Ok(report.class == SampleClass::PathsWrote)
}

fn run_gpu_diagnostics(
    host: &mut GpuHost,
    session: &mut ProductVelloSession,
    produced: &neotavern_presentation_m0_d2::ProducerOutput,
    full_scene: &vello::Scene,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let gpu = &mut host.gpu;
    let rect_report = raster_fresh(
        gpu,
        &opaque_rect_scene(width, height),
        "rect",
        width,
        height,
        vello::peniko::Color::from_rgb8(0x15, 0x13, 0x11),
        false,
        false,
    )?;
    trace(&format!(
        "vello_gpu plumbing_rect={} (not presented)",
        rect_report.class.as_str()
    ));
    let clear_report = raster_fresh(
        gpu,
        &vello::Scene::new(),
        "clear",
        width,
        height,
        UI_BASE_COLOR,
        false,
        false,
    )?;
    trace(&format!(
        "vello_gpu unique_base_clear={}",
        clear_report.class.as_str()
    ));

    recreate_renderer(gpu, false)?;
    let unchecked = raster_fresh(
        gpu,
        full_scene,
        "ui-unchecked",
        width,
        height,
        UI_BASE_COLOR,
        false,
        true,
    )?;
    recreate_renderer(gpu, true)?;
    let checked = raster_fresh(
        gpu,
        full_scene,
        "ui-checked",
        width,
        height,
        UI_BASE_COLOR,
        false,
        true,
    )?;
    let oob = checked.class == SampleClass::PathsWrote
        && unchecked.class != SampleClass::PathsWrote;
    if oob {
        trace("vello_gpu oob_regression=1 shader_bounds_checked_wrote_ui=1 (no WGSL patch)");
        recreate_renderer(gpu, true)?;
    } else {
        recreate_renderer(gpu, false)?;
        if checked.class != SampleClass::PathsWrote && unchecked.class != SampleClass::PathsWrote {
            trace("vello_gpu oob_regression=0 shader_bounds_ab=both_failed");
        } else {
            trace("vello_gpu oob_regression=0 shader_bounds_ab=unchecked_kept");
        }
    }

    let mut best_res: Option<(u32, u32)> = None;
    for (rw, rh, name) in resolution_ladder(width, height) {
        let report = raster_fresh(
            gpu,
            full_scene,
            &format!("ui-res-{name}"),
            rw,
            rh,
            UI_BASE_COLOR,
            false,
            false,
        )?;
        trace(&format!(
            "vello_gpu bisect_a size={name} sample={}",
            report.class.as_str()
        ));
        if report.class == SampleClass::PathsWrote {
            best_res = Some((rw, rh));
        }
    }

    for (name, filter) in bisect_b_filters() {
        let (stage_out, scene, diag) = session.paint(filter)?;
        trace(&format!(
            "vello_gpu bisect_b stage={name} list_ops={} {}",
            stage_out.list.ops.len(),
            diag.line(),
        ));
        let report = raster_fresh(
            gpu,
            &scene,
            &format!("ui-feat-{name}"),
            width,
            height,
            UI_BASE_COLOR,
            false,
            false,
        )?;
        trace(&format!(
            "vello_gpu bisect_b stage={name} sample={}",
            report.class.as_str()
        ));
    }
    trace("vello_gpu bisect_b stage=rectangles same_as=sidebar_rects");

    let full_ops = session
        .paint(VelloFilter::full())
        .map(|(_, _, diag)| diag.ops)
        .unwrap_or(0);
    let full_wrote = unchecked.class == SampleClass::PathsWrote
        || checked.class == SampleClass::PathsWrote;
    if !full_wrote && full_ops > 0 {
        let mut lo = 0u32;
        let mut hi = full_ops;
        while lo < hi {
            let mid = lo + (hi - lo + 1) / 2;
            if prefix_writes(session, gpu, width, height, mid)? {
                lo = mid;
            } else {
                hi = mid.saturating_sub(1);
            }
        }
        trace(&format!(
            "vello_gpu bisect_prefix last_write_ops={lo} first_fail_ops={} of {full_ops} list_ops={}",
            lo.saturating_add(1),
            produced.list.ops.len(),
        ));
    }

    // Single full-viewport path: one layout/PaintScene/SceneEpoch, no layout per tile.
    // The tiled fallback is removed to avoid seam and tile-origin coordinate bugs.
    let present = {
        gpu.tile = None;
        raster_fresh(
            gpu,
            full_scene,
            "ui",
            width,
            height,
            UI_BASE_COLOR,
            true,
            false,
        )?
    };
    trace(&format!(
        "vello_gpu present_class={} shader_bounds={} tile={:?}",
        present.class.as_str(),
        u8::from(gpu.shader_bounds),
        gpu.tile,
    ));
    Ok(())
}

fn produce_and_raster(
    host: &mut GpuHost,
    width: u32,
    height: u32,
    density: f32,
    insets: SafeAreaInsets,
) -> Result<(neotavern_presentation_m0_d2::ProducerOutput, ProductPaintLayout), String> {
    let mut session = catch_unwind(AssertUnwindSafe(|| {
        ProductVelloSession::open(product_shell_app, width, height, density, insets)
    }))
    .unwrap_or_else(|_| Err("produce_panic".into()))?;
    let (produced, full_scene, diag) = session.paint(VelloFilter::full())?;
    let layout = session.paint_layout().clone();
    trace(&diag.line());
    let tile_count = host
        .gpu
        .tile
        .map(|(tw, th)| tile_origins(width, height, tw, th).len())
        .unwrap_or(1);
    trace(&format!(
        "vello_gpu paint_scene=1 scene_epoch={} layout=1 tiles={}",
        produced.list.generation,
        tile_count
    ));
    if !host.gpu_probed {
        run_gpu_diagnostics(host, &mut session, &produced, &full_scene, width, height)?;
        host.gpu_probed = true;
    } else {
        // One full-viewport raster per frame, no tiled layout.
        raster_fresh(
            &mut host.gpu,
            &full_scene,
            "ui",
            width,
            height,
            UI_BASE_COLOR,
            true,
            false,
        )?;
    }
    Ok((produced, layout))
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
        Ok((produced, layout)) => {
            overlay_avatars(host, session, produced, layout)
        }
        Err(err) => {
            trace(&format!(
                "product_bind retry_without_avatars reason={}",
                err.replace(' ', "_")
            ));
            let stripped = shell_without_avatars(shell);
            host.hit_view = Some(stripped.clone());
            install_product_shell(stripped);
            let (produced, layout) =
                produce_and_raster(host, width, height, host.density, session.insets())?;
            overlay_avatars(host, session, produced, layout)
        }
    };
    trace(&format!(
        "product_paint cmds={} rasters={} avatars={} ready={}",
        produced.report.paint_commands,
        produced.report.raster_images,
        host.image_paints.len(),
        host.gpu.avatars.ready_token(),
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
    let line = host_line(&host.gpu, "live", host.devices, host.density);
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
                    "host=neocompositor-surfaceview present vsync={vsync_id} deadline={deadline} expected={expected_present} {} backend={} renderer={} devices={} device_epoch={} cpu_full_frame_raster={} image_readbacks=0 cross_device_copies=0 sampled_output=true",
                    compositor.telemetry_line(),
                    host.gpu.backend,
                    renderer_name(host.gpu.software_debug),
                    host.devices,
                    host.shared.device_epoch().0,
                    u8::from(host.gpu.software_debug),
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
            Ok(()) => host_line(&host.gpu, "live", host.devices, host.density),
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

pub fn is_avatar_overlay() -> bool {
    AVATAR_OVERLAY.load(Ordering::SeqCst)
}

pub fn composite_avatar_overlay() -> bool {
    let mut slot = HOST.lock().unwrap_or_else(|p| p.into_inner());
    let Some(host) = slot.as_mut() else {
        return false;
    };
    if host.image_paints.is_empty() {
        AVATAR_OVERLAY.store(false, Ordering::SeqCst);
        return false;
    }
    host.gpu.avatars.blit(
        &host.gpu.device,
        &host.gpu.queue,
        &host.gpu.resolve_view,
        host.gpu.config.width,
        host.gpu.config.height,
        &host.image_paints,
    );
    AVATAR_OVERLAY.store(false, Ordering::SeqCst);
    true
}

/// Native chat composer/Send overlay is only attached on the chat route.
pub fn chat_route_visible() -> bool {
    let slot = HOST.lock().unwrap_or_else(|p| p.into_inner());
    slot.as_ref()
        .map(|host| !host.shell_overlay)
        .unwrap_or(false)
}
