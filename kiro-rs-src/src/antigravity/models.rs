//! Antigravity 模型映射与规格
//!
//! 客户端传来的 Anthropic 模型名映射到 Antigravity 上游模型 id；
//! Gemini 模型名原样透传（只处理少数已知别名）。

use super::consts::{DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_THINKING_BUDGET};

pub const CLAUDE_OPUS: &str = "claude-opus-4-6-thinking";
pub const CLAUDE_SONNET: &str = "claude-sonnet-4-6-thinking";
const GEMINI_PRO_AGENT: &str = "gemini-pro-agent";
const CLAUDE_PREFIX: &str = "claude-";

/// `/ag/v1/models` 对外列出的模型：(模型 id, 展示名)
pub const PUBLIC_MODELS: &[(&str, &str)] = &[
    (CLAUDE_OPUS, "Claude Opus 4.6 (Thinking)"),
    (CLAUDE_SONNET, "Claude Sonnet 4.6 (Thinking)"),
    ("gemini-3.1-pro-high", "Gemini 3.1 Pro (High)"),
    ("gemini-3.1-pro-low", "Gemini 3.1 Pro (Low)"),
    ("gemini-3.7-flash-high", "Gemini 3.7 Flash (High)"),
    ("gemini-3.7-flash-medium", "Gemini 3.7 Flash (Medium)"),
    ("gemini-3.7-flash-low", "Gemini 3.7 Flash (Low)"),
    ("gemini-3.5-flash-high", "Gemini 3.5 Flash (High)"),
    ("gemini-3.5-flash-medium", "Gemini 3.5 Flash (Medium)"),
    ("gemini-3.5-flash-low", "Gemini 3.5 Flash (Low)"),
    ("gemini-3-flash", "Gemini 3 Flash"),
];

pub const CLAUDE_CONTEXT_WINDOW: i32 = 200_000;
pub const GEMINI_CONTEXT_WINDOW: i32 = 1_048_576;

/// 已知别名：(客户端模型名, 上游模型 id)
const ALIASES: &[(&str, &str)] = &[
    ("gemini-3.1-pro-high", GEMINI_PRO_AGENT),
    ("gemini-3.1-pro", GEMINI_PRO_AGENT),
    ("gemini-3.1-pro-preview", GEMINI_PRO_AGENT),
    ("gemini-3-pro-high", GEMINI_PRO_AGENT),
    ("gemini-3-flash-preview", "gemini-3-flash"),
];

/// 规格别名：未分档的 flash 按 high 档计算预算
const SPEC_ALIASES: &[(&str, &str)] = &[
    ("gemini-3.7-flash", "gemini-3.7-flash-high"),
    ("gemini-3.7-flash-tiered", "gemini-3.7-flash-high"),
    ("gemini-3.6-flash", "gemini-3.7-flash-high"),
    ("gemini-3.6-flash-tiered", "gemini-3.7-flash-high"),
    ("gemini-3.6-flash-high", "gemini-3.7-flash-high"),
    ("gemini-3.6-flash-medium", "gemini-3.7-flash-medium"),
    ("gemini-3.6-flash-low", "gemini-3.7-flash-low"),
];

/// 模型规格：(模型 id, 最大输出, 默认 thinking 预算)
const SPECS: &[(&str, i32, i32)] = &[
    ("gemini-3.7-flash-high", 65_536, 10_000),
    ("gemini-3.7-flash-medium", 65_536, 4_000),
    ("gemini-3.7-flash-low", 65_536, 1_000),
    ("gemini-3.5-flash-high", 65_536, 10_000),
    ("gemini-3.5-flash-medium", 65_536, 4_000),
    ("gemini-3.5-flash-low", 65_536, 1_000),
    ("gemini-3.5-flash-extra-low", 65_536, 1_000),
    ("gemini-3-flash", 65_536, 32_768),
    ("gemini-3.1-pro-low", 65_536, 32_768),
    (GEMINI_PRO_AGENT, 65_536, 32_768),
    (CLAUDE_SONNET, 64_000, 32_768),
    (CLAUDE_OPUS, 64_000, 24_576),
];

fn lookup<'a>(table: &'a [(&str, &str)], key: &str) -> Option<&'a str> {
    table.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

