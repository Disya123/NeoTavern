//! GPU Vello bind shared with the Android SurfaceView host.
//!
//! Matches the M0-D1a / M0-D2 device request (`Limits::default()` first,
//! `CLEAR_TEXTURE` / `PIPELINE_CACHE` when the adapter has them, `use_cpu:
//! false`). CPU Vello is only [`software_raster_debug_enabled`].

use std::num::NonZeroUsize;
use std::sync::Mutex;

use vello::kurbo::{Affine, Rect};
use vello::peniko::{Color, Fill};
use vello::Scene;
use wgpu::TextureFormatFeatureFlags;

const SOFTWARE_RASTER_DEBUG_ENV: &str = "NEOTA_SOFTWARE_RASTER_DEBUG";
static SOFTWARE_RASTER_DEBUG: Mutex<Option<bool>> = Mutex::new(None);

/// GPU→GPU path from Vello's storage target to a sampleable compositor texture.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConvertMode {
    Copy,
    Compute,
}

/// Declared usages for the Vello storage target and the sampled NeoCompositor
/// texture. Non-sRGB `Rgba8Unorm`, premultiplied alpha.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VelloTargetPlan {
    pub format: wgpu::TextureFormat,
    pub storage_usages: wgpu::TextureUsages,
    pub sampled_usages: wgpu::TextureUsages,
    pub convert: ConvertMode,
    pub storage_write: bool,
    pub storage_read: bool,
    pub copy_src: bool,
    pub copy_dst: bool,
    pub texture_binding: bool,
    pub filterable: bool,
}

impl VelloTargetPlan {
    pub fn log_line(&self) -> String {
        format!(
            "vello_gpu format={:?} convert={:?} storage_write={} storage_read={} copy_src={} copy_dst={} sampled={} filterable={} alpha=premultiplied",
            self.format,
            self.convert,
            u8::from(self.storage_write),
            u8::from(self.storage_read),
            u8::from(self.copy_src),
            u8::from(self.copy_dst),
            u8::from(self.texture_binding),
            u8::from(self.filterable),
        )
    }
}

/// Explicit debug override. `None` falls back to `NEOTA_SOFTWARE_RASTER_DEBUG=1`.
pub fn set_software_raster_debug(enabled: Option<bool>) {
    *SOFTWARE_RASTER_DEBUG
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = enabled;
}

pub fn software_raster_debug_enabled() -> bool {
    if let Some(enabled) = *SOFTWARE_RASTER_DEBUG
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
    {
        return enabled;
    }
    matches!(std::env::var(SOFTWARE_RASTER_DEBUG_ENV).as_deref(), Ok("1"))
}

pub fn renderer_name(software_debug: bool) -> &'static str {
    if software_debug {
        "vello-cpu"
    } else {
        "vello-gpu"
    }
}

pub fn production_host_line(
    backend: &str,
    product_wire: &str,
    devices: u32,
    density: f32,
    swapchain: wgpu::TextureFormat,
    device_epoch: u64,
    software_debug: bool,
) -> String {
    let srgb = u8::from(matches!(
        swapchain,
        wgpu::TextureFormat::Rgba8UnormSrgb | wgpu::TextureFormat::Bgra8UnormSrgb
    ));
    format!(
        "host=neocompositor-surfaceview backend={backend} product_wire={product_wire} producer=dioxus+blitz renderer={} devices={devices} device_epoch={device_epoch} density={density} swapchain={swapchain:?} srgb={srgb} sampled_output=true cpu_full_frame_raster={} image_readbacks=0 cross_device_copies=0 software_raster_debug={}",
        renderer_name(software_debug),
        u8::from(software_debug),
        u8::from(software_debug),
    )
}

pub fn vello_renderer_options(software_debug: bool) -> vello::RendererOptions {
    vello::RendererOptions {
        use_cpu: software_debug,
        antialiasing_support: vello::AaSupport::area_only(),
        num_init_threads: NonZeroUsize::new(1),
        ..Default::default()
    }
}

/// Vello 0.9 bin is 256×256 px (16 tiles × 16 px). GPU coarse workgroups must
/// stay ≤ 256 ([linebender/vello#680](https://github.com/linebender/vello/issues/680)).
pub fn coarse_bin_count(width: u32, height: u32) -> u32 {
    let tiles_x = width.div_ceil(16);
    let tiles_y = height.div_ceil(16);
    tiles_x.div_ceil(16) * tiles_y.div_ceil(16)
}

