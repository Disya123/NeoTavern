//! NeoTavern Runtime Kernel storage foundation (ТЗ §21–§42, Фаза 2).
//!
//! This crate is the Runtime Kernel's authoritative SQLite owner. It provides
//! only foundation storage primitives: the SQLite baseline and connection
//! policy ([`baseline`]), error classification ([`error`]), the exclusive
//! data-root lease ([`lease`]), the initial schema ([`schema`]) and the
//! checksummed migration engine ([`migrations`]), the safe open/inspection
//! sequences ([`open`]), the data-root path layout ([`paths`]), the immutable
//! asset protocol ([`assets`]), consistent online snapshots ([`snapshot`]) and
//! read-only recovery diagnostics ([`recovery`]).
//!
//! The crate knows nothing about product features: there are no character or
//! chat tables here — only the `meta`/`migrations`/`assets` foundations.

pub mod activation;
pub mod assets;
pub mod backup;
pub mod baseline;
pub mod error;
pub mod export;
pub mod lease;
pub mod legacy;
pub mod migration;
pub mod migrations;
pub mod open;
pub mod paths;
pub mod recovery;
pub mod restore;
pub mod schema;
pub mod snapshot;

pub use error::{StorageError, StorageErrorCode};

use std::time::Duration;

/// Current on-disk storage format version (stored in `__neotavern_meta` under
/// [`META_KEY_STORAGE_FORMAT`]).
pub const STORAGE_FORMAT: i64 = 1;

/// Current schema revision (`PRAGMA user_version`).
pub const CURRENT_SCHEMA: i64 = 12;

/// Lowest schema revision that can be opened directly; anything older requires
/// a legacy converter that lives outside this crate.
pub const MIN_DIRECT_SCHEMA: i64 = 1;

/// SQLite `application_id` marking a database file as owned by NeoTavern
/// (`'NTAV'`).
pub const APPLICATION_ID: i32 = 0x4E544156;

/// `__neotavern_meta` key holding the storage format version.
pub const META_KEY_STORAGE_FORMAT: &str = "storageFormat";

/// Default SQLite busy timeout in milliseconds (default [`baseline::ConnectionPolicy`]).
pub const DEFAULT_BUSY_TIMEOUT_MS: u32 = 5000;

/// Upper bound (inclusive) for a configured SQLite busy timeout in milliseconds.
pub const MAX_BUSY_TIMEOUT_MS: u32 = 30000;

/// Default orphan-asset GC grace period (24h): files younger than this are
/// never collected, regardless of ledger references.
pub const ASSET_GRACE_PERIOD: Duration = Duration::from_secs(86400);

/// Maximum length of a managed relative asset key, in UTF-8 bytes.
pub const MAX_RELATIVE_KEY_LEN: usize = 512;

/// UTC now as RFC 3339 with seconds precision, e.g. `2026-08-12T22:10:00Z`.
///
/// Uses the `time` crate and never panics: Rfc3339 formatting can only fail
/// for out-of-range components, which `now_utc()` can never produce; the
/// unreachable failure path falls back to a manual zero-padded render of the
/// same components.
pub fn now_utc_rfc3339() -> String {
    use time::format_description::well_known::Rfc3339;

    match time::OffsetDateTime::now_utc().format(&Rfc3339) {
        Ok(formatted) => formatted,
        Err(_) => {
            // Unreachable for `now_utc()`; kept only to uphold the
            // "never panics" contract.
            let now = time::OffsetDateTime::now_utc();
            format!(
                "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
                now.year(),
                now.month() as u8,
                now.day(),
                now.hour(),
                now.minute(),
                now.second(),
            )
        }
    }
}
