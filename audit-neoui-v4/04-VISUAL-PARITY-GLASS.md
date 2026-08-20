# Visual parity, glass, дизайн-система

## 1. React — golden. Проверка честности.

**Утверждение canary:** `React is migration golden` — не `PASS`.

Доказательства честности (нет ложного PASS):

- `docs/architecture/presentation-boundary.md:223-296`
  ```
  The React card formatter is description || "No character description yet."
  ...
  This is **not** a visual golden PASS (device overlay / ≤1 dp geometry diff is not signed)
  and **not** WebView runtime removal.
  ```
- `docs/rfc/presentation-compatibility-matrix.md:5-35` — `Character Management`, `Theme SDK`, `Plugin frontend` — `DEFERRED`.
- `docs/rfc/milestone-c-canary.md:18-19` — `canary_batch PASS` — хозяин не переписывает `milestone-c-adjudication.json` (`canary=false`).

**Визуальные инварианты, которые уже реализованы (не объявлены PASS):**

- `crates/presentation-design-system/src/lib.rs` — `PRODUCT_CSS` содержит:
  ```
  --st-color-accent: #e38a62
  --st-color-surface-canvas: #151311
  --st-radius-control: 10px  →  border-radius: 10px (не var())
  --st-shell-rail-width: 60px
  'Outfit Variable' / 'JetBrains Mono Variable' (70192 / 96940 bytes)
  ```
  Пак пакует *точные* файлы шрифтов и Phosphor `path d` — не похожие иконки.

- `crates/presentation-dioxus-shell/src/product_shell.rs` — `character_card_description` зеркалит React, `ellipsize_css` (хотя эвристика), `RailSpec` — те же 8 пунктов (Chats/Characters/Personas/Lorebooks/Backgrounds/AI Settings/Plugins/Settings).

- `crates/presentation-chat/src/session.rs` — `set_safe_area_physical` делит physical px на `hidpi_scale`, зеркалит WebView `cssPx()`.

**Вердикт:** ✅ честно. Ложного `visual parity PASS` нет.

---

## 2. Live backdrop glass — реализация vs ТЗ

### Что требует ТЗ (GateP:P1)

- Настоящий динамический live backdrop glass на capability-qualified devices.
- Nested glass в поддерживаемых комбинациях.
- Glass над scrolling content, над sampleable video/plugin output.
- Clip/transform/opacity correctness, rotation/resize, color-space/alpha.

### Как сделано

**Display list:**
```rust
// crates/neocompositor/src/display_list.rs
pub enum NeoPaintOp {
  BeginEffectScope(EffectScopeId),
  EndEffectScope(EffectScopeId),
  PaintChunk(PaintChunk),
  BackdropBarrier(GlassBoundary), // ← live glass
  TextFragment(...), Selection(...), Image(...), ...
}
pub struct GlassBoundary {
  pub id: BarrierId,
  pub spatial_node: SpatialNodeId,
  pub clip_chain: ClipChainId,
  pub effect_node: EffectNodeId,
  pub backdrop_root: BackdropRootId,
  pub roi: Rect,
}
```

**Pass graph:**
```rust
// pass_graph.rs
BackdropBarrier → CompiledPass::Glass { barrier, open_scopes }
```
`barriers_cut_raster_runs` — ни один raster pass не содержит чанков с обеих сторон барьера.

**Effect-scope backdrop:**
- `crates/neocompositor/src/scene.rs` — `NeoScene.glass: Vec<GlassSurface>` собирается из барьеров.
- `docs/architecture/presentation-boundary.md:98-99` — PERF-18 **PASS** на физике (Vulkan, Xiaomi): ancestor opacity/filter/mask wrap prefix+glass+foreground как одна group; backdrop семплируется из parent root; group targets bounded; nested glass acyclic; malformed scopes → last-known-good.

**Временная заглушка в chat route:**
- `presentation-boundary.md:242-243` — `NeoGlass host markers are omitted on this route until opaque screenshots match React.` — т.е. live glass **отключён** на текущем chat-route, пока скриншоты непрозрачные не совпадут. Это честно: статус `DEFERRED (Milestone B/C)` в compatibility matrix.