pub fn opaque_rect_scene(width: u32, height: u32) -> Scene {
    let mut scene = Scene::new();
    let width = f64::from(width.max(1));
    let height = f64::from(height.max(1));
    scene.fill(
        Fill::NonZero,
        Affine::IDENTITY,
        Color::from_rgb8(0xe3, 0x8a, 0x62),
        None,
        &Rect::new(width * 0.1, height * 0.1, width * 0.9, height * 0.9),
    );
    scene
}

pub fn plan_vello_target(features: wgpu::TextureFormatFeatures) -> Result<VelloTargetPlan, String> {
    let usages = features.allowed_usages;
    let flags = features.flags;
    let storage_write = usages.contains(wgpu::TextureUsages::STORAGE_BINDING)
        && flags.contains(TextureFormatFeatureFlags::STORAGE_WRITE_ONLY);
    if !storage_write {
        return Err(
            "Rgba8Unorm lacks STORAGE_BINDING/STORAGE_WRITE_ONLY (Vello GPU compute target)".into(),
        );
    }
    let copy_src = usages.contains(wgpu::TextureUsages::COPY_SRC);
    let copy_dst = usages.contains(wgpu::TextureUsages::COPY_DST);
    let texture_binding = usages.contains(wgpu::TextureUsages::TEXTURE_BINDING);
    let render = usages.contains(wgpu::TextureUsages::RENDER_ATTACHMENT);
    let storage_read = flags.contains(TextureFormatFeatureFlags::STORAGE_READ_ONLY);
    let filterable = flags.contains(TextureFormatFeatureFlags::FILTERABLE);
    if !texture_binding {
        return Err("Rgba8Unorm lacks TEXTURE_BINDING for the sampled compositor target".into());
    }
    let (convert, storage_usages, sampled_usages) = if copy_src && copy_dst {
        (
            ConvertMode::Copy,
            wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
            wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_DST
                | wgpu::TextureUsages::RENDER_ATTACHMENT,
        )
    } else if storage_read && texture_binding {
        let mut sampled =
            wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING;
        if render {
            sampled |= wgpu::TextureUsages::RENDER_ATTACHMENT;
        }
        (
            ConvertMode::Compute,
            wgpu::TextureUsages::STORAGE_BINDING,
            sampled,
        )
    } else {
        return Err(
            "Rgba8Unorm cannot GPU-copy or storage-convert Vello output to a sampled texture"
                .into(),
        );
    };
    Ok(VelloTargetPlan {
        format: wgpu::TextureFormat::Rgba8Unorm,
        storage_usages,
        sampled_usages,
        convert,
        storage_write,
        storage_read,
        copy_src,
        copy_dst,
        texture_binding,
        filterable,
    })
}

pub fn skip_emulator_vulkan(info: &wgpu::AdapterInfo) -> bool {
    if info.backend != wgpu::Backend::Vulkan {
        return false;
    }
    let name = info.name.to_ascii_lowercase();
    name.contains("goldfish")
        || name.contains("gfxstream")
        || name.contains("swiftshader")
        || name.contains("android emulator")
}

pub fn adapter_sort_key(backend: wgpu::Backend, device_type: wgpu::DeviceType) -> (u8, u8) {
    let backend_rank = match backend {
        wgpu::Backend::Vulkan => 0,
        wgpu::Backend::Metal => 1,
        wgpu::Backend::Dx12 => 2,
        wgpu::Backend::Gl => 3,
        wgpu::Backend::BrowserWebGpu => 4,
        wgpu::Backend::Noop => 5,
    };
    (
        backend_rank,
        u8::from(matches!(device_type, wgpu::DeviceType::Cpu)),
    )
}

/// Same request as M0-D1a `open_device_on`: conservative WebGPU limits first.
pub fn request_vello_device(
    adapter: &wgpu::Adapter,
) -> Result<(wgpu::Device, wgpu::Queue), String> {
    let required_features =
        adapter.features() & (wgpu::Features::CLEAR_TEXTURE | wgpu::Features::PIPELINE_CACHE);
    let request = |limits: wgpu::Limits| {
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("neocompositor-chat"),
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

pub const CONVERT_WGSL: &str = r#"
@group(0) @binding(0) var src: texture_storage_2d<rgba8unorm, read>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba8unorm, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let dim = textureDimensions(src);
    if (id.x >= dim.x || id.y >= dim.y) {
        return;
    }
    let px = vec2<i32>(i32(id.x), i32(id.y));
    textureStore(dst, px, textureLoad(src, px));
}
"#;

pub fn create_storage_convert_pipeline(
    device: &wgpu::Device,
) -> (wgpu::ComputePipeline, wgpu::BindGroupLayout) {
    let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("vello-gpu-convert-bgl"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::StorageTexture {
                    access: wgpu::StorageTextureAccess::ReadOnly,
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    view_dimension: wgpu::TextureViewDimension::D2,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::StorageTexture {
                    access: wgpu::StorageTextureAccess::WriteOnly,
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    view_dimension: wgpu::TextureViewDimension::D2,
                },
                count: None,
            },
        ],
    });
    let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("vello-gpu-convert-pl"),
        bind_group_layouts: &[Some(&bgl)],
        immediate_size: 0,
    });
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("vello-gpu-convert"),
        source: wgpu::ShaderSource::Wgsl(CONVERT_WGSL.into()),
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("vello-gpu-convert-pipe"),
        layout: Some(&layout),
        module: &shader,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    });
    (pipeline, bgl)
}

