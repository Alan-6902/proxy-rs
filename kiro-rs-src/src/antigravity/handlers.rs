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
use futures::{StreamExt, stream};
use serde_json::Value;
use tokio::time::interval;

use super::models::{self, PUBLIC_MODELS};
use super::provider::{AgError, AntigravityProvider};
use super::stream::{SseDecoder, StreamState, aggregate};
use super::converter;
use crate::anthropic::stream::SseEvent;
use crate::anthropic::types::{
    CountTokensRequest, CountTokensResponse, ErrorResponse, MessagesRequest, Model, ModelsResponse,
};
use crate::token;

const PING_INTERVAL_SECS: u64 = 25;
const PING_SSE: &str = "event: ping\ndata: {\"type\": \"ping\"}\n\n";
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

/// GET /ag/v1/models
pub async fn get_models() -> impl IntoResponse {
    let data = PUBLIC_MODELS
        .iter()
        .map(|(id, name)| Model {
            id: id.to_string(),
            object: "model".to_string(),
            created: MODEL_CREATED_AT,
            owned_by: MODEL_OWNER.to_string(),
            display_name: name.to_string(),
            model_type: "chat".to_string(),
            max_tokens: models::max_output_tokens(&models::map_model(id)),
            context_window: models::context_window(id),
        })
        .collect();
    Json(ModelsResponse { object: "list".to_string(), data })
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
    let converted = converter::convert(&req, &raw);
    let upstream = match state.provider.stream_generate(&converted.envelope, &converted.model).await {
        Ok(r) => r,
        Err(e) => return e.into_response(),
    };
    // 对客户端回显其请求的模型名，而非上游内部 id
    let st = StreamState::new(req.model.clone());
    if req.stream {
        stream_response(upstream, st)
    } else {
        non_stream_response(upstream, st).await
    }
}

fn sse_bytes(events: Vec<SseEvent>) -> stream::Iter<std::vec::IntoIter<Result<Bytes, Infallible>>> {
    let bytes: Vec<Result<Bytes, Infallible>> =
        events.into_iter().map(|e| Ok(Bytes::from(e.to_sse_string()))).collect();
    stream::iter(bytes)
}

fn stream_response(upstream: reqwest::Response, st: StreamState) -> Response {
    let body = upstream.bytes_stream();
    let ping = interval(Duration::from_secs(PING_INTERVAL_SECS));
    let events = stream::unfold(
        (body, st, SseDecoder::default(), false, ping),
        |(mut body, mut st, mut decoder, finished, mut ping)| async move {
            if finished {
                return None;
            }
            tokio::select! {
                chunk = body.next() => {
                    match chunk {
                        Some(Ok(bytes)) => {
                            let events: Vec<SseEvent> = decoder
                                .feed(&bytes)
                                .iter()
                                .flat_map(|v| st.process(v))
                                .collect();
                            Some((sse_bytes(events), (body, st, decoder, false, ping)))
                        }
                        other => {
                            if let Some(Err(e)) = other {
                                tracing::error!("读取 Antigravity 响应流失败: {e}");
                            }
                            let mut events: Vec<SseEvent> =
                                decoder.finish().map(|v| st.process(&v)).unwrap_or_default();
                            events.extend(st.finish());
                            Some((sse_bytes(events), (body, st, decoder, true, ping)))
                        }
                    }
                }
                _ = ping.tick() => {
                    let ping_bytes: Vec<Result<Bytes, Infallible>> = vec![Ok(Bytes::from_static(PING_SSE.as_bytes()))];
                    Some((stream::iter(ping_bytes), (body, st, decoder, false, ping)))
                }
            }
        },
    )
    .flatten();

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::CONNECTION, "keep-alive")
        .body(Body::from_stream(events))
        .unwrap()
}

async fn non_stream_response(upstream: reqwest::Response, mut st: StreamState) -> Response {
    let mut body = upstream.bytes_stream();
    let mut decoder = SseDecoder::default();
    let mut events = Vec::new();
    while let Some(chunk) = body.next().await {
        match chunk {
            Ok(bytes) => {
                for v in decoder.feed(&bytes) {
                    events.extend(st.process(&v));
                }
            }
            Err(e) => {
                return error_response(StatusCode::BAD_GATEWAY, format!("读取上游响应失败: {e}"));
            }
        }
    }
    if let Some(v) = decoder.finish() {
        events.extend(st.process(&v));
    }
    events.extend(st.finish());
    Json(aggregate(&events)).into_response()
}
