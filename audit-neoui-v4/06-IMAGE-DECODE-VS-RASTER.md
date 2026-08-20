# CPU image decode vs CPU raster

## ТЗ

> CPU может декодировать изображения в фоне, но CPU full-frame raster запрещён.

---

## Что считается decode, что — raster

- **Decode** — `image::ImageReader::decode` + `crop/resize` + `premultiply` в RAM, затем `queue.write_texture` (GPU upload). Разрешено, но **только в фоне**, не на render thread.
- **Raster** — `vello::Renderer::render_to_texture` (или `RendererOptions { use_cpu: true }`) — полный проход Vello на CPU. Запрещён в production (разрешён только при `NEOTA_SOFTWARE_RASTER_DEBUG=1`).

---

## Реализация decode (правильная)

**`crates/presentation-chat/src/avatar.rs`**

```rust
pub const AVATAR_DISPLAY_MAX_PX: u32 = 192; // 44px*3 + 52px*3
pub fn thumbnail_from_bytes(bytes: &[u8]) -> Option<AvatarThumb> {
  let image = ImageReader::new(Cursor::new(bytes))
    .with_guessed_format().ok()?.decode().ok()?;
  Some(cover_square_premul(image, 192))
}
fn cover_square_premul(image: DynamicImage, size: u32) -> AvatarThumb {
  let rgba = image.to_rgba8();
  let (w,h) = rgba.dimensions();
  let side = w.min(h).max(1);
  let cropped = crop_imm(&rgba, (w-side)/2, (h-side)/2, side, side).to_image();
  let resized = DynamicImage::ImageRgba8(cropped)
    .resize_exact(size, size, FilterType::Triangle);
  AvatarThumb { width, height, premul_rgba: premultiply(&resized.to_rgba8()) }
}
fn premultiply(image: &RgbaImage) -> Vec<u8> {
  for pixel in image.pixels() {
    let a = pixel[3] as u16;
    out.push((pixel[0] as u16 * a +127)/255); ...
  }
}
```

**Где вызывается (фон):**
```rust
// crates/presentation-chat/src/session.rs: refreshFromRoute / sendComposer
holder.executor.execute { // ← SingleThreadExecutor, не UI, не compositor
  let b64 = wire.call("assets.content", ...)?; // base64
  if let Some(thumb) = premultiplied_cover_thumbnail(&b64) {
    state.avatar_thumbs.insert(asset_id, thumb);
    state.avatar_ready_token += 1;
    compositorHandler.post { PresentationChatNative.rebuildScene() }
  }
}
// crates/presentation-chat/src/avatar_gpu.rs
impl AvatarGpu {
  pub fn upload(&mut self, device, queue, thumb: &AvatarThumb) {
    queue.write_texture(..., &thumb.premul_rgba, ...);
  }
}
```

**Проверка фона:**
- `PresentationChatActivity.sendComposer` / `refreshFromRoute` / `prependOlder` — все `holder.executor.execute { ... thumbnail_from_bytes ... }` — не `runOnUiThread`, не `compositorHandler` (до `rebuildScene`).
- `PresentationChatNative.openRoute` — тоже на `holder.executor`.

**Встроенный data URI — запрещён на paint path:**
```rust
// presentation-dioxus-shell/src/product_shell.rs: CharacterCardView
pub avatar_data_uri: Option<String> // Always None on the paint path.
```
`avatar_data_uri` — только для совместимости старых конструкторов, реально `None`. Blitz не получает `data:` URI, Vello не семплит `Image` brush (иначе чёрный SurfaceView на Vulkan — комментарий в boundary).

**Вердикт decode:** ✅ PASS — decode в фоне, не на render thread, один `texture` на asset_id (header и card share one cached handle).

---

## Реализация raster (запрет соблюдён)

**`crates/presentation-chat/src/vello_gpu.rs`**

```rust
static SOFTWARE_RASTER_DEBUG: Mutex<Option<bool>> = Mutex::new(None);
pub fn software_raster_debug_enabled() -> bool {
  if let Some(v) = *SOFTWARE_RASTER_DEBUG.lock() { return v; }
  matches!(env::var("NEOTA_SOFTWARE_RASTER_DEBUG").as_deref(), Ok("1"))
}
pub fn vello_renderer_options(software_debug: bool) -> RendererOptions {
  RendererOptions { use_cpu: software_debug, antialiasing_support: AreaOnly, .. }
}
pub fn production_host_line(..., software_debug: bool) -> String {
  format!("... cpu_full_frame_raster={} ...", software_debug as u8)
}
```

