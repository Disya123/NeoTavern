//! Plugin supervisor policy (ADR-0066 D7).
//!
//! This module is deliberately **pure**: it decides what the host should do with a
//! plugin process, and never starts or kills anything itself. The host owns
//! `std::process::Child`; the policy owns the rules, so the rules are testable
//! without spawning a process, a GPU or a model.
//!
//! What the policy answers:
//!
//! - is this plugin allowed to run right now, or is it in backoff?
//! - the process died — was that a crash, a clean exit, or a hang?
//! - how many restarts are left, and when is the next one?
//! - when does the host stop trying and mark the plugin failed?
//!
//! Isolation is a property of the host (one OS process per native plugin, resource
//! budgets, kill on lease loss). This module makes the *decisions* predictable: a
//! plugin that crashes five times in a row is not restarted a sixth time, and a
//! plugin that hangs is reaped rather than waited on forever.

use std::time::Duration;

/// Why the supervisor is looking at the plugin right now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExitKind {
    /// Process exited with status 0 on its own.
    Clean,
    /// Process exited with a non-zero status or was killed by a signal.
    Crash,
    /// No heartbeat within the deadline; the host will kill it.
    Hang,
}

/// Observed lifecycle state of one plugin process.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SupervisorState {
    /// Never started, or stopped on request.
    Stopped,
    /// Starting or running; heartbeats are expected.
    Running,
    /// Waiting for the next attempt; `attempts` restarts already happened.
    Backoff,
    /// Out of restarts. The plugin stays installed but does not run.
    Failed,
}

/// Restart policy for one plugin.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SupervisorPolicy {
    /// Restarts allowed after the first start.
    pub max_restarts: u32,
    /// First backoff delay; doubles per attempt.
    pub base_delay: Duration,
    /// Ceiling for the backoff delay.
    pub max_delay: Duration,
    /// How long a plugin may go without a heartbeat before it counts as hung.
    pub heartbeat_timeout: Duration,
}

impl Default for SupervisorPolicy {
    fn default() -> Self {
        Self {
            max_restarts: 5,
            base_delay: Duration::from_millis(500),
            max_delay: Duration::from_secs(30),
            heartbeat_timeout: Duration::from_secs(30),
        }
    }
}

/// Supervisor bookkeeping for one plugin.
#[derive(Clone, Debug)]
pub struct Supervisor {
    policy: SupervisorPolicy,
    state: SupervisorState,
    restarts: u32,
    /// Reason recorded for the last failure, surfaced to the UI verbatim.
    last_error: Option<String>,
    /// Consecutive crashes without a healthy run in between. Reset by
    /// [`Supervisor::mark_healthy`], so a plugin that crashes once a day is not
    /// treated like one that crashes in a loop.
    crash_streak: u32,
}

impl Supervisor {
    pub fn new(policy: SupervisorPolicy) -> Self {
        Self {
            policy,
            state: SupervisorState::Stopped,
            restarts: 0,
            last_error: None,
            crash_streak: 0,
        }
    }

    pub fn with_defaults() -> Self {
        Self::new(SupervisorPolicy::default())
    }

    /// Current state, for the UI and for the host loop.
    pub fn state(&self) -> SupervisorState {
        self.state
    }

    /// Restarts consumed so far.
    pub fn restarts(&self) -> u32 {
        self.restarts
    }

    /// Last failure reason, if any.
    pub fn last_error(&self) -> Option<&str> {
        self.last_error.as_deref()
    }

    /// Marks the plugin as starting/running.
    pub fn start(&mut self) {
        self.state = SupervisorState::Running;
    }

    /// Records a healthy heartbeat: the crash streak is over.
    pub fn mark_healthy(&mut self) {
        if self.state == SupervisorState::Running {
            self.crash_streak = 0;
        }
    }

    /// Whether a heartbeat is overdue at `since_last_heartbeat`.
    pub fn is_hung(&self, since_last_heartbeat: Duration) -> bool {
        self.state == SupervisorState::Running
            && since_last_heartbeat > self.policy.heartbeat_timeout
    }

