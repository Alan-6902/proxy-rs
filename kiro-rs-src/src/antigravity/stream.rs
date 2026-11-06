//! Antigravity SSE（Gemini 响应块）→ Anthropic SSE 事件
//!
//! 上游每行 `data: {"response": {candidates, usageMetadata}}`。非流式请求同样走流式上游，
//! 由 [`aggregate`] 把事件折叠成一条完整消息，保证两条路径的映射完全一致。

use serde_json::{Value, json};

use super::signatures;
use crate::anthropic::stream::SseEvent;

const FINISH_MAX_TOKENS: &str = "MAX_TOKENS";
const STOP_END_TURN: &str = "end_turn";
const STOP_MAX_TOKENS: &str = "max_tokens";
const STOP_TOOL_USE: &str = "tool_use";
const FINISH_STOP: &str = "STOP";
const EMPTY_RESPONSE_ERROR: &str = "上游结束时没有正文或工具调用，本次生成失败";
const INVALID_STREAM_ERROR: &str = "上游 SSE 数据无法解析";
const DATA_PREFIX: &str = "data:";
const DONE_MARKER: &str = "[DONE]";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BlockKind {
    None,
    Thinking,
    Text,
    Tool,
}

/// 按行切分上游 SSE 字节流，取出每个 `data:` 的 JSON
#[derive(Default)]
pub struct SseDecoder {
    buf: Vec<u8>,
}

impl SseDecoder {
    pub fn feed(&mut self, chunk: &[u8]) -> Result<Vec<Value>, &'static str> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(pos) = self.buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            if let Some(v) = parse_line(&line)? {
                out.push(v);
            }
        }
        Ok(out)
    }

    /// 流结束时处理最后一行（可能没有换行符）
    pub fn finish(&mut self) -> Result<Option<Value>, &'static str> {
        let line = std::mem::take(&mut self.buf);
        parse_line(&line)
    }
}

fn parse_line(line: &[u8]) -> Result<Option<Value>, &'static str> {
    let text = std::str::from_utf8(line).map_err(|_| INVALID_STREAM_ERROR)?.trim();
    let Some(data) = text.strip_prefix(DATA_PREFIX).map(str::trim) else {
        return Ok(None);
    };
    if data.is_empty() || data == DONE_MARKER {
        return Ok(None);
    }
    serde_json::from_str(data).map(Some).map_err(|_| INVALID_STREAM_ERROR)
}

/// 上游响应都包在 `response` 里；个别端点直接返回裸响应
pub fn unwrap_response(v: &Value) -> &Value {
    v.get("response").unwrap_or(v)
}

#[derive(Default, Clone, Copy)]
struct Usage {
    input: i64,
    output: i64,
    thinking: i64,
    cached: i64,
}

pub struct StreamState {
    message_id: String,
    model: String,
    started: bool,
    block_index: usize,
    block: BlockKind,
    /// 当前 thinking 块结束时要发出的签名
    pending_signature: Option<String>,
    /// 空文本 part 携带的签名，等下一个块或流结束时发出
    trailing_signature: Option<String>,
    last_signature: Option<String>,
    used_tool: bool,
    has_text: bool,
    saw_thinking: bool,
    upstream_error: bool,
    finish_reason: Option<String>,
    usage: Usage,
}

impl StreamState {
    pub fn new(model: impl Into<String>) -> Self {
        let id = uuid::Uuid::new_v4().simple().to_string();
        Self {
            message_id: format!("msg_{}", &id[..24]),
            model: model.into(),
            started: false,
            block_index: 0,
            block: BlockKind::None,
            pending_signature: None,
            trailing_signature: None,
            last_signature: None,
            used_tool: false,
            has_text: false,
            saw_thinking: false,
            upstream_error: false,
            finish_reason: None,
            usage: Usage::default(),
        }
    }

    fn usage_json(&self) -> Value {
        json!({
            "input_tokens": (self.usage.input - self.usage.cached).max(0),
            "output_tokens": self.usage.output + self.usage.thinking,
            "output_tokens_details": { "thinking_tokens": self.usage.thinking },
            "cache_read_input_tokens": self.usage.cached,
            "cache_creation_input_tokens": 0,
        })
    }

