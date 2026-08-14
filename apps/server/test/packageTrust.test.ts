/**
 * Plugin package trust tests (ТЗ §SEC-05): Ed25519 publisher signature +
 * per-file sha256 digest verification against a trusted keyring, and the
 * install policy (requireSignature / explicit local trust).
 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAppError } from '@neotavern/shared';
import {
  enforceTrustPolicy,
  publisherFingerprint,
  verifyPackageTrust,
} from '../src/lib/packageTrust.js';

const SIGNATURE_FORMAT = 'neotavern.package-signature.v1';

function keyPair(): { publicKey: string; privateKey: KeyObject; rawPublic: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const rawPublic = Buffer.from(jwk.x, 'base64url');
  return { publicKey: rawPublic.toString('base64'), privateKey, rawPublic };
}

async function writePackage(root: string, files: Record<string, string>): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, contents);
  }
}

async function signPackage(root: string, privateKey: KeyObject): Promise<void> {
  const digests: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(root, full).split('\\').join('/');
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && !rel.startsWith('signature/')) {
        digests[rel] = createHash('sha256')
          .update(await readFile(full))
          .digest('hex');
      }
    }
  };
  await walk(root);
  const manifest = {
    format: SIGNATURE_FORMAT,
    algorithm: 'ed25519',
    hash: 'sha256',
    files: digests,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
  const signature = sign(null, manifestBytes, privateKey);
  await mkdir(join(root, 'signature'), { recursive: true });
  await writeFile(join(root, 'signature', 'manifest.json'), manifestBytes);
  await writeFile(join(root, 'signature', 'package.sig'), signature);
}

describe('verifyPackageTrust (ТЗ §SEC-05)', () => {
  it('verifies a package signed by a trusted publisher key', async () => {
    const { publicKey, privateKey, rawPublic } = keyPair();
    const root = await mkdtemp(join(tmpdir(), 'neotavern-trust-'));
    try {
      await writePackage(root, {
        'plugin.json': '{"id":"author.example"}',
        'frontend.js': 'export default {}',
      });
      await signPackage(root, privateKey);

      const verdict = await verifyPackageTrust(root, [publicKey]);

      expect(verdict.trust).toBe('verified-publisher');
      expect(verdict.publisherKeyId).toBe(publisherFingerprint(rawPublic));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a package signed by an unknown publisher (never downgrades to unsigned)', async () => {
    const { privateKey } = keyPair();
    const root = await mkdtemp(join(tmpdir(), 'neotavern-trust-'));
    try {
      await writePackage(root, { 'plugin.json': '{}' });
      await signPackage(root, privateKey);

      await expect(verifyPackageTrust(root, [])).rejects.toMatchObject({
        code: 'PLUGIN_SIGNATURE_UNTRUSTED',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a tampered file (per-file digest mismatch)', async () => {
    const { publicKey, privateKey } = keyPair();
    const root = await mkdtemp(join(tmpdir(), 'neotavern-trust-'));
    try {
      await writePackage(root, {
        'plugin.json': '{"id":"author.example"}',
        'frontend.js': 'export default {}',
      });
      await signPackage(root, privateKey);
      await writeFile(join(root, 'frontend.js'), 'export default { hacked: true }');

      const error = await verifyPackageTrust(root, [publicKey]).catch((caught: unknown) => caught);
      expect(isAppError(error)).toBe(true);
      if (isAppError(error)) {
        expect(error.code).toBe('PLUGIN_SIGNATURE_INVALID');
        expect(error.params).toMatchObject({ reason: 'DIGEST_MISMATCH', path: 'frontend.js' });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an extra file not listed in the signature manifest', async () => {
    const { publicKey, privateKey } = keyPair();
    const root = await mkdtemp(join(tmpdir(), 'neotavern-trust-'));
    try {
      await writePackage(root, { 'plugin.json': '{}' });
      await signPackage(root, privateKey);
      await writeFile(join(root, 'sneaky.js'), 'evil');

      const error = await verifyPackageTrust(root, [publicKey]).catch((caught: unknown) => caught);
      expect(isAppError(error)).toBe(true);
      if (isAppError(error)) {
        expect(error.code).toBe('PLUGIN_SIGNATURE_INVALID');
        expect(error.params).toMatchObject({ reason: 'FILE_SET_MISMATCH' });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a forged file inside signature/ — the signed entrypoint cannot import an unsigned module (SEC-05)', async () => {
    const { publicKey, privateKey } = keyPair();
    const root = await mkdtemp(join(tmpdir(), 'neotavern-trust-'));
    try {
      await writePackage(root, {
        'plugin.json': '{}',
        'frontend.js': "import './signature/module.js'",
      });
      await signPackage(root, privateKey);
      // An attacker drops an unsigned helper into the signature directory:
      // the whole directory is excluded from the digest, so it must NOT slip
      // through as "extra but signed-out" — it is a forbidden signature-dir
      // file and the package must be rejected.
      await writeFile(join(root, 'signature', 'module.js'), 'module.exports = { hacked: true }');

      const error = await verifyPackageTrust(root, [publicKey]).catch((caught: unknown) => caught);
      expect(isAppError(error)).toBe(true);
      if (isAppError(error)) {
        expect(error.code).toBe('PLUGIN_SIGNATURE_INVALID');
        expect(error.params).toMatchObject({ reason: 'FILE_SET_MISMATCH' });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a corrupted signature file', async () => {
    const { publicKey, privateKey } = keyPair();
    const root = await mkdtemp(join(tmpdir(), 'neotavern-trust-'));
    try {
      await writePackage(root, { 'plugin.json': '{}' });
      await signPackage(root, privateKey);
      await writeFile(join(root, 'signature', 'package.sig'), Buffer.alloc(32, 7));

      const error = await verifyPackageTrust(root, [publicKey]).catch((caught: unknown) => caught);
      expect(isAppError(error)).toBe(true);
      if (isAppError(error)) {
        expect(error.code).toBe('PLUGIN_SIGNATURE_INVALID');
        expect(error.params).toMatchObject({ reason: 'BAD_SIGNATURE_SIZE' });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('treats a package without a signature directory as unsigned', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neotavern-trust-'));
    try {
      await writePackage(root, { 'plugin.json': '{}' });
      const verdict = await verifyPackageTrust(root, []);
      expect(verdict).toEqual({ trust: 'unsigned-untrusted', publisherKeyId: null });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('enforceTrustPolicy (ТЗ §SEC-05)', () => {
  it('rejects unsigned packages when requireSignature is set', () => {
    let error: unknown;
    try {
      enforceTrustPolicy({ trust: 'unsigned-untrusted', publisherKeyId: null }, true, false);
    } catch (caught) {
      error = caught;
    }
    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) expect(error.code).toBe('PLUGIN_SIGNATURE_REQUIRED');
  });

  it('records an explicit local trust decision for an unsigned package', () => {
    expect(
      enforceTrustPolicy({ trust: 'unsigned-untrusted', publisherKeyId: null }, false, true),
    ).toEqual({ trust: 'locally-trusted', publisherKeyId: null });
  });

  it('keeps unsigned-untrusted when no decision was made', () => {
    expect(
      enforceTrustPolicy({ trust: 'unsigned-untrusted', publisherKeyId: null }, false, false),
    ).toEqual({ trust: 'unsigned-untrusted', publisherKeyId: null });
  });

  it('a verified signature wins over both policy knobs', () => {
    expect(
      enforceTrustPolicy({ trust: 'verified-publisher', publisherKeyId: 'abc123' }, true, true),
    ).toEqual({ trust: 'verified-publisher', publisherKeyId: 'abc123' });
  });
});
