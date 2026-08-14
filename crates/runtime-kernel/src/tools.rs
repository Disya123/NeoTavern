//! Kernel tool registry (ТЗ §8.3, Этап 2.7).
//!
//! Tools are **declarative**: the host registers the wire `wire.tool.spec`
//! contract (id, name, description, input JSON-Schema) and the kernel uses it
//! to validate every normalized tool call before a run may durably wait on
//! the result. The kernel NEVER executes tools itself (§9.3): the host
//! performs the effect and submits the result via `generation.tool.result`.
//!
//! Validation is a minimal JSON-Schema subset (`object` with
//! `properties`/`required`/`additionalProperties` and scalar/array/object
//! property types) — enough to enforce the golden slice contract; the full
//! JSON-Schema engine is a follow-up.

use crate::KernelError;
use contracts_generated::generated::{self, ResultListTools, ToolSpec};

/// Maximum tool calls a single run may perform before the loop guard fails
/// the run with `TOOL_LOOP_LIMIT` (ТЗ §8.3 budgets/loop detection).
pub(crate) const MAX_TOOL_CALLS: usize = 8;

/// The in-memory set of registered tool contracts. `Clone` so the writer
/// thread can snapshot it for a stream run; thread-safe by construction (the
/// writer is the only mutator).
#[derive(Debug, Clone, Default)]
pub(crate) struct ToolRegistry {
    tools: Vec<ToolSpec>,
}

impl ToolRegistry {
    /// An empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers (or replaces, by `id`) a tool contract.
    pub fn register(&mut self, spec: ToolSpec) {
        self.tools.retain(|t| t.id != spec.id);
        self.tools.push(spec);
    }

    /// Finds a tool by `name` (the identifier the model calls) or by `id`.
    pub fn find(&self, name: &str) -> Option<&ToolSpec> {
        self.tools.iter().find(|t| t.name == name || t.id == name)
    }

    /// All registered contracts, in registration order.
    pub fn list(&self) -> Vec<ToolSpec> {
        self.tools.clone()
    }
}

/// `generation.tools.list` — stateless registry listing (like `providers.list`).
/// Strict empty request; the response is validated through the generated
/// checker before serialization.
pub(crate) fn generation_tools_list(
    registry: &ToolRegistry,
    request: &[u8],
) -> Result<Vec<u8>, KernelError> {
    generated::decode_empty_request_dto(request)?;
    let dto = ResultListTools {
        items: registry.list(),
    };
    crate::product::validate(&dto, generated::validate_result_list_tools)?;
    crate::product::encode(&dto)
}

/// Minimal JSON-Schema subset validation of tool call `arguments` against the
/// tool's `input_schema` (ТЗ §8.3 schema validation). Supported surface:
///
/// - `type: "object"` with `properties`, `required` and
///   `additionalProperties`;
/// - property types `string`, `number`, `integer`, `boolean`, `object`,
///   `array`, `null`;
/// - nested object/array properties are checked recursively.
///
/// An empty, absent or non-object schema validates everything (the schema is
/// treated as "free-form"). Returns the first violation as a message.
pub(crate) fn validate_arguments(
    schema: &serde_json::Value,
    args: &serde_json::Value,
) -> Result<(), String> {
    validate_node(schema, args, "$")
}

