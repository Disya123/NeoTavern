//! Kernel-resident plugin job scheduler (ADR-0064).
//!
//! This crate is the **state machine**, not the runner: it knows what a job is,
//! which transitions are legal, when a lease expires and how retries back off.
//! It owns no database, no threads and no clock — the kernel calls it with a
//! `now_ms` it read from the store, which keeps every transition testable and
//! makes replay deterministic.
//!
//! Why a separate crate: the executor is the piece that later injects plugin
//! secrets into a running task, so its scheduling rules must be reviewable on
//! their own and free of I/O surprises. ADR-0064 records the security model and
//! the review checklist that gates switching execution on.
//!
//! Invariants enforced here:
//!
//! - **A job never carries secret material.** `payload` is opaque JSON produced
//!   by the plugin, bounded to [`MAX_PAYLOAD_BYTES`]; secrets are resolved by the
//!   kernel at run time through the broker seam, not copied into job state.
//! - **`attempts` counts leases, not failures.** Claiming increments it, so a
//!   worker that dies mid-run cannot retry forever by never reporting back.
//! - **Terminal states are terminal.** `succeeded`/`failed`/`cancelled` never
//!   move again; a late `complete` on a terminal job is an error, not a silent
//!   overwrite (the same rule the wire applies to stale revisions).
//! - **Ordering is deterministic.** Due jobs are claimed by
//!   `(run_at, created_at, id)`, so two identical queues claim in the same order
//!   on every host.

use serde::{Deserialize, Serialize};

/// Largest opaque payload a job may carry (64 KiB), matching the plugin KV
/// quota so a plugin cannot use the queue as unbounded storage.
pub const MAX_PAYLOAD_BYTES: usize = 64 * 1024;
/// Retries applied when the caller does not say otherwise.
pub const DEFAULT_MAX_ATTEMPTS: u32 = 3;
/// Upper bound on attempts, so a wedged plugin cannot pin a worker forever.
pub const MAX_ATTEMPTS_LIMIT: u32 = 10;
/// Default lease: long enough for a timer tick, short enough that a crashed
/// worker's job returns to the queue in about a minute.
pub const DEFAULT_LEASE_MS: i64 = 60_000;
/// Retry backoff ceiling (5 minutes).
pub const MAX_BACKOFF_MS: i64 = 5 * 60_000;

/// Lifecycle of one job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum JobState {
    /// Waiting for a worker.
    Queued,
    /// Handed to a worker under a lease.
    Leased,
    /// Finished successfully.
    Succeeded,
    /// Exhausted its attempts or failed permanently.
    Failed,
    /// Cancelled by the plugin or the user.
    Cancelled,
}

impl JobState {
    /// Stable wire spelling (`queued`, `leased`, …).
    pub fn as_str(self) -> &'static str {
        match self {
            JobState::Queued => "queued",
            JobState::Leased => "leased",
            JobState::Succeeded => "succeeded",
            JobState::Failed => "failed",
            JobState::Cancelled => "cancelled",
        }
    }

    /// Parses the wire spelling; unknown values are `None` rather than a guess.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "queued" => Some(JobState::Queued),
            "leased" => Some(JobState::Leased),
            "succeeded" => Some(JobState::Succeeded),
            "failed" => Some(JobState::Failed),
            "cancelled" => Some(JobState::Cancelled),
            _ => None,
        }
    }

    /// Terminal states never move again.
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            JobState::Succeeded | JobState::Failed | JobState::Cancelled
        )
    }
}

/// One queued unit of plugin work.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Job {
    /// Kernel-assigned id.
    pub id: String,
    /// Owning plugin.
    pub plugin_id: String,
    /// Job kind the plugin and the executor agree on (`timer`, `task`, …).
    pub kind: String,
    /// Opaque JSON payload, bounded by [`MAX_PAYLOAD_BYTES`].
    pub payload: String,
    /// Current state.
    pub state: JobState,
    /// Leases taken so far.
    pub attempts: u32,
    /// Attempt ceiling.
    pub max_attempts: u32,
    /// Earliest time a worker may claim it (unix ms).
    pub run_at_ms: i64,
    /// Lease expiry when `state == Leased`.
    pub lease_until_ms: Option<i64>,
    /// Last failure message, if any.
    pub last_error: Option<String>,
    /// Creation time (unix ms).
    pub created_at_ms: i64,
    /// Last transition time (unix ms).
    pub updated_at_ms: i64,
}

