//! Process-tree memory containment for heavy local workloads (plan rev 2.2
//! Layer A).
//!
//! Windows-only native runner: launches the workload root process
//! SUSPENDED, assigns it to a fresh Job Object, then resumes it — so ALL
//! memory the tree allocates counts against the job's limits:
//!
//! ```text
//! CreateProcessW(CREATE_SUSPENDED)
//!   → AssignProcessToJobObject
//!   → ResumeThread
//! ```
//!
//! (memory allocated before a process joins a job does not count toward its
//! limits; children inherit the job because no BREAKAWAY flags are set).
//!
//! Two-threshold memory control:
//! - soft: `JobObjectNotificationLimitInformation` (guaranteed message
//!   `JOB_OBJECT_MSG_NOTIFICATION_LIMIT`) at ~90% of the cap →
//!   `TerminateJobObject` → exit `RESOURCE_LIMIT`;
//! - hard: `JOB_OBJECT_LIMIT_JOB_MEMORY` at 100% of the cap — Windows
//!   blocks further commit even if the runner is dead.
//!
//! Host headroom: before launching, `GetPerformanceInfo` computes
//! system-wide `available_commit = (CommitLimit − CommitTotal) × PageSize`;
//! the effective cap is `min(configured, available − HOST_RESERVE)`; when it
//! falls below `--min-cap`, the runner REFUSES (`SKIPPED`) instead of
//! stressing an already-tight host.
//!
//! Scheduler: an optional named mutex (`--lock`) serializes heavy commands
//! host-wide; the OS releases the mutex automatically when the owner dies,
//! so stale locks cannot exist.
//!
//! stdout/stderr of the workload are INHERITED (never buffered unbounded).
//! Wall-clock deadline is the runner's own timer → `TerminateJobObject`.
//!
//! Exit codes: 0 = success; child's own code = workload failed normally;
//! 2 = runner error (incl. failed job assignment — refuse, never run
//! uncontained); 3 = SKIPPED insufficient host memory; 4 = RESOURCE_LIMIT;
//! 5 = BUSY (scheduler lock timeout); 6 = TIMEOUT.
//!
//! Usage:
//! ```text
//! resource-runner [--cap <MiB>] [--soft <ratio>] [--min-cap <MiB>]
//!                 [--deadline <secs>] [--lock <name>] [--lock-wait <secs>]
//!                 [--cwd <dir>] --cmd <token> [<token> ...]
//! ```
//! `--cmd` consumes the value AND every remaining argv token as the command
//! (the wrapper always puts it last). Tokens keep their boundaries through
//! the argv hop; the runner joins them and wraps the whole command as one
//! quoted `/c` argument for `cmd.exe` — empirically the only pattern that
//! runs both plain executables and `.cmd` shims (`pnpm.cmd` etc.).

#![cfg(windows)]

use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;
use std::ptr;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE, WAIT_ABANDONED, WAIT_FAILED,
    WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectAssociateCompletionPortInformation,
    JobObjectExtendedLimitInformation, JobObjectNotificationLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_ASSOCIATE_COMPLETION_PORT,
    JOBOBJECT_BASIC_LIMIT_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOBOBJECT_NOTIFICATION_LIMIT_INFORMATION, JOB_OBJECT_LIMIT, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
    JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::ProcessStatus::{GetPerformanceInfo, PERFORMANCE_INFORMATION};
use windows_sys::Win32::System::Threading::{
    CreateMutexW, CreateProcessW, GetExitCodeProcess, ReleaseMutex, ResumeThread, TerminateProcess,
    WaitForSingleObject, CREATE_SUSPENDED, PROCESS_INFORMATION, STARTUPINFOW,
};
use windows_sys::Win32::System::IO::{
    CreateIoCompletionPort, GetQueuedCompletionStatus, OVERLAPPED,
};

