//! Editor-core: the single text input model (ADR-0057 INV-4, platform spec
//! §5).
//!
//! One editable buffer type for every input field on every platform — the
//! chat composer, character forms, settings fields, plugin IR inputs. All
//! edits go through [`Editor::replace_range`]; nothing anywhere is
//! append-only. Fields are [`FieldId`]-addressable so focus, IME and a11y
//! target the same logical field the projection renders.
//!
//! The buffer stores UTF-8 text with byte-index positions that are kept on
//! char boundaries by construction (all ops snap to boundaries). Phase 3's
//! IME bridge composes into the same `replace_range` seam
//! (`set_composition`), so the Android adapter will not fork the model.

use std::ops::Range;

/// Logical address of one input field. Product projections mint stable ids;
/// the host routes native focus/IME events to the same id the scene
/// rendered.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum FieldId {
    /// The chat composer (the Phase-1 pilot's single input field).
    Composer,
    /// Generic named field for later panels (`settings.<name>`-style keys
    /// live in the product projection, not the platform).
    Named(&'static str),
}

/// Caret/selection state: `anchor == caret` means a plain caret; otherwise
/// the range between them is the live selection (anchor is where it
/// started, caret is where it moved to).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cursor {
    /// Selection anchor (byte index; on a char boundary).
    pub anchor: usize,
    /// Caret head (byte index; on a char boundary).
    pub caret: usize,
}

impl Cursor {
    pub fn at(index: usize) -> Self {
        Self {
            anchor: index,
            caret: index,
        }
    }

    /// The selection as an ordered range, or `None` for a bare caret.
    pub fn selection(&self) -> Option<Range<usize>> {
        (self.anchor != self.caret).then(|| Range {
            start: self.anchor.min(self.caret),
            end: self.anchor.max(self.caret),
        })
    }

    pub fn min_index(&self) -> usize {
        self.anchor.min(self.caret)
    }

    pub fn max_index(&self) -> usize {
        self.anchor.max(self.caret)
    }
}

/// One text-edit operation, expressed against the current buffer — pure
/// data so the host (winit/Android bridge) maps native events to ops and
/// the whole model stays unit-testable without any window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CursorOp {
    /// Type a string at the caret (replaces the selection when present).
    /// Carries an index into the host's pending-input queue — hosts batch
    /// multi-codepoint insertions. Applying the op CONSUMES that queue
    /// entry (drain semantics): `queue_insert` followed by
    /// `Insert { batch: 0 }` flushes the head, so a host typing one batch
    /// per event always passes `batch: 0`.
    Insert {
        batch: usize,
    },
    DeleteBackward,
    DeleteForward,
    DeleteToLineStart,
    DeleteWordBackward,
    MoveLeft {
        select: bool,
    },
    MoveRight {
        select: bool,
    },
    MoveUp {
        select: bool,
    },
    MoveDown {
        select: bool,
    },
    MoveToLineStart {
        select: bool,
    },
    MoveToLineEnd {
        select: bool,
    },
    MoveToStart {
        select: bool,
    },
    MoveToEnd {
        select: bool,
    },
    /// Click-to-position: byte index on a char boundary (host resolves the
    /// click to an index through the frame snapshot's caret geometry — the
    /// snapshot is the single geometry, INV-2).
    Position {
        index: usize,
        select: bool,
    },
    SelectAll,
    /// Replace the whole buffer (host paste / projection hydration).
    SetText,
}

/// The editable field state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Editor {
    text: String,
    cursor: Cursor,
    /// Pending insert batches: host calls [`Editor::queue_insert`] then
    /// applies ops; kept here so ops stay pure data.
    pending: Vec<String>,
    /// True after a composition (IME) replaced a range — Phase 3 bridge
    /// uses this; Phase 1 keeps it unused-but-present so the seam exists.
    composing: bool,
}

impl Editor {
    pub fn new(text: impl Into<String>) -> Self {
        let text = text.into();
        let end = text.len();
        Self {
            text,
            cursor: Cursor::at(end),
            pending: Vec::new(),
            composing: false,
        }
    }

