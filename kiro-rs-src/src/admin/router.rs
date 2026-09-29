//! Admin API 路由配置

use axum::{
    Router, middleware,
    routing::{delete, get, post, put},
};

use super::{
    handlers::{
        add_credential, adopt_account_credential, delete_credential, ensure_credential_fresh,
        force_refresh_token, get_all_credentials, get_credential_balance, get_load_balancing_mode,
        get_store_info, import_account, reset_failure_count, set_credential_disabled,
        set_credential_in_pool, set_credential_priority, set_credential_proxy,
        set_external_refresh_account, set_load_balancing_mode,
    },
    middleware::{AdminState, admin_auth_middleware},
};

/// 创建 Admin API 路由
///
/// # 端点
/// - `GET /credentials` - 获取所有凭据状态
/// - `POST /credentials` - 添加新凭据
/// - `DELETE /credentials/:id` - 删除凭据
/// - `POST /credentials/:id/disabled` - 设置凭据禁用状态
/// - `POST /credentials/:id/priority` - 设置凭据优先级
/// - `POST /credentials/:id/reset` - 重置失败计数
/// - `POST /credentials/:id/refresh` - 强制刷新 Token
/// - `GET /credentials/:id/balance` - 获取凭据余额
/// - `POST /credentials/:id/pool` - 加入 / 移出号池（账号库模式）
/// - `POST /credentials/:id/ensure-fresh` - 确保凭据新鲜（账号库模式）
/// - `POST /credentials/:id/proxy` - 设置凭据级代理（账号库模式）
/// - `POST /accounts/import` - 导入已有凭据，不刷新（账号库模式）
/// - `POST /accounts/adopt` - 收编 kiro-cli 自行刷新的凭据（账号库模式）
/// - `PUT /accounts/external-refresh` - 指定由 kiro-cli 刷新的账号（账号库模式）
/// - `GET /store/info` - 账号库信息
/// - `GET /config/load-balancing` - 获取负载均衡模式
/// - `PUT /config/load-balancing` - 设置负载均衡模式
///
/// # 认证
/// 需要 Admin API Key 认证，支持：
/// - `x-api-key` header
/// - `Authorization: Bearer <token>` header
pub fn create_admin_router(state: AdminState) -> Router {
    Router::new()
        .route(
            "/credentials",
            get(get_all_credentials).post(add_credential),
        )
        .route("/credentials/{id}", delete(delete_credential))
        .route("/credentials/{id}/disabled", post(set_credential_disabled))
        .route("/credentials/{id}/priority", post(set_credential_priority))
        .route("/credentials/{id}/reset", post(reset_failure_count))
        .route("/credentials/{id}/refresh", post(force_refresh_token))
        .route("/credentials/{id}/balance", get(get_credential_balance))
        .route("/credentials/{id}/pool", post(set_credential_in_pool))
        .route(
            "/credentials/{id}/ensure-fresh",
            post(ensure_credential_fresh),
        )
        .route("/credentials/{id}/proxy", post(set_credential_proxy))
        .route("/accounts/import", post(import_account))
        .route("/accounts/adopt", post(adopt_account_credential))
        .route(
            "/accounts/external-refresh",
            put(set_external_refresh_account),
        )
        .route("/store/info", get(get_store_info))
        .route(
            "/config/load-balancing",
            get(get_load_balancing_mode).put(set_load_balancing_mode),
        )
        .layer(middleware::from_fn_with_state(
            state.clone(),
            admin_auth_middleware,
        ))
        .with_state(state)
}
