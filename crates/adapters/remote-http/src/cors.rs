//! CORS/Origin policy for the remote adapter (ТЗ §10, Phase 4 hardening /
//! Phase 9).
//!
//! **Deny-by-default.** Browsers enforce same-origin; a cross-origin page can
//! only read a response when the server explicitly allows the origin. The
//! adapter therefore admits requests that carry an `Origin` header ONLY when
//! the origin exactly matches an entry of
//! [`crate::RemoteAdapterConfig::allowed_origins`]. With the default (empty)
//! allowlist, every browser-originated request is rejected with 403
//! `ORIGIN_NOT_ALLOWED` before any body read or dispatch — `Access-Control-*`
//! headers are never emitted for disallowed origins, so no browser can read
//! an adapter response cross-origin (§10: "CORS/Origin policy deny-by-default;
//! browser auth защищён от CSRF").
//!
//! Non-browser clients (CLI, the Client SDK outside a browser) send no
//! `Origin` header and are unaffected.

use std::collections::HashSet;

/// Exact-match origin allowlist. An empty set denies every browser origin
/// (deny-by-default).
#[derive(Debug, Clone)]
pub struct CorsPolicy {
    allowed: HashSet<String>,
}

impl CorsPolicy {
    /// A policy over the configured origins. Empty input = deny all origins.
    pub fn new(allowed_origins: &[String]) -> Self {
        Self {
            allowed: allowed_origins.iter().cloned().collect(),
        }
    }

    /// Exact-match check (case-sensitive, no wildcards). `false` = the
    /// request must be rejected 403 `ORIGIN_NOT_ALLOWED` before dispatch.
    pub fn allows(&self, origin: &str) -> bool {
        self.allowed.contains(origin)
    }

    /// The allowed origins (diagnostics/tests).
    pub fn allowed(&self) -> impl Iterator<Item = &str> {
        self.allowed.iter().map(String::as_str)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(origins: &[&str]) -> CorsPolicy {
        let origins: Vec<String> = origins.iter().map(|s| s.to_string()).collect();
        CorsPolicy::new(&origins)
    }

    #[test]
    fn empty_allowlist_denies_every_origin() {
        let policy = policy(&[]);
        assert!(!policy.allows("https://example.com"));
        assert!(!policy.allows("http://127.0.0.1:8080"));
    }

    #[test]
    fn exact_match_admits_only_listed_origins() {
        let policy = policy(&["https://app.example.com"]);
        assert!(policy.allows("https://app.example.com"));
        // Scheme, host, port and case must all match exactly.
        assert!(!policy.allows("https://app.example.com:443"));
        assert!(!policy.allows("http://app.example.com"));
        assert!(!policy.allows("https://APP.EXAMPLE.COM"));
        assert!(!policy.allows("https://evil.example.com"));
    }

    #[test]
    fn multiple_origins_all_admitted() {
        let policy = policy(&["https://a.example", "https://b.example"]);
        assert!(policy.allows("https://a.example"));
        assert!(policy.allows("https://b.example"));
        assert!(!policy.allows("https://c.example"));
    }
}
