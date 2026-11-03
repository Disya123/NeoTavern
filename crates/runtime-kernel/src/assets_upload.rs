//! Chunked asset upload (`assets.upload.begin|append|finish|abort`, ADR-0061).
//!
//! The ingestion contract for files larger than the `assets.put` cap. Bytes are
//! staged in bounded chunks under `<data_root>/staged/<uploadId>/data.part` and
//! published as ONE immutable, content-addressed asset at `finish` — so every
//! consumer keeps addressing an `assetId`, dedupe works exactly as before, and
//! nothing ever holds the whole file in memory (the kernel streams the staged
//! file through sha256 and then renames it into the asset plane).
//!
//! Invariants:
//!
//! - **Declared length is authoritative.** `begin` records `totalBytes`; a
//!   chunk that would exceed it is refused, and `finish` refuses an upload
//!   whose staged bytes do not equal the declaration, so a truncated transfer
//!   can never be mistaken for a complete file.
//! - **Sequential append.** `index` must equal the upload's `nextIndex`; a
//!   lost or reordered chunk is a stable CONFLICT instead of a silently
//!   corrupt file.
//! - **Self-cleaning.** Uploads expire after [`UPLOAD_TTL`]; `begin` sweeps
//!   expired rows together with their staged bytes, and `finish`/`abort`
//!   remove the staged directory in every outcome.
//! - **No bytes in the database.** The `asset_uploads` row is bookkeeping
//!   only (AGENTS.md §11: media never lives in SQLite).

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use contracts_generated::generated::{
    self, ResultAssetsPut, ResultAssetsUploadAbort, ResultAssetsUploadAppend,
    ResultAssetsUploadBegin,
};
use neotavern_storage::open::Database;
use neotavern_storage::StorageError;
use rusqlite::{params, OptionalExtension};

use crate::assets::{asset_by_id, extension_of};
use crate::product::{self, new_id, now};
use crate::KernelError;

/// Maximum RAW chunk accepted by one `assets.upload.append`. The wire request
/// limit is 1 MiB and base64 costs 4/3, so 512 KiB raw keeps a maximal chunk
/// comfortably inside the envelope.
pub(crate) const CHUNK_SIZE_BYTES: i64 = 524_288;

/// Hard ceiling for one upload (matches the DTO's `totalBytes` maximum: the
/// legacy full-data backup cap is 4 GiB).
pub(crate) const MAX_UPLOAD_BYTES: i64 = 4_294_967_296;

/// How long a partially uploaded file is kept before the sweep reclaims it.
pub(crate) const UPLOAD_TTL_SECONDS: i64 = 24 * 60 * 60;

/// One staged upload row.
struct UploadRow {
    kind: String,
    filename: String,
    declared_bytes: i64,
    received_bytes: i64,
    next_index: i64,
    updated_at: String,
}

fn staged_root(db: &Database) -> PathBuf {
    db.root().join("staged")
}

fn upload_dir(db: &Database, upload_id: &str) -> PathBuf {
    staged_root(db).join(upload_id)
}

fn data_path(db: &Database, upload_id: &str) -> PathBuf {
    upload_dir(db, upload_id).join("data.part")
}

fn upload_not_found(upload_id: &str) -> KernelError {
    KernelError::product(
        "ASSET_UPLOAD_NOT_FOUND".to_string(),
        vec![("uploadId".to_string(), upload_id.to_string())],
    )
}

fn upload_expired(upload_id: &str, expires_at: &str) -> KernelError {
    KernelError::product(
        "ASSET_UPLOAD_EXPIRED".to_string(),
        vec![
            ("uploadId".to_string(), upload_id.to_string()),
            ("expiresAt".to_string(), expires_at.to_string()),
        ],
    )
}

fn upload_out_of_order(upload_id: &str, expected: i64, got: i64) -> KernelError {
    KernelError::product(
        "ASSET_UPLOAD_OUT_OF_ORDER".to_string(),
        vec![
            ("uploadId".to_string(), upload_id.to_string()),
            ("expectedIndex".to_string(), expected.to_string()),
            ("index".to_string(), got.to_string()),
        ],
    )
}

