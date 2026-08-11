/**
 * Stable entity identifiers.
 *
 * Every entity in NeoTavern has a stable string identifier. We use UUIDv7
 * (RFC 9562) which is time-ordered: indexes stay compact and range scans over
 * creation time are cheap. An ID is NEVER an array index (see AGENTS.md §4).
 *
 * The implementation is isomorphic (no `node:` imports) so the same module can
 * run in the Node backend and the browser frontend. It relies on the Web Crypto
 * `getRandomValues` which is available in Node.js >= 19 and all modern browsers.
 */

function randomBytes(out: Uint8Array): void {
  const crypto = globalThis.crypto;
  if (!crypto || typeof crypto.getRandomValues !== 'function') {
    throw new Error('Web Crypto getRandomValues is unavailable in this runtime');
  }
  crypto.getRandomValues(out);
}

const UUID_V7_RANDOM_BITS = 74n;
const UUID_V7_RANDOM_MASK = (1n << UUID_V7_RANDOM_BITS) - 1n;
let lastUuidV7Timestamp = -1;
let lastUuidV7Random = 0n;

function random74Bits(): bigint {
  const bytes = new Uint8Array(10);
  randomBytes(bytes);
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value & UUID_V7_RANDOM_MASK;
}

/**
 * Generate a UUIDv7 string (lower-case, hyphenated).
 *
 * Layout (RFC 9562):
 * - 48 bits: unix timestamp in milliseconds
 * - 4 bits: version (0b0111)
 * - 12 bits: random
 * - 2 bits: variant (0b10)
 * - 62 bits: random
 */
export function uuidv7(): string {
  const buf = new ArrayBuffer(16);
  const view = new DataView(buf);

  let ts = Date.now();
  if (ts > lastUuidV7Timestamp) {
    lastUuidV7Timestamp = ts;
    lastUuidV7Random = random74Bits();
  } else {
    ts = lastUuidV7Timestamp;
    lastUuidV7Random = (lastUuidV7Random + 1n) & UUID_V7_RANDOM_MASK;
    if (lastUuidV7Random === 0n) {
      lastUuidV7Timestamp += 1;
      ts = lastUuidV7Timestamp;
      lastUuidV7Random = random74Bits();
    }
  }

  // High 32 bits of the 48-bit millisecond timestamp.
  view.setUint32(0, Math.floor(ts / 0x10000));
  // Low 16 bits of the timestamp.
  view.setUint16(4, ts & 0xffff);

  const randA = Number(lastUuidV7Random >> 62n);
  const randB = lastUuidV7Random & ((1n << 62n) - 1n);
  view.setUint16(6, 0x7000 | randA);
  view.setBigUint64(8, (0x2n << 62n) | randB);

  let out = '';
  for (let i = 0; i < 16; i += 1) {
    out += view.getUint8(i).toString(16).padStart(2, '0');
    if (i === 3 || i === 5 || i === 7 || i === 9) {
      out += '-';
    }
  }
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Type guard for a syntactically valid UUID (any version). */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Generate a short, URL-safe random token (hex). Used for trace IDs and
 * non-identifier tokens where time-ordering is not required.
 */
export function randomToken(byteLength = 8): string {
  const bytes = new Uint8Array(byteLength);
  randomBytes(bytes);
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}