**`crates/presentation-chat/src/android_surface.rs`**

```rust
let software_debug = software_raster_debug_enabled();
let line = production_host_line(backend, "live", 1, density, swapchain, epoch, software_debug);
// Логирует renderer=vello-gpu use_cpu=false по умолчанию
if software_debug { RendererOptions { use_cpu: true } } else { use_cpu: false }
```

Только явный extra `NEOTA_SOFTWARE_RASTER_DEBUG=1` включает CPU raster (документировано в `milestone-c-canary.md:70` как `CPU Vello only (not production/canary)`).

**Tiled raster — не full-frame CPU:**

`presentation-boundary.md:277-284`:
```
Resolution and display-list prefix bisection run on first bind;
if only small targets write, GPU tiled raster is used (not CPU full-frame raster).
Tiled present keeps **one** Blitz layout and **one** PaintScene.
Each tile is Scene::append(full, translate(-tile_origin)) onto tile-sized target
(encoding-level seam-test locked; do not retune WGSL).
Images stay out of Vello; avatars are post-Vello sampled overlay.
```

- Не `RendererOptions { use_cpu: true }`.
- Каждая tile — GPU `RenderParams` на `Rgba8Unorm` storage target, затем `gpu_storage_to_sampled`.
- `coarse_bin_count = tiles_x/16 * tiles_y/16`, `Vello 0.9 bin 16×16 px`.

**Проверка tiled vs full-frame:**
```rust
// vello_diag.rs: tile_origins(width, height, tileW, tileH) → Vec<(f32,f32)>
// android_surface.rs: for origin in tile_origins(...) {
//   let scene = Scene::append(full_scene, Affine::translate(-origin.x, -origin.y));
//   renderer.render_to_texture(device, queue, &scene, &tile_target, &params);
// }
```

**Тест отсутствия full-frame CPU:**
```rust
// crates/presentation-chat/tests/compositor_host.rs
#[test] fn production_host_line_uses_gpu() {
  assert!(!software_raster_debug_enabled());
  let line = production_host_line("Vulkan", "live", 1, 3.0, Rgba8Unorm, 0, false);
  assert!(line.contains("renderer=vello-gpu"));
  assert!(line.contains("cpu_full_frame_raster=0"));
}
```

**Вердикт raster:** ✅ PASS — CPU full-frame raster отсутствует в production/canary; GPU tiled raster — разрешённый продукт-композиторный путь.

---

## Баги / риски в image pipeline

### B1 (P1) — unbounded avatar cache

`avatar_gpu.rs: textures: HashMap<String, CachedAvatar>` — `insert` без evict. `session.rs: avatar_thumbs: HashMap<String, AvatarThumb>` — тоже. При `characters.list` с пагинацией и скролле может вырасти до 100+ аватаров × 192×192×4 ≈ 14 MB на GPU + RAM, без учёта pressure.

**Фикс:** подключить к `PressureController` (PERF-15) или LRU с `DEFAULT_PRESSURE_CAP_BYTES`.

### B2 (P1) — decode без preflight

`thumbnail_from_bytes` сразу `decode()`, затем `resize_exact`. Злоумышленник может подсунуть через `assets.content` большой PNG (напр., 8k×8k, ~200 MB декодированного). Нет проверки `bytes.len()` или `image.dimensions()` до аллокации.

**Фикс:**
```rust
if bytes.len() > 10*1024*1024 { return None; }
let (w,h) = image_dimensions(Cursor::new(bytes))?;
if w*h > 4_000*4_000 { return None; }
```

### B3 (P2) — JPEG vs PNG vs WebP

`ImageReader::with_guessed_format` поддерживает все, но `cover_square_premul` использует `FilterType::Triangle` (билинейный) — на downscale 1024→192 даёт алиасинг vs `Lanczos3`. Визуально может быть 1-px halo vs React `object-fit: cover`. Не критично, но визуальный diff.

---

## Итог

| Требование | Статус | Доказательство |
|---|---|---|
| CPU decode в фоне | ✅ PASS | `holder.executor`, не `present` |
| CPU full-frame raster запрещён | ✅ PASS | `use_cpu=false` по умолчанию, `cpu_full_frame_raster=0` в логах |
| GPU tiled raster — не считается CPU raster | ✅ PASS | `Scene::append` на tile-sized target, один device |
| No readback для аватаров | ✅ PASS | `write_texture` + sampled overlay, не `readback` |

