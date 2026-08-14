# @neotavern/secret-store (Rust crate `secret-store`)

Canonical kernel-plane SecretStore port (ТЗ §SEC-01 / §SEC-01.1,
[ADR-0040](../../docs/adr/0040-secret-store-port-format.md)). Explicit
backends only — there is never a silent plaintext fallback.

## Purpose

- `FileEncryptedSecretStore` — portable `secrets.enc` **v2**: AES-256-GCM
  over a JSON envelope with an Argon2id-derived key (m=64 MiB / t=3 / p=1),
  authenticated header (magic, formatVer, KDF id/params, salt — AAD, so a
  tampered header can never downgrade the KDF), fresh nonce per write, salt
  stable per passphrase, atomic temp+rename writes, machine-independent key
  derivation (file + passphrase only), `lock()` and staged re-encryption.
- `MemorySecretStore` — session-only values (gone after restart).
- `EnvSecretStore` — read-only `NEOTA_SECRET_*` provider for headless.
- `UnavailableSecretStore` — explicit no-backend error backend.
- `SecretStore` trait, `SecretRef`/`make_ref`/`parse_ref` opaque references
  (`portable:`/`session:`/`env:`, last-colon split), stable error codes.

## Public inputs

- Portable store: the `secrets.enc` path plus the master passphrase at
  `create`/`open`.
- Env store: env map (`NEOTA_SECRET_<namespace>_<id>` names) injected at
  construction (tests) or read from the process environment.
- References: the strings the database persists in `value_ref` columns.

## Dependencies

argon2 0.5, aes-gcm 0.10, rand 0.8, zeroize 1, serde/serde_json 1.
No async runtime, no HTTP, no platform I/O beyond `std::fs` (the kernel is
std-only by design, ADR-0038).

## Development

```bash
cargo test --manifest-path crates/Cargo.toml -p secret-store
cargo clippy --manifest-path crates/Cargo.toml -p secret-store --all-targets
cargo fmt --manifest-path crates/Cargo.toml -p secret-store -- --check
```

## Constraints

- Never log, serialize or include secret values; `describe()` returns
  metadata only and is the only diagnostics surface.
- A legacy v1 (scrypt) file is rejected with an explicit
  `SECRET_STORE_CORRUPT` message until the Этап 3 converter lands.
- OS-vault (Desktop), Keystore (Android) and headless file adapters are
  separate adapter slices wired into the kernel composition root.
