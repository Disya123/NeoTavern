//! ADR-0057 Phase 1 desktop bridge for the chat pilot — a dev evidence
//! host, not the shipped desktop UI.
//!
//! Scope contract (platform spec §10, ADR-0057 Phase 1):
//! - Product truth stays in [`ChatSession`] + the wire (INV-1); this host
//!   owns no product state — only window/GPU plumbing and the
//!   editor-core event mapping (INV-4).
//! - Geometry: the host reads ONLY the [`FrameSnapshot`] (hit-tests,
//!   click→caret resolution); it never recomputes positions (INV-2).
//! - Paint: one vello render of the snapshot into an `Rgba8Unorm` raster,
//!   then a minimal wgpu blit onto the swapchain. This is deliberately
//!   NOT the legacy `PresentSurface`: that pipeline carries the m7
//!   chrome/wallpaper/overscan contracts of the frozen contour; the pilot
//!   owns a ~200-line present instead (INV-3 — one render path per
//!   surface, no shared host assumptions).
//! - Wire honesty (INV-7): the FakeWire window is title-tagged
//!   `— FAKE WIRE (dev)`; `--root` runs the real Kernel in a SQLite data
//!   root.
//! - [`render_pngs`] is local-only evidence: PNG rasters for developer
//!   review, never a CI gate.
//!
//! Known limits of the Phase-1 bridge (honest scope, not stubs):
//! - The wheel is not mapped: the pilot's message column is not
//!   scrollable yet, and no parallel geometry may exist to fake it
//!   (INV-2).
//! - Only `Ctrl+A` of the clipboard-family shortcuts is mapped (the
//!   editor core implements `SelectAll`); paste/cut need an arboard seam
//!   alongside the Phase-3 IME composition seam.
//! - DPI > 1: the vello raster is produced in CSS px and stretched by
//!   the linear blit — fractional-DPI crispness waits for the layout
//!   pass carrying physical scale.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use neotavern_presentation_chat::{ChatSession, FakeWire, ProductWire};
use neotavern_presentation_kernel_wire::KernelProductWire;
use neotavern_presentation_scene::snapshot::FrameSnapshot;
use neotavern_presentation_scene::CursorOp;

use winit::application::ApplicationHandler;
use winit::event::{ElementState, KeyEvent, Modifiers, MouseButton, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow};
use winit::keyboard::{Key, NamedKey};
use winit::window::{Window, WindowAttributes};

use crate::ChatPilot;

/// UI-update cadence while a generation stream is live (AGENTS §24: no
/// more than 30 UI updates per second for streaming responses). The
/// session's `poll_stream` is pumped at this cadence from
/// `about_to_wait` until the terminal event clears the handle.
const STREAM_FRAME_MIN_INTERVAL: Duration = Duration::from_millis(33);

/// Golden corpus sizes for the local raster harness — the four layout
/// regimes of the pilot surface (desktop wide, laptop, narrow/tall,
/// composer band). The same corpus as the m0-d2 `chat-golden` rasters so
/// both surfaces stay comparable through the ADR-0057 transition.
pub const GOLDEN_SIZES: [(u32, u32); 4] = [(1100, 760), (900, 700), (620, 800), (900, 220)];

/// How the bridge picks its wire.
pub enum WireSource {
    /// In-memory deterministic demo wire (INV-7: labeled fake).
    Fake { messages: u32 },
    /// Real Rust Kernel over a SQLite data root (created if missing; a
    /// demo chat is seeded only when the workspace has no chats yet).
    Kernel { root: PathBuf },
}

/// Windowed-run configuration for [`run`].
pub struct RunConfig {
    pub source: WireSource,
    pub chat_id: Option<String>,
    /// Initial window size in LOGICAL (CSS) pixels.
    pub width: u32,
    pub height: u32,
}

impl Default for RunConfig {
    fn default() -> Self {
        Self {
            source: WireSource::Fake { messages: 12 },
            chat_id: None,
            width: 1100,
            height: 760,
        }
    }
}

fn to_boxed<E: std::fmt::Display>(err: E) -> Box<dyn std::error::Error> {
    err.to_string().into()
}

/// A session over any wire, boxed for runtime wire selection (the same
/// `Box<dyn ProductWire>` blanket the legacy desktop host rides on).
type BoxedSession = ChatSession<Box<dyn ProductWire>>;