/// What the caller asks for when enqueuing.
pub struct Enqueue<'a> {
    /// Owning plugin.
    pub plugin_id: &'a str,
    /// Job kind.
    pub kind: &'a str,
    /// Opaque JSON payload (defaults to `{}`).
    pub payload: &'a str,
    /// Earliest run time (unix ms); `None` means "now".
    pub run_at_ms: Option<i64>,
    /// Attempt ceiling; `None` means [`DEFAULT_MAX_ATTEMPTS`].
    pub max_attempts: Option<u32>,
}

/// Outcome a worker reports on completion.
pub enum Outcome {
    /// The job did its work.
    Success,
    /// It failed; the scheduler decides retry vs terminal failure.
    Failure(String),
}

/// Why a transition was refused. Each variant maps to a product code at the
/// wire boundary instead of surfacing as an internal error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobError {
    /// Plugin id empty or too long.
    InvalidPluginId,
    /// Kind empty or too long.
    InvalidKind,
    /// Payload is not valid JSON.
    PayloadNotJson,
    /// Payload exceeds [`MAX_PAYLOAD_BYTES`].
    PayloadTooLarge(usize),
    /// Attempt ceiling outside `1..=MAX_ATTEMPTS_LIMIT`.
    InvalidMaxAttempts,
    /// Transition needs a leased job.
    NotLeased,
    /// Terminal job cannot transition.
    Terminal,
}

/// Truncates a worker's failure message to a bounded, single-line form.
fn bounded_error(message: &str) -> String {
    const LIMIT: usize = 500;
    let cleaned: String = message
        .chars()
        .map(|ch| if ch == '\n' || ch == '\r' { ' ' } else { ch })
        .take(LIMIT)
        .collect();
    cleaned
}

/// Retry delay after the given number of attempts: 1s, 2s, 4s … capped at
/// [`MAX_BACKOFF_MS`]. Deterministic (no jitter) because the scheduler must be
/// replayable; the lease — not jitter — is what prevents herd retries.
pub fn backoff_ms(attempts: u32) -> i64 {
    let exponent = attempts.saturating_sub(1).min(16);
    (1_000i64 << exponent).min(MAX_BACKOFF_MS)
}

/// Creates a queued job, validating everything the wire would reject later.
pub fn enqueue(id: &str, request: &Enqueue<'_>, now_ms: i64) -> Result<Job, JobError> {
    if request.plugin_id.is_empty() || request.plugin_id.len() > 64 {
        return Err(JobError::InvalidPluginId);
    }
    if request.kind.is_empty() || request.kind.len() > 32 {
        return Err(JobError::InvalidKind);
    }
    if request.payload.len() > MAX_PAYLOAD_BYTES {
        return Err(JobError::PayloadTooLarge(request.payload.len()));
    }
    if serde_json::from_str::<serde_json::Value>(request.payload).is_err() {
        return Err(JobError::PayloadNotJson);
    }
    let max_attempts = request.max_attempts.unwrap_or(DEFAULT_MAX_ATTEMPTS);
    if max_attempts == 0 || max_attempts > MAX_ATTEMPTS_LIMIT {
        return Err(JobError::InvalidMaxAttempts);
    }
    Ok(Job {
        id: id.to_string(),
        plugin_id: request.plugin_id.to_string(),
        kind: request.kind.to_string(),
        payload: request.payload.to_string(),
        state: JobState::Queued,
        attempts: 0,
        max_attempts,
        run_at_ms: request.run_at_ms.unwrap_or(now_ms),
        lease_until_ms: None,
        last_error: None,
        created_at_ms: now_ms,
        updated_at_ms: now_ms,
    })
}