/// Host reserve: the host must keep at least this much commit headroom.
const HOST_RESERVE_BYTES: u64 = 4 * 1024 * 1024 * 1024; // 4 GiB
/// Minimum host reserve ratio of the total commit limit.
const HOST_RESERVE_RATIO: f64 = 0.25;
/// Default hard job memory cap (MiB).
const DEFAULT_CAP_MIB: u64 = 4096;
/// Default soft notification ratio of the cap.
const DEFAULT_SOFT_RATIO: f64 = 0.9;
/// Default wall-clock deadline (seconds).
const DEFAULT_DEADLINE_SECS: u64 = 600;
/// Default scheduler lock wait (seconds).
const DEFAULT_LOCK_WAIT_SECS: u64 = 600;

// JOB_OBJECT_MSG_* completion values (WinNT.h, stable kernel-defined values).
const JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO: usize = 4;
const JOB_OBJECT_MSG_JOB_MEMORY_LIMIT: usize = 10;
const JOB_OBJECT_MSG_NOTIFICATION_LIMIT: usize = 12;

const EXIT_OK: i32 = 0;
const EXIT_RUNNER_ERROR: i32 = 2;
const EXIT_SKIPPED: i32 = 3;
const EXIT_RESOURCE_LIMIT: i32 = 4;
const EXIT_BUSY: i32 = 5;
const EXIT_TIMEOUT: i32 = 6;

#[derive(Debug)]
struct Options {
    cap_bytes: u64,
    soft_bytes: u64,
    min_cap_bytes: u64,
    deadline: Duration,
    lock_name: Option<String>,
    lock_wait: Duration,
    cwd: Option<PathBuf>,
    cmd_parts: Vec<String>,
}

fn parse_options(args: &[String]) -> Result<Options, String> {
    let mut cap_mib = DEFAULT_CAP_MIB;
    let mut soft_ratio = DEFAULT_SOFT_RATIO;
    let mut min_cap_mib = 0u64;
    let mut deadline_secs = DEFAULT_DEADLINE_SECS;
    let mut lock_name: Option<String> = None;
    let mut lock_wait_secs = DEFAULT_LOCK_WAIT_SECS;
    let mut cwd: Option<PathBuf> = None;
    let mut cmd: Option<String> = None;
    let mut cmd_tail: Vec<String> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        let take = |i: &mut usize, what: &str| -> Result<String, String> {
            *i += 1;
            args.get(*i)
                .cloned()
                .ok_or_else(|| format!("{what} requires a value"))
        };
        match a.as_str() {
            "--cap" => {
                cap_mib = take(&mut i, "--cap")?.parse().map_err(|_| "bad --cap")?;
            }
            "--soft" => {
                soft_ratio = take(&mut i, "--soft")?.parse().map_err(|_| "bad --soft")?;
            }
            "--min-cap" => {
                min_cap_mib = take(&mut i, "--min-cap")?
                    .parse()
                    .map_err(|_| "bad --min-cap")?;
            }
            "--deadline" => {
                deadline_secs = take(&mut i, "--deadline")?
                    .parse()
                    .map_err(|_| "bad --deadline")?;
            }
            "--lock" => lock_name = Some(take(&mut i, "--lock")?),
            "--lock-wait" => {
                lock_wait_secs = take(&mut i, "--lock-wait")?
                    .parse()
                    .map_err(|_| "bad --lock-wait")?;
            }
            "--cwd" => cwd = Some(PathBuf::from(take(&mut i, "--cwd")?)),
            // --cmd consumes the value AND every remaining token: argv
            // boundaries survive CreateProcessW/msvcrt quoting, so the runner
            // can quote each token itself for the cmd /c wrap.
            "--cmd" => {
                cmd = Some(take(&mut i, "--cmd")?);
                cmd_tail = args[i + 1..].to_vec();
                i = args.len();
                continue;
            }
            other => return Err(format!("unknown option {other}")),
        }
        i += 1;
    }
    let first = cmd.ok_or_else(|| "missing --cmd".to_string())?;
    let mut cmd_parts = Vec::with_capacity(1 + cmd_tail.len());
    cmd_parts.push(first);
    cmd_parts.extend(cmd_tail);
    if !(0.0..=1.0).contains(&soft_ratio) {
        return Err("--soft must be in (0, 1]".to_string());
    }
    Ok(Options {
        cap_bytes: cap_mib * 1024 * 1024,
        soft_bytes: (cap_mib as f64 * soft_ratio) as u64 * 1024 * 1024,
        min_cap_bytes: min_cap_mib * 1024 * 1024,
        deadline: Duration::from_secs(deadline_secs),
        lock_name,
        lock_wait: Duration::from_secs(lock_wait_secs),
        cwd,
        cmd_parts,
    })
}

