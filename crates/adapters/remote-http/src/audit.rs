//! Bounded structured audit log for the remote adapter (ТЗ §10, Phase 4
//! hardening / Phase 9).
//!
//! Every security-relevant transition is recorded as a typed, bounded event:
//! adapter start/bind, pairing created/revoked, auth granted/denied,
//! rate-limited requests and stream-limit rejections.
//!
//! **Never secrets.** [`AuditEvent::detail`] carries only stable ids and
//! rules — never tokens, Authorization headers, raw payloads or user
//! content (ТЗ §10: "audit events не содержат token, secret или raw user
//! content"). The ring is bounded ([`AuditLog::new`] capacity), so memory
//! cannot grow without bound.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::SystemTime;

/// Stable audit event kinds. Adding a kind is additive and safe; removing
/// one is a breaking diagnostics change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuditKind {
    /// The adapter listener started (bind succeeded).
    Started,
    /// The adapter began graceful shutdown.
    Shutdown,
    /// A new credential was paired (detail: credential id).
    PairCreated,
    /// A credential was revoked (detail: credential id).
    PairRevoked,
    /// A request was admitted with a valid credential (detail: credential
    /// id).
    AuthGranted,
    /// A request was rejected at the auth gate (detail: rule — missing /
    /// malformed / invalid credential).
    AuthDenied,
    /// A request was rejected by the rate limiter (detail: rule
    /// `rate_limited`).
    RateLimited,
    /// A stream was rejected because the concurrent-stream cap was reached
    /// (detail: rule `stream_limit`).
    StreamLimitReached,
    /// A request was rejected by the CORS/Origin gate (detail: rule
    /// `origin_not_allowed`).
    OriginDenied,
}

/// One audit event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditEvent {
    /// Wall-clock time the event was recorded.
    pub at: SystemTime,
    /// The event kind.
    pub kind: AuditKind,
    /// Stable, secret-free detail (credential ids, rule names — never token
    /// material or payload bytes).
    pub detail: String,
}

/// A bounded ring buffer of audit events (FIFO: oldest dropped at capacity).
pub struct AuditLog {
    capacity: usize,
    events: Mutex<VecDeque<AuditEvent>>,
}

impl AuditLog {
    /// An empty log bounded to `capacity` events.
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            events: Mutex::new(VecDeque::with_capacity(capacity)),
        }
    }

    /// Records one event; drops the oldest when at capacity.
    pub fn record(&self, kind: AuditKind, detail: impl Into<String>) {
        let mut events = self
            .events
            .lock()
            .expect("audit log mutex poisoned (adapter bug)");
        if events.len() >= self.capacity {
            events.pop_front();
        }
        events.push_back(AuditEvent {
            at: SystemTime::now(),
            kind,
            detail: detail.into(),
        });
    }

    /// A snapshot of the recorded events, oldest first.
    pub fn snapshot(&self) -> Vec<AuditEvent> {
        self.events
            .lock()
            .expect("audit log mutex poisoned (adapter bug)")
            .iter()
            .cloned()
            .collect()
    }

    /// Whether any event of `kind` exists in the log.
    pub fn contains(&self, kind: AuditKind) -> bool {
        self.snapshot().iter().any(|event| event.kind == kind)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_is_bounded_fifo() {
        let log = AuditLog::new(3);
        for i in 0..5 {
            log.record(AuditKind::Started, format!("event-{i}"));
        }
        let snapshot = log.snapshot();
        assert_eq!(snapshot.len(), 3, "ring bounded at capacity");
        assert_eq!(snapshot[0].detail, "event-2", "oldest dropped first");
        assert_eq!(snapshot[2].detail, "event-4");
    }

    #[test]
    fn contains_finds_recorded_kind() {
        let log = AuditLog::new(8);
        log.record(AuditKind::PairCreated, "cred-1");
        assert!(log.contains(AuditKind::PairCreated));
        assert!(!log.contains(AuditKind::AuthDenied));
    }
}
