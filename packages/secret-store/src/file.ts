/**
 * Portable encrypted SecretStore backend (ТЗ §SEC-01.1).
 *
 * On-disk format `secrets.enc`:
 *
 * ```text
 * ┌──────────────────────────────────────────────────────────────┐
 * │ magic 'NEOTASEC1' (8) │ formatVersion u32 BE (4)             │
 * │ kdfId u8 (1) │ scryptN u32 BE (4) │ scryptR u8 (1)           │
 * │ scryptP u8 (1) │ salt (16) │ nonce (12)                      │
 * ├──────────────────────────────────────────────────────────────┤
 * │ AES-256-GCM ciphertext of the UTF-8 JSON payload             │
 * │ (AAD = the first 35 header bytes: magic…salt)                │
 * └──────────────────────────────────────────────────────────────┘
 * ```
 *
 * Properties:
 * - Authenticated encryption (AES-256-GCM); format/version and KDF
 *   parameters are authenticated as AAD — a tampered header fails the tag
 *   check, never silently downgrades.
 * - Key derivation: scrypt (RFC 7914) with versioned salt/parameters. The
 *   header carries `kdfId = 1` (scrypt); Argon2id (RFC 9106, the ТЗ target)
 *   is a future `kdfId` bump behind the same authenticated envelope.
 * - Machine identity is NOT part of key derivation: copying the file plus the
 *   master passphrase is sufficient on any machine.
 * - Every write uses a fresh random nonce and rewrites the file atomically
 *   (temp + rename); the previous file remains until the new one is durable.
 * - Derived key and plaintext buffers are best-effort zeroized.
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SecretStoreError, SecretStoreErrorCodes } from './errors.js';
import type { SecretBackendInfo, SecretRecord, SecretStore } from './store.js';

const MAGIC = Buffer.from('NEOTASEC', 'ascii');
const FORMAT_VERSION = 1;
const KDF_SCRYPT = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const NONCE_LENGTH = 12;
const GCM_TAG_LENGTH = 16;
const SCRYPT_DEFAULT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
/** Header bytes covered by the AEAD AAD: magic…salt (everything except nonce). */
const AAD_LENGTH = 8 + 4 + 1 + 4 + 1 + 1 + 16;
/** Full header length: AAD bytes + nonce. */
const HEADER_LENGTH = AAD_LENGTH + NONCE_LENGTH;

interface Payload {
  format: 'neotavern-secrets';
  version: 1;
  records: Record<string, Record<string, { value: string; createdAt: number; updatedAt: number }>>;
}

interface Header {
  version: number;
  kdfId: number;
  scryptN: number;
  scryptR: number;
  scryptP: number;
  salt: Buffer;
  nonce: Buffer;
}

function emptyPayload(): Payload {
  return { format: 'neotavern-secrets', version: 1, records: {} };
}

function encodeHeader(header: Omit<Header, 'nonce'>, nonce: Buffer): Buffer {
  const buffer = Buffer.alloc(HEADER_LENGTH);
  MAGIC.copy(buffer, 0);
  buffer.writeUInt32BE(header.version, 8);
  buffer.writeUInt8(header.kdfId, 12);
  buffer.writeUInt32BE(header.scryptN, 13);
  buffer.writeUInt8(header.scryptR, 17);
  buffer.writeUInt8(header.scryptP, 18);
  header.salt.copy(buffer, 19);
  nonce.copy(buffer, 19 + SALT_LENGTH);
  return buffer;
}

function decodeHeader(buffer: Buffer): Header {
  if (buffer.length < HEADER_LENGTH) {
    throw new SecretStoreError(SecretStoreErrorCodes.SECRET_STORE_CORRUPT, 'truncated header');
  }
  if (!buffer.subarray(0, 8).equals(MAGIC)) {
    throw new SecretStoreError(
      SecretStoreErrorCodes.SECRET_STORE_CORRUPT,
      'not a neotavern secrets file (bad magic)',
    );
  }
  const version = buffer.readUInt32BE(8);
  const kdfId = buffer.readUInt8(12);
  if (version !== FORMAT_VERSION || kdfId !== KDF_SCRYPT) {
    throw new SecretStoreError(
      SecretStoreErrorCodes.SECRET_STORE_CORRUPT,
      `unsupported secrets format (version=${version}, kdf=${kdfId})`,
    );
  }
  return {
    version,
    kdfId,
    scryptN: buffer.readUInt32BE(13),
    scryptR: buffer.readUInt8(17),
    scryptP: buffer.readUInt8(18),
    salt: Buffer.from(buffer.subarray(19, 19 + SALT_LENGTH)),
    nonce: Buffer.from(buffer.subarray(19 + SALT_LENGTH, HEADER_LENGTH)),
  };
}

