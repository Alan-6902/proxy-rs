//! 对外端点：`/v1/messages`（Anthropic）、`/v1/chat/completions`（OpenAI）、`/v1/models`、count_tokens

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    Json,
    body::Body,
    extract::State,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use bytes::Bytes;
use futures::{StreamExt, stream};
use serde_json::{Value, json};
use tokio::time::Instant;

use super::client::FailureKind;
use super::consts::ENVELOPE_REOPEN_MAX;
use super::converter::{ModelMeta, anthropic_to_openai, build_qoder_body, requested_model};
use super::provider::{QoderError, QoderProvider, QueueBudget};
use super::stream::{
    AnthropicWriter, Collected, Delta, EMPTY_RESPONSE_ERROR, Frame, LineDecoder, OpenAiWriter,
    anthropic_error_event, openai_error_chunk,
};
use crate::anthropic::types::{CountTokensRequest, CountTokensResponse, ErrorResponse};
use crate::common::websearch_relay::WebSearchRelay;
use crate::token;

const PING_INTERVAL_SECS: u64 = 25;
/// 打开上游（含选号、换网关、排队等待、信封层重开）的总时限；超过就不再试
const OPEN_TIMEOUT_SECS: u64 = 300;
/// 上游响应后等首个有效内容（思考也算）的上限
const FIRST_OUTPUT_TIMEOUT_SECS: u64 = 300;
/// 开始输出后连续这么久没数据就判定卡住
const UPSTREAM_IDLE_TIMEOUT_SECS: u64 = 180;
const GENERATION_TIMEOUT_SECS: u64 = 1800;
const IDLE_ERROR: &str = "上游长时间无输出，已终止本次请求";
const TIMEOUT_ERROR: &str = "上游生成等待超时，已终止本次请求";
const OPEN_TIMEOUT_ERROR: &str = "打开上游超时（含排队等待与重试），已终止本次请求";
const READ_ERROR: &str = "读取上游响应失败，生成已中断";
const MODEL_OWNER: &str = "qoder";
const MODEL_CREATED_AT: i64 = 1_770_652_800;

#[derive(Clone)]
pub struct QoderState {
    pub api_key: String,
    pub provider: Arc<QoderProvider>,
    /// Claude Code 的 WebSearch 子请求转给本机 kiro-rs 真搜；None 时服务端工具照旧被剥掉
    pub websearch: Option<Arc<WebSearchRelay>>,
}

fn status_code(status: u16) -> StatusCode {
    StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY)
}

/// 上游给了建议等待时间（排队 / 限流）就带上 Retry-After，客户端能据此退避
fn with_retry_after(mut response: Response, e: &QoderError) -> Response {
    if let Some(secs) = e.retry_after_secs
        && let Ok(value) = header::HeaderValue::from_str(&secs.to_string())
    {
        response.headers_mut().insert(header::RETRY_AFTER, value);
    }
    response
}

fn anthropic_error(e: &QoderError) -> Response {
    let kind = match e.status {
        400 => "invalid_request_error",
        401 => "authentication_error",
        429 => "rate_limit_error",
        503 => "overloaded_error",
        _ => "api_error",
    };
    with_retry_after((status_code(e.status), Json(ErrorResponse::new(kind, e.message.clone()))).into_response(), e)
}

fn openai_error(e: &QoderError) -> Response {
    let kind = if e.status == 400 { "invalid_request_error" } else { "api_error" };
    with_retry_after(
        (status_code(e.status), Json(json!({ "error": { "message": e.message, "type": kind, "code": e.status } })))
            .into_response(),
        e,
    )
}

/// messages 必须是数组；user 消息内容为空时转换层会整条丢掉、破坏角色交替，这里提前给出明确的 400
fn validate_messages(raw: &Value) -> Result<(), QoderError> {
    let Some(messages) = raw["messages"].as_array() else {
        return Err(QoderError::new(400, "请求体缺少 messages"));
    };
    for (i, m) in messages.iter().enumerate().filter(|(_, m)| m["role"] == "user") {
        let empty = match &m["content"] {
            Value::String(s) => s.trim().is_empty(),
            Value::Array(blocks) => blocks.is_empty(),
            _ => true,
        };
        if empty {
            return Err(QoderError::new(400, format!("messages[{i}].content 不能为空")));
        }
    }
    Ok(())
}

