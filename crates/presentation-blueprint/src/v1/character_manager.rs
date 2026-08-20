use std::fmt;

use contracts_generated::generated::{
    CharacterDto, ErrorDto, PagedCharacters, RequestCharactersExportCard, RequestCreateCharacter,
    RequestDeleteCharacter, RequestImportsCharacterCard, RequestListCharacters,
    RequestUpdateCharacter,
};
use serde::{Deserialize, Serialize};

/// Version marker for the portable presentation ABI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UiAbiVersionV1 {
    V1,
}

/// The catalog sort choices observed on the Character Manager Cards surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CharacterSortV1 {
    Name,
    NameDesc,
    Newest,
    Oldest,
    Favorites,
    Used,
    ChatsMost,
    ChatsLeast,
    TokensMost,
    TokensLeast,
    Random,
}

/// Stable catalog presentation; no renderer-specific list or grid type leaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CharacterCatalogViewV1 {
    List,
    Grid,
}

/// The selected Character Manager tab. V1 renders Cards natively; the other
/// values remain explicit state so a host cannot silently pretend they are
/// implemented.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CharacterManagerTabV1 {
    Cards,
    Edit,
    Advanced,
    Gallery,
}

/// Dialog state, represented as a product intent rather than DOM portal data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum CharacterManagerDialogV1 {
    Create,
    Delete { character_id: String },
}

/// Observable loading state. Error details stay a Product Wire `ErrorDto`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UiLoadStateV1 {
    Ready,
    Loading,
    Error,
}

/// Product-Wire-backed state necessary for the Cards pilot.
///
/// This deliberately does not invent React-only editor, gallery, or `ext`
/// fields absent from Product Wire. Such surfaces require a contract change
/// before they can become part of this ABI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CharacterManagerCaptureV1 {
    pub catalog: PagedCharacters,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected: Option<CharacterDto>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_character_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_character_id: Option<String>,
    pub query: String,
    pub sort: CharacterSortV1,
    pub view: CharacterCatalogViewV1,
    pub tab: CharacterManagerTabV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dialog: Option<CharacterManagerDialogV1>,
    pub loading: UiLoadStateV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorDto>,
}

/// Immutable transaction handed from the Product Wire host to the pure
/// blueprint compiler. It contains no browser DOM or renderer handles.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CaptureBundleV1 {
    pub version: UiAbiVersionV1,
    pub revision: u64,
    pub character_manager: CharacterManagerCaptureV1,
}

/// Closed, typed intent surface emitted by a Character Manager scene.
///
/// File bytes and filesystem paths never enter this ABI. `BeginImport` asks a
/// host to open a picker; an import becomes `ImportStaged` only after the host
/// has staged the asset through Product Wire.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum UiActionV1 {
    ClosePanel,
    SetQuery {
        value: String,
    },
    SetSort {
        value: CharacterSortV1,
    },
    SetView {
        value: CharacterCatalogViewV1,
    },
    SetTab {
        value: CharacterManagerTabV1,
    },
    SelectCharacter {
        character_id: String,
    },
    LoadMore {
        request: RequestListCharacters,
    },
    RetryList,
    OpenCreate,
    CancelCreate,
    Create {
        request: RequestCreateCharacter,
    },
    OpenDelete {
        character_id: String,
    },
    CancelDelete,
    Delete {
        request: RequestDeleteCharacter,
    },
    SaveBasic {
        request: RequestUpdateCharacter,
    },
    BeginImport,
    ImportStaged {
        request: RequestImportsCharacterCard,
    },
    Export {
        request: RequestCharactersExportCard,
    },
}

/// Backwards-compatible domain name for the closed Character Manager action
/// union. It is intentionally an alias, not a callback trait.
pub type CharacterManagerActionV1 = UiActionV1;

/// A host-visible Product Wire effect. Its payload remains the typed request
/// carried by the action, preventing a second DTO model in the presentation
/// layer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiWireEffectV1 {
    pub operation_id: String,
}

impl UiActionV1 {
    /// Returns the Product Wire operation selected by this action, if the
    /// action is a command rather than local UI state or a host picker intent.
    pub fn wire_effect(&self) -> Option<UiWireEffectV1> {
        let operation_id = match self {
            Self::LoadMore { .. } | Self::RetryList => "characters.list",
            Self::Create { .. } => "characters.create",
            Self::Delete { .. } => "characters.delete",
            Self::SaveBasic { .. } => "characters.update",
            Self::ImportStaged { .. } => "imports.character.card",
            Self::Export { .. } => "characters.export.card",
            Self::ClosePanel
            | Self::SetQuery { .. }
            | Self::SetSort { .. }
            | Self::SetView { .. }
            | Self::SetTab { .. }
            | Self::SelectCharacter { .. }
            | Self::OpenCreate
            | Self::CancelCreate
            | Self::OpenDelete { .. }
            | Self::CancelDelete
            | Self::BeginImport => return None,
        };
        Some(UiWireEffectV1 {
            operation_id: operation_id.to_owned(),
        })
    }
}

