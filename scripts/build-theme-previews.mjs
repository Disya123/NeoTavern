/**
 * Generate deterministic palette preview PNGs for each bundled theme package
 * (apps/server/assets/themes/<id>/preview.png). Pure Node — no native deps.
 *
 * Each preview is a 480x300 card drawn from the theme tokens: canvas
 * background, a surface panel with a border, an accent header bar, four status
 * indicator dots, and two text-coloured bars standing in for primary/secondary
 * text. Re-running overwrites previews in place; output is byte-stable for a
 * given palette.
 */
import { deflateSync } from 'node:zlib';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const themesDir = resolve(repoRoot, 'apps/server/assets/themes');

const WIDTH = 480;
const HEIGHT = 300;

function hexToRgb(value) {
  const match = /^#([\da-f]{3}|[\da-f]{6})$/iu.exec(value.trim());
  if (!match) return [0, 0, 0];
  const hex = match[1];
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

function parseRgba(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('#')) return [...hexToRgb(trimmed), 255];
  const rgba = /^rgba?\(([^)]+)\)$/iu.exec(trimmed);
  if (rgba) {
    const parts = rgba[1].split(',').map((part) => part.trim());
    const [r, g, b] = parts.slice(0, 3).map((part) => Math.round(Number.parseFloat(part)));
    const a = parts[3] !== undefined ? Math.round(Number.parseFloat(parts[3]) * 255) : 255;
    return [r, g, b, Number.isNaN(a) ? 255 : a];
  }
  return [0, 0, 0, 255];
}

/** Resolve a token value, falling back to the dark-mode defaults defined by
 *  the Theme SDK when a theme omits it. */
function token(tokens, name, fallback) {
  const value = tokens[name];
  if (typeof value === 'string' && value.length > 0) return value;
  return fallback;
}

function fillRect(image, x, y, w, h, [r, g, b, a = 255]) {
  const x0 = Math.max(0, Math.min(WIDTH, x));
  const y0 = Math.max(0, Math.min(HEIGHT, y));
  const x1 = Math.max(0, Math.min(WIDTH, x + w));
  const y1 = Math.max(0, Math.min(HEIGHT, y + h));
  for (let yy = y0; yy < y1; yy += 1) {
    for (let xx = x0; xx < x1; xx += 1) {
      const index = (yy * WIDTH + xx) * 4;
      if (a >= 255) {
        image[index] = r;
        image[index + 1] = g;
        image[index + 2] = b;
        image[index + 3] = 255;
      } else {
        const alpha = a / 255;
        image[index] = Math.round(image[index] * (1 - alpha) + r * alpha);
        image[index + 1] = Math.round(image[index + 1] * (1 - alpha) + g * alpha);
        image[index + 2] = Math.round(image[index + 2] * (1 - alpha) + b * alpha);
        image[index + 3] = 255;
      }
    }
  }
}

function strokeRect(image, x, y, w, h, color) {
  fillRect(image, x, y, w, 1, color);
  fillRect(image, x, y + h - 1, w, 1, color);
  fillRect(image, x, y, 1, h, color);
  fillRect(image, x + w - 1, y, 1, h, color);
}

function encodePng(rgba) {
  const bytes = Buffer.alloc(HEIGHT * (WIDTH * 4 + 1));
  for (let y = 0; y < HEIGHT; y += 1) {
    bytes[y * (WIDTH * 4 + 1)] = 0;
    rgba.copy(bytes, y * (WIDTH * 4 + 1) + 1, y * WIDTH * 4, (y + 1) * WIDTH * 4);
  }
  const compressed = deflateSync(bytes, { level: 9 });
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH, 0);
  ihdr.writeUInt32BE(HEIGHT, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);
  const idatData = compressed;
  const chunks = [chunk('IHDR', ihdr), chunk('IDAT', idatData), chunk('IEND', Buffer.alloc(0))];
  return Buffer.concat([signature, ...chunks]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = crc32(Buffer.concat([typeBuf, data]));
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function drawPreview(manifest) {
  const tokens = (manifest.tokens && manifest.tokens.dark) || {};
  const canvas = parseRgba(token(tokens, 'color-surface-canvas', '#000000'));
  const surface = parseRgba(token(tokens, 'color-surface-secondary', '#111111'));
  const surfaceText = parseRgba(token(tokens, 'color-text-primary', '#ffffff'));
  const secondaryText = parseRgba(token(tokens, 'color-text-secondary', '#aaaaaa'));
  const border = parseRgba(token(tokens, 'color-border', '#333333'));
  const accent = parseRgba(token(tokens, 'color-accent', '#3b82f6'));
  const accentText = parseRgba(token(tokens, 'color-accent-text', '#ffffff'));
  const statuses = [
    parseRgba(token(tokens, 'color-success', '#4ade80')),
    parseRgba(token(tokens, 'color-warning', '#fbbf24')),
    parseRgba(token(tokens, 'color-danger', '#f87171')),
    parseRgba(token(tokens, 'color-info', '#60a5fa')),
  ];

  const image = Buffer.alloc(WIDTH * HEIGHT * 4);
  fillRect(image, 0, 0, WIDTH, HEIGHT, canvas);

  const panelX = 28;
  const panelY = 28;
  const panelW = WIDTH - 56;
  const panelH = HEIGHT - 56;
  fillRect(image, panelX, panelY, panelW, panelH, surface);
  strokeRect(image, panelX, panelY, panelW, panelH, border);

  fillRect(image, panelX, panelY, panelW, 12, accent);
  fillRect(image, panelX + 16, panelY + 28, 220, 18, surfaceText);
  fillRect(image, panelX + 16, panelY + 54, 160, 12, secondaryText);
  fillRect(image, panelX + 16, panelY + 76, 280, 10, secondaryText);

  const swatchY = panelY + 110;
  fillRect(image, panelX + 16, swatchY, 56, 56, accent);
  const label = parseRgba(token(tokens, 'color-accent-soft-text', '#ffffff'));
  fillRect(image, panelX + 80, swatchY + 8, 120, 12, label);
  fillRect(image, panelX + 80, swatchY + 28, 80, 8, secondaryText);
  fillRect(image, panelX + 80, swatchY + 44, 140, 8, secondaryText);

  const dotY = swatchY + 88;
  let dotX = panelX + 16;
  for (const status of statuses) {
    fillRect(image, dotX, dotY, 18, 18, status);
    dotX += 30;
  }

  fillRect(image, panelX + 16, dotY + 36, 200, 10, surfaceText);
  fillRect(image, panelX + 16, dotY + 54, 320, 8, secondaryText);

  const headerText = accentText;
  fillRect(image, panelX + 6, panelY + 2, 120, 8, headerText);
  return encodePng(image);
}

const entries = await readdir(themesDir, { withFileTypes: true });
let count = 0;
for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const manifestPath = join(themesDir, entry.name, 'theme.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    continue;
  }
  const png = drawPreview(manifest);
  await writeFile(join(themesDir, entry.name, 'preview.png'), png);
  count += 1;
}
console.log(`Wrote ${count} theme preview(s) into ${themesDir}`);
