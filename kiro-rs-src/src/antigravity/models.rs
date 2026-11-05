//! Antigravity 模型映射与规格
//!
//! 客户端传来的 Anthropic 模型名映射到 Antigravity 上游模型 id；
//! Gemini 模型名原样透传（只处理少数已知别名）。

use super::consts::{DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_THINKING_BUDGET};

pub const CLAUDE_OPUS: &str = "claude-opus-4-6-thinking";
pub const CLAUDE_SONNET: &str = "claude-sonnet-4-6";
pub const CLAUDE_OPUS_5_5_HIGH: &str = "claude-opus-5-5-high";
pub const CLAUDE_OPUS_5_5_MEDIUM: &str = "claude-opus-5-5-medium";
pub const CLAUDE_OPUS_5_5_LOW: &str = "claude-opus-5-5-low";
pub const CLAUDE_SONNET_5_5_HIGH: &str = "claude-sonnet-5-5-high";
pub const CLAUDE_SONNET_5_5_MEDIUM: &str = "claude-sonnet-5-5-medium";
pub const CLAUDE_SONNET_5_5_LOW: &str = "claude-sonnet-5-5-low";
const CLAUDE_OPUS_5_5_BASE: &str = "claude-opus-5-5";
const CLAUDE_SONNET_5_5_BASE: &str = "claude-sonnet-5-5";
const GEMINI_PRO_AGENT: &str = "gemini-pro-agent";
const GEMINI_ARGON: &str = "gemini-4-argon";
pub const THINKING_LEVEL_LOW: &str = "LOW";
pub const THINKING_LEVEL_MEDIUM: &str = "MEDIUM";
pub const THINKING_LEVEL_HIGH: &str = "HIGH";
const CLAUDE_PREFIX: &str = "claude-";
/// 上游不对外提供的内部模型前缀（编辑器补全 / tab 补全）
const INTERNAL_MODEL_PREFIXES: &[&str] = &["chat_", "tab_"];

/// 账号目录为空时的兜底模型：(模型 id, 展示名)
pub const PUBLIC_MODELS: &[(&str, &str)] = &[
    (CLAUDE_OPUS_5_5_HIGH, "Claude Opus 5.5 (High)"),
    (CLAUDE_OPUS_5_5_MEDIUM, "Claude Opus 5.5 (Medium)"),
    (CLAUDE_OPUS_5_5_LOW, "Claude Opus 5.5 (Low)"),
    (CLAUDE_SONNET_5_5_HIGH, "Claude Sonnet 5.5 (High)"),
    (CLAUDE_SONNET_5_5_MEDIUM, "Claude Sonnet 5.5 (Medium)"),
    (CLAUDE_SONNET_5_5_LOW, "Claude Sonnet 5.5 (Low)"),
    (CLAUDE_OPUS, "Claude Opus 4.6 (Thinking)"),
    (CLAUDE_SONNET, "Claude Sonnet 4.6"),
    ("gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"),
    ("gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"),
    ("gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"),
    ("gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite"),
    ("gemini-3-flash", "Gemini 3 Flash"),
    ("gemini-2.5-pro", "Gemini 2.5 Pro"),
    ("gemini-2.5-flash", "Gemini 2.5 Flash"),
    ("gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"),
];

/// 上游 Claude 目录给的输入上下文（Opus / Sonnet 4.6 是 250K，5.5 是 1M）
pub const CLAUDE_CONTEXT_WINDOW: i32 = 250_000;
pub const CLAUDE_5_5_CONTEXT_WINDOW: i32 = 1_000_000;
pub const CLAUDE_5_5_MAX_OUTPUT_TOKENS: i32 = 128_000;
pub const GEMINI_CONTEXT_WINDOW: i32 = 1_048_576;
const GPT_OSS_CONTEXT_WINDOW: i32 = 131_072;
/// 没有上游容量且不属于已知模型族时，不猜测上下文上限。
const UNKNOWN_CONTEXT_WINDOW: i32 = 0;

