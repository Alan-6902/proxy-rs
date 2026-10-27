//! Antigravity provider：把 Anthropic Messages 请求转发到 Google cloudcode-pa v1internal
//!
//! 独立路径 `/ag/v1`（客户端设 `ANTHROPIC_BASE_URL=http://host:port/ag`），
//! 账号存在单独的 SQLite 文件里，与 Kiro 的凭据池互不影响。
//!
//! # 端点
//! - `GET /ag/v1/models`
//! - `POST /ag/v1/messages`
//! - `POST /ag/v1/messages/count_tokens`

mod admin;
mod client;
mod consts;
mod converter;
mod handlers;
mod models;
mod provider;
mod schema;
mod signatures;
mod store;
mod stream;

use std::sync::Arc;

use axum::{
    Router,
    body::Body,
    extract::{DefaultBodyLimit, State},
    http::{Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Json, Response},
    routing::{get, post},
};

pub use admin::create_admin_router;
pub use provider::AntigravityProvider;
pub use store::AgStore;

use crate::anthropic::types::ErrorResponse;
use crate::anthropic::{access_log_middleware, cors_layer};
use crate::common::auth;
use handlers::{AgState, count_tokens, get_models, post_messages};

/// 账号库默认文件名（与 Kiro 账号库同目录）
pub const DEFAULT_DB_FILE_NAME: &str = "antigravity.sqlite3";
const MAX_BODY_SIZE: usize = 50 * 1024 * 1024;

async fn auth_middleware(State(state): State<AgState>, request: Request<Body>, next: Next) -> Response {
    match auth::extract_api_key(&request) {
        Some(key) if auth::constant_time_eq(&key, &state.api_key) => next.run(request).await,
        _ => (StatusCode::UNAUTHORIZED, Json(ErrorResponse::authentication_error())).into_response(),
    }
}

/// 创建 `/ag/v1` 路由，客户端鉴权与 `/v1` 共用同一个 apiKey
pub fn create_router(api_key: impl Into<String>, provider: Arc<AntigravityProvider>) -> Router {
    let state = AgState { api_key: api_key.into(), provider };
    let v1 = Router::new()
        .route("/models", get(get_models))
        .route("/messages", post(post_messages))
        .route("/messages/count_tokens", post(count_tokens))
        .layer(middleware::from_fn_with_state(state.clone(), auth_middleware));
    Router::new()
        .nest("/ag/v1", v1)
        .layer(middleware::from_fn(access_log_middleware))
        .layer(cors_layer())
        .layer(DefaultBodyLimit::max(MAX_BODY_SIZE))
        .with_state(state)
}
