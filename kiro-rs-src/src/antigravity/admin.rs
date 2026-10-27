//! Antigravity 账号管理接口（挂在 `/api/admin/antigravity`，与 Kiro 的 Admin API 共用 admin key）

use std::sync::Arc;

use axum::{
    Json, Router,
    body::Body,
    extract::{Path, State},
    http::{Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use serde::Deserialize;
use serde_json::json;

use super::provider::AntigravityProvider;
use crate::admin::types::{AdminErrorResponse, SuccessResponse};
use crate::common::auth;

#[derive(Clone)]
struct AgAdminState {
    admin_api_key: String,
    provider: Arc<AntigravityProvider>,
}

#[derive(Deserialize)]
struct SetDisabledRequest {
    disabled: bool,
}

async fn admin_auth(State(state): State<AgAdminState>, request: Request<Body>, next: Next) -> Response {
    match auth::extract_api_key(&request) {
        Some(key) if auth::constant_time_eq(&key, &state.admin_api_key) => next.run(request).await,
        _ => (StatusCode::UNAUTHORIZED, Json(AdminErrorResponse::authentication_error())).into_response(),
    }
}

fn internal(e: impl std::fmt::Display) -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, Json(AdminErrorResponse::internal_error(e.to_string()))).into_response()
}

fn upstream(e: impl std::fmt::Display) -> Response {
    (StatusCode::BAD_GATEWAY, Json(AdminErrorResponse::api_error(e.to_string()))).into_response()
}

fn not_found(id: i64) -> Response {
    (StatusCode::NOT_FOUND, Json(AdminErrorResponse::not_found(format!("账号不存在: {id}")))).into_response()
}

/// GET /accounts
async fn list_accounts(State(state): State<AgAdminState>) -> Response {
    match state.provider.accounts() {
        Ok(accounts) => Json(json!({
            "accounts": accounts,
            "dbPath": state.provider.store().path().display().to_string(),
        }))
        .into_response(),
        Err(e) => internal(e),
    }
}

/// POST /oauth/start
async fn start_oauth(State(state): State<AgAdminState>) -> Response {
    match state.provider.start_oauth().await {
        Ok(start) => Json(start).into_response(),
        Err(e) => internal(e),
    }
}

/// GET /oauth/{session}
async fn oauth_status(State(state): State<AgAdminState>, Path(session): Path<String>) -> Response {
    match state.provider.oauth_status(&session) {
        Some(view) => Json(view).into_response(),
        None => (StatusCode::NOT_FOUND, Json(AdminErrorResponse::not_found("登录会话不存在"))).into_response(),
    }
}

/// POST /accounts/{id}/refresh
async fn refresh_account(State(state): State<AgAdminState>, Path(id): Path<i64>) -> Response {
    match state.provider.refresh_account(id).await {
        Ok(Some(view)) => Json(view).into_response(),
        Ok(None) => not_found(id),
        Err(e) => upstream(e),
    }
}

/// POST /accounts/{id}/disabled
async fn set_disabled(
    State(state): State<AgAdminState>,
    Path(id): Path<i64>,
    Json(payload): Json<SetDisabledRequest>,
) -> Response {
    match state.provider.set_disabled(id, payload.disabled) {
        Ok(true) => Json(SuccessResponse::new(if payload.disabled { "已禁用" } else { "已启用" })).into_response(),
        Ok(false) => not_found(id),
        Err(e) => internal(e),
    }
}

/// DELETE /accounts/{id}
async fn delete_account(State(state): State<AgAdminState>, Path(id): Path<i64>) -> Response {
    match state.provider.delete(id) {
        Ok(true) => Json(SuccessResponse::new("已删除")).into_response(),
        Ok(false) => not_found(id),
        Err(e) => internal(e),
    }
}

/// 创建 Antigravity 管理路由
///
/// - `GET /accounts` - 账号列表（不含 token）
/// - `POST /oauth/start` - 开始 Google 登录，返回授权地址与会话 id
/// - `GET /oauth/{session}` - 登录进度
/// - `POST /accounts/{id}/refresh` - 刷新 token、projectId 与额度
/// - `POST /accounts/{id}/disabled` - 启用 / 禁用
/// - `DELETE /accounts/{id}` - 删除
pub fn create_admin_router(admin_api_key: impl Into<String>, provider: Arc<AntigravityProvider>) -> Router {
    let state = AgAdminState { admin_api_key: admin_api_key.into(), provider };
    Router::new()
        .route("/accounts", get(list_accounts))
        .route("/accounts/{id}", delete(delete_account))
        .route("/accounts/{id}/refresh", post(refresh_account))
        .route("/accounts/{id}/disabled", post(set_disabled))
        .route("/oauth/start", post(start_oauth))
        .route("/oauth/{session}", get(oauth_status))
        .layer(middleware::from_fn_with_state(state.clone(), admin_auth))
        .with_state(state)
}
