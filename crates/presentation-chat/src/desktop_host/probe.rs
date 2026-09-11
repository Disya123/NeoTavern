//! Deterministic probe scripting for the desktop host: `--pointer`/`--type`/
//! `--wheel`/`--tick` ops replayed in argument order before the first frame.

use std::collections::VecDeque;

/// One scripted probe step, replayed in argument order so
/// "focus -> type -> send" scenarios are expressible.
#[derive(Clone, Debug)]
pub(super) enum ProbeOp {
    Tap(f32, f32),
    /// Track the cursor without clicking — wheel routing (panel vs chat)
    /// uses the last pointer position.
    Move(f32, f32),
    Type(String),
    /// One wheel notch in CSS px through the live smooth-scroll path.
    Wheel(f32),
    /// Advance the deterministic probe clock by N ms and run one animation
    /// step (same sampler the real frame loop uses).
    Tick(u64),
    /// Debug-print both hit-test systems' resolution for a CSS point
    /// (geometric `shell_hit` + layout-derived `HitRects::resolve_tap`).
    /// The direct tool for "I clicked X, Y happened" questions.
    Hit(f32, f32),
    /// Real-time pause inside the replay (diagnostics only): lets a test
    /// harness bring the window to the foreground BEFORE the scripted
    /// gesture, so the animation runs on a visible window with true
    /// v-sync pacing. Deterministic snapshot flows never use it.
    Wait(u64),
}

/// Parse the probe ops in argv order so "focus -> type -> send" scenarios are
/// expressible (see the flag docs in the bin).
pub(super) fn parse_probe_ops(args: &[String]) -> VecDeque<ProbeOp> {
    let mut ops = VecDeque::new();
    let mut args_iter = args.iter().peekable();
    while let Some(arg) = args_iter.next() {
        match arg.as_str() {
            "--pointer" => {
                if let Some(spec) = args_iter.next() {
                    if let Some((x, y)) = spec.split_once(",") {
                        if let (Ok(x), Ok(y)) = (x.trim().parse::<f32>(), y.trim().parse::<f32>()) {
                            ops.push_back(ProbeOp::Tap(x, y));
                        }
                    }
                }
            }
            "--move" => {
                if let Some(spec) = args_iter.next() {
                    if let Some((x, y)) = spec.split_once(",") {
                        if let (Ok(x), Ok(y)) = (x.trim().parse::<f32>(), y.trim().parse::<f32>()) {
                            ops.push_back(ProbeOp::Move(x, y));
                        }
                    }
                }
            }
            "--type" => {
                if let Some(text) = args_iter.next() {
                    ops.push_back(ProbeOp::Type(text.clone()));
                }
            }
            "--wheel" => {
                if let Some(spec) = args_iter.next() {
                    if let Ok(dy) = spec.trim().parse::<f32>() {
                        ops.push_back(ProbeOp::Wheel(dy));
                    }
                }
            }
            "--tick" => {
                if let Some(spec) = args_iter.next() {
                    if let Ok(ms) = spec.trim().parse::<u64>() {
                        ops.push_back(ProbeOp::Tick(ms));
                    }
                }
            }
            "--hit" => {
                if let Some(spec) = args_iter.next() {
                    if let Some((x, y)) = spec.split_once(",") {
                        if let (Ok(x), Ok(y)) = (x.trim().parse::<f32>(), y.trim().parse::<f32>()) {
                            ops.push_back(ProbeOp::Hit(x, y));
                        }
                    }
                }
            }
            "--wait" => {
                if let Some(spec) = args_iter.next() {
                    if let Ok(ms) = spec.trim().parse::<u64>() {
                        ops.push_back(ProbeOp::Wait(ms));
                    }
                }
            }
            _ => {}
        }
    }
    ops
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ops(args: &[&str]) -> Vec<ProbeOp> {
        parse_probe_ops(&args.iter().map(|s| s.to_string()).collect::<Vec<String>>())
            .into_iter()
            .collect()
    }

    #[test]
    fn hit_probe_parses_css_points_in_order() {
        let parsed = ops(&[
            "--hit",
            "300,120",
            "--pointer",
            "10,20",
            "--hit",
            "55.5, 66",
        ]);
        assert_eq!(parsed.len(), 3);
        assert!(matches!(parsed[0], ProbeOp::Hit(x, y) if x == 300.0 && y == 120.0));
        assert!(matches!(parsed[1], ProbeOp::Tap(..)));
        assert!(matches!(parsed[2], ProbeOp::Hit(x, y) if x == 55.5 && y == 66.0));
    }
}
