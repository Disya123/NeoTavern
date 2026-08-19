---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/rfc/milestone-c-canary.md
---

# Milestone C guarded Dioxus canary

**Status:**

```text
core chat journey batch = PASS
host canary = HOST_CANARY_PASS   # 60a4d6a
NeoCompositor product SurfaceView = CONNECTED
compositor-driven smooth scroll = PENDING_PHYSICAL
Milestone C = STARTED
cutover = STARTED / CANARY
canary_batch = PASS
```

This is **not** RFC §51 PASS and **not** an unguarded production cutover.
WebView stays in the APK. Native Dioxus TalkBack stays
`DEFERRED_BY_OWNER`; the product accessibility path is
`WEBVIEW_FALLBACK` ([ADR-0051](../adr/0051-android-talkback-webview-fallback.md)).

The successful harness stamp `2026-08-19T10-29-35-149Z` remains
`canary=false` in
[`milestone-c-adjudication.json`](https://github.com/Disya123/NeoTavern/blob/main/docs/rfc/milestone-c-adjudication.json). Do not
rewrite that record.

Machine record: [`milestone-c-canary.json`](https://github.com/Disya123/NeoTavern/blob/main/docs/rfc/milestone-c-canary.json)

## Selector (`MainActivity`)

Runs **before** WebView creation, Kernel acquire, and
`System.loadLibrary("neotavern_presentation_chat")`:

```text
safe mode
∨ crash-loop breaker
∨ accessibility / touch exploration
∨ unqualified GPU/device
∨ flag off
    → WebView

else
    → Dioxus/Rust chat (`PresentationChatActivity`)
```

```text
TalkBack / touch exploration enabled → WebView rollback
TalkBack disabled + qualified device + canary flag → Dioxus/Rust
```

Guarantees:

- persisted kill switch (`neotavern_presentation_canary`);
- rollback after Rust-host initialization failure (kill switch, then WebView);
- crash-loop counter (3 failed Dioxus starts without a ready route);
- notification tap opens `MainActivity` with the last Kernel `chatId`;
- Kernel/store are shared (`KernelHost` + `filesDir/neotavern`);
- renderer switch does not duplicate or drop durable messages;
- production APK packages `libneotavern_presentation_chat.so` next to kernel JNI;
- WebView is not removed.

Default remains WebView. In a **debuggable** build, `NEOTA_DIOXUS_SHELL=1`
commits an app-private opt-in (`commit()`, not async `apply()`);
`NEOTA_DIOXUS_SHELL=0` clears it. Later launcher / notification / deep-link
starts use that opt-in and do not need the extra. Safe mode, crash-loop,
TalkBack / touch exploration, and an unqualified device still select
WebView. Release ignores these extras and waits for a signed rollout
config. Isolated 10k is a debug harness profile and is not the canary store.

## Lab extras

| Extra | Effect |
| ----- | ------ |
| `com.neotavern.mobile.NEOTA_DIOXUS_SHELL=1` | debug only: persist opt-in; selector may choose Dioxus |
| `com.neotavern.mobile.NEOTA_DIOXUS_SHELL=0` | debug only: persist opt-in off → WebView |
| `com.neotavern.mobile.NEOTA_SAFE_MODE=1` | WebView this launch |
| `com.neotavern.mobile.NEOTA_FORCE_INIT_FAILURE=1` | arm kill switch **before** `loadLibrary` → WebView |
| `com.neotavern.mobile.NEOTA_CANARY_RESET=1` | clear kill switch and crash-loop counter |
| `com.neotavern.mobile.NEOTA_CHAT_ID` | same Kernel chat across renderers |
| `com.neotavern.mobile.NEOTA_SOFTWARE_RASTER_DEBUG=1` | CPU Vello only (not production/canary) |

Enable once (Xiaomi `8f5c2b7c` only), then use the icon:

```text
adb shell am start -n com.neotavern.mobile/.MainActivity --es com.neotavern.mobile.NEOTA_DIOXUS_SHELL 1
adb shell am force-stop com.neotavern.mobile
adb shell monkey -p com.neotavern.mobile -c android.intent.category.LAUNCHER 1
```

Look for `presentation_renderer=... rust_host_allowed=...` in logcat
(`NeoTavern`). MIUI may hide the tag; dumpsys activity is the fallback.

Physical stamp `2026-08-19T11-20-00-000Z` on Xiaomi `8f5c2b7c` after
`cef4f8f` (debug opt-in persist): all eight canary cases **PASS**. That
stamp is **`HOST_CANARY_PASS`** (source commit `60a4d6a` keeps the same
selector / Kernel / rollback proof). It does **not** prove GPU-renderer
cutover.

The live canary host now creates a NeoCompositor `SurfaceView`. Runtime
logs `host=neocompositor-surfaceview backend=Vulkan product_wire=live
producer=dioxus+blitz renderer=vello-gpu devices=1 cpu_full_frame_raster=0
image_readbacks=0 cross_device_copies=0 sampled_output=true`. Paint uses
`DisplayMetrics.density` so CSS chrome is not 1:1 with the SurfaceView
pixel size; a density-1 dump (tiny top-left glyphs, no header/composer
fill) is a HiDPI miss, not `NOT_CONNECTED`. Physical compositor scroll
(`composite_only_frames > 0`, `layout_rebuilds_on_scroll = 0`) is
**PENDING_PHYSICAL**. TalkBack was enabled only for accessibility
fallback, then restored **off**.

| Case | Result |
| ---- | ------ |
| Rust launch | PASS — `PresentationChatActivity`, Hazel |
| process death | PASS — icon after force-stop keeps Hazel |
| upgrade/relaunch | PASS — `adb install -r` then persisted icon launch |
| send/reopen | PASS — Hazel 6 → 8, reopen 8 |
| safe mode | PASS — extra → WebView `MainActivity`; next icon Dioxus |
| forced init failure | PASS — WebView before `loadLibrary`; kill holds on icon; reset recovers |
| flag off | PASS — extra `0` + icon stay WebView |
| accessibility fallback | PASS — TalkBack on → WebView, Rust host not created |

RFC §51 residual items (i18n/theme/plugin/no-WebView renderer) stay open.
Owner may close Milestone C under the amended scope (native TalkBack
`DEFERRED_BY_OWNER`, product a11y `WEBVIEW_FALLBACK`).
