//! Chat markdown matching `apps/web/src/lib/markdown.ts` (React golden, read-only).
//!
//! Renders a Dioxus RSX tree with the same `data-component` / `data-part`
//! hooks. Blitz never receives raw HTML or `dangerouslySetInnerHTML`.

use dioxus_core::Element;
use dioxus_core_macro::rsx;

#[derive(Clone, Debug, PartialEq)]
pub enum Inline {
    Text(String),
    Code(String),
    Strong(Vec<Inline>),
    Emphasis(Vec<Inline>),
    Quote(Vec<Inline>),
    Link { href: String, children: Vec<Inline> },
    Image { src: String, alt: String },
}

#[derive(Clone, Debug, PartialEq)]
pub enum Block {
    Heading {
        level: u8,
        children: Vec<Inline>,
    },
    Paragraph(Vec<Inline>),
    List {
        ordered: bool,
        items: Vec<Vec<Inline>>,
    },
    Quote(Vec<Inline>),
    Rule,
}

pub fn parse_document(value: &str) -> Vec<Block> {
    let source = value.replace("\r\n", "\n").replace('\r', "\n");
    source
        .split("\n\n")
        .map(str::trim)
        .filter(|block| !block.is_empty())
        .map(parse_block)
        .collect()
}

fn parse_block(block: &str) -> Block {
    if block == "---" {
        return Block::Rule;
    }
    if let Some(heading) = parse_heading(block) {
        return heading;
    }
    if is_list_block(block, false) {
        return Block::List {
            ordered: false,
            items: list_items(block, false),
        };
    }
    if is_list_block(block, true) {
        return Block::List {
            ordered: true,
            items: list_items(block, true),
        };
    }
    if block
        .lines()
        .all(|line| line.starts_with("> ") || line == ">")
    {
        let joined = block
            .lines()
            .map(|line| {
                line.strip_prefix("> ")
                    .unwrap_or(line.strip_prefix('>').unwrap_or(line))
            })
            .collect::<Vec<_>>()
            .join(" ");
        return Block::Quote(parse_inline(&joined));
    }
    Block::Paragraph(parse_inline(block))
}

fn parse_heading(block: &str) -> Option<Block> {
    if block.contains('\n') {
        return None;
    }
    for level in (1..=6).rev() {
        let prefix = format!("{} ", "#".repeat(level));
        if let Some(rest) = block.strip_prefix(&prefix) {
            return Some(Block::Heading {
                level: level as u8,
                children: parse_inline(rest),
            });
        }
    }
    None
}

fn is_list_block(block: &str, ordered: bool) -> bool {
    !block.is_empty()
        && block.lines().all(|line| {
            if ordered {
                ordered_marker(line).is_some()
            } else {
                line.starts_with("- ") || line.starts_with("* ") || line.starts_with("+ ")
            }
        })
}

fn ordered_marker(line: &str) -> Option<&str> {
    let digits = line.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    let rest = &line[digits..];
    rest.strip_prefix(") ").or_else(|| rest.strip_prefix(". "))
}

fn list_items(block: &str, ordered: bool) -> Vec<Vec<Inline>> {
    block
        .lines()
        .filter_map(|line| {
            let body = if ordered {
                ordered_marker(line)?
            } else {
                line.strip_prefix("- ")
                    .or_else(|| line.strip_prefix("* "))
                    .or_else(|| line.strip_prefix("+ "))?
            };
            Some(parse_inline(body))
        })
        .collect()
}

pub fn parse_inline(value: &str) -> Vec<Inline> {
    let (with_code, codes) = extract_delimited(value, '`', "@@md-code-");
    let (with_pipes, pipes) = extract_pipes(&with_code);
    let quoted = split_quotes(&with_pipes);
    let with_images = map_text(quoted, &split_images);
    let with_links = map_text(with_images, &split_links);
    let with_strong = map_text(with_links, &|text: &str| {
        split_delimited(text, "**", Inline::Strong)
    });
    let with_strong2 = map_text(with_strong, &|text: &str| {
        split_delimited(text, "__", Inline::Strong)
    });
    let with_em = map_text(with_strong2, &|text: &str| {
        split_delimited(text, "*", Inline::Emphasis)
    });
    let with_em2 = map_text(with_em, &|text: &str| {
        split_delimited(text, "_", Inline::Emphasis)
    });
    restore_placeholders(with_em2, &pipes, &codes)
}

