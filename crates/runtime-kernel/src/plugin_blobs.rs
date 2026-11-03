//! Plugin blob store (`plugins.blobs.begin|append|finish|list|read|delete`,
//! M7 Этап-4 cluster 21a).
//!
//! The canonical counterpart of the legacy
//! `<root>/<pluginId>/<blobId>.{bin,json}` store served by
//! `/api/v2/plugins/:id/blobs*`. Those routes accepted an 8 MiB binary body,
//! which no Product Wire request can carry honestly, so the family rides the
//! ADR-0061 chunked-ingestion discipline instead of a second HTTP endpoint:
//!
//! - `begin` reserves an upload id and records the declared size;
//! - `append` stages one sequential chunk under <data root>/staged-blobs;
//! - `finish` hashes the staged file, refuses an incomplete transfer, and
//!   renames the bytes into <data root>/plugin-blobs/<pluginId>/<sha256>.bin
//!   (content-addressed, so identical bytes are one file);
//! - `read` serves bounded 256 KiB ranges (the sandbox host loops until `eof`,
//!   which is how an 8 MiB blob reaches the iframe without a JSON blow-up);
//! - `list`/`delete` are the metadata half, newest first, idempotent delete.
//!
//! Security rules that matter:
//!
//! - every operation names its plugin and proves `storage.blobs` in the grant
//!   set recorded at install (ARC-08), exactly like the KV state store;
//! - `append`/`finish` also compare the upload row's owner with the named
//!   plugin, so holding another plugin's upload id is useless — the bytes can
//!   never cross a plugin boundary through a shared asset/fragment plane;
//! - the blob id IS the sha256 of the bytes, so a caller cannot address bytes
//!   it did not upload under a different name.
//!
//! Limits mirror the legacy rev4 contract: 8 MiB per blob, 64 blobs per
//! plugin, 512 KiB raw per chunk (the wire request cap is 1 MiB and base64
//! costs 4/3), and a 24 h TTL on unfinished uploads.
use std::fs::{self, OpenOptions};
use std::io::{Read as _, Seek, SeekFrom, Write as _};
use std::path::{Path, PathBuf};

use base64::Engine as _;
use contracts_generated::generated::{
    self, PluginBlob, RequestPluginsBlobsAppend, RequestPluginsBlobsBegin,
    RequestPluginsBlobsDelete, RequestPluginsBlobsFinish, RequestPluginsBlobsList,
    RequestPluginsBlobsRead, ResultPluginsBlobsAppend, ResultPluginsBlobsBegin,
    ResultPluginsBlobsDelete, ResultPluginsBlobsList, ResultPluginsBlobsRead,
};
use neotavern_storage::open::Database;
use rusqlite::{params, OptionalExtension};

use crate::assets_upload::{
    civil_from_days, parse_utc_seconds, remove_dir_if_present, CHUNK_SIZE_BYTES, UPLOAD_TTL_SECONDS,
};
use crate::plugin_state::require_capability;
use crate::product::{self, new_id, now};
use crate::KernelError;

/// rev4 `storage.maxBlobFileBytes`: one blob may carry at most 8 MiB.
pub(crate) const MAX_BLOB_BYTES: i64 = 8 * 1024 * 1024;
/// rev4 `storage.maxBlobs`: a plugin keeps at most 64 blobs.
pub(crate) const MAX_BLOBS_PER_PLUGIN: i64 = 64;
/// The capability the whole family requires (granted at install).
const BLOB_CAPABILITY: &str = "storage.blobs";

fn staged_root(db: &Database) -> PathBuf {
    db.root().join("staged-blobs")
}

fn upload_dir(db: &Database, upload_id: &str) -> PathBuf {
    staged_root(db).join(upload_id)
}

fn upload_data_path(db: &Database, upload_id: &str) -> PathBuf {
    upload_dir(db, upload_id).join("data.part")
}

fn plugin_dir(db: &Database, plugin_id: &str) -> PathBuf {
    db.root().join("plugin-blobs").join(plugin_id)
}

fn blob_path(db: &Database, plugin_id: &str, blob_id: &str) -> PathBuf {
    plugin_dir(db, plugin_id).join(format!("{blob_id}.bin"))
}

fn upload_not_found(plugin_id: &str, upload_id: &str) -> KernelError {
    KernelError::product(
        "PLUGIN_BLOB_UPLOAD_NOT_FOUND",
        vec![
            ("pluginId".to_string(), plugin_id.to_string()),
            ("uploadId".to_string(), upload_id.to_string()),
        ],
    )
}

