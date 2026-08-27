//! Display-time macro expansion (React `expandDisplayMacros` /
//! `packages/shared/src/macros.ts`). Streaming rows stay raw.

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

const WEEKDAYS: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MacroContext {
    pub user_name: String,
    pub char_name: String,
    pub variables: HashMap<String, String>,
    /// Injected civil time for tests. `None` uses the host clock in UTC.
    pub now: Option<CivilTime>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CivilTime {
    pub year: i32,
    pub month: u8,
    pub day: u8,
    pub hour: u8,
    pub minute: u8,
    /// 0 = Sunday … 6 = Saturday (JS `Date#getDay`).
    pub weekday: u8,
}

pub fn build_macro_context(
    user_name: impl Into<String>,
    char_name: impl Into<String>,
    variables: HashMap<String, String>,
    now: Option<CivilTime>,
) -> MacroContext {
    let user = user_name.into();
    let char_name = char_name.into();
    MacroContext {
        user_name: if user.trim().is_empty() {
            "User".into()
        } else {
            user
        },
        char_name: if char_name.trim().is_empty() {
            "Assistant".into()
        } else {
            char_name
        },
        variables,
        now,
    }
}

pub fn replace_macros(text: &str, ctx: &MacroContext) -> String {
    let with_random = expand_random(text);
    expand_vars(&with_random, ctx)
}

fn expand_random(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' && i + 1 < bytes.len() && bytes[i + 1] == b'{' {
            if let Some((end, body)) = parse_random_body(&text[i..]) {
                let options: Vec<&str> = body
                    .split('~')
                    .map(str::trim)
                    .filter(|part| !part.is_empty())
                    .collect();
                if !options.is_empty() {
                    let pick = random_index(options.len());
                    out.push_str(options[pick]);
                }
                i += end;
                continue;
            }
        }
        let ch = text[i..].chars().next().unwrap_or('\0');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn parse_random_body(rest: &str) -> Option<(usize, &str)> {
    let inner = rest.strip_prefix("{{")?;
    let close = inner.find("}}")?;
    let body_src = inner[..close].trim();
    let lower = body_src.to_ascii_lowercase();
    let after_kw = lower.strip_prefix("random")?;
    let after_src = &body_src[body_src.len() - after_kw.len()..];
    let after_colon = after_src.trim_start().strip_prefix(':')?;
    let consumed = 2 + close + 2;
    Some((consumed, after_colon.trim()))
}

fn random_index(len: usize) -> usize {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as usize)
        .unwrap_or(0);
    nanos % len.max(1)
}

fn expand_vars(text: &str, ctx: &MacroContext) -> String {
    let now = ctx.now.unwrap_or_else(system_civil_utc);
    let mut out = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' && i + 1 < bytes.len() && bytes[i + 1] == b'{' {
            if let Some((end, key)) = parse_var_key(&text[i..]) {
                out.push_str(&replace_key(key, ctx, now));
                i += end;
                continue;
            }
        }
        let ch = text[i..].chars().next().unwrap_or('\0');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn parse_var_key(rest: &str) -> Option<(usize, &str)> {
    let inner = rest.strip_prefix("{{")?;
    let trimmed = inner.trim_start();
    let skipped = inner.len() - trimmed.len();
    let key_len = trimmed
        .chars()
        .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '-')
        .map(char::len_utf8)
        .sum::<usize>();
    if key_len == 0 {
        return None;
    }
    let after_key = &trimmed[key_len..];
    let after_ws = after_key.trim_start();
    if !after_ws.starts_with("}}") {
        return None;
    }
    let consumed = 2 + skipped + key_len + (after_key.len() - after_ws.len()) + 2;
    Some((consumed, &trimmed[..key_len]))
}

fn replace_key(key: &str, ctx: &MacroContext, now: CivilTime) -> String {
    match key.to_ascii_lowercase().as_str() {
        "user" => ctx.user_name.clone(),
        "char" => ctx.char_name.clone(),
        "time" => format!("{}:{}", pad2(now.hour), pad2(now.minute)),
        "date" => format!("{}-{}-{}", now.year, pad2(now.month), pad2(now.day)),
        "datetime" => format!(
            "{}-{}-{} {}:{}",
            now.year,
            pad2(now.month),
            pad2(now.day),
            pad2(now.hour),
            pad2(now.minute)
        ),
        "year" => now.year.to_string(),
        "month" => pad2(now.month),
        "day" => pad2(now.day),
        "hour" => pad2(now.hour),
        "minute" => pad2(now.minute),
        "weekday" => WEEKDAYS[now.weekday.min(6) as usize].to_string(),
        "isnight" => {
            if now.hour >= 22 || now.hour < 6 {
                "true".into()
            } else {
                "false".into()
            }
        }
        _ => ctx
            .variables
            .get(key)
            .cloned()
            .unwrap_or_else(|| format!("{{{{{key}}}}}")),
    }
}

fn pad2(value: u8) -> String {
    format!("{value:02}")
}

fn system_civil_utc() -> CivilTime {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
        .max(0);
    civil_from_unix(secs)
}

fn civil_from_unix(secs: i64) -> CivilTime {
    let days = secs / 86_400;
    let hour = (secs % 86_400 / 3_600) as u8;
    let minute = (secs % 3_600 / 60) as u8;
    let (year, month, day) = civil_from_days(days);
    let weekday = (((days % 7) + 4) % 7) as u8;
    CivilTime {
        year,
        month,
        day,
        hour,
        minute,
        weekday,
    }
}

/// Howard Hinnant civil-from-days (days since 1970-01-01, UTC).
fn civil_from_days(z: i64) -> (i32, u8, u8) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i32 + era as i32 * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = y + i32::from(m <= 2);
    (y, m as u8, d as u8)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(user: &str, char_name: &str) -> MacroContext {
        build_macro_context(user, char_name, HashMap::new(), None)
    }

    #[test]
    fn user_and_char_and_unknown() {
        let ctx = ctx("You", "Hazel");
        assert_eq!(
            replace_macros("{{user}} meets {{char}} and {{unknown}}", &ctx),
            "You meets Hazel and {{unknown}}"
        );
        assert_eq!(replace_macros("{{ USER }}", &ctx), "You");
    }

    #[test]
    fn empty_names_fall_back() {
        let ctx = build_macro_context("  ", "", HashMap::new(), None);
        assert_eq!(replace_macros("{{user}}/{{char}}", &ctx), "User/Assistant");
    }

    #[test]
    fn time_macros_use_injected_now() {
        let now = CivilTime {
            year: 2026,
            month: 8,
            day: 12,
            hour: 23,
            minute: 5,
            weekday: 3,
        };
        let ctx = MacroContext {
            user_name: "You".into(),
            char_name: "Hazel".into(),
            variables: HashMap::new(),
            now: Some(now),
        };
        assert_eq!(replace_macros("{{time}}", &ctx), "23:05");
        assert_eq!(replace_macros("{{date}}", &ctx), "2026-08-12");
        assert_eq!(replace_macros("{{datetime}}", &ctx), "2026-08-12 23:05");
        assert_eq!(replace_macros("{{weekday}}", &ctx), "Wednesday");
        assert_eq!(replace_macros("{{isNight}}", &ctx), "true");
    }

    #[test]
    fn custom_variables_are_case_sensitive() {
        let mut variables = HashMap::new();
        variables.insert("guild".into(), "Kestrel".into());
        let ctx = build_macro_context("You", "Hazel", variables, None);
        assert_eq!(
            replace_macros("{{guild}} {{Guild}}", &ctx),
            "Kestrel {{Guild}}"
        );
    }

    #[test]
    fn random_with_one_option_is_stable() {
        let ctx = ctx("You", "Hazel");
        assert_eq!(replace_macros("{{random:only}}", &ctx), "only");
    }
}
