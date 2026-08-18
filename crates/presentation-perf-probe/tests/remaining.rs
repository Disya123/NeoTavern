//! Remaining Milestone B scenario names and host smoke (not PASS).

use neotavern_presentation_perf_probe::Scenario;

#[test]
fn parses_remaining_scenario_names() {
    assert_eq!(Scenario::parse("perf01"), Some(Scenario::Perf01Warm));
    assert_eq!(Scenario::parse("perf01-cold"), Some(Scenario::Perf01Cold));
    assert_eq!(Scenario::parse("streaming"), Some(Scenario::Perf02));
    assert_eq!(Scenario::parse("triple-glass"), Some(Scenario::Perf03));
    assert_eq!(Scenario::parse("nested-glass"), Some(Scenario::Perf04));
    assert_eq!(Scenario::parse("image-pressure"), Some(Scenario::Perf05));
    assert_eq!(Scenario::parse("paint-order"), Some(Scenario::Perf11));
    assert_eq!(Scenario::parse("adversarial"), Some(Scenario::Perf12));
    assert_eq!(Scenario::parse("teleport"), Some(Scenario::Perf13));
    assert_eq!(Scenario::parse("async-hit"), Some(Scenario::Perf14));
    assert_eq!(Scenario::parse("cold-start"), Some(Scenario::Perf16));
    assert_eq!(Scenario::parse("sticky"), Some(Scenario::Perf17));
    assert_eq!(Scenario::parse("nested-scroll"), Some(Scenario::Perf21));
    assert!(Scenario::parse("perf01-warm").unwrap().is_remaining_b());
    assert!(!Scenario::parse("perf15").unwrap().is_remaining_b());
}

#[cfg(feature = "gpu")]
#[test]
fn remaining_product_path_host_run_or_skip_without_adapter() {
    match neotavern_presentation_perf_probe::run_scenario(Scenario::Perf03, 2, -1) {
        Ok(line) => {
            assert!(line.contains("perf03"), "{line}");
            assert!(line.contains("product_path=true"), "{line}");
            assert!(line.contains("dioxus_shell=true"), "{line}");
            assert!(line.contains("blitz_producer=true"), "{line}");
            assert!(line.contains("wire_messages=10000"), "{line}");
            assert!(
                line.contains("direct_display_list_injection=false"),
                "{line}"
            );
            assert!(line.contains("glass_surfaces="), "{line}");
        }
        Err(err) => {
            assert!(
                err.contains("adapter")
                    || err.contains("vello")
                    || err.contains("gpu")
                    || err.contains("glass_hooks"),
                "{err}"
            );
        }
    }
}

#[cfg(feature = "gpu")]
#[test]
fn remaining_hit_and_cold_host_run_or_skip_without_adapter() {
    for scenario in [Scenario::Perf14, Scenario::Perf16, Scenario::Perf21] {
        match neotavern_presentation_perf_probe::run_scenario(scenario, 2, -1) {
            Ok(line) => {
                assert!(line.contains("product_path=true"), "{line}");
                assert!(line.contains(scenario.as_str()), "{line}");
            }
            Err(err) => {
                assert!(
                    err.contains("adapter") || err.contains("vello") || err.contains("gpu"),
                    "{err}"
                );
            }
        }
    }
}
