//! Visible / prepared / fallback-ready item spans.

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ItemSpan {
    pub start: usize,
    pub end: usize,
}

impl ItemSpan {
    pub const EMPTY: Self = Self { start: 0, end: 0 };

    pub fn is_empty(self) -> bool {
        self.start >= self.end
    }

    pub fn len(self) -> usize {
        self.end.saturating_sub(self.start)
    }

    pub fn contains(self, index: usize) -> bool {
        index >= self.start && index < self.end
    }

    pub fn union(self, other: Self) -> Self {
        if self.is_empty() {
            return other;
        }
        if other.is_empty() {
            return self;
        }
        Self {
            start: self.start.min(other.start),
            end: self.end.max(other.end),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VisibleRange {
    pub span: ItemSpan,
    pub offset: f64,
    pub viewport_height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PreparedRange {
    pub span: ItemSpan,
    pub generation: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FallbackReadyRange {
    pub span: ItemSpan,
}
