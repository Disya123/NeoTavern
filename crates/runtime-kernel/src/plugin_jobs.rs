//! `plugins.jobs.*` — the kernel-resident plugin executor's durable queue
//! (ADR-0064).
//!
//! The wire owns enqueue/list/get/cancel. Claiming, leasing and completing are
//! executor-internal: leases never cross the wire, so a client cannot pose as a
//! worker or steal a job. `plugin_executor` is the state machine; this module is
//! its persistence adapter plus the product-code mapping.
//!
//! Security invariants enforced here:
//!
//! - a job payload is opaque JSON, bounded to 64 KiB (the KV quota) and stored
//!   verbatim — the queue is not a secret channel, and ADR-0064 forbids the
//!   executor from reading secret material out of a payload;
//! - enqueue requires an existing plugin row (`PLUGIN_NOT_FOUND` otherwise), so a
//!   typo cannot create orphan work;
//! - per-plugin outstanding cap ([`MAX_OUTSTANDING_PER_PLUGIN`]) keeps one plugin
//!   from monopolising the queue;
//! - timestamps are stored as milliseconds and rendered as RFC 3339 on the wire,
//!   so ordering never depends on string comparison.

use contracts_generated::generated::{self, PluginJob, ResultPluginJob, ResultPluginsJobsList};
use neotavern_storage::open::Database;
use plugin_executor::{self as scheduler, Enqueue, JobState};
use rusqlite::OptionalExtension;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::{KernelError, KernelErrorCode};

/// Outstanding (queued or leased) jobs one plugin may hold.
pub(crate) const MAX_OUTSTANDING_PER_PLUGIN: i64 = 256;
/// Page size when the caller does not say otherwise.
const DEFAULT_LIST_LIMIT: i64 = 50;

/// Row as stored, before rendering to the wire DTO.
struct JobRow {
    id: String,
    plugin_id: String,
    kind: String,
    payload_json: String,
    state: String,
    attempts: i64,
    max_attempts: i64,
    run_at_ms: i64,
    lease_until_ms: Option<i64>,
    last_error: Option<String>,
    created_at_ms: i64,
    updated_at_ms: i64,
}

fn to_rfc3339(ms: i64) -> String {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .ok()
        .and_then(|stamp| stamp.format(&Rfc3339).ok())
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_string())
}

fn parse_rfc3339_ms(value: &str, field: &str) -> Result<i64, KernelError> {
    OffsetDateTime::parse(value, &Rfc3339)
        .map(|stamp| (stamp.unix_timestamp_nanos() / 1_000_000) as i64)
        .map_err(|_| {
            KernelError::product(
                "JOB_TIMESTAMP_INVALID".to_string(),
                vec![("field".to_string(), field.to_string())],
            )
        })
}

fn now_ms() -> i64 {
    (OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}

fn state_of(value: &str) -> JobState {
    JobState::parse(value).unwrap_or(JobState::Queued)
}

fn row_to_dto(row: &JobRow) -> PluginJob {
    PluginJob {
        id: row.id.clone(),
        plugin_id: row.plugin_id.clone(),
        kind: row.kind.clone(),
        state: match state_of(&row.state) {
            JobState::Queued => generated::PluginJobState::Queued,
            JobState::Leased => generated::PluginJobState::Leased,
            JobState::Succeeded => generated::PluginJobState::Succeeded,
            JobState::Failed => generated::PluginJobState::Failed,
            JobState::Cancelled => generated::PluginJobState::Cancelled,
        },
        payload_json: row.payload_json.clone(),
        attempts: row.attempts,
        max_attempts: row.max_attempts,
        run_at: to_rfc3339(row.run_at_ms),
        lease_until: row.lease_until_ms.map(to_rfc3339),
        last_error: row.last_error.clone(),
        created_at: to_rfc3339(row.created_at_ms),
        updated_at: to_rfc3339(row.updated_at_ms),
    }
}

const SELECT_COLUMNS: &str = "id, plugin_id, kind, payload_json, state, attempts, max_attempts, \
     run_at_ms, lease_until_ms, last_error, created_at_ms, updated_at_ms";

fn read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<JobRow> {
    Ok(JobRow {
        id: row.get(0)?,
        plugin_id: row.get(1)?,
        kind: row.get(2)?,
        payload_json: row.get(3)?,
        state: row.get(4)?,
        attempts: row.get(5)?,
        max_attempts: row.get(6)?,
        run_at_ms: row.get(7)?,
        lease_until_ms: row.get(8)?,
        last_error: row.get(9)?,
        created_at_ms: row.get(10)?,
        updated_at_ms: row.get(11)?,
    })
}

fn write_row(db: &Database, job: &scheduler::Job) -> Result<(), KernelError> {
    db.conn()
        .execute(
            "INSERT INTO plugin_jobs (id, plugin_id, kind, payload_json, state, attempts, \
             max_attempts, run_at_ms, lease_until_ms, last_error, created_at_ms, updated_at_ms) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            rusqlite::params![
                job.id,
                job.plugin_id,
                job.kind,
                job.payload,
                job.state.as_str(),
                i64::from(job.attempts),
                i64::from(job.max_attempts),
                job.run_at_ms,
                job.lease_until_ms,
                job.last_error,
                job.created_at_ms,
                job.updated_at_ms,
            ],
        )
        .map_err(|err| crate::product::sqlite(err, "plugins.jobs: insert failed"))?;
    Ok(())
}