    pub fn empty() -> Self {
        Self::new(String::new())
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn cursor(&self) -> Cursor {
        self.cursor
    }

    /// Queues an insertion for the next `Insert { batch }` op (the host
    /// flushes one batch per key event or IME segment).
    pub fn queue_insert(&mut self, s: impl Into<String>) {
        self.pending.push(s.into());
    }

    pub fn is_composing(&self) -> bool {
        self.composing
    }

    /// Applies one op. Returns `true` when the buffer or selection changed
    /// (hosts use it to coalesce redraws).
    pub fn apply(&mut self, op: CursorOp) -> bool {
        let before = (self.text.clone(), self.cursor);
        match op {
            CursorOp::Insert { batch } => {
                // Drain semantics: the flushed batch leaves the queue, so
                // the head (batch 0) is always the next unflushed segment.
                if batch < self.pending.len() {
                    let s = self.pending.remove(batch);
                    self.replace_selection(s);
                }
            }
            CursorOp::DeleteBackward => {
                if let Some(r) = self.cursor.selection() {
                    self.replace_range(r, String::new());
                } else if self.cursor.caret > 0 {
                    let start = self.prev_char_start(self.cursor.caret);
                    self.replace_range(start..self.cursor.caret, String::new());
                }
            }
            CursorOp::DeleteForward => {
                if let Some(r) = self.cursor.selection() {
                    self.replace_range(r, String::new());
                } else if self.cursor.caret < self.text.len() {
                    let end = self.next_char_end(self.cursor.caret);
                    self.replace_range(self.cursor.caret..end, String::new());
                }
            }
            CursorOp::DeleteToLineStart => {
                if let Some(r) = self.cursor.selection() {
                    self.replace_range(r, String::new());
                } else {
                    let line_start = self.text[..self.cursor.caret]
                        .rfind('\n')
                        .map(|i| i + 1)
                        .unwrap_or(0);
                    self.replace_range(line_start..self.cursor.caret, String::new());
                }
            }
            CursorOp::DeleteWordBackward => {
                if let Some(r) = self.cursor.selection() {
                    self.replace_range(r, String::new());
                } else {
                    let start = self.word_start_before(self.cursor.caret);
                    self.replace_range(start..self.cursor.caret, String::new());
                }
            }
            CursorOp::MoveLeft { select } => {
                let from = if select {
                    self.cursor.caret
                } else {
                    self.cursor.min_index()
                };
                let target = self.prev_char_start(from);
                self.move_caret(target, select);
            }
            CursorOp::MoveRight { select } => {
                let from = if select {
                    self.cursor.caret
                } else {
                    self.cursor.max_index()
                };
                let target = self.next_char_end(from);
                self.move_caret(target, select);
            }
            // Vertical movement over a single-paragraph buffer clamps to
            // start/end; the frame snapshot's caret line geometry drives the
            // multi-line form (host passes resolved indices via `Position`).
            CursorOp::MoveUp { select } => {
                let line_start = self.line_start_of(self.cursor.caret);
                let Some(nl) = self.text[..line_start].rfind('\n') else {
                    return false;
                };
                let prev_start = self.text[..nl].rfind('\n').map(|i| i + 1).unwrap_or(0);
                let column = self.cursor.caret - line_start;
                let target = (prev_start + column).min(nl);
                self.move_caret(self.next_boundary(target), select);
            }
            CursorOp::MoveDown { select } => {
                let line_start = self.line_start_of(self.cursor.caret);
                let Some(nl) = self.text[line_start..].find('\n') else {
                    return false;
                };
                let line_end = line_start + nl;
                let column = self.cursor.caret - line_start;
                let next_start = line_end + 1;
                let Some(next_nl) = self.text[next_start..].find('\n') else {
                    self.move_caret(self.text.len(), select);
                    return true;
                };
                let target = (next_start + column).min(next_start + next_nl);
                self.move_caret(self.next_boundary(target), select);
            }
            CursorOp::MoveToLineStart { select } => {
                let target = self.line_start_of(self.cursor.caret);
                self.move_caret(target, select);
            }
            CursorOp::MoveToLineEnd { select } => {
                let line_start = self.line_start_of(self.cursor.caret);
                let target = self.text[line_start..]
                    .find('\n')
                    .map(|i| line_start + i)
                    .unwrap_or(self.text.len());
                self.move_caret(target, select);
            }
            CursorOp::MoveToStart { select } => self.move_caret(0, select),
            CursorOp::MoveToEnd { select } => self.move_caret(self.text.len(), select),
            CursorOp::Position { index, select } => {
                let index = index.min(self.text.len());
                let index = self.snap_boundary(index);
                self.move_caret(index, select);
            }
            CursorOp::SelectAll => {
                self.cursor.anchor = 0;
                self.cursor.caret = self.text.len();
            }
            CursorOp::SetText => {
                // Whole-buffer replace is issued through `set_text` (the
                // host/projection owns the new text); as an op it's a no-op.
            }
        }
        (self.text.clone(), self.cursor) != before
    }

    /// Replaces the live selection (or inserts at the caret) — the seam the
    /// IME composition also targets.
    pub fn replace_selection(&mut self, s: impl Into<String>) {
        let range = self.cursor.selection().unwrap_or_else(|| {
            let c = self.cursor.caret;
            c..c
        });
        self.replace_range(range, s);
    }

    /// Core edit primitive: every mutation on every platform funnels here.
    pub fn replace_range(&mut self, range: Range<usize>, s: impl Into<String>) {
        let start = self.snap_boundary(range.start.min(range.end));
        let end = self.snap_boundary(range.start.max(range.end).min(self.text.len()));
        let s = s.into();
        let tail_start = end;
        let new_caret = start + s.len();
        let mut text = String::with_capacity(self.text.len() - (end - start) + s.len());
        text.push_str(&self.text[..start]);
        text.push_str(&s);
        text.push_str(&self.text[tail_start..]);
        self.text = text;
        self.cursor = Cursor::at(new_caret);
    }

    /// Replaces the whole buffer (paste, projection hydration, IME commit).
    pub fn set_text(&mut self, text: impl Into<String>) {
        let text = text.into();
        let caret = text.len();
        self.text = text;
        self.cursor = Cursor::at(caret);
    }

    /// Enters composition state (IME): the Android/desktop bridges in
    /// Phase 3 call this around `replace_range` so selection policy stays
    /// in one place.
    pub fn set_composition(&mut self, composing: bool) {
        self.composing = composing;
    }

    /// Selected slice (empty for a bare caret).
    pub fn selected_text(&self) -> &str {
        match self.cursor.selection() {
            Some(r) => &self.text[r],
            None => "",
        }
    }

    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }

