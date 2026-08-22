//! Headless GPU raster of the Character Manager through vello/wgpu.
//!
//! Same pipeline as Android: `UiSceneV1` → `vello::Scene` → `vello::Renderer::render_to_texture`
//! → `wgpu` texture → readback → PNG. No HTML, no SVG, no React.

use std::num::NonZeroUsize;

use vello::peniko::color::palette;
use vello::{AaConfig, AaSupport, RenderParams, Renderer, RendererOptions, Scene};
use vello::wgpu::{self, Extent3d, TextureDescriptor, TextureDimension, TextureFormat, TextureUsages, TexelCopyBufferLayout, TexelCopyTextureInfo, TextureAspect, MapMode, CommandEncoderDescriptor};
use neotavern_presentation_blueprint::v1::CaptureBundleV1;
use neotavern_presentation_blueprint::{materialize_character_manager_scene_v1_from_document, UiBlueprintDocumentV1, ViewportClassV1};

const STATE_FIXTURE: &str =
    include_str!("../../../../packages/contracts/src/presentation/fixtures/character-manager-v1.json");
const DOCUMENT_FIXTURE: &str = include_str!(
    "../../../../packages/contracts/src/presentation/fixtures/ui-blueprint-document-v1.json"
);

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let viewport = args.iter().find(|a| a.starts_with("--viewport="))
        .and_then(|a| a.split('=').nth(1))
        .unwrap_or("compact");
    let out_path = args.iter().find(|a| a.starts_with("--out="))
        .and_then(|a| a.split('=').nth(1))
        .map(String::from)
        .unwrap_or_else(|| "apps/web/public/rust-raster.png".to_string());

    let vp = match viewport {
        "compact" => ViewportClassV1::Compact,
        "medium" => ViewportClassV1::Medium,
        "expanded" => ViewportClassV1::Expanded,
        other => { eprintln!("unknown viewport: {other}"); std::process::exit(1); }
    };

    let (width, height): (u32, u32) = match vp {
        ViewportClassV1::Compact => (360, 800),
        ViewportClassV1::Medium => (720, 800),
        ViewportClassV1::Expanded => (1280, 800),
    };

    // Build scene from fixtures
    let document: UiBlueprintDocumentV1 = serde_json::from_str(DOCUMENT_FIXTURE).expect("document");
    let bundle: CaptureBundleV1 = serde_json::from_str(STATE_FIXTURE).expect("state");
    let scene = materialize_character_manager_scene_v1_from_document(&document, &bundle, vp)
        .expect("scene materialize");

    eprintln!("Scene built: revision={}, paint={}, hit={}", scene.revision, scene.paint_tree.len(), scene.hit_test_tree.len());

    // Build vello scene from UiSceneV1
    let vello_scene = neotavern_presentation_m0::scene_character_manager::build_cm_vello_scene(
        &scene, width as f64, height as f64,
    );

    // GPU init
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::all(),
        flags: wgpu::InstanceFlags::default(),
        memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
        backend_options: wgpu::BackendOptions::default(),
        display: None,
    });
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        compatible_surface: None,
        force_fallback_adapter: false,
    })).expect("no wgpu adapter");
    let (device, queue) = pollster::block_on(adapter.request_device(
        &wgpu::DeviceDescriptor {
            label: Some("cm-raster"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::default(),
            ..Default::default()
        },
    )).expect("no wgpu device");

    let mut renderer = Renderer::new(
        &device,
        RendererOptions {
            use_cpu: false,
            antialiasing_support: AaSupport::area_only(),
            num_init_threads: NonZeroUsize::new(1),
            ..Default::default()
        },
    ).expect("vello renderer");

    // Target texture
    let target = device.create_texture(&TextureDescriptor {
        label: Some("cm-raster-target"),
        size: Extent3d { width, height, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: TextureDimension::D2,
        format: TextureFormat::Rgba8Unorm,
        usage: TextureUsages::STORAGE_BINDING | TextureUsages::COPY_SRC,
        view_formats: &[],
    });

    // Render
    let view = target.create_view(&Default::default());
    renderer.render_to_texture(
        &device, &queue, &vello_scene, &view,
        &RenderParams {
            base_color: palette::css::TRANSPARENT,
            width,
            height,
            antialiasing_method: AaConfig::Area,
        },
    ).expect("vello render_to_texture");
    let _ = device.poll(wgpu::PollType::wait_indefinitely());

    // Readback — bytes_per_row must be aligned to COPY_BYTES_PER_ROW_ALIGNMENT (256)
    let bytes_per_row = (width * 4).div_ceil(256) * 256;
    let buf_size = (bytes_per_row * height) as usize;
    let staging = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("cm-raster-staging"),
        size: buf_size as u64,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&CommandEncoderDescriptor { label: Some("cm-raster-copy") });
    encoder.copy_texture_to_buffer(
        TexelCopyTextureInfo { texture: &target, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: TextureAspect::All },
        wgpu::TexelCopyBufferInfo { buffer: &staging, layout: TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(bytes_per_row), rows_per_image: Some(height) } },
        Extent3d { width, height, depth_or_array_layers: 1 },
    );
    queue.submit([encoder.finish()]);

    let slice = staging.slice(..);
    slice.map_async(MapMode::Read, |r| r.expect("map"));
    let _ = device.poll(wgpu::PollType::wait_indefinitely());

    let data = slice.get_mapped_range();
    // Strip row padding: copy only the valid width*4 bytes per row
    let row_bytes = (width * 4) as usize;
    let mut pixels = Vec::with_capacity(row_bytes * height as usize);
    for row in 0..height as usize {
        let start = row * bytes_per_row as usize;
        pixels.extend_from_slice(&data[start..start + row_bytes]);
    }
    drop(data);
    staging.unmap();

    // Save PNG
    let parent = std::path::Path::new(&out_path).parent().unwrap();
    std::fs::create_dir_all(parent).ok();
    image::save_buffer(&out_path, &pixels, width, height, image::ColorType::Rgba8)
        .expect("save PNG");
    println!("WROTE {out_path} ({width}×{height}, {buf_size} bytes, vello/wgpu GPU raster)");
}