**Вердикт:** Архитектура glass — ✅ PASS (протокол, pass graph, эффект-скопы). Product glass на chat route — ⚠️ временно отключён (не скрыто).

---

## 3. Design-system pack — баги и хрупкости

### 3.1. Flatten токенов (P1)

**Файл:** `crates/presentation-design-system/src/lib.rs:53-124`

```rust
fn bake_insets(css: &str, insets: SafeAreaInsets) -> String {
  let baked = css
    .replace("var(--nt-inset-top)", &format!("{}px", insets.top))
    .replace("var(--nt-safe-area-top)", ...)
  collapse_max_px(&collapse_calc_px_sum(&baked))
}
fn collapse_two_arg_fn(css: &str, name: &str, combine: fn(f32,f32)->f32) -> String {
  // ищет "max(" строковым find, парсит "left,right" до ')'
}
```

**Проблема:** naive строковый парсер ломается на:
- `max(8px, var(--nt-safe-area-top))` — сейчас покрыто, но `max( var( --x ), 10px )` с пробелами/комментариями — может не совпасть.
- вложенные `calc(calc(8px + 4px) + var(--x))` — срежет только внешний `calc(A+B)`.
- `color-mix()` уже flatten-ится ранее, но будущие `color-mix(in srgb, ...)` сломаются.

**Пример риска:** React добавит `padding: max(16px, calc(var(--nt-safe-area-top) + 8px))` — flatten даст `padding: max(16px, ...` остатки.

**Рекомендация:** использовать `lightningcss` или `cssparser` crate для токенизации; добавить snapshot-тест `product.css` golden (сейчас есть `packed_sheet_keeps_react_tokens_and_module_classes`, но он проверяет наличие строк, не рендер).

### 3.2. Safe-area insets

- `MainActivity.kt:414-418` — `cssPx(physicalPx) = (physicalPx / density).toInt()`, `coerceAtLeast(1)` если physical>0.
- `PresentationChatActivity stashSafeArea/flushSafeArea` — тот же делёж на `density` в Rust `set_safe_area_physical`.

**Баг:** `cssPx` делает целочисленный `toInt()` — теряет дробную часть, на density 2.75 даёт ошибку до 0.36 px. На скриншот-тесте может быть ≤1 dp diff, но на glass ROI — сдвиг на 1 px. Нужен `round` как в `compositor.rs: from_list_scaled`.

### 3.3. Icon `mask-image` → inline SVG (правильно, но хрупко)

`product_shell.rs: icon_fill` — inline `<svg><path d>` с `fill` аргументом, не CSS `mask-image`. Это правильно — `Blitz/Stylo` не красит `mask-image`. Но `phosphor_path("UsersThree")` — строковый lookup; если React сменит иконку на `Users` — Rust не упадёт, но покажет старую.

---

## 4. Скриншот-parity — почему не PASS

- `presentation-boundary.md:258-283` — полная история «gray veil» (Vello sRGB bytes дважды гамма-корректировались) — починена переходом на non-sRGB swapchain `Rgba8Unorm`. Но даже после починки скриншоты остаются `opaque` без live glass.
- Приёмка parities требует device overlay ≤1 dp diff с подписью owner — не подписано.
- Canary скриншоты делаются на SurfaceView с HiDPI scale; `DisplayMetrics.density` → Blitz `hidpi_scale` — mismatch 1 px уже помечен как «не `NOT_CONNECTED`».

**Итог:** визуальная честность соблюдена; костыли в flatten — не критичный визуальный баг сейчас, но станут им при смене токенов React.

---

## 5. Рекомендации

- Заменить `bake_insets` на CSS-парсер + snapshot golden image test (Playwright `toHaveScreenshot` для Dioxus vs React на одном 1080p).
- Подписать `presentation-compatibility-matrix.md` для Theme/Plugin/i18n перед объявлением `PARITY`.
- Включить glass на chat route только после `opaque screenshots match` — сейчас выключен, это правильно; не включать «для красоты» до parity.
