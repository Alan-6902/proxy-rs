//! `/ag/v1` 的 Anthropic 兼容端点

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
use futures::{FutureExt, StreamExt, future::BoxFuture, stream};
use serde_json::Value;
use tokio::time::{Instant, interval, timeout_at};

use super::models;
use super::provider::{AgError, AntigravityProvider};
use super::stream::{SseDecoder, StreamState, aggregate};
use super::converter;
use crate::anthropic::stream::SseEvent;
use crate::anthropic::types::{
    CountTokensRequest, CountTokensResponse, ErrorResponse, MessagesRequest, Model, ModelsResponse,
};
use crate::token;

const PING_INTERVAL_SECS: u64 = 25;
// 首次输出上限：等待响应头加上游第一块数据（思考也算）。本地心跳不算上游进展。
const FIRST_OUTPUT_TIMEOUT_SECS: u64 = 300;
// 上游开始输出后，连续这么久没有新数据就判定卡住（思考流同样会顺延）。
const UPSTREAM_IDLE_TIMEOUT_SECS: u64 = 90;
// 每个请求第一次静默满空闲上限时，再宽限这么久：思考结束后上游常整包缓冲大工具调用，
// 期间完全不发数据。宽限只给一次，真卡住时最多多等这么久。
const UPSTREAM_IDLE_GRACE_SECS: u64 = 180;
const GENERATION_TIMEOUT_SECS: u64 = 600;
const GENERATION_TIMEOUT_ERROR: &str = "上游生成等待超时，已终止本次请求";
const UPSTREAM_IDLE_ERROR: &str = "上游长时间无输出，已终止本次请求";
const MODEL_OWNER: &str = "antigravity";
const MODEL_CREATED_AT: i64 = 1_770_652_800;

#[derive(Clone)]
pub struct AgState {
    pub api_key: String,
    pub provider: Arc<AntigravityProvider>,
}

fn error_response(status: StatusCode, message: impl Into<String>) -> Response {
    let kind = match status {
        StatusCode::BAD_REQUEST => "invalid_request_error",
        StatusCode::TOO_MANY_REQUESTS => "rate_limit_error",
        StatusCode::SERVICE_UNAVAILABLE => "overloaded_error",
        _ => "api_error",
    };
    (status, Json(ErrorResponse::new(kind, message))).into_response()
}

impl IntoResponse for AgError {
    fn into_response(self) -> Response {
        error_response(self.status, self.message)
    }
}

