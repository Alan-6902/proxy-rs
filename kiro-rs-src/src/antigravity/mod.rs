//! Antigravity provider：把 Anthropic Messages 请求转发到 Google cloudcode-pa v1internal
//!
//! 独立端口上的 `/v1`（客户端设 `ANTHROPIC_BASE_URL=http://host:antigravityPort`），
//! 账号存在单独的 SQLite 文件里，与 Kiro 的凭据池互不影响。
//!
//! # 端点
//! - `GET /v1/models`
//! - `POST /v1/messages`
//! - `POST /v1/messages/count_tokens`

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
pub use client::OAuthClient;
pub use provider::AntigravityProvider;
pub use store::AgStore;

use crate::anthropic::types::ErrorResponse;
use crate::anthropic::{access_log_middleware, cors_layer};
use crate::common::auth;
use crate::common::websearch_relay::WebSearchRelay;
use handlers::{AgState, count_tokens, get_models, post_messages};

/// 账号库默认文件名（与 Kiro 账号库同目录）
pub const DEFAULT_DB_FILE_NAME: &str = "antigravity.sqlite3";
/// 独立进程的 Admin 页面路径（前端按此路径渲染 Antigravity 面板）
pub const ADMIN_UI_PATH: &str = "/admin/antigravity";
const MAX_BODY_SIZE: usize = 50 * 1024 * 1024;

async fn auth_middleware(State(state): State<AgState>, request: Request<Body>, next: Next) -> Response {
    auth::require_api_key(&state.api_key, request, next, || {
        (StatusCode::UNAUTHORIZED, Json(ErrorResponse::authentication_error())).into_response()
    })
    .await
}

/// 创建 `/v1` 路由，客户端鉴权与 `/v1` 共用同一个 apiKey；
/// `websearch` 有值时 WebSearch 子请求转给 kiro-rs 真搜
pub fn create_router(
    api_key: impl Into<String>,
    provider: Arc<AntigravityProvider>,
    websearch: Option<Arc<WebSearchRelay>>,
) -> Router {
    let state = AgState { api_key: api_key.into(), provider, websearch };
    let v1 = Router::new()
        .route("/models", get(get_models))
        .route("/messages", post(post_messages))
        .route("/messages/count_tokens", post(count_tokens))
        .layer(middleware::from_fn_with_state(state.clone(), auth_middleware));
    Router::new()
        .nest("/v1", v1)
        .layer(middleware::from_fn(access_log_middleware))
        .layer(cors_layer())
        .layer(DefaultBodyLimit::max(MAX_BODY_SIZE))
        .with_state(state)
}