pub struct VelloTargets<'a> {
    pub storage: &'a wgpu::Texture,
    pub sampled: &'a wgpu::Texture,
    pub storage_view: &'a wgpu::TextureView,
    pub sampled_view: &'a wgpu::TextureView,
    pub size: wgpu::Extent3d,
    pub dest_origin: wgpu::Origin3d,
}

pub struct StorageConvert<'a> {
    pub mode: ConvertMode,
    pub pipeline: Option<&'a wgpu::ComputePipeline>,
    pub layout: Option<&'a wgpu::BindGroupLayout>,
}

pub fn gpu_storage_to_sampled(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    targets: VelloTargets<'_>,
    convert: StorageConvert<'_>,
) {
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("vello-gpu-copy"),
    });
    encoder.push_debug_group("vello-gpu-copy");
    match convert.mode {
        ConvertMode::Copy => {
            encoder.copy_texture_to_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: targets.storage,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::TexelCopyTextureInfo {
                    texture: targets.sampled,
                    mip_level: 0,
                    origin: targets.dest_origin,
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::Extent3d {
                    width: targets.size.width.max(1),
                    height: targets.size.height.max(1),
                    depth_or_array_layers: 1,
                },
            );
        }
        ConvertMode::Compute => {
            let pipeline = convert.pipeline.expect("compute convert pipeline");
            let bgl = convert.layout.expect("compute convert layout");
            let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("vello-gpu-convert-bg"),
                layout: bgl,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(targets.storage_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(targets.sampled_view),
                    },
                ],
            });
            {
                let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    label: Some("vello-gpu-convert"),
                    timestamp_writes: None,
                });
                pass.set_pipeline(pipeline);
                pass.set_bind_group(0, &bind, &[]);
                pass.dispatch_workgroups(
                    targets.size.width.div_ceil(8).max(1),
                    targets.size.height.div_ceil(8).max(1),
                    1,
                );
            }
        }
    }
    encoder.pop_debug_group();
    queue.submit(Some(encoder.finish()));
}

pub fn peek_texture_rgba(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    texture: &wgpu::Texture,
    x: u32,
    y: u32,
) -> [u8; 4] {
    let padded = 256u64;
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("vello-gpu-diag-peek"),
        size: padded,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("vello-gpu-diag-peek"),
    });
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture,
            mip_level: 0,
            origin: wgpu::Origin3d { x, y, z: 0 },
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
    queue.submit(Some(encoder.finish()));
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    let slice = buffer.slice(..4);
    let (sender, receiver) = std::sync::mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |result| {
        let _ = sender.send(result);
    });
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    if receiver.recv().ok().and_then(Result::ok).is_none() {
        return [0, 0, 0, 0];
    }
    let data = slice.get_mapped_range();
    [data[0], data[1], data[2], data[3]]
}

// --- Cross-platform present host (Android SurfaceView host, generalized) ---
//
// The Android `android_surface.rs` host owns: adapter/device request, the
// Rgba8Unorm Vello storage target, a sampled accumulation/`resolve` texture,
// a fullscreen blit pipeline into the swapchain, and the present. The only
// platform-specific input is the `wgpu::Surface` (Android: ANativeWindow via
// `create_surface_unsafe`; Windows/macOS: a winit window via `create_surface`).
// This module is that host, available on every `gpu` build; Android can
// migrate onto it without changing behavior.

/// Fullscreen-triangle blit: samples `resolve` into the swapchain, with the
/// NeoCompositor scroll blend band and optional sRGB re-encode.
pub const BLIT_WGSL: &str = r#"
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

pub fn format_is_srgb(format: wgpu::TextureFormat) -> bool {
    matches!(
        format,
        wgpu::TextureFormat::Rgba8UnormSrgb | wgpu::TextureFormat::Bgra8UnormSrgb
    )
}