fn upload_size_exceeded(upload_id: &str, declared: i64, attempted: i64) -> KernelError {
    KernelError::product(
        "ASSET_UPLOAD_SIZE_EXCEEDED".to_string(),
        vec![
            ("uploadId".to_string(), upload_id.to_string()),
            ("declaredBytes".to_string(), declared.to_string()),
            ("attemptedBytes".to_string(), attempted.to_string()),
        ],
    )
}

fn upload_incomplete(upload_id: &str, declared: i64, received: i64) -> KernelError {
    KernelError::product(
        "ASSET_UPLOAD_INCOMPLETE".to_string(),
        vec![
            ("uploadId".to_string(), upload_id.to_string()),
            ("declaredBytes".to_string(), declared.to_string()),
            ("receivedBytes".to_string(), received.to_string()),
        ],
    )
}

pub(crate) fn sqlite(err: rusqlite::Error, context: &str) -> KernelError {
    KernelError::from(StorageError::from_sqlite(err, context))
}

pub(crate) fn io_error(err: std::io::Error, context: &str) -> KernelError {
    KernelError::new(
        crate::KernelErrorCode::Internal,
        format!("{context}: {err}"),
    )
}

/// Parse an RFC 3339 timestamp into epoch seconds (the storage crate writes
/// `YYYY-MM-DDTHH:MM:SSZ`, so a fixed-shape parse is enough here).
pub(crate) fn parse_utc_seconds(stamp: &str) -> Option<i64> {
    let bytes = stamp.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let num =
        |range: std::ops::Range<usize>| -> Option<i64> { stamp.get(range)?.parse::<i64>().ok() };
    let year = num(0..4)?;
    let month = num(5..7)?;
    let day = num(8..10)?;
    let hour = num(11..13)?;
    let minute = num(14..16)?;
    let second = num(17..19)?;
    // Days since the Unix epoch (proleptic Gregorian, no leap-second handling:
    // the comparison target is a TTL, not a calendar date).
    let mut days: i64 = 0;
    for y in 1970..year {
        days += if is_leap(y) { 366 } else { 365 };
    }
    for m in 1..month {
        days += match m {
            1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
            4 | 6 | 9 | 11 => 30,
            _ => {
                if is_leap(year) {
                    29
                } else {
                    28
                }
            }
        };
    }
    days += day - 1;
    Some(days * 86_400 + hour * 3_600 + minute * 60 + second)
}

fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn load_row(db: &Database, upload_id: &str) -> Result<Option<UploadRow>, KernelError> {
    db.conn()
        .query_row(
            "SELECT kind, filename, declared_bytes, received_bytes, next_index, updated_at \
             FROM asset_uploads WHERE id = ?1",
            params![upload_id],
            |row| {
                Ok(UploadRow {
                    kind: row.get(0)?,
                    filename: row.get(1)?,
                    declared_bytes: row.get(2)?,
                    received_bytes: row.get(3)?,
                    next_index: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(|err| sqlite(err, "asset_uploads: load"))
}

fn expiry_of(row: &UploadRow) -> String {
    let updated = parse_utc_seconds(&row.updated_at).unwrap_or(0);
    let expires = updated + UPLOAD_TTL_SECONDS;
    // Re-render through the epoch so the reported deadline matches the sweep.
    let days = expires.div_euclid(86_400);
    let rem = expires.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3_600,
        (rem % 3_600) / 60,
        rem % 60
    )
}

/// Inverse of the epoch-day computation (Howard Hinnant's algorithm, as used by
/// the C++ `<chrono>` calendar conversions).
pub(crate) fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub(crate) fn remove_dir_if_present(path: &Path) -> Result<(), KernelError> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(io_error(err, "drop staged upload directory")),
    }
}

/// Sweep expired uploads (rows + staged bytes). Best-effort per row: a failure
/// to reclaim one upload must not block a fresh `begin`.
fn sweep_expired(db: &Database) {
    let now_seconds = parse_utc_seconds(&now()).unwrap_or(0);
    let rows: Vec<(String, String)> = {
        let conn = db.conn();
        let mut statement = match conn
            .prepare("SELECT id, updated_at FROM asset_uploads ORDER BY updated_at ASC")
        {
            Ok(statement) => statement,
            Err(err) => {
                eprintln!("assets.upload.begin: sweep prepare failed: {err}");
                return;
            }
        };
        let mapped = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        });
        let mapped = match mapped {
            Ok(mapped) => mapped,
            Err(err) => {
                eprintln!("assets.upload.begin: sweep query failed: {err}");
                return;
            }
        };
        mapped.flatten().collect()
    };
    for (id, updated_at) in rows {
        let updated = parse_utc_seconds(&updated_at).unwrap_or(0);
        if now_seconds - updated <= UPLOAD_TTL_SECONDS {
            continue;
        }
        let _ = remove_dir_if_present(&upload_dir(db, &id));
        if let Err(err) = db
            .conn()
            .execute("DELETE FROM asset_uploads WHERE id = ?1", params![id])
        {
            eprintln!("assets.upload.begin: sweep delete failed: {err}");
        }
    }
}

