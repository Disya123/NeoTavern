//! Token-only scene styling (ADR-0057 platform spec §4).
//!
//! A scene node's style carries **semantic token references only**. There is
//! no constructor for a literal color, font size, spacing or radius — the
//! type system makes the AGENTS §14 hardcoding ban structural, on the native
//! contour. Concrete values are resolved per frame by [`crate::theme::Theme`]
//! (the native theme contract: tokens + data-driven skins; themes are data,
//! never code).
//!
//! Structural layout (flex direction, grow, alignment) is part of the scene
//! model itself: components declare roles and stable slots, the shell
//! arrangement is projected by the product (ADR-0057 §5 of AGENTS: "components
//! declare only roles and stable slots").

/// Semantic color tokens (subset of the React golden `--st-color-*` set;
/// extended when panels migrate in Phase 2).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum ColorToken {
    TextPrimary,
    TextSecondary,
    TextMuted,
    TextInverse,
    SurfaceCanvas,
    SurfacePrimary,
    SurfaceSecondary,
    SurfaceTertiary,
    SurfaceElevated,
    Accent,
    AccentText,
    Border,
    BorderSubtle,
    Danger,
    Success,
    Warning,
    /// Composer-specific bubble text (streaming preview).
    StreamingText,
}

/// Named spacing scale. Values live in the theme, never in components.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum SpacingToken {
    /// True zero — used by default paddings so an unpadded node does not
    /// secretly carry the smallest ramp step.
    None,
    Xxs,
    Xs,
    Sm,
    Md,
    Lg,
    Xl,
    Xxl,
}

/// Named radii.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum RadiusToken {
    None,
    Control,
    Card,
}

/// Standard control heights (AGENTS §14 forbids literal control sizes).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum ControlHeightToken {
    Control,
    ControlLarge,
}

/// Type ramp sizes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum FontSizeToken {
    Caption,
    Body,
    BodyLarge,
    Title,
}

/// Font weight ramp.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum FontWeightToken {
    Regular,
    Medium,
    Semibold,
}

/// Font stack selector. The concrete family list is theme data (the golden
/// Outfit/Onest/JetBrains Mono stack packed in the design system).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum FontStackToken {
    Sans,
    Mono,
}

/// How a dimension is derived. Cross-axis sizes are content-driven; fixed
/// sizes come only from named tokens (control heights).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SizeToken {
    Auto,
    Fill,
    Height(ControlHeightToken),
}

/// Padding on a node: one token per side group (no per-side literals).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Padding {
    pub horizontal: SpacingToken,
    pub vertical: SpacingToken,
}

impl Padding {
    pub const fn all(t: SpacingToken) -> Self {
        Self {
            horizontal: t,
            vertical: t,
        }
    }
    pub const fn hv(h: SpacingToken, v: SpacingToken) -> Self {
        Self {
            horizontal: h,
            vertical: v,
        }
    }
    pub const ZERO: Padding = Padding::all(SpacingToken::None);
}

/// Direction of a container.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    Column,
    Row,
}

/// Structural layout of one node. Every number is a token reference.
#[derive(Clone, Debug, PartialEq)]
pub struct NodeLayout {
    pub direction: Direction,
    pub padding: Padding,
    pub gap: SpacingToken,
    pub width: SizeToken,
    pub height: SizeToken,
    /// Flex grow along the main axis (structural, not a theme value).
    pub grow: f32,
}

impl NodeLayout {
    /// A column container filling its parent's cross axis.
    pub fn column() -> Self {
        Self {
            direction: Direction::Column,
            padding: Padding::ZERO,
            gap: SpacingToken::Xxs,
            width: SizeToken::Fill,
            height: SizeToken::Auto,
            grow: 0.0,
        }
    }

    pub fn row() -> Self {
        Self {
            direction: Direction::Row,
            ..Self::column()
        }
    }

    pub fn with_padding(mut self, p: Padding) -> Self {
        self.padding = p;
        self
    }

    pub fn with_gap(mut self, g: SpacingToken) -> Self {
        self.gap = g;
        self
    }

    pub fn with_grow(mut self, g: f32) -> Self {
        self.grow = g;
        self
    }

    pub fn with_height(mut self, h: SizeToken) -> Self {
        self.height = h;
        self
    }
}

/// Text run styling — token references only.
#[derive(Clone, Debug, PartialEq)]
pub struct TextTokens {
    pub stack: FontStackToken,
    pub size: FontSizeToken,
    pub weight: FontWeightToken,
    pub color: ColorToken,
}

impl TextTokens {
    pub fn body() -> Self {
        Self {
            stack: FontStackToken::Sans,
            size: FontSizeToken::Body,
            weight: FontWeightToken::Regular,
            color: ColorToken::TextPrimary,
        }
    }

    pub fn caption() -> Self {
        Self {
            size: FontSizeToken::Caption,
            color: ColorToken::TextMuted,
            ..Self::body()
        }
    }

    pub fn title() -> Self {
        Self {
            size: FontSizeToken::Title,
            weight: FontWeightToken::Semibold,
            ..Self::body()
        }
    }

    pub fn with_color(mut self, c: ColorToken) -> Self {
        self.color = c;
        self
    }
}
