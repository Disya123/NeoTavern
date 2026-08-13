//! Token-bucket rate limiting for the remote adapter (ТЗ §10, Phase 4
//! hardening / Phase 9).
//!
//! The limiter keys buckets by a caller-provided scope string: the paired
//! credential id when auth is enabled, otherwise the peer IP address. Every
//! bucket holds `burst` tokens and refills at `requests_per_second`;
//! `allow()` consumes one token and rejects when the bucket is empty.
//!
//! **Bounded memory.** The bucket map is capped at
//! [`RateLimitConfig::max_clients`]; when a new key would exceed the cap the
//! least-recently-refilled bucket is evicted, so an attacker rotating IPs /
//! credential ids cannot grow the map without bound (§10: bounded queues and
//! stores).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

/// Rate-limit configuration with safe defaults (off by default).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RateLimitConfig {
    /// Tokens refilled per second (per bucket).
    pub requests_per_second: u32,
    /// Bucket capacity — the maximum burst of requests allowed before the
    /// limiter starts rejecting.
    pub burst: u32,
    /// Maximum number of tracked buckets. Eviction is LRU-ish
    /// (least-recently-refilled) at this cap.
    pub max_clients: usize,
}

impl Default for RateLimitConfig {
    fn default() -> Self {
        Self {
            requests_per_second: 10,
            burst: 20,
            max_clients: 1024,
        }
    }
}

/// One token bucket.
struct Bucket {
    tokens: f64,
    last_refill: Instant,
}

/// A shared, bounded token-bucket limiter.
pub struct RateLimiter {
    config: RateLimitConfig,
    buckets: Mutex<HashMap<String, Bucket>>,
}

/// The bucket for `key` had no token available: the request is rejected and
/// the caller answers 429 RATE_LIMITED with `Retry-After`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RateLimitRejected;

impl RateLimiter {
    /// A limiter with the given configuration.
    pub fn new(config: RateLimitConfig) -> Self {
        Self {
            config,
            buckets: Mutex::new(HashMap::new()),
        }
    }

    /// Consumes one token from `key`'s bucket. `Ok(())` admits the request;
    /// `Err(RateLimitRejected)` rejects it (the caller answers 429). When
    /// the bucket map is at [`RateLimitConfig::max_clients`] and `key` is
    /// new, the least-recently-refilled bucket is evicted first.
    pub fn allow(&self, key: &str) -> Result<(), RateLimitRejected> {
        let now = Instant::now();
        let mut buckets = self
            .buckets
            .lock()
            .expect("rate limiter mutex poisoned (adapter bug)");

        let bucket = match buckets.get_mut(key) {
            Some(bucket) => bucket,
            None => {
                if buckets.len() >= self.config.max_clients {
                    evict_stale(&mut buckets);
                }
                buckets.insert(
                    key.to_string(),
                    Bucket {
                        tokens: self.config.burst as f64,
                        last_refill: now,
                    },
                );
                buckets.get_mut(key).expect("inserted bucket present")
            }
        };

        let elapsed = now.duration_since(bucket.last_refill).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * self.config.requests_per_second as f64)
            .min(self.config.burst as f64);
        bucket.last_refill = now;

        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            Ok(())
        } else {
            Err(RateLimitRejected)
        }
    }

    /// Number of tracked buckets (for diagnostics/tests).
    pub fn bucket_count(&self) -> usize {
        self.buckets
            .lock()
            .expect("rate limiter mutex poisoned (adapter bug)")
            .len()
    }
}

/// Evicts the least-recently-refilled bucket to make room for a new key.
fn evict_stale(buckets: &mut HashMap<String, Bucket>) {
    let stale = buckets
        .iter()
        .min_by_key(|(_, bucket)| bucket.last_refill)
        .map(|(key, _)| key.clone());
    if let Some(key) = stale {
        buckets.remove(&key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn burst_admits_exactly_burst_tokens() {
        let limiter = RateLimiter::new(RateLimitConfig {
            requests_per_second: 100,
            burst: 3,
            max_clients: 8,
        });
        assert!(limiter.allow("a").is_ok());
        assert!(limiter.allow("a").is_ok());
        assert!(limiter.allow("a").is_ok());
        assert!(limiter.allow("a").is_err(), "burst exhausted");
    }

    #[test]
    fn keys_are_independent() {
        let limiter = RateLimiter::new(RateLimitConfig {
            requests_per_second: 100,
            burst: 1,
            max_clients: 8,
        });
        assert!(limiter.allow("a").is_ok());
        assert!(limiter.allow("b").is_ok());
        assert!(limiter.allow("a").is_err());
    }

    #[test]
    fn bucket_map_is_bounded() {
        let limiter = RateLimiter::new(RateLimitConfig {
            requests_per_second: 1,
            burst: 1,
            max_clients: 2,
        });
        assert!(limiter.allow("a").is_ok());
        assert!(limiter.allow("b").is_ok());
        // c is a new key at the cap — evicts the stale bucket and admits.
        assert!(limiter.allow("c").is_ok());
        assert!(limiter.bucket_count() <= 2, "map bounded at max_clients");
    }

    #[test]
    fn refill_allows_after_wait() {
        let limiter = RateLimiter::new(RateLimitConfig {
            requests_per_second: 100,
            burst: 1,
            max_clients: 8,
        });
        assert!(limiter.allow("a").is_ok());
        assert!(limiter.allow("a").is_err());
        std::thread::sleep(std::time::Duration::from_millis(30));
        assert!(limiter.allow("a").is_ok(), "bucket refilled");
    }
}
