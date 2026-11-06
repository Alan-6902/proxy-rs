//! 上游 SSE 解析与两种对外格式的流式输出
//!
//! 上游帧：`data:{"headers":{..},"body":"<OpenAI chunk JSON 字符串>","statusCodeValue":200}`，
//! `body` 为 `[DONE]` 时结束；`event:finish` 等计时元数据忽略。拆开信封后就是 OpenAI chunk，
//! 统一解析成 [`Delta`]，再分别写成 OpenAI chunk 或 Anthropic 事件。

use serde_json::{Value, json};

use super::provider::QoderError;
use crate::anthropic::stream::SseEvent;

const DATA_PREFIX: &str = "data:";
const DONE_MARKER: &str = "[DONE]";
/// 单行上限，防止异常上游把内存撑爆
const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
pub const EMPTY_RESPONSE_ERROR: &str = "上游返回空内容（可能是上下文超限或被静默拒绝）";

/// 一帧里的增量
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Delta {
    pub content: String,
    pub reasoning: String,
    /// OpenAI 形态的 tool_calls 增量，合并规则见 [`ToolCalls`]
    pub tool_calls: Vec<Value>,
    pub finish_reason: Option<String>,
    pub usage: Option<Value>,
}

/// 上游帧解析结果
#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    Delta(Delta),
    /// 信封状态码非 200，或内层 chunk 带 error；分类结果随错误带出，由调用方决定重开 / 冷却 / 回错
    Error(QoderError),
    Done,
}

/// 按行切分字节流（跨块拼接）
#[derive(Default)]
pub struct LineDecoder {
    buf: Vec<u8>,
}

impl LineDecoder {
    pub fn feed(&mut self, bytes: &[u8]) -> Result<Vec<Frame>, &'static str> {
        self.buf.extend_from_slice(bytes);
        let mut frames = Vec::new();
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            frames.extend(parse_line(&String::from_utf8_lossy(&line)));
        }
        if self.buf.len() > MAX_LINE_BYTES {
            return Err("上游单行数据过大");
        }
        Ok(frames)
    }

    pub fn finish(&mut self) -> Vec<Frame> {
        let rest = std::mem::take(&mut self.buf);
        parse_line(&String::from_utf8_lossy(&rest)).into_iter().collect()
    }
}

