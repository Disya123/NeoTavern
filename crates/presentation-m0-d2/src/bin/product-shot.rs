//! Render the REAL product App Shell (Dioxus/Blitz from packed React CSS)
//! to a PNG through the NeoCompositor producer seam — the same code path the
//! Android `PresentationChatActivity` paints, run on the host GPU.
//!
//! This is not a blueprint simulation: `product_shell_app` is laid out and
//! styled by Blitz with the packed React CSS, painted through
//! `produce_product_gpu_app_scaled`, and rasterized by vello/wgpu (real
//! shader compilation on the local adapter). Live glass effect scopes are
//! intentionally absent from the product route until opaque screenshots
//! match React (see docs/architecture/presentation-boundary.md).
//!
//! Usage:
//!   cargo run --manifest-path crates/Cargo.toml -p neotavern-presentation-m0-d2 \
//!     --features gpu --bin product-shot -- --w 1280 --h 800 --out shot.png
//!
//! Flags: --w <px> --h <px> --scale <dpr> --out <png> [--panel <id>] [--dom-dump <json>]

use std::num::NonZeroUsize;

use neotavern_presentation_design_system::SafeAreaInsets;
use neotavern_presentation_dioxus_shell::{
    install_product_shell, product_shell_app, CharacterCardView, ProductShellView,
};
use neotavern_presentation_m0_d2::{inspect_slot_skeleton, produce_product_gpu_app_scaled, write_slot_skeleton};
use vello::peniko::color::palette;
use vello::wgpu::{
    CommandEncoderDescriptor, Extent3d, MapMode, TexelCopyBufferInfo, TexelCopyBufferLayout,
    TexelCopyTextureInfo, TextureAspect, TextureDescriptor, TextureDimension, TextureFormat,
    TextureUsages,
};
use vello::{AaConfig, AaSupport, RenderParams, Renderer, RendererOptions};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let get = |name: &str, default: &str| -> String {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
            .unwrap_or_else(|| default.to_string())
    };
    let width: u32 = get("--w", "1280").parse().expect("--w must be u32");
    let height: u32 = get("--h", "800").parse().expect("--h must be u32");
    let scale: f32 = get("--scale", "1").parse().expect("--scale must be f32");
    let out_path = get("--out", "product-shot.png");
    let panel = get("--panel", "characters");
    let dom_dump = args
        .iter()
        .position(|a| a == "--dom-dump")
        .and_then(|i| args.get(i + 1))
        .cloned();

    let view = build_view(&panel, width, height);
    install_product_shell(view);

    if let Some(path) = dom_dump.as_deref() {
        let skeleton = inspect_slot_skeleton(
            product_shell_app,
            width,
            height,
            scale,
            SafeAreaInsets::default(),
        )
        .expect("slot skeleton");
        let count = skeleton.nodes.len();
        write_slot_skeleton(path, &skeleton).expect("write dom-dump");
        println!("WROTE {path} ({count} slot nodes)");
    }

    let (producer, scene) = produce_product_gpu_app_scaled(
        product_shell_app,
        width,
        height,
        scale,
        SafeAreaInsets::default(),
    )
    .expect("product shell produce");

    eprintln!(
        "producer source={} glass_hooks={} effect_scopes={} raster_images={} nodes/stream={}",
        producer.report.source,
        producer.report.glass_hooks,
        producer.report.effect_scopes,
        producer.report.raster_images,
        producer.stream.len(),
    );

    let (data, stride) = rasterize(&scene, width, height).unwrap_or_else(|err| {
        eprintln!("GPU raster failed: {err}");
        std::process::exit(2);
    });

    let parent = std::path::Path::new(&out_path)
        .parent()
        .unwrap_or(std::path::Path::new("."));
    std::fs::create_dir_all(parent).ok();
    image::save_buffer(&out_path, &data, width, height, image::ColorType::Rgba8).expect("save PNG");
    println!("WROTE {out_path} ({width}×{height} @{scale}, {stride} bytes/row, vello/wgpu)");
}

