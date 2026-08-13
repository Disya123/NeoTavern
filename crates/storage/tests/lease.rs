//! Integration tests for the exclusive data-root lease
//! (`neotavern_storage::lease`).
//!
//! This file uses a custom `fn main` instead of the libtest harness (declared
//! with `harness = false` in Cargo.toml) because the binary doubles as a child
//! process for the crash test: when the environment variable
//! `STORAGE_LEASE_HOLDER` is set, the binary acquires the lease on that root,
//! prints `locked`, flushes, and sleeps; the parent test kills it and verifies
//! that the operating system released the lock. Otherwise the binary runs the
//! test functions below directly and reports PASS/FAIL, exiting non-zero on
//! failure.

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::time::Duration;

use neotavern_storage::lease::{probe_lock, DataRootLease};
use neotavern_storage::StorageErrorCode;

type TestResult = Result<(), Box<dyn std::error::Error>>;

type TestFn = fn() -> TestResult;

fn main() {
    if std::env::var("STORAGE_LEASE_HOLDER").is_ok() {
        child_lease_holder();
        // Only reached if the 60s sleep completes without the parent killing us.
        std::process::exit(0);
    }
    let tests: &[(&str, TestFn)] = &[
        ("lease_acquire_and_probe", test_lease_acquire_and_probe),
        (
            "lease_second_acquire_blocked",
            test_lease_second_acquire_blocked,
        ),
        ("lease_release_reacquire", test_lease_release_reacquire),
        ("lease_child_kill_releases", test_lease_child_kill_releases),
    ];
    let mut failures = 0usize;
    for (name, test) in tests {
        match std::panic::catch_unwind(*test) {
            Ok(Ok(())) => println!("PASS {name}"),
            Ok(Err(e)) => {
                println!("FAIL {name}: {e}");
                failures += 1;
            }
            Err(_) => {
                println!("FAIL {name}: panicked");
                failures += 1;
            }
        }
    }
    if failures == 0 {
        println!("ALL TESTS PASSED");
        std::process::exit(0);
    }
    println!("{failures} TEST(S) FAILED");
    std::process::exit(1);
}

/// Child role: acquire the lease, announce readiness, then sleep so the parent
/// can kill us mid-hold.
fn child_lease_holder() {
    let root = match std::env::var("STORAGE_LEASE_HOLDER") {
        Ok(value) => PathBuf::from(value),
        Err(_) => std::process::exit(2),
    };
    match DataRootLease::acquire(&root) {
        Ok(lease) => {
            println!("locked");
            let _ = std::io::stdout().flush();
            std::thread::sleep(Duration::from_secs(60));
            drop(lease);
        }
        Err(e) => {
            eprintln!("child could not acquire lease: {e}");
            std::process::exit(3);
        }
    }
}

fn test_lease_acquire_and_probe() -> TestResult {
    let dir = tempfile::tempdir()?;
    let root = dir.path();
    let lease = DataRootLease::acquire(root)?;
    assert_eq!(lease.root(), root);
    assert!(probe_lock(root)?, "probe_lock must report the held lock");
    drop(lease);
    assert!(
        !probe_lock(root)?,
        "probe_lock must report the lock as free after drop"
    );
    Ok(())
}

fn test_lease_second_acquire_blocked() -> TestResult {
    let dir = tempfile::tempdir()?;
    let root = dir.path();
    let _lease = DataRootLease::acquire(root)?;
    let err = match DataRootLease::acquire(root) {
        Ok(_) => panic!("a second acquire of the same root must fail"),
        Err(e) => e,
    };
    assert_eq!(err.code, StorageErrorCode::DataRootInUse);
    Ok(())
}

fn test_lease_release_reacquire() -> TestResult {
    let dir = tempfile::tempdir()?;
    let root = dir.path();
    let lease = DataRootLease::acquire(root)?;
    lease.release()?;
    assert!(!probe_lock(root)?, "lock must be free after release");
    let _again = DataRootLease::acquire(root)?;
    assert!(probe_lock(root)?, "re-acquired lock must be reported held");
    Ok(())
}

fn test_lease_child_kill_releases() -> TestResult {
    let dir = tempfile::tempdir()?;
    let root = dir.path().to_path_buf();
    let exe = std::env::current_exe()?;
    let mut child = std::process::Command::new(exe)
        .env("STORAGE_LEASE_HOLDER", &root)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .spawn()?;
    let stdout = child.stdout.take().ok_or("child stdout missing")?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut line = String::new();
        let mut reader = std::io::BufReader::new(stdout);
        let _ = reader.read_line(&mut line);
        let _ = tx.send(line);
    });
    let line = rx.recv_timeout(Duration::from_secs(30)).unwrap_or_default();
    assert_eq!(
        line.trim(),
        "locked",
        "child did not report 'locked'; got {line:?}"
    );
    child.kill()?;
    child.wait()?;
    assert!(
        !probe_lock(&root)?,
        "the OS must release the lease when the holder process is killed"
    );
    let _lease = DataRootLease::acquire(&root)?;
    Ok(())
}
