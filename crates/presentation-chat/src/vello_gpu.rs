//! GPU Vello bind shared with the Android SurfaceView host.
//!
//! Matches the M0-D1a / M0-D2 device request (`Limits::default()` first,
//! `CLEAR_TEXTURE` / `PIPELINE_CACHE` when the adapter has them, `use_cpu:
//! false`). CPU Vello is only [`software_raster_debug_enabled`].

use std::num::NonZeroUsize;
use std::sync::Mutex;

use crate::blit_wgsl::BLIT_WGSL;
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

/// Convert a wallpaper dest rect from physical px `(x, y, w, h)` into the
/// shader's uv-space `(x0, y0, x1, y1)` row. A degenerate rect collapses to
/// zeros (the enable flag is decided by the caller).
pub fn wallpaper_rect_uv(rect_px: [f32; 4], width: f32, height: f32) -> [f32; 4] {
    let (width, height) = (width.max(1.0), height.max(1.0));
    let [x, y, w, h] = rect_px;
    [x / width, y / height, (x + w) / width, (y + h) / height]
}

pub fn format_is_srgb(format: wgpu::TextureFormat) -> bool {
    matches!(
        format,
        wgpu::TextureFormat::Rgba8UnormSrgb | wgpu::TextureFormat::Bgra8UnormSrgb
    )
}

