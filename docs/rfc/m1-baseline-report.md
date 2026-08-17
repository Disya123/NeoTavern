# BaselineReport M-1

**Status:** host M-1 **closed** on 2026-08-17. Device evidence is
**emulator-only** (API 36 `sdk_gphone64_x86_64`, 60 Hz locked). Physical
low/mid and high-refresh references are **BLOCKED** (none attached on
2026-08-17 evening). This is **not** Gate P and **not** a Track D GO.
RFC §44: emulator does not replace real-device GPU. High-refresh reference =
`DATA REQUIRED`.

**RFC:** [neoui-v4-android-presentation-backend.md](neoui-v4-android-presentation-backend.md)

**APK:** debug `app-debug.apk` 58 337 647 bytes (same binary for A / A0 / B).
Built `pnpm --filter @neotavern/web build` + `cargo ndk` (x86_64 + arm64-v8a)

- `gradle :app:installDebug`.

**Raw dumps:** `apps/android/m1-captures/` (gitignored). Canonical 50 s cold
runs:

- `2026-08-17T11-33-44-682Z-a-cold`
- `2026-08-17T11-34-50-204Z-a0-cold`
- `2026-08-17T11-35-55-053Z-b-cold`

## Protocol

1. Build one APK (`pnpm --filter @neotavern/web build`, JNI libs, then
   `gradle -p apps/android :app:assembleDebug`). Do not mix debug/release
   across tracks.
2. Install on the device set: one low/mid Android from current support, one
   high-refresh reference. A known-bad OEM is optional and must not extend
   M-1.
3. Cold: `am force-stop`, start with extras, wait **50 s** (covers ~4 s
   `onPageFinished` + 30 s sampler). Warm resume does **not** re-run
   `onCreate` / `onPageFinished`, so rAF / Choreographer are cold-only.
4. Helper:

```sh
node scripts/m1-android-capture.mjs --track a --phase cold
node scripts/m1-android-capture.mjs --track a0 --phase cold
node scripts/m1-android-capture.mjs --track b --phase cold
```

Input-to-present is **not** the rAF sampler. This run did not capture
Perfetto.

### Track launches (opt-in extras; production default is A)

```sh
# A — current WebView + live glass + file://
adb shell am start -n com.neotavern.mobile/.MainActivity \
  -e com.neotavern.mobile.MEASUREMENT_FRAMES on

# A0 — glass off, still file://
adb shell am start -n com.neotavern.mobile/.MainActivity \
  -e com.neotavern.mobile.MEASUREMENT_GLASS off \
  -e com.neotavern.mobile.MEASUREMENT_FRAMES on

# B — WebViewAssetLoader HTTPS origin, live glass
adb shell am start -n com.neotavern.mobile/.MainActivity \
  -e com.neotavern.mobile.MEASUREMENT_ORIGIN asset-loader \
  -e com.neotavern.mobile.MEASUREMENT_FRAMES on
```

Do not ship A0 or B as the launcher default.

## Device set

| Role           | Device / OS / WebView (`m1-env`)                                                                            | Notes                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| emulator       | `sdk_gphone64_x86_64` / Android 16 SDK 36 / WebView `com.google.android.webview:150.0.7871.184` / 1080×2400 | AVD `Medium_Phone_API_36.1`. `supportedModes` id=1 @ 60.000004 Hz only.                                          |
| low/mid        | —                                                                                                           | **BLOCKED** — none attached 2026-08-17 evening (`adb devices` = emulator only) |
| high-refresh   | —                                                                                                           | **BLOCKED** — none attached. AVD: `mRefreshRateChangeable=false` |
| OEM (optional) | —                                                                                                           | not used                                                                                                         |

## Results

Idle HostConnect (not a scrolling chat fixture). Swipes during capture did not
produce a large gfxinfo frame count. Compare A/A0/B rAF on this AVD only.

