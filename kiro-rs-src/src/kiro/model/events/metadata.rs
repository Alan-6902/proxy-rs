//! 消息元数据事件
//!
//! 处理 metadataEvent / messageMetadataEvent 类型的事件，其中的 `tokenUsage`
//! 带有上游 prompt cache 的读写分解，是衡量缓存命中率的唯一真实来源。

use serde::Deserialize;

use crate::kiro::parser::error::ParseResult;
use crate::kiro::parser::frame::Frame;

use super::base::EventPayload;

/// 消息元数据事件
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataEvent {
    /// token 使用量（上游不一定每次都给）
    #[serde(default)]
    pub token_usage: Option<TokenUsage>,
}

/// 上游 token 使用量分解
///
/// 输入总量 = `uncached_input_tokens + cache_read_input_tokens + cache_write_input_tokens`
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    #[serde(default)]
    pub uncached_input_tokens: i64,
    #[serde(default)]
    pub cache_read_input_tokens: i64,
    #[serde(default)]
    pub cache_write_input_tokens: i64,
    #[serde(default)]
    pub output_tokens: i64,
}

impl TokenUsage {
    /// 输入总量（未缓存 + 缓存读 + 缓存写）
    pub fn total_input_tokens(&self) -> i64 {
        self.uncached_input_tokens + self.cache_read_input_tokens + self.cache_write_input_tokens
    }

    /// 缓存命中率：缓存读 / 输入总量，输入为 0 时返回 `None`
    pub fn cache_hit_rate(&self) -> Option<f64> {
        let total = self.total_input_tokens();
        (total > 0).then(|| self.cache_read_input_tokens as f64 / total as f64)
    }

    /// 日志正文，格式同其它请求日志：`[Tag] key: value, key: value`
    fn log_line(&self, model: &str) -> String {
        format!(
            "[Cache] model: {}, read: {}, write: {}, uncached: {}, hit: {}",
            model,
            self.cache_read_input_tokens,
            self.cache_write_input_tokens,
            self.uncached_input_tokens,
            self.cache_hit_rate()
                .map(|r| format!("{:.1}%", r * 100.0))
                .unwrap_or_else(|| "N/A".to_string())
        )
    }
}

/// 请求结束时打一行 `[Cache]` 日志
///
/// 只在上游给了 `tokenUsage` 时打。实测 generateAssistantResponse 目前不返回
/// 缓存分解，每条都打 N/A 只是噪音。
pub fn log_cache_summary(model: &str, usage: Option<&TokenUsage>) {
    if let Some(u) = usage {
        tracing::info!("{}", u.log_line(model));
    }
}

impl EventPayload for MetadataEvent {
    fn from_frame(frame: &Frame) -> ParseResult<Self> {
        frame.payload_as_json()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_token_usage() {
        let json = r#"{"tokenUsage":{"uncachedInputTokens":100,"cacheReadInputTokens":800,"cacheWriteInputTokens":100,"outputTokens":50,"totalTokens":1050,"contextUsagePercentage":0.5}}"#;
        let event: MetadataEvent = serde_json::from_str(json).unwrap();
        let usage = event.token_usage.unwrap();
        assert_eq!(usage.total_input_tokens(), 1000);
        assert_eq!(usage.output_tokens, 50);
        assert_eq!(usage.cache_hit_rate(), Some(0.8));
        assert_eq!(
            usage.log_line("claude-sonnet-4.5"),
            "[Cache] model: claude-sonnet-4.5, read: 800, write: 100, uncached: 100, hit: 80.0%"
        );
    }

    #[test]
    fn test_parse_without_token_usage() {
        let event: MetadataEvent = serde_json::from_str("{}").unwrap();
        assert!(event.token_usage.is_none());
        assert_eq!(TokenUsage::default().cache_hit_rate(), None);
        assert!(TokenUsage::default().log_line("m").ends_with("hit: N/A"));
    }
}
