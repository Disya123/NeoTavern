use neotavern_presentation_perf_probe::start_chat_route;

#[test]
fn start_chat_route_stays_off_without_the_flag() {
    let line = start_chat_route(None);
    assert!(line.contains("chat_route=false"), "{line}");
    assert!(line.contains("reason=flag_off"), "{line}");
    assert!(line.contains("main_activity=false"), "{line}");
}

#[test]
fn start_chat_route_mounts_the_flagged_workspace() {
    let line = start_chat_route(Some("1"));
    assert!(line.contains("chat_route=true"), "{line}");
    assert!(line.contains("data_component=chat-workspace"), "{line}");
    assert!(line.contains("production_cutover=false"), "{line}");
}
