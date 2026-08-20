# Производительность: 120 Hz present loop и compositor fast paths

## 1. Present loop — дизайн на 8.33 мс

**Цель ТЗ:** `One refresh interval при 120 Hz ≈ 8.33 ms. Production renderer MUST проектироваться исходя из этого budget с первого milestone.`

### Как реализован

**MainActivity (WebView) — для сравнения:**
```kotlin
// MainActivity.kt:446-536
applyPreferredDisplayMode() → DisplayRefreshPolicy.chooseHighestRefresh(supportedModes, current)
→ window.attributes.preferredDisplayModeId = requestedModeId
→ web.setRequestedFrameRate(hz) // API35+, иначе HIGH
```
Логирует `m1-refresh phase=apply/observed`, `m1-env`, `m1-thermal`, `m1-choreographer` (UI thread `Choreographer.FrameCallback` — не present loop).

**Rust canary — настоящий present loop:**
```kotlin
// PresentationChatActivity.kt:596-687
startPresentLoop() → HandlerThread("neocompositor-chat") + Choreographer.VsyncCallback (API33+)
  → preferredFrameTimeline.vsyncId / deadlineNanos / expectedPresentationTimeNanos
  → adapter.applyCompositorFrameTimeline(...)
  → PresentationChatNative.presentFrame(vsyncId, frameTimeNanos, deadlineNanos, expectedPresentTime)
  → adapter.markCompositorPresented(uptimeNanos)
→ postVsyncCallback / postFrameCallback по кругу
```

```rust
// crates/presentation-chat/src/android_surface.rs:596-700 (упрощено)
GpuHost::present(timeline) → shared.present()? → InteropPresentOutcome
→ trace!("host=neocompositor-surfaceview present vsync=... cpu_full_frame_raster=0 ...")
```

### Физические измерения

- `docs/rfc/m0-track-comparison.md:51` — Xiaomi D2 probe: `requested 120.00001 Hz mode 2, observed 120.00001 Hz mode 2`
- `docs/rfc/milestone-b-exit.json` — `input_to_present_p99_ns: 20646128` (20.65 мс) помечено `reference-device-baseline`, не бюджет; `release_budget_calibration_adr: null`
- `docs/architecture/presentation-boundary.md:125-133` — явное предупреждение: «Raw p99 is a baseline, not a release budget, until a calibration ADR lands.»

**Вердикт:** ✅ дизайн PASS, **метрический PASS — нет**. Следующий шаг — калибровочный ADR, который установит *release* бюджет (не `Choreographer#doFrame`).

### Что не измерено

- `composite_only_frames > 0, layout_rebuilds_on_scroll == 0` — `PENDING_PHYSICAL` в `milestone-c-canary.md:48`. Host corpus `presentation-session/tests/product_path_perf.rs` — не independent PASS.
- Thermal/power snapshot при 120 Hz — есть `logMeasurementThermal`, но не в составе canary adjudication.
- Low-tier device (weak Android GPU) — отсутствует в matrix; GateP:P1 допускает degraded semantics, но они не измерены.

---

## 2. Fast paths: scroll / transform / opacity / glass

### Инвариант

> Scroll, transform, opacity, glass и другие compositor-анимации не должны вызывать Dioxus/layout/shaping/raster.

### Реализация

**`crates/neocompositor/src/fast_path.rs`**
```rust
pub struct CompositorFastPath {
  snapshot: Option<Arc<PropertySnapshot>>,
  sampled: Option<SampledFrame>,
  scrolls: ScrollTable, animations: AnimationTable, ...
}
impl CompositorFastPath {
  pub fn present(&mut self, time: PresentationTime) -> PresentOutcome {
    // No allocation, no mailbox lock, no producer callback, no raster invalidation.
  }
}
```