/// System-wide commit headroom via `GetPerformanceInfo` (plan rev 2.2 §1.2 —
/// NOT `GlobalMemoryStatusEx`, whose available-page-file is per-process).
fn commit_headroom() -> Result<(u64, u64), String> {
    let mut info: PERFORMANCE_INFORMATION = unsafe { std::mem::zeroed() };
    let ok = unsafe {
        GetPerformanceInfo(
            &mut info,
            std::mem::size_of::<PERFORMANCE_INFORMATION>() as u32,
        )
    };
    if ok == 0 {
        return Err(format!("GetPerformanceInfo failed: {}", unsafe {
            GetLastError()
        }));
    }
    let page = info.PageSize as u64;
    let commit_limit = info.CommitLimit as u64 * page;
    let commit_total = info.CommitTotal as u64 * page;
    let physical_available = info.PhysicalAvailable as u64 * page;
    let available_commit = commit_limit.saturating_sub(commit_total);
    Ok((available_commit, physical_available))
}

/// Host-headroom gate: effective cap = min(configured, available − reserve).
/// Returns `None` (refuse) when the effective cap is below the suite minimum.
fn effective_cap(configured: u64, min_required: u64) -> Result<u64, String> {
    let (available_commit, physical_available) = commit_headroom()?;
    let commit_limit_estimate = available_commit + configured; // upper bound of the limit we may claim
    let reserve =
        HOST_RESERVE_BYTES.max((commit_limit_estimate as f64 * HOST_RESERVE_RATIO) as u64);
    let effective = configured.min(available_commit.saturating_sub(reserve));
    if effective < min_required {
        return Err(format!(
            "SKIPPED: effective job cap {effective} B < required {min_required} B \
             (available commit {available_commit} B, physical available {physical_available} B)"
        ));
    }
    Ok(effective)
}

struct Job {
    handle: HANDLE,
}

impl Job {
    fn create(cap_bytes: u64, soft_bytes: u64) -> Result<Job, String> {
        let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if handle.is_null() {
            return Err(format!("CreateJobObjectW failed: {}", unsafe {
                GetLastError()
            }));
        }
        let extended = JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
            BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION {
                LimitFlags: (JOB_OBJECT_LIMIT_JOB_MEMORY
                    | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                    | JOB_OBJECT_LIMIT_ACTIVE_PROCESS)
                    as JOB_OBJECT_LIMIT,
                ActiveProcessLimit: 64,
                ..unsafe { std::mem::zeroed() }
            },
            JobMemoryLimit: cap_bytes as usize,
            ..unsafe { std::mem::zeroed() }
        };
        let ok = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &extended as *const _ as *const c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            unsafe { CloseHandle(handle) };
            return Err(format!(
                "SetInformationJobObject(extended) failed: {}",
                unsafe { GetLastError() }
            ));
        }
        // Soft notification limit: guaranteed JOB_OBJECT_MSG_NOTIFICATION_LIMIT.
        // The base JOBOBJECT_NOTIFICATION_LIMIT_INFORMATION arms its
        // JobMemoryLimit with JOB_OBJECT_LIMIT_JOB_MEMORY; the *_LOW flag
        // belongs to the Win10-1709+ _2 struct and is rejected (87).
        let notification = JOBOBJECT_NOTIFICATION_LIMIT_INFORMATION {
            JobMemoryLimit: soft_bytes,
            LimitFlags: JOB_OBJECT_LIMIT_JOB_MEMORY as JOB_OBJECT_LIMIT,
            ..unsafe { std::mem::zeroed() }
        };
        let ok = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectNotificationLimitInformation,
                &notification as *const _ as *const c_void,
                std::mem::size_of::<JOBOBJECT_NOTIFICATION_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            unsafe { CloseHandle(handle) };
            return Err(format!(
                "SetInformationJobObject(notification) failed: {}",
                unsafe { GetLastError() }
            ));
        }
        Ok(Job { handle })
    }

    fn assign(&self, process: HANDLE) -> Result<(), String> {
        let ok = unsafe { AssignProcessToJobObject(self.handle, process) };
        if ok == 0 {
            // Nested-job / incompatible hierarchy: REFUSE, never run uncontained.
            return Err(format!("AssignProcessToJobObject failed: {}", unsafe {
                GetLastError()
            }));
        }
        Ok(())
    }

    fn terminate(&self) {
        unsafe { TerminateJobObject(self.handle, EXIT_RESOURCE_LIMIT as u32) };
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        // KILL_ON_JOB_CLOSE also fires here as a safety net.
        unsafe { CloseHandle(self.handle) };
    }
}