fn validate_node(
    schema: &serde_json::Value,
    value: &serde_json::Value,
    path: &str,
) -> Result<(), String> {
    // No schema → anything goes.
    if !schema.is_object() {
        return Ok(());
    }
    let object = schema.as_object().expect("checked above");
    match object.get("type").and_then(|t| t.as_str()) {
        Some("object") => {
            if !value.is_object() {
                return Err(format!("{path}: expected object"));
            }
            if let Some(required) = object.get("required").and_then(|r| r.as_array()) {
                for entry in required {
                    let name = entry
                        .as_str()
                        .ok_or_else(|| format!("{path}: required must be a string array"))?;
                    if !value.get(name).is_some() {
                        return Err(format!("{path}: missing required property '{name}'"));
                    }
                }
            }
            let args_obj = value.as_object().expect("checked above");
            if let Some(properties) = object.get("properties").and_then(|p| p.as_object()) {
                for (name, prop_schema) in properties {
                    if let Some(prop_value) = args_obj.get(name) {
                        validate_node(prop_schema, prop_value, &format!("{path}.{name}"))?;
                    }
                }
            }
            if let Some(false) = object.get("additionalProperties").and_then(|a| a.as_bool()) {
                for key in args_obj.keys() {
                    if !properties_contains(object, key) {
                        return Err(format!(
                            "{path}: additional property '{key}' is not allowed"
                        ));
                    }
                }
            }
            Ok(())
        }
        Some("array") => {
            if !value.is_array() {
                return Err(format!("{path}: expected array"));
            }
            if let Some(items) = object.get("items") {
                for (i, item) in value.as_array().expect("checked above").iter().enumerate() {
                    validate_node(items, item, &format!("{path}[{i}]"))?;
                }
            }
            Ok(())
        }
        Some("string") => {
            if !value.is_string() {
                Err(format!("{path}: expected string"))
            } else {
                Ok(())
            }
        }
        Some("number") => {
            if !value.is_number() {
                Err(format!("{path}: expected number"))
            } else {
                Ok(())
            }
        }
        Some("integer") => match value.as_i64() {
            Some(_) => Ok(()),
            None => Err(format!("{path}: expected integer")),
        },
        Some("boolean") => {
            if value.is_boolean() {
                Ok(())
            } else {
                Err(format!("{path}: expected boolean"))
            }
        }
        Some("null") => {
            if value.is_null() {
                Ok(())
            } else {
                Err(format!("{path}: expected null"))
            }
        }
        Some(other) => Err(format!("{path}: unsupported schema type '{other}'")),
        // A type-less schema node constrains nothing further.
        None => Ok(()),
    }
}

fn properties_contains(
    schema_object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> bool {
    schema_object
        .get("properties")
        .and_then(|p| p.as_object())
        .is_some_and(|properties| properties.contains_key(key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_object_schema_subset() {
        let schema = json!({
            "type": "object",
            "properties": {
                "city": { "type": "string" },
                "units": { "type": "string" },
                "count": { "type": "integer" }
            },
            "required": ["city"],
            "additionalProperties": false
        });
        assert!(validate_arguments(&schema, &json!({"city": "Kyiv", "count": 2})).is_ok());
        assert!(validate_arguments(&schema, &json!({"city": "Kyiv", "extra": 1})).is_err());
        assert!(validate_arguments(&schema, &json!({"count": 2})).is_err());
        assert!(validate_arguments(&schema, &json!({"city": 7})).is_err());
        assert!(validate_arguments(&schema, &json!({"city": "Kyiv", "count": 2.5})).is_err());
    }

    #[test]
    fn empty_or_freeform_schema_validates_anything() {
        assert!(validate_arguments(&json!({}), &json!({"any": ["thing", 1]})).is_ok());
        assert!(validate_arguments(&json!(null), &json!(42)).is_ok());
    }

    #[test]
    fn nested_arrays_are_checked() {
        let schema = json!({
            "type": "object",
            "properties": {
                "tags": { "type": "array", "items": { "type": "string" } }
            }
        });
        assert!(validate_arguments(&schema, &json!({"tags": ["a", "b"]})).is_ok());
        assert!(validate_arguments(&schema, &json!({"tags": ["a", 3]})).is_err());
    }

    #[test]
    fn registry_finds_by_name_or_id() {
        let mut registry = ToolRegistry::new();
        assert!(registry.list().is_empty());
        registry.register(ToolSpec {
            id: "lookup-weather".to_string(),
            name: "lookup_weather".to_string(),
            description: "weather".to_string(),
            input_schema: json!({}),
        });
        assert!(!registry.list().is_empty());
        assert!(registry.find("lookup_weather").is_some());
        assert!(registry.find("lookup-weather").is_some());
        assert!(registry.find("missing").is_none());
        assert_eq!(registry.list().len(), 1);
        // Registering the same id replaces it.
        registry.register(ToolSpec {
            id: "lookup-weather".to_string(),
            name: "lookup_weather_v2".to_string(),
            description: "weather v2".to_string(),
            input_schema: json!({}),
        });
        assert_eq!(registry.list().len(), 1);
        assert!(registry.find("lookup_weather_v2").is_some());
        assert!(registry.find("lookup_weather").is_none());
    }
}
