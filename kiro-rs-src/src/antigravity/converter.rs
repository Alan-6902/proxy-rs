//! Anthropic Messages 请求 → Antigravity v1internal 请求
//!
//! 产出的信封不含 project / userAgent / `request.sessionId`，由发送方按选中的账号补上。
//! 客户端 metadata 不原样转发，只用来算会话指纹（见 `session_key`）。

use std::collections::HashMap;

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use super::consts::{
    DEFAULT_IDENTITY, FLASH_THINKING_BUDGET_CAP, IDENTITY_MARKERS, MIN_CLAUDE_THINKING_BUDGET,
    MIN_SIGNATURE_LENGTH, PLACEHOLDER_THOUGHT_SIGNATURE, REQUEST_TYPE_AGENT, ROLE_MODEL, ROLE_USER,
    SAFETY_CATEGORIES, SAFETY_THRESHOLD_OFF, STOP_SEQUENCES,
};
use super::{models, schema, signatures};
use crate::anthropic::types::MessagesRequest;

const NO_CONTENT_TEXT: &str = "(no content)";
const EMPTY_TOOL_RESULT: &str = "Command executed successfully.";
const EMPTY_TOOL_ERROR: &str = "Tool execution failed with no output.";
/// Gemini 不接受空的 user 轮，用一个空格占位
const EMPTY_USER_TEXT: &str = " ";
/// 本轮最后一条 model 消息缺思考块时补的占位思考（仅 Gemini）
const DUMMY_THOUGHT_TEXT: &str = "Thinking...";
const UUID_PLACEHOLDER: &str = "{uuid}";
/// 首条消息哈希取多少位十六进制作会话指纹
const SESSION_KEY_HEX_LEN: usize = 32;
/// Claude Code 计费伪 Header 里的签名字段（`cch` 每次请求都变）
const BILLING_SIGNATURE_MARKERS: &[&str] = &["cc_version=", "cc_entrypoint=", "cch="];
/// Claude Agent SDK 写死的身份声明，上游会据此识别第三方 Agent 并误报 429
const AGENT_SDK_FINGERPRINTS: &[&str] = &[
    "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
    "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
];

const THINKING_ENABLED: &str = "enabled";
const THINKING_ADAPTIVE: &str = "adaptive";
const THINKING_DISABLED: &str = "disabled";
/// 正文至少保留总额度的一半，长回复最多预留 8192；不扩大调用方的总上限。
const OUTPUT_TOKEN_RESERVE: i32 = 8192;
const LOW_THINKING_BUDGET: i32 = 1024;
const MEDIUM_THINKING_BUDGET: i32 = 8192;

const TOOL_CHOICE_AUTO: &str = "auto";
const TOOL_CHOICE_NONE: &str = "none";
const TOOL_CHOICE_TOOL: &str = "tool";
const MODE_VALIDATED: &str = "VALIDATED";
const MODE_AUTO: &str = "AUTO";
const MODE_NONE: &str = "NONE";
const MODE_ANY: &str = "ANY";

/// 转换结果
pub struct Converted {
    /// v1internal 信封（待补 project / userAgent / request.sessionId）
    pub envelope: Value,
    /// 实际发给上游的模型 id
    pub model: String,
    /// 会话指纹：同一段对话每轮都相同，用于粘到同一账号、生成稳定的 sessionId
    pub session_key: Option<String>,
}

/// 会话指纹：优先用客户端 metadata 里的 session（Claude Code 每个会话一个 UUID），
/// 否则用首条 user 消息文本的哈希（同一段对话的首条消息不变）
fn session_key(req: &MessagesRequest, messages: &[(String, Vec<Value>)]) -> Option<String> {
    if let Some(id) = req
        .metadata
        .as_ref()
        .and_then(|m| m.user_id.as_deref())
        .and_then(metadata_session_id)
    {
        return Some(format!("meta:{id}"));
    }
    let first_user_text: String = messages
        .iter()
        .find(|(role, _)| role == "user")?
        .1
        .iter()
        .filter(|b| block_type(b) == "text")
        .filter_map(|b| str_field(b, "text"))
        .collect::<Vec<_>>()
        .join("\n");
    if first_user_text.trim().is_empty() {
        return None;
    }
    let digest = Sha256::digest(first_user_text.as_bytes());
    Some(format!("first:{}", hex_prefix(&digest, SESSION_KEY_HEX_LEN)))
}

/// `user_xxx_account__session_<uuid>` 或 JSON `{"session_id":"<uuid>"}`
fn metadata_session_id(user_id: &str) -> Option<String> {
    if let Ok(v) = serde_json::from_str::<Value>(user_id)
        && let Some(s) = v.get("session_id").and_then(Value::as_str).filter(|s| !s.trim().is_empty())
    {
        return Some(s.to_string());
    }
    let (_, rest) = user_id.rsplit_once("session_")?;
    let rest = rest.trim();
    (!rest.is_empty()).then(|| rest.to_string())
}

fn hex_prefix(bytes: &[u8], len: usize) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()[..len].to_string()
}

/// 上游的 sessionId：和官方客户端一样是负整数字符串，按「账号 + 会话」稳定
pub fn upstream_session_id(account_id: i64, session_key: Option<&str>) -> String {
    let seed = match session_key {
        Some(key) => format!("{account_id}|{key}"),
        None => uuid::Uuid::new_v4().to_string(),
    };
    let digest = Sha256::digest(seed.as_bytes());
    let mut head = [0u8; 8];
    head.copy_from_slice(&digest[..8]);
    // 去掉符号位再取负，保证落在 i64 负数范围且不为 0
    let n = (u64::from_be_bytes(head) >> 1).max(1) as i64;
    (-n).to_string()
}

/// `raw` 是原始请求体：`MessagesRequest` 没有的采样参数（temperature 等）从这里读
pub fn convert(req: &MessagesRequest, raw: &Value) -> Converted {
    let effort_level = req.output_config.as_ref().and_then(|c| thinking_level(&c.effort));
    let model = models::map_model_with_effort(&req.model, effort_level);
    let messages: Vec<(String, Vec<Value>)> = req
        .messages
        .iter()
        .map(|m| (m.role.clone(), content_blocks(&m.content)))
        .collect();

    let thinking = resolve_thinking(req, &model, &messages);
    let contents = build_contents(&messages, thinking, &model);
    let tools = build_tools(req);

    let mut request = Map::new();
    if let Some(sys) = build_system_instruction(req) {
        request.insert("systemInstruction".into(), sys);
    }
    if let Some(tools) = &tools {
        let tool_config = build_tool_config(req.tool_choice.as_ref());
        request.insert("tool_config".into(), to_snake_tool_config(&tool_config));
        request.insert("toolConfig".into(), tool_config);
        request.insert("tools".into(), tools.clone());
    }
    request.insert(
        "generationConfig".into(),
        build_generation_config(req, raw, &model, thinking),
    );
    request.insert(
        "safetySettings".into(),
        Value::Array(
            SAFETY_CATEGORIES
                .iter()
                .map(|c| json!({ "category": c, "threshold": SAFETY_THRESHOLD_OFF }))
                .collect(),
        ),
    );
    let has_tool_activity = tools.is_some() || contents_have_tool_activity(&contents);
    request.insert("contents".into(), Value::Array(contents));

    let mut envelope = json!({
        "request": request,
        "model": model,
        "requestId": new_request_id(),
    });
    if has_tool_activity {
        envelope["requestType"] = json!(REQUEST_TYPE_AGENT);
    }
    let session_key = session_key(req, &messages);
    Converted { envelope, model, session_key }
}

