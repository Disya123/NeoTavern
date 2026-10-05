//! File-based golden digest corpus — the ADR-0057 Phase 1
//! refactor-stability suite (INV-3 digest seam).
//!
//! Scripted FakeWire journeys fold `FrameSnapshot`s; their FNV-1a digests
//! (quantized to 1/4 px) are compared against the committed golden file
//! `tests/golden/frame-digests.txt`. The corpus gates GEOMETRY and
//! EDITING stability across refactors of the arena, layout, text engine,
//! snapshot or pilot projection — a refactor that keeps the golden
//! corpus green is proven not to have moved a rect.
//!
//! Scope honesty (INV-7): this is NOT a product-claim gate — the wire is
//! the deterministic in-memory fake; product truth stays gated by
//! `tests/phase1_gate.rs` on the real Kernel. Determinism across
//! machines is guaranteed by construction: the design system bundles the
//! golden faces with `system_fonts: false`, the digest quantizes float
//! geometry, input frames are hashed in sorted order and scene epochs
//! stay outside the hash.
//!
//! Regenerate after an INTENTIONAL geometry change (new tokens, layout
//! rules, ramp changes):
//!
//! ```text
//! UPDATE_GOLDENS=1 cargo test --manifest-path crates/Cargo.toml \
//!   -p neotavern-presentation-scene-chat-pilot --test refactor_stability
//! ```
//!
//! (Windows PowerShell: `$env:UPDATE_GOLDENS='1'; cargo test ...`) — the
//! run rewrites the golden file and fails on purpose so the diff gets
//! reviewed, never auto-committed blind.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::PathBuf;

use neotavern_presentation_chat::{ChatSession, FakeWire, ProductWire};
use neotavern_presentation_scene::CursorOp;
use neotavern_presentation_scene_chat_pilot::ChatPilot;

/// One corpus record: `<checkpoint>@<width>x<height>` → digest.
type Corpus = BTreeMap<String, u64>;

// Forward slashes: `CARGO_MANIFEST_DIR` is native, the suffix must be
// path-joined on every platform (std handles `/` on Windows).
const GOLDEN_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/golden/frame-digests.txt"
);

const GOLDEN_HEADER: &str = "\
# ADR-0057 Phase 1 refactor-stability golden corpus — FrameSnapshot digests
# (FNV-1a over quantized 1/4-px geometry; see snapshot.rs). One line per
# checkpoint: <name>@<width>x<height> = <digest>.
#
# Regenerate after an intentional geometry change:
#   UPDATE_GOLDENS=1 cargo test --manifest-path crates/Cargo.toml \
#     -p neotavern-presentation-scene-chat-pilot --test refactor_stability
#
# Deterministic across machines: golden font faces are bundled with
# system_fonts off (design system); digests carry no scene epochs.
# Geometry-only gate (INV-7): product truth is tests/phase1_gate.rs on
# the real Kernel.
";

fn viewports() -> [(f32, f32); 4] {
    // The golden corpus regime (m0-d2 sizes): desktop wide, laptop,
    // narrow/tall, composer band.
    [
        (1100.0, 760.0),
        (900.0, 700.0),
        (620.0, 800.0),
        (900.0, 220.0),
    ]
}

fn label(name: &str, viewport: (f32, f32)) -> String {
    format!("{}@{}x{}", name, viewport.0 as u32, viewport.1 as u32)
}

/// Projects + folds one frame and records its digest.
fn capture(
    name: &str,
    viewport: (f32, f32),
    pilot: &mut ChatPilot,
    session: &ChatSession<Box<dyn ProductWire>>,
    corpus: &mut Corpus,
) {
    pilot.project(session);
    let digest = pilot.frame(viewport).digest();
    corpus.insert(label(name, viewport), digest);
}

/// Types one "keystroke batch" through the real editing model — the
/// host contract: `queue_insert` then `Insert { batch: 0 }` per batch
/// (drain semantics).
fn type_batch(text: &str, pilot: &mut ChatPilot, session: &mut ChatSession<Box<dyn ProductWire>>) {
    pilot.composer().queue_insert(text);
    pilot.apply_composer_op(session, CursorOp::Insert { batch: 0 });
}