    /// Applies an exit and decides what happens next.
    ///
    /// Returns the delay before the next start, or `None` when the host should not
    /// start the plugin again. A clean exit is a normal stop — no restart, no error.
    pub fn on_exit(&mut self, kind: ExitKind, detail: Option<String>) -> Option<Duration> {
        match kind {
            ExitKind::Clean => {
                self.state = SupervisorState::Stopped;
                self.crash_streak = 0;
                None
            }
            ExitKind::Crash | ExitKind::Hang => {
                self.crash_streak += 1;
                self.restarts += 1;
                self.last_error = Some(match (kind, detail) {
                    (ExitKind::Hang, _) => format!(
                        "plugin stopped responding for {}s",
                        self.policy.heartbeat_timeout.as_secs()
                    ),
                    (_, Some(detail)) => detail,
                    (_, None) => "plugin process exited unexpectedly".to_string(),
                });
                if self.restarts > self.policy.max_restarts {
                    self.state = SupervisorState::Failed;
                    return None;
                }
                self.state = SupervisorState::Backoff;
                Some(self.backoff_delay())
            }
        }
    }

    /// Exponential backoff, clamped, based on how many restarts were consumed.
    pub fn backoff_delay(&self) -> Duration {
        let exponent = self.restarts.saturating_sub(1).min(16);
        let factor = 1u32 << exponent;
        let delay = self.policy.base_delay.saturating_mul(factor);
        delay.min(self.policy.max_delay)
    }

    /// Operator-initiated stop. Keeps the error history, forgets the backoff.
    pub fn stop(&mut self) {
        self.state = SupervisorState::Stopped;
    }

    /// Operator-initiated reset: clears failures and allows restarts again.
    pub fn reset(&mut self) {
        self.state = SupervisorState::Stopped;
        self.restarts = 0;
        self.crash_streak = 0;
        self.last_error = None;
    }