/// GET /v1/models（独立服务）或 /ag/v1/models（兼容挂载）
/// 管理与公开接口共用规格；用户明确清空后返回空列表。
pub async fn get_models(State(state): State<AgState>) -> Response {
    let entries = match state.provider.available_models() {
        Ok(entries) => entries,
        Err(e) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let data = entries.into_iter().map(|entry| {
        let max_tokens = models::max_output_tokens(&models::map_model(&entry.id));
        Model {
            max_tokens,
            max_completion_tokens: max_tokens,
            id: entry.id,
            object: "model".to_string(),
            created: MODEL_CREATED_AT,
            owned_by: MODEL_OWNER.to_string(),
            display_name: entry.display_name,
            model_type: "chat".to_string(),
            context_window: entry.context_window,
            context_length: entry.context_window,
        }
    }).collect();
    Json(ModelsResponse { object: "list".to_string(), data }).into_response()
}

/// POST /ag/v1/messages/count_tokens
pub async fn count_tokens(Json(payload): Json<CountTokensRequest>) -> impl IntoResponse {
    let total = token::count_all_tokens(payload.model, payload.system, payload.messages, payload.tools);
    Json(CountTokensResponse { input_tokens: (total as i32).max(1) })
}

/// POST /ag/v1/messages
pub async fn post_messages(State(state): State<AgState>, Json(raw): Json<Value>) -> Response {
    let req: MessagesRequest = match serde_json::from_value(raw.clone()) {
        Ok(r) => r,
        Err(e) => return error_response(StatusCode::BAD_REQUEST, format!("请求体无效: {e}")),
    };
    tracing::info!(
        "[AG] model: {}, stream: {}, messages: {}, max_tokens: {}",
        req.model,
        req.stream,
        req.messages.len(),
        req.max_tokens
    );
    if let Err(message) = converter::validate_thinking(&req, &raw) {
        return error_response(StatusCode::BAD_REQUEST, message);
    }
    let converted = converter::convert(&req, &raw);
    let started = Instant::now();
    let first_deadline = started + Duration::from_secs(FIRST_OUTPUT_TIMEOUT_SECS);
    let total_deadline = started + Duration::from_secs(GENERATION_TIMEOUT_SECS);
    // 对客户端回显请求型号；日志同时记录实际送往上游的型号与配置。
    let st = StreamState::new(req.model.clone());
    tracing::info!(
        request_id = st.request_id(), requested_model = %req.model,
        upstream_model = %converted.model,
        generation_config = %converted.envelope["request"]["generationConfig"],
        "Antigravity 生成配置"
    );
    let upstream = match timeout_at(first_deadline, state.provider.stream_generate(
        &converted.envelope, &converted.model, converted.session_key.as_deref(),
    )).await {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => {
            st.log_outcome(Some("上游请求失败"));
            return e.into_response();
        }
        Err(_) => {
            st.log_outcome(Some(GENERATION_TIMEOUT_ERROR));
            return error_response(StatusCode::GATEWAY_TIMEOUT, GENERATION_TIMEOUT_ERROR);
        }
    };
    tracing::info!(request_id = st.request_id(), elapsed_ms = started.elapsed().as_millis() as u64,
        "Antigravity 上游响应头已到达");
    let provider = state.provider.clone();
    let continuation: Continuation = Box::new(move || {
        let envelope = converter::continuation_envelope(&converted.envelope);
        async move {
            match provider.stream_generate(&envelope, &converted.model, converted.session_key.as_deref()).await {
                Ok(resp) => Some(upstream_body(resp.bytes_stream())),
                Err(e) => {
                    tracing::warn!("Antigravity 续跑请求失败: {}", e.message);
                    None
                }
            }
        }.boxed()
    });
    let limits = Limits {
        first: first_deadline,
        total: total_deadline,
        idle: Duration::from_secs(UPSTREAM_IDLE_TIMEOUT_SECS),
        grace: Duration::from_secs(UPSTREAM_IDLE_GRACE_SECS),
    };
    let events = generation_events(upstream_body(upstream.bytes_stream()), st, limits, Some(continuation));
    if req.stream {
        stream_response(events)
    } else {
        non_stream_response(events).await
    }
}

fn sse_bytes(events: Vec<SseEvent>) -> stream::Iter<std::vec::IntoIter<Result<Bytes, Infallible>>> {
    let bytes: Vec<Result<Bytes, Infallible>> =
        events.into_iter().map(|e| Ok(Bytes::from(e.to_sse_string()))).collect();
    stream::iter(bytes)
}

type GenerationEvents = futures::stream::BoxStream<'static, Result<Vec<SseEvent>, &'static str>>;
type UpstreamBody = futures::stream::BoxStream<'static, Result<Bytes, ()>>;
/// 只思考、不出正文时发起的续跑请求；拿不到上游响应时返回 None
type Continuation = Box<dyn FnOnce() -> BoxFuture<'static, Option<UpstreamBody>> + Send>;

const CONTINUATION_ERROR: &str = "上游续跑请求失败，本次生成没有正文或工具调用";

fn upstream_body<S, E>(body: S) -> UpstreamBody
where
    S: futures::Stream<Item = Result<Bytes, E>> + Send + 'static,
{
    body.map(|r| r.map_err(|_| ())).boxed()
}

#[derive(Clone, Copy)]
struct Limits {
    first: Instant,
    total: Instant,
    idle: Duration,
    grace: Duration,
}

struct Generation {
    body: UpstreamBody,
    st: StreamState,
    decoder: SseDecoder,
    ping: tokio::time::Interval,
    /// 上游下一次必须送来数据的时间；None 表示还没有任何输出
    idle_deadline: Option<Instant>,
    grace_used: bool,
    continuation: Option<Continuation>,
}

/// 两种响应模式共用解码、截止时间与错误判断；终止时立即释放上游流。
///
/// 截止规则：上游第一次输出（含思考）之前受首次截止约束；之后改为空闲截止，
/// 上游每来一块数据就顺延 `idle`。第一次静默满 `idle` 时再宽限一次 `grace`。
/// 本地发出的 ping 不算上游进展。全部不超过总上限。
///
/// 上游正常结束但只有思考时，用 `continuation` 在同一条消息后面续跑一次。
fn generation_events(
    body: UpstreamBody,
    st: StreamState,
    limits: Limits,
    continuation: Option<Continuation>,
) -> GenerationEvents {
    let g = Generation {
        body,
        st,
        decoder: SseDecoder::default(),
        ping: interval(Duration::from_secs(PING_INTERVAL_SECS)),
        idle_deadline: None,
        grace_used: false,
        continuation,
    };
    stream::unfold(Some(g), move |state| async move {
        let mut g = state?;
        let (deadline, timeout_error) = match g.idle_deadline {
            None => (limits.first.min(limits.total), GENERATION_TIMEOUT_ERROR),
            Some(at) if at < limits.total => (at, UPSTREAM_IDLE_ERROR),
            Some(_) => (limits.total, GENERATION_TIMEOUT_ERROR),
        };
        let had_content = g.st.has_content();
        let mut ended = false;
        let mut result = tokio::select! {
            biased;
            _ = tokio::time::sleep_until(deadline) => {
                if timeout_error == UPSTREAM_IDLE_ERROR && !g.grace_used {
                    g.grace_used = true;
                    g.idle_deadline = Some(Instant::now() + limits.grace);
                    tracing::info!(request_id = g.st.request_id(), elapsed_ms = elapsed_ms(limits.first),
                        grace_secs = limits.grace.as_secs(), "Antigravity 上游静默，宽限一次");
                    Ok(Vec::new())
                } else {
                    Err(timeout_error)
                }
            }
            chunk = g.body.next() => {
                match chunk {
                    Some(Ok(bytes)) => {
                        if g.idle_deadline.is_none() {
                            tracing::info!(request_id = g.st.request_id(),
                                elapsed_ms = elapsed_ms(limits.first), "Antigravity 上游开始输出");
                        }
                        g.idle_deadline = Some(Instant::now() + limits.idle);
                        let st = &mut g.st;
                        g.decoder.feed(&bytes).and_then(|chunks| {
                            let events = chunks.iter().flat_map(|v| st.process(v)).collect();
                            if st.has_upstream_error() { Err("上游返回生成错误") } else { Ok(events) }
                        })
                    }
                    Some(Err(_)) => Err("读取上游响应失败，生成已中断"),
                    None => {
                        ended = true;
                        g.decoder.finish().map(|last| last.map(|v| g.st.process(&v)).unwrap_or_default())
                    }
                }
            }
            _ = g.ping.tick() => Ok(vec![SseEvent::new("ping", serde_json::json!({ "type": "ping" }))]),
        };
        let mut finished = false;
        if ended {
            if let Ok(events) = result.as_mut() {
                match continue_thinking_only(&mut g, limits).await {
                    Ok(true) => {}
                    Ok(false) => {
                        finished = true;
                        match g.st.finish() {
                            Ok(tail) => events.extend(tail),
                            Err(e) => result = Err(e),
                        }
                    }
                    Err(e) => result = Err(e),
                }
            }
        }
        if !had_content && g.st.has_content() {
            tracing::info!(request_id = g.st.request_id(), elapsed_ms = elapsed_ms(limits.first),
                "Antigravity 首次有效内容");
        }
        if finished || result.is_err() {
            g.st.log_outcome(result.as_ref().err().copied());
            Some((result, None))
        } else {
            Some((result, Some(g)))
        }
    }).boxed()
}

/// 上游只思考就结束时换上续跑流。返回 true 表示已换上，继续读；false 表示照常收尾。
async fn continue_thinking_only(g: &mut Generation, limits: Limits) -> Result<bool, &'static str> {
    if !g.st.thinking_only() {
        return Ok(false);
    }
    let Some(next) = g.continuation.take() else {
        return Ok(false);
    };
    tracing::info!(request_id = g.st.request_id(), thinking_tokens = g.st.thinking_tokens(),
        elapsed_ms = elapsed_ms(limits.first), "Antigravity 只有思考没有正文，续跑一次");
    match timeout_at(limits.total, next()).await {
        Ok(Some(body)) => {
            g.body = body;
            g.decoder = SseDecoder::default();
            g.st.begin_continuation();
            g.idle_deadline = Some(Instant::now() + limits.idle);
            Ok(true)
        }
        Ok(None) => Err(CONTINUATION_ERROR),
        Err(_) => Err(GENERATION_TIMEOUT_ERROR),
    }
}