/// Builds the session over the configured wire. Returns the window-title
/// tag carrying the INV-7 wire honesty label.
fn open_session(
    source: WireSource,
    chat_id: Option<String>,
) -> Result<(BoxedSession, &'static str), Box<dyn std::error::Error>> {
    match source {
        WireSource::Fake { messages } => {
            let wire: Box<dyn ProductWire> =
                Box::new(FakeWire::with_message_count(messages.max(1)));
            let mut session = ChatSession::open(wire, chat_id.as_deref()).map_err(to_boxed)?;
            // FakeWire completes its demo stream synchronously inside
            // `send`; drain once so the first frame is the settled state.
            let _ = session.pump_stream();
            Ok((session, " — FAKE WIRE (dev)"))
        }
        WireSource::Kernel { root } => {
            let mut wire = KernelProductWire::open(&root).map_err(to_boxed)?;
            let chat_id = match chat_id {
                Some(id) => Some(id),
                None => {
                    let has_chats = wire
                        .call("chats.list", serde_json::json!({}))
                        .ok()
                        .and_then(|call| {
                            call.result
                                .get("items")
                                .and_then(serde_json::Value::as_array)
                                .map(|items| !items.is_empty())
                        })
                        .unwrap_or(false);
                    if has_chats {
                        // Existing workspace: the session picks its own
                        // chat (latest activity order).
                        None
                    } else {
                        Some(
                            neotavern_presentation_kernel_wire::seed_parity_workspace(
                                &mut wire, "Pilot", 6,
                            )
                            .map_err(to_boxed)?,
                        )
                    }
                }
            };
            let wire: Box<dyn ProductWire> = Box::new(wire);
            let session = ChatSession::open(wire, chat_id.as_deref()).map_err(to_boxed)?;
            Ok((session, " — KERNEL"))
        }
    }
}

fn css_size(phys: (u32, u32), density: f32) -> (u32, u32) {
    let d = density.max(1.0);
    (
        ((phys.0 as f32) / d).ceil().max(1.0) as u32,
        ((phys.1 as f32) / d).ceil().max(1.0) as u32,
    )
}

/// One vello render of the snapshot into an `Rgba8Unorm` raster, then a
/// fullscreen-triangle blit onto the swapchain. `Fifo` + the swapchain
/// `present` pace the frames; the host parks in `Wait` between inputs.
struct Gpu {
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    renderer: vello::Renderer,
    /// Vello raster target, in CSS px — the blit stretches it to the
    /// swapchain (DPI note in the module docs).
    raster: wgpu::Texture,
    raster_view: wgpu::TextureView,
    raster_size: (u32, u32),
    sampler: wgpu::Sampler,
    pipeline: wgpu::RenderPipeline,
    bind_layout: wgpu::BindGroupLayout,
    bind: wgpu::BindGroup,
}

const BLIT_WGSL: &str = r#"
@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
    var corners = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 3.0, -1.0),
        vec2<f32>(-1.0,  3.0),
    );
    return vec4<f32>(corners[vi], 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    // wgpu NDC is bottom-left origin; the vello raster's first memory
    // row is the CONTENT TOP — flip y so the top of the raster lands at
    // the top of the window.
    let uv = vec2<f32>((pos.x + 1.0) * 0.5, (1.0 - pos.y) * 0.5);
    return textureSample(raster, raster_sampler, uv);
}
"#;

/// Swapchain format: prefer an sRGB view so vello's gamma-space composit
/// reaches the display without a conversion pass (mirrors the m0-d2
/// `pick_surface_format` preference order).
fn pick_format(formats: &[wgpu::TextureFormat]) -> Option<wgpu::TextureFormat> {
    [
        wgpu::TextureFormat::Bgra8UnormSrgb,
        wgpu::TextureFormat::Rgba8UnormSrgb,
        wgpu::TextureFormat::Bgra8Unorm,
        wgpu::TextureFormat::Rgba8Unorm,
    ]
    .into_iter()
    .find(|candidate| formats.contains(candidate))
    .or_else(|| formats.first().copied())
}