**`crates/neocompositor/src/scroll.rs`**
- `AsyncScrollState { committed_offset, unacked_delta, screen_velocity, bounds }`
- `visual_offset = committed_offset + unacked_delta`
- `consume_delta` — clamp к `ScrollRange`, возвращает неиспользованный `unused` для handoff к outer scroll.
- `ack()` — rebase без телепорта: `committed_offset = clamp(base_offset)`, `unacked = visual - committed`.

**`crates/neocompositor/src/animation.rs`**
```rust
pub enum AnimationProperty { Translation(SpatialId), Opacity(EffectId), Width, Height, Color, FontSize, GlyphOffset }
impl AnimationProperty {
  pub fn compositor_sampleable(self) -> bool {
    matches!(self, Self::Translation(_) | Self::Opacity(_))
  }
}
```
Width/Height/Color/FontSize/GlyphOffset → `Err(NeedsProducer)` и `producer_requests +=1`. Правильно.

**`crates/neocompositor/src/property_tree.rs`**
- `SpatialKind::Scroll/Sticky/Fixed` — per-node, не global delta. `Sticky` получает `constraint_rect` + `valid_scroll_range`, `Fixed` — `containing_block`.

**Доказательство отсутствия Dioxus/layout в present:**

Тест `tests/fast_path.rs: ten_thousand_frames_do_not_call_producer_or_raster`:
```rust
for i in 0..10_000 {
  path.nudge(outer, Vec2(0.0,0.05), ScrollSequence(i+1), time).unwrap();
  let outcome = path.present(time);
  assert_eq!(outcome.raster, RasterDecision::CompositeOnly);
}
assert_eq!(path.producer_requests(), 0);
assert_eq!(path.raster_invalidations(), 0);
assert_eq!(sampled.worlds_ptr(), ptr); // no re-alloc
```

**Проверка glass:**
- `NeoDisplayList` — `GlassBoundary` как `BackdropBarrier` в paint order, между `PaintChunk`ами.
- `pass_graph.rs: compile_passes` — `Barrier` → `Glass { open_scopes }`, мерж через барьер запрещён. Тесты `effect_scope.rs` проверяют `opacity 0.5 + Glass` — backdrop семплируется до применения group opacity.

**Вердикт:** ✅ PASS. Архитектура fast path соблюдена; багов «scroll вызывает layout» не найдено. Остаётся проверить физический след: `layout_rebuilds_on_scroll` должен оставаться 0 при флинге.

---

## 3. Потенциальные перф-регрессии (не баги, но watch)

| № | Файл | Риск | Пояснение |
|---|---|---|---|
| 3.1 | `chat-viewport/src/tiles.rs` + `session.rs` | Предсказание overscan может не успеть при быстром флинге | Predictor использует `PREDICTOR_BUDGETS` (viewport_h, 8 ms). Если бюджет занижен, при выходе за prepared range появится `PENDING_PHYSICAL` gap (spec §2.1 запрещает «uninitialized gap»). Текущий `PROTECTED_BAND_PX` и `GeometryDebtLedger` частично покрывают. |
| 3.2 | `presentation-session/src/lib.rs` | `TileCache::new(256, 4MiB)` — entry cap без bytes pressure интеграции | При 10k виртуальных чатов 256 tiles может быть мало; pressure controller в `neocompositor` не связан с tile cache. |
| 3.3 | `PresentationChatActivity.sendComposer` | `pollStream(50)` в цикле 40× на executor — до 2 сек блокирует executor | Долгий `holder.executor` HOL блокирует `chats.list`/`characters.list` на фоне. |

---

## 4. Рекомендации

- Физический прогон `PERF_SCENARIO=scroll` с `FrameTimeline` + `SurfaceFlinger` на Xiaomi, проверка `composite_only_frames` и `damage` bounded.
- Калибровочный ADR: определить release бюджет для 120 Hz (напр., `p95 ≤ 8 ms` compositor-only + `p99 i2p ≤ 16 ms`).
- Связать `TileCache` и `PressureController` — один reclaimed budget.