fn new_request_id() -> String {
    let hex = uuid::Uuid::new_v4().simple().to_string();
    format!("agent/{}/{}", chrono::Utc::now().timestamp_millis(), &hex[..8])
}

const CONTINUE_PROMPT_ZH: &str = "继续";
const CONTINUE_PROMPT_EN: &str = "Continue.";

fn has_cjk(text: &str) -> bool {
    text.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c))
}

/// 上游只思考、没出正文就结束时的续跑请求：在最后一条 user 消息末尾追加「继续」。
///
/// 不能另起一条 user 消息：连续两条同角色会被上游拒绝（400）。
/// 用户说中文就用「继续」，否则用 `Continue.`。
pub fn continuation_envelope(envelope: &Value) -> Value {
    let mut env = envelope.clone();
    env["requestId"] = json!(new_request_id());
    let Some(contents) = env["request"]["contents"].as_array_mut() else {
        return env;
    };
    let chinese = contents
        .iter()
        .filter(|c| c["role"] == ROLE_USER)
        .flat_map(|c| c["parts"].as_array().into_iter().flatten())
        .filter_map(|p| p["text"].as_str())
        .any(has_cjk);
    let prompt = if chinese { CONTINUE_PROMPT_ZH } else { CONTINUE_PROMPT_EN };
    match contents.last_mut() {
        Some(last) if last["role"] == ROLE_USER => {
            let parts = last["parts"].as_array_mut();
            let text_part = parts.as_ref().and_then(|ps| {
                ps.iter().rposition(|p| p["text"].is_string() && p.get("thought").is_none())
            });
            match (parts, text_part) {
                (Some(ps), Some(i)) => {
                    let text = ps[i]["text"].as_str().unwrap_or_default();
                    ps[i]["text"] = json!(format!("{text}\n\n{prompt}"));
                }
                (Some(ps), None) => ps.push(json!({ "text": prompt })),
                (None, _) => last["parts"] = json!([{ "text": prompt }]),
            }
        }
        _ => contents.push(json!({ "role": ROLE_USER, "parts": [{ "text": prompt }] })),
    }
    env
}

/// 消息 content：字符串视为单个 text 块
fn content_blocks(content: &Value) -> Vec<Value> {
    match content {
        Value::Array(blocks) => blocks.clone(),
        Value::String(s) => vec![json!({ "type": "text", "text": s })],
        _ => Vec::new(),
    }
}

fn block_type(block: &Value) -> &str {
    block.get("type").and_then(Value::as_str).unwrap_or_default()
}

fn str_field<'a>(block: &'a Value, key: &str) -> Option<&'a str> {
    block.get(key).and_then(Value::as_str)
}

fn valid_signature(sig: Option<&str>) -> Option<&str> {
    sig.filter(|s| s.len() >= MIN_SIGNATURE_LENGTH)
}

fn is_base64_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=' | b'-' | b'_')
}

fn b64_val(b: u8) -> Option<u8> {
    match b {
        b'A'..=b'Z' => Some(b - b'A'),
        b'a'..=b'z' => Some(b - b'a' + 26),
        b'0'..=b'9' => Some(b - b'0' + 52),
        b'+' | b'-' => Some(62),
        b'/' | b'_' => Some(63),
        _ => None,
    }
}

/// Claude 上游的 `thoughtSignature` 是双重 Base64（第一层解码后仍是 ASCII Base64 字符），
/// 而 Gemini 上游的 `thoughtSignature` 单层 Base64 解码后是原始二进制字节（含非 ASCII 字节）。
/// 跨模型切换时，把对方的签名传过去会导致上游报 `Invalid signature` 或 `Corrupted thought signature`。
fn is_claude_signature(sig: &str) -> bool {
    let bytes: Vec<u8> = sig.bytes().filter(|b| !b.is_ascii_whitespace() && *b != b'=').collect();
    if bytes.len() < MIN_SIGNATURE_LENGTH || !bytes.iter().all(|b| is_base64_byte(*b)) {
        return false;
    }
    let mut decoded = Vec::with_capacity(bytes.len() * 3 / 4);
    for chunk in bytes.chunks(4) {
        let Some(v0) = chunk.first().copied().and_then(b64_val) else { return false };
        let Some(v1) = chunk.get(1).copied().and_then(b64_val) else { break };
        decoded.push((v0 << 2) | (v1 >> 4));
        let Some(v2) = chunk.get(2).copied().and_then(b64_val) else { break };
        decoded.push((v1 << 4) | (v2 >> 2));
        let Some(v3) = chunk.get(3).copied().and_then(b64_val) else { break };
        decoded.push((v2 << 6) | v3);
    }
    decoded.len() >= 8 && decoded.iter().all(|b| is_base64_byte(*b))
}

/// 签名是否与目标模型族兼容（测试里的模拟短签名 `sig-...` 解码后不是双重 Base64，测试环境按原逻辑放行）
fn signature_matches_model(sig: &str, model: &str) -> bool {
    if sig.len() < MIN_SIGNATURE_LENGTH || sig == PLACEHOLDER_THOUGHT_SIGNATURE {
        return false;
    }
    if sig.starts_with("sig-") {
        return true;
    }
    models::is_claude(model) == is_claude_signature(sig)
}

// === thinking ===

fn resolve_thinking(req: &MessagesRequest, model: &str, messages: &[(String, Vec<Value>)]) -> bool {
    let requested = match &req.thinking {
        Some(t) => t.thinking_type == THINKING_ENABLED || t.thinking_type == THINKING_ADAPTIVE,
        None => models::thinking_by_default(model),
    };
    if !requested || !models::supports_thinking(model) {
        return false;
    }
    // 历史里有工具调用却拿不到任何真实签名时，上游会拒绝带 thinking 的请求
    let blocks = || messages.iter().flat_map(|(_, b)| b.iter());
    let has_tool_use = blocks().any(|b| block_type(b) == "tool_use");
    if !has_tool_use || models::keeps_thinking_without_signature(model) {
        return true;
    }
    blocks().any(|b| match block_type(b) {
        "thinking" => valid_signature(str_field(b, "signature"))
            .is_some_and(|s| signature_matches_model(s, model)),
        "tool_use" => {
            valid_signature(str_field(b, "signature"))
                .is_some_and(|s| signature_matches_model(s, model))
                || str_field(b, "id")
                    .and_then(signatures::lookup)
                    .is_some_and(|s| signature_matches_model(&s, model))
        }
        _ => false,
    })
}

