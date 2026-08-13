//! Portable built-in provider adapters (ТЗ §55, Фаза 7).
//!
//! Two adapters over the frozen [`provider_sdk::ProviderAdapter`] contract:
//!
//! - [`fake::FakeProvider`] — the deterministic built-in fake (byte-identical
//!   port of the Phase 6 kernel inline fake; delta text derives from
//!   `sha256(run_key|i)` — no wall clock).
//! - [`recorded::RecordedProvider`] — replays committed JSON scripts for
//!   cancellation, deadline, fault-injection and stop-signal conformance.
//!
//! Both stream text deltas with prompt cancellation/deadline handling, never
//! retry a billable attempt internally, and never touch secret values.

pub mod fake;
pub mod recorded;

pub use fake::FakeProvider;
pub use recorded::{RecordedProvider, RecordedScript, RecordedStep};

use std::time::Duration;

use provider_sdk::policy::Deadline;
use provider_sdk::{CancelToken, ProviderError, ProviderErrorCode};

/// Maximum sleep slice (ms): cancellation and the deadline are re-checked at
/// most this often during any provider delay, so a provider stops promptly
/// (§63).
const SLEEP_SLICE_MS: u64 = 10;

/// Sleeps `ms` milliseconds in [`SLEEP_SLICE_MS`] slices, re-checking
/// cancellation and the deadline between slices.
///
/// Returns `Err(Cancelled)` when cancellation is observed and
/// `Err(Timeout)` once the deadline has expired.
pub(crate) fn sleep_checking(
    cancel: &CancelToken<'_>,
    deadline: Option<Deadline>,
    mut ms: u64,
) -> Result<(), ProviderError> {
    while ms > 0 {
        if cancel.is_cancelled() {
            return Err(ProviderError::new(
                ProviderErrorCode::Cancelled,
                "cancelled during provider delay",
            ));
        }
        if deadline.is_some_and(|d| d.expired()) {
            return Err(ProviderError::new(
                ProviderErrorCode::Timeout,
                "deadline expired during provider delay",
            ));
        }
        let slice = ms.min(SLEEP_SLICE_MS);
        std::thread::sleep(Duration::from_millis(slice));
        ms -= slice;
    }
    Ok(())
}
