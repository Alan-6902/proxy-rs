//! Qoder 账号管理接口（挂在 `/api/admin/qoder`，admin key 鉴权）

use std::sync::Arc;

use axum::{
    Json, Router,
    body::Body,
    extract::{Path, State},
    http::{Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
};
use serde::Deserialize;
use serde_json::json;

use super::provider::{QoderError, QoderProvider};
use super::store::ModelOverrides;
use crate::admin::types::{AdminErrorResponse, SuccessResponse};
use crate::common::auth;

#[derive(Clone)]
struct AdminState {
    admin_api_key: String,
    provider: Arc<QoderProvider>,
}

#[derive(Deserialize)]
struct AddPatRequest {
    pat: String,
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

async fn admin_auth(State(state): State<AdminState>, request: Request<Body>, next: Next) -> Response {
    auth::require_api_key(&state.admin_api_key, request, next, || {
        (StatusCode::UNAUTHORIZED, Json(AdminErrorResponse::authentication_error())).into_response()
    })
    .await
}

fn internal(e: impl std::fmt::Display) -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, Json(AdminErrorResponse::internal_error(e.to_string()))).into_response()
}

fn qoder_error(e: QoderError) -> Response {
    let status = match e.status {
        400 | 404 => StatusCode::from_u16(e.status).unwrap_or(StatusCode::BAD_REQUEST),
        _ => StatusCode::BAD_GATEWAY,
    };
    let body = if e.status == 404 { AdminErrorResponse::not_found(e.message) } else { AdminErrorResponse::api_error(e.message) };
    (status, Json(body)).into_response()
}

fn not_found(id: i64) -> Response {
    (StatusCode::NOT_FOUND, Json(AdminErrorResponse::not_found(format!("账号不存在: {id}")))).into_response()
}

async fn service_info(State(state): State<AdminState>) -> Response {
    match state.provider.store().path().canonicalize() {
        Ok(path) => Json(json!({ "service": "qoder", "databasePath": path })).into_response(),
        Err(e) => internal(e),
    }
}

/// 只返回服务身份与账号库路径，供 App 验证独立进程
pub fn create_service_info_router(admin_api_key: impl Into<String>, provider: Arc<QoderProvider>) -> Router {
    let state = AdminState { admin_api_key: admin_api_key.into(), provider };
    Router::new()
        .route("/info", get(service_info))
        .layer(middleware::from_fn_with_state(state.clone(), admin_auth))
        .with_state(state)
}

async fn list_accounts(State(state): State<AdminState>) -> Response {
    match state.provider.accounts() {
        Ok(accounts) => Json(json!({
            "accounts": accounts,
            "dbPath": state.provider.store().path().display().to_string(),
        })).into_response(),
        Err(e) => internal(e),
    }
}

async fn add_account(State(state): State<AdminState>, Json(payload): Json<AddPatRequest>) -> Response {
    match state.provider.add_pat(&payload.pat).await {
        Ok(view) => Json(view).into_response(),
        Err(e) => qoder_error(e),
    }
}

async fn refresh_account(State(state): State<AdminState>, Path(id): Path<i64>) -> Response {
    match state.provider.refresh_account(id).await {
        Ok(view) => Json(view).into_response(),
        Err(e) => qoder_error(e),
    }
}

async fn set_disabled(State(state): State<AdminState>, Path(id): Path<i64>, Json(p): Json<SetDisabledRequest>) -> Response {
    match state.provider.set_disabled(id, p.disabled) {
        Ok(true) => Json(SuccessResponse::new(if p.disabled { "已禁用" } else { "已启用" })).into_response(),
        Ok(false) => not_found(id),
        Err(e) => internal(e),
    }
}

async fn delete_account(State(state): State<AdminState>, Path(id): Path<i64>) -> Response {
    match state.provider.delete(id) {
        Ok(true) => Json(SuccessResponse::new("已删除")).into_response(),
        Ok(false) => not_found(id),
        Err(e) => internal(e),
    }
}

async fn list_models(State(state): State<AdminState>) -> Response {
    match state.provider.model_catalog().await {
        Ok(models) => Json(json!({ "models": models })).into_response(),
        Err(e) => qoder_error(e),
    }
}

#[derive(Deserialize)]
struct SetOverridesRequest {
    overrides: ModelOverrides,
}

async fn set_model_overrides(State(state): State<AdminState>, Json(p): Json<SetOverridesRequest>) -> Response {
    match state.provider.save_model_overrides(&p.overrides).await {
        Ok(()) => list_models(State(state)).await,
        Err(e) => qoder_error(e),
    }
}

async fn set_models(State(state): State<AdminState>, Json(p): Json<SetModelsRequest>) -> Response {
    match state.provider.save_model_selection(&p.enabled_model_ids).await {
        Ok(()) => list_models(State(state)).await,
        Err(e) => qoder_error(e),
    }
}

/// - `GET /accounts` 账号列表（不含 PAT / token）
/// - `POST /accounts` 粘贴 PAT 添加，body `{ "pat": "pt-..." }`
/// - `POST /accounts/{id}/refresh` 强制续期并刷新额度
/// - `POST /accounts/{id}/disabled` 启用 / 禁用
/// - `DELETE /accounts/{id}` 删除
/// - `GET|PUT /models` 模型目录与勾选
/// - `PUT /models/overrides` 别名、上下文档位、思考强度，body `{ "overrides": { "<key>": {...} } }`
pub fn create_admin_router(admin_api_key: impl Into<String>, provider: Arc<QoderProvider>) -> Router {
    let state = AdminState { admin_api_key: admin_api_key.into(), provider };
    Router::new()
        .route("/accounts", get(list_accounts).post(add_account))
        .route("/accounts/{id}", delete(delete_account))
        .route("/accounts/{id}/refresh", post(refresh_account))
        .route("/accounts/{id}/disabled", post(set_disabled))
        .route("/models", get(list_models).put(set_models))
        .route("/models/overrides", put(set_model_overrides))
        .layer(middleware::from_fn_with_state(state.clone(), admin_auth))
        .with_state(state)
}
