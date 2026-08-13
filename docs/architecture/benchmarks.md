# Benchmark manifest (ТЗ §84)

> **Status.** Version 1, measured 2026-08-13 on the reference development PC
> (AMD Ryzen 5 5600, Windows 11, NTFS). Numbers are **debug** Rust builds
> (`cargo run --example`); a release-profile re-measurement is required before
> any release gate cites them (ТЗ §84: PR/Nightly compare against an approved
> baseline; exceeding a threshold blocks or requires an ADR).

## Reference hardware / fixture

| Axis | Value |
| --- | --- |
| CPU | AMD Ryzen 5 5600 (6C/12T) |
| OS | Windows 11 Pro (NTFS) |
| Rust profile | debug (bundled SQLite 3.53.2, WAL, `synchronous=FULL`) |
| Fixture | 200 characters, 50 chats, 5 000 messages (16×"message content " bodies) |
| Database size | 2 650 112 bytes |
| Export size | 2 283 530 bytes |
| Measurement | `crates/storage/examples/phase11_bench.rs` (wall clock, single run; p50/p95 sampling lands with the Nightly harness) |

## Phase 11 portable-data budgets

| Metric | Measured (debug) | Budget |
| --- | --- | --- |
| Backup throughput (2.53 MiB DB + assets) | 11.9 MiB/s (212 ms) | ≥ 5 MiB/s on reference hardware |
| Restore throughput (verify + stage + activate) | 8.2 MiB/s (308 ms) | ≥ 4 MiB/s |
| Export throughput (NDJSON + assets) | 10.7 MiB/s (203 ms) | ≥ 5 MiB/s |
| Fixture seed (5 250 rows, one transaction) | 134 ms | informational |

Budgets are set at ~2× below the debug measurement so a release build passes
with wide margin while a regression that halves throughput is caught.

## Carried-over targets (ТЗ §24 / §84, unchanged)

- startup to ready UI ≤ 4 s (reference PC);
- backend idle ≤ 180 MB RAM;
- first page of 100 000 characters ≤ 300 ms;
- 10 000-message chat open ≤ 700 ms to latest messages;
- ≤ 30 UI updates/s while streaming;
- initial frontend bundle ≤ 2 MB gzip without lazy chunks.

These remain owned by their phases' gates; this manifest only adds the
Phase 11 portable-data rows and the measurement method.

## Method notes

- Every number is reproducible by running the example; the fixture is
  deterministic (fixed ids, fixed timestamps).
- Backup includes the Online-Backup snapshot, pinned asset copies, checksum
  computation and container finalization.
- Restore includes full container verification (inventory checksums,
  `quick_check`, schema window), candidate staging, candidate open with
  migrations and integrity checks, and the atomic activation.
- Export includes NDJSON serialization, asset copies and the checksummed
  inventory; import verification cost is covered by the round-trip tests,
  not this throughput row.