fn alloc_raster(
    device: &wgpu::Device,
    bind_layout: &wgpu::BindGroupLayout,
    sampler: &wgpu::Sampler,
    css: (u32, u32),
) -> (wgpu::Texture, wgpu::TextureView, wgpu::BindGroup) {
    let raster = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("scene-pilot-raster"),
        size: wgpu::Extent3d {
            width: css.0.max(1),
            height: css.1.max(1),
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        // STORAGE_BINDING: vello's compute raster writes the target as a
        // storage image (m0-d2 `plan_vello_target` contract); TEXTURE_
        // BINDING serves the blit's sample; COPY_SRC serves the readbacks.
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT
            | wgpu::TextureUsages::COPY_SRC
            | wgpu::TextureUsages::STORAGE_BINDING
            | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    let raster_view = raster.create_view(&wgpu::TextureViewDescriptor::default());
    let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("scene-pilot-blit-bind"),
        layout: bind_layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&raster_view),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::Sampler(sampler),
            },
        ],
    });
    (raster, raster_view, bind)
}

impl Gpu {
    fn open(window: &Arc<Window>, phys: (u32, u32), css: (u32, u32)) -> Result<Self, String> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::all(),
            flags: wgpu::InstanceFlags::from_build_config().with_env(),
            memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
            backend_options: wgpu::BackendOptions::default(),
            display: None,
        });
        let surface = instance
            .create_surface(window.clone())
            .map_err(|err| err.to_string())?;
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: Some(&surface),
            force_fallback_adapter: false,
        }))
        .map_err(|err| err.to_string())?;
        let (device, queue) =
            pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))
                .map_err(|err| err.to_string())?;
        let caps = surface.get_capabilities(&adapter);
        let format = pick_format(&caps.formats).ok_or("no swapchain format")?;
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: phys.0.max(1),
            height: phys.1.max(1),
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode: caps
                .alpha_modes
                .first()
                .copied()
                .unwrap_or(wgpu::CompositeAlphaMode::Auto),
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &config);
        // The project's proven vello options (m0-d2 `vello_renderer_options`):
        // area AA only, single shader-init thread.
        let renderer = vello::Renderer::new(
            &device,
            vello::RendererOptions {
                antialiasing_support: vello::AaSupport::area_only(),
                num_init_threads: std::num::NonZeroUsize::new(1),
                ..Default::default()
            },
        )
        .map_err(|err| format!("vello: {err}"))?;

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("scene-pilot-blit"),
            source: wgpu::ShaderSource::Wgsl(BLIT_WGSL.into()),
        });
        let bind_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("scene-pilot-blit-bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        multisampled: false,
                        view_dimension: wgpu::TextureViewDimension::D2,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("scene-pilot-blit-pl"),
            bind_group_layouts: &[Some(&bind_layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("scene-pilot-blit-pipeline"),
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
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("scene-pilot-blit-sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Nearest,
            ..Default::default()
        });
        let (raster, raster_view, bind) = alloc_raster(&device, &bind_layout, &sampler, css);
        Ok(Self {
            device,
            queue,
            surface,
            config,
            renderer,
            raster,
            raster_view,
            raster_size: css,
            sampler,
            pipeline,
            bind_layout,
            bind,
        })
    }

    /// Swapchain re-configure + raster re-allocation, atomically at
    /// frame time (resize events only record the size — the old config
    /// keeps presenting a consistent frame until here).
    fn reconfigure(&mut self, phys: (u32, u32), css: (u32, u32)) {
        self.config.width = phys.0.max(1);
        self.config.height = phys.1.max(1);
        self.surface.configure(&self.device, &self.config);
        if self.raster_size != css {
            let (raster, raster_view, bind) =
                alloc_raster(&self.device, &self.bind_layout, &self.sampler, css);
            self.raster = raster;
            self.raster_view = raster_view;
            self.bind = bind;
            self.raster_size = css;
        }
    }

    fn render(&mut self, vello_scene: &vello::Scene, css: (u32, u32)) {
        let mut outcome = self.surface.get_current_texture();
        if matches!(
            outcome,
            wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost
        ) {
            // Heal a stale swapchain with the CURRENT config (the one the
            // raster still matches) — the m0-d2 acquire contract.
            self.surface.configure(&self.device, &self.config);
            outcome = self.surface.get_current_texture();
        }
        let frame = match outcome {
            wgpu::CurrentSurfaceTexture::Success(frame)
            | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
            wgpu::CurrentSurfaceTexture::Timeout
            | wgpu::CurrentSurfaceTexture::Occluded
            | wgpu::CurrentSurfaceTexture::Outdated
            | wgpu::CurrentSurfaceTexture::Lost
            | wgpu::CurrentSurfaceTexture::Validation => {
                eprintln!("[scene-pilot] surface acquire: {outcome:?}");
                return;
            }
        };
        if self.raster_size != css {
            self.reconfigure((self.config.width, self.config.height), css);
        }
        let params = vello::RenderParams {
            base_color: vello::peniko::Color::from_rgba8(0, 0, 0, 0),
            width: css.0.max(1),
            height: css.1.max(1),
            antialiasing_method: vello::AaConfig::Area,
        };
        if let Err(err) = self.renderer.render_to_texture(
            &self.device,
            &self.queue,
            vello_scene,
            &self.raster_view,
            &params,
        ) {
            eprintln!("[scene-pilot] vello render: {err:?}");
            return;
        }
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("scene-pilot-blit-enc"),
            });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("scene-pilot-blit-pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                    store: wgpu::StoreOp::Store,
                },
                depth_slice: None,
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.bind, &[]);
        pass.draw(0..3, 0..1);
        drop(pass);
        self.queue.submit(Some(encoder.finish()));
        frame.present();
    }
}

