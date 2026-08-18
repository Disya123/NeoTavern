//! Product-path PERF-01/02/16 catalog: Product Wire DTOs for a 10k mixed
//! chat. The VirtualDom only mounts the visible window plus glass chrome.

use std::cell::RefCell;

use serde_json::{json, Value};

use crate::{CanonicalFixture, FixtureCommand, StreamEvent};

pub const PRODUCT_PATH_ITEMS: u32 = 10_000;
pub const PRODUCT_PATH_VISIBLE: usize = 12;
pub const PRODUCT_PATH_CHAT_ID: &str = "7f3a2b4c-1d2e-4f5a-8b9c-0d1e2f3a4b5c";
pub const PRODUCT_PATH_CHARACTER_ID: &str = "4f2f0a1e-9b3c-4d5e-8f6a-7b8c9d0e1f2a";
pub const PRODUCT_PATH_PERSONA_ID: &str = "0d1e2f3a-4b5c-4d6e-8f90-1a2b3c4d5e6f";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RowKind {
    Markdown,
    Image,
    Mixed,
}

#[derive(Clone, Debug, PartialEq)]
pub struct VisibleRow {
    pub id: String,
    pub role: String,
    pub content: String,
    pub kind: RowKind,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ProductChrome {
    #[default]
    HeaderComposer,
    TripleGlass,
    NestedDialog,
    PaintOrder,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProductChatView {
    pub title: String,
    pub message_count: usize,
    pub visible: Vec<VisibleRow>,
    pub chrome: ProductChrome,
}

impl Default for ProductChatView {
    fn default() -> Self {
        Self {
            title: "Product path".into(),
            message_count: 0,
            visible: Vec::new(),
            chrome: ProductChrome::HeaderComposer,
        }
    }
}

thread_local! {
    static PRODUCT_CHAT: RefCell<ProductChatView> = RefCell::new(ProductChatView::default());
}

pub fn mixed_height(index: u32) -> f64 {
    48.0 + f64::from(index % 7) * 12.0 + if index.is_multiple_of(11) { 80.0 } else { 0.0 }
}

pub fn message_id(index: u32) -> String {
    format!("00000000-0000-4000-8000-{:012x}", u64::from(index) + 1)
}

fn row_kind(index: u32) -> RowKind {
    match index % 5 {
        0 => RowKind::Markdown,
        1 => RowKind::Image,
        _ => RowKind::Mixed,
    }
}

fn row_role(index: u32) -> &'static str {
    if index.is_multiple_of(2) {
        "user"
    } else {
        "assistant"
    }
}

fn row_content(index: u32) -> String {
    match row_kind(index) {
        RowKind::Markdown => {
            format!("**msg {index}**\n\n- item one\n- `code fence`\n\nParagraph with *emphasis*.")
        }
        RowKind::Image => format!("![photo {index}](asset:thumb-{index})"),
        RowKind::Mixed => {
            format!("**mixed {index}** with an image\n\n![thumb](asset:thumb-{index})")
        }
    }
}

pub fn mixed_height_catalog(count: u32) -> CanonicalFixture {
    let messages: Vec<Value> = (0..count)
        .map(|index| {
            json!({
                "id": message_id(index),
                "chatId": PRODUCT_PATH_CHAT_ID,
                "role": row_role(index),
                "content": row_content(index),
                "createdAt": "2026-08-12T10:00:00Z",
                "sequence": i64::from(index),
                "meta": { "manualExcluded": false }
            })
        })
        .collect();
    CanonicalFixture {
        chat: json!({
            "id": PRODUCT_PATH_CHAT_ID,
            "title": "10k mixed chat",
            "characterId": PRODUCT_PATH_CHARACTER_ID,
            "personaId": PRODUCT_PATH_PERSONA_ID,
            "messageCount": i64::from(count),
            "createdAt": "2026-08-12T10:00:00Z",
            "updatedAt": "2026-08-12T10:00:00Z"
        }),
        messages,
        commands: vec![
            FixtureCommand {
                wire_operation_id: "chats.get".into(),
            },
            FixtureCommand {
                wire_operation_id: "chats.messages.list".into(),
            },
            FixtureCommand {
                wire_operation_id: "generation.start".into(),
            },
        ],
        stream: streaming_schedule(24),
        stream_cap: 8,
    }
}

/// Real streaming schedule: many tokens per generation, plus stale events.
pub fn streaming_schedule(generations: u64) -> Vec<StreamEvent> {
    let mut events = Vec::new();
    for generation in 1..=generations {
        for part in 0..6u32 {
            events.push(StreamEvent {
                generation,
                text: format!("tok{generation}-{part} "),
            });
        }
        if generation > 1 {
            events.push(StreamEvent {
                generation: generation - 1,
                text: "stale".into(),
            });
        }
    }
    events
}

pub fn visible_rows(fixture: &CanonicalFixture, start: usize) -> Vec<VisibleRow> {
    let end = (start + PRODUCT_PATH_VISIBLE).min(fixture.messages.len());
    fixture.messages[start..end]
        .iter()
        .enumerate()
        .map(|(offset, value)| {
            let index = start as u32 + offset as u32;
            VisibleRow {
                id: value
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                role: value
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or("assistant")
                    .to_string(),
                content: value
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                kind: row_kind(index),
            }
        })
        .collect()
}

pub fn install_product_chat(view: ProductChatView) {
    PRODUCT_CHAT.with(|slot| *slot.borrow_mut() = view);
}

pub fn current_product_chat() -> ProductChatView {
    PRODUCT_CHAT.with(|slot| slot.borrow().clone())
}

pub fn product_chat_from_fixture(fixture: &CanonicalFixture, start: usize) -> ProductChatView {
    ProductChatView {
        title: fixture
            .chat
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("chat")
            .to_string(),
        message_count: fixture.messages.len(),
        visible: visible_rows(fixture, start),
        chrome: ProductChrome::HeaderComposer,
    }
}

pub fn product_chat_with_chrome(
    fixture: &CanonicalFixture,
    start: usize,
    chrome: ProductChrome,
) -> ProductChatView {
    let mut view = product_chat_from_fixture(fixture, start);
    view.chrome = chrome;
    view
}
