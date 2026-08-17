#!/usr/bin/env bash
#
# Builds the debug-only M0-D1a paint probe into
# app/src/debug/jniLibs/{arm64-v8a,x86_64}/libneotavern_presentation_m0.so
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

echo "Building neotavern-presentation-m0 (${M0_D1A_FEATURES:-gpu,android-jni}) -> $OUT_DIR"
cd "$WORKSPACE_DIR"
cargo ndk \
  -t arm64-v8a \
  -t x86_64 \
  -o "$OUT_DIR" \
  build --release -p neotavern-presentation-m0 --features "${M0_D1A_FEATURES:-gpu,android-jni}"

echo "Built:"
ls -1 "$OUT_DIR"/*/libneotavern_presentation_m0.so
# cargo-ndk -o copies every workspace cdylib for the target; keep only the probe.
find "$OUT_DIR" -name 'libneotavern_android_jni.so' -delete