fn blob_not_found(plugin_id: &str, blob_id: &str) -> KernelError {
    KernelError::product(
        "PLUGIN_BLOB_NOT_FOUND",
        vec![
            ("pluginId".to_string(), plugin_id.to_string()),
            ("blobId".to_string(), blob_id.to_string()),
        ],
    )
}

fn upload_expired(upload_id: &str, expires_at: &str) -> KernelError {
    KernelError::product(
        "PLUGIN_BLOB_UPLOAD_EXPIRED",
        vec![
            ("uploadId".to_string(), upload_id.to_string()),
            ("expiresAt".to_string(), expires_at.to_string()),
        ],
    )
}

fn upload_out_of_order(upload_id: &str, expected: i64, got: i64) -> KernelError {
    KernelError::product(
        "PLUGIN_BLOB_UPLOAD_OUT_OF_ORDER",
        vec![
            ("uploadId".to_string(), upload_id.to_string()),
            ("expectedIndex".to_string(), expected.to_string()),
            ("index".to_string(), got.to_string()),
        ],
    )
}

fn upload_size_exceeded(upload_id: &str, declared: i64, attempted: i64) -> KernelError {
    KernelError::product(
        "PLUGIN_BLOB_SIZE_EXCEEDED",
        vec![
            ("uploadId".to_string(), upload_id.to_string()),
            ("declaredBytes".to_string(), declared.to_string()),
            ("attemptedBytes".to_string(), attempted.to_string()),
        ],
    )
}

fn upload_incomplete(upload_id: &str, declared: i64, received: i64) -> KernelError {
    KernelError::product(
        "PLUGIN_BLOB_UPLOAD_INCOMPLETE",
        vec![
            ("uploadId".to_string(), upload_id.to_string()),
            ("declaredBytes".to_string(), declared.to_string()),
            ("receivedBytes".to_string(), received.to_string()),
        ],
    )
}

fn quota_exceeded(plugin_id: &str, blobs: i64) -> KernelError {
    KernelError::product(
        "PLUGIN_BLOB_QUOTA_EXCEEDED",
        vec![
            ("pluginId".to_string(), plugin_id.to_string()),
            ("limit".to_string(), MAX_BLOBS_PER_PLUGIN.to_string()),
            ("blobs".to_string(), blobs.to_string()),
        ],
    )
}

fn chunk_too_large(upload_id: &str, chunk: i64) -> KernelError {
    KernelError::product(
        "PLUGIN_BLOB_CHUNK_TOO_LARGE",
        vec![
            ("uploadId".to_string(), upload_id.to_string()),
            ("limitBytes".to_string(), CHUNK_SIZE_BYTES.to_string()),
            ("bytes".to_string(), chunk.to_string()),
        ],
    )
}

fn encode<T: serde::Serialize>(
    dto: &T,
    validator: fn(&serde_json::Value) -> Result<(), Vec<contracts_generated::Issue>>,
) -> Result<Vec<u8>, KernelError> {
    product::validate(dto, validator)?;
    product::encode(dto)
}

struct UploadRow {
    plugin_id: String,
    name: String,
    content_type: String,
    declared_bytes: i64,
    received_bytes: i64,
    next_index: i64,
    updated_at: String,
}

struct BlobRow {
    blob_id: String,
    name: String,
    content_type: String,
    size_bytes: i64,
    created_at: String,
}