/// Claims the next due job and returns its index.
///
/// Ordering is `(run_at_ms, created_at_ms, id)`; only `queued` jobs whose
/// `run_at_ms` has arrived are eligible. Claiming increments `attempts` and sets
/// the lease, so a worker that never reports back still releases on expiry.
pub fn claim(jobs: &mut [Job], now_ms: i64, lease_ms: i64) -> Option<usize> {
    let mut best: Option<usize> = None;
    for (index, job) in jobs.iter().enumerate() {
        if job.state != JobState::Queued || job.run_at_ms > now_ms {
            continue;
        }
        let key = (job.run_at_ms, job.created_at_ms, job.id.as_str());
        let better = match best {
            None => true,
            Some(current) => {
                let other = &jobs[current];
                key < (other.run_at_ms, other.created_at_ms, other.id.as_str())
            }
        };
        if better {
            best = Some(index);
        }
    }
    let index = best?;
    let job = &mut jobs[index];
    job.state = JobState::Leased;
    job.attempts = job.attempts.saturating_add(1);
    job.lease_until_ms = Some(now_ms.saturating_add(lease_ms.max(1)));
    job.updated_at_ms = now_ms;
    Some(index)
}

/// Reports an outcome for a leased job.
///
/// Success is terminal. Failure re-queues with [`backoff_ms`] while attempts
/// remain, and fails terminally once they are exhausted.
pub fn complete(job: &mut Job, outcome: Outcome, now_ms: i64) -> Result<(), JobError> {
    if job.state.is_terminal() {
        return Err(JobError::Terminal);
    }
    if job.state != JobState::Leased {
        return Err(JobError::NotLeased);
    }
    match outcome {
        Outcome::Success => {
            job.state = JobState::Succeeded;
            job.lease_until_ms = None;
            job.last_error = None;
        }
        Outcome::Failure(message) => {
            job.last_error = Some(bounded_error(&message));
            job.lease_until_ms = None;
            if job.attempts >= job.max_attempts {
                job.state = JobState::Failed;
            } else {
                job.state = JobState::Queued;
                job.run_at_ms = now_ms.saturating_add(backoff_ms(job.attempts));
            }
        }
    }
    job.updated_at_ms = now_ms;
    Ok(())
}

/// Cancels a job that has not finished. Terminal jobs refuse (`Terminal`), so a
/// late cancel cannot rewrite history.
pub fn cancel(job: &mut Job, now_ms: i64) -> Result<(), JobError> {
    if job.state.is_terminal() {
        return Err(JobError::Terminal);
    }
    job.state = JobState::Cancelled;
    job.lease_until_ms = None;
    job.updated_at_ms = now_ms;
    Ok(())
}

