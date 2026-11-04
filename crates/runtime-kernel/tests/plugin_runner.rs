//! Executor loop (`plugin_runner`, ADR-0064): claim → run → complete, with the
//! secret path closed unless every gate agrees.
//!
//! These tests drive the runner against a real storage root (the same open path
//! the kernel uses) and assert the four promises the security checklist makes:
//!
//! 1. the kill switch claims nothing;
//! 2. a claimed job hands its opaque payload to the handler and completes;
//! 3. a secret is reachable only with the `secrets.reveal` grant AND the
//!    exposure flag, and only for the plugin that owns the job;
//! 4. nothing secret lands in the job row — not the payload, not `last_error`.

use std::sync::{Arc, Mutex};

use runtime_kernel::plugin_runner::{
    run_due, JobInvocation, PluginJobHandler, RunnerOptions, SecretAccess,
};
use secret_store::memory::MemorySecretStore;
use secret_store::SecretStore;

const PLUGIN_ID: &str = "clockwork-jobs";
const JOB_ID: &str = "00000000-0000-4000-8000-0000000000aa";
const SECRET_KEY: &str = "API_KEY";
const SECRET_VALUE: &str = "sk-live-executor-secret";

fn open_db(root: &std::path::Path) -> neotavern_storage::open::Database {
    let mut progress = |_p: neotavern_storage::migrations::MigrationProgress| {};
    neotavern_storage::open::open(
        root,
        &neotavern_storage::baseline::ConnectionPolicy::default(),
        &mut progress,
    )
    .expect("data root must open")
}

fn seed_plugin(db: &neotavern_storage::open::Database, permissions: &[&str]) {
    let permissions_json = serde_json::to_string(permissions).expect("permissions encode");
    db.conn()
        .execute(
            "INSERT INTO plugins (id, name, version, enabled, manifest_json, permissions_json, \
             trust_state, installed_at, updated_at) \
             VALUES (?1, 'Jobs Test', '1.0.0', 1, '{}', ?2, 'locally-trusted', \
             '2026-11-04T00:00:00Z', '2026-11-04T00:00:00Z')",
            rusqlite::params![PLUGIN_ID, permissions_json],
        )
        .expect("seed plugin");
}

fn seed_job(db: &neotavern_storage::open::Database, max_attempts: i64) {
    db.conn()
        .execute(
            "INSERT INTO plugin_jobs (id, plugin_id, kind, payload_json, state, attempts, \
             max_attempts, run_at_ms, lease_until_ms, last_error, created_at_ms, updated_at_ms) \
             VALUES (?1, ?2, 'timer', '{\"tick\":1}', 'queued', 0, ?3, 0, NULL, NULL, 0, 0)",
            rusqlite::params![JOB_ID, PLUGIN_ID, max_attempts],
        )
        .expect("seed job");
}

fn seed_secret(db: &neotavern_storage::open::Database, store: &MemorySecretStore) {
    // Same shape the wire `plugins.secrets.set` writes: a value-free row plus a
    // store entry under `plugin-secret:<plugin>` keyed `user::<key>`.
    db.conn()
        .execute(
            "INSERT INTO plugin_secrets (plugin_id, scope, owner_key, key, secret_ref, created_at, updated_at) \
             VALUES (?1, 'user', '', ?2, 'session:opaque-ref', \
             '2026-11-04T00:00:00Z', '2026-11-04T00:00:00Z')",
            rusqlite::params![PLUGIN_ID, SECRET_KEY],
        )
        .expect("seed secret row");
    store
        .put(
            &format!("plugin-secret:{PLUGIN_ID}"),
            &format!("user::{SECRET_KEY}"),
            SECRET_VALUE,
        )
        .expect("seed secret value");
}

fn job_state(db: &neotavern_storage::open::Database) -> (String, i64, Option<String>) {
    db.conn()
        .query_row(
            "SELECT state, attempts, last_error FROM plugin_jobs WHERE id = ?1",
            rusqlite::params![JOB_ID],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("job row")
}

/// Handler that records what it saw and optionally reveals one secret.
#[derive(Default)]
struct Recorder {
    payloads: Mutex<Vec<String>>,
    revealed: Mutex<Vec<Result<String, String>>>,
    reveal_key: Option<&'static str>,
    fail_with: Option<String>,
}

impl PluginJobHandler for Recorder {
    fn run(&self, job: &JobInvocation, secrets: &mut dyn SecretAccess) -> Result<(), String> {
        self.payloads
            .lock()
            .expect("lock")
            .push(job.payload_json.clone());
        if let Some(key) = self.reveal_key {
            let outcome = secrets.reveal(key).map_err(|error| {
                error
                    .product
                    .as_deref()
                    .map(|product| product.code.clone())
                    .unwrap_or_else(|| "INTERNAL".to_string())
            });
            // A handler that NEEDS the secret fails when it cannot have it; that
            // is what makes a missing grant or a disabled exposure visible in the
            // job row instead of silently running without credentials.
            let code = outcome.as_ref().err().cloned();
            self.revealed.lock().expect("lock").push(outcome);
            if let Some(code) = code {
                return Err(code);
            }
        }
        match &self.fail_with {
            Some(message) => Err(message.clone()),
            None => Ok(()),
        }
    }
}

fn enabled() -> RunnerOptions {
    RunnerOptions {
        enabled: true,
        allow_exposure: true,
        lease_ms: 60_000,
        max_jobs: 8,
    }
}

#[test]
fn the_kill_switch_claims_nothing() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = open_db(dir.path());
    seed_plugin(&db, &["jobs.enqueue"]);
    seed_job(&db, 3);

    let recorder = Recorder::default();
    let report = run_due(&db, None, &recorder, &RunnerOptions::default()).expect("pass");

    assert!(report.skipped, "defaults disable execution");
    assert_eq!(report.claimed, 0);
    assert_eq!(job_state(&db).0, "queued");
    assert!(recorder.payloads.lock().expect("lock").is_empty());
}