    pub fn len(&self) -> usize {
        self.text.len()
    }

    // -- internals --------------------------------------------------------

    fn move_caret(&mut self, index: usize, select: bool) {
        if select {
            self.cursor.caret = index;
        } else {
            self.cursor = Cursor::at(index);
        }
    }

    fn next_boundary(&self, i: usize) -> usize {
        let mut i = i.min(self.text.len());
        while i < self.text.len() && !self.text.is_char_boundary(i) {
            i += 1;
        }
        i
    }

    /// Start of the character immediately before byte `i` — strictly less
    /// than `i` whenever `i > 0`. When `i` sits mid-char, this is the
    /// start of that (partially traversed) character instead. Movement
    /// and backspace use this so a boundary position can never produce a
    /// no-op.
    fn prev_char_start(&self, i: usize) -> usize {
        let mut i = i.min(self.text.len());
        if i == 0 {
            return 0;
        }
        i -= 1;
        while i > 0 && !self.text.is_char_boundary(i) {
            i -= 1;
        }
        i
    }

    /// End of the character at byte `i` — strictly greater than `i`
    /// whenever `i < len`. DeleteForward and MoveRight use this.
    fn next_char_end(&self, i: usize) -> usize {
        let mut i = i.min(self.text.len());
        if i >= self.text.len() {
            return self.text.len();
        }
        i += 1;
        while i < self.text.len() && !self.text.is_char_boundary(i) {
            i += 1;
        }
        i
    }

    fn snap_boundary(&self, i: usize) -> usize {
        let mut i = i.min(self.text.len());
        while i < self.text.len() && !self.text.is_char_boundary(i) {
            i += 1;
        }
        i
    }

    fn line_start_of(&self, i: usize) -> usize {
        self.text[..i].rfind('\n').map(|x| x + 1).unwrap_or(0)
    }