    fn message_start(&mut self) -> Vec<SseEvent> {
        if self.started {
            return Vec::new();
        }
        self.started = true;
        vec![SseEvent::new(
            "message_start",
            json!({
                "type": "message_start",
                "message": {
                    "id": self.message_id,
                    "type": "message",
                    "role": "assistant",
                    "model": self.model,
                    "content": [],
                    "stop_reason": null,
                    "stop_sequence": null,
                    "usage": self.usage_json(),
                }
            }),
        )]
    }

    /// 处理一个上游响应块
    pub fn process(&mut self, chunk: &Value) -> Vec<SseEvent> {
        let resp = unwrap_response(chunk);
        if resp.get("error").is_some() || chunk.get("error").is_some() {
            self.upstream_error = true;
        }
        if let Some(u) = resp.get("usageMetadata") {
            // 部分上游将用量分多帧发送，缺失字段不能覆盖为零。
            for (key, value) in [
                ("promptTokenCount", &mut self.usage.input),
                ("candidatesTokenCount", &mut self.usage.output),
                ("thoughtsTokenCount", &mut self.usage.thinking),
                ("cachedContentTokenCount", &mut self.usage.cached),
            ] {
                if let Some(n) = u.get(key).and_then(Value::as_i64) {
                    *value = n.max(0);
                }
            }
        }
        let mut events = self.message_start();
        let candidate = &resp["candidates"][0];
        if let Some(parts) = candidate["content"]["parts"].as_array() {
            for part in parts {
                events.extend(self.process_part(part));
            }
        }
        if let Some(reason) = candidate.get("finishReason").and_then(Value::as_str) {
            self.finish_reason = Some(reason.to_string());
        }
        events
    }

    fn delta(&self, delta: Value) -> SseEvent {
        SseEvent::new(
            "content_block_delta",
            json!({ "type": "content_block_delta", "index": self.block_index, "delta": delta }),
        )
    }

    fn start_block(&mut self, kind: BlockKind, content_block: Value) -> Vec<SseEvent> {
        let mut events = self.end_block();
        events.push(SseEvent::new(
            "content_block_start",
            json!({ "type": "content_block_start", "index": self.block_index, "content_block": content_block }),
        ));
        self.block = kind;
        events
    }

    fn end_block(&mut self) -> Vec<SseEvent> {
        if self.block == BlockKind::None {
            return Vec::new();
        }
        let mut events = Vec::new();
        if self.block == BlockKind::Thinking
            && let Some(sig) = self.pending_signature.take() {
                events.push(self.delta(json!({ "type": "signature_delta", "signature": sig })));
            }
        events.push(SseEvent::new(
            "content_block_stop",
            json!({ "type": "content_block_stop", "index": self.block_index }),
        ));
        self.block_index += 1;
        self.block = BlockKind::None;
        events
    }

    /// 只携带签名的空 thinking 块：让客户端下一轮把签名回传
    fn signature_carrier(&mut self, sig: String) -> Vec<SseEvent> {
        let mut events = self.start_block(BlockKind::Thinking, json!({ "type": "thinking", "thinking": "" }));
        events.push(self.delta(json!({ "type": "thinking_delta", "thinking": "" })));
        self.pending_signature = Some(sig);
        events.extend(self.end_block());
        events
    }

    fn flush_trailing(&mut self) -> Vec<SseEvent> {
        match self.trailing_signature.take() {
            Some(sig) => self.signature_carrier(sig),
            None => Vec::new(),
        }
    }