/// The windowed pilot host. Owns the session, the pilot and the GPU
/// state; every mutation flows through the session command surface and
/// every geometry question flows through the snapshot.
struct Host {
    session: BoxedSession,
    pilot: ChatPilot,
    window: Option<Arc<Window>>,
    gpu: Option<Gpu>,
    size_phys: (u32, u32),
    density: f32,
    /// Single invalidation flag: input handlers, the stream pump and
    /// resize/scale events set it; the frame consumes it.
    dirty: bool,
    /// The last built snapshot — the only geometry this host reads.
    snapshot: Option<FrameSnapshot>,
    last_cursor_css: (f32, f32),
    /// Tracked via `ModifiersChanged` — winit 0.30 `KeyEvent` carries no
    /// mods field of its own.
    mods: Modifiers,
    title: String,
}

impl Host {
    fn new(
        session: ChatSession<Box<dyn ProductWire>>,
        title: String,
        initial_size: (u32, u32),
    ) -> Self {
        Self {
            session,
            pilot: ChatPilot::new(),
            window: None,
            gpu: None,
            size_phys: initial_size,
            density: 1.0,
            dirty: true,
            snapshot: None,
            last_cursor_css: (0.0, 0.0),
            mods: Modifiers::default(),
            title,
        }
    }

    fn css_point(&self, physical_x: f64, physical_y: f64) -> (f32, f32) {
        let d = self.density.max(1.0);
        ((physical_x as f32) / d, (physical_y as f32) / d)
    }

    fn request_redraw(&self) {
        if let Some(window) = self.window.as_ref() {
            window.request_redraw();
        }
    }

    /// One frame: (re)project, fold the snapshot, render to the swapchain.
    fn frame(&mut self) {
        let Some(gpu) = self.gpu.as_mut() else {
            return;
        };
        let phys = (self.size_phys.0.max(1), self.size_phys.1.max(1));
        let css = css_size(phys, self.density);
        if gpu.config.width != phys.0 || gpu.config.height != phys.1 {
            gpu.reconfigure(phys, css);
            self.dirty = true;
        }
        if self.dirty || self.snapshot.is_none() {
            self.pilot.project(&self.session);
            self.snapshot = Some(self.pilot.frame((css.0 as f32, css.1 as f32)));
            self.dirty = false;
        }
        let Some(snapshot) = self.snapshot.as_ref() else {
            return;
        };
        let mut vello_scene = vello::Scene::new();
        self.pilot.render(snapshot, &mut vello_scene);
        gpu.render(&vello_scene, css);
    }

    /// Mouse press → one hit through the single geometry. Disjoint field
    /// borrows keep the snapshot immutable while the pilot/session mutate.
    fn click(&mut self) {
        let (x, y) = self.last_cursor_css;
        let Some(snapshot) = self.snapshot.as_ref() else {
            return;
        };
        let Self { pilot, session, .. } = self;
        let _target = pilot.handle_hit(session, snapshot, x, y);
        self.dirty = true;
        self.request_redraw();
    }