/// 一次生成的记账守卫：正常结束或上游出错时显式记一次；客户端提前断开导致响应流被丢弃时，
/// 由 Drop 按正常结束补记——账号已经正常出流，不该算它失败，也不该漏记。
struct Settle {
    provider: Arc<QoderProvider>,
    account_id: i64,
    done: bool,
}

impl Settle {
    fn new(provider: Arc<QoderProvider>, account_id: i64) -> Self {
        Self { provider, account_id, done: false }
    }

    fn finish(&mut self, error: Option<&QoderError>) {
        if !std::mem::replace(&mut self.done, true) {
            self.provider.finish(self.account_id, error);
        }
    }
}

impl Drop for Settle {
    fn drop(&mut self) {
        self.finish(None);
    }
}

/// GET /v1/models
pub async fn get_models(State(state): State<QoderState>) -> Response {
    let data: Vec<Value> = state.provider.public_models().await.into_iter().map(|m| json!({
        // 配了别名时客户端（如 Magpie）显示的名字也用别名，不再露出上游名
        "display_name": if m.public_id != m.id { &m.public_id } else { &m.display_name },
        "id": m.public_id, "object": "model", "created": MODEL_CREATED_AT, "owned_by": MODEL_OWNER,
        "type": "chat",
        "max_tokens": m.max_output, "max_completion_tokens": m.max_output,
        "context_window": m.context_window, "context_length": m.context_window,
    })).collect();
    Json(json!({ "object": "list", "data": data })).into_response()
}

/// POST /v1/messages/count_tokens
pub async fn count_tokens(Json(payload): Json<CountTokensRequest>) -> impl IntoResponse {
    let total = token::count_all_tokens(payload.model, payload.system, payload.messages, payload.tools);
    Json(CountTokensResponse { input_tokens: (total as i32).max(1) })
}

/// OpenAI 形态请求的输入 token 估算（上游没给 usage 时兜底）
fn estimate_input(chat: &Value) -> i64 {
    let text: String = chat["messages"].as_array().into_iter().flatten()
        .map(|m| match &m["content"] { Value::String(s) => s.clone(), v => v.to_string() })
        .chain(chat["tools"].as_array().map(|t| Value::Array(t.clone()).to_string()))
        .collect();
    (token::count_tokens(&text) as i64).max(1)
}

/// 会话标识只发送哈希；无显式标识时以系统消息与第一条用户消息稳定派生。
fn conversation_id(raw: &Value) -> String {
    use sha2::Digest;
    let named = raw["metadata"]["user_id"].as_str().filter(|s| !s.trim().is_empty())
        .or_else(|| raw["prompt_cache_key"].as_str().filter(|s| !s.trim().is_empty()))
        .or_else(|| raw["user"].as_str().filter(|s| !s.trim().is_empty()));
    let seed = if let Some(name) = named {
        json!(["session", name])
    } else {
        let messages = raw["messages"].as_array().cloned().unwrap_or_default();
        let system: Vec<&Value> = messages.iter().filter(|m| m["role"] == "system" || m["role"] == "developer").collect();
        let first = messages.iter().find(|m| m["role"] == "user").map(|m| &m["content"]);
        json!(["chat", raw["system"], system, first])
    };
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&sha2::Sha256::digest(seed.to_string().as_bytes())[..16]);
    uuid::Builder::from_random_bytes(bytes).into_uuid().to_string()
}

/// 上游读取循环的统一结果
enum Item {
    Delta(Delta),
    Ping,
    Error(QoderError),
    End,
}

