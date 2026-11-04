//! Kernel-resident plugin executor loop (ADR-0064).
//!
//! The queue (`plugin_jobs`) and the scheduling state machine
//! (`plugin_executor`) already exist; this module is the loop that drains them.
//! It is the component ADR-0064's security checklist talks about, so it is
//! deliberately small and closed by default:
//!
//! - [`RunnerOptions::enabled`] is `false` unless the host turns execution on —
//!   the kill switch. With it off, nothing is claimed and the queue only grows.
//! - [`RunnerOptions::allow_exposure`] is `false` by default and gates every
//!   secret reveal, mirroring `secrets.exposure` for the wire op. A job that
//!   needs a secret fails with `SECRETS_EXPOSURE_DISABLED` when it is off.
//! - Secrets are reached ONLY through [`SecretAccess`], one key at a time, and
//!   resolved against the plugin's `user` scope with the `secrets.reveal` grant
//!   checked on every call. The value is handed to the handler in memory; it is
//!   never written to the job row, a DTO, an error message or a metric.
//! - A handler is trusted Rust (a host adapter), not plugin JavaScript. The
//!   untrusted sandbox stays in the host process: the kernel never executes
//!   plugin code, it hands a trusted adapter what the job is allowed to see.
//!
//! Audit trail: the job row itself — one row per job, `attempts` per lease,
//! bounded `last_error`, and timestamps for every transition. Secret key names
//! are not recorded by this module; a handler that wants an audit line records
//! it (without the value) through its own sink.

use std::sync::Arc;

use neotavern_storage::open::Database;
use plugin_executor::{self as scheduler, Outcome};
use secret_store::SecretStore;

use crate::plugin_jobs;
use crate::plugin_secrets;
use crate::KernelError;

/// One drain pass configuration. Defaults are closed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerOptions {
    /// Kill switch: when false, [`run_due`] claims nothing.
    pub enabled: bool,
    /// Whether a job may read secret values at all (`secrets.exposure` analog).
    pub allow_exposure: bool,
    /// Lease handed to a claimed job; a crashed run returns it to the queue.
    pub lease_ms: i64,
    /// Upper bound on jobs per pass, so one pass cannot starve the writer.
    pub max_jobs: usize,
}

impl Default for RunnerOptions {
    fn default() -> Self {
        Self {
            enabled: false,
            allow_exposure: false,
            lease_ms: scheduler::DEFAULT_LEASE_MS,
            max_jobs: 8,
        }
    }
}

/// What a job sees of itself: no lease, no attempts bookkeeping, no secrets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobInvocation {
    /// Kernel-assigned job id.
    pub job_id: String,
    /// Owning plugin (authoritative for grants — never read from the payload).
    pub plugin_id: String,
    /// Job kind the plugin registered.
    pub kind: String,
    /// Opaque plugin JSON, already bounded and validated at enqueue.
    pub payload_json: String,
    /// Lease number this run is (1 for the first attempt).
    pub attempts: u32,
}

/// The only path from a running job to secret material.
pub trait SecretAccess {
    /// Reads one `user`-scope secret of the job's plugin.
    ///
    /// Fails with the product codes `SECRETS_EXPOSURE_DISABLED`,
    /// `SECRET_UNAVAILABLE`, `PLUGIN_SECRET_NOT_FOUND` or the plugin's grant
    /// refusal — never with a value in the message.
    fn reveal(&mut self, key: &str) -> Result<String, KernelError>;
}

/// A trusted consumer of jobs (a host adapter).
pub trait PluginJobHandler: Send + Sync {
    /// Runs one job. `Err(message)` marks the attempt failed; the scheduler
    /// decides retry vs terminal failure and stores the bounded message.
    fn run(&self, job: &JobInvocation, secrets: &mut dyn SecretAccess) -> Result<(), String>;
}

/// Outcome of one drain pass.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct RunReport {
    /// Jobs claimed this pass.
    pub claimed: usize,
    /// Jobs that reported success.
    pub succeeded: usize,
    /// Jobs that reported failure (retryable or terminal).
    pub failed: usize,
    /// True when the kill switch was off and nothing was claimed.
    pub skipped: bool,
}

struct SecretSession<'a> {
    db: &'a Database,
    store: Option<&'a Arc<dyn SecretStore>>,
    plugin_id: &'a str,
    allow_exposure: bool,
}

impl SecretAccess for SecretSession<'_> {
    fn reveal(&mut self, key: &str) -> Result<String, KernelError> {
        if !self.allow_exposure {
            return Err(KernelError::product(
                "SECRETS_EXPOSURE_DISABLED".to_string(),
                vec![("pluginId".to_string(), self.plugin_id.to_string())],
            ));
        }
        plugin_secrets::resolve_for_executor(self.db, self.store, self.plugin_id, key)
    }
}

/// Drains up to `options.max_jobs` due jobs through `handler`.
///
/// Claiming is sequential on purpose: the kernel has one writer connection, and
/// a job runs synchronously, so a second worker could only fight for the same
/// lock. Parallelism belongs to the host adapters that the handler dispatches to.
pub fn run_due(
    db: &Database,
    store: Option<&Arc<dyn SecretStore>>,
    handler: &dyn PluginJobHandler,
    options: &RunnerOptions,
) -> Result<RunReport, KernelError> {
    if !options.enabled {
        return Ok(RunReport {
            skipped: true,
            ..RunReport::default()
        });
    }
    let mut report = RunReport::default();
    for _ in 0..options.max_jobs {
        let Some(mut job) = plugin_jobs::claim_next(db, options.lease_ms)? else {
            break;
        };
        report.claimed += 1;
        let invocation = JobInvocation {
            job_id: job.id.clone(),
            plugin_id: job.plugin_id.clone(),
            kind: job.kind.clone(),
            payload_json: job.payload.clone(),
            attempts: job.attempts,
        };
        let outcome = {
            let mut session = SecretSession {
                db,
                store,
                plugin_id: &job.plugin_id,
                allow_exposure: options.allow_exposure,
            };
            match handler.run(&invocation, &mut session) {
                Ok(()) => Outcome::Success,
                Err(message) => Outcome::Failure(message),
            }
        };
        match outcome {
            Outcome::Success => {
                plugin_jobs::complete(db, &mut job, Outcome::Success)?;
                report.succeeded += 1;
            }
            Outcome::Failure(message) => {
                plugin_jobs::complete(db, &mut job, Outcome::Failure(message))?;
                report.failed += 1;
            }
        }
    }
    Ok(report)
}
