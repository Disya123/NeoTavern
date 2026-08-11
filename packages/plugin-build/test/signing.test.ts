/**
 * Package signing tests (ТЗ §36): Ed25519 round-trip, tamper detection,
 * key-id pinning, canonical JSON stability.
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  generateKeyPair,
  keyIdOf,
  signManifest,
  verifyManifestSignature,
} from '../src/signing.js';
import type { PluginManifest } from '@neotavern/plugin-sdk';

const BASE_MANIFEST: PluginManifest = {
  id: 'author.demo',
  name: 'Demo',
  version: '1.0.0',
  apiVersion: 3,
  backend: 'index.js',
  requiredCapabilities: [{ name: 'storage.kv' }],
};

describe('package signing (§36)', () => {
  it('round-trips sign → verify and pins the key id', () => {
    const { privateKeyPem, publicKeyPem, keyId } = generateKeyPair();
    const signed = signManifest(BASE_MANIFEST, privateKeyPem);
    expect(signed.publisher?.keyId).toBe(keyId);
    expect(typeof signed.signature).toBe('string');
    const result = verifyManifestSignature(signed, publicKeyPem);
    expect(result).toEqual({ ok: true });
  });

  it('rejects tampered manifests (PACKAGE_SIGNATURE_INVALID)', () => {
    const { privateKeyPem, publicKeyPem } = generateKeyPair();
    const signed = signManifest(BASE_MANIFEST, privateKeyPem);
    const tampered = { ...signed, version: '9.9.9' };
    const result = verifyManifestSignature(tampered, publicKeyPem);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('PACKAGE_SIGNATURE_INVALID');
  });

  it('rejects a signature from a different key (PUBLISHER_KEY_CHANGED)', () => {
    const first = generateKeyPair();
    const second = generateKeyPair();
    const signed = signManifest(BASE_MANIFEST, first.privateKeyPem);
    const result = verifyManifestSignature(signed, second.publicKeyPem);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('PUBLISHER_KEY_CHANGED');
  });

  it('rejects missing/malformed signatures', () => {
    const { publicKeyPem } = generateKeyPair();
    expect(verifyManifestSignature(BASE_MANIFEST, publicKeyPem).ok).toBe(false);
    expect(
      verifyManifestSignature({ ...BASE_MANIFEST, signature: 'not-base64!' }, publicKeyPem).ok,
    ).toBe(false);
    // Shape-only check without a key requires the keyId field.
    expect(verifyManifestSignature({ ...BASE_MANIFEST, signature: 'x' }).ok).toBe(false);
  });

  it('produces stable canonical JSON regardless of key order', () => {
    const a = canonicalJson({ b: 1, a: [2, { c: 3 }], z: null });
    const b = canonicalJson({ z: null, a: [2, { c: 3 }], b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":[2,{"c":3}],"b":1,"z":null}');
  });

  it('derives a stable ed25519 key id from the public key', () => {
    const pair = generateKeyPair();
    expect(keyIdOf(pair.publicKeyPem)).toBe(pair.keyId);
    expect(pair.keyId).toMatch(/^ed25519:[0-9a-f]{32}$/);
  });
});
