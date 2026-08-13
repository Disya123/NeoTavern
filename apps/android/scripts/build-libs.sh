#!/usr/bin/env bash
#
# Builds the NeoTavern Android JNI kernel library into
# app/src/main/jniLibs/{arm64-v8a,x86_64}/libneotavern_android_jni.so.
#
# Run from apps/android (CI jobs do exactly that: `bash scripts/build-libs.sh`
# with working-directory: apps/android). The script is cwd-independent — it
# locates the Rust workspace (crates/) relative to its own path.
#
# Requires:
#   - cargo + cargo-ndk  (cargo install cargo-ndk)
#   - Android NDK        (ANDROID_NDK_HOME or ANDROID_NDK_ROOT, or an `ndk`
#                         directory on PATH)
#
# Output (NOT committed — gitignored via app/src/main/jniLibs/):
#   app/src/main/jniLibs/arm64-v8a/libneotavern_android_jni.so
#   app/src/main/jniLibs/x86_64/libneotavern_android_jni.so
# Both ABIs are required: arm64-v8a for devices, x86_64 for the CI emulator.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_DIR="$(cd "$APP_DIR/../../crates" && pwd)"

if [[ ! -f "$WORKSPACE_DIR/Cargo.toml" ]]; then
  echo "error: Rust workspace manifest not found at $WORKSPACE_DIR" >&2
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "error: cargo is not installed" >&2
  exit 1
fi

if ! command -v cargo-ndk >/dev/null 2>&1; then
  echo "error: cargo-ndk is not installed (cargo install cargo-ndk)" >&2
  exit 1
fi

OUT_DIR="$APP_DIR/app/src/main/jniLibs"
mkdir -p "$OUT_DIR"

echo "Building neotavern-android-jni (arm64-v8a, x86_64) -> $OUT_DIR"

# The Rust workspace root is crates/ (the repo root has no Cargo.toml), so the
# frozen cargo-ndk command runs from the workspace with an absolute -o path.
cd "$WORKSPACE_DIR"
cargo ndk \
  -t arm64-v8a \
  -t x86_64 \
  -o "$OUT_DIR" \
  build --release -p neotavern-android-jni

echo "Built:"
ls -1 "$OUT_DIR"/*/libneotavern_android_jni.so
