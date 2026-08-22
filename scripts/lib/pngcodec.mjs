/**
 * Minimal PNG codec (decode RGBA8/RGB8 + encode RGBA8) with zero dependencies.
 *
 * Restricted on purpose: bit depth 8, color types 2 (RGB) and 6 (RGBA), no
 * interlace, filters 0..4, and zlib-wrapped IDAT streams. Everything outside
 * that is rejected with a clear error. Both golden (Playwright/React) and
 * native (Rust `image::save_buffer`) outputs satisfy these constraints.
 */

import { deflateSync, inflateSync } from 'node:zlib';

export class PngError extends Error {}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunkCrc(typeAndData) {
  return crc32(typeAndData);
}

function readU32(bytes, offset) {
  // `>>> 0` keeps the value unsigned — plain `<<` wraps a high bit into
  // negative for CRC/length comparisons.
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function chunk(type, data) {
  const typeBytes = new Uint8Array(type.split('').map((c) => c.charCodeAt(0)));
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const crc = chunkCrc(body);
  const out = new Uint8Array(4 + body.length + 4);
  const len = new DataView(out.buffer);
  len.setUint32(0, data.length);
  out.set(body, 4);
  const crcView = new DataView(out.buffer, 4 + body.length, 4);
  crcView.setUint32(0, crc);
  return out;
}

/** Decode a PNG buffer into `{ width, height, channels, data: Uint8Array }`. */
export function decodePng(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 8 || !SIGNATURE.every((b, i) => bytes[i] === b)) {
    throw new PngError('not a PNG (bad signature)');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = -1;
  const idat = [];
  let seenEnd = false;

  while (offset + 8 <= bytes.length && !seenEnd) {
    const length = readU32(bytes, offset);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) throw new PngError('truncated PNG chunk');
    // Verify CRC over type+data.
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const data = bytes.subarray(dataStart, dataEnd);
    const body = new Uint8Array(type.length + length);
    body.set(typeBytes, 0);
    body.set(data, type.length);
    const expectedCrc = readU32(bytes, dataEnd);
    if (crc32(body) !== expectedCrc) {
      throw new PngError(`CRC mismatch in ${type} chunk`);
    }

    if (type === 'IHDR') {
      if (length < 13) throw new PngError('short IHDR');
      width = readU32(data, 0);
      height = readU32(data, 4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
      if (bitDepth !== 8) throw new PngError(`unsupported bit depth ${bitDepth} (only 8)`);
      if (colorType !== 2 && colorType !== 6) {
        throw new PngError(`unsupported color type ${colorType} (only RGB=2 / RGBA=6)`);
      }
      if (interlace !== 0) throw new PngError('interlaced PNG is not supported');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      seenEnd = true;
    }
    offset = dataEnd + 4;
  }

  if (!width || !height) throw new PngError('PNG has no IHDR');
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const rowBytes = width * channels;
  const expected = (rowBytes + 1) * height;
  if (raw.length < expected) throw new PngError('truncated scanline data');

  const data = new Uint8Array(width * height * channels);
  let src = 0;
  const prev = new Uint8Array(rowBytes);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[src];
    src += 1;
    const row = new Uint8Array(rowBytes);
    for (let x = 0; x < rowBytes; x += 1) {
      const rawByte = raw[src + x];
      const left = x >= channels ? row[x - channels] : 0;
      const up = prev[x];
      const upLeft = x >= channels ? prev[x - channels] : 0;
      let value = 0;
      switch (filter) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = rawByte + left;
          break;
        case 2:
          value = rawByte + up;
          break;
        case 3:
          value = rawByte + Math.floor((left + up) / 2);
          break;
        case 4:
          value = rawByte + paeth(left, up, upLeft);
          break;
        default:
          throw new PngError(`unsupported scanline filter ${filter}`);
      }
      row[x] = value & 0xff;
    }
    data.set(row, y * rowBytes);
    prev.set(row);
    src += rowBytes;
  }
  return { width, height, channels, data };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Encode RGBA8 pixels into a PNG buffer (filter 0, single IDAT). */
export function encodePng({ width, height, data }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new PngError('invalid dimensions for PNG encoding');
  }
  const channels = 4;
  const rowBytes = width * channels;
  if (data.length < rowBytes * height) throw new PngError('pixel buffer too small');

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0; // non-interlaced

  const raw = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (rowBytes + 1)] = 0; // filter: None
    raw.set(data.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1);
  }

  const signature = new Uint8Array(SIGNATURE);
  const out = Buffer.concat([
    Buffer.from(signature),
    Buffer.from(chunk('IHDR', Buffer.from(ihdr))),
    Buffer.from(chunk('IDAT', deflateSync(raw))),
    Buffer.from(chunk('IEND', new Uint8Array(0))),
  ]);
  return out;
}