/// 已知别名：(客户端模型名, 上游模型 id)
const ALIASES: &[(&str, &str)] = &[
    ("gemini-3.1-pro-high", GEMINI_PRO_AGENT),
    ("gemini-3.1-pro", GEMINI_PRO_AGENT),
    ("gemini-3.1-pro-preview", GEMINI_PRO_AGENT),
    ("gemini-3-pro-high", GEMINI_PRO_AGENT),
    ("gemini-3-flash-preview", "gemini-3-flash"),
    ("claude-opus-5.5-high", CLAUDE_OPUS_5_5_HIGH),
    ("claude-opus-5.5-medium", CLAUDE_OPUS_5_5_MEDIUM),
    ("claude-opus-5.5-low", CLAUDE_OPUS_5_5_LOW),
    ("claude-sonnet-5.5-high", CLAUDE_SONNET_5_5_HIGH),
    ("claude-sonnet-5.5-medium", CLAUDE_SONNET_5_5_MEDIUM),
    ("claude-sonnet-5.5-low", CLAUDE_SONNET_5_5_LOW),
];

/// 规格别名：未分档的 flash 按 high 档计算预算
const SPEC_ALIASES: &[(&str, &str)] = &[
    ("gemini-3.8-flash", "gemini-3.8-flash-high"),
    ("gemini-3.8-flash-tiered", "gemini-3.8-flash-high"),
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
    ("gemini-3.8-flash-high", 65_536, 10_000),
    ("gemini-3.8-flash-medium", 65_536, 4_000),
    ("gemini-3.8-flash-low", 65_536, 1_000),
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
    (CLAUDE_OPUS_5_5_HIGH, CLAUDE_5_5_MAX_OUTPUT_TOKENS, 32_768),
    (CLAUDE_OPUS_5_5_MEDIUM, CLAUDE_5_5_MAX_OUTPUT_TOKENS, 8_192),
    (CLAUDE_OPUS_5_5_LOW, CLAUDE_5_5_MAX_OUTPUT_TOKENS, 1_024),
    (CLAUDE_SONNET_5_5_HIGH, CLAUDE_5_5_MAX_OUTPUT_TOKENS, 32_768),
    (CLAUDE_SONNET_5_5_MEDIUM, CLAUDE_5_5_MAX_OUTPUT_TOKENS, 8_192),
    (CLAUDE_SONNET_5_5_LOW, CLAUDE_5_5_MAX_OUTPUT_TOKENS, 1_024),
    (CLAUDE_SONNET, 64_000, 32_768),
    (CLAUDE_OPUS, 64_000, 24_576),
];

/// 账号目录里的模型能不能对外提供
pub fn is_public(id: &str) -> bool {
    !INTERNAL_MODEL_PREFIXES.iter().any(|p| id.starts_with(p))
}

/// 展示名：已知模型查表，其余直接用 id
pub fn display_name(id: &str) -> String {
    lookup(PUBLIC_MODELS, id).unwrap_or(id).to_string()
}

fn lookup<'a>(table: &'a [(&str, &str)], key: &str) -> Option<&'a str> {
    table.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

/// 客户端模型名 → 上游模型 id
///
/// 显式指定的 `claude-opus-5-5-{high,medium,low}` 与 `claude-sonnet-5-5-{high,medium,low}` 原样保留；
/// 未带档位的 `claude-*5-5*` / `claude-*5.5*` 默认映射到 5.5 high 档；
/// 旧版 `claude-*`（4.6 / 4.5 等）映射到 4.6。
pub fn map_model(input: &str) -> String {
    map_model_with_effort(input, None)
}

/// 支持根据 `output_config.effort` 为未显式带档位的 Claude 5.5 选择对应 experience
pub fn map_model_with_effort(input: &str, effort_level: Option<&str>) -> String {
    let normalized = input.trim().to_lowercase();
    if let Some(target) = lookup(ALIASES, &normalized) {
        return target.to_string();
    }
    if claude_5_5_tier(&normalized).is_some() {
        return normalized;
    }
    if normalized.starts_with(CLAUDE_PREFIX) {
        let is_5_5 = normalized.contains("5-5") || normalized.contains("5.5");
        let is_opus = normalized.contains("opus");
        if is_5_5 {
            return match (is_opus, effort_level) {
                (true, Some(THINKING_LEVEL_LOW)) => CLAUDE_OPUS_5_5_LOW,
                (true, Some(THINKING_LEVEL_MEDIUM)) => CLAUDE_OPUS_5_5_MEDIUM,
                (true, _) => CLAUDE_OPUS_5_5_HIGH,
                (false, Some(THINKING_LEVEL_LOW)) => CLAUDE_SONNET_5_5_LOW,
                (false, Some(THINKING_LEVEL_MEDIUM)) => CLAUDE_SONNET_5_5_MEDIUM,
                (false, _) => CLAUDE_SONNET_5_5_HIGH,
            }
            .to_string();
        }
        return if is_opus { CLAUDE_OPUS } else { CLAUDE_SONNET }.to_string();
    }
    input.trim().to_string()
}