fn sqlite_error(err: rusqlite::Error, context: &str) -> KernelError {
    KernelError::new(KernelErrorCode::StorageFailure, format!("{context}: {err}"))
}

fn job_not_found(job_id: &str) -> KernelError {
    KernelError::product(
        "JOB_NOT_FOUND".to_string(),
        vec![("jobId".to_string(), job_id.to_string())],
    )
}

fn plugin_not_found(plugin_id: &str) -> KernelError {
    KernelError::product(
        "PLUGIN_NOT_FOUND".to_string(),
        vec![("pluginId".to_string(), plugin_id.to_string())],
    )
}

fn map_scheduler_error(err: scheduler::JobError) -> KernelError {
    let (code, detail) = match &err {
        scheduler::JobError::InvalidPluginId => ("JOB_PLUGIN_ID_INVALID", String::new()),
        scheduler::JobError::InvalidKind => ("JOB_KIND_INVALID", String::new()),
        scheduler::JobError::PayloadNotJson => ("JOB_PAYLOAD_INVALID", "not json".to_string()),
        scheduler::JobError::PayloadTooLarge(len) => ("JOB_PAYLOAD_TOO_LARGE", len.to_string()),
        scheduler::JobError::InvalidMaxAttempts => ("JOB_ATTEMPTS_INVALID", String::new()),
        scheduler::JobError::NotLeased => ("JOB_NOT_LEASED", String::new()),
        scheduler::JobError::Terminal => ("JOB_TERMINAL", String::new()),
    };
    KernelError::product(code.to_string(), vec![("detail".to_string(), detail)])
}

fn new_id() -> String {
    crate::product::new_id()
}

/// Releases expired leases before any queue read, so a crashed worker's job is
/// claimable without a separate sweeper process.
fn release_expired(db: &Database) -> Result<(), KernelError> {
    let now = now_ms();
    db.conn()
        .execute(
            "UPDATE plugin_jobs SET state = 'queued', lease_until_ms = NULL, updated_at_ms = ?1 \
             WHERE state = 'leased' AND lease_until_ms IS NOT NULL AND lease_until_ms <= ?1",
            rusqlite::params![now],
        )
        .map_err(|err| sqlite_error(err, "plugins.jobs: lease sweep failed"))?;
    Ok(())
}

/// `plugins.jobs.enqueue`.
pub(crate) fn enqueue(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_plugins_jobs_enqueue(request)?;
    let exists: Option<String> = db
        .conn()
        .query_row(
            "SELECT id FROM plugins WHERE id = ?1",
            rusqlite::params![req.plugin_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| sqlite_error(err, "plugins.jobs: plugin lookup failed"))?;
    if exists.is_none() {
        return Err(plugin_not_found(&req.plugin_id));
    }
    let outstanding: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM plugin_jobs WHERE plugin_id = ?1 AND state IN ('queued', 'leased')",
            rusqlite::params![req.plugin_id],
            |row| row.get(0),
        )
        .map_err(|err| sqlite_error(err, "plugins.jobs: outstanding count failed"))?;
    if outstanding >= MAX_OUTSTANDING_PER_PLUGIN {
        return Err(KernelError::product(
            "JOB_QUEUE_LIMIT".to_string(),
            vec![
                ("pluginId".to_string(), req.plugin_id.clone()),
                ("limit".to_string(), MAX_OUTSTANDING_PER_PLUGIN.to_string()),
            ],
        ));
    }

    release_expired(db)?;
    let now = now_ms();
    let run_at_ms = match req.run_at.as_deref() {
        Some(value) => Some(parse_rfc3339_ms(value, "runAt")?),
        None => None,
    };
    let max_attempts = req.max_attempts.map(|value| value as u32);
    let payload = req.payload_json.clone().unwrap_or_else(|| "{}".to_string());
    let job = scheduler::enqueue(
        &new_id(),
        &Enqueue {
            plugin_id: &req.plugin_id,
            kind: &req.kind,
            payload: &payload,
            run_at_ms,
            max_attempts,
        },
        now,
    )
    .map_err(map_scheduler_error)?;
    write_row(db, &job)?;

    let dto = ResultPluginJob {
        job: row_to_dto(&JobRow {
            id: job.id,
            plugin_id: job.plugin_id,
            kind: job.kind,
            payload_json: job.payload,
            state: job.state.as_str().to_string(),
            attempts: i64::from(job.attempts),
            max_attempts: i64::from(job.max_attempts),
            run_at_ms: job.run_at_ms,
            lease_until_ms: job.lease_until_ms,
            last_error: job.last_error,
            created_at_ms: job.created_at_ms,
            updated_at_ms: job.updated_at_ms,
        }),
    };
    crate::product::validate(&dto, generated::validate_result_plugin_job)?;
    crate::product::encode(&dto)
}