/// 读上游、解析帧、处理首包 / 空闲 / 总超时与心跳；遇到 Error 或 End 后结束
fn upstream_items(response: reqwest::Response) -> futures::stream::BoxStream<'static, Item> {
    struct S {
        body: futures::stream::BoxStream<'static, reqwest::Result<Bytes>>,
        decoder: LineDecoder,
        pending: std::collections::VecDeque<Item>,
        started: Instant,
        idle_deadline: Option<Instant>,
        ping: tokio::time::Interval,
        done: bool,
    }
    let s = S {
        body: response.bytes_stream().boxed(),
        decoder: LineDecoder::default(),
        pending: Default::default(),
        started: Instant::now(),
        idle_deadline: None,
        ping: {
            let mut i = tokio::time::interval(Duration::from_secs(PING_INTERVAL_SECS));
            i.reset();
            i
        },
        done: false,
    };
    stream::unfold(s, |mut s| async move {
        loop {
            if let Some(item) = s.pending.pop_front() {
                if matches!(item, Item::Error(..) | Item::End) {
                    s.done = true;
                    s.pending.clear();
                }
                return Some((item, s));
            }
            if s.done {
                return None;
            }
            let total = s.started + Duration::from_secs(GENERATION_TIMEOUT_SECS);
            let (deadline, error) = match s.idle_deadline {
                None => ((s.started + Duration::from_secs(FIRST_OUTPUT_TIMEOUT_SECS)).min(total), TIMEOUT_ERROR),
                Some(at) if at < total => (at, IDLE_ERROR),
                Some(_) => (total, TIMEOUT_ERROR),
            };
            tokio::select! {
                biased;
                _ = tokio::time::sleep_until(deadline) => s.pending.push_back(Item::Error(QoderError::new(504, error))),
                chunk = s.body.next() => match chunk {
                    Some(Ok(bytes)) => match s.decoder.feed(&bytes) {
                        Ok(frames) => push_frames(&mut s.pending, &mut s.idle_deadline, frames),
                        Err(e) => s.pending.push_back(Item::Error(QoderError::new(502, e))),
                    },
                    // 连接层中断属于瞬时故障：首包前可以重开
                    Some(Err(_)) => s.pending.push_back(Item::Error(QoderError {
                        kind: Some(FailureKind::Unavailable), ..QoderError::new(502, READ_ERROR)
                    })),
                    None => {
                        let rest = s.decoder.finish();
                        push_frames(&mut s.pending, &mut s.idle_deadline, rest);
                        s.pending.push_back(Item::End);
                    }
                },
                _ = s.ping.tick() => return Some((Item::Ping, s)),
            }
        }
    }).boxed()
}

fn push_frames(pending: &mut std::collections::VecDeque<Item>, idle: &mut Option<Instant>, frames: Vec<Frame>) {
    for frame in frames {
        match frame {
            Frame::Delta(d) => {
                // 心跳帧不算进展，避免上游只发心跳时永远不超时
                if d.meaningful() || d.usage.is_some() {
                    *idle = Some(Instant::now() + Duration::from_secs(UPSTREAM_IDLE_TIMEOUT_SECS));
                    pending.push_back(Item::Delta(d));
                }
            }
            Frame::Error(e) => pending.push_back(Item::Error(e)),
            Frame::Done => pending.push_back(Item::End),
        }
    }
}

/// 打开上游并等到第一个有效内容：在这之前出错还能整体返回 HTTP 错误，而不是 200 里的错误事件。
///
/// 首包之前的失败按分类处理：信封层排队按上游建议等完再重开（与 HTTP 层共用一份预算）；
/// 瞬时错误（418 / 5xx / 供应商故障）最多重开 `ENVELOPE_REOPEN_MAX` 次，重开照常选号，可能换到别的账号；
/// 其余（额度、凭证、请求本身有问题、空响应）直接回错。整个打开过程不超过 `OPEN_TIMEOUT_SECS`；
/// 上游响应后的首包超时由 [`upstream_items`] 以 504 给出。
async fn open_and_peek(state: &QoderState, chat: &Value, raw: &Value)
    -> Result<(futures::stream::BoxStream<'static, Item>, Vec<Item>, Settle, ModelMeta), QoderError> {
    let model = state.provider.resolve_model(&requested_model(chat)).await?;
    let conversation = conversation_id(raw);
    let task = state.provider.task_for(&conversation, chat);
    let task_id = task.id.clone();
    let open_deadline = Instant::now() + Duration::from_secs(OPEN_TIMEOUT_SECS);
    let budget = QueueBudget::new();
    let mut reopens = 0usize;
    loop {
        let opened = {
            let model_for_body = model.clone();
            let open = state.provider.open_chat(model.clone(), |_account| {
                build_qoder_body(chat, &model_for_body, &conversation, &task)
            }, &budget);
            tokio::time::timeout_at(open_deadline, open).await
                .map_err(|_| QoderError::new(504, OPEN_TIMEOUT_ERROR))??
        };
        let mut settle = Settle::new(state.provider.clone(), opened.account_id);
        tracing::info!("[Qoder] 账号 #{} 模型 {} 上游已响应", opened.account_id, opened.model.key);
        let mut items = upstream_items(opened.response);
        let mut head = Vec::new();
        let error = loop {
            match items.next().await {
                Some(Item::Ping) => continue,
                Some(Item::Delta(d)) => {
                    let meaningful = d.meaningful();
                    head.push(Item::Delta(d));
                    if meaningful {
                        state.provider.task_answered(&task_id);
                        return Ok((items, head, settle, opened.model));
                    }
                }
                Some(Item::Error(e)) => break e,
                Some(Item::End) | None => break QoderError::new(502, EMPTY_RESPONSE_ERROR),
            }
        };
        settle.finish(Some(&error));
        match error.kind {
            // 信封层排队：等完重开，不占重开次数（预算用尽时 wait 直接给出 503）
            Some(FailureKind::Queued) => budget.wait(&error).await?,
            Some(FailureKind::Unavailable) if reopens < ENVELOPE_REOPEN_MAX => {
                reopens += 1;
                tracing::warn!("[Qoder] 账号 #{} 首包前上游瞬时错误，重开第 {reopens} 次：{}", opened.account_id, error.message);
            }
            _ => return Err(error),
        }
    }
}