pub fn is_claude_5_5(model: &str) -> bool {
    let m = model.to_lowercase();
    m == CLAUDE_OPUS_5_5_BASE
        || m == CLAUDE_SONNET_5_5_BASE
        || claude_5_5_tier(&m).is_some()
}

pub fn claude_5_5_tier(model: &str) -> Option<&'static str> {
    let m = model.to_lowercase();
    let suffix = m
        .strip_prefix(CLAUDE_OPUS_5_5_BASE)
        .or_else(|| m.strip_prefix(CLAUDE_SONNET_5_5_BASE))?;
    match suffix {
        "-low" => Some(THINKING_LEVEL_LOW),
        "-medium" => Some(THINKING_LEVEL_MEDIUM),
        "-high" => Some(THINKING_LEVEL_HIGH),
        _ => None,
    }
}

/// 新后端 aicode.googleapis.com/v1alpha 优先的模型（Claude 5.5 系列仅在新后端开放）
pub fn prefers_aicode_endpoint(model: &str) -> bool {
    is_claude_5_5(model)
}

fn spec(model: &str) -> Option<(i32, i32)> {
    let resolved = lookup(SPEC_ALIASES, model).unwrap_or(model);
    SPECS
        .iter()
        .find(|(id, _, _)| *id == resolved)
        .map(|(_, out, budget)| (*out, *budget))
}

pub fn max_output_tokens(model: &str) -> i32 {
    if uses_thinking_level(model) {
        return 65_536;
    }
    spec(model).map_or(DEFAULT_MAX_OUTPUT_TOKENS, |(out, _)| out)
}

/// 只声明已核实的等级型家族，不能把未来 Gemini 型号一概套入。
pub fn uses_thinking_level(model: &str) -> bool {
    let m = model.to_lowercase();
    m == GEMINI_ARGON || argon_tier(&m).is_some()
}

pub fn argon_tier(model: &str) -> Option<&'static str> {
    let m = model.to_lowercase();
    match m.strip_prefix(GEMINI_ARGON)? {
        "-low" => Some(THINKING_LEVEL_LOW),
        "-medium" => Some(THINKING_LEVEL_MEDIUM),
        "-high" => Some(THINKING_LEVEL_HIGH),
        _ => None,
    }
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
        || uses_thinking_level(model)
}

/// 客户端没指定 thinking 时是否默认开启
pub fn thinking_by_default(model: &str) -> bool {
    let m = model.to_lowercase();
    m.contains("-thinking")
        || is_claude(&m)
        || m.contains("gemini-3.1-pro")
        || is_pro_agent(&m)
        || m.contains("gemini-3-flash")
        || m.contains("gemini-3.1-flash")
        || m.contains("gemini-3.8-flash")
        || uses_thinking_level(&m)
}

/// 历史里的工具调用缺签名时仍可保持 thinking 的模型（接受占位签名）
pub fn keeps_thinking_without_signature(model: &str) -> bool {
    is_flash(model)
        || model.to_lowercase().contains(GEMINI_PRO_AGENT)
        || uses_thinking_level(model)
        || is_claude_5_5(model)
}