/// One catalog card without copied product data.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CharacterCardBlueprintV1 {
    pub character: CharacterDto,
    pub selected: bool,
    pub pinned: bool,
}

/// Controls visible in the Cards pilot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CharacterManagerControlsV1 {
    pub query: String,
    pub sort: CharacterSortV1,
    pub view: CharacterCatalogViewV1,
    pub can_load_more: bool,
    pub can_retry: bool,
    pub active_tab: CharacterManagerTabV1,
}

/// Feedback expressed as semantic state, not localized literal text.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum UiFeedbackV1 {
    Loading,
    Error { error: ErrorDto },
}

/// Portable Character Manager Cards blueprint. It has no absolute browser
/// bounds, CSS Modules classes, JSX, DOM IDs, or compositor handles.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CharacterManagerBlueprintV1 {
    pub revision: u64,
    pub catalog: Vec<CharacterCardBlueprintV1>,
    pub controls: CharacterManagerControlsV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dialog: Option<CharacterManagerDialogV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feedback: Option<UiFeedbackV1>,
}

/// Versioned portable blueprint union. More product surfaces add variants in a
/// later ABI version rather than altering this v1 representation in place.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "surface", content = "blueprint", rename_all = "kebab-case")]
pub enum UiBlueprintV1 {
    CharacterManager(CharacterManagerBlueprintV1),
}

/// Compiler rejection. Every error is deliberate: silently dropping an
/// unsupported React state would create the manual-parity drift this ABI is
/// intended to prevent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlueprintErrorV1 {
    SelectedCharacterMissing { character_id: String },
    SelectedCharacterMismatch { expected: String, actual: String },
    ErrorStateMissingError,
    ErrorProvidedOutsideErrorState,
}

impl fmt::Display for BlueprintErrorV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SelectedCharacterMissing { character_id } => {
                write!(formatter, "selected character is missing: {character_id}")
            }
            Self::SelectedCharacterMismatch { expected, actual } => {
                write!(
                    formatter,
                    "selected character mismatch: expected {expected}, got {actual}"
                )
            }
            Self::ErrorStateMissingError => {
                write!(formatter, "error state requires Product Wire error")
            }
            Self::ErrorProvidedOutsideErrorState => {
                write!(formatter, "Product Wire error requires error loading state")
            }
        }
    }
}

impl std::error::Error for BlueprintErrorV1 {}

fn validate_capture(capture: &CharacterManagerCaptureV1) -> Result<(), BlueprintErrorV1> {
    match (&capture.selected_character_id, &capture.selected) {
        (Some(character_id), Some(selected)) if character_id != &selected.id => {
            return Err(BlueprintErrorV1::SelectedCharacterMismatch {
                expected: character_id.clone(),
                actual: selected.id.clone(),
            });
        }
        (Some(character_id), None) => {
            if !capture
                .catalog
                .items
                .iter()
                .any(|item| item.id == *character_id)
            {
                return Err(BlueprintErrorV1::SelectedCharacterMissing {
                    character_id: character_id.clone(),
                });
            }
        }
        _ => {}
    }
    match (capture.loading, &capture.error) {
        (UiLoadStateV1::Error, None) => Err(BlueprintErrorV1::ErrorStateMissingError),
        (UiLoadStateV1::Error, Some(_)) | (_, None) => Ok(()),
        (_, Some(_)) => Err(BlueprintErrorV1::ErrorProvidedOutsideErrorState),
    }
}

/// Compiles immutable Product Wire state into a renderer-neutral blueprint.
pub fn compile_character_manager_v1(
    capture: &CaptureBundleV1,
) -> Result<UiBlueprintV1, BlueprintErrorV1> {
    validate_capture(&capture.character_manager)?;
    let state = &capture.character_manager;
    let catalog = state
        .catalog
        .items
        .iter()
        .cloned()
        .map(|character| CharacterCardBlueprintV1 {
            selected: state.selected_character_id.as_deref() == Some(character.id.as_str()),
            pinned: state.pinned_character_id.as_deref() == Some(character.id.as_str()),
            character,
        })
        .collect();
    let feedback = match (state.loading, &state.error) {
        (UiLoadStateV1::Loading, _) => Some(UiFeedbackV1::Loading),
        (UiLoadStateV1::Error, Some(error)) => Some(UiFeedbackV1::Error {
            error: error.clone(),
        }),
        (UiLoadStateV1::Ready, _) => None,
        (UiLoadStateV1::Error, None) => return Err(BlueprintErrorV1::ErrorStateMissingError),
    };
    Ok(UiBlueprintV1::CharacterManager(
        CharacterManagerBlueprintV1 {
            revision: capture.revision,
            catalog,
            controls: CharacterManagerControlsV1 {
                query: state.query.clone(),
                sort: state.sort,
                view: state.view,
                can_load_more: state.catalog.next_cursor.is_some(),
                can_retry: state.loading == UiLoadStateV1::Error,
                active_tab: state.tab,
            },
            dialog: state.dialog.clone(),
            feedback,
        },
    ))
}
