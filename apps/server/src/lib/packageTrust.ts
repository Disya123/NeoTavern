/**
 * Plugin package trust (ТЗ §SEC-05): publisher signature and per-file digest
 * verification performed BEFORE consent/install, plus the recorded trust
 * state (`built-in` / `verified-publisher` / `locally-trusted` /
 * `unsigned-untrusted`).
 *
 * Signed package layout (format `neotavern.package-signature.v1`):
 *
 * ```text
 * plugin.json
 * frontend.js
 * signature/
 *   manifest.json   { "format": ..., "algorithm": "ed25519",
 *                     "hash": "sha256", "files": { <rel-path>: <sha256 hex> } }
 *   package.sig     64-byte raw Ed25519 signature over the exact bytes of
 *                   signature/manifest.json
 * ```
 *
 * Verification is fail-closed: the signature covers the digest of every file
 * in the package, so a package with any extra, missing or modified file does
 * not verify. A signature that verifies against none of the trusted publisher
 * keys is rejected (`PLUGIN_SIGNATURE_UNTRUSTED`) — it is never downgraded to
 * "unsigned". `requireSignature` policy turns an unsigned package into
 * `PLUGIN_SIGNATURE_REQUIRED`.
 */
import { createHash, createPublicKey, verify as ed25519Verify } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { AppError, ErrorCodes } from '@neotavern/shared';
import type { PluginPackageTrust } from '@neotavern/contracts';

export interface PackageTrustVerdict {
  /** Resolved trust state for the package content. */
  trust: PluginPackageTrust;
  /** Fingerprint (sha256 hex prefix) of the publisher key that verified. */
  publisherKeyId: string | null;
}

const SIGNATURE_DIR = 'signature';
const SIGNATURE_MANIFEST = 'signature/manifest.json';
const SIGNATURE_FILE = 'signature/package.sig';
const SIGNATURE_FORMAT = 'neotavern.package-signature.v1';
const SIGNATURE_ALGORITHM = 'ed25519';
const SIGNATURE_HASH = 'sha256';
/** Ed25519 signatures are always 64 bytes. */
const ED25519_SIGNATURE_BYTES = 64;
/** Manifest is a file list; 1 MiB is far beyond any legitimate package. */
const MAX_SIGNATURE_MANIFEST_BYTES = 1024 * 1024;
/** Fingerprint prefix shown in the registry (sha256 of the raw public key). */
const PUBLISHER_KEY_ID_LENGTH = 16;

interface SignatureManifest {
  format: string;
  algorithm: string;
  hash: string;
  files: Record<string, string>;
}

function signatureError(
  code: ErrorCodeSignature,
  params: Record<string, unknown>,
  message: string,
): AppError {
  return new AppError({ code, params, message });
}

type ErrorCodeSignature =
  typeof ErrorCodes.PLUGIN_SIGNATURE_INVALID | typeof ErrorCodes.PLUGIN_SIGNATURE_UNTRUSTED;

/**
 * Verify the package's publisher signature (when present) against the
 * trusted publisher keyring and resolve the trust state. `packageRoot` is an
 * already-extracted, already path-validated package tree; symlinks and
 * traversal paths cannot exist there (extraction rejects them).
 */
