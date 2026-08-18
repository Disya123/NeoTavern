use neotavern_presentation_perf_probe::{run_fling_trace, Scenario};

#[test]
fn parses_scenario_names() {
    assert_eq!(Scenario::parse("perf18"), Some(Scenario::Perf18));
    assert_eq!(Scenario::parse("19"), Some(Scenario::Perf19));
    assert_eq!(Scenario::parse("PERF20"), Some(Scenario::Perf20));
    assert_eq!(Scenario::parse("nope"), None);
}

#[test]
fn perf20_fling_trace_emits_required_fields_and_one_commit() {
    let mut log = String::new();
    let summary = run_fling_trace(32, &mut |line| {
        log.push_str(line);
        log.push('\n');
    })
    .expect("fling");
    assert!(summary.applied, "{summary:?}");
    assert!(!summary.deferred, "{summary:?}");
    assert!(summary.velocity_continuous, "{summary:?}");
    assert!(!summary.mixed_epoch, "{summary:?}");
    assert!(summary.blank_px < 1e-6, "{summary:?}");
    assert!(log.contains("perf20-commit "));
    assert!(log.contains("exact_delta=350"));
    assert!(log.contains("fling_px_s=10000"));
    let frames = log
        .lines()
        .filter(|line| line.starts_with("perf20-frame "))
        .count();
    assert!(frames >= 8, "{frames}");
    assert!(log.contains("layout_rebuilds=0"));
    assert!(log.contains("paint_rebuilds=0"));
    assert!(log.contains("raster_invalidations=0"));
}

#[cfg(feature = "gpu")]
#[test]
fn perf18_host_run_or_skip_without_adapter() {
    let result = neotavern_presentation_perf_probe::run_scenario(Scenario::Perf18, 2, -1);
    match result {
        Ok(line) => {
            assert!(line.contains("perf18"), "{line}");
            assert!(line.contains("devices="), "{line}");
        }
        Err(err) => {
            assert!(
                err.contains("adapter") || err.contains("vello") || err.contains("gpu"),
                "{err}"
            );
        }
    }
}
