//! 请求转换：Anthropic Messages → OpenAI Chat → Qoder agent_chat_generation 明文请求体
//!
//! 内部统一用 OpenAI Chat 形态（上游消息本身就是 OpenAI 格式）：`/v1/chat/completions`
//! 原样进入，`/v1/messages` 先转成 OpenAI 形态。

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

use super::consts::{AUTO_MODEL, COSY_VERSION, DEFAULT_MAX_INPUT_TOKENS, DEFAULT_MAX_TOKENS};

const SESSION_NAME_MAX_CHARS: usize = 10;
const EMPTY_TOOL_RESULT: &str = "(空结果)";
const QODER_SYS: &str = "You are a Qoder agent. Use the instructions below and the tools available to you to assist the user.";
const SMALL_OUTPUT_BUDGET: i64 = 1024;
const EFFORT_RANK: [&str; 8] = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultracode"];
const SCHEMA_DEPTH_LIMIT: usize = 64;
const SCHEMA_REF_LIMIT: usize = 16;

fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts.iter()
            .filter_map(|p| match p {
                Value::String(s) => Some(s.as_str()),
                _ if matches!(p["type"].as_str(), Some("text") | None) => p["text"].as_str(),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Anthropic image block → OpenAI image_url part
fn image_part(block: &Value) -> Option<Value> {
    let source = &block["source"];
    let url = match source["type"].as_str()? {
        "base64" => format!("data:{};base64,{}", source["media_type"].as_str()?, source["data"].as_str()?),
        "url" => source["url"].as_str()?.to_string(),
        _ => return None,
    };
    Some(json!({ "type": "image_url", "image_url": { "url": url } }))
}

/// 只有文本时压成字符串，带图片时保留 parts 数组
fn user_content(parts: Vec<Value>) -> Value {
    if parts.iter().all(|p| p["type"] == "text") {
        Value::String(parts.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("\n"))
    } else {
        Value::Array(parts)
    }
}

fn tool_result_text(block: &Value) -> String {
    let text = text_of(&block["content"]);
    let text = if text.trim().is_empty() { EMPTY_TOOL_RESULT.to_string() } else { text };
    if block["is_error"] == true { format!("[错误] {text}") } else { text }
}

/// 上游不支持的内容块（document、redacted_thinking、server_tool_use 等）只能丢弃，留下痕迹便于排查
fn warn_dropped_block(index: usize, role: &str, block: &Value) {
    tracing::warn!("[Qoder] messages[{index}]（{role}）含不支持的内容块 type={}，已丢弃",
        block["type"].as_str().unwrap_or("?"));
}

/// Anthropic Messages 请求 → OpenAI Chat 请求（字段只保留上游用得到的）
pub fn anthropic_to_openai(req: &Value) -> Value {
    let mut messages = Vec::new();
    let system = match &req["system"] {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n\n"),
        _ => String::new(),
    };
    if !system.trim().is_empty() {
        messages.push(json!({ "role": "system", "content": system }));
    }
    for (i, msg) in req["messages"].as_array().into_iter().flatten().enumerate() {
        let role = msg["role"].as_str().unwrap_or("user");
        let blocks = match &msg["content"] {
            Value::String(s) => vec![json!({ "type": "text", "text": s })],
            Value::Array(blocks) => blocks.clone(),
            _ => Vec::new(),
        };
        if role == "assistant" {
            let mut text = String::new();
            let mut reasoning = String::new();
            let mut tool_calls = Vec::new();
            for b in &blocks {
                match b["type"].as_str() {
                    Some("text") => text.push_str(b["text"].as_str().unwrap_or_default()),
                    Some("thinking") => reasoning.push_str(b["thinking"].as_str().unwrap_or_default()),
                    Some("tool_use") => tool_calls.push(json!({
                        "id": b["id"], "type": "function",
                        "function": { "name": b["name"], "arguments": b["input"].to_string() },
                    })),
                    _ => warn_dropped_block(i, role, b),
                }
            }
            // 上游只在 content 是字符串时才把 tool_calls 与后续 tool 消息配对，不能发 null
            let mut out = json!({ "role": "assistant", "content": text });
            if !reasoning.is_empty() {
                out["reasoning_content"] = json!(reasoning);
            }
            if !tool_calls.is_empty() {
                out["tool_calls"] = Value::Array(tool_calls);
            }
            messages.push(out);
            continue;
        }
        // user：tool_result 先拆成 tool 消息（必须紧跟 assistant），其余内容合成一条 user
        let mut parts = Vec::new();
        for b in &blocks {
            match b["type"].as_str() {
                Some("tool_result") => {
                    let images: Vec<Value> = b["content"].as_array().into_iter().flatten()
                        .filter(|p| p["type"] == "image").filter_map(image_part).collect();
                    let text = tool_result_text(b);
                    let content = if images.is_empty() { json!(text) } else {
                        let mut blocks = vec![json!({"type":"text", "text":text})];
                        blocks.extend(images);
                        Value::Array(blocks)
                    };
                    messages.push(json!({"role":"tool", "tool_call_id":b["tool_use_id"], "content":content}));
                },
                Some("text") => parts.push(json!({ "type": "text", "text": b["text"] })),
                Some("image") => parts.extend(image_part(b)),
                _ => warn_dropped_block(i, role, b),
            }
        }
        if !parts.is_empty() {
            messages.push(json!({ "role": "user", "content": user_content(parts) }));
        }
    }
    let tools: Vec<Value> = req["tools"].as_array().into_iter().flatten()
        .filter(|t| t["type"].is_null() || t["type"] == "custom")
        .map(|t| json!({ "type": "function", "function": {
            "name": t["name"], "description": t["description"],
            "parameters": if t["input_schema"].is_object() { t["input_schema"].clone() } else { json!({"type":"object"}) },
        }}))
        .collect();
    let mut out = json!({ "model": req["model"], "messages": messages, "stream": req["stream"] == true });
    if !tools.is_empty() {
        out["tools"] = Value::Array(tools);
    }
    out["tool_choice"] = match req["tool_choice"]["type"].as_str() {
        Some("any") => json!("required"),
        Some("none") => json!("none"),
        Some("tool") => json!({ "type": "function", "function": { "name": req["tool_choice"]["name"] } }),
        _ => Value::Null,
    };
    for key in ["max_tokens", "temperature", "top_p"] {
        out[key] = req[key].clone();
    }
    out["stop"] = req["stop_sequences"].clone();
    out["reasoning_effort"] = match (req["thinking"]["type"].as_str(), req["output_config"]["effort"].as_str()) {
        (Some("enabled" | "adaptive"), effort) => json!(effort.unwrap_or("high")),
        (Some("disabled"), _) => json!("none"),
        _ => Value::Null,
    };
    out
}

/// 最近一条带文本的 user 提示词（上游 chat_context 高亮与会话名）
fn latest_prompt(messages: &[Value]) -> String {
    messages.iter().rev()
        .filter(|m| m["role"] == "user")
        .map(|m| text_of(&m["content"]))
        .find(|t| !t.trim().is_empty())
        .unwrap_or_default()
}

/// 模型目录条目里本次请求用得到的元数据
#[derive(Debug, Clone, Default)]
pub struct ModelMeta {
    pub key: String,
    pub display_name: String,
    pub is_vl: bool,
    pub is_reasoning: bool,
    pub max_input_tokens: Option<i64>,
    /// 管理页选的上下文档位；发给上游的 parameters.context_length
    pub context_window: Option<i64>,
    /// 管理页选的思考强度；覆盖客户端请求里的强度
    pub effort: Option<String>,
    pub raw_config: Value,
    pub context_windows: Vec<i64>,
    pub default_context_window: Option<i64>,
    pub efforts: Vec<String>,
    pub default_effort: Option<String>,
}

/// 同一用户任务的工具循环共享生命周期，由 Provider 管理。
#[derive(Debug, Clone)]
pub struct TaskContext {
    pub id: String,
    pub begin_at_ms: i64,
    pub answered: bool,
}

/// 用户图文转为上游文本块，丢弃不受支持的块类型。
fn blocks_of(content: &Value) -> Vec<Value> {
    match content {
        Value::String(s) if !s.is_empty() => vec![json!({"type":"text", "text":s})],
        Value::Array(items) => items.iter().filter_map(|p| match p["type"].as_str() {
            Some("text") => p["text"].as_str().map(|s| json!({"type":"text", "text":s})),
            Some("image_url") => p["image_url"].as_str().or(p["image_url"]["url"].as_str())
                .map(|s| json!({"type":"image_url", "image_url":{"url":s}})),
            _ => None,
        }).collect(),
        _ => Vec::new(),
    }
}

/// 缺失调用 ID 用内容确定性派生，后续重发不会更换。
fn call_id(turn: usize, index: usize, call: &Value) -> String {
    let input = json!([turn, index, call["function"]]).to_string();
    format!("call_{}", hex::encode(Sha256::digest(input.as_bytes())))
}

fn flush_user(out: &mut Vec<Value>, pending: &mut Vec<Value>) {
    if !pending.is_empty() { out.push(json!({"role":"user", "content":std::mem::take(pending)})); }
}

/// 配对工具结果，保留推理与图片；没有对应调用的结果作为用户文本交给模型。
fn qoder_messages(input: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();
    let mut pending = Vec::new();
    let mut open: Vec<String> = Vec::new();
    let mut kept = HashSet::new();
    for (i, m) in input.iter().enumerate() {
        let role = m["role"].as_str().unwrap_or("user");
        if matches!(role, "system" | "developer") { continue; }
        if role == "user" { open.clear(); kept.clear(); }
        if !matches!(role, "user" | "tool") { flush_user(&mut out, &mut pending); }
        if role == "tool" {
            let named = m["tool_call_id"].as_str().unwrap_or_default().trim();
            let at = open.iter().position(|id| id == named)
                .or_else(|| open.iter().position(|id| !kept.contains(id)));
            let mut text = text_of(&m["content"]);
            let images: Vec<Value> = blocks_of(&m["content"]).into_iter().filter(|b| b["type"] == "image_url").collect();
            if let Some(at) = at {
                let id = open.remove(at);
                if !images.is_empty() {
                    pending.push(json!({"type":"text", "text":format!("[From the result of tool call {id}:]")}));
                    pending.extend(images);
                    text.push_str("\n\n[The tool returned an image; it follows in the next message.]");
                }
                out.push(json!({"role":"tool", "tool_call_id":id, "content":text}));
            } else {
                if !text.trim().is_empty() { pending.push(json!({"type":"text", "text":text})); }
                pending.extend(images);
            }
            continue;
        }
        if role == "assistant" && m["tool_calls"].as_array().is_some_and(|v| !v.is_empty()) {
            let calls: Vec<Value> = m["tool_calls"].as_array().unwrap().iter().enumerate().map(|(k, c)| {
                let id = c["id"].as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
                    .unwrap_or_else(|| call_id(i, k, c));
                let args = c["function"]["arguments"].as_str().map(str::to_string)
                    .unwrap_or_else(|| c["function"]["arguments"].to_string());
                json!({"id":id, "type":"function", "function":{"name":c["function"]["name"], "arguments":args}})
            }).collect();
            open = calls.iter().filter_map(|c| c["id"].as_str().map(str::to_string)).collect();
            kept = input[i+1..].iter().take_while(|r| r["role"] == "tool")
                .filter_map(|r| r["tool_call_id"].as_str().map(str::to_string)).filter(|id| open.contains(id)).collect();
            let mut message = json!({"role":"assistant", "content":text_of(&m["content"]), "tool_calls":calls});
            if let Some(t) = m["reasoning_content"].as_str().filter(|t| !t.trim().is_empty()) { message["reasoning_content"] = json!(t); }
            out.push(message);
            continue;
        }
        let mut blocks = blocks_of(&m["content"]);
        if role == "assistant" { blocks.retain(|b| b["type"] == "text"); }
        if blocks.is_empty() {
            // 入口已拦下空 user 内容，走到这里是内容块全部不受支持（如 file / input_audio）
            if role == "user" && pending.is_empty() {
                tracing::warn!("[Qoder] messages[{i}]（user）没有可用内容块，整条已丢弃");
            }
            continue;
        }
        if role == "user" && !pending.is_empty() {
            let mut combined = std::mem::take(&mut pending); combined.extend(blocks); blocks = combined;
        }
        let mut message = json!({"role":role, "content":blocks});
        if role == "assistant" && let Some(t) = m["reasoning_content"].as_str().filter(|t| !t.trim().is_empty()) {
            message["reasoning_content"] = json!(t);
        }
        out.push(message);
        open.clear(); kept.clear();
    }
    flush_user(&mut out, &mut pending);
    out
}

fn cache_marked(messages: &mut [Value]) {
    if let Some(last) = messages.last_mut().filter(|m| m["role"] == "user")
        && let Some(block) = last["content"].as_array_mut().and_then(|b| b.last_mut()) {
        block["cache_control"] = json!({"type":"ephemeral"});
    }
    for m in messages.iter_mut().filter(|m| m["role"] == "user" && m["content"].is_array()) {
        m["contents"] = m["content"].clone();
    }
}

fn effort_for(chat: &Value, model: &ModelMeta, budget: i64) -> (bool, Option<String>) {
    let explicit = model.effort.as_deref().or(chat["reasoning_effort"].as_str()).filter(|s| !s.is_empty());
    let want = explicit.unwrap_or(if budget <= SMALL_OUTPUT_BUDGET { "none" } else { "" });
    if !model.is_reasoning { return (false, None); }
    let supports_none = model.efforts.iter().any(|e| e == "none");
    if want == "none" && (supports_none || model.efforts.is_empty()) { return (false, None); }
    let levels: Vec<&str> = model.efforts.iter().map(String::as_str).filter(|s| *s != "none").collect();
    if want == "none" { return (true, levels.first().map(|s| s.to_string())); }
    if want.is_empty() { return (true, model.default_effort.clone()); }
    if levels.is_empty() || levels.contains(&want) { return (true, Some(want.to_string())); }
    // 显式管理配置已由保存接口校验，不能因输出预算而静默改掉。
    if model.effort.is_some() { return (true, Some(want.to_string())); }
    let rank = |s: &str| EFFORT_RANK.iter().position(|v| *v == s);
    let fitted = rank(want).and_then(|at| levels.iter().filter_map(|s| rank(s).map(|r| (*s, r)))
        .min_by_key(|(_, r)| (r.abs_diff(at), std::cmp::Reverse(*r))).map(|(s, _)| s.to_string()));
    (true, fitted.or_else(|| model.default_effort.clone()))
}

fn window_for(chat: &Value, model: &ModelMeta, reply: i64) -> Option<i64> {
    if model.context_window.is_some() { return model.context_window; }
    let base = model.default_context_window.or(model.max_input_tokens);
    let need = json!({"m":chat["messages"], "t":chat["tools"]}).to_string().len().div_ceil(3) as i64 + reply;
    if let Some(base) = base.filter(|b| *b >= need) { return Some(base); }
    model.context_windows.iter().copied().filter(|w| *w >= need).min()
        .or_else(|| model.context_windows.iter().copied().max()).or(base)
}

/// 只遍历 JSON Schema 子节点，不误改 examples/default 中的用户数据。
fn typed_unions(schema: &Value) -> Value {
    fn object_branch(v: &Value, root: &Value, seen: &mut Vec<String>) -> bool {
        if let Some(t) = v.get("type") { return t == "object"; }
        let Some(reference) = v["$ref"].as_str().filter(|r| r.starts_with("#/")) else { return false; };
        if seen.len() >= SCHEMA_REF_LIMIT || seen.iter().any(|s| s == reference) { return false; }
        seen.push(reference.to_string());
        root.pointer(&reference[1..]).is_some_and(|v| object_branch(v, root, seen))
    }
    fn walk(v: &mut Value, root: &Value, depth: usize) {
        if depth > SCHEMA_DEPTH_LIMIT || !v.is_object() { return; }
        if v.get("type").is_none() && v["oneOf"].as_array().is_some_and(|a| !a.is_empty() && a.iter().all(|b| object_branch(b, root, &mut Vec::new()))) {
            v["type"] = json!("object");
        }
        for key in ["items", "additionalItems", "unevaluatedItems", "contains", "not", "if", "then", "else", "propertyNames", "additionalProperties", "unevaluatedProperties"] {
            if let Some(s) = v.get_mut(key) { walk(s, root, depth + 1); }
        }
        for key in ["anyOf", "oneOf", "allOf", "prefixItems"] {
            if let Some(items) = v.get_mut(key).and_then(Value::as_array_mut) { for s in items { walk(s, root, depth + 1); } }
        }
        for key in ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"] {
            if let Some(map) = v.get_mut(key).and_then(Value::as_object_mut) { for s in map.values_mut() { walk(s, root, depth + 1); } }
        }
    }
    if schema.is_null() { return json!({"type":"object", "properties":{}}); }
    let mut out = schema.clone();
    walk(&mut out, schema, 0);
    out
}

/// OpenAI 请求转换为桌面端协议；会话与任务身份由调用方传入。
pub fn build_qoder_body(chat: &Value, model: &ModelMeta, conversation_id: &str, task: &TaskContext) -> Value {
    let input = chat["messages"].as_array().map(Vec::as_slice).unwrap_or_default();
    let user_system = input.iter().filter(|m| matches!(m["role"].as_str(), Some("system" | "developer")))
        .map(|m| text_of(&m["content"])).filter(|s| !s.trim().is_empty()).collect::<Vec<_>>().join("\n\n");
    let mut system = if user_system.is_empty() { QODER_SYS.to_string() } else { format!("{QODER_SYS}\n\n{user_system}") };
    let tools: Vec<Value> = chat["tools"].as_array().into_iter().flatten()
        .filter(|t| chat["tool_choice"] != "none" && t["type"] == "function" && t["function"]["name"].as_str().is_some_and(|n| !n.is_empty()))
        .map(|t| json!({"type":"function", "function":{
            "name":t["function"]["name"], "description":t["function"]["description"].as_str().unwrap_or_default(),
            "parameters":typed_unions(&t["function"]["parameters"]),
        }})).collect();
    if chat["tool_choice"] == "required" && !tools.is_empty() {
        system.push_str("\nYou must call an available function in this response.");
    }
    let sys = json!({"type":"text", "text":system});
    let mut messages = qoder_messages(input);
    cache_marked(&mut messages);
    messages.insert(0, json!({"role":"system", "content":[sys.clone()]}));
    let max_tokens = chat["max_completion_tokens"].as_i64().or(chat["max_tokens"].as_i64())
        .filter(|n| *n > 0).unwrap_or(DEFAULT_MAX_TOKENS);
    let (thinking, effort) = effort_for(chat, model, max_tokens);
    let mut parameters = json!({"max_tokens":max_tokens, "enable_thinking":thinking});
    if let Some(effort) = effort { parameters["reasoning_effort"] = json!(effort); }
    for key in ["temperature", "top_p", "stop", "tool_choice", "response_format", "parallel_tool_calls"] {
        if !chat[key].is_null() { parameters[key] = chat[key].clone(); }
    }
    if let Some(window) = window_for(chat, model, max_tokens) { parameters["context_length"] = json!(window); }
    let raw = &model.raw_config;
    let mut model_config = json!({
        "key":model.key, "display_name":model.display_name,
        "format":raw["format"].as_str().unwrap_or("openai"), "is_vl":model.is_vl,
        "is_reasoning":model.is_reasoning && thinking,
        "api_key":"", "url":"", "source":raw["source"].as_str().filter(|s| !s.is_empty()).unwrap_or("system"),
        "max_input_tokens":model.max_input_tokens.unwrap_or(DEFAULT_MAX_INPUT_TOKENS),
    });
    if let Some(provider) = raw["outer_provider"].as_str().filter(|s| !s.is_empty()) {
        model_config["outer_provider"] = json!(provider);
    } else { model_config["model"] = json!(""); }
    let request = uuid::Uuid::new_v4().to_string();
    let name: String = latest_prompt(input).chars().take(SESSION_NAME_MAX_CHARS).collect();
    let mut body = json!({
        "request_id":request, "chat_record_id":request, "session_id":conversation_id, "request_set_id":task.id,
        "agent_id":"agent_common", "task_id":"common", "session_type":"app",
        "system":[sys], "messages":messages, "parameters":parameters, "model_config":model_config,
        "business":{"product":"app", "version":COSY_VERSION, "type":"agent", "id":task.id,
            "name":name, "begin_at":task.begin_at_ms, "stage":if task.answered {"processing"} else {"start"}, "model_key":model.key},
    });
    if !tools.is_empty() { body["tools"] = json!(tools); }
    body
}

/// 请求的模型名：空串按 auto
pub fn requested_model(chat: &Value) -> String {
    chat["model"].as_str().map(str::trim).filter(|m| !m.is_empty()).unwrap_or(AUTO_MODEL).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anthropic_tool_round_trip_shapes() {
        let req = json!({
            "model": "auto", "max_tokens": 100, "stream": true,
            "system": [{"type":"text","text":"sys"}],
            "thinking": {"type":"enabled","budget_tokens":1000},
            "tools": [{"name":"Read","description":"d","input_schema":{"type":"object","properties":{}}},
                      {"type":"web_search_20250305","name":"web_search"}],
            "tool_choice": {"type":"any"},
            "messages": [
                {"role":"user","content":"hi"},
                {"role":"assistant","content":[{"type":"thinking","thinking":"t"},
                    {"type":"tool_use","id":"tu1","name":"Read","input":{"p":1}}]},
                {"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":""},
                    {"type":"text","text":"next"},
                    {"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAA"}}]},
            ],
        });
        let chat = anthropic_to_openai(&req);
        let m = chat["messages"].as_array().unwrap();
        assert_eq!(m.iter().map(|x| x["role"].as_str().unwrap()).collect::<Vec<_>>(),
            ["system", "user", "assistant", "tool", "user"]);
        assert_eq!(m[2]["content"], "");
        assert_eq!(m[2]["reasoning_content"], "t");
        assert_eq!(m[2]["tool_calls"][0]["function"]["arguments"], "{\"p\":1}");
        assert_eq!(m[3]["content"], EMPTY_TOOL_RESULT);
        assert_eq!(m[4]["content"][1]["image_url"]["url"], "data:image/png;base64,AAA");
        assert_eq!(chat["tools"].as_array().unwrap().len(), 1);
        assert_eq!((chat["tool_choice"].clone(), chat["reasoning_effort"].clone()), (json!("required"), json!("high")));
    }

    #[test]
    fn qoder_body_shape() {
        let chat = json!({"model":"m","max_tokens":50,"temperature":0.2,"messages":[
            {"role":"system","content":"a"},{"role":"developer","content":"b"},
            {"role":"user","content":"第一个问题，很长很长很长"}]});
        let meta = ModelMeta { key:"k1".into(), display_name:"K1".into(), is_reasoning:true,
            max_input_tokens:Some(180_000), context_window:Some(1_000_000),
            raw_config:json!({"format":"anthropic","source":"system"}), efforts:vec!["low".into(),"high".into()], ..Default::default() };
        let task = TaskContext { id:"task-1".into(), begin_at_ms:7, answered:true };
        let body = build_qoder_body(&chat, &meta, "session-1", &task);
        assert_eq!(body["system"][0]["text"], format!("{QODER_SYS}\n\na\n\nb"));
        assert_eq!(body["messages"][0]["content"], body["system"]);
        assert_eq!(body["messages"][1]["contents"], body["messages"][1]["content"]);
        assert_eq!(body["messages"][1]["content"][0]["cache_control"]["type"], "ephemeral");
        assert_eq!(body["parameters"], json!({"max_tokens":50,"enable_thinking":true,"reasoning_effort":"low","temperature":0.2,"context_length":1_000_000}));
        assert_eq!(body["model_config"]["max_input_tokens"], 180_000);
        assert_eq!(body["model_config"]["format"], "anthropic");
        assert_ne!(body["request_id"], "session-1");
        assert_eq!(body["request_id"], body["chat_record_id"]);
        assert_eq!((body["session_id"].clone(), body["request_set_id"].clone(), body["business"]["id"].clone()), (json!("session-1"), json!("task-1"), json!("task-1")));
        assert_eq!((body["session_type"].clone(), body["business"]["product"].clone(), body["business"]["stage"].clone()), (json!("app"), json!("app"), json!("processing")));
        assert_eq!(body["business"]["name"].as_str().unwrap().chars().count(), SESSION_NAME_MAX_CHARS);
        assert_eq!(requested_model(&json!({"model":" "})), AUTO_MODEL);
    }

    #[test]
    fn tool_results_pair_and_keep_images() {
        let chat = json!({"messages":[
            {"role":"user","content":"start"},
            {"role":"assistant","content":null,"reasoning_content":"plan","tool_calls":[
                {"type":"function","function":{"name":"Read","arguments":{"path":"a"}}},
                {"id":"named","type":"function","function":{"name":"Read","arguments":"{}"}}]},
            {"role":"tool","tool_call_id":"named","content":"second"},
            {"role":"tool","tool_call_id":"lost","content":[{"type":"text","text":"first"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AA"}}]},
            {"role":"tool","tool_call_id":"orphan","content":"spare"},
            {"role":"user","content":"next"}]});
        let first = qoder_messages(chat["messages"].as_array().unwrap());
        let second = qoder_messages(chat["messages"].as_array().unwrap());
        let generated = first[1]["tool_calls"][0]["id"].as_str().unwrap();
        assert_eq!(generated, second[1]["tool_calls"][0]["id"]);
        assert_eq!(first[1]["reasoning_content"], "plan");
        assert_eq!(first[2]["tool_call_id"], "named");
        assert_eq!(first[3]["tool_call_id"], generated);
        assert!(first[3]["content"].as_str().unwrap().contains("follows in the next message"));
        let pending = first[4]["content"].as_array().unwrap();
        assert!(pending.iter().any(|b| b["type"] == "image_url"));
        assert!(pending.iter().any(|b| b["text"] == "spare"));
        assert!(pending.iter().any(|b| b["text"] == "next"));
    }

    #[test]
    fn effort_and_window_follow_plugin_rules() {
        let model = ModelMeta { key:"k".into(), display_name:"K".into(), is_reasoning:true,
            max_input_tokens:Some(200_000), default_context_window:Some(200_000), context_windows:vec![200_000,400_000,1_000_000],
            efforts:vec!["low".into(),"high".into(),"max".into()], default_effort:Some("high".into()), ..Default::default() };
        let small = build_qoder_body(&json!({"max_tokens":32,"messages":[{"role":"user","content":"x"}]}), &model, "s", &TaskContext{id:"t".into(),begin_at_ms:1,answered:false});
        assert_eq!(small["parameters"]["reasoning_effort"], "low");
        let medium = build_qoder_body(&json!({"max_tokens":2000,"reasoning_effort":"medium","messages":[{"role":"user","content":"x"}]}), &model, "s", &TaskContext{id:"t".into(),begin_at_ms:1,answered:false});
        assert_eq!(medium["parameters"]["reasoning_effort"], "high");
        let explicit = ModelMeta { effort:Some("max".into()), ..model.clone() };
        let configured = build_qoder_body(&json!({"max_tokens":32,"reasoning_effort":"none","messages":[{"role":"user","content":"x"}]}), &explicit, "s", &TaskContext{id:"t".into(),begin_at_ms:1,answered:false});
        assert_eq!(configured["parameters"]["reasoning_effort"], "max");
        let large = "x".repeat(700_000);
        let chosen = build_qoder_body(&json!({"max_tokens":32000,"messages":[{"role":"user","content":large}]}), &model, "s", &TaskContext{id:"t".into(),begin_at_ms:1,answered:false});
        assert_eq!(chosen["parameters"]["context_length"], 400_000);
    }

    #[test]
    fn typed_unions_only_patch_object_branches() {
        let schema = json!({"$defs":{"o":{"type":"object"}},"properties":{"x":{"oneOf":[{"$ref":"#/$defs/o"},{"type":"object"}]},"y":{"oneOf":[{"type":"object"},{"type":"string"}]}},"examples":[{"oneOf":[{"type":"object"}]}]});
        let out = typed_unions(&schema);
        assert_eq!(out["properties"]["x"]["type"], "object");
        assert!(out["properties"]["y"].get("type").is_none());
        assert!(out["examples"][0].get("type").is_none());
    }
}
