# Milestone C physical journey batch

**Status:** journey batch **PASS**. Successful stamp `2026-08-19T10-29-35-149Z`
on Xiaomi `8f5c2b7c` / `23122PCD1G`. Stamp `2026-08-18T21-55-58-696Z` stays a
preserved **`FAILED_ATTEMPT`** in `failed_attempts` (live open of Kernel chat
`Hazel` passed, send round-trip did not persist `messageCount`). RFC §51
Milestone C remains **STARTED**, not PASS. Compatibility matrix rows stay
**DEFERRED**. Production cutover stays **NOT_STARTED**. Canary on
`MainActivity` was **not** enabled.

Do not overwrite the failed stamp. Later successful batches must keep it in
`failed_attempts`.

TalkBack was **not** enabled on this batch (operator waived).
`talkback_journey` is **SKIPPED**, not PASS, and is not a journey-batch gate.

Evidence is UIAutomator / dumpsys / InputConnection markers on the debug
harness `PresentationChatActivity`, not RenderDoc. MIUI does not reliably
surface the `NeoTavern` log tag, so logcat is not the admission path.
Emulators are excluded.

Record: [`milestone-c-adjudication.json`](milestone-c-adjudication.json)

## Required chain

```text
debug APK with libneotavern_presentation_chat.so
→ node scripts/milestone-c-physical-capture.mjs --serial=8f5c2b7c
→ node scripts/milestone-c-physical-adjudicate.mjs --write --evidence=apps/android/milestone-c-captures/STAMP-evidence.json
```

Gboard is driven by tapping Gboard keys, not `adb input text`, Espresso
`typeText`, or a direct InputConnection call. Do not enable TalkBack. Do not
install on `emulator-*`. Do not bind this batch as RFC C PASS.

## Honest status after successful stamp `2026-08-19T10-29-35-149Z`

```text
Milestone C = STARTED
journey_batch = PASS
send_round_trip = PASS
physical_10k = PASS
gboard_environment = READY
gboard_journey = PASS
talkback_semantics = PASS
talkback_journey = SKIPPED
lifecycle = PASS
safe_mode = PASS
cutover = NOT_STARTED
canary = false
```

## Journeys (successful stamp)

| Journey              | Admission                                      | Stamp result                          |
| -------------------- | ---------------------------------------------- | ------------------------------------- |
| flag_off             | composer `enabled=false` without the extra     | PASS                                  |
| live_open            | header `Chat header, Hazel, N messages`        | PASS (live Kernel chat, not fixture)  |
| jni_mapped           | live route opened; `/proc/maps` via run-as empty on MIUI | PASS (inferred from live_open) |
| a11y_semantics       | Chat workspace / header / messages / composer  | PASS                                  |
| send                 | Kernel `messageCount` grew via Gboard SEND     | PASS (4 → 6)                          |
| reopen               | same durable count after close/open            | PASS                                  |
| ime                  | default IME is Gboard                          | READY                                 |
| gboard_journey       | Gboard keys; IC `commitText` / `deleteSurroundingText` / `performEditorAction SEND`; inset show/hide | PASS |
| rotate               | live header after `wm set-user-rotation`       | PASS                                  |
| background           | live header after HOME + relaunch              | PASS                                  |
| launcher_untouched   | LAUNCHER resolves to `MainActivity`            | PASS                                  |
| safe_mode            | `NEOTA_SAFE_MODE=1` resumes `MainActivity`     | PASS                                  |
| 10k messages         | isolated Kernel store + same Wire route        | PASS (`Isolated 10k` / 10000)         |
| talkback_journey     | TalkBack enable/focus/scroll/click             | SKIPPED (operator waived)             |
| compositor SurfaceView chat | —                                         | not this harness                      |

This device's Gboard Alphabet/Russian layout commits letters through
`commitText` rather than `setComposingText`. Admission accepts that IC
corpus when `deleteSurroundingText` and `performEditorAction SEND` are also
present. `Gboard environment=READY` alone is not a Gboard journey.

## Not claimed

- RFC §51 DoD (i18n/RTL, Theme SDK v2, plugin matrix, no-WebView renderer)
- owner-signed PARITY
- production `MainActivity` canary
- TalkBack focus traversal, scroll/click actions, streaming announcement as a proven journey