/// Associates a completion port so memory-limit violations can kill the job
/// deterministically. Returns the port handle.
fn associate_completion_port(job: &Job) -> Result<HANDLE, String> {
    let port = unsafe { CreateIoCompletionPort(INVALID_HANDLE_VALUE, ptr::null_mut(), 0, 1) };
    if port.is_null() {
        return Err(format!("CreateIoCompletionPort failed: {}", unsafe {
            GetLastError()
        }));
    }
    let assoc = JOBOBJECT_ASSOCIATE_COMPLETION_PORT {
        CompletionKey: ptr::null_mut(),
        CompletionPort: port,
    };
    let ok = unsafe {
        SetInformationJobObject(
            job.handle,
            JobObjectAssociateCompletionPortInformation,
            &assoc as *const _ as *const c_void,
            std::mem::size_of::<JOBOBJECT_ASSOCIATE_COMPLETION_PORT>() as u32,
        )
    };
    if ok == 0 {
        unsafe { CloseHandle(port) };
        return Err(format!("associate completion port failed: {}", unsafe {
            GetLastError()
        }));
    }
    Ok(port)
}

/// Named-mutex scheduler lock (OS releases it automatically when the owner
/// dies — no stale locks).
struct SchedulerLock {
    handle: HANDLE,
}

impl SchedulerLock {
    fn acquire(name: &str, wait: Duration) -> Result<SchedulerLock, i32> {
        let wide: Vec<u16> = std::ffi::OsStr::new(name)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let handle = unsafe { CreateMutexW(ptr::null(), 0, wide.as_ptr()) };
        if handle.is_null() {
            return Err(EXIT_RUNNER_ERROR);
        }
        let wait_ms = wait.as_millis().min(u32::MAX as u128) as u32;
        let status = unsafe { WaitForSingleObject(handle, wait_ms) };
        match status {
            WAIT_OBJECT_0 | WAIT_ABANDONED => Ok(SchedulerLock { handle }),
            WAIT_TIMEOUT => Err(EXIT_BUSY),
            _ => Err(EXIT_RUNNER_ERROR),
        }
    }
}

impl Drop for SchedulerLock {
    fn drop(&mut self) {
        unsafe { ReleaseMutex(self.handle) };
        unsafe { CloseHandle(self.handle) };
    }
}

