//! Deterministic probe scripting for the desktop host: `--pointer`/`--type`/
//! `--wheel`/`--tick` ops replayed in argument order before the first frame.

use std::collections::VecDeque;

/// One scripted probe step, replayed in argument order so
/// "focus -> type -> send" scenarios are expressible.
#[derive(Clone, Debug)]
pub(super) enum ProbeOp {
    Tap(f32, f32),
    Type(String),
    /// One wheel notch in CSS px through the live smooth-scroll path.
    Wheel(f32),
    /// Advance the deterministic probe clock by N ms and run one animation
    /// step (same sampler the real frame loop uses).
    Tick(u64),
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
            _ => {}
        }
    }
    ops
}
