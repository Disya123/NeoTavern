//! `recorded` provider (design §RecordedProvider): replays a committed JSON
//! script for conformance testing.
//!
//! The request `model` field selects a [`RecordedScript`] by id; unknown ids
//! yield `RequestInvalid`. Replay honors cancellation, the deadline and
//! `EmitStatus::Stop` exactly like the fake provider, and a `Fail` step maps
//! to the matching [`ProviderErrorCode`].

use provider_sdk::policy::Usage;
use provider_sdk::{
    Availability, CancelToken, EmitStatus, ProviderAdapter, ProviderError, ProviderErrorCode,
    ProviderEvent, ProviderModel, ProviderRequest,
};
use serde::{Deserialize, Serialize};

use crate::sleep_checking;

/// Maximum replay delay per `Sleep` step in milliseconds; larger script
/// values clamp at replay (design §RecordedProvider).
const MAX_SLEEP_MS: u64 = 200;

/// One replayed generation script (serde JSON).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecordedScript {
    /// Script identifier, selected by the request `model` field.
    pub id: String,
    /// Steps replayed in order.
    pub steps: Vec<RecordedStep>,
}

/// One step of a [`RecordedScript`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum RecordedStep {
    /// Emit one text delta.
    Delta {
        /// Delta text.
        text: String,
    },
    /// Pause `ms` milliseconds before the next step (clamped to 0..=200 at
    /// replay).
    Sleep {
        /// Pause length in milliseconds.
        ms: u64,
    },
    /// Fail with the mapped error code
    /// (`"step-failed" | "network-fault" | "unavailable"`).
    Fail {
        /// Mapped [`ProviderErrorCode`] key.
        code: String,
    },
}

impl RecordedScript {
    /// Parses a script from JSON.
    ///
    /// Malformed JSON yields `Err(RequestInvalid)`.
    pub fn from_json(json: &str) -> Result<Self, ProviderError> {
        serde_json::from_str(json).map_err(|e| {
            ProviderError::new(
                ProviderErrorCode::RequestInvalid,
                format!("invalid recorded script JSON: {e}"),
            )
        })
    }
}

/// Maps a `Fail` step code to the normalized [`ProviderErrorCode`]; unknown
/// codes are invalid scripts (`RequestInvalid`).
fn fail_code(code: &str) -> Result<ProviderErrorCode, ProviderError> {
    match code {
        "step-failed" => Ok(ProviderErrorCode::StepFailed),
        "network-fault" => Ok(ProviderErrorCode::NetworkFault),
        "unavailable" => Ok(ProviderErrorCode::Unavailable),
        other => Err(ProviderError::new(
            ProviderErrorCode::RequestInvalid,
            format!("unknown recorded fail code: {other}"),
        )),
    }
}

/// Script-replaying `recorded` provider.
#[derive(Debug)]
pub struct RecordedProvider {
    scripts: Vec<RecordedScript>,
}

impl RecordedProvider {
    /// Creates the provider replaying the given scripts; the request `model`
    /// selects a script by id.
    pub fn new(scripts: Vec<RecordedScript>) -> Self {
        Self { scripts }
    }
}

impl ProviderAdapter for RecordedProvider {
    fn id(&self) -> &str {
        "recorded"
    }

    fn name(&self) -> &str {
        "Recorded Provider"
    }

    fn builtin(&self) -> bool {
        true
    }

    fn models(&self) -> Vec<ProviderModel> {
        self.scripts
            .iter()
            .map(|script| ProviderModel {
                id: script.id.clone(),
                name: script.id.clone(),
                context_limit: None,
                max_output_tokens: None,
            })
            .collect()
    }

    fn availability(&self) -> Availability {
        Availability::Available
    }

    fn generate(
        &self,
        request: &ProviderRequest<'_>,
        cancel: CancelToken<'_>,
        emit: &mut dyn FnMut(ProviderEvent) -> EmitStatus,
    ) -> Result<Usage, ProviderError> {
        // Pre-cancel check at generate entry — replay honors cancel/deadline/
        // Stop exactly like the fake provider (design §RecordedProvider).
        if cancel.is_cancelled() {
            return Err(ProviderError::new(
                ProviderErrorCode::Cancelled,
                "cancelled before start",
            ));
        }
        let script = self
            .scripts
            .iter()
            .find(|script| script.id == request.model)
            .ok_or_else(|| {
                ProviderError::with(
                    ProviderErrorCode::RequestInvalid,
                    format!("unknown recorded script model: {}", request.model),
                    vec![("model".to_string(), request.model.to_string())],
                )
            })?;

        let mut emitted_steps: u64 = 0;
        let mut output_chars: u64 = 0;
        for step in &script.steps {
            if cancel.is_cancelled() {
                return Err(ProviderError::new(
                    ProviderErrorCode::Cancelled,
                    "cancelled before step",
                ));
            }
            if request.deadline.is_some_and(|d| d.expired()) {
                return Err(ProviderError::new(
                    ProviderErrorCode::Timeout,
                    "deadline expired before step",
                ));
            }
            match step {
                RecordedStep::Delta { text } => {
                    let chars = text.chars().count() as u64;
                    if emit(ProviderEvent::Delta { text: text.clone() }) == EmitStatus::Stop {
                        return Err(ProviderError::new(
                            ProviderErrorCode::Cancelled,
                            "executor requested stop",
                        ));
                    }
                    emitted_steps += 1;
                    output_chars += chars;
                }
                RecordedStep::Sleep { ms } => {
                    sleep_checking(&cancel, request.deadline, (*ms).min(MAX_SLEEP_MS))?;
                }
                RecordedStep::Fail { code } => {
                    return Err(ProviderError::with(
                        fail_code(code)?,
                        format!("recorded script failed: {code}"),
                        Vec::new(),
                    ));
                }
            }
        }
        Ok(Usage {
            steps: emitted_steps,
            output_chars,
        })
    }
}
