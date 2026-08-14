# ADR-0040: SecretStore port — host backends, portable `secrets.enc` format and crypto parameters

Date: 2026-08-14. Status: Accepted. Related: ТЗ 10/10 rev2 §SEC-01 /
§SEC-01.1 / §19.2 ADR #5, [ADR-0038](0038-canonical-rust-kernel-core.md)
(kernel plane), SEC-01 legacy-contour delivery (CHANGELOG,
`apps/server/src/lib/secretStore.ts`, `packages/secret-store`), RFC 9106.

## Context

ТЗ §19.2 requires ADR #5 — secret storage by host, including the Portable
mode and the cryptographic format — before Stable, and §SEC-01.1 mandates
that the concrete Argon2id parameters be fixed by a security ADR and
benchmark. The legacy-compat contour already ships a SecretStore port
(`packages/secret-store`, scrypt-based `secrets.enc` v1) with the DB storing
only opaque references. The canonical Rust Kernel must own its own
SecretStore port (ТЗ §5.1 Ports) with the same invariants:

- secrets never live in the canonical DB — the DB stores opaque references;
- no backend available ⇒ explicit error or session-only secret, never a
  plaintext fallback;
- portable `secrets.enc` transfers across machines with the file + master
  passphrase only (machine identity is not part of the key derivation);
- format/version and KDF parameters are authenticated (a tampered header can
  never downgrade the KDF);
- auto-lock, manual lock and best-effort zeroization;
- staged passphrase re-encryption without losing the previous file;
- a machine-bound vault reference on another device returns the stable
  `SECRET_UNAVAILABLE_ON_THIS_DEVICE`, not a corruption-looking error.

## Decision

### 1. Host backend matrix

| Host / mode         | Backend                                    | Persistent |
| ------------------- | ------------------------------------------ | ---------- |
| Desktop installed   | OS credential vault / keychain adapter     | Yes        |
| Desktop portable    | `secrets.enc` (this ADR, v2 format)        | Yes        |
| Android             | Android Keystore-backed adapter            | Yes        |
| Headless            | explicit env/file provider or `secrets.enc`; chosen policy documented at deploy | Yes |
| Session-only        | in-memory store                            | No         |

Absence of a usable backend is an explicit configuration error; the runtime
then reports `SECRET_UNAVAILABLE_ON_THIS_DEVICE` / read-only errors — never a
plaintext fallback. OS-vault, Keystore and env/file adapters are separate
adapter crates; this ADR fixes the portable format and the port contract that
all backends implement.

### 2. Portable format — `secrets.enc` v2 (canonical)

- **Authenticated encryption:** AES-256-GCM (permitted by ТЗ §SEC-01.1).
- **KDF:** Argon2id (RFC 9106), versioned parameters.
- **Header layout** (big-endian, fixed offsets; the AAD covers the header so
  every field that affects decryption is authenticated):

  | Offset | Size | Field      | Value                                         |
  | ------ | ---- | ---------- | --------------------------------------------- |
  | 0      | 8    | magic      | ASCII `NEOTASEC`                              |
  | 8      | 4    | formatVer  | `2`                                           |
  | 12     | 1    | kdfId      | `2` = Argon2id                                |
  | 13     | 4    | argon2 m   | 65536 KiB (64 MiB)                            |
  | 17     | 4    | argon2 t   | 3                                             |
  | 21     | 1    | argon2 p   | 1                                             |
  | 22     | 1    | argon2 out | 32                                            |
  | 23     | 16   | salt       | random, stable per passphrase (KDF input)     |
  | 39     | 12   | nonce      | fresh random per write (not in AAD)           |
  | 51     | …    | ciphertext | AES-256-GCM over the JSON payload             |

  AAD = header bytes `[0, 39)` (magic … salt). Nonce is fresh for every
  write; the salt is reused for the lifetime of the store (changing it would
  re-derive the key). Key + plaintext are best-effort zeroized on drop.

- **Payload** (JSON, forward-compatible envelope):

  ```json
  { "format": "neotavern-secrets", "version": 2,
    "records": { "<namespace>": { "<id>": { "value": "...", "createdAt": 123, "updatedAt": 123 } } } }
  ```