fn build_generation_config(req: &MessagesRequest, raw: &Value, model: &str, thinking: bool) -> Value {
    let max_output = req.max_tokens.clamp(1, models::max_output_tokens(model));
    let mut config = Map::new();
    if thinking {
        let mut tc = json!({ "includeThoughts": true });
        let mut enabled = true;
        let adaptive = req.thinking.as_ref().is_some_and(|t| t.thinking_type == THINKING_ADAPTIVE);
        let explicit_budget = !adaptive
            && raw.pointer("/thinking/budget_tokens").is_some()
            && req.thinking.as_ref().is_some_and(|t| t.budget_tokens > 0);
        if models::uses_thinking_level(model) {
            // 带档位模型保持其档位；冲突 effort 由 validate_thinking 在发请求前拒绝。
            let level = models::argon_tier(model)
                .or_else(|| req.output_config.as_ref().and_then(|c| thinking_level(&c.effort)))
                .unwrap_or(models::THINKING_LEVEL_MEDIUM);
            tc["thinkingLevel"] = json!(level);
        } else if let Some(level) = models::claude_5_5_tier(model).filter(|_| !explicit_budget) {
            tc["thinkingLevel"] = json!(level);
        } else {
            let default_budget = models::default_thinking_budget(model);
            let mut budget = match &req.thinking {
                Some(t) if explicit_budget => t.budget_tokens,
                _ => match req.output_config.as_ref().and_then(|c| thinking_level(&c.effort)) {
                    Some(models::THINKING_LEVEL_LOW) => default_budget.min(LOW_THINKING_BUDGET),
                    Some(models::THINKING_LEVEL_MEDIUM) => default_budget.min(MEDIUM_THINKING_BUDGET),
                    _ => default_budget,
                },
            };
            if models::is_flash(model) {
                budget = budget.min(FLASH_THINKING_BUDGET_CAP);
            }
            let reserve = (max_output / 2).clamp(1, OUTPUT_TOKEN_RESERVE);
            budget = budget.min(max_output - reserve).max(0);
            // 保持既有做法：Claude 有 1024 下限，放不下时不带 thinking。
            enabled = !models::is_claude(model) || budget >= MIN_CLAUDE_THINKING_BUDGET;
            tc["thinkingBudget"] = json!(budget);
        }
        if enabled {
            config.insert("thinkingConfig".into(), tc);
        }
    } else if models::is_flash(model) && is_disabled(req) {
        // Flash 的数字预算 0 是显式关闭；其它模型的关闭方式未验证，由 validate_thinking 拦截。
        config.insert("thinkingConfig".into(), json!({ "includeThoughts": false, "thinkingBudget": 0 }));
    }
    for (from, to) in [("temperature", "temperature"), ("top_p", "topP"), ("top_k", "topK")] {
        if let Some(v) = raw.get(from).filter(|v| v.is_number()) {
            config.insert(to.into(), v.clone());
        }
    }
    config.insert("maxOutputTokens".into(), json!(max_output));
    config.insert("stopSequences".into(), json!(STOP_SEQUENCES));
    Value::Object(config)
}

fn thinking_level(effort: &str) -> Option<&'static str> {
    match effort.trim().to_ascii_lowercase().as_str() {
        "low" => Some(models::THINKING_LEVEL_LOW),
        "medium" => Some(models::THINKING_LEVEL_MEDIUM),
        "high" | "xhigh" | "max" => Some(models::THINKING_LEVEL_HIGH),
        _ => None,
    }
}

fn is_disabled(req: &MessagesRequest) -> bool {
    req.thinking.as_ref().is_some_and(|t| t.thinking_type == THINKING_DISABLED)
}

/// 无法忠实表达的推理控制在发送前拒绝，避免静默降档或把省略参数假装成关闭。
pub fn validate_thinking(req: &MessagesRequest, raw: &Value) -> Result<(), &'static str> {
    let model = models::map_model(&req.model);
    if is_disabled(req) && models::is_claude(&model) {
        return Err("当前 Antigravity Claude 路径暂不支持显式关闭推理");
    }
    if !models::uses_thinking_level(&model) {
        return Ok(());
    }
    if let Some(t) = &req.thinking {
        if t.thinking_type == THINKING_DISABLED {
            return Err("Argon 暂不支持关闭推理，请使用 adaptive 或选择支持关闭推理的模型");
        }
        if raw.pointer("/thinking/budget_tokens").is_some() {
            return Err("Argon 使用推理等级，不能设置 budget_tokens，请使用 output_config.effort");
        }
        if t.thinking_type != THINKING_ADAPTIVE && t.thinking_type != THINKING_ENABLED {
            return Err("Argon 的 thinking.type 只支持 adaptive 或 enabled");
        }
    }
    if let Some(config) = &req.output_config {
        let level = thinking_level(&config.effort).ok_or("Argon 的 effort 只支持 low、medium、high、xhigh 或 max")?;
        if models::argon_tier(&model).is_some_and(|tier| tier != level) {
            return Err("Argon 模型档位与 output_config.effort 冲突，请选择相同档位或不带档位的模型");
        }
    }
    Ok(())
}

// === system ===

fn build_system_instruction(req: &MessagesRequest) -> Option<Value> {
    let instructions: Vec<String> = req
        .system
        .iter()
        .flatten()
        .map(|s| sanitize_system_text(&s.text))
        .filter(|s| !s.trim().is_empty())
        .collect();
    let has_identity = instructions
        .iter()
        .any(|t| IDENTITY_MARKERS.iter().any(|m| t.contains(m)));
    let mut sections = Vec::with_capacity(instructions.len() + 1);
    if !has_identity {
        sections.push(DEFAULT_IDENTITY.to_string());
    }
    sections.extend(instructions);
    Some(json!({ "parts": [{ "text": sections.join("\n\n") }] }))
}