    /// Word start before `i` (char-class based, no ICU dependency — a
    /// word = a run of alphanumeric-ish or a run of the rest).
    fn word_start_before(&self, i: usize) -> usize {
        let bytes = self.text.as_bytes();
        if i == 0 {
            return 0;
        }
        let is_word = |b: u8| b.is_ascii_alphanumeric() || b >= 0x80;
        let at = |x: usize| bytes.get(x).copied().unwrap_or(b'\0');
        let mut x = i;
        // skip whitespace, then take one class run.
        while x > 0 && at(x - 1).is_ascii_whitespace() {
            x = self.prev_char_start(x);
        }
        let wordish = x > 0 && is_word(at(x - 1));
        while x > 0 && is_word(at(x - 1)) == wordish {
            x = self.prev_char_start(x);
        }
        x
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ed(text: &str) -> Editor {
        Editor::new(text)
    }

    #[test]
    fn typing_replaces_selection_not_appends() {
        // The audit's PL-01 failure mode: append-only input. Insert with a
        // live selection must replace, and mid-string edits must work.
        let mut e = ed("hello world");
        e.apply(CursorOp::Position {
            index: 5,
            select: false,
        });
        e.apply(CursorOp::MoveRight { select: true });
        e.apply(CursorOp::MoveRight { select: true });
        e.apply(CursorOp::MoveRight { select: true });
        e.apply(CursorOp::MoveRight { select: true });
        e.apply(CursorOp::MoveRight { select: true });
        e.apply(CursorOp::MoveRight { select: true }); // selected " world"
        e.queue_insert(" there");
        e.apply(CursorOp::Insert { batch: 0 });
        assert_eq!(e.text(), "hello there");
    }

    #[test]
    fn mid_string_insert_and_backspace() {
        let mut e = ed("нап");
        e.apply(CursorOp::Position {
            index: 2,
            select: false,
        }); // inside "нa" multibyte
        e.queue_insert("X");
        e.apply(CursorOp::Insert { batch: 0 });
        assert_eq!(e.text(), "нXап");
        e.apply(CursorOp::DeleteBackward);
        assert_eq!(e.text(), "нап");
        e.apply(CursorOp::DeleteBackward);
        assert_eq!(e.text(), "ап");
        e.apply(CursorOp::MoveToEnd { select: false });
        e.apply(CursorOp::DeleteForward); // no-op at end
        assert_eq!(e.text(), "ап");
    }

    #[test]
    fn multibyte_boundaries_never_panic_or_split() {
        let mut e = ed("日本語テキスト");
        e.apply(CursorOp::Position {
            index: 3,
            select: false,
        }); // inside a char
        assert!(e.text().is_char_boundary(e.cursor().caret));
        e.queue_insert("🙂");
        e.apply(CursorOp::Insert { batch: 0 });
        assert_eq!(e.text().chars().count(), 8);
        // Backspace removes exactly one char per op and always advances —
        // a boundary position must never turn DeleteBackward into a no-op.
        let mut i = 0;
        while e.cursor().caret > 0 {
            e.apply(CursorOp::DeleteBackward);
            i += 1;
        }
        assert_eq!(i, 2, "only the chars before the caret are removed");
        assert_eq!(e.text(), "本語テキスト");
        e.apply(CursorOp::MoveToEnd { select: false });
        while !e.is_empty() {
            e.apply(CursorOp::DeleteBackward);
            i += 1;
        }
        assert_eq!(i, 8, "every char deleted exactly once, none split");
        assert!(e.is_empty());
    }

    #[test]
    fn word_and_line_ops() {
        let mut e = ed("foo bar\nbaz qux");
        e.apply(CursorOp::MoveToEnd { select: false });
        e.apply(CursorOp::DeleteWordBackward);
        assert_eq!(e.text(), "foo bar\nbaz ");
        e.apply(CursorOp::DeleteWordBackward);
        assert_eq!(e.text(), "foo bar\n");
        e.apply(CursorOp::MoveToLineStart { select: false });
        assert_eq!(
            e.cursor().caret,
            "foo bar\n".len(),
            "caret sits on the empty last line"
        );
        e.apply(CursorOp::MoveUp { select: false });
        assert_eq!(
            e.cursor().caret,
            0,
            "column 0 of the empty last line maps to column 0 of the previous line"
        );
        e.apply(CursorOp::MoveDown { select: false });
        assert_eq!(e.cursor().caret, "foo bar\n".len());
        e.apply(CursorOp::SelectAll);
        assert_eq!(e.selected_text(), "foo bar\n");
        e.apply(CursorOp::DeleteBackward);
        assert!(e.is_empty());
    }

    #[test]
    fn selection_geometrics_via_position_select() {
        let mut e = ed("abcdef");
        e.apply(CursorOp::Position {
            index: 1,
            select: false,
        });
        e.apply(CursorOp::Position {
            index: 4,
            select: true,
        });
        assert_eq!(e.selected_text(), "bcd");
        e.queue_insert("XY");
        e.apply(CursorOp::Insert { batch: 0 });
        assert_eq!(e.text(), "aXYef");
    }

    #[test]
    fn set_text_is_the_whole_buffer_replace() {
        let mut e = ed("old");
        e.set_text("новый текст");
        assert_eq!(e.text(), "новый текст");
        assert_eq!(e.cursor().caret, "новый текст".len());
    }

    #[test]
    fn replace_range_is_the_single_mutation_seam() {
        let mut e = ed("hello");
        e.replace_range(1..3, "EY".to_string());
        assert_eq!(e.text(), "hEYlo");
        assert_eq!(e.cursor().caret, 3);
        e.replace_range(0..1, String::new());
        assert_eq!(e.text(), "EYlo");
    }
}
