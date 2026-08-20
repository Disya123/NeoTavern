# GPU interop: no readback / no cross-device copies

## Инвариант ТЗ

- Один `Instance/Adapter/Device/Queue` на процесс.
- Blitz/Vello растер биндит тот же контекст, не открывает второй device.
- Raster tiles, accumulator, glass ROI, surface — один `DeviceEpoch`.
- Typed GPU handles reject foreign/stale owners before submit.
- Raster output — sampleable compositor texture: `image_readbacks=0`, `cross_device_copies=0`.
- Timestamp queries — capability-gated, `GpuTiming::Unavailable` или bounded async resolve, не блокируют present.

---

## Реализация

### 1. `crates/neocompositor/src/shared_device.rs` — CPU-протокол

```rust
pub struct SharedGpuContext {
  identity: DeviceIdentity(1),
  epoch: DeviceEpoch(0),
  format: SharedFormat {
    color_space: Srgb,
    alpha_mode: Premultiplied,
    texture_format: Rgba8Unorm, // non-sRGB, premultiplied
    usage: SAMPLE | RENDER | COPY_SRC // но не CPU_READBACK
  },
  caps: GpuCaps { compute: true, timestamp_queries: false, .. },
  host: PresentationHost::NeoCompositor { feature_flag: true },
  raster: Option<BoundBackend>,
  compositor: Option<BoundBackend>,
  live: Vec<TypedGpuHandle>,
  inflight: VecDeque<InFlight>,
}
```

Ключевые ошибки (все `Err` до submit):
```rust
pub enum SharedGpuError {
  SecondDevice, Unsupported, Degraded, StaleEpoch,
  ForeignDevice, ForeignOwner, QueueSaturated, LiveHandleCap,
  CpuReadbackForbidden, CrossDeviceCopyForbidden,
  PollWaitForbidden, MixedEpoch,
}
```

Методы, нарушающие инвариант, сразу падают:
```rust
fn image_readback(&self) -> Err(CpuReadbackForbidden)
fn cross_device_copy(&self) -> Err(CrossDeviceCopyForbidden)
fn poll_wait_in_present(&self) -> Err(PollWaitForbidden)
```

`format_is_explicit_and_forbids_cpu_readback` — тест `shared_device.rs:229-244` проверяет `!usage.contains(CPU_READBACK)`.

### 2. `crates/presentation-chat/src/android_surface.rs` — живой Vulkan host

```rust
// android_surface.rs:180-240 (упрощено)
let instance = wgpu::Instance::new(InstanceDescriptor {
  backends: VULKAN | GL, ..
});
let adapter = instance.request_adapter(...).await; // skip_emulator_vulkan
let (device, queue) = request_vello_device(&adapter)?; // Limits::default first
let shared = SharedGpuContext::open_with_identity(identity, caps)?;
shared.bind_raster()?; shared.bind_compositor()?;
```

`request_vello_device` — `wgpu::Limits::default()` first, fallback `adapter.limits()` только если default не подошёл (тот же запрос, что M0-D1a).

**Swapchain формат:** `plan_vello_target(features)` требует `Rgba8Unorm` с `STORAGE_WRITE_ONLY` + `TEXTURE_BINDING` + `COPY_SRC|DST` или `STORAGE_READ_ONLY`. Если формат не подходит — `Err("...cannot GPU-copy or storage-convert")`. Non-sRGB chosen сознательно — чтобы Vello sRGB bytes не гамма-корректировались дважды (бывший «gray veil»).

**Present path:**
```rust
// vello_gpu.rs: production_host_line(...)
format!("host=neocompositor-surfaceview backend={} ... devices=1 ... cpu_full_frame_raster=0 image_readbacks=0 cross_device_copies=0 sampled_output=true")
```

В `android_surface.rs` логируется та же строка на каждый `attachSurface` и `presentFrame`.

### 3. Vello storage → sampled texture (без CPU)

