//! Host tool executor seam (ТЗ §8.3, §9.3, Этап 2.7, M5 slice 57).
//!
//! The kernel NEVER executes tools: it validates the normalized tool call
//! against the declarative registry, journals the durable `tool_call` step
//! and durably waits (`waiting_for_tool`). The HOST performs the effect and
//! submits the result via `generation.tool.result`. This module is the
//! desktop host's seam: stream pollers hand every waiting `tool_call` step to
//! the registered [`ToolExecutor`], which returns:
//!
//! - `Ok(None)` — not handled; the run stays durably waiting (the UI / a
//!   future consent flow may drive it),
//! - `Ok(Some(value))` — the wire result to submit, resuming the run,
//! - `Err(_)` — execution failed; the run stays waiting (recoverable) and
//!   only the tool NAME is logged (SEC-07: never the arguments, never the
//!   result content).
//!
//! SEC-07: the executor logs nothing itself; the poller logs only the tool
//! name on success/failure. The built-in executor covers only
//! side-effect-free, consent-free tools — `app_now` (pure UTC clock, no I/O,
//! no secrets). Network/fs/process tools fall in the high-risk consent
//! categories (ТЗ §14.2.3) and stay unhandled until the consent flow exists.

use contracts_generated::generated::{EventEnvelope, ToolCall};
/// Result of one host-side tool execution attempt.
pub trait ToolExecutor: Send + Sync {
    /// `Ok(None)` — not handled; the run stays durably waiting.
    /// `Ok(Some(value))` — the wire result to submit via
    /// `generation.tool.result` (the resumed provider turn receives it).
    /// `Err(_)` — the effect failed; the run stays waiting (recoverable),
    /// the caller logs a redacted diagnostic.
    fn execute(&self, tool_call: &ToolCall) -> Result<Option<serde_json::Value>, String>;
}

/// A host that never executes tools — the default. Waiting runs behave
/// exactly as before this slice: the consumer stream closes and the run
/// stays durably waiting for an external result.
#[derive(Debug, Default)]
pub struct NoopToolExecutor;

impl ToolExecutor for NoopToolExecutor {
    fn execute(&self, _tool_call: &ToolCall) -> Result<Option<serde_json::Value>, String> {
        Ok(None)
    }
}

/// Built-in side-effect-free tool effects (M5 slice 57).
///
/// `app_now` returns the current UTC time: pure, deterministic per call, no
/// I/O, no secrets, no consent required (the ТЗ §14.2.3 high-risk categories
/// — network, filesystem, process execution, legacy island — are none of
/// these). The provider may call it to anchor the conversation in real time.
#[derive(Debug, Default)]
pub struct BuiltinToolExecutor;

impl ToolExecutor for BuiltinToolExecutor {
    fn execute(&self, tool_call: &ToolCall) -> Result<Option<serde_json::Value>, String> {
        match tool_call.name.as_str() {
            "app_now" => {
                let secs = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|_| "system clock before the unix epoch".to_string())?
                    .as_secs() as i64;
                Ok(Some(serde_json::json!({
                    "unix": secs,
                    "iso": unix_to_utc_rfc3339(secs),
                })))
            }
            _ => Ok(None),
        }
    }
}

/// Extracts the normalized tool call from a committed event when (and only
/// when) it is a durably WAITING `tool_call` step. Returns `None` for every
/// other event/step — the poller must never act on text deltas, completed
/// steps or terminal events.
pub fn step_tool_call(step_event: &EventEnvelope) -> Option<ToolCall> {
    if step_event.r#type != "generation.step" {
        return None;
    }
    let step = step_event.payload.get("step")?;
    if step.get("type").and_then(|value| value.as_str()) != Some("tool_call") {
        return None;
    }
    if step.get("status").and_then(|value| value.as_str()) != Some("waiting") {
        return None;
    }
    serde_json::from_value(step.get("input")?.get("toolCall")?.clone()).ok()
}

