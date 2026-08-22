#!/usr/bin/env node
/**
 * Pixel-diff golden gate: React golden PNG vs native raster PNG → diff image.
 *
 * Closes the "похоже / чуть сильнее похоже" eyeball loop with a number. It is
 * intentionally zero-dependency: PNG decode/encode lives in `lib/pngcodec.mjs`
 * (constrained to what our own tooling emits — RGBA8/RGB8, bit depth 8,
 * non-interlaced).
 *
 * Example:
 *   # produce the native raster (vello/wgpu, same pipeline as Android):
 *   cargo run -p neotavern-presentation-m0 --features gpu \
 *     --bin cm-raster --branch ... -- --viewport=expanded --out=build/native.png
 *   # compare against the React golden:
 *   node scripts/style-golden-diff.mjs \
 *     --golden crates/presentation-design-system/generated/react-golden-character-manager.png \
 *     --native build/native.png --out build/diff.png --json
 *
 * Gate mode (CI): `--max-diff 0.05` exits 1 when >0.05% of pixels differ.
 *
 * Flags:
 *   --golden <png>        reference (React) image
 *   --native <png>        candidate (native Rust renderer) image
 *   --out <png>           diff image (default ./style-golden-diff.png)
 *   --threshold <0..255>  per-channel delta below which a pixel counts as equal (default 0)
 *   --max-diff <percent>  exit 1 when percentDifferent exceeds this
 *   --resize <nearest|none>  how to align mismatched sizes (default nearest)
 *   --json                print only the metric JSON line
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodePng, encodePng, PngError } from './lib/pngcodec.mjs';

export const DEFAULT_OUT = resolve(import.meta.dirname, '..', 'style-golden-diff.png');

/** Nearest-neighbor resize of RGBA data from (w,h) to (tw,th). Pure. */
export function resizeNearest(data, width, height, tw, th) {
  const out = new Uint8Array(tw * th * 4);
  for (let y = 0; y < th; y += 1) {
    const sy = Math.min(height - 1, Math.floor((y * height) / th));
    for (let x = 0; x < tw; x += 1) {
      const sx = Math.min(width - 1, Math.floor((x * width) / tw));
      const si = (sy * width + sx) * 4;
      const di = (y * tw + x) * 4;
      out[di] = data[si];
      out[di + 1] = data[si + 1];
      out[di + 2] = data[si + 2];
      out[di + 3] = data[si + 3];
    }
  }
  return out;
}

/**
 * Compare two RGBA buffers of equal size.
 * Returns `{ width, height, differentPixels, percentDifferent, maxChannelDelta }`.
 */
export function compareImages(golden, native, width, height, { threshold = 0 } = {}) {
  if (golden.length !== native.length || golden.length !== width * height * 4) {
    throw new PngError('cannot compare: RGBA buffers must be equal size');
  }
  let differentPixels = 0;
  let maxChannelDelta = 0;
  for (let i = 0; i < golden.length; i += 4) {
    const dR = Math.abs(golden[i] - native[i]);
    const dG = Math.abs(golden[i + 1] - native[i + 1]);
    const dB = Math.abs(golden[i + 2] - native[i + 2]);
    const dA = Math.abs(golden[i + 3] - native[i + 3]);
    const max = Math.max(dR, dG, dB, dA);
    if (max > maxChannelDelta) maxChannelDelta = max;
    if (max > threshold) differentPixels += 1;
  }
  const total = width * height;
  const percentDifferent = total === 0 ? 0 : (differentPixels / total) * 100;
  return { width, height, differentPixels, percentDifferent, maxChannelDelta };
}

/**
 * Diff image: unchanged pixels keep the native color, differing pixels turn red.
 */
export function buildDiffImage(golden, native, width, height, { threshold = 0 } = {}) {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < golden.length; i += 4) {
    const max = Math.max(
      Math.abs(golden[i] - native[i]),
      Math.abs(golden[i + 1] - native[i + 1]),
      Math.abs(golden[i + 2] - native[i + 2]),
      Math.abs(golden[i + 3] - native[i + 3]),
    );
    if (max > threshold) {
      out[i] = 255;
      out[i + 1] = 0;
      out[i + 2] = 0;
      out[i + 3] = 255;
    } else {
      out[i] = native[i];
      out[i + 1] = native[i + 1];
      out[i + 2] = native[i + 2];
      out[i + 3] = native[i + 3];
    }
  }
  return out;
}

function argValue(args, name) {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const goldenPath = argValue(args, '--golden');
  const nativePath = argValue(args, '--native');
  const outPath =
    argValue(args, '--out') ?? resolve(import.meta.dirname, '..', 'style-golden-diff.png');
  const threshold = Number.parseInt(argValue(args, '--threshold') ?? '0', 10) || 0;
  const maxDiff = Number.parseFloat(argValue(args, '--max-diff') ?? 'NaN');
  const resizeMode = argValue(args, '--resize') ?? 'nearest';
  const jsonOnly = args.includes('--json');

  if (!goldenPath || !nativePath) {
    console.error(
      'usage: style-golden-diff.mjs --golden <png> --native <png> [--out <png>] [--threshold N] [--max-diff P] [--json]',
    );
    process.exit(2);
  }

  let golden;
  let native;
  try {
    golden = decodePng(readFileSync(goldenPath));
    native = decodePng(readFileSync(nativePath));
  } catch (err) {
    console.error(`[style-golden-diff] cannot decode: ${err.message}`);
    process.exit(2);
  }

  let gData = golden.data;
  let nData = native.data;
  let w = golden.width;
  let h = golden.height;

  if (native.width !== golden.width || native.height !== golden.height) {
    if (golden.channels !== 4 || native.channels !== 4) {
      throw new PngError('size mismatch with non-RGBA input; resize needs RGBA');
    }
    if (resizeMode !== 'nearest') {
      console.error(
        `[style-golden-diff] size mismatch (golden ${golden.width}x${golden.height}, native ${native.width}x${native.height}) and --resize=none`,
      );
      process.exit(2);
    }
    nData = resizeNearest(native.data, native.width, native.height, w, h);
  }

  const metric = compareImages(gData, nData, w, h, { threshold });
  const diff = buildDiffImage(gData, nData, w, h, { threshold });
  writeFileSync(outPath, encodePng({ width: w, height: h, data: diff }));

  if (jsonOnly) {
    console.log(JSON.stringify({ ...metric, diffImage: outPath }));
  } else {
    console.log(
      `[style-golden-diff] ${w}x${h}: ${metric.differentPixels}/${w * h} px differ ` +
        `(${metric.percentDifferent.toFixed(4)}%), maxChannelDelta=${metric.maxChannelDelta} → ${outPath}`,
    );
  }

  if (Number.isFinite(maxDiff) && metric.percentDifferent > maxDiff) {
    console.error(
      `[style-golden-diff] GATE FAILED: ${metric.percentDifferent.toFixed(4)}% > ${maxDiff}% allowed`,
    );
    process.exit(1);
  }
  if (Number.isFinite(maxDiff)) {
    console.log(`[style-golden-diff] gate ok (≤${maxDiff}%)`);
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