fn build_view(panel: &str, width: u32, height: u32) -> ProductShellView {
    let mut view = ProductShellView::default();
    view.panel = panel.to_string();
    view.chat.viewport_width = width;
    view.chat.viewport_height = height;
    view.chat.character_name = "Hazel".into();
    view.chat.composer_placeholder = "Message Hazel…".into();
    view.chat.title = "Live wire chat".into();
    view.characters = vec![
        CharacterCardView {
            id: "11111111-1111-4111-8111-111111111111".into(),
            name: "Hazel".into(),
            description: "No character description yet.".into(),
            tags: vec!["wry".into(), "kestrel".into()],
            avatar_asset_id: None,
            avatar_data_uri: None,
        },
        CharacterCardView {
            id: "22222222-2222-4222-8222-222222222222".into(),
            name: "Vesper".into(),
            description: "A quiet archivist with a sharp memory.".into(),
            tags: vec!["archivist".into()],
            avatar_asset_id: None,
            avatar_data_uri: None,
        },
    ];
    view.selected_character_id = Some("11111111-1111-4111-8111-111111111111".into());
    view
}

fn rasterize(scene: &vello::Scene, width: u32, height: u32) -> Result<(Vec<u8>, u32), String> {
    let instance = vello::wgpu::Instance::new(vello::wgpu::InstanceDescriptor {
        backends: vello::wgpu::Backends::all(),
        flags: vello::wgpu::InstanceFlags::default(),
        memory_budget_thresholds: vello::wgpu::MemoryBudgetThresholds::default(),
        backend_options: vello::wgpu::BackendOptions::default(),
        display: None,
    });
    let adapter = pollster::block_on(instance.request_adapter(
        &vello::wgpu::RequestAdapterOptions {
            power_preference: vello::wgpu::PowerPreference::HighPerformance,
            compatible_surface: None,
            force_fallback_adapter: false,
        },
    ))
    .map_err(|e| format!("adapter request: {e}"))?;
    let (device, queue) =
        pollster::block_on(adapter.request_device(&vello::wgpu::DeviceDescriptor {
            label: Some("product-shot"),
            required_features: vello::wgpu::Features::empty(),
            required_limits: vello::wgpu::Limits::default(),
            ..Default::default()
        }))
        .map_err(|e| format!("device: {e}"))?;

    let mut renderer = Renderer::new(
        &device,
        RendererOptions {
            use_cpu: false,
            antialiasing_support: AaSupport::area_only(),
            num_init_threads: NonZeroUsize::new(1),
            ..Default::default()
        },
    )
    .map_err(|e| format!("vello renderer: {e}"))?;

    let target = device.create_texture(&TextureDescriptor {
        label: Some("product-shot-target"),
        size: Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: TextureDimension::D2,
        format: TextureFormat::Rgba8Unorm,
        usage: TextureUsages::STORAGE_BINDING | TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = target.create_view(&Default::default());
    renderer
        .render_to_texture(
            &device,
            &queue,
            scene,
            &view,
            &RenderParams {
                base_color: palette::css::TRANSPARENT,
                width,
                height,
                antialiasing_method: AaConfig::Area,
            },
        )
        .map_err(|e| format!("render_to_texture: {e}"))?;
    let _ = device.poll(vello::wgpu::PollType::wait_indefinitely());

    let bytes_per_row = (width * 4).div_ceil(256) * 256;
    let buf_size = (bytes_per_row * height) as usize;
    let staging = device.create_buffer(&vello::wgpu::BufferDescriptor {
        label: Some("product-shot-staging"),
        size: buf_size as u64,
        usage: vello::wgpu::BufferUsages::MAP_READ | vello::wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&CommandEncoderDescriptor {
        label: Some("product-shot-copy"),
    });
    encoder.copy_texture_to_buffer(
        TexelCopyTextureInfo {
            texture: &target,
            mip_level: 0,
            origin: vello::wgpu::Origin3d::ZERO,
            aspect: TextureAspect::All,
        },
        TexelCopyBufferInfo {
            buffer: &staging,
            layout: TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(bytes_per_row),
                rows_per_image: Some(height),
            },
        },
        Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
    );
    queue.submit([encoder.finish()]);
    let slice = staging.slice(..);
    slice.map_async(MapMode::Read, |r| r.expect("map"));
    let _ = device.poll(vello::wgpu::PollType::wait_indefinitely());

    let data = slice.get_mapped_range();
    let row_bytes = (width * 4) as usize;
    let mut pixels = Vec::with_capacity(row_bytes * height as usize);
    for row in 0..height as usize {
        let start = row * bytes_per_row as usize;
        pixels.extend_from_slice(&data[start..start + row_bytes]);
    }
    drop(data);
    staging.unmap();
    Ok((pixels, bytes_per_row))
}
