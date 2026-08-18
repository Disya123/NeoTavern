#!/usr/bin/env bash
#
# Builds the debug-only M0-D1a/D1b/D2 paint probes and the Milestone C
# presentation chat JNI into
# app/src/debug/jniLibs/{arm64-v8a,x86_64}/libneotavern_presentation_m0.so,
# libneotavern_presentation_m0_d2.so, libneotavern_presentation_perf_probe.so,
# and libneotavern_presentation_chat.so
#
# Default features: gpu,android-jni (control counters).
# Capture APK: M0_D1A_FEATURES=gpu,android-jni,renderdoc-capture
# Production libneotavern_android_jni.so is never this crate.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_DIR="$(cd "$APP_DIR/../../crates" && pwd)"

if [[ ! -f "$WORKSPACE_DIR/Cargo.toml" ]]; then
  echo "error: Rust workspace manifest not found at $WORKSPACE_DIR" >&2
  exit 1
fi

if ! command -v cargo-ndk >/dev/null 2>&1; then
  echo "error: cargo-ndk is not installed (cargo install cargo-ndk)" >&2
  exit 1
fi

OUT_DIR="$APP_DIR/app/src/debug/jniLibs"
mkdir -p "$OUT_DIR"
FEATURES="${M0_D1A_FEATURES:-gpu,android-jni}"

echo "Building neotavern-presentation-m0 ($FEATURES) -> $OUT_DIR"
cd "$WORKSPACE_DIR"
cargo ndk \
  -t arm64-v8a \
  -t x86_64 \
  -o "$OUT_DIR" \
  build --release -p neotavern-presentation-m0 --features "$FEATURES"

echo "Building neotavern-presentation-m0-d2 ($FEATURES) -> $OUT_DIR"
cargo ndk \
  -t arm64-v8a \
  -t x86_64 \
  -o "$OUT_DIR" \
  build --release -p neotavern-presentation-m0-d2 --features "$FEATURES"

echo "Building neotavern-presentation-perf-probe ($FEATURES) -> $OUT_DIR"
cargo ndk \
  -t arm64-v8a \
  -t x86_64 \
  -o "$OUT_DIR" \
  build --release -p neotavern-presentation-perf-probe --features "$FEATURES"

echo "Building neotavern-presentation-chat (android-jni) -> $OUT_DIR"
cargo ndk \
  -t arm64-v8a \
  -t x86_64 \
  -o "$OUT_DIR" \
  build --release -p neotavern-presentation-chat --features android-jni

echo "Built:"
ls -1 "$OUT_DIR"/*/libneotavern_presentation_m0.so
ls -1 "$OUT_DIR"/*/libneotavern_presentation_m0_d2.so
ls -1 "$OUT_DIR"/*/libneotavern_presentation_perf_probe.so
ls -1 "$OUT_DIR"/*/libneotavern_presentation_chat.so
# cargo-ndk -o copies every workspace cdylib for the target; keep the probes
# and the Milestone C presentation chat library. Production kernel JNI stays in
# app/src/main/jniLibs.
find "$OUT_DIR" -name 'libneotavern_android_jni.so' -delete