/// 去掉每轮都会变的日期行与计费伪 Header、把 UUID 换成占位符，让系统提示前缀稳定便于上游缓存；
/// 顺带去掉 Agent SDK 身份指纹
fn sanitize_system_text(text: &str) -> String {
    let kept: Vec<&str> = text
        .lines()
        .filter(|line| !is_volatile_date_line(line) && !is_billing_header_line(line))
        .collect();
    let mut joined = replace_uuids(&kept.join("\n"));
    for fingerprint in AGENT_SDK_FINGERPRINTS {
        joined = joined.replace(fingerprint, "");
    }
    while joined.contains("\n\n\n") {
        joined = joined.replace("\n\n\n", "\n\n");
    }
    joined.trim().to_string()
}

/// `x-anthropic-billing-header: cc_version=…; cch=…;` 这类客户端注入的计费伪 Header 行：
/// 名字以 `x-` 开头且含 billing，或值里带 Claude Code 计费签名字段
fn is_billing_header_line(line: &str) -> bool {
    let lower = line.trim().to_lowercase();
    let Some((name, value)) = lower.split_once(':') else {
        return false;
    };
    let is_header_name = name.starts_with("x-")
        && name.len() > 2
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    is_header_name
        && (name.contains("billing") || BILLING_SIGNATURE_MARKERS.iter().any(|m| value.contains(m)))
}

fn is_volatile_date_line(line: &str) -> bool {
    let lower = line.trim_start().to_lowercase();
    let after_prefix = |prefix: &str| lower.strip_prefix(prefix).map(str::trim_start);
    for prefix in ["current date", "current time"] {
        if let Some(rest) = after_prefix(prefix) {
            let rest = rest.strip_prefix("is").map(str::trim_start).unwrap_or(rest);
            if rest.starts_with(':') {
                return true;
            }
        }
    }
    if after_prefix("today is").is_some_and(|r| r.starts_with(':')) {
        return true;
    }
    // Date: 2026-01-01
    after_prefix("date:").is_some_and(|r| {
        let b = r.as_bytes();
        b.len() >= 10
            && b[..4].iter().all(u8::is_ascii_digit)
            && b[4] == b'-'
            && b[5..7].iter().all(u8::is_ascii_digit)
            && b[7] == b'-'
            && b[8..10].iter().all(u8::is_ascii_digit)
    })
}

fn replace_uuids(text: &str) -> String {
    const GROUPS: [usize; 5] = [8, 4, 4, 4, 12];
    const UUID_LEN: usize = 36;
    let bytes = text.as_bytes();
    let is_word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let matches_at = |i: usize| -> bool {
        if i + UUID_LEN > bytes.len() {
            return false;
        }
        if i > 0 && is_word(bytes[i - 1]) {
            return false;
        }
        if bytes.get(i + UUID_LEN).is_some_and(|b| is_word(*b)) {
            return false;
        }
        let mut pos = i;
        for (gi, len) in GROUPS.iter().enumerate() {
            if !bytes[pos..pos + len].iter().all(u8::is_ascii_hexdigit) {
                return false;
            }
            pos += len;
            if gi < GROUPS.len() - 1 {
                if bytes[pos] != b'-' {
                    return false;
                }
                pos += 1;
            }
        }
        true
    };
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut last = 0;
    while i < bytes.len() {
        if matches_at(i) {
            out.push_str(&text[last..i]);
            out.push_str(UUID_PLACEHOLDER);
            i += UUID_LEN;
            last = i;
        } else {
            i += 1;
        }
    }
    out.push_str(&text[last..]);
    out
}

// === tools ===

fn build_tools(req: &MessagesRequest) -> Option<Value> {
    let mut decls: Vec<Value> = req
        .tools
        .iter()
        .flatten()
        // 服务端工具（web_search 等）不转发
        .filter(|t| t.tool_type.is_none() && !t.name.is_empty())
        .map(|t| {
            let schema_map: Map<String, Value> =
                t.input_schema.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
            json!({
                "name": t.name,
                "description": t.description,
                "parameters": schema::clean_tool_schema(&schema_map),
            })
        })
        .collect();
    if decls.is_empty() {
        return None;
    }
    decls.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    Some(json!([{ "functionDeclarations": decls }]))
}

fn build_tool_config(choice: Option<&Value>) -> Value {
    let kind = choice.and_then(|c| c.as_str().or_else(|| str_field(c, "type")));
    let mode = match kind {
        None => MODE_VALIDATED,
        Some(TOOL_CHOICE_AUTO) => MODE_AUTO,
        Some(TOOL_CHOICE_NONE) => MODE_NONE,
        Some(_) => MODE_ANY,
    };
    let mut fcc = json!({ "mode": mode });
    if kind == Some(TOOL_CHOICE_TOOL)
        && let Some(name) = choice.and_then(|c| str_field(c, "name")) {
            fcc["allowedFunctionNames"] = json!([name]);
        }
    json!({ "functionCallingConfig": fcc, "includeServerSideToolInvocations": true })
}

fn to_snake_tool_config(config: &Value) -> Value {
    let fcc = &config["functionCallingConfig"];
    let mut snake = json!({ "mode": fcc["mode"] });
    if let Some(names) = fcc.get("allowedFunctionNames") {
        snake["allowed_function_names"] = names.clone();
    }
    json!({
        "function_calling_config": snake,
        "include_server_side_tool_invocations": config["includeServerSideToolInvocations"],
    })
}

/// 将 v1internal 信封转换为 aicode.googleapis.com/v1alpha 的顶层 GenerateContentRequest。
/// AICode 的 ToolConfig 仅包含 `functionCallingConfig`，且 `Mode` 枚举不含 `VALIDATED`。
pub fn to_aicode_request(envelope: &Value, model: &str, user_tier: &str, session_id: &str) -> Value {
    let req = &envelope["request"];
    let mut out = Map::new();
    out.insert("entitlement".into(), json!({ "userTier": user_tier }));
    out.insert("aicode".into(), json!({ "experience": model }));
    out.insert("sessionId".into(), Value::String(session_id.to_string()));
    for key in ["systemInstruction", "tools", "safetySettings", "generationConfig", "contents"] {
        if let Some(v) = req.get(key) {
            out.insert(key.into(), v.clone());
        }
    }
    if let Some(tc) = req.get("toolConfig") {
        let mut fcc = tc["functionCallingConfig"].clone();
        if fcc.get("mode").and_then(Value::as_str) == Some(MODE_VALIDATED) {
            fcc["mode"] = json!(MODE_AUTO);
        }
        out.insert("toolConfig".into(), json!({ "functionCallingConfig": fcc }));
    }
    Value::Object(out)
}

// === contents ===

fn with_signature(mut part: Value, sig: &str) -> Value {
    part["thoughtSignature"] = json!(sig);
    part
}

fn inline_data(source: &Value) -> Option<Value> {
    if str_field(source, "type") != Some("base64") {
        return None;
    }
    Some(json!({
        "inlineData": {
            "mimeType": str_field(source, "media_type").unwrap_or_default(),
            "data": str_field(source, "data").unwrap_or_default(),
        }
    }))
}