fn status_of(v: &Value) -> Option<u16> {
    match v {
        Value::Number(n) => n.as_u64().map(|n| n as u16),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// 解析一行；非 data 行、心跳、无法解析的行返回 None
pub fn parse_line(line: &str) -> Option<Frame> {
    let data = line.trim().strip_prefix(DATA_PREFIX)?.trim();
    if data.is_empty() {
        return None;
    }
    if data == DONE_MARKER {
        return Some(Frame::Done);
    }
    let outer: Value = serde_json::from_str(data).ok()?;
    let status = status_of(&outer["statusCodeValue"]);
    let body = match &outer["body"] {
        Value::String(s) if s.trim() == DONE_MARKER => return Some(Frame::Done),
        Value::String(s) => match serde_json::from_str::<Value>(s) {
            Ok(v) => v,
            Err(_) if status.is_some_and(|c| c != 200) => Value::String(s.clone()),
            Err(_) => return None,
        },
        Value::Object(_) => outer["body"].clone(),
        // 没有信封：直接是 OpenAI chunk
        _ if outer.get("choices").is_some() || outer.get("error").is_some() => outer.clone(),
        _ => return None,
    };
    if status.is_some_and(|s| s != 200) || body.get("error").is_some_and(|e| !e.is_null()) {
        let raw = match &body {
            Value::String(s) => s.clone(),
            v => v.to_string(),
        };
        return Some(Frame::Error(QoderError::from(super::client::classify(status.unwrap_or(200), &raw))));
    }
    let choice = &body["choices"][0];
    let part = if choice["delta"].is_object() { &choice["delta"] } else { &choice["message"] };
    Some(Frame::Delta(Delta {
        content: part["content"].as_str().unwrap_or_default().to_string(),
        reasoning: part["reasoning_content"].as_str().unwrap_or_default().to_string(),
        tool_calls: part["tool_calls"].as_array().cloned().unwrap_or_default(),
        finish_reason: choice["finish_reason"].as_str().filter(|s| !s.is_empty()).map(str::to_string),
        usage: body.get("usage").filter(|u| u.is_object()).cloned(),
    }))
}

impl Delta {
    /// 是否携带客户端需要的内容（心跳 / 空增量不算）
    pub fn meaningful(&self) -> bool {
        !self.content.is_empty() || !self.reasoning.is_empty() || !self.tool_calls.is_empty()
            || self.finish_reason.is_some()
    }
}

fn usage_tokens(usage: &Value) -> (i64, i64, i64) {
    let cached = usage["prompt_tokens_details"]["cached_tokens"].as_i64()
        .or(usage["cache_read_tokens"].as_i64())
        .or(usage["prompt_cache_hit_tokens"].as_i64())
        .unwrap_or(0);
    (usage["prompt_tokens"].as_i64().unwrap_or(0), usage["completion_tokens"].as_i64().unwrap_or(0), cached)
}

/// 合并流式 tool_call：id / name 取第一个非空值，arguments 拼接。
///
/// 上游并行调用多个工具时会复用同一个 index（都是 0 或干脆不带），
/// 只按 index 合并会把几个调用的参数拼进第一个，所以 index 相同但
/// 带来了不同的 id、或已有名字时又带来新名字，都视为新的调用。
#[derive(Debug, Default, Clone)]
pub struct ToolCalls {
    /// (上游 index, id, name, arguments)；在 Vec 中的位置即对外的调用序号
    calls: Vec<(i64, String, String, String)>,
}

impl ToolCalls {
    /// 合并一批增量；返回每个增量对应的 (调用序号, 是否新出现, 本次 arguments 片段)
    pub fn add(&mut self, deltas: &[Value]) -> Vec<(i64, bool, String)> {
        deltas.iter().enumerate().map(|(pos, tc)| {
            let index = tc["index"].as_i64().unwrap_or(pos as i64);
            let id = tc["id"].as_str().unwrap_or_default();
            let name = tc["function"]["name"].as_str().unwrap_or_default();
            let args = tc["function"]["arguments"].as_str().unwrap_or_default().to_string();
            // 同一 index 取最近的那个调用，再看这次增量是不是另起了一个调用
            let existing = self.calls.iter().rposition(|c| c.0 == index).filter(|&slot| {
                let call = &self.calls[slot];
                let new_id = !id.is_empty() && !call.1.is_empty() && call.1 != id;
                let new_name = id.is_empty() && !name.is_empty() && !call.2.is_empty();
                !new_id && !new_name
            });
            let (slot, is_new) = match existing {
                Some(slot) => (slot, false),
                None => {
                    self.calls.push((index, String::new(), String::new(), String::new()));
                    (self.calls.len() - 1, true)
                }
            };
            let call = &mut self.calls[slot];
            if call.1.is_empty() {
                call.1 = id.to_string();
            }
            if call.2.is_empty() {
                call.2 = name.to_string();
            }
            call.3.push_str(&args);
            (slot as i64, is_new, args)
        }).collect()
    }

    fn get(&self, slot: i64) -> Option<&(i64, String, String, String)> {
        usize::try_from(slot).ok().and_then(|s| self.calls.get(s))
    }

    pub fn is_empty(&self) -> bool {
        self.calls.is_empty()
    }

    /// (id, name, arguments)，缺 id 时补一个
    pub fn finished(&self) -> Vec<(String, String, String)> {
        let mut calls = self.calls.clone();
        calls.sort_by_key(|c| c.0);
        calls.into_iter().map(|(_, id, name, args)| {
            let id = if id.is_empty() { format!("call_{}", uuid::Uuid::new_v4().simple()) } else { id };
            (id, name, args)
        }).collect()
    }
}

/// 两种格式共用的累计状态
#[derive(Debug, Default, Clone)]
pub struct Collected {
    pub content: String,
    pub reasoning: String,
    pub tools: ToolCalls,
    pub finish_reason: Option<String>,
    pub usage: Option<Value>,
}

impl Collected {
    pub fn push(&mut self, d: &Delta) {
        self.content.push_str(&d.content);
        self.reasoning.push_str(&d.reasoning);
        self.tools.add(&d.tool_calls);
        if d.finish_reason.is_some() {
            self.finish_reason = d.finish_reason.clone();
        }
        if d.usage.is_some() {
            self.usage = d.usage.clone();
        }
    }

    pub fn has_output(&self) -> bool {
        !self.content.is_empty() || !self.reasoning.is_empty() || !self.tools.is_empty()
    }

    fn openai_finish(&self) -> String {
        match self.finish_reason.as_deref() {
            _ if !self.tools.is_empty() => "tool_calls".to_string(),
            Some(f) => f.to_string(),
            None => "stop".to_string(),
        }
    }

    fn anthropic_stop(&self) -> &'static str {
        match self.openai_finish().as_str() {
            "tool_calls" => "tool_use",
            "length" => "max_tokens",
            _ => "end_turn",
        }
    }

    /// (input, output, cache_read)；上游没给 usage 时按字符估算
    fn tokens(&self, input_estimate: i64) -> (i64, i64, i64) {
        match &self.usage {
            Some(u) => {
                let (prompt, completion, cached) = usage_tokens(u);
                ((prompt - cached).max(0), completion, cached)
            }
            None => {
                let text = format!("{}{}{}", self.content, self.reasoning,
                    self.tools.finished().iter().map(|t| t.2.as_str()).collect::<String>());
                (input_estimate, crate::token::count_tokens(&text) as i64, 0)
            }
        }
    }

    fn openai_usage(&self, input_estimate: i64) -> Value {
        let (input, output, cached) = self.tokens(input_estimate);
        json!({
            "prompt_tokens": input + cached, "completion_tokens": output, "total_tokens": input + cached + output,
            "prompt_tokens_details": { "cached_tokens": cached },
        })
    }

    fn anthropic_usage(&self, input_estimate: i64) -> Value {
        let (input, output, cached) = self.tokens(input_estimate);
        json!({ "input_tokens": input, "output_tokens": output, "cache_read_input_tokens": cached })
    }

    /// 非流式 OpenAI chat.completion
    pub fn openai_response(&self, id: &str, model: &str, created: i64, input_estimate: i64) -> Value {
        let mut message = json!({ "role": "assistant", "content": self.content });
        if !self.reasoning.is_empty() {
            message["reasoning_content"] = json!(self.reasoning);
        }
        if !self.tools.is_empty() {
            message["tool_calls"] = Value::Array(self.tools.finished().into_iter().map(|(id, name, args)| json!({
                "id": id, "type": "function", "function": { "name": name, "arguments": args },
            })).collect());
        }
        json!({
            "id": id, "object": "chat.completion", "created": created, "model": model,
            "choices": [{ "index": 0, "message": message, "finish_reason": self.openai_finish() }],
            "usage": self.openai_usage(input_estimate),
        })
    }

    /// 非流式 Anthropic message
    pub fn anthropic_response(&self, id: &str, model: &str, input_estimate: i64) -> Value {
        let mut content = Vec::new();
        if !self.reasoning.is_empty() {
            content.push(json!({ "type": "thinking", "thinking": self.reasoning, "signature": "" }));
        }
        if !self.content.is_empty() {
            content.push(json!({ "type": "text", "text": self.content }));
        }
        for (id, name, args) in self.tools.finished() {
            content.push(json!({ "type": "tool_use", "id": id, "name": name, "input": parse_args(&args) }));
        }
        json!({
            "id": id, "type": "message", "role": "assistant", "model": model, "content": content,
            "stop_reason": self.anthropic_stop(), "stop_sequence": null,
            "usage": self.anthropic_usage(input_estimate),
        })
    }
}

fn parse_args(args: &str) -> Value {
    if args.trim().is_empty() {
        return json!({});
    }
    serde_json::from_str(args).unwrap_or_else(|_| json!({}))
}

/// OpenAI chat.completion.chunk 流
pub struct OpenAiWriter {
    id: String,
    model: String,
    created: i64,
    input_estimate: i64,
    collected: Collected,
    sent_role: bool,
}

impl OpenAiWriter {
    pub fn new(model: &str, input_estimate: i64) -> Self {
        Self {
            id: format!("chatcmpl-{}", uuid::Uuid::new_v4().simple()),
            model: model.to_string(),
            created: chrono::Utc::now().timestamp(),
            input_estimate,
            collected: Collected::default(),
            sent_role: false,
        }
    }

    fn chunk(&self, delta: Value, finish: Option<&str>, usage: Option<Value>) -> String {
        let mut chunk = json!({
            "id": self.id, "object": "chat.completion.chunk", "created": self.created, "model": self.model,
            "choices": [{ "index": 0, "delta": delta, "finish_reason": finish }],
        });
        if let Some(usage) = usage {
            chunk["usage"] = usage;
        }
        format!("data: {chunk}\n\n")
    }

    pub fn push(&mut self, d: &Delta) -> Vec<String> {
        // 先按合并后的调用序号改写 index，上游复用 index 时客户端才不会把参数拼到一起
        let slots = self.collected.tools.add(&d.tool_calls);
        let tool_calls: Vec<Value> = d.tool_calls.iter().zip(&slots).map(|(tc, (slot, _, _))| {
            let mut tc = tc.clone();
            tc["index"] = json!(slot);
            tc
        }).collect();
        self.collected.push(&Delta { tool_calls: Vec::new(), ..d.clone() });
        let mut delta = json!({});
        if !self.sent_role {
            delta["role"] = json!("assistant");
        }
        if !d.content.is_empty() {
            delta["content"] = json!(d.content);
        }
        if !d.reasoning.is_empty() {
            delta["reasoning_content"] = json!(d.reasoning);
        }
        if !tool_calls.is_empty() {
            delta["tool_calls"] = Value::Array(tool_calls);
        }
        if delta.as_object().is_some_and(|o| o.keys().all(|k| k == "role")) {
            return Vec::new();
        }
        self.sent_role = true;
        vec![self.chunk(delta, None, None)]
    }

    /// 收尾：补 finish_reason 与 usage，最后 [DONE]
    pub fn finish(&mut self) -> Vec<String> {
        let finish = self.collected.openai_finish();
        let usage = self.collected.openai_usage(self.input_estimate);
        vec![self.chunk(json!({}), Some(&finish), Some(usage)), "data: [DONE]\n\n".to_string()]
    }
}

pub fn openai_error_chunk(message: &str) -> String {
    format!("data: {}\n\n", json!({ "error": { "message": message, "type": "api_error" } }))
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Open {
    None,
    Thinking,
    Text,
    Tool(i64),
}

/// Anthropic Messages 事件流
pub struct AnthropicWriter {
    id: String,
    model: String,
    input_estimate: i64,
    collected: Collected,
    started: bool,
    open: Open,
    index: i64,
}

impl AnthropicWriter {
    pub fn new(model: &str, input_estimate: i64) -> Self {
        Self {
            id: format!("msg_{}", uuid::Uuid::new_v4().simple()),
            model: model.to_string(),
            input_estimate,
            collected: Collected::default(),
            started: false,
            open: Open::None,
            index: -1,
        }
    }

    pub fn start(&mut self) -> Vec<SseEvent> {
        if self.started {
            return Vec::new();
        }
        self.started = true;
        vec![SseEvent::new("message_start", json!({
            "type": "message_start",
            "message": {
                "id": self.id, "type": "message", "role": "assistant", "model": self.model, "content": [],
                "stop_reason": null, "stop_sequence": null,
                "usage": { "input_tokens": self.input_estimate, "output_tokens": 1 },
            },
        }))]
    }

    fn close(&mut self) -> Vec<SseEvent> {
        if self.open == Open::None {
            return Vec::new();
        }
        self.open = Open::None;
        vec![SseEvent::new("content_block_stop", json!({ "type": "content_block_stop", "index": self.index }))]
    }

    fn open_block(&mut self, open: Open, block: Value) -> Vec<SseEvent> {
        let mut events = self.close();
        self.index += 1;
        self.open = open;
        events.push(SseEvent::new("content_block_start", json!({
            "type": "content_block_start", "index": self.index, "content_block": block,
        })));
        events
    }

    fn delta(&self, delta: Value) -> SseEvent {
        SseEvent::new("content_block_delta", json!({ "type": "content_block_delta", "index": self.index, "delta": delta }))
    }

    pub fn push(&mut self, d: &Delta) -> Vec<SseEvent> {
        let mut events = self.start();
        if !d.reasoning.is_empty() {
            if self.open != Open::Thinking {
                events.extend(self.open_block(Open::Thinking, json!({ "type": "thinking", "thinking": "" })));
            }
            events.push(self.delta(json!({ "type": "thinking_delta", "thinking": d.reasoning })));
        }
        if !d.content.is_empty() {
            if self.open != Open::Text {
                events.extend(self.open_block(Open::Text, json!({ "type": "text", "text": "" })));
            }
            events.push(self.delta(json!({ "type": "text_delta", "text": d.content })));
        }
        for (index, is_new, args) in self.collected.tools.add(&d.tool_calls) {
            // 已关闭的工具又来参数：上游极少这样交错，参数只记进最终结果
            if !is_new && self.open != Open::Tool(index) {
                continue;
            }
            if is_new {
                let (_, id, name, _) = self.collected.tools.get(index).cloned().unwrap_or_default();
                let id = if id.is_empty() { format!("toolu_{}", uuid::Uuid::new_v4().simple()) } else { id };
                events.extend(self.open_block(Open::Tool(index),
                    json!({ "type": "tool_use", "id": id, "name": name, "input": {} })));
            }
            if !args.is_empty() {
                events.push(self.delta(json!({ "type": "input_json_delta", "partial_json": args })));
            }
        }
        self.collected.content.push_str(&d.content);
        self.collected.reasoning.push_str(&d.reasoning);
        if d.finish_reason.is_some() {
            self.collected.finish_reason = d.finish_reason.clone();
        }
        if d.usage.is_some() {
            self.collected.usage = d.usage.clone();
        }
        events
    }

    pub fn finish(&mut self) -> Vec<SseEvent> {
        let mut events = self.start();
        events.extend(self.close());
        events.push(SseEvent::new("message_delta", json!({
            "type": "message_delta",
            "delta": { "stop_reason": self.collected.anthropic_stop(), "stop_sequence": null },
            "usage": self.collected.anthropic_usage(self.input_estimate),
        })));
        events.push(SseEvent::new("message_stop", json!({ "type": "message_stop" })));
        events
    }
}

pub fn anthropic_error_event(message: &str) -> SseEvent {
    SseEvent::new("error", json!({ "type": "error", "error": { "type": "api_error", "message": message } }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::qoder::client::FailureKind;

    fn env(inner: Value) -> String {
        format!("data:{}\n", json!({ "headers": {}, "body": inner.to_string(), "statusCodeValue": 200 }))
    }

    #[test]
    fn parses_envelope_errors_and_done() {
        let mut dec = LineDecoder::default();
        let text = env(json!({"choices":[{"delta":{"content":"he"}}]}));
        let (a, b) = text.split_at(10);
        assert!(dec.feed(a.as_bytes()).unwrap().is_empty());
        let frames = dec.feed(b.as_bytes()).unwrap();
        assert!(matches!(&frames[..], [Frame::Delta(d)] if d.content == "he"));
        assert_eq!(parse_line("data:{\"body\":\"[DONE]\"}"), Some(Frame::Done));
        assert_eq!(parse_line("event:finish{}"), None);
        let Some(Frame::Error(teapot)) = parse_line("data:{\"body\":\"boom\",\"statusCodeValue\":\"418\"}") else { panic!() };
        assert_eq!((teapot.status, teapot.message.as_str(), teapot.kind),
            (502, "Qoder 上游 418: boom", Some(FailureKind::Unavailable)));
        assert!(matches!(parse_line(&env(json!({"error":{"message":"quota exceeded"}}))),
            Some(Frame::Error(e)) if e.status == 429));
        let Some(Frame::Delta(hb)) = parse_line(&env(json!({"choices":[{"delta":{}}]}))) else { panic!() };
        assert!(!hb.meaningful());
    }

    /// 信封层排队：HTTP 200 建流后在信封里投 403 + isQueued，要被认成排队而不是凭证问题
    #[test]
    fn envelope_queue_frame_is_queued_not_auth() {
        let body = json!({"isQueued":true,"retryAfterSeconds":30,"subCode":"RESOURCE_LIMIT"}).to_string();
        let line = format!("data:{}", json!({"headers":{}, "body":body, "statusCodeValue":403}));
        let Some(Frame::Error(e)) = parse_line(&line) else { panic!("未识别排队帧") };
        assert_eq!((e.status, e.kind, e.retry_after_secs), (503, Some(FailureKind::Queued), Some(30)));
    }

#[test]
    fn rejected_frames_keep_reason_in_every_envelope() {
        let body = json!({"error":{"code":406,"message":"","type":"intention_rejected"}});
        let frames = [
            format!("data:{}", json!({"statusCodeValue":416,"body":body.to_string()})),
            format!("data:{}", json!({"statusCodeValue":200,"body":body})),
            format!("data:{body}"),
        ];
        for line in frames {
            let Some(Frame::Error(e)) = parse_line(&line) else { panic!("未识别拒绝") };
            assert_eq!(e.status, 400);
            assert!(e.message.contains("intention_rejected，code=406"));
            assert!(e.message.contains("上游未提供具体原因"));
        }
    }

    fn deltas() -> Vec<Delta> {
        vec![
            Delta { reasoning: "think".into(), ..Default::default() },
            Delta { content: "hi".into(), ..Default::default() },
            Delta { tool_calls: vec![json!({"index":0,"id":"c1","type":"function","function":{"name":"Read","arguments":"{\"p\""}})], ..Default::default() },
            Delta { tool_calls: vec![json!({"index":0,"function":{"arguments":":1}"}})], finish_reason: Some("tool_calls".into()),
                usage: Some(json!({"prompt_tokens":10,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":4}})), ..Default::default() },
        ]
    }

    #[test]
    fn anthropic_stream_blocks() {
        let mut w = AnthropicWriter::new("m", 3);
        let mut events: Vec<SseEvent> = deltas().iter().flat_map(|d| w.push(d)).collect();
        events.extend(w.finish());
        let names: Vec<&str> = events.iter().map(|e| e.event.as_str()).collect();
        assert_eq!(names.iter().filter(|n| **n == "content_block_start").count(), 3);
        assert_eq!(names.first(), Some(&"message_start"));
        assert_eq!(names.last(), Some(&"message_stop"));
        let tool_start = events.iter().find(|e| e.data["content_block"]["type"] == "tool_use").unwrap();
        assert_eq!((tool_start.data["index"].clone(), tool_start.data["content_block"]["id"].clone()), (json!(2), json!("c1")));
        let delta = events.iter().find(|e| e.event == "message_delta").unwrap();
        assert_eq!(delta.data["delta"]["stop_reason"], "tool_use");
        assert_eq!(delta.data["usage"], json!({"input_tokens":6,"output_tokens":5,"cache_read_input_tokens":4}));
    }

    /// 上游并行工具调用复用 index 0（或不带 index）时，每个调用要各自成块
    #[test]
    fn parallel_tool_calls_sharing_index_stay_separate() {
        let call = |id: &str, name: &str, args: &str| Delta {
            tool_calls: vec![json!({"index":0,"id":id,"type":"function","function":{"name":name,"arguments":args}})],
            ..Default::default()
        };
        let more = |args: &str| Delta { tool_calls: vec![json!({"function":{"arguments":args}})], ..Default::default() };
        let stream = vec![
            call("a", "ToolSearch", ""), more("{\"query\":"), more("\"x\"}"),
            call("b", "Bash", "{\"command\":\"ls\"}"),
            call("c", "Bash", "{\"command\":\"pwd\"}"),
        ];
        let mut w = AnthropicWriter::new("m", 1);
        let mut events: Vec<SseEvent> = stream.iter().flat_map(|d| w.push(d)).collect();
        events.extend(w.finish());
        let starts: Vec<&SseEvent> = events.iter().filter(|e| e.data["content_block"]["type"] == "tool_use").collect();
        assert_eq!(starts.iter().map(|e| e.data["content_block"]["id"].clone()).collect::<Vec<_>>(),
            vec![json!("a"), json!("b"), json!("c")]);
        let args_of = |index: &Value| events.iter()
            .filter(|e| e.data["index"] == *index && e.data["delta"]["type"] == "input_json_delta")
            .map(|e| e.data["delta"]["partial_json"].as_str().unwrap()).collect::<String>();
        assert_eq!(args_of(&starts[0].data["index"]), "{\"query\":\"x\"}");
        assert_eq!(args_of(&starts[2].data["index"]), "{\"command\":\"pwd\"}");

        let mut c = Collected::default();
        stream.iter().for_each(|d| c.push(d));
        let a = c.anthropic_response("id", "m", 1);
        assert_eq!(a["content"].as_array().unwrap().len(), 3);
        assert_eq!(a["content"][1]["input"], json!({"command":"ls"}));

        let mut o = OpenAiWriter::new("m", 1);
        let lines: Vec<String> = stream.iter().flat_map(|d| o.push(d)).collect();
        let indices: Vec<i64> = lines.iter().map(|l| {
            let v: Value = serde_json::from_str(l.trim_start_matches("data: ").trim()).unwrap();
            v["choices"][0]["delta"]["tool_calls"][0]["index"].as_i64().unwrap()
        }).collect();
        assert_eq!(indices, vec![0, 0, 0, 1, 2]);
    }

    /// 标准 OpenAI 形态：index 分开、续包只带 index 与 arguments（偶尔重复 id），不能被拆成新调用
    #[test]
    fn distinct_index_tool_calls_merge_by_index() {
        let start = |index: i64, id: &str, name: &str| Delta {
            tool_calls: vec![json!({"index":index,"id":id,"type":"function","function":{"name":name,"arguments":""}})],
            ..Default::default()
        };
        let more = |index: i64, args: &str| Delta {
            tool_calls: vec![json!({"index":index,"function":{"arguments":args}})], ..Default::default()
        };
        let stream = vec![
            start(0, "a", "Read"), more(0, "{\"p\":"), more(0, "1}"),
            start(1, "b", "Bash"), more(1, "{\"command\":"),
            Delta { tool_calls: vec![json!({"index":1,"id":"b","function":{"arguments":"\"ls\"}"}})], ..Default::default() },
        ];
        let mut c = Collected::default();
        stream.iter().for_each(|d| c.push(d));
        let calls = c.openai_response("id", "m", 1, 1)["choices"][0]["message"]["tool_calls"].clone();
        assert_eq!(calls.as_array().unwrap().len(), 2);
        assert_eq!(calls[0]["function"]["arguments"], "{\"p\":1}");
        assert_eq!(calls[1]["function"]["arguments"], "{\"command\":\"ls\"}");

        let mut w = AnthropicWriter::new("m", 1);
        let mut events: Vec<SseEvent> = stream.iter().flat_map(|d| w.push(d)).collect();
        events.extend(w.finish());
        let starts: Vec<&SseEvent> = events.iter().filter(|e| e.data["content_block"]["type"] == "tool_use").collect();
        assert_eq!(starts.iter().map(|e| e.data["content_block"]["id"].clone()).collect::<Vec<_>>(), vec![json!("a"), json!("b")]);
        let args_b: String = events.iter()
            .filter(|e| e.data["index"] == starts[1].data["index"] && e.data["delta"]["type"] == "input_json_delta")
            .map(|e| e.data["delta"]["partial_json"].as_str().unwrap()).collect();
        assert_eq!(args_b, "{\"command\":\"ls\"}");

        let mut o = OpenAiWriter::new("m", 1);
        let indices: Vec<i64> = stream.iter().flat_map(|d| o.push(d)).map(|l| {
            let v: Value = serde_json::from_str(l.trim_start_matches("data: ").trim()).unwrap();
            v["choices"][0]["delta"]["tool_calls"][0]["index"].as_i64().unwrap()
        }).collect();
        assert_eq!(indices, vec![0, 0, 0, 1, 1, 1]);
    }

    #[test]
    fn openai_stream_and_non_stream() {
        let mut w = OpenAiWriter::new("m", 3);
        let mut lines: Vec<String> = deltas().iter().flat_map(|d| w.push(d)).collect();
        lines.extend(w.finish());
        assert!(lines[0].contains("\"role\":\"assistant\""));
        assert_eq!(lines.last().unwrap(), "data: [DONE]\n\n");
        assert!(lines[lines.len() - 2].contains("\"finish_reason\":\"tool_calls\""));
        let mut c = Collected::default();
        deltas().iter().for_each(|d| c.push(d));
        let o = c.openai_response("id", "m", 1, 3);
        assert_eq!(o["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"], "{\"p\":1}");
        assert_eq!(o["usage"]["prompt_tokens"], 10);
        let a = c.anthropic_response("id", "m", 3);
        assert_eq!(a["content"][2]["input"], json!({"p":1}));
        assert_eq!(a["stop_reason"], "tool_use");
        let empty = Collected { finish_reason: Some("length".into()), content: "x".into(), ..Default::default() };
        assert_eq!(empty.anthropic_response("i", "m", 1)["stop_reason"], "max_tokens");
    }
}
