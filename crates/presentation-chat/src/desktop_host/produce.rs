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

/// Cap on live+detached Blitz arena nodes before the next produce cold-opens
/// a fresh document (leak containment for the vendored blitz-dom GC no-op).
/// `NEOTA_ARENA_COLD_REOPEN` overrides (diagnostics/soak tests).
fn arena_cold_reopen_nodes() -> usize {
    std::env::var("NEOTA_ARENA_COLD_REOPEN")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8192)
}

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
        // The rasters carry the overscan strips (144fps scroll runway) on
        // top of the panel height.
        let overscan_phys = ((neotavern_presentation_dioxus_shell::CHAT_OVERSCAN_CSS as f32)
            * density)
            .round()
            .max(1.0) as u32;
        present.resize(width.max(1), height, overscan_phys);
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
            // presents. The frozen-raster fast path has no baked content
            // beyond the band — the blit shader fills the leading edge — so
            // the drift cap is bounded (96px) instead of half the band:
            // the filler strip stays a screen-edge sliver mid-fling.
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
            // Directional runway caps: the overscan raster only has baked
            // rows while the drift stays inside the painted canvas extents;
            // past them the leading edge would show the wallpaper filler
            // again. Land the re-produce with runway to spare (24px margin
            // absorbs frame jitter and the compact-pad estimate difference
            // between the session extents and the rendered anchor). At the
            // bottom pin the below-band runway is ~0 — but the offset cannot
            // move past the pin, so the small newer-cap never gates a real
            // gesture.
            let (band_top_css, band_bottom_css) = (header as f32, (header + viewport) as f32);
            // The canvas extents are painted subject to the viewport box
            // (CHAT_OVERSCAN_CSS past the panel edges) — anything beyond is
            // clipped, so the runway must clamp to the box too, or a fling
            // would sample the cleared raster outside the painted strips.
            let overscan_css = neotavern_presentation_dioxus_shell::CHAT_OVERSCAN_CSS as f32;
            let canvas_top = shell.chat.chat_canvas_top_css.max(-overscan_css);
            let canvas_bottom = shell
                .chat
                .chat_canvas_bottom_css
                .min(css_h as f32 + overscan_css);
            let runway_older = band_top_css - canvas_top - 24.0;
            let runway_newer = canvas_bottom - band_bottom_css - 24.0;
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
                (runway_older, runway_newer),
                ui_opacity,
                character_count,
            )
        };
        self.chat_band = Some(chat_band);
        let (runway_older, runway_newer) = ack_cap_css;
        self.ack.set_runway_caps(runway_older, runway_newer);
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

        // The rasters are taller than the swapchain by the overscan strips;
        // the doc scene paints into the middle window (+overscan from the
        // raster top) so its panel row maps 1:1 onto the screen.
        let mut raster_scene = vello::Scene::new();
        raster_scene.append(
            &scene,
            Some(vello::kurbo::Affine::translate((
                0.0,
                f64::from(overscan_phys),
            ))),
        );
        if let Err(err) = present.render(&raster_scene, palette::css::TRANSPARENT) {
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
        // Arena leak containment: the vendored blitz-dom has the arena GC
        // disabled (dioxus-native-dom id recycling panicked on arena-dead
        // nodes — see vendor/blitz-dom/NEOTAVERN_PATCH.md), so detached
        // subtrees accumulate instead. Past the threshold the warm session
        // is dropped and the NEXT produce cold-opens a fresh document,
        // bounding the leak at a one-frame hiccup (~90 ms release) per
        // crossing. The live DOM at desktop sizes is ~120-180 nodes; the
        // cap leaves ~45x headroom.
        let arena_nodes = sess.arena_node_count();
        if arena_nodes > arena_cold_reopen_nodes() {
            let cap = arena_cold_reopen_nodes();
            eprintln!(
                "[neocompositor-desktop] arena nodes {arena_nodes} > {cap}: next produce cold-opens"
            );
        } else {
            // Park the warm session for the next incremental produce.
            self.vello_session = Some(sess);
        }
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
        // L3 height feedback (before the dump writes, it decides them):
        // measured painted heights replace the estimates. A CHANGED
        // correction re-arms one settle produce — the row window is selected
        // by the corrected heights, so without it the first frame after open
        // (estimates only) paints the wrong rows (the startup chat sat on
        // mid-list rows instead of the newest ones). A stable layout
        // re-learns nothing and clears the flag: no produce loop. The redraw
        // re-arm is load-bearing: the event loop waits idle, so the settle
        // produce never runs unless asked for. Probe dumps skip this
        // estimate-selected frame and capture the settle produce instead.
        let learned = self.session.learn_measured_heights(&self.message_rects);
        if !learned {
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
        // Extent cache — refreshed here because learning (above) is the only
        // thing that changes it. A fling-to-top pinned the offset against the
        // extent the host knew at impulse time; when learning grows the
        // extent, re-pin so one fling reaches the top instead of sticking
        // short. The re-pin rides the NEXT produce: this raster stays at the
        // window it painted (the ack landed on it above), so no visible snap.
        let prev_max = self.scroll_max_css;
        self.scroll_max_css = self.session.scroll_max_css();
        let repinned = prev_max > 0.0
            && self.scroll_max_css > prev_max + 0.5
            && self.session.scroll_offset_css() >= prev_max - 0.5;
        if repinned {
            self.session.set_scroll_offset_css(self.scroll_max_css);
        }
        // A3 scroll-settle hydration moved out of the produce (host `frame`
        // runs it after the present): image fetches must not extend the
        // land-critical path, and a hydrated asset re-arms one redraw itself.
        self.dirty = learned || repinned;
        if self.dirty {
            self.window.as_ref().map(|w| w.request_redraw());
        }
    }
}
