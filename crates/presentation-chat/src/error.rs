use contracts_generated::generated::ErrorDto;
use neotavern_presentation_dioxus_shell::ShellError;

#[derive(Debug, Clone, PartialEq)]
pub enum ChatRouteError {
    FlagDisabled,
    UnknownCommand(String),
    Wire(String),
    Json(String),
    Product(ErrorDto),
    Transport(String),
    EmptyLibrary,
    NoActiveRun,
    NoStream,
}

impl ChatRouteError {
    pub fn reason_code(&self) -> String {
        match self {
            Self::FlagDisabled => "flag_off".into(),
            Self::UnknownCommand(_) => "unknown_command".into(),
            Self::Wire(_) => "wire".into(),
            Self::Json(_) => "json".into(),
            Self::Product(err) => err.code.clone(),
            Self::Transport(_) => "transport".into(),
            Self::EmptyLibrary => "EMPTY_LIBRARY".into(),
            Self::NoActiveRun => "GENERATION_RUN_NOT_FOUND".into(),
            Self::NoStream => "NO_STREAM".into(),
        }
    }

    pub fn product(code: &str, params: serde_json::Value) -> Self {
        Self::Product(ErrorDto {
            code: code.to_string(),
            params,
            trace_id: None,
            correlation_id: None,
        })
    }
}

impl std::fmt::Display for ChatRouteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::FlagDisabled => write!(f, "NEOTA_DIOXUS_SHELL must be 1"),
            Self::UnknownCommand(id) => {
                write!(
                    f,
                    "presentation command is not a Product Wire operation: {id}"
                )
            }
            Self::Wire(msg) | Self::Json(msg) | Self::Transport(msg) => write!(f, "{msg}"),
            Self::Product(err) => write!(f, "{}", err.code),
            Self::EmptyLibrary => write!(f, "EMPTY_LIBRARY"),
            Self::NoActiveRun => write!(f, "GENERATION_RUN_NOT_FOUND"),
            Self::NoStream => write!(f, "NO_STREAM"),
        }
    }
}

impl From<ShellError> for ChatRouteError {
    fn from(err: ShellError) -> Self {
        match err {
            ShellError::FlagDisabled => Self::FlagDisabled,
            ShellError::UnknownCommand(id) => Self::UnknownCommand(id),
            ShellError::Json(msg) => Self::Json(msg),
            ShellError::Wire(msg) => Self::Wire(msg),
        }
    }
}

impl From<serde_json::Error> for ChatRouteError {
    fn from(err: serde_json::Error) -> Self {
        Self::Json(err.to_string())
    }
}