fn sse_response(body: impl futures::Stream<Item = Result<Bytes, Infallible>> + Send + 'static) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::CONNECTION, "keep-alive")
        .body(Body::from_stream(body))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// 首包之后的收尾：非流式聚合时遇到错误返回 Err
async fn collect_rest(items: &mut futures::stream::BoxStream<'static, Item>, head: Vec<Item>, collected: &mut Collected)
    -> Option<QoderError> {
    let mut all = stream::iter(head).chain(items);
    while let Some(item) = all.next().await {
        match item {
            Item::Delta(d) => collected.push(&d),
            Item::Ping => {}
            Item::Error(e) => return Some(e),
            Item::End => break,
        }
    }
    None
}

/// POST /v1/messages（Anthropic）
pub async fn post_messages(State(state): State<QoderState>, Json(raw): Json<Value>) -> Response {
    // WebSearch 子请求：Qoder 上游不执行服务端工具，交给 kiro-rs 真搜；失败则按普通请求继续
    if let Some(relay) = state.websearch.as_ref().filter(|_| WebSearchRelay::is_web_search_request(&raw))
        && let Some(response) = relay.forward(&raw).await
    {
        return response;
    }
    if let Err(e) = validate_messages(&raw) {
        return anthropic_error(&e);
    }
    let chat = anthropic_to_openai(&raw);
    let model_name = requested_model(&chat);
    let stream = raw["stream"] == true;
    tracing::info!("[Qoder] /v1/messages model: {model_name}, stream: {stream}, messages: {}",
        raw["messages"].as_array().map_or(0, Vec::len));
    let input = estimate_input(&chat);
    let (mut items, head, mut settle, _) = match open_and_peek(&state, &chat, &raw).await {
        Ok(v) => v,
        Err(e) => return anthropic_error(&e),
    };
    if !stream {
        let mut collected = Collected::default();
        let error = collect_rest(&mut items, head, &mut collected).await;
        settle.finish(error.as_ref());
        if let Some(e) = error {
            return anthropic_error(&truncated_error(e, collected.has_output()));
        }
        let id = format!("msg_{}", uuid::Uuid::new_v4().simple());
        return Json(collected.anthropic_response(&id, &model_name, input)).into_response();
    }
    let mut writer = AnthropicWriter::new(&model_name, input);
    let body = stream::iter(head).chain(items).chain(stream::once(async { Item::End }))
        .scan(settle, move |settle, item| {
            if settle.done {
                return futures::future::ready(None);
            }
            let events = match item {
                Item::Delta(d) => writer.push(&d),
                Item::Ping => vec![crate::anthropic::stream::SseEvent::new("ping", json!({ "type": "ping" }))],
                Item::Error(e) => {
                    settle.finish(Some(&e));
                    vec![anthropic_error_event(&e.message)]
                }
                Item::End => {
                    settle.finish(None);
                    writer.finish()
                }
            };
            let text: String = events.iter().map(|e| e.to_sse_string()).collect();
            futures::future::ready(Some(Ok::<_, Infallible>(Bytes::from(text))))
        });
    sse_response(body)
}

/// POST /v1/chat/completions（OpenAI）
pub async fn post_chat_completions(State(state): State<QoderState>, Json(raw): Json<Value>) -> Response {
    if let Err(e) = validate_messages(&raw) {
        return openai_error(&e);
    }
    let model_name = requested_model(&raw);
    let stream = raw["stream"] == true;
    let include_usage = raw["stream_options"]["include_usage"] != false;
    tracing::info!("[Qoder] /v1/chat/completions model: {model_name}, stream: {stream}, messages: {}",
        raw["messages"].as_array().map_or(0, Vec::len));
    let input = estimate_input(&raw);
    let (mut items, head, mut settle, _) = match open_and_peek(&state, &raw, &raw).await {
        Ok(v) => v,
        Err(e) => return openai_error(&e),
    };
    if !stream {
        let mut collected = Collected::default();
        let error = collect_rest(&mut items, head, &mut collected).await;
        settle.finish(error.as_ref());
        if let Some(e) = error {
            return openai_error(&truncated_error(e, collected.has_output()));
        }
        let id = format!("chatcmpl-{}", uuid::Uuid::new_v4().simple());
        return Json(collected.openai_response(&id, &model_name, chrono::Utc::now().timestamp(), input)).into_response();
    }
    let mut writer = OpenAiWriter::new(&model_name, input);
    let body = stream::iter(head).chain(items).chain(stream::once(async { Item::End }))
        .scan(settle, move |settle, item| {
            if settle.done {
                return futures::future::ready(None);
            }
            let lines = match item {
                Item::Delta(d) => writer.push(&d),
                // SSE 注释行做心跳，OpenAI 客户端会忽略
                Item::Ping => vec![": ping\n\n".to_string()],
                Item::Error(e) => {
                    settle.finish(Some(&e));
                    vec![openai_error_chunk(&e.message), "data: [DONE]\n\n".to_string()]
                }
                Item::End => {
                    settle.finish(None);
                    let mut lines = writer.finish();
                    if !include_usage {
                        lines = lines.into_iter().map(|l| strip_usage(&l)).collect();
                    }
                    lines
                }
            };
            futures::future::ready(Some(Ok::<_, Infallible>(Bytes::from(lines.concat()))))
        });
    sse_response(body)
}

/// 非流式生成中途出错：已有部分输出也不能当成正常结束返回，否则客户端拿到截断结果却无从察觉
fn truncated_error(e: QoderError, partial: bool) -> QoderError {
    let status = if e.status == 200 { 502 } else { e.status };
    let message = if partial { format!("上游生成中途出错，结果不完整: {}", e.message) } else { e.message };
    QoderError { status, message, ..e }
}

/// 客户端显式 include_usage=false 时去掉末块的 usage
fn strip_usage(line: &str) -> String {
    let Some(data) = line.strip_prefix("data: ").map(str::trim) else { return line.to_string() };
    match serde_json::from_str::<Value>(data) {
        Ok(mut v) if v.get("usage").is_some() => {
            v.as_object_mut().map(|o| o.remove("usage"));
            format!("data: {v}\n\n")
        }
        _ => line.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conversation_id_is_stable_per_session() {
        let a = json!({"metadata":{"user_id":"user_x_session_1"}});
        assert_eq!(conversation_id(&a), conversation_id(&a));
        assert_ne!(conversation_id(&a), conversation_id(&json!({"metadata":{"user_id":"user_x_session_2"}})));
        let first = json!({"system":"规则","messages":[{"role":"user","content":"开始"}]});
        let later = json!({"system":"规则","messages":[{"role":"user","content":"开始"},
            {"role":"assistant","content":"好"},{"role":"user","content":"继续"}]});
        assert_eq!(conversation_id(&first), conversation_id(&later));
        assert_ne!(conversation_id(&first), conversation_id(&json!({"system":"规则","messages":[{"role":"user","content":"另一会话"}]})));
    }

    #[test]
    fn heartbeat_frames_do_not_extend_idle() {
        let mut pending = Default::default();
        let mut idle = None;
        push_frames(&mut pending, &mut idle, vec![Frame::Delta(Delta::default())]);
        assert!(idle.is_none() && pending.is_empty());
        push_frames(&mut pending, &mut idle, vec![Frame::Delta(Delta { content: "x".into(), ..Default::default() }), Frame::Done]);
        assert!(idle.is_some());
        assert_eq!(pending.len(), 2);
    }

    #[test]
    fn partial_output_with_error_is_not_success() {
        let e = truncated_error(QoderError::new(200, "boom"), true);
        assert_eq!(e.status, 502);
        assert!(e.message.contains("不完整") && e.message.contains("boom"));
        let quota = QoderError { status: 429, message: "q".into(), kind: Some(FailureKind::Quota), retry_after_secs: Some(9) };
        let kept = truncated_error(quota.clone(), false);
        assert_eq!((kept.message.as_str(), kept.kind, kept.retry_after_secs), ("q", Some(FailureKind::Quota), Some(9)));
    }

    /// 排队 / 限流回错时带 Retry-After，客户端能据此退避；普通错误不带
    #[test]
    fn errors_carry_retry_after_when_upstream_suggested_one() {
        let queued = QoderError { status: 503, message: "排队".into(), kind: Some(FailureKind::Queued), retry_after_secs: Some(30) };
        for response in [anthropic_error(&queued), openai_error(&queued)] {
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(response.headers()[header::RETRY_AFTER], "30");
        }
        assert!(anthropic_error(&QoderError::new(502, "x")).headers().get(header::RETRY_AFTER).is_none());
    }

    #[test]
    fn strip_usage_only_touches_usage_chunk() {
        assert_eq!(strip_usage("data: [DONE]\n\n"), "data: [DONE]\n\n");
        assert!(!strip_usage("data: {\"choices\":[],\"usage\":{\"a\":1}}\n\n").contains("usage"));
    }

    #[test]
    fn empty_user_message_is_rejected() {
        assert_eq!(validate_messages(&json!({"model":"m"})).unwrap_err().message, "请求体缺少 messages");
        for content in [json!(""), json!("  "), json!([]), Value::Null] {
            let e = validate_messages(&json!({"messages":[{"role":"user","content":"ok"},{"role":"user","content":content}]})).unwrap_err();
            assert_eq!((e.status, e.message.as_str()), (400, "messages[1].content 不能为空"));
        }
        // assistant 的空 content 合法（只带 tool_calls 时就是这样），tool 消息不在此校验
        assert!(validate_messages(&json!({"messages":[
            {"role":"user","content":[{"type":"text","text":"hi"}]},
            {"role":"assistant","content":"","tool_calls":[{"id":"c"}]},
            {"role":"tool","tool_call_id":"c","content":""}]})).is_ok());
    }

    #[test]
    fn settle_records_once_even_when_dropped_early() {
        use super::super::store::{NewAccount, QoderStore};
        let dir = std::env::temp_dir().join(format!("qoder-handlers-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let store = Arc::new(QoderStore::open_or_create(&dir.join("q.sqlite3"),
            Arc::new(super::super::vault::MemoryVault::default())).unwrap());
        let id = store.upsert(&NewAccount {
            uid: "u", name: None, email: None, pat: "pt-x", access_token: "at", refresh_token: None,
            expires_at_ms: 1, user_type: None, org_id: None, org_name: None,
        }).unwrap();
        let provider = Arc::new(QoderProvider::new(store.clone(), None).unwrap());
        // 客户端提前断开：守卫被丢弃时按正常结束补记一次
        drop(Settle::new(provider.clone(), id));
        // 已显式记为失败，再丢弃不会重复记
        let mut settle = Settle::new(provider.clone(), id);
        settle.finish(Some(&QoderError::new(502, "boom")));
        drop(settle);
        // 首包前撞上排队：既不算失败也不算成功
        let mut settle = Settle::new(provider.clone(), id);
        settle.finish(Some(&QoderError { status: 503, message: "q".into(), kind: Some(FailureKind::Queued), retry_after_secs: Some(30) }));
        drop(settle);
        let account = store.get(id).unwrap().unwrap();
        assert_eq!((account.success_count, account.failure_count), (1, 1));
        let trash = std::path::PathBuf::from(std::env::var_os("HOME").unwrap()).join(".Trash");
        std::fs::create_dir_all(&trash).unwrap();
        std::fs::rename(&dir, trash.join(dir.file_name().unwrap())).unwrap();
    }
}