fn wide(s: &str) -> Vec<u16> {
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn run_contained(opts: &Options) -> i32 {
    // 1. Host-headroom gate BEFORE launching anything.
    let cap_bytes = match effective_cap(opts.cap_bytes, opts.min_cap_bytes) {
        Ok(cap) => cap,
        Err(reason) => {
            eprintln!("resource-runner: {reason}");
            return EXIT_SKIPPED;
        }
    };
    let soft_bytes = cap_bytes.min(opts.soft_bytes);

    // 2. Scheduler lock (optional).
    let _lock = match &opts.lock_name {
        Some(name) => match SchedulerLock::acquire(name, opts.lock_wait) {
            Ok(lock) => Some(lock),
            Err(code) => {
                eprintln!("resource-runner: scheduler lock busy ({name})");
                return code;
            }
        },
        None => None,
    };

    // 3. Job + completion port.
    let job = match Job::create(cap_bytes, soft_bytes) {
        Ok(job) => job,
        Err(reason) => {
            eprintln!("resource-runner: {reason}");
            return EXIT_RUNNER_ERROR;
        }
    };
    let port = match associate_completion_port(&job) {
        Ok(port) => port,
        Err(reason) => {
            eprintln!("resource-runner: {reason}");
            return EXIT_RUNNER_ERROR;
        }
    };

    // 4. Launch SUSPENDED, assign, then resume. CreateProcessW cannot run
    // .cmd/.bat directly, so batch commands are wrapped via cmd /c with the
    // WHOLE command in one quoted /c argument (`cmd /d /s /c "<cmd>"`) —
    // empirically the only pattern that survives CreateProcessW for both
    // plain executables and .cmd shims (pnpm.cmd etc.); per-token quoting
    // inside /c breaks cmd's /S parsing. Commands that embed their own
    // double quotes are out of scope for the wrapper.
    let joined = opts.cmd_parts.join(" ");
    let wrapped = format!("cmd.exe /d /s /c \"{joined}\"");
    let mut cmdline = wide(&wrapped);
    let mut si: STARTUPINFOW = unsafe { std::mem::zeroed() };
    si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let cwd_wide = opts.cwd.as_ref().map(|p| wide(&p.to_string_lossy()));
    let cwd_ptr = cwd_wide.as_ref().map(|v| v.as_ptr()).unwrap_or(ptr::null());
    let ok = unsafe {
        CreateProcessW(
            ptr::null(),
            cmdline.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            1, // bInheritHandles: child inherits stdout/stderr (streaming)
            CREATE_SUSPENDED,
            ptr::null(),
            cwd_ptr,
            &si,
            &mut pi,
        )
    };
    if ok == 0 {
        eprintln!(
            "resource-runner: CreateProcessW failed: {} (cmd: {})",
            unsafe { GetLastError() },
            opts.cmd_parts.join(" ")
        );
        return EXIT_RUNNER_ERROR;
    }

    // 5. Assign BEFORE the child can allocate anything that must count.
    if let Err(reason) = job.assign(pi.hProcess) {
        unsafe { TerminateProcess(pi.hProcess, 2) };
        unsafe { CloseHandle(pi.hThread) };
        unsafe { CloseHandle(pi.hProcess) };
        eprintln!("resource-runner: {reason}");
        return EXIT_RUNNER_ERROR;
    }
    unsafe { ResumeThread(pi.hThread) };
    unsafe { CloseHandle(pi.hThread) };

    // 6. Watch the completion port + the process handle + the deadline.
    let deadline = Instant::now() + opts.deadline;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            eprintln!("resource-runner: wall-clock deadline exceeded; terminating job");
            job.terminate();
            unsafe { CloseHandle(pi.hProcess) };
            unsafe { CloseHandle(port) };
            return EXIT_TIMEOUT;
        }
        let wait_ms = remaining.as_millis().min(u32::MAX as u128) as u32;
        let status = unsafe { WaitForSingleObject(pi.hProcess, wait_ms) };
        match status {
            WAIT_OBJECT_0 => {
                // Root process exited. Terminate the job so any surviving
                // descendants die with it, then take the exit code.
                let mut code: u32 = 0;
                unsafe { GetExitCodeProcess(pi.hProcess, &mut code) };
                job.terminate();
                unsafe { CloseHandle(pi.hProcess) };
                unsafe { CloseHandle(port) };
                return code as i32;
            }
            WAIT_TIMEOUT => {
                // Drain memory-limit notifications without blocking.
                let mut key: usize = 0;
                let mut bytes: u32 = 0;
                let mut overlapped: *mut OVERLAPPED = ptr::null_mut();
                while unsafe {
                    GetQueuedCompletionStatus(port, &mut bytes, &mut key, &mut overlapped, 0)
                } != 0
                {
                    match key {
                        JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO => {
                            unsafe { CloseHandle(pi.hProcess) };
                            unsafe { CloseHandle(port) };
                            return EXIT_OK;
                        }
                        JOB_OBJECT_MSG_NOTIFICATION_LIMIT | JOB_OBJECT_MSG_JOB_MEMORY_LIMIT => {
                            eprintln!(
                                "resource-runner: job memory limit ({cap_bytes} B) violated; terminating job"
                            );
                            job.terminate();
                            unsafe { CloseHandle(pi.hProcess) };
                            unsafe { CloseHandle(port) };
                            return EXIT_RESOURCE_LIMIT;
                        }
                        _ => {} // other job messages are informational
                    }
                }
            }
            WAIT_FAILED => {
                eprintln!("resource-runner: WaitForSingleObject failed: {}", unsafe {
                    GetLastError()
                });
                job.terminate();
                unsafe { CloseHandle(pi.hProcess) };
                unsafe { CloseHandle(port) };
                return EXIT_RUNNER_ERROR;
            }
            _ => {}
        }
    }
}

