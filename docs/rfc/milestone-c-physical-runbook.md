# Milestone C physical journey batch

**Status:** journey batch **FAIL**. Stamp `2026-08-18T21-55-58-696Z` on Xiaomi
`8f5c2b7c` / `23122PCD1G` is a preserved **`FAILED_ATTEMPT`**: live open of
Kernel chat `Hazel` passed, send round-trip did not persist
`messageCount`. RFC §51 Milestone C remains **STARTED**, not PASS.
Compatibility matrix rows stay **DEFERRED**. Production cutover stays
**NOT_STARTED**. Canary on `MainActivity` was **not** enabled.

Do not overwrite that stamp. Later successful batches must keep it in
`failed_attempts`.

Evidence is UIAutomator / dumpsys on the debug harness
`PresentationChatActivity`, not RenderDoc. MIUI does not reliably
surface the `NeoTavern` log tag, so logcat is not the admission path.
Emulators are excluded.

Record: [`milestone-c-adjudication.json`](milestone-c-adjudication.json)

## Required chain

```text
debug APK with libneotavern_presentation_chat.so
→ node scripts/milestone-c-physical-capture.mjs --serial=8f5c2b7c
→ node scripts/milestone-c-physical-adjudicate.mjs --write --evidence=apps/android/milestone-c-captures/STAMP-evidence.json
```

Capture must tap the **Send** button. `KEYCODE_ENTER` does not fire
`IME_ACTION_SEND` on this composer. Do not install on `emulator-*`.
Do not bind this batch as RFC C PASS.

## Honest status after FAILED_ATTEMPT `2026-08-18T21-55-58-696Z`

```text
Milestone C = STARTED
live open = PASS
send round-trip = FAIL
10k physical = NOT_RUN
Gboard environment = READY
Gboard journey = NOT_PROVEN
TalkBack semantics = PASS
TalkBack journey = NOT_PROVEN
cutover = NOT_STARTED
```

## Journeys

| Journey              | Admission                                      | Stamp result                          |
| -------------------- | ---------------------------------------------- | ------------------------------------- |
| flag_off             | composer `enabled=false` without the extra     | PASS                                  |
| live_open            | header `Chat header, Hazel, 0 messages`        | PASS (live Kernel chat, not fixture)  |
| jni_mapped           | live route opened; `/proc/maps` via run-as empty on MIUI | PASS (inferred from live_open) |
| a11y_semantics       | Chat workspace / header / messages / composer  | PASS                                  |
| send                 | Kernel `messageCount` must grow                | FAIL (count stayed 0)                 |
| reopen               | same durable count after close/open            | NOT_RUN on this stamp                 |
| ime                  | default IME is Gboard                          | READY (not a composing journey)       |
| rotate               | live header after `wm set-user-rotation`       | PASS                                  |
| background           | live header after HOME + relaunch              | PASS                                  |
| launcher_untouched   | LAUNCHER resolves to `MainActivity`            | PASS                                  |
| safe_mode            | `NEOTA_SAFE_MODE=1` resumes `MainActivity`     | PASS                                  |
| 10k messages         | isolated Kernel store + same Wire route        | NOT_RUN on this stamp                 |
| compositor SurfaceView chat | —                                         | not this harness                      |

## Not claimed

- RFC §51 DoD (i18n/RTL, Theme SDK v2, plugin matrix, no-WebView renderer)
- owner-signed PARITY
- production `MainActivity` canary
- Gboard composing-region / editor-actions / inset corpus
- TalkBack focus traversal, scroll/click actions, streaming announcement
