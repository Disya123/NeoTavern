//! Hand-written runtime for the generated wire-contract DTOs.
//!
//! [`generated`] is emitted by `tools/contract-codegen/codegen.mjs` and is
//! intentionally absent until the codegen step runs: the crate does not
//! compile until then, which is expected.

use serde::de::DeserializeOwned;
use std::sync::LazyLock;

pub mod generated;

/// A single wire-contract violation found during structural validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issue {
    /// Path to the offending value ("" for the root), e.g. `/properties/name`.
    pub path: String,
    /// Machine-readable rule name, e.g. `minLength` or `unknown-key`.
    pub rule: String,
}

impl Issue {
    /// Creates a new issue at `path` with rule `rule`.
    pub fn new(path: impl Into<String>, rule: impl Into<String>) -> Self {
        Issue {
            path: path.into(),
            rule: rule.into(),
        }
    }
}

/// Classification of a wire decoding failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireErrorKind {
    /// The bytes were not valid JSON.
    Parse,
    /// The JSON parsed but violated the wire contract.
    Violation,
    /// The contract check passed yet typed decoding failed (crate bug).
    Internal,
}

/// A wire decoding failure: malformed JSON, a contract violation, or an
/// internal mismatch between the structural check and the typed DTO.
#[derive(Debug, Clone)]
pub struct WireError {
    /// Failure classification.
    pub kind: WireErrorKind,
    /// Human-readable description of the failure.
    pub message: String,
    /// Structural violations, populated for [`WireErrorKind::Violation`].
    pub issues: Vec<Issue>,
}

impl WireError {
    /// Builds a parse failure (bytes were not valid JSON).
    pub fn parse(message: impl Into<String>) -> Self {
        WireError {
            kind: WireErrorKind::Parse,
            message: message.into(),
            issues: Vec::new(),
        }
    }

    /// Builds a contract-violation failure carrying the structural issues.
    pub fn violation(message: impl Into<String>, issues: Vec<Issue>) -> Self {
        WireError {
            kind: WireErrorKind::Violation,
            message: message.into(),
            issues,
        }
    }

    /// Builds an internal failure (check passed but typed decode failed).
    pub fn internal(message: impl Into<String>) -> Self {
        WireError {
            kind: WireErrorKind::Internal,
            message: message.into(),
            issues: Vec::new(),
        }
    }
}

impl std::fmt::Display for WireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "wire error: {}", self.message)
    }
}

impl std::error::Error for WireError {}

/// Decodes `bytes` into `T` following the three-stage wire pipeline:
/// parse JSON, run the structural check, then deserialize into `T`.
///
/// Errors are classified as [`WireErrorKind::Parse`] (invalid JSON),
/// [`WireErrorKind::Violation`] (JSON parsed but failed `check`), or
/// [`WireErrorKind::Internal`] (the check passed yet typed decoding failed —
/// a bug in the generated DTO, never a payload problem).
pub fn decode<T: DeserializeOwned>(
    check: impl Fn(&serde_json::Value) -> Result<(), Vec<Issue>>,
    bytes: &[u8],
) -> Result<T, WireError> {
    let value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|e| WireError::parse(format!("invalid JSON: {e}")))?;
    check(&value)
        .map_err(|issues| WireError::violation("payload violates wire contract", issues))?;
    serde_json::from_value(value)
        .map_err(|e| WireError::internal(format!("typed decode failed after check: {e}")))
}

/// The canonical contract manifest embedded at build time (packaging constant).
pub const CONTRACT_MANIFEST_JSON: &str =
    include_str!("../../../packages/contracts/generated/contract-manifest.json");

/// The sha256 schema hash of the contract bundle. Panics only on a malformed
/// embedded manifest — a packaging bug, never a runtime payload.
pub fn contract_schema_hash() -> &'static str {
    static HASH: LazyLock<String> = LazyLock::new(|| {
        let manifest: serde_json::Value = serde_json::from_str(CONTRACT_MANIFEST_JSON)
            .expect("embedded contract manifest is not valid JSON (packaging bug)");
        manifest
            .get("schemaHash")
            .and_then(serde_json::Value::as_str)
            .expect("embedded contract manifest is missing schemaHash (packaging bug)")
            .to_owned()
    });
    &HASH
}

/// The wire protocol version `(major, minor)` from the embedded manifest.
/// Panics only on a malformed embedded manifest (packaging bug).
pub fn wire_protocol() -> (i64, i64) {
    static PROTOCOL: LazyLock<(i64, i64)> = LazyLock::new(|| {
        let manifest: serde_json::Value = serde_json::from_str(CONTRACT_MANIFEST_JSON)
            .expect("embedded contract manifest is not valid JSON (packaging bug)");
        let major = manifest
            .pointer("/wireProtocol/major")
            .and_then(serde_json::Value::as_i64)
            .expect("embedded contract manifest is missing wireProtocol.major (packaging bug)");
        let minor = manifest
            .pointer("/wireProtocol/minor")
            .and_then(serde_json::Value::as_i64)
            .expect("embedded contract manifest is missing wireProtocol.minor (packaging bug)");
        (major, minor)
    });
    *PROTOCOL
}