    fn process_part(&mut self, part: &Value) -> Vec<SseEvent> {
        let signature = part
            .get("thoughtSignature")
            .or_else(|| part.get("thought_signature"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        if let Some(sig) = &signature {
            self.last_signature = Some(sig.clone());
        }

        if let Some(fc) = part.get("functionCall") {
            let mut events = self.flush_trailing();
            events.extend(self.function_call(fc, signature));
            return events;
        }
        let Some(text) = part.get("text").and_then(Value::as_str) else {
            return Vec::new();
        };
        if part.get("thought").and_then(Value::as_bool).unwrap_or(false) {
            self.thinking(text, signature)
        } else {
            self.text(text, signature)
        }
    }

    fn thinking(&mut self, text: &str, signature: Option<String>) -> Vec<SseEvent> {
        let mut events = self.flush_trailing();
        if text.is_empty() && signature.is_none() {
            return events;
        }
        if self.block != BlockKind::Thinking {
            events.extend(self.start_block(BlockKind::Thinking, json!({ "type": "thinking", "thinking": "" })));
        }
        if !text.is_empty() {
            self.saw_thinking = true;
            events.push(self.delta(json!({ "type": "thinking_delta", "thinking": text })));
        }
        if signature.is_some() {
            self.pending_signature = signature;
        }
        events
    }

    fn text(&mut self, text: &str, signature: Option<String>) -> Vec<SseEvent> {
        if text.is_empty() {
            if signature.is_some() {
                self.trailing_signature = signature;
            }
            return Vec::new();
        }
        let mut events = self.flush_trailing();
        if let Some(sig) = signature {
            // 签名放在正文前的空 thinking 块里，正文保持纯文本
            events.extend(self.signature_carrier(sig));
        }
        if self.block != BlockKind::Text {
            events.extend(self.start_block(BlockKind::Text, json!({ "type": "text", "text": "" })));
        }
        self.has_text |= !text.trim().is_empty();
        events.push(self.delta(json!({ "type": "text_delta", "text": text })));
        events
    }

    fn function_call(&mut self, fc: &Value, signature: Option<String>) -> Vec<SseEvent> {
        let name = fc.get("name").and_then(Value::as_str).unwrap_or_default();
        if name.trim().is_empty() || fc.get("args").is_some_and(|args| !args.is_object()) {
            self.upstream_error = true;
            return Vec::new();
        }
        self.used_tool = true;
        let id = fc
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                let hex = uuid::Uuid::new_v4().simple().to_string();
                format!("toolu_{}", &hex[..24])
            });
        // 客户端不会回传 tool_use 上的签名，先记下来等下一轮回放
        if let Some(sig) = signature.as_ref().or(self.last_signature.as_ref()) {
            signatures::remember(&id, sig);
        }
        let mut events = self.start_block(
            BlockKind::Tool,
            json!({ "type": "tool_use", "id": id, "name": name, "input": {} }),
        );
        let args = fc.get("args").cloned().unwrap_or_else(|| json!({}));
        events.push(self.delta(json!({ "type": "input_json_delta", "partial_json": args.to_string() })));
        events.extend(self.end_block());
        events
    }

    pub fn request_id(&self) -> &str {
        &self.message_id
    }

    pub fn has_upstream_error(&self) -> bool {
        self.upstream_error
    }

    pub fn has_content(&self) -> bool {
        self.has_text || self.used_tool
    }

    /// 续跑段接在同一条消息后面：上一段的结束原因作废，等新一段自己给
    pub fn begin_continuation(&mut self) {
        self.finish_reason = None;
    }

    /// 上游正常结束，但只有思考、没有正文或工具调用：可以续跑一次
    pub fn thinking_only(&self) -> bool {
        (self.saw_thinking || self.usage.thinking > 0)
            && !self.has_content()
            && !self.upstream_error
            // 输出额度已经用完：续跑大概率再撞上限，直接按失败返回
            && self.finish_reason.as_deref() != Some(FINISH_MAX_TOKENS)
    }

    pub fn thinking_tokens(&self) -> i64 {
        self.usage.thinking
    }

    pub fn log_outcome(&self, error: Option<&str>) {
        tracing::info!(
            request_id = %self.message_id, model = %self.model,
            candidate_tokens = self.usage.output, thinking_tokens = self.usage.thinking,
            finish_reason = ?self.finish_reason, has_content = self.has_content(), error,
            "Antigravity 生成结束"
        );
    }

    /// 没有有效成果或缺少上游终止事件时，不伪造可续写的正常消息。
    pub fn finish(&mut self) -> Result<Vec<SseEvent>, &'static str> {
        if self.upstream_error {
            return Err("上游返回生成错误");
        }
        if !self.has_content() {
            return Err(EMPTY_RESPONSE_ERROR);
        }
        if !matches!(self.finish_reason.as_deref(), Some(FINISH_STOP | FINISH_MAX_TOKENS)) {
            return Err("上游未正常结束生成，响应可能不完整");
        }
        let mut events = self.message_start();
        // 收尾时的尾随签名后面已无块：不再补空 thinking 块，避免客户端把它当成最后一条消息、读不到正文。
        // 文本上的签名上游不做校验，丢弃不影响下一轮。
        self.trailing_signature = None;
        events.extend(self.end_block());
        let stop_reason = if self.used_tool {
            STOP_TOOL_USE
        } else if self.finish_reason.as_deref() == Some(FINISH_MAX_TOKENS) {
            STOP_MAX_TOKENS
        } else {
            STOP_END_TURN
        };
        events.push(SseEvent::new(
            "message_delta",
            json!({
                "type": "message_delta",
                "delta": { "stop_reason": stop_reason, "stop_sequence": null },
                "usage": self.usage_json(),
            }),
        ));
        events.push(SseEvent::new("message_stop", json!({ "type": "message_stop" })));
        Ok(events)
    }
}