/// The scripted journey. Every step is deterministic; the corpus keys
/// name WHAT changed, not how the internals got there.
fn run_journey() -> Corpus {
    let wire: Box<dyn ProductWire> = Box::new(FakeWire::with_message_count(12));
    let mut session = ChatSession::open(wire, None).expect("fake wire opens");
    // FakeWire completes its demo stream synchronously inside `send`;
    // drain once so `open` sees the settled state.
    let _ = session.pump_stream();
    let mut pilot = ChatPilot::new();

    let mut corpus = Corpus::new();

    // 1. The seeded history across every layout regime.
    for viewport in viewports() {
        capture("open", viewport, &mut pilot, &session, &mut corpus);
    }

    // 2. Typing — one batch per keystroke, caret walks the word.
    for ch in "hello pilot".chars() {
        type_batch(&ch.to_string(), &mut pilot, &mut session);
    }
    capture("typed", (1100.0, 760.0), &mut pilot, &session, &mut corpus);
    capture("typed", (620.0, 800.0), &mut pilot, &session, &mut corpus);

    // 3. Selection over everything, then a whole-buffer replace (the
    // PL-01 failure mode of the earlier increments).
    pilot.apply_composer_op(&mut session, CursorOp::SelectAll);
    capture(
        "select-all",
        (1100.0, 760.0),
        &mut pilot,
        &session,
        &mut corpus,
    );
    type_batch("hello from the scene pilot", &mut pilot, &mut session);
    capture(
        "replaced",
        (1100.0, 760.0),
        &mut pilot,
        &session,
        &mut corpus,
    );

    // 4. Caret-only motion: same text, moved caret rect.
    for _ in 0..3 {
        pilot.apply_composer_op(&mut session, CursorOp::MoveLeft { select: false });
    }
    capture(
        "caret-left-3",
        (1100.0, 760.0),
        &mut pilot,
        &session,
        &mut corpus,
    );

    // 5. Multibyte clusters (Onest carries the Cyrillic; Outfit does
    // not): grapheme navigation and shaping through the cluster seam.
    pilot.apply_composer_op(&mut session, CursorOp::SelectAll);
    for ch in "Привет, пилот!".chars() {
        type_batch(&ch.to_string(), &mut pilot, &mut session);
    }
    capture(
        "cyrillic",
        (1100.0, 760.0),
        &mut pilot,
        &session,
        &mut corpus,
    );

    // 6. Wrap regime: a long fixed paragraph at two widths.
    pilot.apply_composer_op(&mut session, CursorOp::SelectAll);
    type_batch(
        "The refactor-stability corpus pins the geometry of this frame: \
         every rect, caret and selection edge folds into one digest, so a \
         refactor that quietly nudges a padding token, a baseline or a \
         line-break rule cannot hide behind green unit tests.",
        &mut pilot,
        &mut session,
    );
    capture(
        "wrap-long",
        (900.0, 700.0),
        &mut pilot,
        &session,
        &mut corpus,
    );
    capture(
        "wrap-long",
        (900.0, 220.0),
        &mut pilot,
        &session,
        &mut corpus,
    );

    // 7. Send through the session command surface, drain the fake
    // stream to completion, verify the post-send frame: the new
    // assistant row and the cleared composer.
    session.send(None).expect("fake send");
    while session.pump_stream() {}
    capture("sent", (1100.0, 760.0), &mut pilot, &session, &mut corpus);

    corpus
}

fn parse_golden(text: &str) -> Corpus {
    let mut corpus = Corpus::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((name, digest)) = line.split_once(" = ") else {
            panic!("golden line is not `<name> = <digest>`: {line:?}");
        };
        let digest = u64::from_str_radix(digest.trim(), 10)
            .unwrap_or_else(|err| panic!("golden digest {digest:?}: {err}"));
        corpus.insert(name.trim().to_string(), digest);
    }
    corpus
}

fn render_golden(corpus: &Corpus) -> String {
    let mut out = String::from(GOLDEN_HEADER);
    for (name, digest) in corpus {
        writeln!(out, "{name} = {digest}").expect("string write cannot fail");
    }
    out
}

#[test]
fn refactor_stability_corpus_matches_the_committed_goldens() {
    let once = run_journey();
    // Determinism self-check: a second fresh run (new wire, session,
    // pilot, text engine) must reproduce every digest bit-for-bit —
    // this catches arena/HashMap/pump nondeterminism before it can
    // masquerade as a golden mismatch.
    let twice = run_journey();
    assert_eq!(
        once,
        twice,
        "the corpus must be deterministic across fresh runs: {:#?}",
        once.iter()
            .filter(|(k, v)| twice.get(*k) != Some(*v))
            .collect::<std::collections::BTreeMap<_, _>>()
    );

    let path = PathBuf::from(GOLDEN_PATH);
    let updating = std::env::var_os("UPDATE_GOLDENS").is_some();
    if updating || !path.exists() {
        std::fs::create_dir_all(path.parent().expect("golden dir")).expect("create golden dir");
        std::fs::write(&path, render_golden(&once)).expect("write golden file");
        panic!(
            "golden corpus {} — review the diff and commit it with the \
             intentional geometry change",
            if updating { "regenerated" } else { "created" }
        );
    }

    let golden_text = std::fs::read_to_string(&path).expect("read golden file");
    let golden = parse_golden(&golden_text);

    let mut missing: Vec<&String> = golden.keys().filter(|k| !once.contains_key(*k)).collect();
    let mut extra: Vec<&String> = once.keys().filter(|k| !golden.contains_key(*k)).collect();
    let mut changed: Vec<(String, u64, u64)> = Vec::new();
    for (name, digest) in &golden {
        if let Some(&actual) = once.get(name) {
            if actual != *digest {
                changed.push((name.clone(), *digest, actual));
            }
        }
    }
    missing.sort();
    extra.sort();
    changed.sort();

    if missing.is_empty() && extra.is_empty() && changed.is_empty() {
        return;
    }
    let mut report = String::from("refactor-stability golden mismatch:\n");
    for (name, expected, actual) in &changed {
        writeln!(
            report,
            "  CHANGED {name}: golden {expected}, actual {actual}"
        )
        .expect("string write cannot fail");
    }
    for name in &missing {
        writeln!(report, "  MISSING {name} (no longer produced)")
            .expect("string write cannot fail");
    }
    for name in &extra {
        writeln!(report, "  NEW {name} (add with UPDATE_GOLDENS=1)")
            .expect("string write cannot fail");
    }
    writeln!(
        report,
        "Intentional geometry change? Regenerate: UPDATE_GOLDENS=1 cargo \
         test -p neotavern-presentation-scene-chat-pilot --test \
         refactor_stability, then review the diff. Accidental? The \
         refactor moved a rect — fix it here, not in the goldens."
    )
    .expect("string write cannot fail");
    panic!("{report}");
}
