//! The slow path: one full document rebuild + Blitz layout + vello raster
//! (`produce_and_render`), including the wallpaper cover and avatar plumbing.

use super::{wallpaper_rect_css, App};
use crate::{sidebar_occupied_css, ChatCompositor, HitRects};
use neotavern_presentation_dioxus_shell::{
    chrome_metrics, install_product_shell, product_shell_app,
};
use neotavern_presentation_m0_d2::{
    image_paints_from_layout, write_slot_skeleton, ProductVelloSession, VelloFilter,
};
use vello::peniko::color::palette;

impl App {
    /// Produce + rasterize once on dirty (mirrors the Android host: layout and
    /// vello raster happen per `bind`, then each present frame only re-blits
    /// the accumulated `resolve` вЂ” `composite_only_frames`).
    pub(super) fn produce_and_render(&mut self) {
        let Some(present) = self.present.as_mut() else {
            return;
        };
        let t0 = std::time::Instant::now();
        let (width, height) = self.size;
        let density = self.density;
        // Produce-time target re-allocation: resize events only re-configure
        // the swapchain (stretch-present of the previous raster); here the
        // rasters catch up with the settled size exactly once per produce.
        present.resize(width.max(1), height);
        let (insets, toast_showing, chat_band, ack_cap_css, ui_opacity, character_count) = {
            let session = &mut self.session;
            session.set_surface_size(width.max(1), height, density);
            session.set_safe_area_physical(0.0, 0.0, 0.0, 0.0);
            // One view-model build per frame: `shell_view` clones characters,
            // visible rows and drafts, so a second call for the toast check
            // doubles that cost on every drag/scroll tick.
            let shell = session.shell_view();
            let toast_showing = shell.status_message.is_some();
            // Chat-column blend window (physical px) for blit-shifted
            // presents; the drift cap is half the band height so filler never
            // covers the whole viewport between landings.
            let d = density.max(1.0);
            let css_w = ((width.max(1) as f32 / d).round()) as u32;
            let css_h = ((height.max(1) as f32 / d).round()) as u32;
            let (_, header, viewport, _) = chrome_metrics(css_w, css_h);
            let occupied = sidebar_occupied_css(&shell);
            let band = (
                header as f32 * d,
                (header + viewport) as f32 * d,
                occupied * d,
                width as f32,
            );
            let cap = (band.1 - band.0) * 0.5 / d;
            // Captured before the move into `install_product_shell`; the
            // wallpaper dim and the produce log need them, and a second
            // `shell_view()` call would clone the whole view-model again
            // (see the comment above).
            let ui_opacity = shell.ui_opacity;
            let character_count = shell.characters.len();
            install_product_shell(shell);
            (
                session.insets(),
                toast_showing,
                band,
                cap,
                ui_opacity,
                character_count,
            )
        };
        self.chat_band = Some(chat_band);
        self.ack.set_cap(ack_cap_css);
        if toast_showing {
            if self.status_shown_at.is_none() {
                self.status_shown_at = Some(std::time::Instant::now());
            }
        } else {
            self.status_shown_at = None;
        }
        let t_layout = std::time::Instant::now();

        let t_open = std::time::Instant::now();
        // A2 incremental produce: keep the VirtualDom mounted between produces
        // and diff only the dirty scopes; `NEOTA_INCREMENTAL_PRODUCE=0` or the
        // first frame falls back to the full `open`. The session is taken out
        // so a failed refresh cannot poison the next cold open.
        let mut sess = match ProductVelloSession::open_or_refresh(
            product_shell_app,
            width.max(1),
            height.max(1),
            density.max(1.0),
            insets,
            self.session.asset_store(),
            self.vello_session.take(),
        ) {
            Ok(session) => session,
            Err(err) => {
                eprintln!("[neocompositor-desktop] session open: {err}");
                self.dirty = true;
                return;
            }
        };
        let t_paint = std::time::Instant::now();
        let (produced, scene, _diag) = match sess.paint(VelloFilter::full()) {
            Ok(out) => out,
            Err(err) => {
                eprintln!("[neocompositor-desktop] paint: {err}");
                self.dirty = true;
                return;
            }
        };
        let t_render = std::time::Instant::now();
        let list_ops = produced.list.ops.len();
        let scene_paths = scene.encoding().n_paths;

        // Diagnostic: dump the recorded paint stream (fills/strokes with
        // bounding boxes) so the painted geometry can be compared with the
        // skeleton (`--dom-dump`). Helps catch paint/layout divergence.
        if std::env::var("NEOTA_SCENE_DUMP").is_ok() {
            let mut lines: Vec<String> = produced
                .stream
                .iter()
                .filter_map(|op| match op {
                    neotavern_presentation_m0_d2::StreamOp::Draw {
                        kind,
                        rect: Some(r),
                        fill_rgba: Some((cr, cg, cb, ca)),
                    } if *ca > 40 => Some(format!(
                        "[stream] {kind:?} rect=({:.0},{:.0},{:.0},{:.0}) rgba=({cr},{cg},{cb},{ca})",
                        r.x, r.y, r.x + r.width, r.y + r.height
                    )),
                    _ => None,
                })
                .collect();
            lines.sort();
            for l in lines {
                eprintln!("{l}");
            }
        }

        let heights = self.session.compositor_height_index();
        match self.compositor.as_mut() {
            Some(compositor) => compositor.bind_list(produced.list),
            None => {
                self.compositor = Some(ChatCompositor::from_list_scaled(
                    heights,
                    width,
                    height,
                    produced.list,
                    density.max(1.0),
                ));
            }
        }

        if let Err(err) = present.render(&scene, palette::css::TRANSPARENT) {
            eprintln!("[neocompositor-desktop] render: {err}");
            self.dirty = true;
            return;
        }
        let t_post = std::time::Instant::now();
        if std::env::var("NEOTA_DEBUG_PEEK").is_ok() {
            for (px, py) in [(550, 410), (1092, 410), (550, 100), (30, 400)] {
                let before = present.debug_peek_resolve(px, py);
                eprintln!("[wall-debug] after render ({px},{py}): {before:?}");
            }
        }
        // One full skeleton build per produce: the same skeleton feeds the
        // wallpaper dest rect, the hit rects and (when requested) the dom
        // dump — `slot_skeleton()` walks the whole document on every call.
        let skeleton = sess.slot_skeleton();
        // Wallpaper photo: fixed underlay composited by the blit shader (image
        // audit, stage C). The scroll blit shifts the scene OVER the photo, so
        // the wallpaper no longer rides the band shift and the band's
        // out-of-range region shows the photo instead of the flat filler. The
        // dest rect is the layout rect of the `part:chat-wallpaper` node
        // (chat workspace + bleed) — the photo no longer glows through the
        // sidebar, matching the React chrome scoping.
        if let Some(bytes) = &self.wallpaper_bytes {
            let density = density.max(1.0);
            let wall_css = wallpaper_rect_css(&skeleton);
            // React parity dim: `overlay_alpha = ui_opacity/100 * 0.45`
            // (product_shell.rs); the shader applies it fixed to the photo.
            let overlay_alpha = (ui_opacity.min(100) as f32 / 100.0) * 0.45;
            present.set_wallpaper_overlay_alpha(overlay_alpha);
            match wall_css {
                Some(rect) => {
                    let (rw, rh) = (
                        (rect.2 * density).round().max(1.0),
                        (rect.3 * density).round().max(1.0),
                    );
                    // Re-derive the cover only when the dest rect moved by
                    // more than 10% along either axis; in between the shader
                    // stretches the cached cover into the new rect (a photo
                    // tolerates it, and a resize drag changes the rect every
                    // produce — a full re-decode per tick would dominate the
                    // frame).
                    let stale = match &self.wallpaper_cache {
                        Some((w, h, _)) => {
                            let (w, h) = (*w as f32, *h as f32);
                            (w - rw).abs() > w * 0.1 || (h - rh).abs() > h * 0.1
                        }
                        None => true,
                    };
                    let regen = if stale {
                        crate::wallpaper_cover_thumbnail(bytes, rw as u32, rh as u32)
                    } else {
                        None
                    };
                    if let Some(thumb) = regen {
                        self.wallpaper_cache = Some((rw as u32, rh as u32, thumb));
                        self.wallpaper_epoch += 1;
                    }
                    if let Some((_, _, thumb)) = &self.wallpaper_cache {
                        present.upload_wallpaper(self.wallpaper_epoch, thumb);
                        present.set_wallpaper_rect(Some([
                            (rect.0 * density).round(),
                            (rect.1 * density).round(),
                            rw,
                            rh,
                        ]));
                    }
                }
                None => present.set_wallpaper_rect(None),
            }
        }
        // Avatars ride the scene as `<img src="asset:{id}">` rasters (image
        // audit, stage B): the paint walk z-orders them with clips and modal
        // layers, so no post-frame composite exists. NEOTA_INSCENE_IMAGES=0
        // restores the Stage A GPU overlay for a device where the Vello
        // image atlas regresses.
        let avatar_count = if neotavern_presentation_m0_d2::inscene_images_enabled() {
            sess.paint_layout().avatars.len()
        } else {
            let avatar_paints = image_paints_from_layout(
                sess.paint_layout(),
                density.max(1.0),
                self.session.avatar_ready_token(),
            );
            for (asset_id, thumb) in self.session.avatar_thumbs() {
                present.upload_avatar(asset_id, thumb);
            }
            present.composite_avatars(&avatar_paints);
            avatar_paints.len()
        };
        // Message row boxes for inline action hit-testing (copy). The rows are
        // in-flow inside the chat viewport, so their layout rects are the
        // window CSS-px positions the pointer pipeline uses.
        self.message_rects = sess.paint_layout().messages.clone();
        // Layout-derived hit rects: the single geometry source for taps and
        // text-field focus (same skeleton the `--dom-dump` writes).
        self.hit_rects = HitRects::from_skeleton(&skeleton);
        // Park the warm session for the next incremental produce.
        self.vello_session = Some(sess);
        let total = t0.elapsed();
        let layout_ms = t_layout.duration_since(t0).as_millis();
        let open_ms = t_paint.duration_since(t_open).as_millis();
        let paint_ms = t_render.duration_since(t_paint).as_millis();
        let render_ms = t_post.duration_since(t_render).as_millis();
        let post_ms = total.as_millis() - layout_ms - open_ms - paint_ms - render_ms;
        eprintln!(
            "[neocompositor-desktop] produced cmds={} ops={} paths={} glass={} backend={} kernel_messages={} characters={} avatars={} [layout {}ms open {}ms paint {}ms render {}ms post {}ms total {}ms]",
            produced.report.paint_commands,
            list_ops,
            scene_paths,
            produced.report.glass_hooks,
            present.backend,
            self.session.kernel_message_count(),
            character_count,
            avatar_count,
            layout_ms,
            open_ms,
            paint_ms,
            render_ms,
            post_ms,
            total.as_millis(),
        );
        if let Some(path) = self.snapshot_path.take() {
            match present.snapshot(&path) {
                Ok(()) => eprintln!("[neocompositor-desktop] snapshot WROTE {path}"),
                Err(err) => eprintln!("[neocompositor-desktop] snapshot failed: {err}"),
            }
        }
        if let Some(path) = self.dom_dump_path.take() {
            let count = skeleton.nodes.len();
            match write_slot_skeleton(&path, &skeleton) {
                Ok(()) => {
                    eprintln!("[neocompositor-desktop] dom-dump WROTE {path} ({count} nodes)")
                }
                Err(err) => eprintln!("[neocompositor-desktop] dom-dump failed: {err}"),
            }
        }
        // After a produce the raster is baked at the session offset: the
        // ack-loop lands on the produced window (the blit shift reads against
        // it). While no scroll animation is mid-flight the visual follows the
        // bake; mid-animation the visual keeps leading (landing will sync it
        // back).
        self.ack.land(self.session.scroll_offset_css());
        if !self.scroll_animation_active() {
            self.visual_scroll_css = self.session.scroll_offset_css();
        }
        // A3 scroll-settle hydration moved out of the produce (host `frame`
        // runs it after the present): image fetches must not extend the
        // land-critical path, and a hydrated asset re-arms one redraw itself.
        self.dirty = false;
    }
}