impl UploadRow {
    fn expires_at(&self) -> String {
        let updated = parse_utc_seconds(&self.updated_at).unwrap_or(0);
        let expires = updated + UPLOAD_TTL_SECONDS;
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
}

impl BlobRow {
    fn dto(&self) -> PluginBlob {
        PluginBlob {
            blob_id: self.blob_id.clone(),
            hash: self.blob_id.clone(),
            name: self.name.clone(),
            content_type: self.content_type.clone(),
            size_bytes: self.size_bytes,
            created_at: self.created_at.clone(),
        }
    }
}

fn load_upload(db: &Database, upload_id: &str) -> Result<Option<UploadRow>, KernelError> {
    db.conn()
        .query_row(
            "SELECT plugin_id, name, content_type, declared_bytes, received_bytes, next_index, \
             updated_at FROM plugin_blob_uploads WHERE id = ?1",
            params![upload_id],
            |row| {
                Ok(UploadRow {
                    plugin_id: row.get(0)?,
                    name: row.get(1)?,
                    content_type: row.get(2)?,
                    declared_bytes: row.get(3)?,
                    received_bytes: row.get(4)?,
                    next_index: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            },
        )
        .optional()
        .map_err(|err| product::sqlite(err, "plugin_blob_uploads: load"))
}

/// Load an upload row that the named plugin owns. A foreign id answers exactly
/// like an unknown one — never a distinguishable "wrong owner", which would
/// leak the existence of another plugin's upload.
fn load_owned_upload(
    db: &Database,
    plugin_id: &str,
    upload_id: &str,
) -> Result<UploadRow, KernelError> {
    let row = load_upload(db, upload_id)?
        .filter(|row| row.plugin_id == plugin_id)
        .ok_or_else(|| upload_not_found(plugin_id, upload_id))?;
    Ok(row)
}

fn load_blob(
    db: &Database,
    plugin_id: &str,
    blob_id: &str,
) -> Result<Option<BlobRow>, KernelError> {
    db.conn()
        .query_row(
            "SELECT blob_id, name, content_type, size_bytes, created_at \
             FROM plugin_blobs WHERE plugin_id = ?1 AND blob_id = ?2",
            params![plugin_id, blob_id],
            |row| {
                Ok(BlobRow {
                    blob_id: row.get(0)?,
                    name: row.get(1)?,
                    content_type: row.get(2)?,
                    size_bytes: row.get(3)?,
                    created_at: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|err| product::sqlite(err, "plugin_blobs: load"))
}

fn blob_count(db: &Database, plugin_id: &str) -> Result<i64, KernelError> {
    db.conn()
        .query_row(
            "SELECT COUNT(*) FROM plugin_blobs WHERE plugin_id = ?1",
            params![plugin_id],
            |row| row.get(0),
        )
        .map_err(|err| product::sqlite(err, "plugin_blobs: count"))
}

/// Sweep expired upload rows together with their staged bytes. Best-effort per
/// row: reclaiming one upload must never block a fresh `begin`.
fn sweep_expired(db: &Database) {
    let now_seconds = parse_utc_seconds(&now()).unwrap_or(0);
    let rows: Vec<(String, String)> = {
        let conn = db.conn();
        let mut statement = match conn
            .prepare("SELECT id, updated_at FROM plugin_blob_uploads ORDER BY updated_at ASC")
        {
            Ok(statement) => statement,
            Err(err) => {
                eprintln!("plugins.blobs.begin: sweep prepare failed: {err}");
                return;
            }
        };
        let mapped = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        });
        let mapped = match mapped {
            Ok(mapped) => mapped,
            Err(err) => {
                eprintln!("plugins.blobs.begin: sweep query failed: {err}");
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
            .execute("DELETE FROM plugin_blob_uploads WHERE id = ?1", params![id])
        {
            eprintln!("plugins.blobs.begin: sweep delete failed: {err}");
        }
    }
}

fn open_append(path: &Path) -> Result<fs::File, KernelError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| crate::assets_upload::io_error(err, "create staged blob directory"))?;
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| crate::assets_upload::io_error(err, "open staged blob file"))
}

/// `plugins.blobs.begin` — reserve an upload id and record the declared size.
pub(crate) fn begin(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req: RequestPluginsBlobsBegin = generated::decode_request_plugins_blobs_begin(request)?;
    {
        let conn = db.conn();
        require_capability(conn, &req.plugin_id, BLOB_CAPABILITY)?;
    }
    // The DTO already caps `totalBytes`; this is the belt-and-braces refusal
    // for a hand-built request, so the filesystem limit can never drift from
    // the rev4 contract silently.
    if req.total_bytes > MAX_BLOB_BYTES {
        return Err(KernelError::new(
            crate::KernelErrorCode::ContractViolation,
            format!(
                "plugins.blobs.begin: totalBytes {} exceeds the {MAX_BLOB_BYTES}-byte limit",
                req.total_bytes
            ),
        ));
    }
    sweep_expired(db);

    let id = new_id();
    let created_at = now();
    db.conn()
        .execute(
            "INSERT INTO plugin_blob_uploads \
             (id, plugin_id, name, content_type, declared_bytes, received_bytes, next_index, \
              created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, ?6, ?6)",
            params![
                &id,
                &req.plugin_id,
                &req.name,
                &req.content_type,
                req.total_bytes,
                &created_at
            ],
        )
        .map_err(|err| product::sqlite(err, "plugins.blobs.begin: insert"))?;
    let row = load_owned_upload(db, &req.plugin_id, &id)?;
    let dto = ResultPluginsBlobsBegin {
        upload_id: id,
        chunk_size_bytes: CHUNK_SIZE_BYTES,
        expires_at: row.expires_at(),
    };
    encode(&dto, generated::validate_result_plugins_blobs_begin)
}

/// `plugins.blobs.append` — stage one sequential chunk.
pub(crate) fn append(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req: RequestPluginsBlobsAppend = generated::decode_request_plugins_blobs_append(request)?;
    {
        let conn = db.conn();
        require_capability(conn, &req.plugin_id, BLOB_CAPABILITY)?;
    }
    let row = load_owned_upload(db, &req.plugin_id, &req.upload_id)?;
    if parse_utc_seconds(&now()).unwrap_or(0) - parse_utc_seconds(&row.updated_at).unwrap_or(0)
        > UPLOAD_TTL_SECONDS
    {
        return Err(upload_expired(&req.upload_id, &row.expires_at()));
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
                format!("plugins.blobs.append: chunk is not base64: {err}"),
            )
        })?;
    let chunk_bytes = bytes.len() as i64;
    if chunk_bytes > CHUNK_SIZE_BYTES {
        return Err(chunk_too_large(&req.upload_id, chunk_bytes));
    }
    let received = row.received_bytes + chunk_bytes;
    if received > row.declared_bytes {
        return Err(upload_size_exceeded(
            &req.upload_id,
            row.declared_bytes,
            received,
        ));
    }
    let path = upload_data_path(db, &req.upload_id);
    let mut file = open_append(&path)?;
    file.write_all(&bytes)
        .map_err(|err| crate::assets_upload::io_error(err, "append staged blob chunk"))?;
    file.flush()
        .map_err(|err| crate::assets_upload::io_error(err, "flush staged blob chunk"))?;
    drop(file);

    let updated_at = now();
    db.conn()
        .execute(
            "UPDATE plugin_blob_uploads SET received_bytes = ?2, next_index = ?3, updated_at = ?4 \
             WHERE id = ?1",
            params![&req.upload_id, received, req.index + 1, &updated_at],
        )
        .map_err(|err| product::sqlite(err, "plugins.blobs.append: update"))?;
    let dto = ResultPluginsBlobsAppend {
        upload_id: req.upload_id,
        received_bytes: received,
        next_index: req.index + 1,
    };
    encode(&dto, generated::validate_result_plugins_blobs_append)
}

/// `plugins.blobs.finish` — publish the staged bytes as a content-addressed
/// blob (dedupe refreshes the metadata of identical bytes).
pub(crate) fn finish(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req: RequestPluginsBlobsFinish = generated::decode_request_plugins_blobs_finish(request)?;
    {
        let conn = db.conn();
        require_capability(conn, &req.plugin_id, BLOB_CAPABILITY)?;
    }
    let row = load_owned_upload(db, &req.plugin_id, &req.upload_id)?;
    if row.received_bytes != row.declared_bytes {
        return Err(upload_incomplete(
            &req.upload_id,
            row.declared_bytes,
            row.received_bytes,
        ));
    }
    let staged = upload_data_path(db, &req.upload_id);
    let (checksum, hashed_bytes) =
        neotavern_storage::assets::sha256_file_hex(&staged).map_err(KernelError::from)?;
    if hashed_bytes != row.declared_bytes {
        return Err(upload_incomplete(
            &req.upload_id,
            row.declared_bytes,
            hashed_bytes,
        ));
    }

    let existing = load_blob(db, &req.plugin_id, &checksum)?;
    let now_stamp = now();
    if existing.is_none() {
        let count = blob_count(db, &req.plugin_id)?;
        if count >= MAX_BLOBS_PER_PLUGIN {
            return Err(quota_exceeded(&req.plugin_id, count));
        }
    }

    let target = blob_path(db, &req.plugin_id, &checksum);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| crate::assets_upload::io_error(err, "create plugin blob directory"))?;
    }
    fs::rename(&staged, &target)
        .map_err(|err| crate::assets_upload::io_error(err, "publish plugin blob"))?;

    db.conn()
        .execute(
            "INSERT INTO plugin_blobs \
             (plugin_id, blob_id, name, content_type, size_bytes, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6) \
             ON CONFLICT (plugin_id, blob_id) DO UPDATE SET \
                 name = excluded.name, \
                 content_type = excluded.content_type, \
                 updated_at = excluded.updated_at",
            params![
                &req.plugin_id,
                &checksum,
                &row.name,
                &row.content_type,
                row.declared_bytes,
                &now_stamp
            ],
        )
        .map_err(|err| product::sqlite(err, "plugins.blobs.finish: upsert"))?;
    let removed = remove_dir_if_present(&upload_dir(db, &req.upload_id));
    db.conn()
        .execute(
            "DELETE FROM plugin_blob_uploads WHERE id = ?1",
            params![&req.upload_id],
        )
        .map_err(|err| product::sqlite(err, "plugins.blobs.finish: delete upload row"))?;
    removed?;

    let stored = load_blob(db, &req.plugin_id, &checksum)?
        .ok_or_else(|| blob_not_found(&req.plugin_id, &checksum))?;
    encode(&stored.dto(), generated::validate_plugin_blob)
}