type ScryptParams = { scryptN: number; scryptR: number; scryptP: number };

async function deriveKey(passphrase: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(
      passphrase,
      salt,
      KEY_LENGTH,
      { N: params.scryptN, r: params.scryptR, p: params.scryptP, maxmem: SCRYPT_DEFAULT.maxmem },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });
}

function zeroize(...buffers: Buffer[]): void {
  for (const buffer of buffers) buffer.fill(0);
}

function validatePayload(value: unknown): asserts value is Payload {
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { format?: unknown }).format !== 'neotavern-secrets' ||
    (value as { version?: unknown }).version !== 1 ||
    typeof (value as { records?: unknown }).records !== 'object' ||
    (value as { records?: unknown }).records === null
  ) {
    throw new SecretStoreError(
      SecretStoreErrorCodes.SECRET_STORE_CORRUPT,
      'invalid secrets payload',
    );
  }
}

export class FileEncryptedSecretStore implements SecretStore {
  private header: Header | null = null;
  private payload: Payload | null = null;
  private key: Buffer | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(
    private readonly filePath: string,
    now: () => number = Date.now,
  ) {
    this.now = now;
  }

  isAvailable(): boolean {
    return this.key !== null && this.payload !== null;
  }

  describe(): SecretBackendInfo {
    let recordCount = 0;
    if (this.payload) {
      for (const namespace of Object.values(this.payload.records)) {
        recordCount += Object.keys(namespace).length;
      }
    }
    return {
      kind: 'portable',
      persistent: true,
      writable: true,
      formatVersion: FORMAT_VERSION,
      kdf: 'scrypt',
      available: this.isAvailable(),
      recordCount,
    };
  }

