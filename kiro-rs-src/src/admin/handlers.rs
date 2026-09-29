//! Admin API HTTP 处理器

use axum::{
    Json,
    extract::{Path, Query, State},
    response::IntoResponse,
};

use super::{
    middleware::AdminState,
    types::{
        AddCredentialRequest, AdoptCredentialRequest, BalanceQuery, DeleteCredentialQuery,
        EnsureFreshRequest, ImportAccountRequest, ListCredentialsQuery, SetDisabledRequest,
        SetInPoolRequest, SetLoadBalancingModeRequest, SetPriorityRequest, SetProxyRequest,
        SuccessResponse,
    },
};

/// GET /api/admin/credentials
/// 获取所有凭据状态
pub async fn get_all_credentials(
    State(state): State<AdminState>,
    Query(query): Query<ListCredentialsQuery>,
) -> impl IntoResponse {
    let response = state.service.get_all_credentials(query.all);
    Json(response)
}

/// POST /api/admin/credentials/:id/disabled
/// 设置凭据禁用状态
pub async fn set_credential_disabled(
    State(state): State<AdminState>,
    Path(id): Path<u64>,
    Json(payload): Json<SetDisabledRequest>,
) -> impl IntoResponse {
    match state.service.set_disabled(id, payload.disabled) {
        Ok(_) => {
            let action = if payload.disabled { "禁用" } else { "启用" };
            Json(SuccessResponse::new(format!("凭据 #{} 已{}", id, action))).into_response()
        }
        Err(e) => (e.status_code(), Json(e.into_response())).into_response(),
    }
}

/// POST /api/admin/credentials/:id/priority
/// 设置凭据优先级
pub async fn set_credential_priority(
    State(state): State<AdminState>,
    Path(id): Path<u64>,
    Json(payload): Json<SetPriorityRequest>,
) -> impl IntoResponse {
    match state.service.set_priority(id, payload.priority) {
        Ok(_) => Json(SuccessResponse::new(format!(
            "凭据 #{} 优先级已设置为 {}",
            id, payload.priority
        )))
        .into_response(),
        Err(e) => (e.status_code(), Json(e.into_response())).into_response(),
    }
}

/// POST /api/admin/credentials/:id/reset
/// 重置失败计数并重新启用
pub async fn reset_failure_count(
    State(state): State<AdminState>,
    Path(id): Path<u64>,
) -> impl IntoResponse {
    match state.service.reset_and_enable(id) {
        Ok(_) => Json(SuccessResponse::new(format!(
            "凭据 #{} 失败计数已重置并重新启用",
            id
        )))
        .into_response(),
        Err(e) => (e.status_code(), Json(e.into_response())).into_response(),
    }
}

/// GET /api/admin/credentials/:id/balance
/// 获取指定凭据的余额
pub async fn get_credential_balance(
    State(state): State<AdminState>,
    Path(id): Path<u64>,
    Query(query): Query<BalanceQuery>,
) -> impl IntoResponse {
    match state.service.get_balance(id, query.fresh).await {
        Ok(response) => Json(response).into_response(),
        Err(e) => (e.status_code(), Json(e.into_response())).into_response(),
    }
}

/// POST /api/admin/credentials
/// 添加新凭据
pub async fn add_credential(
    State(state): State<AdminState>,
    Json(payload): Json<AddCredentialRequest>,
) -> impl IntoResponse {
    match state.service.add_credential(payload).await {
        Ok(response) => Json(response).into_response(),
        Err(e) => (e.status_code(), Json(e.into_response())).into_response(),
    }
}

/// DELETE /api/admin/credentials/:id
/// 删除凭据
pub async fn delete_credential(
    State(state): State<AdminState>,
    Path(id): Path<u64>,
    Query(query): Query<DeleteCredentialQuery>,
) -> impl IntoResponse {
    match state.service.delete_credential(id, query.purge) {
        Ok(_) => Json(SuccessResponse::new(format!("凭据 #{} 已删除", id))).into_response(),
        Err(e) => (e.status_code(), Json(e.into_response())).into_response(),
    }
}

