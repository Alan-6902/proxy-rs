//! Anthropic Messages 请求 → Antigravity v1internal 请求
//!
//! 产出的信封不含 project / userAgent，由发送方按选中的账号补上。
//! 上游不认 `sessionId`，客户端 metadata 一律不转发。

use std::collections::HashMap;

use serde_json::{Map, Value, json};

use super::consts::{
    DEFAULT_IDENTITY, FLASH_THINKING_BUDGET_CAP, IDENTITY_MARKERS, MIN_SIGNATURE_LENGTH,
    PLACEHOLDER_THOUGHT_SIGNATURE, REQUEST_TYPE_AGENT, ROLE_MODEL, ROLE_USER, SAFETY_CATEGORIES,
    SAFETY_THRESHOLD_OFF, STOP_SEQUENCES,
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

const THINKING_ENABLED: &str = "enabled";
const THINKING_ADAPTIVE: &str = "adaptive";

const TOOL_CHOICE_AUTO: &str = "auto";
const TOOL_CHOICE_NONE: &str = "none";
const TOOL_CHOICE_TOOL: &str = "tool";
const MODE_VALIDATED: &str = "VALIDATED";
const MODE_AUTO: &str = "AUTO";
const MODE_NONE: &str = "NONE";
const MODE_ANY: &str = "ANY";

/// 转换结果
pub struct Converted {
    /// v1internal 信封（待补 project / userAgent）
    pub envelope: Value,
    /// 实际发给上游的模型 id
    pub model: String,
}

/// `raw` 是原始请求体：`MessagesRequest` 没有的采样参数（temperature 等）从这里读
pub fn convert(req: &MessagesRequest, raw: &Value) -> Converted {
    let model = models::map_model(&req.model);
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
    Converted { envelope, model }
}

fn new_request_id() -> String {
    let hex = uuid::Uuid::new_v4().simple().to_string();
    format!("agent/{}/{}", chrono::Utc::now().timestamp_millis(), &hex[..8])
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
        "thinking" => valid_signature(str_field(b, "signature")).is_some(),
        "tool_use" => {
            valid_signature(str_field(b, "signature")).is_some()
                || str_field(b, "id").and_then(signatures::lookup).is_some()
        }
        _ => false,
    })
}

fn build_generation_config(req: &MessagesRequest, raw: &Value, model: &str, thinking: bool) -> Value {
    let max_output = req.max_tokens.clamp(1, models::max_output_tokens(model));
    let mut config = Map::new();
    if thinking {
        let mut tc = json!({ "includeThoughts": true });
        let adaptive = req.thinking.as_ref().is_some_and(|t| t.thinking_type == THINKING_ADAPTIVE);
        if adaptive && models::is_claude(model) {
            let level = req
                .output_config
                .as_ref()
                .map(|c| c.effort.to_lowercase())
                .filter(|e| e == "low" || e == "medium")
                .unwrap_or_else(|| "high".to_string());
            tc["thinkingLevel"] = json!(level);
        } else {
            let mut budget = match &req.thinking {
                Some(t) if !adaptive && t.budget_tokens > 0 => t.budget_tokens,
                _ => models::default_thinking_budget(model),
            };
            if models::is_flash(model) {
                budget = budget.min(FLASH_THINKING_BUDGET_CAP);
            }
            // 预算必须小于最大输出，否则上游报参数错误
            tc["thinkingBudget"] = json!(budget.min(max_output - 1).max(0));
        }
        config.insert("thinkingConfig".into(), tc);
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

/// 去掉每轮都会变的日期行、把 UUID 换成占位符，让系统提示前缀稳定便于上游缓存
fn sanitize_system_text(text: &str) -> String {
    let kept: Vec<&str> = text
        .lines()
        .filter(|line| !is_volatile_date_line(line))
        .collect();
    let mut joined = replace_uuids(&kept.join("\n"));
    while joined.contains("\n\n\n") {
        joined = joined.replace("\n\n\n", "\n\n");
    }
    joined.trim().to_string()
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
    if kind == Some(TOOL_CHOICE_TOOL) {
        if let Some(name) = choice.and_then(|c| str_field(c, "name")) {
            fcc["allowedFunctionNames"] = json!([name]);
        }
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
                    let mut part = json!({
                        "text": str_field(block, "thinking").unwrap_or_default(),
                        "thought": true,
                    });
                    if let Some(sig) = str_field(block, "signature").filter(|s| !s.is_empty()) {
                        last_signature = Some(sig.to_string());
                        part = with_signature(part, sig);
                    }
                    parts.push(part);
                }
                "redacted_thinking" => {
                    let data = str_field(block, "data").unwrap_or_default();
                    parts.push(json!({ "text": format!("[Redacted Thinking: {data}]"), "thought": true }));
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
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                        .or_else(|| signatures::lookup(id))
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
        assert_eq!(tc["thinkingBudget"], 3999);
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
    fn adaptive_thinking_uses_level_on_claude() {
        let out = convert_json(json!({
            "model": "claude-opus-4-6",
            "max_tokens": 4000,
            "thinking": { "type": "adaptive" },
            "output_config": { "effort": "medium" },
            "messages": [{ "role": "user", "content": "go" }]
        }));
        let tc = &out.envelope["request"]["generationConfig"]["thinkingConfig"];
        assert_eq!(tc["thinkingLevel"], "medium");
        assert!(tc.get("thinkingBudget").is_none());
    }
}
