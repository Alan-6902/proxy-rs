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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetModelsRequest {
    enabled_model_ids: Vec<String>,
}

/// GET /models：包含兜底目录，规格与公开模型接口一致。
async fn list_models(State(state): State<AgAdminState>) -> Response {
    match state.provider.model_catalog() {
        Ok(models) => Json(json!({ "models": models })).into_response(),
        Err(e) => internal(e),
    }
}

/// PUT /models：保存完整选择，空数组表示全不选；同时按当前目录把勾选的模型分组到账号。
async fn set_models(
    State(state): State<AgAdminState>,
    Json(payload): Json<SetModelsRequest>,
) -> Response {
    match state.provider.save_model_selection(&payload.enabled_model_ids) {
        Ok(()) => list_models(State(state)).await,
        Err(e) if e.to_string().starts_with("模型不在当前目录中") => {
            (StatusCode::BAD_REQUEST, Json(AdminErrorResponse::api_error(e.to_string()))).into_response()
        }
        Err(e) => internal(e),
    }
}

/// POST /models/scan：逐个刷新启用账号的模型列表，返回扫描结果与最新目录
async fn scan_models(State(state): State<AgAdminState>) -> Response {
    let results = match state.provider.scan_accounts().await {
        Ok(results) => results,
        Err(e) => return internal(e),
    };
    match state.provider.model_catalog() {
        Ok(models) => Json(json!({ "models": models, "scan": results })).into_response(),
        Err(e) => internal(e),
    }
}

async fn admin_auth(State(state): State<AgAdminState>, request: Request<Body>, next: Next) -> Response {
    auth::require_api_key(&state.admin_api_key, request, next, || {
        (StatusCode::UNAUTHORIZED, Json(AdminErrorResponse::authentication_error())).into_response()
    })
    .await
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

/// 只返回服务身份与账号库路径，供 App 验证独立进程，不读取账号内容。
async fn service_info(State(state): State<AgAdminState>) -> Response {
    match state.provider.store().path().canonicalize() {
        Ok(path) => Json(json!({
            "service": "antigravity",
            "databasePath": path,
        })).into_response(),
        Err(e) => internal(e),
    }
}

pub fn create_service_info_router(admin_api_key: impl Into<String>, provider: Arc<AntigravityProvider>) -> Router {
    let state = AgAdminState { admin_api_key: admin_api_key.into(), provider };
    Router::new()
        .route("/info", get(service_info))
        .layer(middleware::from_fn_with_state(state.clone(), admin_auth))
        .with_state(state)
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

/// POST /accounts/{id}/reset
async fn reset_failures(State(state): State<AgAdminState>, Path(id): Path<i64>) -> Response {
    match state.provider.reset_failures(id) {
        Ok(true) => Json(SuccessResponse::new("失败计数已清零")).into_response(),
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
/// - `GET /models` - 模型目录及勾选状态
/// - `PUT /models` - 替换模型目录选择，并按账号分组勾选的模型
/// - `POST /models/scan` - 扫描各启用账号的模型列表
/// - `GET /accounts` - 账号列表（不含 token）
/// - `POST /oauth/start` - 开始 Google 登录，返回授权地址与会话 id
/// - `GET /oauth/{session}` - 登录进度
/// - `POST /accounts/{id}/refresh` - 刷新 token、projectId 与额度
/// - `POST /accounts/{id}/disabled` - 启用 / 禁用
/// - `POST /accounts/{id}/reset` - 失败计数清零并解除冷却
/// - `DELETE /accounts/{id}` - 删除
pub fn create_admin_router(admin_api_key: impl Into<String>, provider: Arc<AntigravityProvider>) -> Router {
    let state = AgAdminState { admin_api_key: admin_api_key.into(), provider };
    Router::new()
        .route("/models", get(list_models).put(set_models))
        .route("/models/scan", post(scan_models))
        .route("/accounts", get(list_accounts))
        .route("/accounts/{id}", delete(delete_account))
        .route("/accounts/{id}/refresh", post(refresh_account))
        .route("/accounts/{id}/disabled", post(set_disabled))
        .route("/accounts/{id}/reset", post(reset_failures))
        .route("/oauth/start", post(start_oauth))
        .route("/oauth/{session}", get(oauth_status))
        .layer(middleware::from_fn_with_state(state.clone(), admin_auth))
        .with_state(state)
}