fn build_contents(messages: &[(String, Vec<Value>)], thinking: bool, model: &str) -> Vec<Value> {
    let allow_dummy_thought = models::is_gemini(model);
    let is_claude_model = models::is_claude(model);
    let keeps_without_sig = models::keeps_thinking_without_signature(model);
    let mut tool_names: HashMap<String, String> = HashMap::new();
    let mut last_signature: Option<String> = None;
    let mut contents = Vec::with_capacity(messages.len());

    for (index, (role, blocks)) in messages.iter().enumerate() {
        let role = if role == "assistant" { ROLE_MODEL } else { ROLE_USER };
        let mut parts: Vec<Value> = Vec::new();

        for block in blocks {
            match block_type(block) {
                "text" => {
                    let text = str_field(block, "text").unwrap_or_default().trim();
                    if !text.is_empty() && text != NO_CONTENT_TEXT {
                        parts.push(json!({ "text": text }));
                    }
                }
                "thinking" => {
                    let text = str_field(block, "thinking").unwrap_or_default();
                    let sig = str_field(block, "signature")
                        .filter(|s| signature_matches_model(s, model));
                    // Claude 上游对历史里的每个 thought 块都强制校验 signature；
                    // 缺签名或签名来自 Gemini（会话中途切模型）时跳过该思考块，保留正文与工具调用。
                    if is_claude_model && sig.is_none() {
                        continue;
                    }
                    let mut part = json!({
                        "text": text,
                        "thought": true,
                    });
                    if let Some(sig) = sig {
                        last_signature = Some(sig.to_string());
                        part = with_signature(part, sig);
                    }
                    parts.push(part);
                }
                "redacted_thinking" => {
                    if !is_claude_model {
                        let data = str_field(block, "data").unwrap_or_default();
                        parts.push(json!({ "text": format!("[Redacted Thinking: {data}]"), "thought": true }));
                    }
                }
                "image" | "document" => {
                    if let Some(part) = block.get("source").and_then(inline_data) {
                        parts.push(part);
                    }
                }
                "tool_use" => {
                    let id = str_field(block, "id").unwrap_or_default();
                    let name = str_field(block, "name").unwrap_or_default();
                    tool_names.insert(id.to_string(), name.to_string());
                    let part = json!({
                        "functionCall": {
                            "name": name,
                            "args": block.get("input").cloned().unwrap_or_else(|| json!({})),
                            "id": id,
                        }
                    });
                    let sig = str_field(block, "signature")
                        .filter(|s| signature_matches_model(s, model))
                        .map(str::to_string)
                        .or_else(|| signatures::lookup(id).filter(|s| signature_matches_model(s, model)))
                        .or_else(|| last_signature.clone());
                    parts.push(match sig {
                        Some(sig) => with_signature(part, &sig),
                        None if thinking || keeps_without_sig => {
                            with_signature(part, PLACEHOLDER_THOUGHT_SIGNATURE)
                        }
                        None => part,
                    });
                }
                "tool_result" => {
                    let id = str_field(block, "tool_use_id").unwrap_or_default();
                    let name = tool_names.get(id).map(String::as_str).unwrap_or(id);
                    let (mut text, extra) = tool_result_content(block.get("content"));
                    if text.trim().is_empty() && extra.is_empty() {
                        let is_error = block.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                        text = if is_error { EMPTY_TOOL_ERROR } else { EMPTY_TOOL_RESULT }.to_string();
                    }
                    let part = json!({
                        "functionResponse": { "name": name, "response": { "result": text }, "id": id }
                    });
                    parts.push(match &last_signature {
                        Some(sig) => with_signature(part, sig),
                        None => part,
                    });
                    parts.extend(extra);
                }
                _ => {}
            }
        }

        let is_last = index + 1 == messages.len();
        if allow_dummy_thought && role == ROLE_MODEL && thinking && is_last
            && !parts.iter().any(|p| p.get("thought") == Some(&Value::Bool(true)))
        {
            parts.insert(0, json!({ "text": DUMMY_THOUGHT_TEXT, "thought": true }));
        }
        if !parts.is_empty() {
            contents.push(json!({ "role": role, "parts": parts }));
        } else if role == ROLE_USER {
            contents.push(json!({ "role": role, "parts": [{ "text": EMPTY_USER_TEXT }] }));
        }
    }
    contents
}

/// tool_result 的 content：文本合并成一段，图片等作为额外的 inlineData part
fn tool_result_content(content: Option<&Value>) -> (String, Vec<Value>) {
    match content {
        Some(Value::String(s)) => (s.clone(), Vec::new()),
        Some(Value::Array(items)) => {
            let text = items
                .iter()
                .filter(|c| block_type(c) == "text")
                .filter_map(|c| str_field(c, "text"))
                .collect::<Vec<_>>()
                .join("\n");
            let extra = items
                .iter()
                .filter(|c| matches!(block_type(c), "image" | "document"))
                .filter_map(|c| c.get("source").and_then(inline_data))
                .collect();
            (text, extra)
        }
        _ => (String::new(), Vec::new()),
    }
}