| Field                                                   | A cold                                                 | A warm                      | A0 cold                                        | A0 warm                     | B cold                                                                                        | B warm                      |
| ------------------------------------------------------- | ------------------------------------------------------ | --------------------------- | ---------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------- | --------------------------- |
| supported_modes (`m1-refresh`)                          | `[1:60.000004:1080x2400]`                              | n/m resume                  | same                                           | n/m resume                  | same                                                                                          | n/m resume                  |
| requested_frame_rate                                    | 60.000004 (`already-max`); `view_frame_rate=60.000004` | n/m resume                  | 60.000004 (`already-max`)                      | n/m resume                  | 60.000004 (`already-max`); `view_frame_rate=60.000004`                                        | n/m resume                  |
| observed_display_mode                                   | mode 1 / 60.000004 Hz                                  | n/m resume                  | mode 1 / 60.000004 Hz                          | n/m resume                  | mode 1 / 60.000004 Hz                                                                         | n/m resume                  |
| rAF callback_hz / misses / longest_streak (`m1-frames`) | 57.51 / 77 / 63 (30.015 s, 1726 frames)                | n/m — sampler not restarted | 57.79 / 67 / 60 (30.005 s, 1734 frames)        | n/m — sampler not restarted | 57.61 / 75 / 60 (30.013 s, 1729 frames)                                                       | n/m — sampler not restarted |
| UI-thread Choreographer (`m1-choreographer`)            | 57.67 / 73 / 63                                        | n/m                         | 57.87 / 65 / 60                                | n/m                         | 57.33 / 81 / 60                                                                               | n/m                         |
| gfxinfo jank / missed vsync                             | 16 frames, 13 janky (81.25%), missed 5, p90 950ms      | n/m                         | 9 frames, 9 janky (100%), missed 6, p90 1100ms | n/m                         | 12 frames, 10 janky (83.33%), missed 6, p90 850ms                                             | n/m                         |
| startup to onPageFinished (`m1-startup`)                | 4210 ms                                                | n/m                         | 3120 ms                                        | n/m                         | 3411 ms                                                                                       | n/m                         |
| input-to-present                                        | not-measured (no Perfetto)                             | not-measured                | not-measured                                   | not-measured                | not-measured                                                                                  | not-measured                |
| live/static/no-glass semantic (`m1-glass`)              | Live                                                   | n/m                         | Off                                            | n/m                         | Live                                                                                          | n/m                         |
| origin (`m1-origin`)                                    | file                                                   | file                        | file                                           | file                        | https `appassets.androidplatform.net/assets/web/index.html` (AssetLoader served the document) | https                       |
| thermal start/end (`m1-thermal`)                        | apply=0 / observed=0                                   | n/m                         | apply=0 / observed=0                           | n/m                         | apply=0 / observed=0                                                                          | n/m                         |
| refresh downgrade during run                            | none (single 60 Hz mode)                               | n/m                         | none                                           | n/m                         | none                                                                                          | n/m                         |
| memory (`m1-memory`)                                    | avail 665 / total 1965 MB, low=false                   | n/m                         | avail 636 / total 1965 MB, low=false           | n/m                         | avail 633 / total 1965 MB, low=false                                                          | n/m                         |
| APK/startup delta vs A                                  | —                                                      | —                           | same APK; startup −1090 ms                     | —                           | same APK; startup −799 ms                                                                     | —                           |
| known limitations                                       | 60 Hz AVD; gfxinfo idle; rAF ≠ compositor              | resume skips onCreate       | glass-off vs live delta is noise on this AVD   | resume skips onCreate       | Track B **loaded** without SPA rewrite; FPS ≈ A on this 60 Hz AVD                             | resume skips onCreate       |

## Implementation effort actually spent