export async function verifyPackageTrust(
  packageRoot: string,
  trustedPublisherKeys: readonly string[],
): Promise<PackageTrustVerdict> {
  const signatureDir = join(packageRoot, SIGNATURE_DIR);
  const signatureDirInfo = await stat(signatureDir).catch(() => null);
  if (signatureDirInfo === null || !signatureDirInfo.isDirectory()) {
    // No signature: the package is unsigned. Whether that is acceptable is
    // decided by the install policy (`requireSignature`) and by the user's
    // explicit consent (recorded as `locally-trusted`).
    return { trust: 'unsigned-untrusted', publisherKeyId: null };
  }

  const manifestBytes = await readBoundedFile(
    join(packageRoot, SIGNATURE_MANIFEST),
    MAX_SIGNATURE_MANIFEST_BYTES,
  );
  const signatureBytes = await readBoundedFile(
    join(packageRoot, SIGNATURE_FILE),
    ED25519_SIGNATURE_BYTES,
  );
  if (signatureBytes.length !== ED25519_SIGNATURE_BYTES) {
    throw signatureError(
      ErrorCodes.PLUGIN_SIGNATURE_INVALID,
      { reason: 'BAD_SIGNATURE_SIZE' },
      'invalid package signature',
    );
  }

  let manifest: SignatureManifest;
  try {
    const parsed: unknown = JSON.parse(manifestBytes.toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new TypeError('signature manifest must be an object');
    }
    const record = parsed as Record<string, unknown>;
    if (
      record['format'] !== SIGNATURE_FORMAT ||
      record['algorithm'] !== SIGNATURE_ALGORITHM ||
      record['hash'] !== SIGNATURE_HASH ||
      typeof record['files'] !== 'object' ||
      record['files'] === null ||
      Array.isArray(record['files']) ||
      !Object.entries(record['files'] as Record<string, unknown>).every(
        ([path, digest]) => path.length > 0 && path.length <= 1024 && typeof digest === 'string',
      )
    ) {
      throw new TypeError('unsupported signature manifest shape');
    }
    manifest = {
      format: record['format'] as string,
      algorithm: record['algorithm'] as string,
      hash: record['hash'] as string,
      files: record['files'] as Record<string, string>,
    };
  } catch (cause) {
    throw signatureError(
      ErrorCodes.PLUGIN_SIGNATURE_INVALID,
      { reason: 'BAD_MANIFEST' },
      cause instanceof Error ? cause.message : 'invalid signature manifest',
    );
  }

  // ТЗ §SEC-05: the signature manifest pins the digest of EVERY file in the
  // package — extra files, missing files and modified files all fail.
  const actualDigests = await collectFileDigests(packageRoot);
  const manifestPaths = Object.keys(manifest.files).sort();
  const actualPaths = Object.keys(actualDigests).sort();
  if (
    manifestPaths.length !== actualPaths.length ||
    !manifestPaths.every((path, i) => path === actualPaths[i])
  ) {
    throw signatureError(
      ErrorCodes.PLUGIN_SIGNATURE_INVALID,
      { reason: 'FILE_SET_MISMATCH' },
      'package files do not match the signature manifest',
    );
  }
  for (const path of manifestPaths) {
    if (actualDigests[path] !== manifest.files[path]) {
      throw signatureError(
        ErrorCodes.PLUGIN_SIGNATURE_INVALID,
        { reason: 'DIGEST_MISMATCH', path },
        'package file digest does not match the signature manifest',
      );
    }
  }

  // The signature covers the exact manifest bytes: no JSON canonicalization
  // is involved, so the signer and the verifier always agree on the input.
  for (const encodedKey of trustedPublisherKeys) {
    let rawKey: Buffer;
    try {
      rawKey = Buffer.from(encodedKey, 'base64');
    } catch {
      continue; // malformed configured keys never verify; they are ignored
    }
    if (rawKey.length !== 32) continue;
    let publicKey: ReturnType<typeof createPublicKey>;
    try {
      // The configured keys are raw Ed25519 public keys; verify() needs a
      // KeyObject, so the raw bytes are wrapped as a JWK key.
      publicKey = createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: rawKey.toString('base64url') },
        format: 'jwk',
      });
    } catch {
      continue;
    }
    if (ed25519Verify(null, manifestBytes, publicKey, signatureBytes)) {
      return {
        trust: 'verified-publisher',
        publisherKeyId: publisherFingerprint(rawKey),
      };
    }
  }

  throw signatureError(
    ErrorCodes.PLUGIN_SIGNATURE_UNTRUSTED,
    { reason: 'UNKNOWN_PUBLISHER' },
    'package signature is not from a trusted publisher',
  );
}

/** Fingerprint of a raw Ed25519 public key: sha256 hex prefix. */
export function publisherFingerprint(publicKey: Buffer): string {
  return createHash('sha256').update(publicKey).digest('hex').slice(0, PUBLISHER_KEY_ID_LENGTH);
}

/**
 * Apply the install policy to the verification verdict:
 * - `requireSignature` turns unsigned packages into `PLUGIN_SIGNATURE_REQUIRED`;
 * - an explicit local-trust decision upgrades an unsigned package to
 *   `locally-trusted` (the user accepted the risk);
 * - a verified signature always wins over both.
 */
export function enforceTrustPolicy(
  verdict: PackageTrustVerdict,
  requireSignature: boolean,
  explicitLocalTrust: boolean,
): PackageTrustVerdict {
  if (verdict.trust !== 'unsigned-untrusted') return verdict;
  if (requireSignature) {
    throw new AppError({
      code: ErrorCodes.PLUGIN_SIGNATURE_REQUIRED,
      params: { reason: 'UNSIGNED' },
      message: 'unsigned plugin packages are rejected by the install policy',
    });
  }
  if (explicitLocalTrust) return { trust: 'locally-trusted', publisherKeyId: null };
  return verdict;
}

async function readBoundedFile(path: string, maxBytes: number): Promise<Buffer> {
  const info = await stat(path).catch(() => null);
  if (info === null || !info.isFile() || info.size > maxBytes) {
    throw signatureError(
      ErrorCodes.PLUGIN_SIGNATURE_INVALID,
      { reason: 'BAD_SIGNATURE_FILES' },
      'invalid package signature files',
    );
  }
  return readFile(path);
}

/** sha256 of every regular file under `root`, keyed by POSIX relative path. */
async function collectFileDigests(root: string): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  await walk(root, root, digests);
  return digests;
}

async function walk(root: string, dir: string, out: Record<string, string>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    const rel = relative(root, path).split('\\').join('/');
    if (rel === SIGNATURE_DIR) continue; // the signature itself is not signed
    if (entry.isDirectory()) {
      await walk(root, path, out);
    } else if (entry.isFile()) {
      out[rel] = createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
    }
    // Symlinks cannot exist here (extraction rejects them); anything else is
    // skipped, which a strict file-set comparison turns into a rejection.
  }
}
