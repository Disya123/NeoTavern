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