/// Formats a unix timestamp as a UTC RFC 3339 string without external
/// dependencies (e.g. `2026-08-13T12:34:56Z`). Pure arithmetic: days since
/// epoch → proleptic Gregorian calendar date.
fn unix_to_utc_rfc3339(unix_secs: i64) -> String {
    let days = unix_secs.div_euclid(86_400);
    let secs_of_day = unix_secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Days since 1970-01-01 → (year, month, day) in the proleptic Gregorian
/// calendar (Howard Hinnant's civil_from_days algorithm).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    fn tool_call(name: &str) -> ToolCall {
        ToolCall {
            id: "00000000-0000-4000-8000-000000000001".to_string(),
            name: name.to_string(),
            arguments: serde_json::json!({}),
        }
    }

    #[test]
    fn builtin_executor_answers_app_now() {
        let executor = BuiltinToolExecutor;
        let result = executor
            .execute(&tool_call("app_now"))
            .expect("app_now succeeds");
        let value = result.expect("app_now must be handled");
        assert!(value["unix"].as_i64().is_some());
        assert!(value["iso"].as_str().is_some());
    }

    #[test]
    fn builtin_executor_leaves_unknown_tools_waiting() {
        let executor = BuiltinToolExecutor;
        let result = executor
            .execute(&tool_call("lookup_weather"))
            .expect("unknown tool is not an error");
        assert!(result.is_none(), "unknown tool stays waiting");
    }

    #[test]
    fn noop_executor_never_handles() {
        let executor = NoopToolExecutor;
        assert!(executor.execute(&tool_call("app_now")).unwrap().is_none());
    }

    #[test]
    fn step_tool_call_extracts_only_waiting_tool_call_steps() {
        let event = |r#type: &str, step: serde_json::Value| EventEnvelope {
            stream_id: "run-1".to_string(),
            sequence: 1,
            r#type: r#type.to_string(),
            payload: serde_json::json!({ "step": step }),
        };
        let waiting = event(
            "generation.step",
            serde_json::json!({
                "type": "tool_call",
                "status": "waiting",
                "input": {
                    "toolCall": {
                        "id": "00000000-0000-4000-8000-000000000007",
                        "name": "app_now",
                        "arguments": {},
                    }
                },
            }),
        );
        let extracted = step_tool_call(&waiting).expect("waiting tool_call step extracts");
        assert_eq!(extracted.name, "app_now");

        // A completed tool_call step must NOT be executed again.
        let completed = event(
            "generation.step",
            serde_json::json!({
                "type": "tool_call",
                "status": "completed",
                "input": {
                    "toolCall": {
                        "id": "00000000-0000-4000-8000-000000000007",
                        "name": "app_now",
                        "arguments": {},
                    }
                },
            }),
        );
        assert!(step_tool_call(&completed).is_none());

        // A tool_result step must NOT be executed.
        let result_step = event(
            "generation.step",
            serde_json::json!({ "type": "tool_result", "status": "completed" }),
        );
        assert!(step_tool_call(&result_step).is_none());

        // A terminal event carries no step at all.
        assert!(step_tool_call(&EventEnvelope {
            stream_id: "run-1".to_string(),
            sequence: 2,
            r#type: "generation.completed".to_string(),
            payload: serde_json::json!({}),
        })
        .is_none());
    }

    #[test]
    fn rfc3339_utc_rounds_to_expected_strings() {
        assert_eq!(unix_to_utc_rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(unix_to_utc_rfc3339(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(unix_to_utc_rfc3339(1_700_000_000), "2023-11-14T22:13:20Z");
    }

    #[test]
    fn executor_trait_object_is_shareable() {
        let executor: Arc<dyn ToolExecutor> = Arc::new(BuiltinToolExecutor);
        let clone = Arc::clone(&executor);
        let result = clone.execute(&tool_call("app_now")).unwrap();
        assert!(result.is_some());
    }
}