/// `assets.upload.begin` — reserve an upload id and record the declared size.
pub(crate) fn upload_begin(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_assets_upload_begin(request)?;
    if req.total_bytes > MAX_UPLOAD_BYTES {
        return Err(KernelError::new(
            crate::KernelErrorCode::ContractViolation,
            format!(
                "assets.upload.begin: totalBytes {} exceeds the {MAX_UPLOAD_BYTES}-byte limit",
                req.total_bytes
            ),
        ));
    }
    sweep_expired(db);

    let id = new_id();
    let created_at = now();
    db.conn()
        .execute(
            "INSERT INTO asset_uploads \
             (id, kind, filename, content_type, declared_bytes, received_bytes, next_index, \
              created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, ?6, ?6)",
            params![
                &id,
                &req.kind,
                &req.filename,
                req.content_type.as_deref(),
                req.total_bytes,
                &created_at
            ],
        )
        .map_err(|err| sqlite(err, "assets.upload.begin: insert"))?;

    let row = load_row(db, &id)?.ok_or_else(|| upload_not_found(&id))?;
    let dto = ResultAssetsUploadBegin {
        upload_id: id,
        chunk_size_bytes: CHUNK_SIZE_BYTES,
        expires_at: expiry_of(&row),
    };
    product::validate(&dto, generated::validate_result_assets_upload_begin)?;
    product::encode(&dto)
}

/// `assets.upload.append` — append one sequential chunk to the staged file.
pub(crate) fn upload_append(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_assets_upload_append(request)?;
    let row = load_row(db, &req.upload_id)?.ok_or_else(|| upload_not_found(&req.upload_id))?;
    if parse_utc_seconds(&now()).unwrap_or(0) - parse_utc_seconds(&row.updated_at).unwrap_or(0)
        > UPLOAD_TTL_SECONDS
    {
        return Err(upload_expired(&req.upload_id, &expiry_of(&row)));
    }
    if req.index != row.next_index {
        return Err(upload_out_of_order(
            &req.upload_id,
            row.next_index,
            req.index,
        ));
    }

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(req.content_base64.as_bytes())
        .map_err(|err| {
            KernelError::new(
                crate::KernelErrorCode::ContractViolation,
                format!("assets.upload.append: contentBase64 is not valid base64: {err}"),
            )
        })?;
    if bytes.is_empty() {
        return Err(KernelError::new(
            crate::KernelErrorCode::ContractViolation,
            "assets.upload.append: a chunk must not be empty",
        ));
    }
    if bytes.len() as i64 > CHUNK_SIZE_BYTES {
        return Err(KernelError::new(
            crate::KernelErrorCode::ContractViolation,
            format!(
                "assets.upload.append: chunk of {} bytes exceeds the {CHUNK_SIZE_BYTES}-byte maximum",
                bytes.len()
            ),
        ));
    }
    let attempted = row.received_bytes + bytes.len() as i64;
    if attempted > row.declared_bytes {
        return Err(upload_size_exceeded(
            &req.upload_id,
            row.declared_bytes,
            attempted,
        ));
    }

    let dir = upload_dir(db, &req.upload_id);
    fs::create_dir_all(&dir).map_err(|err| io_error(err, "create staged upload directory"))?;
    let path = data_path(db, &req.upload_id);
    // The staged file and the row must agree before appending: a crash between
    // the file write and the row update is detected here instead of silently
    // shifting every following chunk.
    let staged_len = match fs::metadata(&path) {
        Ok(meta) => meta.len() as i64,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => 0,
        Err(err) => return Err(io_error(err, "stat staged upload")),
    };
    if staged_len != row.received_bytes {
        return Err(upload_incomplete(
            &req.upload_id,
            row.received_bytes,
            staged_len,
        ));
    }

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|err| io_error(err, "open staged upload for append"))?;
    file.write_all(&bytes)
        .map_err(|err| io_error(err, "append staged chunk"))?;
    file.flush()
        .map_err(|err| io_error(err, "flush staged chunk"))?;
    drop(file);

    let updated_at = now();
    db.conn()
        .execute(
            "UPDATE asset_uploads SET received_bytes = ?2, next_index = ?3, updated_at = ?4 \
             WHERE id = ?1",
            params![&req.upload_id, attempted, row.next_index + 1, &updated_at],
        )
        .map_err(|err| sqlite(err, "assets.upload.append: update"))?;

    let dto = ResultAssetsUploadAppend {
        upload_id: req.upload_id,
        received_bytes: attempted,
        next_index: row.next_index + 1,
    };
    product::validate(&dto, generated::validate_result_assets_upload_append)?;
    product::encode(&dto)
}