/// `plugins.blobs.list` — every blob of the plugin, newest first.
pub(crate) fn list(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req: RequestPluginsBlobsList = generated::decode_request_plugins_blobs_list(request)?;
    {
        let conn = db.conn();
        require_capability(conn, &req.plugin_id, BLOB_CAPABILITY)?;
    }
    let rows = {
        let conn = db.conn();
        let mut statement = conn
            .prepare(
                "SELECT blob_id, name, content_type, size_bytes, created_at FROM plugin_blobs \
                 WHERE plugin_id = ?1 ORDER BY created_at DESC, blob_id ASC",
            )
            .map_err(|err| product::sqlite(err, "plugins.blobs.list: prepare"))?;
        let mapped = statement
            .query_map(params![&req.plugin_id], |row| {
                Ok(BlobRow {
                    blob_id: row.get(0)?,
                    name: row.get(1)?,
                    content_type: row.get(2)?,
                    size_bytes: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(|err| product::sqlite(err, "plugins.blobs.list: query"))?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| product::sqlite(err, "plugins.blobs.list: row"))?
    };
    let dto = ResultPluginsBlobsList {
        items: rows.iter().map(BlobRow::dto).collect(),
    };
    encode(&dto, generated::validate_result_plugins_blobs_list)
}

/// `plugins.blobs.read` — bounded range read (the host loops until `eof`).
pub(crate) fn read(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req: RequestPluginsBlobsRead = generated::decode_request_plugins_blobs_read(request)?;
    {
        let conn = db.conn();
        require_capability(conn, &req.plugin_id, BLOB_CAPABILITY)?;
    }
    let row = load_blob(db, &req.plugin_id, &req.blob_id)?
        .ok_or_else(|| blob_not_found(&req.plugin_id, &req.blob_id))?;
    if req.offset > row.size_bytes {
        return Err(KernelError::new(
            crate::KernelErrorCode::ContractViolation,
            format!(
                "plugins.blobs.read: offset {} is past the {}-byte blob",
                req.offset, row.size_bytes
            ),
        ));
    }
    let path = blob_path(db, &req.plugin_id, &req.blob_id);
    let mut file = fs::File::open(&path)
        .map_err(|err| crate::assets_upload::io_error(err, "open plugin blob"))?;
    file.seek(SeekFrom::Start(req.offset as u64))
        .map_err(|err| crate::assets_upload::io_error(err, "seek plugin blob"))?;
    let want = req
        .length
        .min(CHUNK_SIZE_BYTES)
        .min(row.size_bytes - req.offset);
    let mut buffer = vec![0u8; want as usize];
    let read = file
        .read(&mut buffer)
        .map_err(|err| crate::assets_upload::io_error(err, "read plugin blob"))?;
    buffer.truncate(read);
    let dto = ResultPluginsBlobsRead {
        blob_id: row.blob_id,
        content_type: row.content_type,
        size_bytes: row.size_bytes,
        offset: req.offset,
        data_base64: base64::engine::general_purpose::STANDARD.encode(&buffer),
        eof: req.offset + read as i64 >= row.size_bytes,
    };
    encode(&dto, generated::validate_result_plugins_blobs_read)
}

/// `plugins.blobs.delete` — idempotent metadata + bytes removal.
pub(crate) fn delete(db: &mut Database, request: &[u8]) -> Result<Vec<u8>, KernelError> {
    let req: RequestPluginsBlobsDelete = generated::decode_request_plugins_blobs_delete(request)?;
    {
        let conn = db.conn();
        require_capability(conn, &req.plugin_id, BLOB_CAPABILITY)?;
    }
    let existing = load_blob(db, &req.plugin_id, &req.blob_id)?;
    if existing.is_some() {
        db.conn()
            .execute(
                "DELETE FROM plugin_blobs WHERE plugin_id = ?1 AND blob_id = ?2",
                params![&req.plugin_id, &req.blob_id],
            )
            .map_err(|err| product::sqlite(err, "plugins.blobs.delete: delete row"))?;
        let path = blob_path(db, &req.plugin_id, &req.blob_id);
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(crate::assets_upload::io_error(err, "remove plugin blob")),
        }
    }
    let dto = ResultPluginsBlobsDelete {
        deleted: existing.is_some(),
    };
    encode(&dto, generated::validate_result_plugins_blobs_delete)
}