/// Prefer non-sRGB `Rgba8Unorm`/`Bgra8Unorm` so the swapchain target never
/// needs re-encoding before the storage-blit path (same preference as the
/// Android host).
pub fn pick_surface_format(formats: &[wgpu::TextureFormat]) -> Option<wgpu::TextureFormat> {
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
        .find(|format| format_is_srgb(*format))
        .or_else(|| formats.first().copied())
}

pub fn pick_alpha_mode(modes: &[wgpu::CompositeAlphaMode]) -> wgpu::CompositeAlphaMode {
    if modes.contains(&wgpu::CompositeAlphaMode::Opaque) {
        wgpu::CompositeAlphaMode::Opaque
    } else {
        modes
            .first()
            .copied()
            .unwrap_or(wgpu::CompositeAlphaMode::Opaque)
    }
}

pub fn canvas_clear_color() -> wgpu::Color {
    wgpu::Color {
        r: 0x15 as f64 / 255.0,
        g: 0x13 as f64 / 255.0,
        b: 0x11 as f64 / 255.0,
        a: 1.0,
    }
}

pub fn clear_view_color(
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

/// Vello storage + sampled accumulation target pair at a given size.
pub struct PresentTargets {
    pub storage: wgpu::Texture,
    pub storage_view: wgpu::TextureView,
    pub resolve: wgpu::Texture,
    pub resolve_view: wgpu::TextureView,
}

impl PresentTargets {
    pub fn alloc(device: &wgpu::Device, plan: &VelloTargetPlan, width: u32, height: u32) -> Self {
        let size = wgpu::Extent3d {
            width: width.max(1),
            height: height.max(1),
            depth_or_array_layers: 1,
        };
        let storage = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("neocompositor-vello-storage"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: plan.format,
            usage: plan.storage_usages,
            view_formats: &[],
        });
        let storage_view = storage.create_view(&wgpu::TextureViewDescriptor::default());
        let resolve = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("neocompositor-sampled"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: plan.format,
            usage: plan.sampled_usages | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let resolve_view = resolve.create_view(&wgpu::TextureViewDescriptor::default());
        Self {
            storage,
            storage_view,
            resolve,
            resolve_view,
        }
    }
}

/// The shared render/present host. Identical behavior to the Android
/// `GpuSurface`: Vello renders into the non-sRGB storage target, the result is
/// copied into a sampled accumulation texture, and a fullscreen blit draws it
/// into the swapchain.
pub struct PresentSurface {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub surface: wgpu::Surface<'static>,
    pub config: wgpu::SurfaceConfiguration,
    pub backend: String,
    pub srgb_target: bool,
    pub convert: ConvertMode,
    plan: VelloTargetPlan,
    targets: PresentTargets,
    pipeline: wgpu::RenderPipeline,
    bind_layout: wgpu::BindGroupLayout,
    bind: wgpu::BindGroup,
    sampler: wgpu::Sampler,
    uniform: wgpu::Buffer,
    renderer: vello::Renderer,
    convert_pipeline: Option<wgpu::ComputePipeline>,
    convert_bgl: Option<wgpu::BindGroupLayout>,
    avatars: crate::avatar_gpu::AvatarGpu,
}

impl PresentSurface {
    /// Pick the best surface-capable adapter, request the Vello-capable device
    /// and build the full present pipeline. `surface,width,height` are the only
    /// platform inputs; the caller owns the `Surface`.
    pub fn open(
        instance: &wgpu::Instance,
        surface: wgpu::Surface<'static>,
        width: u32,
        height: u32,
    ) -> Result<Self, String> {
        let mut adapters = pollster::block_on(instance.enumerate_adapters(wgpu::Backends::all()));
        adapters.sort_by_key(|adapter| {
            let info = adapter.get_info();
            adapter_sort_key(info.backend, info.device_type)
        });
        let adapter = adapters
            .into_iter()
            .find(|adapter| {
                let info = adapter.get_info();
                !skip_emulator_vulkan(&info) && adapter.is_surface_supported(&surface)
            })
            .ok_or_else(|| "no surface-capable wgpu adapter".to_string())?;
        let info = adapter.get_info();
        let (device, queue) = request_vello_device(&adapter)?;
        let plan = plan_vello_target(
            adapter.get_texture_format_features(wgpu::TextureFormat::Rgba8Unorm),
        )?;
        let cap = surface.get_capabilities(&adapter);
        let format = pick_surface_format(&cap.formats).ok_or("no swapchain format")?;
        let srgb_target = format_is_srgb(format);
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            format,
            width: width.max(1),
            height: height.max(1),
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode: pick_alpha_mode(&cap.alpha_modes),
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &config);
        let renderer = vello::Renderer::new(&device, vello_renderer_options(false))
            .map_err(|err| format!("vello: {err}"))?;
        let targets = PresentTargets::alloc(&device, &plan, width, height);
        clear_view_color(&device, &queue, &targets.resolve_view, canvas_clear_color());

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
                    resource: wgpu::BindingResource::TextureView(&targets.resolve_view),
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
        let (convert_pipeline, convert_bgl) = if plan.convert == ConvertMode::Compute {
            let (pipeline, bgl) = create_storage_convert_pipeline(&device);
            (Some(pipeline), Some(bgl))
        } else {
            (None, None)
        };
        let avatars = crate::avatar_gpu::AvatarGpu::new(&device, plan.format);
        Ok(Self {
            device,
            queue,
            surface,
            config,
            backend: format!("{:?}", info.backend),
            srgb_target,
            convert: plan.convert,
            plan,
            targets,
            pipeline,
            bind_layout,
            bind,
            sampler,
            uniform,
            renderer,
            convert_pipeline,
            convert_bgl,
            avatars,
        })
    }

    /// Upload an avatar thumbnail into the overlay GPU cache (Android parity:
    /// `GpuHost` calls `avatars.upload` once per `asset_id`).
    pub fn upload_avatar(&mut self, asset_id: &str, thumb: &crate::avatar::AvatarThumb) -> bool {
        self.avatars
            .upload(&self.device, &self.queue, asset_id, thumb)
    }

    /// Draw cached avatar thumbnails on top of `resolve` (before the swapchain
    /// blit) — the shared-host equivalent of Android
    /// `composite_avatar_overlay`, so desktop / macOS composite the same image
    /// the Android surface shows.
    pub fn composite_avatars(&mut self, paints: &[neotavern_neocompositor::ImagePaintOp]) {
        if paints.is_empty() {
            return;
        }
        let (w, h) = self.size();
        self.avatars.blit(
            &self.device,
            &self.queue,
            &self.targets.resolve_view,
            w,
            h,
            paints,
        );
    }

    pub fn size(&self) -> (u32, u32) {
        (self.config.width, self.config.height)
    }

    /// Vello-rasterize `scene` into the storage target then move it into the
    /// sampled accumulation `resolve` (the same GPU→GPU path as the Android
    /// host, without avatars).
    pub fn render(
        &mut self,
        scene: &vello::Scene,
        base_color: vello::peniko::Color,
    ) -> Result<(), String> {
        let (width, height) = self.size();
        if let Err(err) = self.renderer.render_to_texture(
            &self.device,
            &self.queue,
            scene,
            &self.targets.storage_view,
            &vello::RenderParams {
                base_color,
                width,
                height,
                antialiasing_method: vello::AaConfig::Area,
            },
        ) {
            return Err(format!("render_to_texture: {err}"));
        }
        gpu_storage_to_sampled(
            &self.device,
            &self.queue,
            VelloTargets {
                storage: &self.targets.storage,
                sampled: &self.targets.resolve,
                storage_view: &self.targets.storage_view,
                sampled_view: &self.targets.resolve_view,
                size: wgpu::Extent3d {
                    width,
                    height,
                    depth_or_array_layers: 1,
                },
                dest_origin: wgpu::Origin3d::ZERO,
            },
            StorageConvert {
                mode: self.convert,
                pipeline: self.convert_pipeline.as_ref(),
                layout: self.convert_bgl.as_ref(),
            },
        );
        Ok(())
    }

    /// Draw `resolve` into the swapchain and present (mirror of the Android
    /// host's `blit`). Scroll/header/composer are the NeoCompositor blend
    /// window; header/composer may be 0 when the shell overlay is attached.
    pub fn present(&mut self, scroll_y: f32, header: f32, composer_top: f32) -> Result<(), String> {
        self.present_opt(scroll_y, header, composer_top, None)
    }

    /// `present` plus a one-shot swapchain read-back diagnostic (what the user
    /// actually sees). `swap_save` copies the backbuffer right after the blit,
    /// before `frame.present()`.
    pub fn present_and_dump(
        &mut self,
        scroll_y: f32,
        header: f32,
        composer_top: f32,
        swap_save: &str,
    ) -> Result<(), String> {
        self.present_opt(scroll_y, header, composer_top, Some(swap_save))
    }

    fn present_opt(
        &mut self,
        scroll_y: f32,
        header: f32,
        composer_top: f32,
        swap_save: Option<&str>,
    ) -> Result<(), String> {
        let height = self.config.height.max(1) as f32;
        let offset = scroll_y / height;
        let header_uv = header / height;
        let composer_uv = composer_top / height;
        let mut uniform = [0u8; 16];
        uniform[0..4].copy_from_slice(&offset.to_le_bytes());
        uniform[4..8].copy_from_slice(&header_uv.to_le_bytes());
        uniform[8..12].copy_from_slice(&composer_uv.to_le_bytes());
        let srgb = if self.srgb_target { 1.0f32 } else { 0.0 };
        uniform[12..16].copy_from_slice(&srgb.to_le_bytes());
        self.queue.write_buffer(&self.uniform, 0, &uniform);
        let frame = match self.surface.get_current_texture() {
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
        let mut encoder = self
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
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.bind, &[]);
            pass.draw(0..3, 0..1);
        }
        encoder.pop_debug_group();
        self.queue.submit(Some(encoder.finish()));
        if let Some(path) = swap_save {
            self.swapchain_snapshot(path, &frame)?;
        }
        frame.present();
        Ok(())
    }

    /// Re-tie the blit bind group to the (possibly re-allocated) `resolve`.
    /// Failing to do this after `resize` lets the blit keep sampling the old,
    /// cleared target — the swapchain shows the clear color while every other
    /// path (render/snapshot) still sees the fresh content.
    fn rebuild_bind(&mut self) {
        self.bind = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("neocompositor-bg"),
            layout: &self.bind_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&self.targets.resolve_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: self.uniform.as_entire_binding(),
                },
            ],
        });
    }

    /// Re-create targets and re-configure the swapchain at a new size.
    pub fn resize(&mut self, width: u32, height: u32) {
        let width = width.max(1);
        let height = height.max(1);
        if width == self.config.width && height == self.config.height {
            return;
        }
        self.config.width = width;
        self.config.height = height;
        self.targets = PresentTargets::alloc(&self.device, &self.plan, width, height);
        self.rebuild_bind();
        clear_view_color(
            &self.device,
            &self.queue,
            &self.targets.resolve_view,
            canvas_clear_color(),
        );
        self.surface.configure(&self.device, &self.config);
    }

    /// Headless diagnostic: read back the accumulated `resolve` (before the
    /// swapchain blit) and save it as a PNG — exactly what the blit samples.
    pub fn snapshot(&self, path: &str) -> Result<(), String> {
        let width = self.config.width.max(1);
        let height = self.config.height.max(1);
        let bytes_per_row = (width * 4).div_ceil(256) * 256;
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("neocompositor-snapshot"),
            size: u64::from(bytes_per_row * height),
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("neocompositor-snapshot"),
            });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &self.targets.resolve,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(bytes_per_row),
                    rows_per_image: Some(height),
                },
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        self.queue.submit(Some(encoder.finish()));
        let _ = self.device.poll(wgpu::PollType::wait_indefinitely());
        let slice = buffer.slice(..);
        let (sender, receiver) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = sender.send(result);
        });
        let _ = self.device.poll(wgpu::PollType::wait_indefinitely());
        receiver
            .recv()
            .map_err(|_| "snapshot map recv failed".to_string())?
            .map_err(|err| format!("snapshot map: {err}"))?;
        let data = slice.get_mapped_range();
        let row_bytes = (width as usize) * 4;
        let mut pixels = Vec::with_capacity(row_bytes * height as usize);
        for row in 0..(height as usize) {
            let start = row * (bytes_per_row as usize);
            pixels.extend_from_slice(&data[start..start + row_bytes]);
        }
        drop(data);
        buffer.unmap();
        image::save_buffer(path, &pixels, width, height, image::ColorType::Rgba8)
            .map_err(|err| format!("snapshot save: {err}"))?;
        Ok(())
    }

    /// Diagnostic: read back the swapchain backbuffer immediately after a
    /// `present` — the pixels the user actually sees on screen — instead of the
    /// pre-blit `resolve`. Returns an error string on the acquire result.
    pub fn swapchain_snapshot(
        &self,
        path: &str,
        frame: &wgpu::SurfaceTexture,
    ) -> Result<(), String> {
        let width = self.config.width.max(1);
        let height = self.config.height.max(1);
        let bytes_per_row = (width * 4).div_ceil(256) * 256;
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("neocompositor-swap-snapshot"),
            size: u64::from(bytes_per_row * height),
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("neocompositor-swap-snapshot"),
            });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &frame.texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(bytes_per_row),
                    rows_per_image: Some(height),
                },
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        self.queue.submit(Some(encoder.finish()));
        let _ = self.device.poll(wgpu::PollType::wait_indefinitely());
        let slice = buffer.slice(..);
        let (sender, receiver) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = sender.send(result);
        });
        let _ = self.device.poll(wgpu::PollType::wait_indefinitely());
        receiver
            .recv()
            .map_err(|_| "swap snapshot map recv failed".to_string())?
            .map_err(|err| format!("swap snapshot map: {err}"))?;
        let data = slice.get_mapped_range();
        let row_bytes = (width as usize) * 4;
        let mut pixels = Vec::with_capacity(row_bytes * height as usize);
        for row in 0..(height as usize) {
            let start = row * (bytes_per_row as usize);
            pixels.extend_from_slice(&data[start..start + row_bytes]);
        }
        drop(data);
        buffer.unmap();
        image::save_buffer(path, &pixels, width, height, image::ColorType::Rgba8)
            .map_err(|err| format!("swap snapshot save: {err}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_features(
        usages: wgpu::TextureUsages,
        flags: TextureFormatFeatureFlags,
    ) -> wgpu::TextureFormatFeatures {
        wgpu::TextureFormatFeatures {
            allowed_usages: usages,
            flags,
        }
    }

    #[test]
    fn software_raster_debug_is_off_without_an_explicit_flag() {
        set_software_raster_debug(None);
        if std::env::var(SOFTWARE_RASTER_DEBUG_ENV).as_deref() == Ok("1") {
            return;
        }
        assert!(!software_raster_debug_enabled());
        assert_eq!(renderer_name(false), "vello-gpu");
        assert!(!vello_renderer_options(false).use_cpu);
    }

    #[test]
    fn software_raster_debug_is_only_the_explicit_override() {
        set_software_raster_debug(Some(true));
        assert!(software_raster_debug_enabled());
        assert!(vello_renderer_options(true).use_cpu);
        set_software_raster_debug(Some(false));
        assert!(!software_raster_debug_enabled());
        set_software_raster_debug(None);
    }

    #[test]
    fn production_host_line_is_vello_gpu_without_cpu_raster() {
        let line = production_host_line(
            "Vulkan",
            "live",
            1,
            3.0,
            wgpu::TextureFormat::Rgba8Unorm,
            0,
            false,
        );
        assert!(line.contains("renderer=vello-gpu"));
        assert!(line.contains("backend=Vulkan"));
        assert!(line.contains("devices=1"));
        assert!(line.contains("cpu_full_frame_raster=0"));
        assert!(line.contains("image_readbacks=0"));
        assert!(line.contains("cross_device_copies=0"));
        assert!(line.contains("sampled_output=true"));
        assert!(line.contains("software_raster_debug=0"));
        assert!(!line.contains("renderer=vello-cpu"));
    }

    #[test]
    fn xiaomi_physical_surface_stays_under_vello_bin_cap() {
        assert!(coarse_bin_count(1220, 2712) < 256);
        assert!(coarse_bin_count(320, 200) < 256);
    }

    #[test]
    fn opaque_rect_scene_is_not_empty() {
        let scene = opaque_rect_scene(1220, 2712);
        assert!(!scene.encoding().is_empty());
        assert!(scene.encoding().n_paths > 0);
    }

    #[test]
    fn storage_target_prefers_gpu_copy_to_a_sampled_texture() {
        let plan = plan_vello_target(sample_features(
            wgpu::TextureUsages::STORAGE_BINDING
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::COPY_DST
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::RENDER_ATTACHMENT,
            TextureFormatFeatureFlags::STORAGE_WRITE_ONLY
                | TextureFormatFeatureFlags::STORAGE_READ_ONLY
                | TextureFormatFeatureFlags::FILTERABLE,
        ))
        .expect("plan");
        assert_eq!(plan.format, wgpu::TextureFormat::Rgba8Unorm);
        assert_eq!(plan.convert, ConvertMode::Copy);
        assert!(plan.log_line().contains("convert=Copy"));
        assert!(plan.log_line().contains("alpha=premultiplied"));
        assert!(plan
            .storage_usages
            .contains(wgpu::TextureUsages::STORAGE_BINDING));
        assert!(plan.storage_usages.contains(wgpu::TextureUsages::COPY_SRC));
        assert!(!plan
            .storage_usages
            .contains(wgpu::TextureUsages::TEXTURE_BINDING));
        assert!(plan
            .sampled_usages
            .contains(wgpu::TextureUsages::TEXTURE_BINDING));
        assert!(plan.sampled_usages.contains(wgpu::TextureUsages::COPY_DST));
    }

    #[test]
    fn storage_target_uses_compute_convert_when_copy_is_missing() {
        let plan = plan_vello_target(sample_features(
            wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
            TextureFormatFeatureFlags::STORAGE_WRITE_ONLY
                | TextureFormatFeatureFlags::STORAGE_READ_ONLY
                | TextureFormatFeatureFlags::FILTERABLE,
        ))
        .expect("plan");
        assert_eq!(plan.convert, ConvertMode::Compute);
        assert!(plan
            .sampled_usages
            .contains(wgpu::TextureUsages::STORAGE_BINDING));
        assert!(plan
            .sampled_usages
            .contains(wgpu::TextureUsages::TEXTURE_BINDING));
    }

    #[test]
    fn gpu_vello_opaque_rect_copies_to_sampled_or_skip() {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::VULKAN | wgpu::Backends::GL,
            flags: wgpu::InstanceFlags::from_build_config()
                | wgpu::InstanceFlags::ALLOW_UNDERLYING_NONCOMPLIANT_ADAPTER,
            memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
            backend_options: wgpu::BackendOptions::from_env_or_default(),
            display: None,
        });
        let mut adapters = pollster::block_on(instance.enumerate_adapters(wgpu::Backends::all()));
        adapters.sort_by_key(|adapter| {
            let info = adapter.get_info();
            adapter_sort_key(info.backend, info.device_type)
        });
        let Some(adapter) = adapters.into_iter().find(|adapter| {
            let info = adapter.get_info();
            !skip_emulator_vulkan(&info) && !matches!(info.device_type, wgpu::DeviceType::Cpu)
        }) else {
            eprintln!("SKIP: no wgpu adapter for GPU Vello rect copy");
            return;
        };
        let (device, queue) = match request_vello_device(&adapter) {
            Ok(pair) => pair,
            Err(err) => {
                eprintln!("SKIP: request_vello_device failed: {err}");
                return;
            }
        };
        let plan =
            plan_vello_target(adapter.get_texture_format_features(wgpu::TextureFormat::Rgba8Unorm))
                .expect("Rgba8Unorm Vello target plan");
        assert_eq!(plan.format, wgpu::TextureFormat::Rgba8Unorm);
        let width = 320;
        let height = 200;
        let storage = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("test-vello-storage"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: plan.format,
            usage: plan.storage_usages,
            view_formats: &[],
        });
        let sampled = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("test-vello-sampled"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: plan.format,
            usage: plan.sampled_usages | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let storage_view = storage.create_view(&wgpu::TextureViewDescriptor::default());
        let sampled_view = sampled.create_view(&wgpu::TextureViewDescriptor::default());
        let mut renderer =
            vello::Renderer::new(&device, vello_renderer_options(false)).expect("vello gpu");
        let scene = opaque_rect_scene(width, height);
        renderer
            .render_to_texture(
                &device,
                &queue,
                &scene,
                &storage_view,
                &vello::RenderParams {
                    base_color: Color::from_rgb8(0x15, 0x13, 0x11),
                    width,
                    height,
                    antialiasing_method: vello::AaConfig::Area,
                },
            )
            .expect("gpu render");
        let (convert_pipeline, convert_bgl) = if plan.convert == ConvertMode::Compute {
            let (pipeline, bgl) = create_storage_convert_pipeline(&device);
            (Some(pipeline), Some(bgl))
        } else {
            (None, None)
        };
        gpu_storage_to_sampled(
            &device,
            &queue,
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
                mode: plan.convert,
                pipeline: convert_pipeline.as_ref(),
                layout: convert_bgl.as_ref(),
            },
        );
        let padded = 256u64;
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("test-vello-peek"),
            size: padded,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("test-vello-peek"),
        });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &sampled,
                mip_level: 0,
                origin: wgpu::Origin3d {
                    x: width / 2,
                    y: height / 2,
                    z: 0,
                },
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
        queue.submit(Some(encoder.finish()));
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        let slice = buffer.slice(..4);
        let (sender, receiver) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = sender.send(result);
        });
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        receiver.recv().expect("map").expect("map ok");
        let data = slice.get_mapped_range();
        let px = [data[0], data[1], data[2], data[3]];
        assert!(
            px[3] > 0,
            "sampled GPU copy must have alpha, got {px:?} convert={:?}",
            plan.convert
        );
        assert_ne!(
            px,
            [0, 0, 0, 0],
            "GPU Vello opaque rect must not leave sampled output black"
        );
    }
}