```rust
// vello_gpu.rs: VelloTargetPlan
pub enum ConvertMode { Copy, Compute }
pub fn gpu_storage_to_sampled(
  device, queue, storage_texture, sampled_texture, plan, encoder
) -> Result<(), String> {
  match plan.convert {
    Copy => encoder.copy_texture_to_texture(...),
    Compute => { encoder.dispatch(ComputePipeline { CONVERT_WGSL }) }
  }
}
```

- Copy путь — `copy_texture_to_texture` внутри одного device, одного queue — **не** cross-device.
- Compute путь — `texture_storage_2d<rgba8unorm, read> → texture_storage_2d<rgba8unorm, write>` — остаётся на GPU.

**Не CPU readback:** `vello_diag::peek_texture_rgba` существует, но вызывается только в диагностических `resolution_ladder` / `bisection` на first bind, не в `present`. В `android_surface.rs` есть `device.poll(wait)` только как `diagnostic-only` (комментарий в boundary.md: «Bind logs render_to_texture Result, wgpu error scopes, uncaptured errors, and submit-done; `device.poll(wait)` is diagnostic-only.»).

### 4. Тесты

`crates/neocompositor/tests/shared_device.rs` — 10 тестов, ключевые:

- `context_and_device_are_created_once` — второй `open` → `SecondDevice`
- `vello_and_compositor_see_the_same_device_identity` — `identity` и `epoch` совпадают
- `current_epoch_tile_is_accepted_foreign_and_stale_are_rejected` — `ForeignDevice` / `StaleEpoch` после `on_device_lost`
- `dropped_transaction_holds_lease_until_gpu_completion` — `lease_held` после `drop_pending_latest_wins`, снятие только после `complete_oldest`
- `queue_saturation_does_not_block_present` — `QueueSaturated` не блокирует `present`, `PollWaitForbidden`
- `ten_thousand_frames_do_not_grow_live_textures_or_targets` — 10k кадров, `live_textures_high_water ≤1`, `devices==1`
- `format_is_explicit_and_forbids_cpu_readback` — `image_readback()==CpuReadbackForbidden`

---

## Проверка на нарушения

| Проверка | Результат | Доказательство |
|---|---|---|
| Есть ли `map_async`/`read_buffer`/`get_mapped_range` в present? | ❌ Нет | Греп по `readback|map_async|get_mapped` в `android_surface.rs` — только в `vello_diag::peek_texture_rgba` (диагностика) |
| Есть ли второй `Instance::new`/`request_adapter` после первого? | ❌ Нет | `SharedGpuFactory.devices_created()` счётчик, второй `open` → `SecondDevice` |
| Есть ли `COPY_SRC` с `CPU_READBACK` флагом? | ❌ Нет | `DEFAULT_FORMAT.usage` не содержит `CPU_READBACK`; `SharedGpuContext::open` проверяет |
| Есть ли `device.poll(true)` в present loop? | ❌ Нет | `poll_wait_in_present()` → `PollWaitForbidden`; реальный `device.poll(wait)` только в `android_surface` диагностике |
| Аватары идут через CPU readback? | ❌ Нет | `avatar_gpu.rs` — `queue.write_texture` upload, затем sampled overlay; не `readback` |

---

## Остаточные риски

1. **Emulator Vulkan skip** — `skip_emulator_vulkan` по подстроке, не по `device_type`. Если OEM назовёт Vulkan `swiftshader-like`, будет пропуск hardware.
2. **Tiled raster diagnostic** — первый bind делает `resolution ladder` с несколькими пробными растрами разных размеров. Это не readback, но тратит GPU время на первом кадре — может дать 1-frame hitch, не критично.
3. **`wgpu::Backends::GL` fallback** — `InstanceDescriptor { backends: VULKAN | GL }` может выбрать GL на старых устройствах. GL path не тестирован на PERF-01…22 (только Vulkan Xiaomi). Нужен `GLES` adjudication или явный `Vulkan required`.

---

## Вердикт

✅ **PASS.** No image readback, no cross-device copies в production path. Протокол и живой host соблюдают инвариант. Единственный readback — диагностический, gated.