/// 把 SSE 事件折叠成非流式的 Anthropic 消息
pub fn aggregate(events: &[SseEvent]) -> Value {
    let mut message = json!({});
    let mut blocks: Vec<Value> = Vec::new();
    let mut partial_json: Vec<String> = Vec::new();
    for e in events {
        let d = &e.data;
        match e.event.as_str() {
            "message_start" => message = d["message"].clone(),
            "content_block_start" => {
                blocks.push(d["content_block"].clone());
                partial_json.push(String::new());
            }
            "content_block_delta" => {
                let (Some(block), Some(json_buf)) = (blocks.last_mut(), partial_json.last_mut()) else {
                    continue;
                };
                let delta = &d["delta"];
                let append = |block: &mut Value, key: &str, piece: &Value| {
                    let cur = block[key].as_str().unwrap_or_default().to_string();
                    block[key] = json!(cur + piece.as_str().unwrap_or_default());
                };
                match delta["type"].as_str().unwrap_or_default() {
                    "text_delta" => append(block, "text", &delta["text"]),
                    "thinking_delta" => append(block, "thinking", &delta["thinking"]),
                    "signature_delta" => block["signature"] = delta["signature"].clone(),
                    "input_json_delta" => json_buf.push_str(delta["partial_json"].as_str().unwrap_or_default()),
                    _ => {}
                }
            }
            "content_block_stop" => {
                if let (Some(block), Some(json_buf)) = (blocks.last_mut(), partial_json.last())
                    && block["type"] == "tool_use" && !json_buf.is_empty() {
                        block["input"] = serde_json::from_str(json_buf).unwrap_or_else(|_| json!({}));
                    }
            }
            "message_delta" => {
                message["stop_reason"] = d["delta"]["stop_reason"].clone();
                message["usage"] = d["usage"].clone();
            }
            _ => {}
        }
    }
    message["content"] = Value::Array(blocks);
    message
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(chunks: &[Value]) -> (Vec<SseEvent>, Value) {
        let mut st = StreamState::new("claude-opus-4-6");
        let mut events = Vec::new();
        for c in chunks {
            events.extend(st.process(c));
        }
        events.extend(st.finish().unwrap());
        let msg = aggregate(&events);
        (events, msg)
    }

    #[test]
    fn decoder_splits_lines_across_chunks() {
        let mut d = SseDecoder::default();
        assert!(d.feed(b"data: {\"a\":").unwrap().is_empty());
        let out = d.feed(b"1}\n\ndata: [DONE]\ndata: {\"b\":2}").unwrap();
        assert_eq!(out, vec![json!({ "a": 1 })]);
        assert_eq!(d.finish().unwrap(), Some(json!({ "b": 2 })));
    }

    #[test]
    fn maps_thinking_text_and_usage() {
        let (events, msg) = run(&[
            json!({ "response": { "candidates": [{ "content": { "parts": [
                { "text": "hmm", "thought": true },
                { "text": "", "thought": true, "thoughtSignature": "sig-abcdefghijk" }
            ]}}]}}),
            json!({ "response": {
                "candidates": [{ "content": { "parts": [{ "text": "Hello" }] }, "finishReason": "STOP" }],
                "usageMetadata": { "promptTokenCount": 100, "candidatesTokenCount": 7, "thoughtsTokenCount": 3, "cachedContentTokenCount": 40 }
            }}),
        ]);
        assert_eq!(events[0].event, "message_start");
        assert_eq!(events.last().unwrap().event, "message_stop");
        let content = msg["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[0], json!({ "type": "thinking", "thinking": "hmm", "signature": "sig-abcdefghijk" }));
        assert_eq!(content[1], json!({ "type": "text", "text": "Hello" }));
        assert_eq!(msg["stop_reason"], "end_turn");
        assert_eq!(msg["usage"]["input_tokens"], 60);
        assert_eq!(msg["usage"]["cache_read_input_tokens"], 40);
        assert_eq!(msg["usage"]["output_tokens"], 10);
    }

    #[test]
    fn maps_function_call_and_remembers_signature() {
        let (_, msg) = run(&[json!({ "response": { "candidates": [{ "content": { "parts": [
            { "functionCall": { "name": "read", "args": { "p": "a" }, "id": "call_9" }, "thoughtSignature": "sig-tool-0123456" }
        ]}, "finishReason": "STOP" }]}})]);
        let block = &msg["content"][0];
        assert_eq!(block["type"], "tool_use");
        assert_eq!(block["id"], "call_9");
        assert_eq!(block["input"], json!({ "p": "a" }));
        assert_eq!(msg["stop_reason"], "tool_use");
        assert_eq!(signatures::lookup("call_9").as_deref(), Some("sig-tool-0123456"));
    }

    #[test]
    fn signed_text_gets_signature_carrier_and_keeps_max_tokens() {
        let (_, msg) = run(&[json!({ "response": { "candidates": [{ "content": { "parts": [
            { "text": "answer", "thoughtSignature": "sig-text-0123456" }
        ]}, "finishReason": "MAX_TOKENS" }]}})]);
        assert_eq!(msg["content"][0]["type"], "thinking");
        assert_eq!(msg["content"][0]["signature"], "sig-text-0123456");
        assert_eq!(msg["content"][1]["text"], "answer");
        assert_eq!(msg["stop_reason"], "max_tokens");
    }

    #[test]
    fn trailing_signature_after_text_does_not_end_with_empty_thinking() {
        let (_, msg) = run(&[json!({ "response": { "candidates": [{ "content": { "parts": [
            { "text": "answer" },
            { "text": "", "thoughtSignature": "sig-trailing-0123456" }
        ]}, "finishReason": "STOP" }]}})]);
        let content = msg["content"].as_array().unwrap();
        assert_eq!(content.len(), 1);
        assert_eq!(content[0], json!({ "type": "text", "text": "answer" }));
        assert_eq!(msg["stop_reason"], "end_turn");
    }

    #[test]
    fn trailing_signature_before_tool_call_is_kept() {
        let (_, msg) = run(&[json!({ "response": { "candidates": [{ "content": { "parts": [
            { "text": "answer" },
            { "text": "", "thoughtSignature": "sig-trailing-0123456" },
            { "functionCall": { "name": "read", "args": {}, "id": "call_trailing" } }
        ]}, "finishReason": "STOP" }]}})]);
        let types: Vec<_> = msg["content"].as_array().unwrap().iter().map(|b| b["type"].clone()).collect();
        assert_eq!(types, [json!("text"), json!("thinking"), json!("tool_use")]);
        assert_eq!(msg["content"][1]["signature"], "sig-trailing-0123456");
    }

    #[test]
    fn empty_and_thinking_only_responses_fail_instead_of_continuing() {
        for parts in [json!([]), json!([{ "text": "hmm", "thought": true }]), json!([{ "text": "   " }])] {
            let mut st = StreamState::new("gemini-4-argon-high");
            st.process(&json!({ "candidates": [{ "content": { "parts": parts }, "finishReason": "MAX_TOKENS" }],
                "usageMetadata": { "thoughtsTokenCount": 65535 } }));
            assert!(st.finish().is_err());
        }
    }

    #[test]
    fn missing_terminal_and_upstream_error_are_not_success() {
        let mut st = StreamState::new("gemini-3.8-flash-high");
        st.process(&json!({ "candidates": [{ "content": { "parts": [{ "text": "partial" }] } }] }));
        assert!(st.finish().is_err());
        st.process(&json!({ "error": { "message": "upstream secret detail" } }));
        assert!(st.finish().is_err());
    }

    #[test]
    fn split_usage_preserves_thinking_and_candidate_counts() {
        let (_, msg) = run(&[
            json!({ "usageMetadata": { "promptTokenCount": 100, "thoughtsTokenCount": 30 } }),
            json!({ "usageMetadata": { "candidatesTokenCount": 7 }, "candidates": [{
                "content": { "parts": [{ "text": "answer" }] }, "finishReason": "STOP" }] }),
        ]);
        assert_eq!(msg["usage"]["output_tokens"], 37);
        assert_eq!(msg["usage"]["input_tokens"], 100);
        assert_eq!(msg["usage"]["output_tokens_details"]["thinking_tokens"], 30);
    }

    #[test]
    fn malformed_sse_is_reported() {
        let mut decoder = SseDecoder::default();
        assert!(decoder.feed(b"data: {broken}\n").is_err());
    }
}