- **Reference syntax** (what the DB stores, never the value):
  `portable:<namespace>:<id>` / `session:<namespace>:<id>` /
  `env:<namespace>:<id>`.

- **Parameters rationale (provisional, benchmark-gated).** Argon2id
  m=64 MiB, t=3, p=1 matches the RFC 9106 high-security recommendation and
  the local-first desktop context (interactive unlock at app start, not
  per-request). The ADR fixes these values as the format default; a
  benchmark ADR (ТЗ §16, before Stable) confirms or tunes them on the
  reference environment. Because parameters are versioned in the header,
  a future tune is a non-breaking format evolution.

- **Locking / re-encryption.** `lock()` drops the derived key in memory and
  keeps the file untouched; a read after lock fails with
  `SECRET_STORE_LOCKED`. Passphrase change performs staged re-encryption:
  write the new file to a temporary sibling, verify by re-opening it with
  the new passphrase, then atomically replace; the previous file is only
  removed after the new one verified.

- **Atomicity.** Writes go to a temporary file in the same directory,
  `fsync`, then atomic rename over the target; a crash mid-write leaves
  either the old or the new file, never a torn one.

### 3. Legacy v1 (scrypt) files

The legacy-contour v1 file (`magic NEOTASEC`, formatVer 1, scrypt
N=32768/r=8/p=1, same payload envelope) is a migration input, not a read
format for the kernel: opening a v1 file in the kernel store fails with an
explicit, machine-readable `SECRET_STORE_CORRUPT` whose message names the
legacy version and directs the user to the data-cutover converter
(Этап 3). A converter that reads v1 and rewrites v2 under the canonical
data root is delivered with the kernel SecretStore integration.

### 4. Port contract (kernel `crates/secret-store`)

`SecretStore` trait: `put(namespace, id, value)`, `get(namespace, id)`,
`delete`, `list`, `has`, `is_available`, `describe()`,
`make_ref(namespace, id)` / `parse_ref`, `lock()`, `re_encrypt(passphrase)`.
Errors carry stable codes: `SECRET_STORE_LOCKED`, `SECRET_STORE_CORRUPT`,
`SECRET_STORE_AUTH_FAILED`, `SECRET_STORE_READ_ONLY`, `SECRET_NOT_FOUND`,
`SECRET_STORE_BUSY`. The kernel owns one store instance for its data root;
provider configuration stores references only (mirroring the legacy
contour's `value_ref` contract).

### 5. Acceptance

- Cross-machine portable test: create store in one directory, copy the file
  to a fresh directory/instance, unlock with the same passphrase, values
  readable (no machine identity in KDF).
- Wrong passphrase, corrupted header/ciphertext, interrupted re-encryption
  and format downgrade all fail closed with the stable codes above.
- Sentinel secrets never appear in the canonical DB, logs, exports or
  diagnostics.
- Session-only cleanup: `drop`/restart removes all values.

## Alternatives

- **Keep scrypt as the canonical KDF.** Rejected: ТЗ §SEC-01.1 explicitly
  mandates Argon2id; scrypt remains the legacy v1 migration input.
- **XChaCha20-Poly1305 instead of AES-256-GCM.** Both are permitted by the
  ТЗ; AES-256-GCM keeps cipher parity with the legacy contour and the
  storage crate's existing dependency surface.
- **Binary payload instead of JSON.** Rejected: the JSON envelope keeps the
  v1→v2 converter and future format evolution trivial and auditable.

## Consequences

- The kernel gains `crates/secret-store` (port + portable/session/env/
  unavailable backends) — this round.
- OS-vault (Desktop), Keystore (Android) and headless env/file adapters are
  separate adapter slices wired into the kernel composition root.
- Data cutover (Этап 3) includes the v1→v2 converter; the legacy contour
  keeps its scrypt v1 store for the transition period.
- A benchmark ADR before Stable confirms Argon2id parameters on the
  reference environment; the versioned header makes the change non-breaking.
