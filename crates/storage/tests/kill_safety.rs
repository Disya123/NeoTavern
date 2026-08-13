//! Integration tests for kill-safety: an abruptly killed process must lose
//! uncommitted work while committed work survives, and `open()` must recover
//! cleanly afterwards.
//!
//! This file uses a custom `fn main` instead of the libtest harness (declared
//! with `harness = false` in Cargo.toml) because the binary doubles as a child
//! process: when the environment variable `STORAGE_KILL_HOLDER` is set, the
//! binary opens the database at that root, writes a committed row, optionally
//! opens a transaction with an uncommitted row and sleeps inside it, then
//! prints `ready` and sleeps until the parent kills it. Otherwise the binary
//! runs the test functions below directly and reports PASS/FAIL, exiting
//! non-zero on failure.

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::time::Duration;

use neotavern_storage::baseline::ConnectionPolicy;
use neotavern_storage::open::open;
use neotavern_storage::StorageError;
type TestResult = Result<(), Box<dyn std::error::Error>>;
type TestFn = fn() -> TestResult;

fn main() {
    if std::env::var("STORAGE_KILL_HOLDER").is_ok() {
        child_kill_holder();
        // Only reached if the 60s sleep completes without the parent killing us.
        std::process::exit(0);
    }
    let tests: &[(&str, TestFn)] = &[
        (
            "kill_uncommitted_lost_committed_survives",
            test_uncommitted_lost_committed_survives,
        ),
        ("kill_committed_survives", test_committed_survives),
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

/// Child role: open the database, commit one row, then either sleep (mode
/// "commit") or open a second transaction with an uncommitted row and sleep
/// inside it (mode "tx"). The parent kills us mid-sleep.
fn child_kill_holder() {
    let root = match std::env::var("STORAGE_KILL_HOLDER") {
        Ok(value) => PathBuf::from(value),
        Err(_) => std::process::exit(2),
    };
    let mode = std::env::var("STORAGE_KILL_MODE").unwrap_or_else(|_| "commit".to_string());

    let mut noop = |_| {};
    let mut db = match open(&root, &ConnectionPolicy::default(), &mut noop) {
        Ok(db) => db,
        Err(e) => {
            eprintln!("child open failed: {e}");
            std::process::exit(3);
        }
    };

    // Committed row: must survive the kill.
    let committed = db.transaction(|tx| {
        tx.execute(
            "INSERT INTO __neotavern_meta (key, value) VALUES ('kill_committed', '1')",
            [],
        )
        .map_err(|e| StorageError::from_sqlite(e, "insert committed row"))
    });
    if committed.is_err() {
        eprintln!("child could not commit the committed row");
        std::process::exit(4);
    }

    if mode == "tx" {
        // Uncommitted row: sleep inside the open transaction so the parent
        // kills us before the transaction can commit.
        let uncommitted = db.transaction(|tx| {
            tx.execute(
                "INSERT INTO __neotavern_meta (key, value) VALUES ('kill_uncommitted', '1')",
                [],
            )
            .map_err(|e| StorageError::from_sqlite(e, "insert uncommitted row"))?;
            println!("ready");
            let _ = std::io::stdout().flush();
            std::thread::sleep(Duration::from_secs(60));
            Ok(())
        });
        let _ = uncommitted;
        std::process::exit(0);
    }

    println!("ready");
    let _ = std::io::stdout().flush();
    std::thread::sleep(Duration::from_secs(60));
    std::process::exit(0);
}

/// Spawn the child in the given mode, wait for its `ready` line, then kill it.
fn spawn_and_kill_child(root: &std::path::Path, mode: &str) -> TestResult {
    let exe = std::env::current_exe()?;
    let mut child = std::process::Command::new(exe)
        .env("STORAGE_KILL_HOLDER", root)
        .env("STORAGE_KILL_MODE", mode)
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
        "ready",
        "child did not report 'ready'; got {line:?}"
    );
    child.kill()?;
    child.wait()?;
    Ok(())
}

fn test_uncommitted_lost_committed_survives() -> TestResult {
    let dir = tempfile::tempdir()?;
    let root = dir.path().to_path_buf();
    spawn_and_kill_child(&root, "tx")?;

    // Reopen: the lease was released by the OS and the WAL was recovered.
    let mut noop = |_| {};
    let db = open(&root, &ConnectionPolicy::default(), &mut noop)?;
    let quick_check: String = db
        .conn()
        .query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    assert_eq!(quick_check, "ok");

    let committed: i64 = db.conn().query_row(
        "SELECT COUNT(*) FROM __neotavern_meta WHERE key = 'kill_committed'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(committed, 1, "the committed row must survive the kill");

    let uncommitted: i64 = db.conn().query_row(
        "SELECT COUNT(*) FROM __neotavern_meta WHERE key = 'kill_uncommitted'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(uncommitted, 0, "the uncommitted row must be lost");
    Ok(())
}

fn test_committed_survives() -> TestResult {
    let dir = tempfile::tempdir()?;
    let root = dir.path().to_path_buf();
    spawn_and_kill_child(&root, "commit")?;

    let mut noop = |_| {};
    let db = open(&root, &ConnectionPolicy::default(), &mut noop)?;
    let quick_check: String = db
        .conn()
        .query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    assert_eq!(quick_check, "ok");

    let committed: i64 = db.conn().query_row(
        "SELECT COUNT(*) FROM __neotavern_meta WHERE key = 'kill_committed'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(committed, 1, "the committed row must survive the kill");
    Ok(())
}