/// The NeoCompositor scroll blend window passed to [`PresentSurface::present`]:
/// a 2D rect of the swapchain that samples `resolve` shifted down by
/// `scroll_y` physical px, with everything outside the rect passed through.
/// The rect spans `[header, composer_top)` vertically (the chat column between
/// its fixed header and composer) and `[band_left, band_right)` horizontally
/// (excluding the rail + sidebar panel on split layouts). All values in
/// physical px; `BlitWindow::default()` (all zeros) disables the shift and
/// blits the full frame unchanged — the pre-scroll-window behavior.
///
/// `src_top`/`src_bottom` bound the rows the drift may sample, in ABSOLUTE
/// raster px (the rasters carry overscan strips above/below the panel): the
/// baked chat-row canvas. Below the band the raster contains the COMPOSER
/// (part of the same doc scene), so an unclamped shifted sample paints a
/// ghost composer into the band — the src window must always be the canvas
/// extents, and rows past them fall to the wallpaper/filler branch like the
/// old 96 px cap behavior. `(0, 0)` keeps the legacy full-raster window.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BlitWindow {
    pub scroll_y: f32,
    pub header: f32,
    pub composer_top: f32,
    pub band_left: f32,
    pub band_right: f32,
    pub src_top: f32,
    pub src_bottom: f32,
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
    /// Allocated size of `targets` (scene/resolve rasters). Tracked
    /// separately from `config` so the cheap per-event swapchain
    /// re-configure ([`Self::set_swapchain_size`]) does not make
    /// [`Self::resize`] skip the produce-time target re-allocation.
    targets_size: (u32, u32),
    /// Overscan strip above (and below) the panel baked into the rasters,
    /// physical px (144fps scroll runway; see `CHAT_OVERSCAN_CSS`). The
    /// rasters are taller than the swapchain by `2x` this; the blit maps the
    /// screen into the middle window.
    overscan_phys: u32,
    pipeline: wgpu::RenderPipeline,
    bind_layout: wgpu::BindGroupLayout,
    bind: wgpu::BindGroup,
    sampler: wgpu::Sampler,
    uniform: wgpu::Buffer,
    /// Wallpaper underlay texture for the blit shader (bindings 3/4). A 1×1
    /// transparent dummy until [`Self::upload_wallpaper`] runs; the dummy
    /// keeps the bind group complete on hosts that never enable a wallpaper.
    wall_texture: wgpu::Texture,
    wall_view: wgpu::TextureView,
    wall_key: Option<u64>,
    wall_rect_px: Option<[f32; 4]>,
    wall_overlay_alpha: f32,
    renderer: vello::Renderer,
    convert_pipeline: Option<wgpu::ComputePipeline>,
    convert_bgl: Option<wgpu::BindGroupLayout>,
    avatars: crate::avatar_gpu::AvatarGpu,
    /// Swapchain texture checked out by [`Self::acquire`] and presented by
    /// [`Self::blit`]. Splitting the present lets the host sample
    /// time-dependent state (the scroll animation) BETWEEN the two: with the
    /// FIFO swapchain `acquire` returns on a v-sync boundary, so a sample
    /// taken right after it leads scanout by exactly one refresh — a wake
    /// timer's arbitrary offset into the refresh interval cannot reach the
    /// displayed motion.
    frame: Option<wgpu::SurfaceTexture>,
    /// How long the last [`Self::acquire`] blocked on the FIFO swapchain
    /// (`NEOTA_FRAME_TIMING` diagnostics).
    acquire_wait: std::time::Duration,
    /// When the last [`Self::acquire`] returned, plus the EMA of consecutive
    /// return gaps. On a visible window the FIFO acquire returns on a
    /// v-sync boundary, so `last + interval` predicts the scanout instant of
    /// the frame being composed — the animation sample clock.
    acquire_return: Option<std::time::Instant>,
    acquire_interval: Option<std::time::Duration>,
    /// Frame-corruption diagnostics (`NEOTA_FRAME_DUMPS=<n>`): every n-th
    /// blit writes BOTH what it sampled (resolve) and what reached the
    /// swapchain into `dump_dir` — a broken resolve indicts the DOM/scene,
    /// a clean resolve with a broken swapchain indicts the blit/present.
    dump_every: u32,
    dump_count: u32,
    dump_dir: String,
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
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 4,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
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
                    // Resolve holds premultiplied alpha: the neutralizer root
                    // is transparent so translucent scene areas (glass panels,
                    // wallpaper cutouts) keep honest alpha here. The blit must
                    // composite over the cleared canvas color instead of
                    // replacing pixels, or transparent regions go black.
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
        let uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("neocompositor-scroll"),
            size: 80,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let wall_texture = Self::alloc_dummy_wallpaper(&device, &queue);
        let wall_view = wall_texture.create_view(&wgpu::TextureViewDescriptor::default());
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
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(&wall_view),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: wgpu::BindingResource::Sampler(&sampler),
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
            targets_size: (width.max(1), height.max(1)),
            overscan_phys: 0,
            pipeline,
            bind_layout,
            bind,
            sampler,
            uniform,
            wall_texture,
            wall_view,
            wall_key: None,
            wall_rect_px: None,
            wall_overlay_alpha: 0.0,
            renderer,
            convert_pipeline,
            convert_bgl,
            avatars,
            frame: None,
            acquire_wait: std::time::Duration::ZERO,
            acquire_return: None,
            acquire_interval: None,
            dump_every: 0,
            dump_count: 0,
            dump_dir: String::new(),
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

    /// Upload the wallpaper photo raster for the blit-shader underlay (image
    /// audit, stage C). `key` is a caller-owned content token: a call with the
    /// same key as the current texture is a no-op, so per-produce calls stay
    /// cheap while a wallpaper change re-uploads. The texture must be paired
    /// with [`Self::set_wallpaper_rect`] to become visible.
    pub fn upload_wallpaper(&mut self, key: u64, thumb: &crate::avatar::AvatarThumb) -> bool {
        if self.wall_key == Some(key) {
            return false;
        }
        if thumb.width == 0 || thumb.height == 0 {
            return false;
        }
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("neocompositor-wallpaper"),
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
        self.queue.write_texture(
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
        self.wall_view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        self.wall_texture = texture;
        self.wall_key = Some(key);
        self.rebuild_bind();
        true
    }

    /// Place the wallpaper underlay: `rect_px` is `(x, y, w, h)` in physical
    /// px — the layout rect of the `part:chat-wallpaper` node (workspace +
    /// bleed), not the full window. `None` disables the underlay (the dummy
    /// transparent texture stays bound). The rect is re-applied on every
    /// produce; a resize self-corrects on the next produce.
    pub fn set_wallpaper_rect(&mut self, rect_px: Option<[f32; 4]>) {
        self.wall_rect_px = rect_px.filter(|[_, _, w, h]| *w > 0.0 && *h > 0.0);
    }

    /// Fixed dim over the wallpaper underlay (`scroll[3].y`): the React
    /// wallpaper gradient parity. While this is > 0 the scene's
    /// `chat-wallpaper-overlay` div must paint transparent, or the dim is
    /// applied twice (once fixed by the shader, once scrolling with the band).
    pub fn set_wallpaper_overlay_alpha(&mut self, alpha: f32) {
        self.wall_overlay_alpha = alpha.clamp(0.0, 1.0);
    }

    fn alloc_dummy_wallpaper(device: &wgpu::Device, queue: &wgpu::Queue) -> wgpu::Texture {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("neocompositor-wallpaper-dummy"),
            size: wgpu::Extent3d {
                width: 1,
                height: 1,
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
            &[0u8; 4],
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(4),
                rows_per_image: Some(1),
            },
            wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
        );
        texture
    }

    pub fn size(&self) -> (u32, u32) {
        (self.config.width, self.config.height)
    }

    /// Diagnostic read-back of the accumulated `resolve` texture. Hidden
    /// behind an env gate in the host; never on a hot path.
    #[doc(hidden)]
    pub fn debug_peek_resolve(&self, x: u32, y: u32) -> [u8; 4] {
        // `y` is a panel pixel; the resolve carries the overscan strips, so
        // peek the shifted raster pixel.
        peek_texture_rgba(
            &self.device,
            &self.queue,
            &self.targets.resolve,
            x,
            y + self.overscan_phys,
        )
    }

    /// Vello-rasterize `scene` into the storage target then move it into the
    /// sampled accumulation `resolve` (the same GPU→GPU path as the Android
    /// host, without avatars).
    pub fn render(
        &mut self,
        scene: &vello::Scene,
        base_color: vello::peniko::Color,
    ) -> Result<(), String> {
        let (width, height) = (self.targets_size.0, self.targets_size.1);
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

    /// Phase 1 of a frame: acquire the swapchain texture. With the FIFO
    /// swapchain this blocks until the compositor releases a buffer — a
    /// v-sync boundary — which makes it the frame pacer. Hosts run their
    /// time-dependent sampling between `acquire` and [`Self::blit`].
    pub fn acquire(&mut self) -> Result<(), String> {
        let started = std::time::Instant::now();
        let mut outcome = self.surface.get_current_texture();
        if matches!(outcome, wgpu::CurrentSurfaceTexture::Outdated) {
            // Heal a stale swapchain with the CURRENT config — the one the
            // rasters still match. Adopting a newer window size here would
            // desynchronize the blit's doc-window mapping from the resolve
            // until the next produce re-allocates; until then DWM stretches
            // the last consistent frame instead.
            self.surface.configure(&self.device, &self.config);
            outcome = self.surface.get_current_texture();
        }
        self.acquire_wait = started.elapsed();
        let returned = std::time::Instant::now();
        if let Some(last) = self.acquire_return {
            let gap = returned.duration_since(last);
            // Idle gaps (no animation running) and occluded-window free runs
            // must not define the refresh interval; the clamp bounds a
            // pathological driver anyway.
            if gap <= std::time::Duration::from_millis(100) {
                self.acquire_interval = Some(
                    match self.acquire_interval {
                        Some(cur) => cur.mul_f64(0.75) + gap.mul_f64(0.25),
                        None => gap,
                    }
                    .clamp(
                        std::time::Duration::from_micros(500),
                        std::time::Duration::from_millis(50),
                    ),
                );
            }
        }
        self.acquire_return = Some(returned);
        self.frame = Some(match outcome {
            wgpu::CurrentSurfaceTexture::Success(frame)
            | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
            wgpu::CurrentSurfaceTexture::Timeout => return Err("acquire_timeout".into()),
            wgpu::CurrentSurfaceTexture::Occluded => return Err("acquire_occluded".into()),
            wgpu::CurrentSurfaceTexture::Outdated => return Err("acquire_outdated".into()),
            wgpu::CurrentSurfaceTexture::Lost => return Err("acquire_lost".into()),
            wgpu::CurrentSurfaceTexture::Validation => return Err("acquire_validation".into()),
        });
        Ok(())
    }

    /// Phase 2 of a frame: draw `resolve` into the texture acquired by
    /// [`Self::acquire`] and present it (mirror of the Android host's
    /// `blit`). The window is the NeoCompositor scroll blend window;
    /// `BlitWindow::default()` is a plain full-frame blit.
    pub fn blit(&mut self, window: BlitWindow) -> Result<(), String> {
        self.blit_opt(window, None)
    }

    /// `blit` plus a one-shot swapchain read-back diagnostic (what the user
    /// actually sees). `swap_save` copies the backbuffer right after the blit,
    /// before `frame.present()`.
    pub fn blit_and_dump(&mut self, window: BlitWindow, swap_save: &str) -> Result<(), String> {
        self.blit_opt(window, Some(swap_save))
    }

    /// How long the last [`Self::acquire`] blocked on the FIFO swapchain
    /// (frame pacing diagnostics).
    pub fn last_acquire_wait(&self) -> std::time::Duration {
        self.acquire_wait
    }

    /// Predicted scanout instant of the frame being composed, as ns since
    /// `base`. On a visible window the FIFO acquire returns right after a
    /// v-sync boundary (a buffer just came back from scanout), and the frame
    /// acquired now presents at the NEXT boundary — `last return + interval`.
    /// Sampling the scroll animation at this instant makes consecutive
    /// displayed positions exactly one refresh apart, regardless of when the
    /// wake timer happened to fire. `None` (no phase yet, or a stale one —
    /// the window idled or is occluded and the FIFO free-runs) lets the
    /// caller fall back to wall time.
    pub fn predicted_display_ns(&self, base: std::time::Instant) -> Option<u64> {
        let last = self.acquire_return?;
        let interval = self.acquire_interval?;
        let predicted = last + interval;
        if predicted <= std::time::Instant::now() {
            return None;
        }
        Some(predicted.duration_since(base).as_nanos() as u64)
    }

    fn blit_opt(&mut self, window: BlitWindow, swap_save: Option<&str>) -> Result<(), String> {
        let frame = self
            .frame
            .take()
            .ok_or_else(|| "blit without acquire".to_string())?;
        let height = self.config.height.max(1) as f32;
        let width = self.config.width.max(1) as f32;
        // Raster-window mapping: the rasters are taller than the swapchain
        // by the overscan strips, so the shader scales screen uv into the
        // middle window (top offset + scale) and the blit shift normalizes
        // against the raster height (the shift happens in raster space).
        let raster_h = self.raster_height().max(1) as f32;
        let mut uniform = [0u8; 80];
        uniform[0..4].copy_from_slice(&(window.scroll_y / raster_h).to_le_bytes());
        uniform[4..8].copy_from_slice(&(window.header / height).to_le_bytes());
        uniform[8..12].copy_from_slice(&(window.composer_top / height).to_le_bytes());
        let srgb = if self.srgb_target { 1.0f32 } else { 0.0 };
        uniform[12..16].copy_from_slice(&srgb.to_le_bytes());
        uniform[16..20].copy_from_slice(&(window.band_left / width).to_le_bytes());
        uniform[20..24].copy_from_slice(&(window.band_right / width).to_le_bytes());
        // uniform[24..32] stay zero (reserved for the next window parameter).
        // Rows 2/3: wallpaper underlay dest rect in uv + enable flag; zeros
        // keep the shader at the pre-wallpaper blit when no wallpaper is set.
        let (rect_uv, enabled) = match self.wall_rect_px {
            Some(rect) => (
                wallpaper_rect_uv(rect, width, height),
                if self.wall_key.is_some() { 1.0f32 } else { 0.0 },
            ),
            None => ([0.0f32; 4], 0.0),
        };
        uniform[32..36].copy_from_slice(&rect_uv[0].to_le_bytes());
        uniform[36..40].copy_from_slice(&rect_uv[1].to_le_bytes());
        uniform[40..44].copy_from_slice(&rect_uv[2].to_le_bytes());
        uniform[44..48].copy_from_slice(&rect_uv[3].to_le_bytes());
        uniform[48..52].copy_from_slice(&enabled.to_le_bytes());
        uniform[52..56].copy_from_slice(&self.wall_overlay_alpha.to_le_bytes());
        // uniform[56..64]: scroll[3].zw — the raster doc window the screen
        // maps into (top offset + scale).
        //
        // uniform[64..72]: scroll[4].xy — the source window the drift may
        // sample: the baked chat-row canvas. It is NOT the full raster —
        // below the band the doc scene painted the COMPOSER, and an
        // unclamped sample would smear a ghost composer into the band while
        // the drift is live (the desktop "second composer" artifact).
        let (src_top_uv, src_bottom_uv) = if window.src_bottom > window.src_top {
            let overscan = self.overscan_phys as f32;
            (
                (overscan + window.src_top.max(0.0)) / raster_h,
                (overscan + window.src_bottom.min(raster_h as f32 - overscan)) / raster_h,
            )
        } else {
            (0.0f32, 1.0f32)
        };
        uniform[56..60].copy_from_slice(&(self.overscan_phys as f32 / raster_h).to_le_bytes());
        uniform[60..64].copy_from_slice(&(height / raster_h).to_le_bytes());
        uniform[64..68].copy_from_slice(&src_top_uv.to_le_bytes());
        uniform[68..72].copy_from_slice(&src_bottom_uv.to_le_bytes());
        self.queue.write_buffer(&self.uniform, 0, &uniform);
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
        if self.dump_every > 0 {
            self.dump_count += 1;
            if self.dump_count % self.dump_every == 0 {
                let n = self.dump_count;
                let _ = self.snapshot(&format!("{}/resolve_{n:05}.png", self.dump_dir));
                let _ =
                    self.swapchain_snapshot(&format!("{}/swap_{n:05}.png", self.dump_dir), &frame);
            }
        }
        frame.present();
        Ok(())
    }

    /// Frame-corruption diagnostics: every `every`-th blit writes the sampled
    /// resolve and the presented swapchain frame into `dir` (see the
    /// `dump_every` field docs).
    pub fn set_frame_dumps(&mut self, every: u32, dir: String) {
        self.dump_every = every;
        self.dump_dir = dir;
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
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(&self.wall_view),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
            ],
        });
    }

    /// Re-configure the swapchain for a new window size WITHOUT touching the
    /// scene targets. The per-event resize path in the host calls this so a
    /// drag does not re-allocate fullscreen rasters per `Resized` event; the
    /// blit keeps sampling the old `resolve` and stretches it into the new
    /// swapchain until the next produce re-renders at the settled size
    /// ([`Self::resize`]).
    pub fn set_swapchain_size(&mut self, width: u32, height: u32) {
        let width = width.max(1);
        let height = height.max(1);
        if width == self.config.width && height == self.config.height {
            return;
        }
        self.config.width = width;
        self.config.height = height;
        self.surface.configure(&self.device, &self.config);
    }

    /// Re-create targets and re-configure the swapchain at a new size. The
    /// host calls this from the produce path (once per settled size), never
    /// per `Resized` event.
    ///
    /// `overscan_phys` extends the scene/resolve rasters above and below the
    /// panel by that strip (physical px, 144fps scroll runway): the doc
    /// scene paints into the middle window, and the blit samples it while
    /// the drift stays inside the baked extents.
    pub fn resize(&mut self, width: u32, height: u32, overscan_phys: u32) {
        let width = width.max(1);
        let height = height.max(1);
        let overscan_phys = overscan_phys.min(height / 2);
        let raster_height = height + 2 * overscan_phys;
        let targets_changed =
            (width, raster_height) != self.targets_size || self.overscan_phys != overscan_phys;
        self.overscan_phys = overscan_phys;
        self.set_swapchain_size(width, height);
        if !targets_changed {
            return;
        }
        self.targets_size = (width, raster_height);
        self.targets = PresentTargets::alloc(&self.device, &self.plan, width, raster_height);
        self.rebuild_bind();
        clear_view_color(
            &self.device,
            &self.queue,
            &self.targets.resolve_view,
            canvas_clear_color(),
        );
    }

    /// Overscan strip baked into the rasters (physical px, above AND below
    /// the panel).
    pub fn overscan_phys(&self) -> u32 {
        self.overscan_phys
    }

    /// Full raster height in physical px (swapchain + both overscan strips).
    pub fn raster_height(&self) -> u32 {
        self.config.height + 2 * self.overscan_phys
    }

    /// Headless diagnostic: read back the accumulated `resolve` (before the
    /// swapchain blit) and save it as a PNG — exactly what the blit samples.
    pub fn snapshot(&self, path: &str) -> Result<(), String> {
        let width = self.config.width.max(1);
        let height = self.config.height.max(1);
        // The resolve is taller than the swapchain (overscan strips): the
        // snapshot must cover exactly what the blit maps the screen to, so
        // read the middle panel window.
        let origin_y = self.overscan_phys;
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
                origin: wgpu::Origin3d {
                    x: 0,
                    y: origin_y,
                    z: 0,
                },
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
    fn wallpaper_rect_maps_physical_px_into_uv() {
        let uv = wallpaper_rect_uv([428.0, -12.0, 684.0, 784.0], 1100.0, 760.0);
        assert!((uv[0] - 428.0 / 1100.0).abs() < 1e-6);
        assert!((uv[1] - (-12.0 / 760.0)).abs() < 1e-6);
        assert!((uv[2] - 1112.0 / 1100.0).abs() < 1e-6);
        assert!((uv[3] - 772.0 / 760.0).abs() < 1e-6);
        // Degenerate sizes clamp instead of dividing by zero.
        let degenerate = wallpaper_rect_uv([0.0, 0.0, 0.0, 0.0], 0.0, 0.0);
        assert_eq!(degenerate, [0.0, 0.0, 0.0, 0.0]);
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

    #[test]
    fn gpu_vello_image_brush_rasterizes_on_the_sampled_target() {
        // Stage B repro for the Vello 0.9-era "Image brush blacks the whole
        // surface" regression: a scene with one Image-brush fill must write
        // that image's pixels into the sampled target, not wipe it.
        use vello::peniko::ImageData as PenikoImage;
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
            eprintln!("SKIP: no wgpu adapter for GPU Vello image brush repro");
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
        let width = 320u32;
        let height = 200u32;
        let storage = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("test-vello-image-storage"),
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
            label: Some("test-vello-image-sampled"),
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
        // A 4x1 opaque magenta strip scaled over the whole target.
        let pixels: Vec<u8> = [255u8, 0, 255, 255].repeat(4);
        let image = PenikoImage {
            data: pixels.into(),
            format: vello::peniko::ImageFormat::Rgba8,
            alpha_type: vello::peniko::ImageAlphaType::Alpha,
            width: 4,
            height: 1,
        };
        let brush = vello::peniko::ImageBrush::from(image);
        let mut scene = vello::Scene::new();
        scene.fill(
            vello::peniko::Fill::NonZero,
            // 4×1 strip scaled non-uniformly to the full 320×200 target.
            vello::kurbo::Affine::new([80.0, 0.0, 0.0, 200.0, 0.0, 0.0]),
            &brush,
            None,
            &vello::kurbo::Rect::new(0.0, 0.0, 4.0, 1.0),
        );
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
            .expect("gpu render with image brush");
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
        let center = peek_texture_rgba(&device, &queue, &sampled, width / 2, height / 2);
        assert!(
            center[3] > 0,
            "image brush must not leave the sampled output empty, got {center:?}"
        );
        assert!(
            center[0] > 128 && center[2] > 128 && center[1] < 128,
            "center pixel must be the magenta image fill, got {center:?}"
        );
    }
}
