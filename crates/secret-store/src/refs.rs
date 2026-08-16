//! Opaque secret references (ТЗ §SEC-01, ADR-0040).
//!
//! The database stores only references — never values. A reference encodes
//! the backend kind and the namespaced id: `portable:<namespace>:<id>`,
//! `session:<namespace>:<id>`, `env:<namespace>:<id>`. Parsing splits on the
//! LAST colon after the kind prefix, so namespaces may themselves contain
//! colons (e.g. `portable:provider:openai:rec-1` → namespace
//! `provider:openai`, id `rec-1`) — mirroring the legacy-contour
//! `parseSecretRef` contract.

/// Backend kinds a reference can point at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretRefKind {
    Portable,
    Session,
    Env,
    /// Machine-bound OS credential vault (Windows Credential Manager /
    /// macOS Keychain / Linux Secret Service).
    OsVault,
}

impl SecretRefKind {
    /// The reference prefix, including the trailing `:`.
    pub fn prefix(self) -> &'static str {
        match self {
            Self::Portable => "portable:",
            Self::Session => "session:",
            Self::Env => "env:",
            Self::OsVault => "osvault:",
        }
    }
}

impl std::fmt::Display for SecretRefKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.prefix())
    }
}

/// A parsed secret reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretRef {
    pub kind: SecretRefKind,
    pub namespace: String,
    pub id: String,
}

impl SecretRef {
    /// Renders the canonical reference string.
    pub fn render(&self) -> String {
        format!("{}{}:{}", self.kind.prefix(), self.namespace, self.id)
    }
}

/// Builds a reference string for `kind`/`namespace`/`id`.
pub fn make_ref(kind: SecretRefKind, namespace: &str, id: &str) -> String {
    format!("{}{}:{}", kind.prefix(), namespace, id)
}

/// Parses a reference string. Returns `None` for anything that is not a
/// known-kind reference with a non-empty namespace and id.
pub fn parse_ref(raw: &str) -> Option<SecretRef> {
    for kind in [
        SecretRefKind::Portable,
        SecretRefKind::Session,
        SecretRefKind::Env,
        SecretRefKind::OsVault,
    ] {
        let prefix = kind.prefix();
        let Some(rest) = raw.strip_prefix(prefix) else {
            continue;
        };
        // Namespace may contain colons; the id is the last segment.
        let last_colon = rest.rfind(':')?;
        if last_colon == 0 || last_colon == rest.len() - 1 {
            return None;
        }
        return Some(SecretRef {
            kind,
            namespace: rest[..last_colon].to_string(),
            id: rest[last_colon + 1..].to_string(),
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn make_and_parse_roundtrip() {
        for (kind, ns, id) in [
            (SecretRefKind::Portable, "provider:openai", "01hx"),
            (
                SecretRefKind::Session,
                "plugin:test.sec01",
                "user\u{0}apiKey",
            ),
            (SecretRefKind::Env, "provider", "openaikey"),
            (SecretRefKind::OsVault, "provider:openai", "rec-machine-1"),
        ] {
            let raw = make_ref(kind, ns, id);
            let parsed = parse_ref(&raw).expect("parse");
            assert_eq!(parsed.kind, kind);
            assert_eq!(parsed.namespace, ns);
            assert_eq!(parsed.id, id);
        }
    }

    #[test]
    fn ids_may_contain_colons_after_the_namespace() {
        // Split on the last colon: the namespace keeps its own colons, the
        // id is the final segment (mirrors the legacy parseSecretRef).
        let raw = "session:provider:openai:sk-123:456";
        let parsed = parse_ref(raw).expect("parse");
        assert_eq!(parsed.namespace, "provider:openai:sk-123");
        assert_eq!(parsed.id, "456");
        let raw = "portable:provider:openai:rec-1";
        let parsed = parse_ref(raw).expect("parse");
        assert_eq!(parsed.namespace, "provider:openai");
        assert_eq!(parsed.id, "rec-1");
    }

    #[test]
    fn rejects_invalid_references() {
        for raw in [
            "",
            "portable:",
            "session::id",
            "env:ns:",
            "unknown:ns:id",
            "portablens:id",
        ] {
            assert!(parse_ref(raw).is_none(), "{raw:?} must not parse");
        }
    }
}