    /// Keyboard → editor-core `CursorOp`s (INV-4: the host maps events,
    /// the op model stays unit-testable). Plain `Enter` sends; every other
    /// key edits through `apply_composer_op`.
    fn key(&mut self, event: KeyEvent) {
        let shift = self.mods.state().shift_key();
        let ctrl = self.mods.state().control_key();
        let alt = self.mods.state().alt_key();
        match &event.logical_key {
            Key::Character(text) if ctrl => {
                if text.eq_ignore_ascii_case("a") {
                    self.pilot
                        .apply_composer_op(&mut self.session, CursorOp::SelectAll);
                }
            }
            Key::Character(text) if !ctrl && !alt => {
                self.pilot.composer().queue_insert(text.as_str());
                self.pilot
                    .apply_composer_op(&mut self.session, CursorOp::Insert { batch: 0 });
            }
            Key::Named(NamedKey::Backspace) => {
                self.pilot
                    .apply_composer_op(&mut self.session, CursorOp::DeleteBackward);
            }
            Key::Named(NamedKey::Delete) => {
                self.pilot
                    .apply_composer_op(&mut self.session, CursorOp::DeleteForward);
            }
            Key::Named(NamedKey::Enter) => {
                if shift {
                    self.pilot.composer().queue_insert("\n");
                    self.pilot
                        .apply_composer_op(&mut self.session, CursorOp::Insert { batch: 0 });
                } else {
                    let _ = self.session.send(None);
                }
            }
            Key::Named(NamedKey::ArrowLeft) => {
                self.pilot
                    .apply_composer_op(&mut self.session, CursorOp::MoveLeft { select: shift });
            }
            Key::Named(NamedKey::ArrowRight) => {
                self.pilot
                    .apply_composer_op(&mut self.session, CursorOp::MoveRight { select: shift });
            }
            Key::Named(NamedKey::ArrowUp) => {
                self.pilot
                    .apply_composer_op(&mut self.session, CursorOp::MoveUp { select: shift });
            }
            Key::Named(NamedKey::ArrowDown) => {
                self.pilot
                    .apply_composer_op(&mut self.session, CursorOp::MoveDown { select: shift });
            }
            Key::Named(NamedKey::Home) => {
                self.pilot.apply_composer_op(
                    &mut self.session,
                    CursorOp::MoveToLineStart { select: shift },
                );
            }
            Key::Named(NamedKey::End) => {
                self.pilot.apply_composer_op(
                    &mut self.session,
                    CursorOp::MoveToLineEnd { select: shift },
                );
            }
            _ => {}
        }
        self.dirty = true;
        self.request_redraw();
    }
}

impl ApplicationHandler for Host {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        event_loop.set_control_flow(ControlFlow::Wait);
        let window = match event_loop.create_window(
            WindowAttributes::default()
                .with_title(self.title.clone())
                .with_inner_size(winit::dpi::LogicalSize::new(
                    self.size_phys.0 as f64,
                    self.size_phys.1 as f64,
                )),
        ) {
            Ok(window) => Arc::new(window),
            Err(err) => {
                eprintln!("[scene-pilot] window: {err}");
                event_loop.exit();
                return;
            }
        };
        let inner = window.inner_size();
        self.size_phys = (inner.width.max(1), inner.height.max(1));
        self.density = window.scale_factor() as f32;
        let css = css_size(self.size_phys, self.density);
        let gpu = match Gpu::open(&window, self.size_phys, css) {
            Ok(gpu) => gpu,
            Err(err) => {
                eprintln!("[scene-pilot] gpu: {err}");
                event_loop.exit();
                return;
            }
        };
        eprintln!(
            "[scene-pilot] ready {}x{} dpr={:.2} swapchain={:?}",
            self.size_phys.0, self.size_phys.1, self.density, gpu.config.format,
        );
        self.gpu = Some(gpu);
        self.window = Some(window);
        self.dirty = true;
        self.request_redraw();
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        _window_id: winit::window::WindowId,
        event: WindowEvent,
    ) {
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
                self.density = scale_factor as f32;
                self.dirty = true;
                self.request_redraw();
            }
            WindowEvent::Resized(size) => {
                if size.width > 0 && size.height > 0 {
                    self.size_phys = (size.width, size.height);
                    self.dirty = true;
                    self.request_redraw();
                }
            }
            WindowEvent::RedrawRequested => self.frame(),
            WindowEvent::CursorMoved { position, .. } => {
                self.last_cursor_css = self.css_point(position.x, position.y);
            }
            WindowEvent::MouseInput {
                state: ElementState::Pressed,
                button: MouseButton::Left,
                ..
            } => self.click(),
            WindowEvent::KeyboardInput { event, .. } if event.state == ElementState::Pressed => {
                self.key(event);
            }
            WindowEvent::ModifiersChanged(mods) => {
                self.mods = mods;
            }
            _ => {}
        }
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        // Stream pump: the session owns the stream (INV-5); the host only
        // drains at the AGENTS §24 cadence while a run is live.
        if self.session.pump_stream() {
            self.dirty = true;
        }
        let stream_live = self.session.state().stream_handle.is_some();
        if self.dirty {
            self.request_redraw();
        }
        if stream_live {
            let next = Instant::now() + STREAM_FRAME_MIN_INTERVAL;
            event_loop.set_control_flow(ControlFlow::WaitUntil(next));
        } else {
            event_loop.set_control_flow(ControlFlow::Wait);
        }
    }
}

