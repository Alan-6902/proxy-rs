//! 日志输出格式
//!
//! 每行形如 `[2026-09-10T09:35:58.332Z] [INFO] [Tag] 消息`：
//! - 时间为 UTC、毫秒精度；
//! - 消息自带 `[Tag]` 前缀时原样输出，否则用模块名（`token_manager` → `TokenManager`）补上；
//! - 结构化字段追加在消息后面：`消息 (key: value, key: value)`。
//!
//! proxy-rs 按这个格式解析 kiro-rs 的输出（`proxy-rs/src/main/accountDb/kiroRsView.ts`），
//! 改格式时两边要一起改。

use std::fmt::{self, Write as _};

use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::fmt::format::Writer;
use tracing_subscriber::fmt::{FmtContext, FormatEvent, FormatFields};
use tracing_subscriber::registry::LookupSpan;

/// 时间戳格式：2026-09-10T09:35:58.332Z
const TIMESTAMP_FORMAT: &str = "%Y-%m-%dT%H:%M:%S%.3fZ";

/// 顶层模块（`kiro_rs` 本身，如 main.rs）的标签
const ROOT_TAG: &str = "Main";

/// kiro-rs 的日志格式，见模块文档
pub struct ProxyLogFormat;

impl<S, N> FormatEvent<S, N> for ProxyLogFormat
where
    S: Subscriber + for<'a> LookupSpan<'a>,
    N: for<'a> FormatFields<'a> + 'static,
{
    fn format_event(
        &self,
        _ctx: &FmtContext<'_, S, N>,
        mut writer: Writer<'_>,
        event: &Event<'_>,
    ) -> fmt::Result {
        let mut visitor = FieldCollector::default();
        event.record(&mut visitor);
        let meta = event.metadata();
        let line = format_line(
            &chrono::Utc::now().format(TIMESTAMP_FORMAT).to_string(),
            meta.level(),
            meta.target(),
            &visitor.message,
            &visitor.fields,
            writer.has_ansi_escapes(),
        );
        writeln!(writer, "{}", line)
    }
}

/// 拼出一行日志（不含换行）
fn format_line(
    timestamp: &str,
    level: &Level,
    target: &str,
    message: &str,
    fields: &[(String, String)],
    ansi: bool,
) -> String {
    let level_text = format!("[{}]", level);
    let level_text = if ansi {
        format!("{}{}\x1b[0m", level_color(level), level_text)
    } else {
        level_text
    };

    let mut body = if has_tag(message) {
        message.to_string()
    } else {
        format!("[{}] {}", tag_from_target(target), message)
    };
    if !fields.is_empty() {
        let joined = fields
            .iter()
            .map(|(k, v)| format!("{}: {}", k, v))
            .collect::<Vec<_>>()
            .join(", ");
        let _ = write!(body, " ({})", joined);
    }

    format!("[{}] {} {}", timestamp, level_text, body)
}

/// 消息是否已自带 `[Tag]` 前缀
fn has_tag(message: &str) -> bool {
    message.starts_with('[') && message.find(']').is_some_and(|end| end > 1)
}

/// 模块路径 → 标签：`kiro_rs::kiro::token_manager` → `TokenManager`
fn tag_from_target(target: &str) -> String {
    let last = target.rsplit("::").next().unwrap_or(target);
    if target == "kiro_rs" || last.is_empty() {
        return ROOT_TAG.to_string();
    }
    last.split('_')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().chain(chars).collect::<String>(),
                None => String::new(),
            }
        })
        .collect()
}

/// 级别配色，与终端日志查看器的习惯一致
fn level_color(level: &Level) -> &'static str {
    match *level {
        Level::ERROR => "\x1b[31m",
        Level::WARN => "\x1b[33m",
        Level::INFO => "\x1b[34m",
        _ => "\x1b[2m",
    }
}

/// 收集事件的 message 与其余结构化字段
#[derive(Default)]
struct FieldCollector {
    message: String,
    fields: Vec<(String, String)>,
}

impl Visit for FieldCollector {
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message = value.to_string();
        } else {
            self.fields
                .push((field.name().to_string(), value.to_string()));
        }
    }

    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        if field.name() == "message" {
            self.message = format!("{:?}", value);
        } else {
            self.fields
                .push((field.name().to_string(), format!("{:?}", value)));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TS: &str = "2026-09-10T09:35:58.332Z";

    #[test]
    fn test_message_with_tag_is_kept() {
        assert_eq!(
            format_line(
                TS,
                &Level::INFO,
                "kiro_rs::anthropic::handlers",
                "[API] Request for model: m, stream: true",
                &[],
                false
            ),
            "[2026-09-10T09:35:58.332Z] [INFO] [API] Request for model: m, stream: true"
        );
    }

    #[test]
    fn test_tag_derived_from_module() {
        assert_eq!(
            format_line(
                TS,
                &Level::WARN,
                "kiro_rs::kiro::token_manager",
                "凭据 #2 刷新失败",
                &[],
                false
            ),
            "[2026-09-10T09:35:58.332Z] [WARN] [TokenManager] 凭据 #2 刷新失败"
        );
        assert_eq!(tag_from_target("kiro_rs"), "Main");
        assert_eq!(tag_from_target("hyper_util::client::legacy"), "Legacy");
    }

    #[test]
    fn test_fields_appended() {
        let fields = vec![("query".to_string(), "rust".to_string())];
        assert_eq!(
            format_line(
                TS,
                &Level::INFO,
                "kiro_rs::anthropic::websearch",
                "处理 WebSearch 请求",
                &fields,
                false
            ),
            "[2026-09-10T09:35:58.332Z] [INFO] [Websearch] 处理 WebSearch 请求 (query: rust)"
        );
    }

    #[test]
    fn test_ansi_colors_only_level() {
        let line = format_line(TS, &Level::ERROR, "kiro_rs", "[Main] boom", &[], true);
        assert_eq!(
            line,
            "[2026-09-10T09:35:58.332Z] \x1b[31m[ERROR]\x1b[0m [Main] boom"
        );
    }

    #[test]
    fn test_bracket_alone_is_not_tag() {
        assert!(!has_tag("[] x"));
        assert!(has_tag("[POST] /v1/messages 200 (12ms)"));
    }
}
