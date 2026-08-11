/**
 * Package signing (ТЗ Plugin SDK vNext v3.2 §36).
 *
 * Ed25519 signing of the canonical manifest. The signed payload is the
 * stable-canonical JSON of the manifest (sorted keys, no whitespace), which
 * makes verification independent of key order. `publisher.keyId` is the
 * SHA-256 fingerprint of the public key (hex, first 16 bytes), matching the
 * manifest field `publisher.keyId = "ed25519:<fingerprint>"`.
 *
 * Signing covers the manifest only: the file-tree digests and module-graph
 * digest live inside the manifest (fields added by `neotavern-plugin build`), so a
 * tampered package fails verification through the manifest signature.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signData,
  verify as verifyData,
} from 'node:crypto';
import type { PluginManifest } from '@neotavern/plugin-sdk';

/** Stable canonical JSON: sorted keys, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

/** `ed25519:<hex>` key id for a public key (PEM or DER). */
export function keyIdOf(publicKeyPem: string): string {
  const der = publicKeyPem
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s+/g, '');
  const fingerprint = createHash('sha256').update(Buffer.from(der, 'base64')).digest('hex');
  return `ed25519:${fingerprint.slice(0, 32)}`;
}

export interface SigningKeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
  keyId: string;
}

/** Generate a fresh Ed25519 key pair (PEM). */
export function generateKeyPair(): SigningKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString().trim();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().trim();
  return { publicKeyPem, privateKeyPem, keyId: keyIdOf(publicKeyPem) };
}

export interface SignedManifest extends PluginManifest {
  signature: string;
}

/**
 * Sign a manifest: stamps `publisher.keyId` with the key's fingerprint and
 * attaches `signature` (base64 Ed25519 over the canonical manifest WITHOUT
 * the signature field).
 */
export function signManifest(manifest: PluginManifest, privateKeyPem: string): SignedManifest {
  const privateKey = createPrivateKey(privateKeyPem);
  const publicKey = createPublicKey(privateKey);
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString().trim();
  const unsigned = {
    ...manifest,
    publisher: { ...manifest.publisher, keyId: keyIdOf(publicKeyPem) },
  };
  const payload = canonicalJson(unsigned);
  const signature = signData(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64');
  return { ...unsigned, signature } as SignedManifest;
}

/**
 * Verify a signed manifest. Returns `{ ok: true }` or the failure reason.
 * `publicKeyPem` is optional: without it only the key-id shape is checked
 * (the CLI `verify` path passes the key for a real cryptographic check).
 */
export function verifyManifestSignature(
  manifest: PluginManifest & { signature?: string },
  publicKeyPem?: string,
): { ok: true } | { ok: false; reason: string } {
  if (typeof manifest.signature !== 'string' || manifest.signature.length === 0) {
    return { ok: false, reason: 'PACKAGE_SIGNATURE_INVALID: missing signature' };
  }
  const keyId = manifest.publisher?.keyId;
  if (typeof keyId !== 'string' || !keyId.startsWith('ed25519:')) {
    return { ok: false, reason: 'PACKAGE_SIGNATURE_INVALID: publisher.keyId missing' };
  }
  if (publicKeyPem === undefined) {
    return { ok: true };
  }
  try {
    const publicKey = createPublicKey(publicKeyPem);
    if (keyId !== keyIdOf(publicKey.export({ type: 'spki', format: 'pem' }).toString().trim())) {
      return { ok: false, reason: 'PUBLISHER_KEY_CHANGED: keyId does not match the signing key' };
    }
    const { signature, ...unsigned } = manifest;
    const payload = canonicalJson(unsigned);
    const valid = verifyData(
      null,
      Buffer.from(payload, 'utf8'),
      publicKey,
      Buffer.from(signature, 'base64'),
    );
    if (!valid) {
      return { ok: false, reason: 'PACKAGE_SIGNATURE_INVALID: signature mismatch' };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'PACKAGE_SIGNATURE_INVALID: malformed key or signature' };
  }
}