/// Returns expired leases to the queue. Returns how many were released.
///
/// The attempt taken by the dead worker is NOT refunded: that is what bounds a
/// crash-looping job.
pub fn release_expired(jobs: &mut [Job], now_ms: i64) -> usize {
    let mut released = 0;
    for job in jobs.iter_mut() {
        if job.state == JobState::Leased && job.lease_until_ms.is_some_and(|until| until <= now_ms)
        {
            job.state = JobState::Queued;
            job.lease_until_ms = None;
            job.updated_at_ms = now_ms;
            released += 1;
        }
    }
    released
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request<'a>(plugin: &'a str, payload: &'a str) -> Enqueue<'a> {
        Enqueue {
            plugin_id: plugin,
            kind: "timer",
            payload,
            run_at_ms: None,
            max_attempts: None,
        }
    }

    #[test]
    fn enqueue_validates_and_defaults() {
        let job = enqueue("j1", &request("plugin-a", "{\"tick\":1}"), 1_000).expect("queued");
        assert_eq!(job.state, JobState::Queued);
        assert_eq!(job.attempts, 0);
        assert_eq!(job.max_attempts, DEFAULT_MAX_ATTEMPTS);
        assert_eq!(job.run_at_ms, 1_000);

        assert_eq!(
            enqueue("j2", &request("", "{}"), 0),
            Err(JobError::InvalidPluginId)
        );
        assert_eq!(
            enqueue("j3", &request("p", "not json"), 0),
            Err(JobError::PayloadNotJson)
        );
        let huge = format!("{{\"x\":\"{}\"}}", "a".repeat(MAX_PAYLOAD_BYTES));
        assert!(matches!(
            enqueue("j4", &request("p", &huge), 0),
            Err(JobError::PayloadTooLarge(_))
        ));
        let bad_attempts = Enqueue {
            max_attempts: Some(0),
            ..request("p", "{}")
        };
        assert_eq!(
            enqueue("j5", &bad_attempts, 0),
            Err(JobError::InvalidMaxAttempts)
        );
    }

    #[test]
    fn claims_in_deterministic_order_and_counts_attempts() {
        let mut jobs = vec![
            enqueue("b", &request("p", "{}"), 100).expect("b"),
            enqueue("a", &request("p", "{}"), 100).expect("a"),
            enqueue("later", &request("p", "{}"), 500).expect("later"),
        ];
        // Both `a` and `b` are due at 100; ties break on id.
        let first = claim(&mut jobs, 100, 1_000).expect("claim");
        assert_eq!(jobs[first].id, "a");
        assert_eq!(jobs[first].attempts, 1);
        assert_eq!(jobs[first].lease_until_ms, Some(1_100));
        let second = claim(&mut jobs, 100, 1_000).expect("claim");
        assert_eq!(jobs[second].id, "b");
        // Nothing else is due yet.
        assert!(claim(&mut jobs, 100, 1_000).is_none());
        let third = claim(&mut jobs, 500, 1_000).expect("claim");
        assert_eq!(jobs[third].id, "later");
    }

    #[test]
    fn failure_retries_with_backoff_then_fails_terminally() {
        let mut job = enqueue("j", &request("p", "{}"), 0).expect("job");
        job.max_attempts = 2;

        assert_eq!(job.state, JobState::Queued);
        claim(std::slice::from_mut(&mut job), 0, 1_000);
        complete(&mut job, Outcome::Failure("boom\nline".into()), 10).expect("retry");
        assert_eq!(job.state, JobState::Queued);
        assert_eq!(job.run_at_ms, 10 + backoff_ms(1));
        assert_eq!(job.last_error.as_deref(), Some("boom line"));

        claim(std::slice::from_mut(&mut job), 2_000, 1_000);
        complete(&mut job, Outcome::Failure("again".into()), 2_000).expect("terminal");
        assert_eq!(job.state, JobState::Failed);
        // Terminal is terminal.
        assert_eq!(
            complete(&mut job, Outcome::Success, 2_001),
            Err(JobError::Terminal)
        );
    }

    #[test]
    fn expired_lease_requeues_without_refunding_the_attempt() {
        let mut jobs = vec![enqueue("j", &request("p", "{}"), 0).expect("job")];
        claim(&mut jobs, 0, 1_000);
        assert_eq!(release_expired(&mut jobs, 500), 0);
        assert_eq!(release_expired(&mut jobs, 1_000), 1);
        assert_eq!(jobs[0].state, JobState::Queued);
        assert_eq!(jobs[0].attempts, 1);
        claim(&mut jobs, 1_000, 1_000);
        assert_eq!(jobs[0].attempts, 2);
    }

    #[test]
    fn cancel_refuses_terminal_jobs() {
        let mut job = enqueue("j", &request("p", "{}"), 0).expect("job");
        cancel(&mut job, 5).expect("cancel queued");
        assert_eq!(job.state, JobState::Cancelled);
        assert_eq!(cancel(&mut job, 6), Err(JobError::Terminal));
    }

    #[test]
    fn complete_requires_a_lease() {
        let mut job = enqueue("j", &request("p", "{}"), 0).expect("job");
        assert_eq!(
            complete(&mut job, Outcome::Success, 0),
            Err(JobError::NotLeased)
        );
    }

    #[test]
    fn backoff_is_bounded() {
        assert_eq!(backoff_ms(1), 1_000);
        assert_eq!(backoff_ms(3), 4_000);
        assert_eq!(backoff_ms(30), MAX_BACKOFF_MS);
    }
}
