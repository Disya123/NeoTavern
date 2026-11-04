//! Host dispatch seam (`plugin_jobs::claim_for_host` / `report_from_host`,
//! ADR-0065): the desktop host claims a job, hands it to the sandbox, and reports
//! the outcome back. These tests pin the promises the host adapter relies on:
//!
//! 1. a claim hands the host the payload and the attempt number, and moves the row
//!    to `leased` so a second claim cannot take it;
//! 2. a success report completes the job and clears the lease;
//! 3. a report naming an older attempt is refused as `JOB_LEASE_STALE` and the row
//!    stays leased (a slow reporter from a previous life cannot complete a retry);
//! 4. a report on a terminal job is refused as `JOB_TERMINAL`.

use plugin_executor::Outcome;

const PLUGIN_ID: &str = "dispatch-jobs";
const JOB_ID: &str = "00000000-0000-4000-8000-0000000000bb";
const LEASE_MS: i64 = 30_000;

fn open_db(root: &std::path::Path) -> neotavern_storage::open::Database {
    let mut progress = |_p: neotavern_storage::migrations::MigrationProgress| {};
    neotavern_storage::open::open(
        root,
        &neotavern_storage::baseline::ConnectionPolicy::default(),
        &mut progress,
    )
    .expect("data root must open")
}

fn seed_plugin(db: &neotavern_storage::open::Database) {
    db.conn()
        .execute(
            "INSERT INTO plugins (id, name, version, enabled, manifest_json, permissions_json, \
             trust_state, installed_at, updated_at) \
             VALUES (?1, 'Dispatch Test', '1.0.0', 1, '{}', '[\"jobs.background\"]', \
             'locally-trusted', '2026-11-04T00:00:00Z', '2026-11-04T00:00:00Z')",
            rusqlite::params![PLUGIN_ID],
        )
        .expect("seed plugin");
}

fn seed_job(db: &neotavern_storage::open::Database, max_attempts: i64) {
    db.conn()
        .execute(
            "INSERT INTO plugin_jobs (id, plugin_id, kind, payload_json, state, attempts, \
             max_attempts, run_at_ms, lease_until_ms, last_error, created_at_ms, updated_at_ms) \
             VALUES (?1, ?2, 'timer', '{\"tick\":7}', 'queued', 0, ?3, 0, NULL, NULL, 0, 0)",
            rusqlite::params![JOB_ID, PLUGIN_ID, max_attempts],
        )
        .expect("seed job");
}

fn job_state(db: &neotavern_storage::open::Database) -> (String, i64, Option<i64>) {
    db.conn()
        .query_row(
            "SELECT state, attempts, lease_until_ms FROM plugin_jobs WHERE id = ?1",
            rusqlite::params![JOB_ID],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("job row")
}

#[test]
fn claim_hands_the_host_the_payload_and_leases_the_row() {
    let dir = tempfile::tempdir().expect("temp dir");
    let db = open_db(dir.path());
    seed_plugin(&db);
    seed_job(&db, 3);

    let claimed = runtime_kernel::plugin_jobs::claim_for_host(&db, LEASE_MS)
        .expect("claim")
        .expect("a due job");
    assert_eq!(claimed.id, JOB_ID);
    assert_eq!(claimed.plugin_id, PLUGIN_ID);
    assert_eq!(claimed.kind, "timer");
    assert_eq!(claimed.payload_json, "{\"tick\":7}");
    assert_eq!(claimed.attempts, 1);
    assert_eq!(claimed.max_attempts, 3);

    let (state, attempts, lease) = job_state(&db);
    assert_eq!(state, "leased");
    assert_eq!(attempts, 1);
    assert!(lease.is_some(), "a claim without a lease could be stolen");

    // The queue is the arbiter: nothing else is due while this lease lives.
    assert!(runtime_kernel::plugin_jobs::claim_for_host(&db, LEASE_MS)
        .expect("second claim")
        .is_none());
}

#[test]
fn success_report_completes_and_clears_the_lease() {
    let dir = tempfile::tempdir().expect("temp dir");
    let db = open_db(dir.path());
    seed_plugin(&db);
    seed_job(&db, 3);
    let claimed = runtime_kernel::plugin_jobs::claim_for_host(&db, LEASE_MS)
        .expect("claim")
        .expect("a due job");

    runtime_kernel::plugin_jobs::report_from_host(
        &db,
        &claimed.id,
        claimed.attempts,
        Outcome::Success,
    )
    .expect("report");

    let (state, attempts, lease) = job_state(&db);
    assert_eq!(state, "succeeded");
    assert_eq!(attempts, 1);
    assert_eq!(lease, None);
}

#[test]
fn stale_attempt_report_is_refused_and_leaves_the_row_leased() {
    let dir = tempfile::tempdir().expect("temp dir");
    let db = open_db(dir.path());
    seed_plugin(&db);
    seed_job(&db, 3);
    let claimed = runtime_kernel::plugin_jobs::claim_for_host(&db, LEASE_MS)
        .expect("claim")
        .expect("a due job");

    let error = runtime_kernel::plugin_jobs::report_from_host(
        &db,
        &claimed.id,
        claimed.attempts - 1,
        Outcome::Success,
    )
    .expect_err("an older attempt must not complete a retry");
    assert_eq!(
        error.product.as_ref().map(|product| product.code.as_str()),
        Some("JOB_LEASE_STALE")
    );
    let (state, _, lease) = job_state(&db);
    assert_eq!(state, "leased");
    assert!(lease.is_some());
}

#[test]
fn report_on_a_terminal_job_is_refused() {
    let dir = tempfile::tempdir().expect("temp dir");
    let db = open_db(dir.path());
    seed_plugin(&db);
    seed_job(&db, 3);
    let claimed = runtime_kernel::plugin_jobs::claim_for_host(&db, LEASE_MS)
        .expect("claim")
        .expect("a due job");
    runtime_kernel::plugin_jobs::report_from_host(
        &db,
        &claimed.id,
        claimed.attempts,
        Outcome::Success,
    )
    .expect("first report");

    let error = runtime_kernel::plugin_jobs::report_from_host(
        &db,
        &claimed.id,
        claimed.attempts,
        Outcome::Success,
    )
    .expect_err("a terminal job cannot be reported twice");
    assert_eq!(
        error.product.as_ref().map(|product| product.code.as_str()),
        Some("JOB_TERMINAL")
    );
}
