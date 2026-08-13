//! Timeout, deadline and retry policy primitives (§55).
//!
//! Retry policy here is advisory metadata only: a provider call is executed
//! exactly once per [`super::ProviderAdapter::generate`] invocation, and any
//! retry is a new user-visible generation attempt (`generation.retry`) — never
//! a hidden repeat (§55, §87 blind-retry prohibition).

use std::time::{Duration, Instant};

/// Monotonic deadline for one provider attempt.
#[derive(Debug, Clone, Copy)]
pub struct Deadline(Instant);

impl Deadline {
    /// A deadline `d` from now (monotonic clock).
    pub fn after(d: Duration) -> Self {
        Self(Instant::now() + d)
    }

    /// True once the deadline has passed.
    pub fn expired(&self) -> bool {
        Instant::now() >= self.0
    }

    /// Time left, `None` when already expired.
    pub fn remaining(&self) -> Option<Duration> {
        self.0.checked_duration_since(Instant::now())
    }
}

/// How many provider attempts the kernel may execute for one workflow.
///
/// `1` (the default, [`RetryPolicy::NO_RETRY`]) forbids any repeat; larger
/// values still require each attempt to be a durable, user-visible retry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    /// Maximum provider attempts per workflow.
    pub max_provider_attempts: u32,
}

impl RetryPolicy {
    /// No hidden retry: exactly one attempt.
    pub const NO_RETRY: RetryPolicy = RetryPolicy {
        max_provider_attempts: 1,
    };

    /// Whether a 1-based `attempt` number is allowed.
    pub fn allows(&self, attempt: u32) -> bool {
        attempt >= 1 && attempt <= self.max_provider_attempts
    }
}

/// Normalized usage accounting for one attempt (§55).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    /// Number of produced steps (deltas).
    pub steps: u64,
    /// Total output characters produced.
    pub output_chars: u64,
}