/// Runs the pilot in a winit window. Blocks until the window closes.
pub fn run(config: RunConfig) -> Result<(), Box<dyn std::error::Error>> {
    let (session, tag) = open_session(config.source, config.chat_id)?;
    let title = format!("NeoTavern scene pilot (ADR-0057 Phase 1){tag}");
    let event_loop = winit::event_loop::EventLoop::new()?;
    let mut host = Host::new(session, title, (config.width, config.height));
    event_loop.run_app(&mut host)?;
    Ok(())
}

/// Local-only raster evidence: renders the pilot at [`GOLDEN_SIZES`] on an
/// offscreen wgpu device (no window) and writes one PNG per size into
/// `out_dir`. Never a CI gate; FakeWire labels live in the PNG filenames.
pub fn render_pngs(
    config: RunConfig,
    out_dir: &Path,
) -> Result<Vec<PathBuf>, Box<dyn std::error::Error>> {
    let (session, tag) = open_session(config.source, config.chat_id)?;
    // "— FAKE WIRE (dev)" -> "fake-wire-dev": filesystem-safe INV-7 label.
    let tag_slug: String = tag
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == ' ')
        .collect::<String>()
        .replace(' ', "-")
        .trim_matches('-')
        .to_lowercase();
    let mut pilot = ChatPilot::new();
    pilot.project(&session);

    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::all(),
        flags: wgpu::InstanceFlags::from_build_config().with_env(),
        memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
        backend_options: wgpu::BackendOptions::default(),
        display: None,
    });
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        compatible_surface: None,
        force_fallback_adapter: false,
    }))
    .map_err(|err| err.to_string())?;
    let (device, queue) =
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))
            .map_err(to_boxed)?;
    let mut renderer = vello::Renderer::new(
        &device,
        vello::RendererOptions {
            antialiasing_support: vello::AaSupport::area_only(),
            num_init_threads: std::num::NonZeroUsize::new(1),
            ..Default::default()
        },
    )
    .map_err(|err| err.to_string())?;

    std::fs::create_dir_all(out_dir)?;
    let mut written = Vec::new();
    for (width, height) in GOLDEN_SIZES {
        let snapshot = pilot.frame((width as f32, height as f32));
        let mut vello_scene = vello::Scene::new();
        pilot.render(&snapshot, &mut vello_scene);

        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("scene-pilot-golden-raster"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::STORAGE_BINDING,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        renderer
            .render_to_texture(
                &device,
                &queue,
                &vello_scene,
                &view,
                &vello::RenderParams {
                    base_color: vello::peniko::Color::from_rgba8(0, 0, 0, 0),
                    width,
                    height,
                    antialiasing_method: vello::AaConfig::Area,
                },
            )
            .map_err(|err| err.to_string())?;

        let bytes_per_row = (width * 4).div_ceil(256) * 256;
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("scene-pilot-golden-readback"),
            size: u64::from(bytes_per_row * height),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder =
            device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
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
        queue.submit(Some(encoder.finish()));
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        let slice = buffer.slice(..);
        let (sender, receiver) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = sender.send(result);
        });
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        receiver
            .recv()
            .map_err(|_| "readback channel closed")?
            .map_err(|err| err.to_string())?;
        let data = slice.get_mapped_range();
        let mut pixels = Vec::with_capacity((width as usize) * 4 * height as usize);
        for row in 0..height as usize {
            let start = row * bytes_per_row as usize;
            pixels.extend_from_slice(&data[start..start + width as usize * 4]);
        }
        drop(data);
        buffer.unmap();

        let path = out_dir.join(format!("scene-pilot-{tag_slug}-{width}x{height}.png"));
        let file = std::io::BufWriter::new(std::fs::File::create(&path)?);
        let mut encoder = png::Encoder::new(file, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.write_header()?.write_image_data(&pixels)?;
        eprintln!("[scene-pilot] golden raster {}", path.display());
        written.push(path);
    }
    Ok(written)
}