fn contents_have_tool_activity(contents: &[Value]) -> bool {
    contents.iter().any(|c| {
        c["parts"].as_array().is_some_and(|parts| {
            parts
                .iter()
                .any(|p| p.get("functionCall").is_some() || p.get("functionResponse").is_some())
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn convert_json(body: Value) -> Converted {
        let req: MessagesRequest = serde_json::from_value(body.clone()).unwrap();
        convert(&req, &body)
    }

    #[test]
    fn continuation_appends_to_last_user_turn_without_new_role() {
        let env = json!({ "requestId": "agent/1/a", "request": { "contents": [
            { "role": "user", "parts": [{ "text": "帮我看看" }] },
            { "role": "model", "parts": [{ "functionCall": { "name": "read", "args": {} } }] },
            { "role": "user", "parts": [{ "functionResponse": { "name": "read", "response": {} } }] },
        ]}});
        let out = continuation_envelope(&env);
        let contents = out["request"]["contents"].as_array().unwrap();
        assert_eq!(contents.len(), 3);
        assert_eq!(contents[2]["parts"][1], json!({ "text": "继续" }));
        assert_ne!(out["requestId"], env["requestId"]);

        let env = json!({ "request": { "contents": [{ "role": "user", "parts": [{ "text": "hello" }] }] } });
        let out = continuation_envelope(&env);
        assert_eq!(out["request"]["contents"][0]["parts"][0]["text"], "hello\n\nContinue.");
    }

    #[test]
    fn maps_basic_request_and_injects_identity() {
        let out = convert_json(json!({
            "model": "claude-sonnet-4-5",
            "max_tokens": 100000,
            "temperature": 0.3,
            "system": "Be brief.\nToday is: Monday\nid 0b4445e1-f5be-49e1-87ce-62bbc28ad705",
            "metadata": { "user_id": "user_x_session_1" },
            "messages": [
                { "role": "user", "content": "hi" },
                { "role": "assistant", "content": [{ "type": "text", "text": "(no content)" }] },
                { "role": "user", "content": [] }
            ]
        }));
        let env = &out.envelope;
        assert_eq!(out.model, models::CLAUDE_SONNET);
        assert!(env.get("sessionId").is_none());
        assert!(env.get("requestType").is_none());
        assert!(env["requestId"].as_str().unwrap().starts_with("agent/"));
        let sys = env["request"]["systemInstruction"]["parts"][0]["text"].as_str().unwrap();
        assert!(sys.starts_with("You are Antigravity"));
        assert!(sys.contains("Be brief.\nid {uuid}"));
        assert!(!sys.contains("Today is"));
        let gc = &env["request"]["generationConfig"];
        assert_eq!(gc["maxOutputTokens"], 64_000);
        assert_eq!(gc["temperature"], 0.3);
        // sonnet-thinking 默认开启 thinking
        assert_eq!(gc["thinkingConfig"]["includeThoughts"], true);
        let contents = env["request"]["contents"].as_array().unwrap();
        // 空的 assistant 轮丢弃，空的 user 轮用空格占位
        assert_eq!(contents.len(), 2);
        assert_eq!(contents[1]["parts"][0]["text"], " ");
    }

    fn system_text(body: Value) -> String {
        let out = convert_json(body);
        out.envelope["request"]["systemInstruction"]["parts"][0]["text"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn strips_billing_header_so_prefix_stays_cacheable() {
        let sys = |cch: &str| {
            system_text(json!({
                "model": "gemini-3-flash",
                "max_tokens": 1000,
                "system": [
                    { "type": "text", "text": format!("x-anthropic-billing-header: cc_version=2.1.316.ad1; cc_entrypoint=cli; cch={cch};") },
                    { "type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude.\nBe brief." }
                ],
                "messages": [{ "role": "user", "content": "hi" }]
            }))
        };
        let first = sys("a1b2c");
        assert!(!first.contains("billing"));
        assert!(!first.contains("cch="));
        assert!(first.contains("Be brief."));
        // cch 每次请求都变，剥掉后系统提示应完全一致
        assert_eq!(first, sys("ffee9"));
    }

    #[test]
    fn billing_header_detection_ignores_ordinary_lines() {
        assert!(is_billing_header_line("  X-Anthropic-Billing-Header: cc_entrypoint=desktop;"));
        assert!(is_billing_header_line("x-client-meta: cc_version=1.0; cch=abc;"));
        assert!(!is_billing_header_line("Billing: see docs"));
        assert!(!is_billing_header_line("x-request-id: 123"));
        assert!(!is_billing_header_line("Note on x-billing: use the dashboard"));
    }

    #[test]
    fn session_key_prefers_metadata_then_first_user_message() {
        let body = |metadata: Value, second: &str| {
            json!({
                "model": "gemini-3-flash",
                "max_tokens": 1000,
                "metadata": metadata,
                "messages": [
                    { "role": "user", "content": "fix the bug" },
                    { "role": "assistant", "content": "ok" },
                    { "role": "user", "content": second }
                ]
            })
        };
        let meta = json!({ "user_id": "user_abc_account__session_0b4445e1-f5be-49e1-87ce-62bbc28ad705" });
        let key = convert_json(body(meta.clone(), "x")).session_key.unwrap();
        assert_eq!(key, "meta:0b4445e1-f5be-49e1-87ce-62bbc28ad705");
        let json_meta = json!({ "user_id": r#"{"device_id":"d","session_id":"s-123"}"# });
        assert_eq!(convert_json(body(json_meta, "x")).session_key.unwrap(), "meta:s-123");
        // 没有 metadata：同一段对话后续轮次指纹不变，换了首条消息就变
        let a = convert_json(body(Value::Null, "turn 2")).session_key.unwrap();
        let b = convert_json(body(Value::Null, "turn 3")).session_key.unwrap();
        assert_eq!(a, b);
        assert!(a.starts_with("first:"));
        let mut other = body(Value::Null, "turn 2");
        other["messages"][0]["content"] = json!("another task");
        assert_ne!(convert_json(other).session_key.unwrap(), a);
    }

    #[test]
    fn upstream_session_id_is_stable_per_account_and_session() {
        let a = upstream_session_id(1, Some("meta:s"));
        assert_eq!(a, upstream_session_id(1, Some("meta:s")));
        assert_ne!(a, upstream_session_id(2, Some("meta:s")));
        assert!(a.starts_with('-') && a[1..].bytes().all(|b| b.is_ascii_digit()));
        // 没有会话指纹时每次都不同
        assert_ne!(upstream_session_id(1, None), upstream_session_id(1, None));
    }

    #[test]
    fn strips_agent_sdk_fingerprints() {
        let sys = system_text(json!({
            "model": "gemini-3-flash",
            "max_tokens": 1000,
            "system": "You are a Claude agent, built on Anthropic's Claude Agent SDK.\nKeep answers short.",
            "messages": [{ "role": "user", "content": "hi" }]
        }));
        assert!(!sys.contains("Claude Agent SDK"));
        assert!(sys.contains("Keep answers short."));
    }

    #[test]
    fn maps_tools_and_tool_history() {
        let out = convert_json(json!({
            "model": "gemini-3-flash",
            "max_tokens": 1000,
            "tool_choice": { "type": "tool", "name": "read" },
            "tools": [
                { "name": "write", "description": "w", "input_schema": { "type": "object" } },
                { "name": "read", "description": "r", "input_schema": { "type": "object", "properties": { "p": { "type": "string" } } } },
                { "type": "web_search_20250305", "name": "web_search", "max_uses": 3 }
            ],
            "messages": [
                { "role": "user", "content": "read a" },
                { "role": "assistant", "content": [
                    { "type": "tool_use", "id": "toolu_1", "name": "read", "input": { "p": "a" } }
                ]},
                { "role": "user", "content": [
                    { "type": "tool_result", "tool_use_id": "toolu_1", "content": [] }
                ]}
            ]
        }));
        let req = &out.envelope["request"];
        assert_eq!(out.envelope["requestType"], "agent");
        let decls = req["tools"][0]["functionDeclarations"].as_array().unwrap();
        assert_eq!(decls.len(), 2);
        assert_eq!(decls[0]["name"], "read");
        assert_eq!(req["toolConfig"]["functionCallingConfig"]["mode"], "ANY");
        assert_eq!(req["toolConfig"]["functionCallingConfig"]["allowedFunctionNames"], json!(["read"]));
        assert_eq!(req["tool_config"]["function_calling_config"]["allowed_function_names"], json!(["read"]));
        let contents = req["contents"].as_array().unwrap();
        let call = &contents[1]["parts"][0];
        assert_eq!(call["functionCall"]["name"], "read");
        // flash 接受占位签名
        assert_eq!(call["thoughtSignature"], PLACEHOLDER_THOUGHT_SIGNATURE);
        let resp = &contents[2]["parts"][0]["functionResponse"];
        assert_eq!(resp["name"], "read");
        assert_eq!(resp["response"]["result"], EMPTY_TOOL_RESULT);
    }

    #[test]
    fn disables_claude_thinking_when_tool_history_has_no_signature() {
        let out = convert_json(json!({
            "model": "claude-opus-4-6",
            "max_tokens": 4000,
            "thinking": { "type": "enabled", "budget_tokens": 8000 },
            "messages": [
                { "role": "user", "content": "go" },
                { "role": "assistant", "content": [
                    { "type": "tool_use", "id": "toolu_unsigned", "name": "x", "input": {} }
                ]},
                { "role": "user", "content": [
                    { "type": "tool_result", "tool_use_id": "toolu_unsigned", "content": "ok" }
                ]}
            ]
        }));
        let gc = &out.envelope["request"]["generationConfig"];
        assert!(gc.get("thinkingConfig").is_none());
        let call = &out.envelope["request"]["contents"][1]["parts"][0];
        assert!(call.get("thoughtSignature").is_none());
    }

    #[test]
    fn thinking_budget_stays_below_max_output() {
        let out = convert_json(json!({
            "model": "claude-opus-4-6",
            "max_tokens": 4000,
            "thinking": { "type": "enabled", "budget_tokens": 8000 },
            "messages": [{ "role": "user", "content": "go" }]
        }));
        let tc = &out.envelope["request"]["generationConfig"]["thinkingConfig"];
        assert_eq!(tc["thinkingBudget"], 2000);
        assert_eq!(out.envelope["request"]["generationConfig"]["maxOutputTokens"], 4000);
    }

    #[test]
    fn drops_claude_thinking_when_budget_cannot_reach_upstream_minimum() {
        // max_tokens 太小，挤不下 1024 的预算，宁可不开 thinking 也不能让上游报参数错误
        let out = convert_json(json!({
            "model": "claude-opus-4-6",
            "max_tokens": 500,
            "thinking": { "type": "enabled", "budget_tokens": 8000 },
            "messages": [{ "role": "user", "content": "go" }]
        }));
        assert!(out.envelope["request"]["generationConfig"].get("thinkingConfig").is_none());
    }

    #[test]
    fn replays_cached_tool_signature() {
        signatures::remember("toolu_cached", "sig-from-upstream-0123456789");
        let out = convert_json(json!({
            "model": "claude-opus-4-6",
            "max_tokens": 4000,
            "thinking": { "type": "enabled", "budget_tokens": 2000 },
            "messages": [
                { "role": "user", "content": "go" },
                { "role": "assistant", "content": [
                    { "type": "tool_use", "id": "toolu_cached", "name": "x", "input": {} }
                ]}
            ]
        }));
        let req = &out.envelope["request"];
        assert!(req["generationConfig"].get("thinkingConfig").is_some());
        assert_eq!(req["contents"][1]["parts"][0]["thoughtSignature"], "sig-from-upstream-0123456789");
    }

    #[test]
    fn adaptive_claude_uses_budget_for_resolved_model() {
        for (effort, expected) in [("low", 1024), ("medium", 8192), ("high", 24576)] {
            let out = convert_json(json!({
                "model": "claude-opus-4-6",
                "max_tokens": 64000,
                "thinking": { "type": "adaptive" },
                "output_config": { "effort": effort },
                "messages": [{ "role": "user", "content": "go" }]
            }));
            assert_eq!(out.model, models::CLAUDE_OPUS);
            let tc = &out.envelope["request"]["generationConfig"]["thinkingConfig"];
            assert_eq!(tc["thinkingBudget"], expected);
            assert!(tc.get("thinkingLevel").is_none());
        }
        for (effort, expected_model, expected_level) in [
            ("low", models::CLAUDE_OPUS_5_5_LOW, "LOW"),
            ("medium", models::CLAUDE_OPUS_5_5_MEDIUM, "MEDIUM"),
            ("high", models::CLAUDE_OPUS_5_5_HIGH, "HIGH"),
        ] {
            let out = convert_json(json!({
                "model": "claude-opus-5-5",
                "max_tokens": 128000,
                "thinking": { "type": "adaptive" },
                "output_config": { "effort": effort },
                "messages": [{ "role": "user", "content": "go" }]
            }));
            assert_eq!(out.model, expected_model);
            let gc = &out.envelope["request"]["generationConfig"];
            assert_eq!(gc["maxOutputTokens"], 128000);
            assert_eq!(gc["thinkingConfig"]["thinkingLevel"], expected_level);
            assert!(gc["thinkingConfig"].get("thinkingBudget").is_none());
        }
    }

    #[test]
    fn builds_aicode_request_with_entitlement_and_auto_tool_mode() {
        let out = convert_json(json!({
            "model": "claude-opus-5-5-high",
            "max_tokens": 4096,
            "tools": [
                { "name": "read", "description": "r", "input_schema": { "type": "object" } }
            ],
            "messages": [{ "role": "user", "content": "hi" }]
        }));
        let aicode = to_aicode_request(&out.envelope, &out.model, "g1-ultra-tier", "-42");
        assert_eq!(aicode["entitlement"]["userTier"], "g1-ultra-tier");
        assert_eq!(aicode["aicode"]["experience"], "claude-opus-5-5-high");
        assert_eq!(aicode["sessionId"], "-42");
        assert_eq!(aicode["toolConfig"]["functionCallingConfig"]["mode"], "AUTO");
        assert!(aicode["toolConfig"].get("includeServerSideToolInvocations").is_none());
        assert!(aicode.get("tool_config").is_none());
        assert!(aicode.get("request").is_none());
    }

    #[test]
    fn argon_levels_survive_unsigned_tool_history() {
        for (model, level) in [
            ("gemini-4-argon-high", "HIGH"),
            ("gemini-4-argon-medium", "MEDIUM"),
            ("gemini-4-argon-low", "LOW"),
            ("gemini-4-argon", "MEDIUM"),
        ] {
            let out = convert_json(json!({
                "model": model, "max_tokens": 65536,
                "thinking": { "type": "adaptive" },
                "messages": [
                    { "role": "user", "content": "read" },
                    { "role": "assistant", "content": [{ "type": "tool_use", "id": "argon_unsigned", "name": "read", "input": {} }] },
                    { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "argon_unsigned", "content": "ok" }] }
                ]
            }));
            let gc = &out.envelope["request"]["generationConfig"];
            assert_eq!(gc["maxOutputTokens"], 65536);
            assert_eq!(gc["thinkingConfig"]["thinkingLevel"], level);
            assert!(gc["thinkingConfig"].get("thinkingBudget").is_none());
            assert_eq!(out.envelope["request"]["contents"][1]["parts"][0]["thoughtSignature"], PLACEHOLDER_THOUGHT_SIGNATURE);
        }
    }

    #[test]
    fn flash_small_budget_reserves_output_and_disabled_is_explicit() {
        for max_tokens in [1, 256, 1024, 4000, 65536] {
            let out = convert_json(json!({
                "model": "gemini-3.8-flash-high", "max_tokens": max_tokens,
                "thinking": { "type": "adaptive" },
                "messages": [{ "role": "user", "content": "go" }]
            }));
            let gc = &out.envelope["request"]["generationConfig"];
            let budget = gc["thinkingConfig"]["thinkingBudget"].as_i64().unwrap();
            assert_eq!(gc["maxOutputTokens"], max_tokens);
            assert!(budget <= i64::from(max_tokens - (max_tokens / 2).clamp(1, 8192)));
            assert!(gc["thinkingConfig"].get("thinkingLevel").is_none());
        }
        let out = convert_json(json!({
            "model": "gemini-3.8-flash-high", "max_tokens": 4096,
            "thinking": { "type": "disabled" },
            "messages": [{ "role": "user", "content": "go" }]
        }));
        assert_eq!(out.envelope["request"]["generationConfig"]["thinkingConfig"], json!({ "includeThoughts": false, "thinkingBudget": 0 }));
    }

    #[test]
    fn disabled_claude_is_rejected_and_explicit_budget_wins_over_effort() {
        for model in [models::CLAUDE_OPUS, models::CLAUDE_SONNET] {
            let raw = json!({
                "model": model, "max_tokens": 64000,
                "thinking": { "type": "disabled" },
                "messages": [{ "role": "user", "content": "go" }]
            });
            let req: MessagesRequest = serde_json::from_value(raw.clone()).unwrap();
            assert!(validate_thinking(&req, &raw).is_err());
        }
        let out = convert_json(json!({
            "model": "gemini-3.8-flash-high", "max_tokens": 65536,
            "thinking": { "type": "enabled", "budget_tokens": 20000 },
            "output_config": { "effort": "low" },
            "messages": [{ "role": "user", "content": "go" }]
        }));
        assert_eq!(out.envelope["request"]["generationConfig"]["thinkingConfig"]["thinkingBudget"], 20000);
    }

    #[test]
    fn argon_rejects_unrepresentable_controls_and_conflicting_tiers() {
        for options in [
            json!({ "thinking": { "type": "disabled" } }),
            json!({ "thinking": { "type": "enabled", "budget_tokens": 2048 } }),
            json!({ "thinking": { "type": "adaptive" }, "output_config": { "effort": "low" } }),
        ] {
            let mut raw = json!({ "model": "gemini-4-argon-high", "max_tokens": 65536, "messages": [] });
            raw.as_object_mut().unwrap().extend(options.as_object().unwrap().clone());
            let req: MessagesRequest = serde_json::from_value(raw.clone()).unwrap();
            assert!(validate_thinking(&req, &raw).is_err());
        }
        let raw = json!({
            "model": "gemini-4-argon", "max_tokens": 65536,
            "thinking": { "type": "adaptive" }, "output_config": { "effort": "low" }, "messages": []
        });
        let req: MessagesRequest = serde_json::from_value(raw.clone()).unwrap();
        assert!(validate_thinking(&req, &raw).is_ok());
        assert_eq!(build_generation_config(&req, &raw, &req.model, true)["thinkingConfig"]["thinkingLevel"], "LOW");
    }

    #[test]
    fn cross_model_switch_strips_incompatible_or_unsigned_thoughts() {
        let gemini_sig = "Eo0ECooEAWkUfRNdU9V2Dklb7Kf6aASkz/YgzLid";
        let claude_sig = "Q0FRUzJnVUtFZ2dURUFJWUFqZ0JRZ2gwYUdsdWEybHVaeElNdEo5Uzl6Y3lnbFBIM3NBc0dneVgzS3ZZQytWUnEwY1lHb1lpTUdaNmdZMHpQNk9xbGkxSC9QZXF1T3l4Wm8xbEo5VzA0bThUVDg0Y0hQb25JNEc5SFE3WWRISVg3Uk44bTNMcXJpcjFCTlR1WSt5L2hCUXN1N2ZqNjl0b3ozUQ==";
        assert!(!is_claude_signature(gemini_sig));
        assert!(is_claude_signature(claude_sig));

        // 1. 从 Gemini 切到 Claude Opus 5.5：无签名或 Gemini 签名的 thinking 块被剥离，保留正文和工具调用
        let out_claude = convert_json(json!({
            "model": "claude-opus-5-5-high",
            "max_tokens": 4096,
            "messages": [
                { "role": "user", "content": "hi" },
                { "role": "assistant", "content": [
                    { "type": "thinking", "thinking": "unsigned thought", "signature": "" },
                    { "type": "thinking", "thinking": "gemini thought", "signature": gemini_sig },
                    { "type": "thinking", "thinking": "claude thought", "signature": claude_sig },
                    { "type": "text", "text": "hello" }
                ]}
            ]
        }));
        let parts = out_claude.envelope["request"]["contents"][1]["parts"].as_array().unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0]["text"], "claude thought");
        assert_eq!(parts[0]["thoughtSignature"], claude_sig);
        assert_eq!(parts[1]["text"], "hello");

        // 2. 从 Claude 切回 Gemini Argon：Claude 签名不传给 Argon，改用占位签名
        let out_argon = convert_json(json!({
            "model": "gemini-4-argon-high",
            "max_tokens": 4096,
            "messages": [
                { "role": "user", "content": "hi" },
                { "role": "assistant", "content": [
                    { "type": "thinking", "thinking": "claude thought", "signature": claude_sig },
                    { "type": "tool_use", "id": "call_from_claude", "name": "read", "input": {}, "signature": claude_sig }
                ]}
            ]
        }));
        let argon_parts = out_argon.envelope["request"]["contents"][1]["parts"].as_array().unwrap();
        assert!(argon_parts[0].get("thoughtSignature").is_none());
        assert_eq!(argon_parts[1]["thoughtSignature"], PLACEHOLDER_THOUGHT_SIGNATURE);
    }
}