fn extract_delimited(value: &str, delim: char, prefix: &str) -> (String, Vec<String>) {
    let mut out = String::new();
    let mut spans = Vec::new();
    let mut rest = value;
    let delim_s = delim.to_string();
    while let Some(start) = rest.find(delim) {
        out.push_str(&rest[..start]);
        rest = &rest[start + delim_s.len()..];
        match rest.find(delim) {
            Some(end) => {
                let token = format!("{prefix}{}@@", spans.len());
                spans.push(rest[..end].to_string());
                out.push_str(&token);
                rest = &rest[end + delim_s.len()..];
            }
            None => {
                out.push(delim);
                out.push_str(rest);
                return (out, spans);
            }
        }
    }
    out.push_str(rest);
    (out, spans)
}

fn extract_pipes(value: &str) -> (String, Vec<String>) {
    let mut out = String::new();
    let mut spans = Vec::new();
    let mut rest = value;
    while let Some(start) = rest.find('|') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let line_end = after.find('\n').unwrap_or(after.len());
        match after[..line_end].find('|') {
            Some(end) => {
                let token = format!("@@md-pipe-{}@@", spans.len());
                spans.push(format!("|{}|", &after[..end]));
                out.push_str(&token);
                rest = &after[end + 1..];
            }
            None => {
                out.push('|');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    (out, spans)
}

fn restore_placeholders(nodes: Vec<Inline>, pipes: &[String], codes: &[String]) -> Vec<Inline> {
    let restored_pipes = map_text(nodes, &|text: &str| {
        replace_tokens(text, "@@md-pipe-", pipes, false)
    });
    map_text(restored_pipes, &|text: &str| {
        replace_tokens(text, "@@md-code-", codes, true)
    })
}

fn replace_tokens(text: &str, prefix: &str, spans: &[String], as_code: bool) -> Vec<Inline> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find(prefix) {
        if start > 0 {
            push_text(&mut out, &rest[..start]);
        }
        let body = &rest[start + prefix.len()..];
        let Some(idx_end) = body.find("@@") else {
            push_text(&mut out, rest);
            return out;
        };
        let Ok(index) = body[..idx_end].parse::<usize>() else {
            push_text(&mut out, prefix);
            rest = &rest[start + prefix.len()..];
            continue;
        };
        let token_len = prefix.len() + idx_end + 2;
        if let Some(span) = spans.get(index) {
            if as_code {
                out.push(Inline::Code(span.clone()));
            } else {
                push_text(&mut out, span);
            }
        }
        rest = &rest[start + token_len..];
    }
    push_text(&mut out, rest);
    out
}

fn map_text<F: Fn(&str) -> Vec<Inline>>(nodes: Vec<Inline>, f: &F) -> Vec<Inline> {
    let mut out = Vec::new();
    for node in nodes {
        match node {
            Inline::Text(text) => out.extend(f(&text)),
            Inline::Strong(children) => out.push(Inline::Strong(map_text(children, f))),
            Inline::Emphasis(children) => out.push(Inline::Emphasis(map_text(children, f))),
            Inline::Quote(children) => out.push(Inline::Quote(map_text(children, f))),
            Inline::Link { href, children } => out.push(Inline::Link {
                href,
                children: map_text(children, f),
            }),
            other => out.push(other),
        }
    }
    out
}

fn split_quotes(value: &str) -> Vec<Inline> {
    split_paired(
        value,
        &[
            ("\"", "\""),
            ("\u{201C}", "\u{201D}"),
            ("\u{00AB}", "\u{00BB}"),
            ("\u{300C}", "\u{300D}"),
            ("\u{300E}", "\u{300F}"),
            ("\u{FF02}", "\u{FF02}"),
        ],
        |inner| Inline::Quote(vec![Inline::Text(inner.to_string())]),
    )
}

fn split_images(value: &str) -> Vec<Inline> {
    let mut out = Vec::new();
    let mut rest = value;
    while let Some(start) = rest.find("![") {
        if start > 0 {
            push_text(&mut out, &rest[..start]);
        }
        let after_alt = &rest[start + 2..];
        let Some(alt_end) = after_alt.find("](") else {
            push_text(&mut out, &rest[start..]);
            return out;
        };
        let alt = &after_alt[..alt_end];
        let after_url = &after_alt[alt_end + 2..];
        let Some(url_end) = after_url.find(')') else {
            push_text(&mut out, &rest[start..]);
            return out;
        };
        let src = &after_url[..url_end];
        if src.starts_with("https://") || src.starts_with("http://") {
            out.push(Inline::Image {
                src: src.to_string(),
                alt: alt.to_string(),
            });
            rest = &after_url[url_end + 1..];
        } else {
            push_text(
                &mut out,
                &rest[start..start + 2 + alt_end + 2 + url_end + 1],
            );
            rest = &after_url[url_end + 1..];
        }
    }
    push_text(&mut out, rest);
    out
}

fn split_links(value: &str) -> Vec<Inline> {
    let mut out = Vec::new();
    let mut rest = value;
    while let Some(start) = rest.find('[') {
        if start > 0 {
            push_text(&mut out, &rest[..start]);
        }
        if rest[start..].starts_with("![") {
            push_text(&mut out, "[");
            rest = &rest[start + 1..];
            continue;
        }
        let after_label = &rest[start + 1..];
        let Some(label_end) = after_label.find("](") else {
            push_text(&mut out, &rest[start..]);
            return out;
        };
        let label = &after_label[..label_end];
        let after_url = &after_label[label_end + 2..];
        let Some(url_end) = after_url.find(')') else {
            push_text(&mut out, &rest[start..]);
            return out;
        };
        let href = &after_url[..url_end];
        if href.starts_with("https://") || href.starts_with("http://") {
            out.push(Inline::Link {
                href: href.to_string(),
                children: vec![Inline::Text(label.to_string())],
            });
            rest = &after_url[url_end + 1..];
        } else {
            push_text(
                &mut out,
                &rest[start..start + 1 + label_end + 2 + url_end + 1],
            );
            rest = &after_url[url_end + 1..];
        }
    }
    push_text(&mut out, rest);
    out
}

fn split_delimited(value: &str, delim: &str, wrap: fn(Vec<Inline>) -> Inline) -> Vec<Inline> {
    let mut out = Vec::new();
    let mut rest = value;
    while let Some(start) = rest.find(delim) {
        if start > 0 {
            push_text(&mut out, &rest[..start]);
        }
        let after = &rest[start + delim.len()..];
        match after.find(delim) {
            Some(end) if end > 0 => {
                out.push(wrap(vec![Inline::Text(after[..end].to_string())]));
                rest = &after[end + delim.len()..];
            }
            _ => {
                push_text(&mut out, delim);
                rest = after;
            }
        }
    }
    push_text(&mut out, rest);
    out
}

fn split_paired(value: &str, pairs: &[(&str, &str)], wrap: impl Fn(&str) -> Inline) -> Vec<Inline> {
    let mut out = Vec::new();
    let mut rest = value;
    while !rest.is_empty() {
        let mut hit: Option<(usize, &str, &str)> = None;
        for (open, close) in pairs {
            if let Some(at) = rest.find(open) {
                if hit.map(|(best, _, _)| at < best).unwrap_or(true) {
                    hit = Some((at, *open, *close));
                }
            }
        }
        let Some((at, open, close)) = hit else {
            push_text(&mut out, rest);
            break;
        };
        if at > 0 {
            push_text(&mut out, &rest[..at]);
        }
        let after = &rest[at + open.len()..];
        match after.find(close) {
            Some(end) => {
                let inner = &after[..end];
                let mut quoted = wrap(inner);
                if let Inline::Quote(children) = &mut quoted {
                    if children.is_empty() {
                        children.push(Inline::Text(format!("{open}{inner}{close}")));
                    } else {
                        let mut wrapped = vec![Inline::Text(open.to_string())];
                        wrapped.extend(children.clone());
                        wrapped.push(Inline::Text(close.to_string()));
                        *children = wrapped;
                    }
                }
                out.push(quoted);
                rest = &after[end + close.len()..];
            }
            None => {
                push_text(&mut out, open);
                rest = after;
            }
        }
    }
    out
}

fn push_text(out: &mut Vec<Inline>, text: &str) {
    if !text.is_empty() {
        out.push(Inline::Text(text.to_string()));
    }
}

pub fn contains_part(nodes: &[Inline], part: &str) -> bool {
    nodes.iter().any(|node| match node {
        Inline::Code(_) => part == "message-code",
        Inline::Strong(children) => part == "message-strong" || contains_part(children, part),
        Inline::Emphasis(children) => part == "message-emphasis" || contains_part(children, part),
        Inline::Quote(children) => part == "message-quote" || contains_part(children, part),
        Inline::Link { children, .. } => part == "message-link" || contains_part(children, part),
        Inline::Image { .. } => part == "message-image",
        Inline::Text(_) => false,
    })
}

pub fn message_markdown(text: &str, streaming: bool) -> Element {
    if text.is_empty() {
        if streaming {
            return rsx! {
                span {
                    "data-component": "message-markdown",
                    "data-format": "markdown",
                    "data-part": "typing",
                    "data-state": "streaming",
                    "..."
                }
            };
        }
        return rsx! {};
    }
    let blocks = parse_document(text);
    let state = if streaming { "streaming" } else { "done" };
    rsx! {
        div {
            class: "MessageMarkdown_root",
            "data-component": "message-markdown",
            "data-format": "markdown",
            "data-state": "{state}",
            article {
                class: "MessageMarkdown_chat-message-markdown chat-message-markdown",
                for block in blocks.iter() {
                    {render_block(block)}
                }
            }
        }
    }
}

fn render_block(block: &Block) -> Element {
    match block {
        Block::Rule => rsx! { hr {} },
        Block::Heading { level, children } => match *level {
            1 => rsx! { h1 { {render_inlines(children)} } },
            2 => rsx! { h2 { {render_inlines(children)} } },
            3 => rsx! { h3 { {render_inlines(children)} } },
            4 => rsx! { h4 { {render_inlines(children)} } },
            5 => rsx! { h5 { {render_inlines(children)} } },
            _ => rsx! { h6 { {render_inlines(children)} } },
        },
        Block::Paragraph(children) => rsx! { p { {render_inlines(children)} } },
        Block::Quote(children) => rsx! { blockquote { {render_inlines(children)} } },
        Block::List {
            ordered: false,
            items,
        } => rsx! {
            ul {
                for item in items.iter() {
                    li { {render_inlines(item)} }
                }
            }
        },
        Block::List {
            ordered: true,
            items,
        } => rsx! {
            ol {
                for item in items.iter() {
                    li { {render_inlines(item)} }
                }
            }
        },
    }
}

fn render_inlines(nodes: &[Inline]) -> Element {
    rsx! {
        for node in nodes.iter() {
            {render_inline(node)}
        }
    }
}

fn render_inline(node: &Inline) -> Element {
    match node {
        Inline::Text(text) => rsx! { "{text}" },
        Inline::Code(text) => rsx! {
            code { "data-part": "message-code", "{text}" }
        },
        Inline::Strong(children) => rsx! {
            strong { "data-part": "message-strong", {render_inlines(children)} }
        },
        Inline::Emphasis(children) => rsx! {
            em { "data-part": "message-emphasis", {render_inlines(children)} }
        },
        Inline::Quote(children) => rsx! {
            q { "data-part": "message-quote", {render_inlines(children)} }
        },
        Inline::Link { href, children } => rsx! {
            span {
                "data-part": "message-link",
                title: "{href}",
                {render_inlines(children)}
            }
        },
        Inline::Image { alt, .. } => rsx! {
            span {
                "data-part": "message-image",
                "aria-label": "{alt}",
                style: "display:block;max-width:100%;height:32px;background:#3a4a60;",
            }
        },
    }
}