#[test]
fn a_claimed_job_reaches_the_handler_and_completes() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = open_db(dir.path());
    seed_plugin(&db, &["jobs.enqueue"]);
    seed_job(&db, 3);

    let recorder = Recorder::default();
    let report = run_due(&db, None, &recorder, &enabled()).expect("pass");

    assert_eq!(report.claimed, 1);
    assert_eq!(report.succeeded, 1);
    assert_eq!(
        recorder.payloads.lock().expect("lock").as_slice(),
        ["{\"tick\":1}"],
        "the opaque payload is handed over verbatim"
    );
    let (state, attempts, last_error) = job_state(&db);
    assert_eq!(state, "succeeded");
    assert_eq!(attempts, 1, "one lease");
    assert!(last_error.is_none());
}

#[test]
fn a_secret_is_injected_only_with_grant_and_exposure() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = open_db(dir.path());
    seed_plugin(&db, &["jobs.enqueue", "secrets.reveal"]);
    seed_job(&db, 3);
    let store = MemorySecretStore::new();
    seed_secret(&db, &store);
    let store: Arc<dyn SecretStore> = Arc::new(store);

    let recorder = Recorder {
        reveal_key: Some(SECRET_KEY),
        ..Recorder::default()
    };
    let report = run_due(&db, Some(&store), &recorder, &enabled()).expect("pass");

    assert_eq!(report.succeeded, 1);
    let revealed = recorder.revealed.lock().expect("lock");
    assert_eq!(revealed.as_slice(), [Ok(SECRET_VALUE.to_string())]);

    // The value is in no column of the job row.
    let (_, _, last_error) = job_state(&db);
    assert!(!last_error.unwrap_or_default().contains(SECRET_VALUE));
    let payload: String = db
        .conn()
        .query_row(
            "SELECT payload_json FROM plugin_jobs WHERE id = ?1",
            rusqlite::params![JOB_ID],
            |row| row.get(0),
        )
        .expect("payload");
    assert!(!payload.contains(SECRET_VALUE));
}

#[test]
fn the_exposure_flag_is_required_even_with_the_grant() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = open_db(dir.path());
    seed_plugin(&db, &["jobs.enqueue", "secrets.reveal"]);
    seed_job(&db, 1);
    let store = MemorySecretStore::new();
    seed_secret(&db, &store);
    let store: Arc<dyn SecretStore> = Arc::new(store);

    let recorder = Recorder {
        reveal_key: Some(SECRET_KEY),
        ..Recorder::default()
    };
    let options = RunnerOptions {
        allow_exposure: false,
        ..enabled()
    };
    let report = run_due(&db, Some(&store), &recorder, &options).expect("pass");

    assert_eq!(report.failed, 1);
    let revealed = recorder.revealed.lock().expect("lock");
    assert_eq!(
        revealed.as_slice(),
        [Err("SECRETS_EXPOSURE_DISABLED".to_string())]
    );
    let (state, _, last_error) = job_state(&db);
    assert_eq!(state, "failed");
    assert_eq!(last_error.as_deref(), Some("SECRETS_EXPOSURE_DISABLED"));
}

#[test]
fn a_plugin_without_the_grant_cannot_read_its_secret() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = open_db(dir.path());
    seed_plugin(&db, &["jobs.enqueue"]);
    seed_job(&db, 1);
    let store = MemorySecretStore::new();
    seed_secret(&db, &store);
    let store: Arc<dyn SecretStore> = Arc::new(store);

    let recorder = Recorder {
        reveal_key: Some(SECRET_KEY),
        ..Recorder::default()
    };
    let report = run_due(&db, Some(&store), &recorder, &enabled()).expect("pass");

    assert_eq!(report.failed, 1);
    let revealed = recorder.revealed.lock().expect("lock");
    let error = revealed[0].as_ref().expect_err("must refuse");
    assert_eq!(error, "PLUGIN_PERMISSION_DENIED");
    let (state, _, last_error) = job_state(&db);
    assert_eq!(state, "failed");
    assert_eq!(last_error.as_deref(), Some("PLUGIN_PERMISSION_DENIED"));
}

#[test]
fn a_failed_job_is_retried_until_attempts_run_out() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = open_db(dir.path());
    seed_plugin(&db, &["jobs.enqueue"]);
    seed_job(&db, 2);

    let recorder = Recorder {
        fail_with: Some("boom".to_string()),
        ..Recorder::default()
    };
    let first = run_due(&db, None, &recorder, &enabled()).expect("pass");
    assert_eq!((first.claimed, first.failed), (1, 1));
    let (state, attempts, last_error) = job_state(&db);
    assert_eq!(state, "queued", "retry scheduled");
    assert_eq!(attempts, 1);
    assert_eq!(last_error.as_deref(), Some("boom"));

    // The retry is backed off, so an immediate second pass finds nothing.
    let second = run_due(&db, None, &recorder, &enabled()).expect("pass");
    assert_eq!(second.claimed, 0);
}