/// `plugins.jobs.get`.
pub(crate) fn get(db: &Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_plugins_jobs_get(request)?;
    let row = db
        .conn()
        .query_row(
            &format!("SELECT {SELECT_COLUMNS} FROM plugin_jobs WHERE id = ?1"),
            rusqlite::params![req.job_id],
            read_row,
        )
        .optional()
        .map_err(|err| sqlite_error(err, "plugins.jobs: get failed"))?
        .ok_or_else(|| job_not_found(&req.job_id))?;
    let dto = ResultPluginJob {
        job: row_to_dto(&row),
    };
    crate::product::validate(&dto, generated::validate_result_plugin_job)?;
    crate::product::encode(&dto)
}

/// `plugins.jobs.list`.
pub(crate) fn list(db: &Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_plugins_jobs_list(request)?;
    release_expired(db)?;
    let limit = req.limit.unwrap_or(DEFAULT_LIST_LIMIT).clamp(1, 200);
    let state = req.state.as_ref().map(|value| match value {
        generated::PluginJobState::Queued => "queued",
        generated::PluginJobState::Leased => "leased",
        generated::PluginJobState::Succeeded => "succeeded",
        generated::PluginJobState::Failed => "failed",
        generated::PluginJobState::Cancelled => "cancelled",
    });

    let mut sql = format!("SELECT {SELECT_COLUMNS} FROM plugin_jobs WHERE 1 = 1");
    let mut params: Vec<rusqlite::types::Value> = Vec::new();
    if let Some(plugin_id) = req.plugin_id.as_deref() {
        sql.push_str(" AND plugin_id = ?");
        params.push(plugin_id.to_string().into());
    }
    if let Some(state) = state {
        sql.push_str(" AND state = ?");
        params.push(state.to_string().into());
    }
    sql.push_str(" ORDER BY created_at_ms DESC, id DESC LIMIT ?");
    params.push(limit.into());

    let mut statement = db
        .conn()
        .prepare(&sql)
        .map_err(|err| sqlite_error(err, "plugins.jobs: list prepare failed"))?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(params.iter()), read_row)
        .map_err(|err| sqlite_error(err, "plugins.jobs: list query failed"))?;
    let mut jobs = Vec::new();
    for row in rows {
        jobs.push(row_to_dto(&row.map_err(|err| {
            sqlite_error(err, "plugins.jobs: list row failed")
        })?));
    }
    let dto = ResultPluginsJobsList { jobs };
    crate::product::validate(&dto, generated::validate_result_plugins_jobs_list)?;
    crate::product::encode(&dto)
}