  /**
   * Create a new (empty) store file and open it. Fails if the file already
   * exists — callers must `open` existing files instead.
   */
  async create(passphrase: string): Promise<void> {
    if (passphrase.length === 0) {
      throw new SecretStoreError(
        SecretStoreErrorCodes.SECRET_STORE_AUTH_FAILED,
        'empty passphrase',
      );
    }
    try {
      await readFile(this.filePath);
      throw new SecretStoreError(
        SecretStoreErrorCodes.SECRET_STORE_CORRUPT,
        'secrets file already exists — open it instead of creating',
      );
    } catch (error) {
      if (error instanceof SecretStoreError) throw error;
      // ENOENT — proceed with creation.
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    await this.writeEncryptedFile(passphrase, emptyPayload());
    await this.open(passphrase);
  }

  /** Open an existing store file with the master passphrase. */
  async open(passphrase: string): Promise<void> {
    const loaded = await this.loadFile(passphrase);
    this.discardKey();
    this.header = loaded.header;
    this.payload = loaded.payload;
    this.key = loaded.key;
  }

  /**
   * Re-encrypt the whole store under a new passphrase. Staged: the new file is
   * written atomically and only replaces the old one after a successful write,
   * so a failure never destroys the previous file.
   */
  async reEncrypt(newPassphrase: string): Promise<void> {
    if (!this.isAvailable()) {
      throw new SecretStoreError(SecretStoreErrorCodes.SECRET_STORE_LOCKED, 'store is locked');
    }
    await this.writeEncryptedFile(newPassphrase, this.payload!);
    await this.open(newPassphrase);
  }

  /** Lock the store: drop records and zeroize the derived key (best effort). */
  lock(): void {
    this.discardKey();
    this.payload = null;
    this.header = null;
  }

  async put(namespace: string, id: string, value: string): Promise<string> {
    this.assertUnlocked();
    await this.enqueue(async () => {
      const records = this.payload!.records;
      const scope = (records[namespace] ??= {});
      const timestamp = this.now();
      const existing = scope[id];
      scope[id] = existing
        ? { value, createdAt: existing.createdAt, updatedAt: timestamp }
        : { value, createdAt: timestamp, updatedAt: timestamp };
      await this.persist();
    });
    return id;
  }

  async get(namespace: string, id: string): Promise<string | null> {
    if (!this.isAvailable()) return null;
    return this.payload!.records[namespace]?.[id]?.value ?? null;
  }

  async delete(namespace: string, id: string): Promise<boolean> {
    // Fail-closed: when the store is locked the caller cannot confirm the
    // value was revoked — surface the error instead of a silent no-op, so
    // secret cleanup keeps the DB reference for a retry (SEC-01).
    this.assertUnlocked();
    let removed = false;
    await this.enqueue(async () => {
      const scope = this.payload!.records[namespace];
      if (scope && id in scope) {
        delete scope[id];
        removed = true;
        await this.persist();
      }
    });
    return removed;
  }

  async list(
    namespace: string,
  ): Promise<Array<{ id: string; createdAt: number; updatedAt: number }>> {
    if (!this.isAvailable()) return [];
    const scope = this.payload!.records[namespace] ?? {};
    return Object.entries(scope).map(([id, record]) => ({
      id,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }));
  }

  async has(namespace: string, id: string): Promise<boolean> {
    if (!this.isAvailable()) return false;
    return id in (this.payload!.records[namespace] ?? {});
  }

  ref(namespace: string, id: string): string {
    return `portable:${namespace}:${id}`;
  }

  private assertUnlocked(): void {
    if (!this.isAvailable()) {
      throw new SecretStoreError(SecretStoreErrorCodes.SECRET_STORE_LOCKED, 'store is locked');
    }
  }

  private discardKey(): void {
    if (this.key) zeroize(this.key);
    this.key = null;
  }

  /** Serialize mutations so concurrent writes never interleave nonces/files. */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.writeChain.then(task);
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  private async loadFile(
    passphrase: string,
  ): Promise<{ header: Header; payload: Payload; key: Buffer }> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.filePath);
    } catch {
      throw new SecretStoreError(
        SecretStoreErrorCodes.SECRET_STORE_CORRUPT,
        'secrets file missing',
      );
    }
    const header = decodeHeader(bytes);
    const key = await deriveKey(passphrase, header.salt, header);
    try {
      const aad = bytes.subarray(0, AAD_LENGTH);
      const body = bytes.subarray(HEADER_LENGTH);
      const tagStart = body.length - GCM_TAG_LENGTH;
      if (tagStart < 0) {
        throw new SecretStoreError(
          SecretStoreErrorCodes.SECRET_STORE_CORRUPT,
          'truncated ciphertext',
        );
      }
      const decipher = createDecipheriv('aes-256-gcm', key, header.nonce);
      decipher.setAAD(aad);
      decipher.setAuthTag(body.subarray(tagStart));
      const plaintext = Buffer.concat([
        decipher.update(body.subarray(0, tagStart)),
        decipher.final(),
      ]);
      const parsed = JSON.parse(plaintext.toString('utf8')) as unknown;
      validatePayload(parsed);
      zeroize(plaintext);
      return { header, payload: parsed, key };
    } catch (error) {
      zeroize(key);
      if (error instanceof SecretStoreError) throw error;
      throw new SecretStoreError(
        SecretStoreErrorCodes.SECRET_STORE_AUTH_FAILED,
        'passphrase mismatch or corrupted store',
      );
    }
  }

  private async writeEncryptedFile(passphrase: string, payload: Payload): Promise<void> {
    const salt = randomBytes(SALT_LENGTH);
    const nonce = randomBytes(NONCE_LENGTH);
    const header: Omit<Header, 'nonce'> = {
      version: FORMAT_VERSION,
      kdfId: KDF_SCRYPT,
      scryptN: SCRYPT_DEFAULT.N,
      scryptR: SCRYPT_DEFAULT.r,
      scryptP: SCRYPT_DEFAULT.p,
      salt,
    };
    const key = await deriveKey(passphrase, salt, header);
    try {
      const aad = encodeHeader(header, nonce).subarray(0, AAD_LENGTH);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(aad);
      const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      zeroize(plaintext);
      const file = Buffer.concat([encodeHeader(header, nonce), ciphertext]);
      const temporary = `${this.filePath}.tmp-${randomBytes(4).toString('hex')}`;
      try {
        await writeFile(temporary, file, { flag: 'wx', mode: 0o600 });
        await rename(temporary, this.filePath);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    } finally {
      zeroize(key);
    }
  }

  /** Rewrite the current in-memory records under a fresh nonce. The salt is
   * stable for the passphrase (it rotates only via reEncrypt), the nonce is
   * fresh on every write — so a persisted file always decrypts with the key
   * held in memory. */
  private async persist(): Promise<void> {
    if (!this.isAvailable()) return;
    const header = this.header!;
    const key = this.key!;
    const salt = header.salt;
    const nonce = randomBytes(NONCE_LENGTH);
    const payload = this.payload!;
    const aad = encodeHeader({ ...header, salt }, nonce).subarray(0, AAD_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad);
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    zeroize(plaintext);
    const file = Buffer.concat([encodeHeader({ ...header, salt }, nonce), ciphertext]);
    const temporary = `${this.filePath}.tmp-${randomBytes(4).toString('hex')}`;
    try {
      await writeFile(temporary, file, { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.filePath);
      this.header = { ...header, salt, nonce };
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

export type { SecretRecord };