pub fn context_window(model: &str) -> i32 {
    let m = model.to_lowercase();
    if is_claude_5_5(&m) {
        CLAUDE_5_5_CONTEXT_WINDOW
    } else if is_claude(&m) {
        CLAUDE_CONTEXT_WINDOW
    } else if m.starts_with("gpt-oss") {
        GPT_OSS_CONTEXT_WINDOW
    } else if is_gemini(&m) {
        GEMINI_CONTEXT_WINDOW
    } else {
        UNKNOWN_CONTEXT_WINDOW
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_claude_family_and_gemini_aliases() {
        assert_eq!(map_model("claude-opus-5-5"), CLAUDE_OPUS_5_5_HIGH);
        assert_eq!(map_model("claude-opus-5-5-medium"), CLAUDE_OPUS_5_5_MEDIUM);
        assert_eq!(map_model("claude-opus-5.5-low"), CLAUDE_OPUS_5_5_LOW);
        assert_eq!(map_model("claude-sonnet-5-5"), CLAUDE_SONNET_5_5_HIGH);
        assert_eq!(map_model_with_effort("claude-opus-5-5", Some("MEDIUM")), CLAUDE_OPUS_5_5_MEDIUM);
        assert_eq!(map_model_with_effort("claude-opus-5-5-high", Some("LOW")), CLAUDE_OPUS_5_5_HIGH);
        assert_eq!(map_model("claude-opus-4-6"), CLAUDE_OPUS);
        assert_eq!(map_model("claude-sonnet-4-5-20250929"), CLAUDE_SONNET);
        assert_eq!(map_model("claude-haiku-4-5-20251001"), CLAUDE_SONNET);
        assert_eq!(map_model("gemini-3.1-pro-high"), GEMINI_PRO_AGENT);
        assert_eq!(map_model("gemini-3.7-flash-low"), "gemini-3.7-flash-low");
    }

    #[test]
    fn internal_models_are_hidden_and_unknown_names_fall_back_to_id() {
        assert!(!is_public("tab_flash_lite_preview"));
        assert!(!is_public("chat_20706"));
        assert!(is_public("claude-sonnet-4-6"));
        assert_eq!(display_name("claude-sonnet-4-6"), "Claude Sonnet 4.6");
        assert_eq!(display_name(CLAUDE_OPUS_5_5_HIGH), "Claude Opus 5.5 (High)");
        assert_eq!(display_name("gemini-9-flash"), "gemini-9-flash");
    }

    #[test]
    fn context_windows_follow_the_model_family() {
        assert_eq!(context_window(CLAUDE_OPUS_5_5_HIGH), CLAUDE_5_5_CONTEXT_WINDOW);
        assert_eq!(context_window("claude-opus-4-6-thinking"), CLAUDE_CONTEXT_WINDOW);
        assert_eq!(context_window("gpt-oss-120b-medium"), GPT_OSS_CONTEXT_WINDOW);
        assert_eq!(context_window("gemini-3.8-flash-tiered"), GEMINI_CONTEXT_WINDOW);
        assert_eq!(context_window("unknown-model"), UNKNOWN_CONTEXT_WINDOW);
    }

    #[test]
    fn argon_capabilities_do_not_leak_to_unknown_models() {
        for model in ["gemini-4-argon", "gemini-4-argon-high", "gemini-4-argon-medium", "gemini-4-argon-low"] {
            assert!(uses_thinking_level(model));
            assert!(supports_thinking(model));
            assert!(thinking_by_default(model));
            assert!(keeps_thinking_without_signature(model));
            assert_eq!(max_output_tokens(model), 65_536);
        }
        for model in [CLAUDE_OPUS, CLAUDE_OPUS_5_5_HIGH, "gemini-3.8-flash-high", "gemini-4-unknown", "gemini-4-argon-preview"] {
            assert!(!uses_thinking_level(model));
        }
    }

    #[test]
    fn specs_follow_aliases_and_defaults() {
        assert_eq!(default_thinking_budget("gemini-3.6-flash-medium"), 4_000);
        assert_eq!(default_thinking_budget("gemini-3.8-flash-tiered"), 10_000);
        assert!(thinking_by_default("gemini-3.8-flash-high"));
        assert_eq!(max_output_tokens(CLAUDE_OPUS), 64_000);
        assert_eq!(max_output_tokens(CLAUDE_OPUS_5_5_HIGH), CLAUDE_5_5_MAX_OUTPUT_TOKENS);
        assert_eq!(max_output_tokens("unknown"), DEFAULT_MAX_OUTPUT_TOKENS);
        assert!(keeps_thinking_without_signature("gemini-3-flash"));
        assert!(keeps_thinking_without_signature(CLAUDE_OPUS_5_5_HIGH));
        assert!(!keeps_thinking_without_signature(CLAUDE_SONNET));
    }
}