/// POST /api/admin/credentials/:id/refresh
/// 强制刷新凭据 Token
pub async fn force_refresh_token(
    State(state): State<AdminState>,
    Path(id): Path<u64>,
) -> impl IntoResponse {
    match state.service.force_refresh_token(id).await {
        Ok(_) => Json(SuccessResponse::new(format!(
            "凭据 #{} Token 已强制刷新",
            id
        )))
        .into_response(),
        Err(e) => (e.status_code(), Json(e.into_response())).into_response(),
    }
}

/// GET /api/admin/config/load-balancing
/// 获取负载均衡模式
pub async fn get_load_balancing_mode(State(state): State<AdminState>) -> impl IntoResponse {
    let response = state.service.get_load_balancing_mode();
    Json(response)
}

/// PUT /api/admin/config/load-balancing
/// 设置负载均衡模式
pub async fn set_load_balancing_mode(
    State(state): State<AdminState>,
    Json(payload): Json<SetLoadBalancingModeRequest>,
) -> impl IntoResponse {
    match state.service.set_load_balancing_mode(payload) {
        Ok(response) => Json(response).into_response(),
        Err(e) => (e.status_code(), Json(e.into_response())).into_response(),
    }
}

/// POST /api/admin/credentials/:id/pool
/// 加入 / 移出反代号池
pub async fn set_credential_in_pool(
    State(state): State<AdminState>,
    Path(id): Path<u64>,
    Json(payload): Json<SetInPoolRequest>,
) -> impl IntoResponse {
    match state.service.set_in_pool(id, payload.in_pool) {
        Ok(_) => {
            let action = if payload.in_pool {
                "已加入号池"
            } else {
                "已移出号池"
            };
            Json(SuccessResponse::new(format!("凭据 #{} {}", id, action))).into_response()
        }
        Err(e) => (e.status_code(), Json(e.into_response())).into_response(),
    }
}

/// POST /api/admin/credentials/:id/ensure-fresh
/// 确保凭据新鲜，返回当前凭据版本
pub async fn ensure_credential_fresh(
    State(state): State<AdminState>,
    Path(id): Path<u64>,
    payload: Option<Json<EnsureFreshRequest>>,
) -> impl IntoResponse {
    let req = payload.map(|Json(p)| p).unwrap_or_default();
    match state.service.ensure_fresh(id, req).await {
        Ok(response) => Json(response).into_response(),
        Err(e) => (e.status_code(), Json(e.into_response())).into_response(),
    }
}

/// POST /api/admin/credentials/:id/proxy
/// 设置凭据级代理
pub async fn set_credential_proxy(
    State(state): State<AdminState>,
    Path(id): Path<u64>,
    Json(payload): Json<SetProxyRequest>,
) -> impl IntoResponse {
    match state.service.set_proxy(id, payload) {
        Ok(_) => Json(SuccessResponse::new(format!("凭据 #{} 代理已更新", id))).into_response(),
        Err(e) => (e.status_code(), Json(e.into_response())).into_response(),
    }
}

/// POST /api/admin/accounts/import
/// 导入已有凭据（不刷新、不查额度）
pub async fn import_account(
    State(state): State<AdminState>,
    Json(payload): Json<ImportAccountRequest>,
) -> impl IntoResponse {
    match state.service.import_account(payload) {
        Ok(response) => Json(response).into_response(),
        Err(e) => (e.status_code(), Json(e.into_response())).into_response(),
    }
}

/// POST /api/admin/accounts/adopt
/// 收编外部（kiro-cli）自行刷新得到的凭据：按上游身份认账号，更新时替换，不再自己刷新
pub async fn adopt_account_credential(
    State(state): State<AdminState>,
    Json(payload): Json<AdoptCredentialRequest>,
) -> impl IntoResponse {
    match state.service.adopt_credential(payload).await {
        Ok(response) => Json(response).into_response(),
        Err(e) => (e.status_code(), Json(e.into_response())).into_response(),
    }
}

/// GET /api/admin/store/info
/// 账号库信息
pub async fn get_store_info(State(state): State<AdminState>) -> impl IntoResponse {
    Json(state.service.store_info())
}
