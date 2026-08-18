---
editUrl: https://github.com/Disya123/NeoTavern/edit/main/docs/rfc/remaining-b-physical-runbook.md
---

# Remaining Milestone B physical batch

**Status:** fixtures implemented, **not adjudicated**. Milestone B remains
**STARTED**. `almost_pass=false`. Production cutover remains
**NOT_STARTED**. Host corpora from
`scripts/presentation-perf-bench-runner.mjs` are **not** independent PASS.

Independent records are written only after a BOUND debug APK capture on
Xiaomi `8f5c2b7c` / Vulkan. Do not commit these JSON files from host
logs.

| Criterion | Record path after capture | Physical fixture |
| --- | --- | --- |
| PERF-01 | `docs/rfc/perf-01-adjudication.json` | `perf01-warm` + `perf01-cold` |
| PERF-02 | `docs/rfc/perf-02-adjudication.json` | `perf02` |
| PERF-03 | `docs/rfc/perf-03-adjudication.json` | `perf03` RenderDoc |
| PERF-04 | `docs/rfc/perf-04-adjudication.json` | `perf04` RenderDoc |
| PERF-05 | `docs/rfc/perf-05-adjudication.json` | `perf05` |
| PERF-11 | `docs/rfc/perf-11-adjudication.json` | `perf11` RenderDoc |
| PERF-12 | `docs/rfc/perf-12-adjudication.json` | `perf12` |
| PERF-13 | `docs/rfc/perf-13-adjudication.json` | `perf13` |
| PERF-14 | `docs/rfc/perf-14-adjudication.json` | `perf14` |
| PERF-16 | `docs/rfc/perf-16-adjudication.json` | `perf16` 100 samples |
| PERF-17 | `docs/rfc/perf-17-adjudication.json` | `perf17` |
| PERF-21 | `docs/rfc/perf-21-adjudication.json` | `perf21` |

Do not commit PASS JSON from host logs. PERF-15 / PERF-18…20 / PERF-22 /
device-loss stay on their existing independent records.

## Required chain

```text
independent baseline (already green)
→ NDK debug probes only (build-m0-d1a-libs.sh)
   libneotavern_presentation_perf_probe.so
   NEVER scripts/build-libs.sh
→ delete any copied libneotavern_android_jni.so from debug jniLibs
→ debug APK
→ bind APK (--bind-apk, evidence_dirty=false)
→ one remaining batch:
   node scripts/b-exit-physical-capture.mjs --batch=remaining --serial=8f5c2b7c
→ independent adjudicators:
   node scripts/remaining-b-physical-adjudicate.mjs --write --apk-linkage=BOUND --evidence-dirty=false
     --perf01-warm-log=… --perf01-cold-log=… --perf02-log=… (etc.)
```

Product path for this batch is Wire → flagged Dioxus shell → Blitz →
presentation-session → compositor. Callers must not assemble a
`NeoDisplayList` by hand. Production `MainActivity` / default JNI stay
untouched.

PERF-16 publishes contentful p99 and interaction p99 only from ≥100
samples. Host p99 stays `none`.
