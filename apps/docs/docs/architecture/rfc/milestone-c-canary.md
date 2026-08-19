---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/rfc/milestone-c-canary.md
---

# Milestone C guarded Dioxus canary

**Status:**

```text
core chat journey batch = PASS
Milestone C = STARTED
cutover = STARTED / CANARY
canary_batch = NOT_RUN
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

Enable once (Xiaomi `8f5c2b7c` only), then use the icon:

```text
adb shell am start -n com.neotavern.mobile/.MainActivity --es com.neotavern.mobile.NEOTA_DIOXUS_SHELL 1
adb shell am force-stop com.neotavern.mobile
adb shell monkey -p com.neotavern.mobile -c android.intent.category.LAUNCHER 1
```

Look for `presentation_renderer=... rust_host_allowed=...` in logcat
(`NeoTavern`). MIUI may hide the tag; dumpsys activity is the fallback.

## Physical canary batch (required to close Milestone C under owner-amended scope)

Not run in this commit. One later Xiaomi batch must PASS all of:

| Case | Expect |
| ---- | ------ |
| Rust launch | `presentation_renderer=DIOXUS reason=canary rust_host_allowed=true`; live Kernel chat |
| process death | same `chatId` / `messageCount` after force-stop |
| upgrade/relaunch | persisted flag relaunches Dioxus without the extra |
| send/reopen | Kernel `messageCount` grows and survives reopen |
| safe mode | `NEOTA_SAFE_MODE=1` → WebView; no Rust host |
| forced init failure | `NEOTA_FORCE_INIT_FAILURE=1` → WebView before `loadLibrary`; kill switch holds |
| flag off | `NEOTA_DIOXUS_SHELL=0` → WebView |
| accessibility fallback | touch exploration on → WebView; Rust host is **not** created |

TalkBack / touch exploration, if enabled for that last case, must be restored
**off** afterwards. Do not treat harness `talkback_journey=SKIPPED` as this
case.

After that batch PASS, Milestone C may close under the owner-amended
scope (native TalkBack still `DEFERRED_BY_OWNER`). Until then:

```text
Milestone C = STARTED
cutover = STARTED / CANARY
canary_batch = NOT_RUN
```
