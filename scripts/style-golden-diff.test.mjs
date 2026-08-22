import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { encodePng, decodePng, PngError } from './lib/pngcodec.mjs';
import { buildDiffImage, compareImages, resizeNearest } from './style-golden-diff.mjs';

function rgba(w, h, fill = (x, y) => [x & 0xff, (y * 37) & 0xff, (x + y) & 0xff, 255]) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const [r, g, b, a] = fill(x, y);
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return data;
}

describe('pngcodec round-trip', () => {
  it('encode → decode preserves pixels exactly (RGBA, non-interlaced)', () => {
    const width = 3;
    const height = 2;
    const data = rgba(width, height);
    const png = encodePng({ width, height, data });
    const decoded = decodePng(png);
    expect(decoded.width).toBe(width);
    expect(decoded.height).toBe(height);
    expect(decoded.channels).toBe(4);
    expect([...decoded.data]).toEqual([...data]);
  });

  it('rejects a non-PNG input', () => {
    expect(() => decodePng(Buffer.from('not a png at all........' + 'x'.repeat(64)))).toThrow(
      PngError,
    );
  });

  it('detects IDAT corruption through CRC verification', () => {
    const png = encodePng({ width: 4, height: 4, data: rgba(4, 4) });
    // Walk chunks to find the IDAT data payload offset, then corrupt it.
    const view = new Uint8Array(png);
    let offset = 8;
    let idatDataStart = -1;
    let idatLen = -1;
    while (offset + 8 <= view.length) {
      const length =
        (view[offset] << 24) |
        (view[offset + 1] << 16) |
        (view[offset + 2] << 8) |
        view[offset + 3];
      const type = String.fromCharCode(
        view[offset + 4],
        view[offset + 5],
        view[offset + 6],
        view[offset + 7],
      );
      if (type === 'IDAT') {
        idatDataStart = offset + 8;
        idatLen = length;
        break;
      }
      offset += 12 + length;
    }
    expect(idatDataStart).toBeGreaterThan(0);
    const corrupted = Buffer.from(png);
    corrupted[idatDataStart + Math.floor(idatLen / 2)] ^= 0xff;
    expect(() => decodePng(corrupted)).toThrow(/CRC/i);
  });

  it('encodePng rejects undersized pixel buffers', () => {
    expect(() => encodePng({ width: 2, height: 2, data: new Uint8Array(3) })).toThrow(PngError);
  });
});

describe('resizeNearest', () => {
  it('produces the target dimensions and maps the top-left pixel', () => {
    const width = 2;
    const height = 2;
    const data = rgba(width, height);
    const out = resizeNearest(data, width, height, 4, 4);
    expect(out.length).toBe(4 * 4 * 4);
    // Top-left stays the same pixel; bottom-right maps from (1,1).
    expect([...out.slice(0, 4)]).toEqual([...data.slice(0, 4)]);
    const lastIndex = (3 * 4 + 3) * 4;
    const sourceLast = (1 * 2 + 1) * 4;
    expect([...out.slice(lastIndex, lastIndex + 4)]).toEqual([
      ...data.slice(sourceLast, sourceLast + 4),
    ]);
  });
});

describe('compareImages / buildDiffImage', () => {
  const w = 4;
  const h = 1;
  const golden = rgba(w, h);
  const native = Uint8Array.from(golden);

  it('equal images → zero diff and zero percent', () => {
    const metric = compareImages(golden, native, w, h);
    expect(metric.differentPixels).toBe(0);
    expect(metric.percentDifferent).toBe(0);
    expect(metric.maxChannelDelta).toBe(0);
  });

  it('one differing pixel → counted and turned red', () => {
    const changed = Uint8Array.from(native);
    const i = 1 * 4;
    changed[i] = 255; // golden[4] was 1 → large delta on the second pixel
    const metric = compareImages(golden, changed, w, h);
    expect(metric.differentPixels).toBe(1);
    expect(metric.percentDifferent).toBe(25);
    expect(metric.maxChannelDelta).toBeGreaterThan(0);

    const diff = buildDiffImage(golden, changed, w, h);
    // Differing pixel is pure red.
    expect([...diff.slice(4, 8)]).toEqual([255, 0, 0, 255]);
    // Unchanged pixel keeps native.
    expect([...diff.slice(0, 4)]).toEqual([...golden.slice(0, 4)]);
  });

  it('threshold suppresses sub-threshold channel deltas', () => {
    const changed = Uint8Array.from(native);
    const i = w * h * 4 - 4;
    changed[i] = changed[i] + 1;
    expect(compareImages(golden, changed, w, h, { threshold: 0 }).differentPixels).toBe(1);
    expect(compareImages(golden, changed, w, h, { threshold: 1 }).differentPixels).toBe(0);
  });

  it('CLI end-to-end writes a diff PNG and prints JSON on identical inputs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nt-style-diff-cli-'));
    try {
      const goldenPath = join(dir, 'golden.png');
      const nativePath = join(dir, 'native.png');
      const diffPath = join(dir, 'diff.png');
      const pixels = rgba(6, 3);
      writeFileSync(goldenPath, encodePng({ width: 6, height: 3, data: pixels }));
      writeFileSync(nativePath, encodePng({ width: 6, height: 3, data: pixels }));

      const script = resolve(import.meta.dirname, 'style-golden-diff.mjs');
      const result = spawnSync(
        process.execPath,
        [script, '--golden', goldenPath, '--native', nativePath, '--out', diffPath, '--json'],
        { encoding: 'utf8' },
      );
      expect(result.status).toBe(0);
      const metric = JSON.parse(result.stdout.trim());
      expect(metric.width).toBe(6);
      expect(metric.height).toBe(3);
      expect(metric.differentPixels).toBe(0);
      expect(metric.percentDifferent).toBe(0);
      expect(readFileSync(diffPath).length).toBeGreaterThan(8);
      const decodedDiff = decodePng(readFileSync(diffPath));
      expect(decodedDiff.width).toBe(6);
      expect(decodedDiff.height).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