/// `assets.upload.finish` — stream the staged file into the asset plane.
pub(crate) fn upload_finish(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_assets_upload_finish(request)?;
    let row = load_row(db, &req.upload_id)?.ok_or_else(|| upload_not_found(&req.upload_id))?;
    if row.received_bytes != row.declared_bytes {
        return Err(upload_incomplete(
            &req.upload_id,
            row.declared_bytes,
            row.received_bytes,
        ));
    }
    let path = data_path(db, &req.upload_id);
    let (checksum, hashed_bytes) =
        neotavern_storage::assets::sha256_file_hex(&path).map_err(KernelError::from)?;
    if hashed_bytes != row.declared_bytes {
        return Err(upload_incomplete(
            &req.upload_id,
            row.declared_bytes,
            hashed_bytes,
        ));
    }

    // Identical bytes under the same kind are an idempotent re-import: keep the
    // existing asset and drop the staged copy (content addressing makes them
    // interchangeable, AGENTS.md §11).
    let existing: Option<String> = db
        .conn()
        .query_row(
            "SELECT id FROM __neotavern_assets WHERE checksum_sha256 = ?1 AND type = ?2 LIMIT 1",
            params![&checksum, &row.kind],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| sqlite(err, "assets.upload.finish: dedupe lookup"))?;

    let (asset_id, deduplicated) = match existing {
        Some(id) => (id, true),
        None => {
            let id = new_id();
            let relative_key = format!("{}/{}{}", row.kind, checksum, extension_of(&row.filename));
            neotavern_storage::assets::publish_asset_from_file(
                db,
                &id,
                &row.kind,
                &relative_key,
                &path,
                &checksum,
                row.declared_bytes,
            )
            .map_err(KernelError::from)?;
            (id, false)
        }
    };

    let _ = remove_dir_if_present(&upload_dir(db, &req.upload_id));
    db.conn()
        .execute(
            "DELETE FROM asset_uploads WHERE id = ?1",
            params![&req.upload_id],
        )
        .map_err(|err| sqlite(err, "assets.upload.finish: delete row"))?;

    let asset = asset_by_id(db, &asset_id)?;
    let dto = ResultAssetsPut {
        asset,
        deduplicated,
        deduplicated_from_id: if deduplicated { Some(asset_id) } else { None },
    };
    product::validate(&dto, generated::validate_result_assets_put)?;
    product::encode(&dto)
}

/// `assets.upload.abort` — drop the staged bytes (idempotent).
pub(crate) fn upload_abort(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req = generated::decode_request_assets_upload_abort(request)?;
    let removed = db
        .conn()
        .execute(
            "DELETE FROM asset_uploads WHERE id = ?1",
            params![&req.upload_id],
        )
        .map_err(|err| sqlite(err, "assets.upload.abort: delete row"))?;
    remove_dir_if_present(&upload_dir(db, &req.upload_id))?;
    let dto = ResultAssetsUploadAbort {
        deleted: removed > 0,
    };
    product::validate(&dto, generated::validate_result_assets_upload_abort)?;
    product::encode(&dto)
}