/// `plugins.jobs.cancel`.
pub(crate) fn cancel(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_plugins_jobs_get(request)?;
    let row = db
        .conn()
        .query_row(
            &format!("SELECT {SELECT_COLUMNS} FROM plugin_jobs WHERE id = ?1"),
            rusqlite::params![req.job_id],
            read_row,
        )
        .optional()
        .map_err(|err| sqlite_error(err, "plugins.jobs: cancel lookup failed"))?
        .ok_or_else(|| job_not_found(&req.job_id))?;

    let now = now_ms();
    let mut job = scheduler::Job {
        id: row.id.clone(),
        plugin_id: row.plugin_id.clone(),
        kind: row.kind.clone(),
        payload: row.payload_json.clone(),
        state: state_of(&row.state),
        attempts: row.attempts as u32,
        max_attempts: row.max_attempts as u32,
        run_at_ms: row.run_at_ms,
        lease_until_ms: row.lease_until_ms,
        last_error: row.last_error.clone(),
        created_at_ms: row.created_at_ms,
        updated_at_ms: row.updated_at_ms,
    };
    scheduler::cancel(&mut job, now).map_err(map_scheduler_error)?;
    db.conn()
        .execute(
            "UPDATE plugin_jobs SET state = ?1, lease_until_ms = NULL, updated_at_ms = ?2 \
             WHERE id = ?3",
            rusqlite::params![job.state.as_str(), job.updated_at_ms, job.id],
        )
        .map_err(|err| sqlite_error(err, "plugins.jobs: cancel failed"))?;

    let dto = ResultPluginJob {
        job: row_to_dto(&JobRow {
            id: job.id,
            plugin_id: job.plugin_id,
            kind: job.kind,
            payload_json: job.payload,
            state: job.state.as_str().to_string(),
            attempts: i64::from(job.attempts),
            max_attempts: i64::from(job.max_attempts),
            run_at_ms: job.run_at_ms,
            lease_until_ms: job.lease_until_ms,
            last_error: job.last_error,
            created_at_ms: job.created_at_ms,
            updated_at_ms: job.updated_at_ms,
        }),
    };
    crate::product::validate(&dto, generated::validate_result_plugin_job)?;
    crate::product::encode(&dto)
}

/// Claims the next due job for the executor (internal — no wire op).
///
/// Deliberately unused until ADR-0064's security-review checklist is answered:
/// the worker loop is the component that would inject secrets, so the seam lands
/// with the queue while execution stays off. `allow(dead_code)` marks that
/// intent rather than hiding an accidental orphan.
#[allow(dead_code)]
///
/// Returns the claimed job, or `None` when nothing is due. The caller owns the
/// lease and must eventually call [`complete`] or let it expire.
pub(crate) fn claim_next(
    db: &Database,
    lease_ms: i64,
) -> Result<Option<scheduler::Job>, KernelError> {
    release_expired(db)?;
    let now = now_ms();
    let row = db
        .conn()
        .query_row(
            &format!(
                "SELECT {SELECT_COLUMNS} FROM plugin_jobs \
                 WHERE state = 'queued' AND run_at_ms <= ?1 \
                 ORDER BY run_at_ms ASC, created_at_ms ASC, id ASC LIMIT 1"
            ),
            rusqlite::params![now],
            read_row,
        )
        .optional()
        .map_err(|err| sqlite_error(err, "plugins.jobs: claim lookup failed"))?;
    let Some(row) = row else { return Ok(None) };
    db.conn()
        .execute(
            "UPDATE plugin_jobs SET state = 'leased', attempts = attempts + 1, \
             lease_until_ms = ?1, updated_at_ms = ?2 WHERE id = ?3 AND state = 'queued'",
            rusqlite::params![now + lease_ms.max(1), now, row.id],
        )
        .map_err(|err| sqlite_error(err, "plugins.jobs: claim update failed"))?;
    Ok(Some(scheduler::Job {
        id: row.id,
        plugin_id: row.plugin_id,
        kind: row.kind,
        payload: row.payload_json,
        state: JobState::Leased,
        attempts: row.attempts as u32 + 1,
        max_attempts: row.max_attempts as u32,
        run_at_ms: row.run_at_ms,
        lease_until_ms: Some(now + lease_ms.max(1)),
        last_error: row.last_error,
        created_at_ms: row.created_at_ms,
        updated_at_ms: now,
    }))
}

/// Reports a claimed job's outcome (internal — no wire op).
#[allow(dead_code)]
pub(crate) fn complete(
    db: &Database,
    job: &mut scheduler::Job,
    outcome: scheduler::Outcome,
) -> Result<(), KernelError> {
    let now = now_ms();
    scheduler::complete(job, outcome, now).map_err(map_scheduler_error)?;
    db.conn()
        .execute(
            "UPDATE plugin_jobs SET state = ?1, attempts = ?2, run_at_ms = ?3, \
             lease_until_ms = NULL, last_error = ?4, updated_at_ms = ?5 WHERE id = ?6",
            rusqlite::params![
                job.state.as_str(),
                i64::from(job.attempts),
                job.run_at_ms,
                job.last_error,
                job.updated_at_ms,
                job.id,
            ],
        )
        .map_err(|err| sqlite_error(err, "plugins.jobs: complete failed"))?;
    Ok(())
}