/// Fail-safe policy (plan rev 2.2 §1.4 — no accidental uncontained run):
/// a workload may run only when the caller explicitly enabled containment.
/// Parameterized over the env value so the guard is unit-testable in ANY
/// environment (inside the runner the variable IS present, so an
/// env-dependent assertion would be inverted).
fn fail_safe_mode_ok(mode: Option<&str>) -> Result<(), String> {
    if mode == Some("contained") {
        Ok(())
    } else {
        Err("RESOURCE_BUDGET_MODE=contained is required (fail-safe direct-run guard)".to_string())
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let opts = match parse_options(&args) {
        Ok(opts) => opts,
        Err(reason) => {
            eprintln!("resource-runner: {reason}");
            std::process::exit(EXIT_RUNNER_ERROR);
        }
    };
    if let Err(reason) = fail_safe_mode_ok(std::env::var("RESOURCE_BUDGET_MODE").ok().as_deref()) {
        eprintln!("resource-runner: {reason}");
        std::process::exit(EXIT_RUNNER_ERROR);
    }
    std::process::exit(run_contained(&opts));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[allow(dead_code)]
    fn opts(cmd: &str) -> Options {
        Options {
            cap_bytes: 4096 * 1024 * 1024,
            soft_bytes: 3686 * 1024 * 1024,
            min_cap_bytes: 512 * 1024 * 1024,
            deadline: Duration::from_secs(60),
            lock_name: None,
            lock_wait: Duration::from_secs(60),
            cwd: None,
            cmd_parts: vec![cmd.to_string()],
        }
    }

    #[test]
    fn parse_full_command_line() {
        let args = [
            "--cap".to_string(),
            "2048".to_string(),
            "--soft".to_string(),
            "0.9".to_string(),
            "--min-cap".to_string(),
            "512".to_string(),
            "--deadline".to_string(),
            "30".to_string(),
            "--cmd".to_string(),
            "node".to_string(),
            "scripts/run.mjs".to_string(),
            "--flag".to_string(),
            "value".to_string(),
        ];
        let o = parse_options(&args).expect("parses");
        assert_eq!(o.cap_bytes, 2048 * 1024 * 1024);
        assert_eq!(o.soft_bytes, 1843 * 1024 * 1024);
        assert_eq!(o.deadline, Duration::from_secs(30));
        assert_eq!(o.cmd_parts, ["node", "scripts/run.mjs", "--flag", "value"]);
    }

    #[test]
    fn parse_rejects_missing_cmd() {
        assert!(parse_options(&["--cap".to_string(), "1".to_string()]).is_err());
    }

    #[test]
    fn soft_ratio_bounds() {
        let args = [
            "--soft".to_string(),
            "1.5".to_string(),
            "--cmd".to_string(),
            "true".to_string(),
        ];
        assert!(parse_options(&args).is_err());
    }

    #[test]
    fn fail_safe_requires_contained_mode() {
        // Deterministic policy check, independent of the surrounding
        // environment (the test binary itself may run inside the runner,
        // where RESOURCE_BUDGET_MODE IS set).
        assert!(fail_safe_mode_ok(Some("contained")).is_ok());
        assert!(fail_safe_mode_ok(None).is_err());
        assert!(fail_safe_mode_ok(Some("CI")).is_err());
        assert!(fail_safe_mode_ok(Some("")).is_err());
    }
}