/// 从请求开始算起的耗时（首次截止 = 开始 + FIRST_OUTPUT_TIMEOUT_SECS）
fn elapsed_ms(first_deadline: Instant) -> u64 {
    (Instant::now() - (first_deadline - Duration::from_secs(FIRST_OUTPUT_TIMEOUT_SECS))).as_millis() as u64
}

fn stream_response(events: GenerationEvents) -> Response {
    let events = events.map(|result| {
        sse_bytes(match result {
            Ok(events) => events,
            Err(message) => vec![SseEvent::new("error", serde_json::json!({
                "type": "error", "error": { "type": "api_error", "message": message }
            }))],
        })
    }).flatten();
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::CONNECTION, "keep-alive")
        .body(Body::from_stream(events))
        .unwrap()
}

async fn non_stream_response(mut batches: GenerationEvents) -> Response {
    let mut events = Vec::new();
    while let Some(batch) = batches.next().await {
        match batch {
            Ok(batch) => events.extend(batch.into_iter().filter(|e| e.event != "ping")),
            Err(message) => return error_response(StatusCode::BAD_GATEWAY, message),
        }
    }
    Json(aggregate(&events)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const IDLE: Duration = Duration::from_secs(UPSTREAM_IDLE_TIMEOUT_SECS);
    const THINKING: &[u8] = b"data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"hmm\",\"thought\":true}]}}]}\n";
    const ANSWER: &[u8] = b"data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"done\"}]},\"finishReason\":\"STOP\"}]}\n";

    /// 测试用截止配置；宽限为 0 时第一次静默只多等一瞬
    fn limits(first: Duration, total: Duration, idle: Duration, grace: Duration) -> Limits {
        let now = Instant::now();
        Limits { first: now + first, total: now + total, idle, grace }
    }

    fn run_gen<S, E>(body: S, model: &str, limits: Limits) -> GenerationEvents
    where
        S: futures::Stream<Item = Result<Bytes, E>> + Send + 'static,
    {
        generation_events(upstream_body(body), StreamState::new(model), limits, None)
    }

    fn events(data: &'static [u8]) -> GenerationEvents {
        run_gen(stream::iter(vec![Ok::<_, ()>(Bytes::from_static(data))]), "gemini-4-argon-high",
            limits(Duration::from_secs(5), Duration::from_secs(10), IDLE, Duration::ZERO))
    }

    async fn first_error(mut batches: GenerationEvents) -> &'static str {
        loop {
            match batches.next().await.unwrap() {
                Ok(_) => continue,
                Err(e) => break e,
            }
        }
    }

    /// 每隔 `gap` 送一块思考，共 `count` 块；之后送正文或保持静默
    fn thinking_then(gap: Duration, count: usize, answer: bool)
        -> futures::stream::BoxStream<'static, Result<Bytes, ()>> {
        let chunks = stream::unfold(0usize, move |i| async move {
            if i >= count { return None; }
            tokio::time::sleep(gap).await;
            Some((Ok(Bytes::from_static(THINKING)), i + 1))
        });
        if answer {
            chunks.chain(stream::iter(vec![Ok(Bytes::from_static(ANSWER))])).boxed()
        } else {
            chunks.chain(stream::pending()).boxed()
        }
    }

    #[tokio::test]
    async fn thinking_counts_as_progress_past_first_deadline() {
        // 思考持续到首次截止之后才出正文：不应被首次截止掐断
        let batches = run_gen(thinking_then(Duration::from_millis(40), 8, true), "gemini-4-argon-high",
            limits(Duration::from_millis(100), Duration::from_secs(5), Duration::from_millis(200), Duration::ZERO));
        assert_eq!(non_stream_response(batches).await.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn upstream_silence_after_output_hits_idle_timeout() {
        // 上游开始思考后中途卡住：按空闲截止断开，不等到首次或总上限
        let now = Instant::now();
        let mut batches = run_gen(thinking_then(Duration::ZERO, 1, false), "gemini-4-argon-high",
            limits(Duration::from_secs(5), Duration::from_secs(5), Duration::from_millis(100), Duration::ZERO));
        let error = loop {
            match batches.next().await.unwrap() {
                Ok(_) => continue,
                Err(e) => break e,
            }
        };
        assert_eq!(error, UPSTREAM_IDLE_ERROR);
        assert!(now.elapsed() < Duration::from_secs(2));
        assert!(batches.next().await.is_none());
    }

    #[tokio::test]
    async fn first_silence_gets_one_grace_then_idle_timeout() {
        // 第一次静默满空闲上限后再宽限一次：宽限内恢复输出就正常完成
        let body = stream::iter(vec![Ok::<_, ()>(Bytes::from_static(THINKING))])
            .chain(stream::once(async {
                tokio::time::sleep(Duration::from_millis(250)).await;
                Ok(Bytes::from_static(ANSWER))
            }));
        let batches = run_gen(body, "gemini-4-argon-high",
            limits(Duration::from_secs(5), Duration::from_secs(5), Duration::from_millis(100), Duration::from_millis(400)));
        assert_eq!(non_stream_response(batches).await.status(), StatusCode::OK);

        // 宽限只有一次：宽限后再静默就断开，总耗时约 idle + grace
        let now = Instant::now();
        let batches = run_gen(thinking_then(Duration::ZERO, 1, false), "gemini-4-argon-high",
            limits(Duration::from_secs(5), Duration::from_secs(5), Duration::from_millis(100), Duration::from_millis(200)));
        assert_eq!(first_error(batches).await, UPSTREAM_IDLE_ERROR);
        let elapsed = now.elapsed();
        assert!(elapsed >= Duration::from_millis(300) && elapsed < Duration::from_secs(2), "{elapsed:?}");
    }

    const THINK_STOP: &[u8] = b"data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"hmm\",\"thought\":true}]},\"finishReason\":\"STOP\"}]}\n";

    fn with_continuation(first: &'static [u8], next: Option<&'static [u8]>, calls: Arc<std::sync::atomic::AtomicUsize>)
        -> GenerationEvents {
        let continuation: Continuation = Box::new(move || {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async move {
                next.map(|data| upstream_body(stream::iter(vec![Ok::<_, ()>(Bytes::from_static(data))])))
            }.boxed()
        });
        generation_events(upstream_body(stream::iter(vec![Ok::<_, ()>(Bytes::from_static(first))])),
            StreamState::new("gemini-4-argon-high"),
            limits(Duration::from_secs(5), Duration::from_secs(10), IDLE, Duration::ZERO), Some(continuation))
    }

    #[tokio::test]
    async fn thinking_only_stop_continues_once_in_same_message() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        // 续跑出正文：同一条消息里先思考后正文，只有一个 message_start / message_stop
        let calls = Arc::new(AtomicUsize::new(0));
        let response = stream_response(with_continuation(THINK_STOP, Some(ANSWER), calls.clone()));
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(text.matches("event: message_start").count(), 1);
        assert_eq!(text.matches("event: message_stop").count(), 1);
        assert!(text.contains("\"text\":\"done\""));
        assert!(!text.contains("event: error"));

        // 续跑后仍只有思考：只续一次，按空回复失败，不伪造 message_stop
        let calls = Arc::new(AtomicUsize::new(0));
        let response = stream_response(with_continuation(THINK_STOP, Some(THINK_STOP), calls.clone()));
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(text.contains("event: error"));
        assert!(!text.contains("event: message_stop"));

        // 续跑请求本身失败：报续跑失败
        let calls = Arc::new(AtomicUsize::new(0));
        assert_eq!(first_error(with_continuation(THINK_STOP, None, calls)).await, CONTINUATION_ERROR);
    }

    #[tokio::test]
    async fn max_tokens_and_normal_answers_do_not_continue() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        const THINK_MAX: &[u8] = b"data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"hmm\",\"thought\":true}]},\"finishReason\":\"MAX_TOKENS\"}]}\n";
        for (data, ok) in [(THINK_MAX, false), (ANSWER, true)] {
            let calls = Arc::new(AtomicUsize::new(0));
            let status = non_stream_response(with_continuation(data, Some(ANSWER), calls.clone())).await.status();
            assert_eq!(calls.load(Ordering::SeqCst), 0);
            assert_eq!(status.is_success(), ok);
        }
    }

    #[tokio::test]
    async fn endless_thinking_is_capped_by_total_deadline() {
        // 思考一直不停：空闲截止不断顺延，但仍受总上限约束
        let now = Instant::now();
        let batches = run_gen(thinking_then(Duration::from_millis(30), usize::MAX, false), "gemini-4-argon-high",
            limits(Duration::from_millis(100), Duration::from_millis(300), Duration::from_millis(200), Duration::ZERO));
        assert_eq!(first_error(batches).await, GENERATION_TIMEOUT_ERROR);
        assert!(now.elapsed() < Duration::from_secs(2));
    }

    #[tokio::test]
    async fn empty_max_tokens_fails_in_both_response_modes() {
        const EMPTY: &[u8] = b"data: {\"candidates\":[{\"finishReason\":\"MAX_TOKENS\"}]}\n";
        let response = non_stream_response(events(EMPTY)).await;
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let response = stream_response(events(EMPTY));
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(text.contains("event: error"));
        assert!(!text.contains("event: message_stop"));
        assert!(!text.contains("\"stop_reason\":\"max_tokens\""));
    }

    #[tokio::test]
    async fn pending_upstream_and_expired_total_deadline_terminate() {
        for has_content in [false, true] {
            let mut st = StreamState::new("gemini-3.8-flash-high");
            if has_content {
                st.process(&json!({"candidates":[{"content":{"parts":[{"text":"hello"}]}}]}));
            }
            let first = if has_content { Duration::from_secs(60) } else { Duration::ZERO };
            let mut batches = generation_events(upstream_body(stream::pending::<Result<Bytes, ()>>()), st,
                limits(first, Duration::ZERO, IDLE, Duration::ZERO), None);
            assert_eq!(batches.next().await.unwrap().unwrap_err(), GENERATION_TIMEOUT_ERROR);
            assert!(batches.next().await.is_none());
        }
    }

    #[tokio::test]
    async fn read_failure_and_malformed_payload_fail_without_normal_finish() {
        let batches = run_gen(stream::iter(vec![Err::<Bytes, _>(())]), "claude-sonnet-4-6",
            limits(Duration::from_secs(5), Duration::from_secs(10), IDLE, Duration::ZERO));
        assert_eq!(non_stream_response(batches).await.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(non_stream_response(events(b"data: {broken}\n")).await.status(), StatusCode::BAD_GATEWAY);
    }
}