/// 独立监听只暴露 Antigravity 的业务和管理接口。
pub fn create_service_router(
    api_key: &str,
    admin_key: Option<&str>,
    provider: Arc<AntigravityProvider>,
    websearch: Option<Arc<WebSearchRelay>>,
) -> Router {
    let app = create_router(api_key, provider.clone(), websearch);
    match admin_key.filter(|key| !key.trim().is_empty()) {
        Some(key) => app
            .nest("/api/admin/service", admin::create_service_info_router(key, provider.clone()))
            .nest("/api/admin/antigravity", create_admin_router(key, provider))
            .route("/admin/", get(|| async { axum::response::Redirect::temporary(ADMIN_UI_PATH) }))
            .nest("/admin", crate::admin_ui::create_admin_ui_router_redirecting_to(ADMIN_UI_PATH)),
        None => app,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::config::TlsBackend;

    #[tokio::test]
    async fn independent_routes_keep_kiro_and_legacy_endpoints_out() {
        let directory = std::env::temp_dir().join(format!("ag-routes-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let provider = Arc::new(AntigravityProvider::new(
            Arc::new(AgStore::open_or_create(&directory.join(DEFAULT_DB_FILE_NAME)).unwrap()),
            None,
            TlsBackend::Rustls,
            OAuthClient::for_tests(),
        ).unwrap());
        // 假 kiro-rs 接收 WebSearch 子请求；其余请求不经过它
        let (fake_kiro_url, fake_kiro) = crate::common::websearch_relay::tests::fake_kiro().await;
        let relay = Arc::new(WebSearchRelay::new(&fake_kiro_url, "test-api-key".into()).unwrap());
        let ag = create_service_router("test-api-key", Some("test-admin-key"), provider.clone(), Some(relay));
        let kiro = crate::anthropic::create_router_with_provider("test-api-key", None, true);
        let listener_ag = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let listener_kiro = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ag_url = format!("http://{}", listener_ag.local_addr().unwrap());
        let kiro_url = format!("http://{}", listener_kiro.local_addr().unwrap());
        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let mut shutdown_kiro = shutdown_rx.clone();
        let mut shutdown_ag = shutdown_rx;
        let task_ag = tokio::spawn(async move {
            axum::serve(listener_ag, ag).with_graceful_shutdown(async move {
                let _ = shutdown_ag.changed().await;
            }).await.unwrap();
        });
        let task_kiro = tokio::spawn(async move {
            axum::serve(listener_kiro, kiro).with_graceful_shutdown(async move {
                let _ = shutdown_kiro.changed().await;
            }).await.unwrap();
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let info_url = format!("{ag_url}/api/admin/service/info");
        assert_eq!(client.get(&info_url).send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
        assert_eq!(client.get(&info_url).header("x-api-key", "test-api-key")
            .send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
        let info: serde_json::Value = client.get(&info_url).header("x-api-key", "test-admin-key")
            .send().await.unwrap().json().await.unwrap();
        assert_eq!(info, serde_json::json!({
            "service": "antigravity",
            "databasePath": directory.join(DEFAULT_DB_FILE_NAME).canonicalize().unwrap(),
        }));
        assert_eq!(client.get(format!("{ag_url}/v1/models")).send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
        let models = client.get(format!("{ag_url}/v1/models"))
            .header("x-api-key", "test-api-key").send().await.unwrap();
        assert_eq!(models.status(), StatusCode::OK);
        let models: serde_json::Value = models.json().await.unwrap();
        assert!(models["data"].as_array().unwrap().iter().all(|model| model["owned_by"] == "antigravity"));
        assert_eq!(client.get(format!("{ag_url}/api/admin/antigravity/accounts"))
            .header("x-api-key", "test-admin-key").send().await.unwrap().status(), StatusCode::OK);
        assert_eq!(client.get(format!("{ag_url}/api/admin/antigravity/accounts")).send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
        let catalog_url = format!("{ag_url}/api/admin/antigravity/models");
        assert_eq!(client.get(&catalog_url).send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
        assert_eq!(client.put(&catalog_url).json(&serde_json::json!({"enabledModelIds": []}))
            .send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
        let catalog_response = client.get(&catalog_url).header("x-api-key", "test-admin-key").send().await.unwrap();
        assert_eq!(catalog_response.status(), StatusCode::OK);
        let catalog: serde_json::Value = catalog_response.json().await.unwrap();
        let catalog_models = catalog["models"].as_array().unwrap();
        assert_eq!(catalog_models.len(), models["data"].as_array().unwrap().len());
        assert!(catalog_models.iter().all(|m| m["enabled"] == true));
        let selected_id = catalog_models[0]["id"].as_str().unwrap();
        let updated = client.put(&catalog_url).header("x-api-key", "test-admin-key")
            .json(&serde_json::json!({"enabledModelIds": [selected_id]})).send().await.unwrap();
        assert_eq!(updated.status(), StatusCode::OK);
        let updated: serde_json::Value = updated.json().await.unwrap();
        assert_eq!(updated["models"].as_array().unwrap().iter().filter(|m| m["enabled"] == true).count(), 1);
        let public: serde_json::Value = client.get(format!("{ag_url}/v1/models")).header("x-api-key", "test-api-key")
            .send().await.unwrap().json().await.unwrap();
        assert_eq!(public["data"].as_array().unwrap().len(), 1);
        assert_eq!(public["data"][0]["id"], selected_id);
        assert_eq!(public["data"][0]["display_name"], catalog_models[0]["displayName"]);
        assert_eq!(public["data"][0]["context_window"], catalog_models[0]["contextWindow"]);
        let invalid = client.put(&catalog_url).header("x-api-key", "test-admin-key")
            .json(&serde_json::json!({"enabledModelIds": ["not-in-catalog"]})).send().await.unwrap();
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        assert_eq!(provider.available_models().unwrap().len(), 1);
        let missing = client.put(&catalog_url).header("x-api-key", "test-admin-key")
            .json(&serde_json::json!({})).send().await.unwrap();
        assert_eq!(missing.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let cleared = client.put(&catalog_url).header("x-api-key", "test-admin-key")
            .json(&serde_json::json!({"enabledModelIds": []})).send().await.unwrap();
        assert_eq!(cleared.status(), StatusCode::OK);
        let public: serde_json::Value = client.get(format!("{ag_url}/v1/models")).header("x-api-key", "test-api-key")
            .send().await.unwrap().json().await.unwrap();
        assert!(public["data"].as_array().unwrap().is_empty());
        for route in ["/ag/v1/models", "/api/admin/credentials"] {
            assert_eq!(client.get(format!("{ag_url}{route}")).send().await.unwrap().status(), StatusCode::NOT_FOUND);
        }
        for route in ["/ag/v1/models", "/api/admin/antigravity/accounts"] {
            assert_eq!(client.get(format!("{kiro_url}{route}")).send().await.unwrap().status(), StatusCode::NOT_FOUND);
        }
        assert_eq!(client.get(format!("{kiro_url}/v1/models"))
            .header("x-api-key", "test-api-key").send().await.unwrap().status(), StatusCode::OK);
        assert_eq!(client.get(format!("{ag_url}/admin/antigravity")).send().await.unwrap().status(), StatusCode::OK);
        let no_redirect = reqwest::Client::builder()
            .no_proxy().redirect(reqwest::redirect::Policy::none()).build().unwrap();
        for route in ["/admin", "/admin/"] {
            let response = no_redirect.get(format!("{ag_url}{route}")).send().await.unwrap();
            assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
            assert_eq!(response.headers()["location"], "/admin/antigravity");
        }
        let index = client.get(format!("{ag_url}/admin/antigravity")).send().await.unwrap().text().await.unwrap();
        let asset = index.split("src=\"").nth(1).unwrap().split('"').next().unwrap();
        let asset_response = client.get(format!("{ag_url}{asset}")).send().await.unwrap();
        assert_eq!(asset_response.status(), StatusCode::OK);
        assert!(asset_response.headers()["content-type"].to_str().unwrap().contains("javascript"));
        // WebSearch 子请求：鉴权仍由本服务做，通过后原样转给 kiro-rs，SSE 原样回流
        let search = serde_json::json!({"model":"gemini-4-argon-high","max_tokens":10,"stream":true,
            "tools":[{"type":"web_search_20250305","name":"web_search","max_uses":8}],
            "messages":[{"role":"user","content":"Perform a web search for the query: rust"}]});
        assert_eq!(client.post(format!("{ag_url}/v1/messages")).json(&search).send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
        let relayed = client.post(format!("{ag_url}/v1/messages")).header("x-api-key", "test-api-key")
            .json(&search).send().await.unwrap();
        assert_eq!(relayed.status(), StatusCode::OK);
        assert!(relayed.headers()["content-type"].to_str().unwrap().starts_with("text/event-stream"));
        assert!(relayed.text().await.unwrap().contains("query=Perform a web search for the query: rust"));
        fake_kiro.abort();
        shutdown_tx.send(true).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            task_ag.await.unwrap();
            task_kiro.await.unwrap();
        }).await.unwrap();
        let trash = std::path::PathBuf::from(std::env::var_os("HOME").unwrap()).join(".Trash");
        std::fs::create_dir_all(&trash).unwrap();
        std::fs::rename(&directory, trash.join(directory.file_name().unwrap())).unwrap();
    }
}