/// 客户端模型名 → 上游模型 id
///
/// 任意 `claude-*opus*` 走 Opus，其余 `claude-*`（Sonnet / Haiku / 新版本号）走 Sonnet，
/// 这样 Claude Code 的默认模型名不用逐个登记。
pub fn map_model(input: &str) -> String {
    let normalized = input.trim().to_lowercase();
    if let Some(target) = lookup(ALIASES, &normalized) {
        return target.to_string();
    }
    if normalized.starts_with(CLAUDE_PREFIX) {
        return if normalized.contains("opus") { CLAUDE_OPUS } else { CLAUDE_SONNET }.to_string();
    }
    input.trim().to_string()
}

fn spec(model: &str) -> Option<(i32, i32)> {
    let resolved = lookup(SPEC_ALIASES, model).unwrap_or(model);
    SPECS
        .iter()
        .find(|(id, _, _)| *id == resolved)
        .map(|(_, out, budget)| (*out, *budget))
}

pub fn max_output_tokens(model: &str) -> i32 {
    spec(model).map_or(DEFAULT_MAX_OUTPUT_TOKENS, |(out, _)| out)
}

pub fn default_thinking_budget(model: &str) -> i32 {
    spec(model).map_or(DEFAULT_THINKING_BUDGET, |(_, budget)| budget)
}

pub fn is_claude(model: &str) -> bool {
    model.to_lowercase().contains("claude")
}

pub fn is_gemini(model: &str) -> bool {
    model.to_lowercase().starts_with("gemini-")
}

pub fn is_flash(model: &str) -> bool {
    let m = model.to_lowercase();
    m.contains("gemini") && m.contains("flash")
}

fn is_pro_agent(model: &str) -> bool {
    let m = model.to_lowercase();
    m.contains("gemini") && (m.contains("gemini-pro") || m.contains("-pro-agent"))
}

fn is_gemini_pro(model: &str) -> bool {
    let m = model.to_lowercase();
    m.contains("gemini-3-pro") || m.contains("gemini-3.1-pro")
}

pub fn supports_thinking(model: &str) -> bool {
    model.contains("-thinking")
        || is_claude(model)
        || is_gemini_pro(model)
        || is_pro_agent(model)
        || is_flash(model)
}

/// 客户端没指定 thinking 时是否默认开启
pub fn thinking_by_default(model: &str) -> bool {
    let m = model.to_lowercase();
    m.contains("-thinking")
        || m.contains("gemini-3.1-pro")
        || is_pro_agent(&m)
        || m.contains("gemini-3-flash")
        || m.contains("gemini-3.1-flash")
}

/// 历史里的工具调用缺签名时仍可保持 thinking 的模型（接受占位签名）
pub fn keeps_thinking_without_signature(model: &str) -> bool {
    is_flash(model) || model.to_lowercase().contains(GEMINI_PRO_AGENT)
}

pub fn context_window(model: &str) -> i32 {
    if is_claude(model) { CLAUDE_CONTEXT_WINDOW } else { GEMINI_CONTEXT_WINDOW }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_claude_family_and_gemini_aliases() {
        assert_eq!(map_model("claude-opus-5-5"), CLAUDE_OPUS);
        assert_eq!(map_model("claude-sonnet-4-5-20250929"), CLAUDE_SONNET);
        assert_eq!(map_model("claude-haiku-4-5-20251001"), CLAUDE_SONNET);
        assert_eq!(map_model("gemini-3.1-pro-high"), GEMINI_PRO_AGENT);
        assert_eq!(map_model("gemini-3.7-flash-low"), "gemini-3.7-flash-low");
    }

    #[test]
    fn specs_follow_aliases_and_defaults() {
        assert_eq!(default_thinking_budget("gemini-3.6-flash-medium"), 4_000);
        assert_eq!(max_output_tokens(CLAUDE_OPUS), 64_000);
        assert_eq!(max_output_tokens("unknown"), DEFAULT_MAX_OUTPUT_TOKENS);
        assert!(keeps_thinking_without_signature("gemini-3-flash"));
        assert!(!keeps_thinking_without_signature(CLAUDE_SONNET));
    }
}