| Slice                        | Spent                        | Notes                                                                                        |
| ---------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------- |
| Track A high-refresh request | host always-on + API 35 vote | On this AVD the only mode is 60 Hz (`already-max`). Request ≠ higher rate.                   |
| Track A0 glass-off           | opt-in extra                 | `m1-glass=Off` confirmed. rAF 57.79 vs A 57.51 — not a product-level live-glass cost on AVD. |
| Track B AssetLoader          | opt-in extra                 | Document URL served. SPA HashRouter / `isPackagedWebView` already knew the host.             |
| Frame / env telemetry        | rAF + Choreographer + env    | Application callback rate, not input-to-present.                                             |
| Capture script               | `m1-android-capture.mjs`     | Default wait 50 s; JSON summary preferred over the sampler start line.                       |
| Device capture               | 2026-08-17 emulator-5554     | Three 50 s cold tracks. No physical low/mid or high-refresh phone.                           |

## Findings for Gate P (still not a decision)

- Live glass vs glass-off did **not** show a large rAF gap on this 60 Hz
  emulator. That does **not** answer the original high-refresh phone question.
- Track B is a viable measurement path (HTTPS origin works). It is not a
  compositor upgrade.
- High-refresh `preferredDisplayModeId` cannot be proven here:
  `supported_modes` has one 60 Hz mode.
- gfxinfo on idle HostConnect is not a scroll/animation fixture.

## Gate P input (not a decision)

```text
decision:
owner:
date:
input evidence: BaselineReport M-1 (emulator-only, 2026-08-17)
qualified device definition:
allowed degraded semantics:
critical Android journeys:
budget/capacity ceiling:
revisit/kill trigger:
```

Empty `decision` / `owner` / `date` means Gate P is still `UNDECIDED`. Track D
stays forbidden until that record exists.

Unsigned draft with a technical recommendation (still not a signature):
[gate-p-decision-draft.md](gate-p-decision-draft.md).

## Session 2 — 2026-08-17 evening (physical BLOCKED; AVD recapture)

`adb devices -l` listed only `emulator-5554` (`sdk_gphone64_x86_64`,
Android 16 / SDK 36). **No physical low/mid phone and no high-refresh
reference.** RFC minimum device set is therefore **BLOCKED**.

The APK on the emulator was **not** the canonical 58 337 647-byte fixture:

| Field | Canonical morning fixture | Evening installed APK |
| --- | --- | --- |
| bytes | 58 337 647 | 44 432 284 |
| SHA-256 | not recorded in the morning report | `A661693E006827C64654134053027C85F2A66AB5DA4F9E493DEB26EFA484BAEB` |
| path | `app-debug.apk` from `assembleDebug` | pulled `pm path` `base.apk` |

Evening A/A0/B cold runs (50 s helper, same AVD, **different APK**, not a
replacement of the morning table):

- `2026-08-17T14-03-26-278Z-a-cold`
- `2026-08-17T14-04-29-858Z-a0-cold`
- `2026-08-17T14-05-33-456Z-b-cold`

| Field | A cold (evening) | A0 cold (evening) | B cold (evening) |
| --- | --- | --- | --- |
| origin | `file:///android_asset/web/index.html` | file `#/home` | `https://appassets.androidplatform.net/assets/web/index.html` then `#/chats/…` |
| glass | Live | Off | Live |
| rAF callback_hz / misses / streak | 59.56 / 15 / 15 | 56.6 / 104 / 45 | 58.61 / 44 / 5 |
| Choreographer | 59.53 / 15 / 15 | 57.27 / 83 / 39 | 59.13 / 28 / 4 |
| gfxinfo total / janky | 21 / 8 (38.10%) | 779 / 89 (11.42%) | 1278 / 154 (12.05%) |
| startup ms | 4155 | 29984 (late `onPageFinished` after hash navigation) | 15625 |
| thermal | 0 | 0 | 0 |
| memory avail/total MB | 678 / 1965 | 690 / 1965 | 698 / 1965 |

Do **not** treat A vs A0 vs B deltas here as a live-glass cost: the three
tracks did not stay on the same screen (HostConnect vs Home vs an open chat).
High-refresh and physical GPU remain `DATA REQUIRED`.