    /// How many restarts remain before the plugin is marked failed.
    pub fn restarts_left(&self) -> u32 {
        self.policy.max_restarts.saturating_sub(self.restarts) + u32::from(self.restarts == 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> SupervisorPolicy {
        SupervisorPolicy {
            max_restarts: 3,
            base_delay: Duration::from_millis(100),
            max_delay: Duration::from_millis(1000),
            heartbeat_timeout: Duration::from_secs(5),
        }
    }

    #[test]
    fn a_clean_exit_is_a_stop_not_a_failure() {
        let mut supervisor = Supervisor::new(policy());
        supervisor.start();
        assert_eq!(supervisor.on_exit(ExitKind::Clean, None), None);
        assert_eq!(supervisor.state(), SupervisorState::Stopped);
        assert_eq!(supervisor.restarts(), 0);
        assert!(supervisor.last_error().is_none());
    }

    #[test]
    fn crashes_back_off_exponentially_up_to_the_cap() {
        let mut supervisor = Supervisor::new(policy());
        supervisor.start();
        assert_eq!(
            supervisor.on_exit(ExitKind::Crash, Some("segfault".into())),
            Some(Duration::from_millis(100))
        );
        supervisor.start();
        assert_eq!(
            supervisor.on_exit(ExitKind::Crash, None),
            Some(Duration::from_millis(200))
        );
        supervisor.start();
        assert_eq!(
            supervisor.on_exit(ExitKind::Crash, None),
            Some(Duration::from_millis(400))
        );
        assert_eq!(supervisor.state(), SupervisorState::Backoff);
        assert_eq!(
            supervisor.last_error(),
            Some("plugin process exited unexpectedly")
        );
    }

    #[test]
    fn the_plugin_fails_after_the_restart_budget() {
        let mut supervisor = Supervisor::new(policy());
        for _ in 0..3 {
            supervisor.start();
            assert!(supervisor.on_exit(ExitKind::Crash, None).is_some());
        }
        supervisor.start();
        assert_eq!(supervisor.on_exit(ExitKind::Crash, None), None);
        assert_eq!(supervisor.state(), SupervisorState::Failed);
        assert_eq!(supervisor.restarts(), 4);
    }

    #[test]
    fn a_hang_is_named_and_reaped_like_a_crash() {
        let mut supervisor = Supervisor::new(policy());
        supervisor.start();
        let delay = supervisor
            .on_exit(ExitKind::Hang, None)
            .expect("one restart");
        assert!(delay > Duration::ZERO);
        assert_eq!(
            supervisor.last_error(),
            Some("plugin stopped responding for 5s")
        );
        assert_eq!(supervisor.state(), SupervisorState::Backoff);
    }

    #[test]
    fn heartbeats_reset_the_crash_streak_but_not_the_restart_count() {
        let mut supervisor = Supervisor::new(policy());
        supervisor.start();
        supervisor.on_exit(ExitKind::Crash, None);
        supervisor.start();
        supervisor.mark_healthy();
        assert_eq!(supervisor.restarts(), 1);
        assert_eq!(supervisor.state(), SupervisorState::Running);
    }

    #[test]
    fn a_silent_running_plugin_is_hung_only_after_the_timeout() {
        let mut supervisor = Supervisor::new(policy());
        supervisor.start();
        assert!(!supervisor.is_hung(Duration::from_secs(4)));
        assert!(supervisor.is_hung(Duration::from_secs(6)));
        supervisor.stop();
        assert!(!supervisor.is_hung(Duration::from_secs(60)));
    }

    #[test]
    fn reset_clears_failure_state_for_an_operator_retry() {
        let mut supervisor = Supervisor::new(policy());
        for _ in 0..4 {
            supervisor.start();
            supervisor.on_exit(ExitKind::Crash, Some("boom".into()));
        }
        assert_eq!(supervisor.state(), SupervisorState::Failed);
        supervisor.reset();
        assert_eq!(supervisor.state(), SupervisorState::Stopped);
        assert_eq!(supervisor.restarts(), 0);
        assert!(supervisor.last_error().is_none());
    }
}

/// The host half: run one plugin process under the policy above.
///
/// Isolation is the OS process boundary — the kernel never loads plugin code. This
/// function only *supervises*: it spawns, waits, kills on timeout and classifies the
/// outcome. Resource budgets (memory, GPU) belong to the platform layer and are not
/// pretended here.
pub struct ProcessOutcome {
    pub kind: ExitKind,
    pub detail: Option<String>,
    /// Wall time the process lived, for the UI and for backoff decisions.
    pub elapsed: Duration,
}

/// Spawns `command`, waits up to `timeout`, then kills it and reports a hang.
///
/// A non-zero exit is a crash with its code in `detail`; a zero exit is clean. The
/// child is always waited for, so a killed process never becomes a zombie.
pub fn run_guarded(
    command: &mut std::process::Command,
    timeout: Duration,
) -> std::io::Result<ProcessOutcome> {
    let started = std::time::Instant::now();
    let mut child = command.spawn()?;
    loop {
        match child.try_wait()? {
            Some(status) => {
                let elapsed = started.elapsed();
                return Ok(if status.success() {
                    ProcessOutcome {
                        kind: ExitKind::Clean,
                        detail: None,
                        elapsed,
                    }
                } else {
                    ProcessOutcome {
                        kind: ExitKind::Crash,
                        detail: Some(match status.code() {
                            Some(code) => format!("plugin process exited with code {code}"),
                            None => "plugin process was terminated".to_string(),
                        }),
                        elapsed,
                    }
                });
            }
            None => {
                if started.elapsed() >= timeout {
                    let _ = child.kill();
                    // Reap it: leaving a zombie behind is not a hang, it is a leak.
                    let _ = child.wait();
                    return Ok(ProcessOutcome {
                        kind: ExitKind::Hang,
                        detail: None,
                        elapsed: started.elapsed(),
                    });
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        }
    }
}

#[cfg(test)]
mod process_tests {
    use super::*;

    fn shell(script: &str) -> std::process::Command {
        #[cfg(windows)]
        {
            let mut command = std::process::Command::new("cmd");
            command.args(["/C", script]);
            command
        }
        #[cfg(not(windows))]
        {
            let mut command = std::process::Command::new("sh");
            command.args(["-c", script]);
            command
        }
    }

    #[test]
    fn a_zero_exit_is_clean() {
        let outcome = run_guarded(&mut shell("exit 0"), Duration::from_secs(10)).expect("spawn");
        assert_eq!(outcome.kind, ExitKind::Clean);
        assert!(outcome.detail.is_none());
    }

    #[test]
    fn a_non_zero_exit_names_the_code() {
        let outcome = run_guarded(&mut shell("exit 7"), Duration::from_secs(10)).expect("spawn");
        assert_eq!(outcome.kind, ExitKind::Crash);
        assert!(
            outcome.detail.as_deref().unwrap_or_default().contains('7'),
            "the exit code must reach the user: {:?}",
            outcome.detail
        );
    }

    #[test]
    fn a_silent_process_is_killed_and_reported_as_a_hang() {
        #[cfg(windows)]
        let mut command = shell("ping -n 30 127.0.0.1 >NUL");
        #[cfg(not(windows))]
        let mut command = shell("sleep 30");
        let outcome = run_guarded(&mut command, Duration::from_millis(300)).expect("spawn");
        assert_eq!(outcome.kind, ExitKind::Hang);
        assert!(
            outcome.elapsed < Duration::from_secs(10),
            "the kill must be prompt"
        );
    }
}
