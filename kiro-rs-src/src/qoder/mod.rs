//! Qoder 国际版反代：Anthropic / OpenAI 请求转发到 Qoder COSY 推理网关
//!
//! 独立进程 `qoder-rs`、独立端口（默认 12890）、独立账号库 `qoder.sqlite3`。
//! 账号用 Personal Access Token（pt-）导入。协议行为参考 caigee-cmd/cli2api 与
//! shuishuipingan/qoder2api-hub（均 MIT），代码自行实现。
//!
//! # 端点
//! - `GET /v1/models`
//! - `POST /v1/messages`、`POST /v1/messages/count_tokens`（Anthropic）
//! - `POST /v1/chat/completions`（OpenAI）

mod admin;
mod client;
mod consts;
mod converter;
mod cosy;
mod handlers;
mod provider;
mod store;
mod stream;
mod task;
pub mod vault;

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
pub use provider::QoderProvider;
pub use store::QoderStore;

use crate::anthropic::types::ErrorResponse;
use crate::anthropic::{access_log_middleware, cors_layer};
use crate::common::auth;
use crate::common::websearch_relay::WebSearchRelay;
use handlers::{QoderState, count_tokens, get_models, post_chat_completions, post_messages};

pub const DEFAULT_DB_FILE_NAME: &str = "qoder.sqlite3";
pub const ADMIN_UI_PATH: &str = "/admin/qoder";
const MAX_BODY_SIZE: usize = 50 * 1024 * 1024;

async fn auth_middleware(State(state): State<QoderState>, request: Request<Body>, next: Next) -> Response {
    match auth::extract_api_key(&request) {
        Some(key) if auth::constant_time_eq(&key, &state.api_key) => next.run(request).await,
        _ => (StatusCode::UNAUTHORIZED, Json(ErrorResponse::authentication_error())).into_response(),
    }
}

/// `/v1` 业务路由，客户端鉴权与 Kiro 共用同一个 apiKey；
/// `websearch` 有值时 WebSearch 子请求转给 kiro-rs 真搜
pub fn create_router(
    api_key: impl Into<String>,
    provider: Arc<QoderProvider>,
    websearch: Option<Arc<WebSearchRelay>>,
) -> Router {
    let state = QoderState { api_key: api_key.into(), provider, websearch };
    let v1 = Router::new()
        .route("/models", get(get_models))
        .route("/messages", post(post_messages))
        .route("/messages/count_tokens", post(count_tokens))
        .route("/chat/completions", post(post_chat_completions))
        .layer(middleware::from_fn_with_state(state.clone(), auth_middleware));
    Router::new()
        .nest("/v1", v1)
        .layer(middleware::from_fn(access_log_middleware))
        .layer(cors_layer())
        .layer(DefaultBodyLimit::max(MAX_BODY_SIZE))
        .with_state(state)
}

/// 独立监听：业务接口 + 管理接口 + 管理页面
pub fn create_service_router(
    api_key: &str,
    admin_key: Option<&str>,
    provider: Arc<QoderProvider>,
    websearch: Option<Arc<WebSearchRelay>>,
) -> Router {
    let app = create_router(api_key, provider.clone(), websearch);
    match admin_key.filter(|key| !key.trim().is_empty()) {
        Some(key) => app
            .nest("/api/admin/service", admin::create_service_info_router(key, provider.clone()))
            .nest("/api/admin/qoder", create_admin_router(key, provider))
            .route("/admin/", get(|| async { axum::response::Redirect::temporary(ADMIN_UI_PATH) }))
            .nest("/admin", crate::admin_ui::create_qoder_admin_ui_router()),
        None => app,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn routes_require_keys_and_hide_other_services() {
        let directory = std::env::temp_dir().join(format!("qoder-routes-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let store = Arc::new(QoderStore::open_or_create(&directory.join(DEFAULT_DB_FILE_NAME), Arc::new(vault::MemoryVault::default())).unwrap());
        let provider = Arc::new(QoderProvider::new(store, None).unwrap());
        let (fake_kiro_url, fake_kiro) = crate::common::websearch_relay::tests::fake_kiro().await;
        let relay = Arc::new(WebSearchRelay::new(&fake_kiro_url, "test-api-key".into()).unwrap());
        let app = create_service_router("test-api-key", Some("test-admin-key"), provider, Some(relay));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (tx, mut rx) = tokio::sync::watch::channel(false);
        let task = tokio::spawn(async move {
            axum::serve(listener, app).with_graceful_shutdown(async move { let _ = rx.changed().await; }).await.unwrap();
        });
        let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).build().unwrap();
        let info = format!("{url}/api/admin/service/info");
        assert_eq!(client.get(&info).header("x-api-key", "test-api-key").send().await.unwrap().status(), 401);
        let v: serde_json::Value = client.get(&info).header("x-api-key", "test-admin-key").send().await.unwrap().json().await.unwrap();
        assert_eq!(v["service"], "qoder");
        let accounts = format!("{url}/api/admin/qoder/accounts");
        assert_eq!(client.get(&accounts).send().await.unwrap().status(), 401);
        let v: serde_json::Value = client.get(&accounts).header("x-api-key", "test-admin-key").send().await.unwrap().json().await.unwrap();
        assert_eq!(v["accounts"], serde_json::json!([]));
        // PAT 格式不对直接 400，不发上游请求
        let bad = client.post(&accounts).header("x-api-key", "test-admin-key")
            .json(&serde_json::json!({"pat":"not-a-pat"})).send().await.unwrap();
        assert_eq!(bad.status(), 400);
        assert_eq!(client.get(format!("{url}/v1/models")).send().await.unwrap().status(), 401);
        // 没有账号：目录拉不到时 /v1/models 至少给 auto，推理返回 503
        let models: serde_json::Value = client.get(format!("{url}/v1/models")).bearer_auth("test-api-key")
            .send().await.unwrap().json().await.unwrap();
        assert_eq!(models["data"][0]["id"], "auto");
        let chat = client.post(format!("{url}/v1/chat/completions")).bearer_auth("test-api-key")
            .json(&serde_json::json!({"model":"auto","messages":[{"role":"user","content":"hi"}]})).send().await.unwrap();
        assert_eq!(chat.status(), 503);
        let msg = client.post(format!("{url}/v1/messages")).header("x-api-key", "test-api-key")
            .json(&serde_json::json!({"model":"auto","max_tokens":10,"messages":[{"role":"user","content":"hi"}]})).send().await.unwrap();
        assert_eq!(msg.status(), 503);
        assert_eq!(msg.json::<serde_json::Value>().await.unwrap()["type"], "error");
        for route in ["/api/admin/credentials", "/api/admin/antigravity/accounts", "/ag/v1/models"] {
            assert_eq!(client.get(format!("{url}{route}")).send().await.unwrap().status(), 404);
        }
        let redirect = client.get(format!("{url}/admin")).send().await.unwrap();
        assert_eq!(redirect.headers()["location"], ADMIN_UI_PATH);
        assert_eq!(client.get(format!("{url}{ADMIN_UI_PATH}")).send().await.unwrap().status(), 200);
        // WebSearch 子请求：没有账号也能走，因为它不进 Qoder 上游，而是原样转给 kiro-rs
        let search = serde_json::json!({"model":"auto","max_tokens":10,"stream":true,
            "tools":[{"type":"web_search_20250305","name":"web_search","max_uses":8}],
            "messages":[{"role":"user","content":"Perform a web search for the query: rust"}]});
        let relayed = client.post(format!("{url}/v1/messages")).header("x-api-key", "test-api-key")
            .json(&search).send().await.unwrap();
        assert_eq!(relayed.status(), 200);
        assert!(relayed.headers()["content-type"].to_str().unwrap().starts_with("text/event-stream"));
        assert!(relayed.text().await.unwrap().contains("query=Perform a web search for the query: rust"));
        fake_kiro.abort();
        tx.send(true).unwrap();
        task.await.unwrap();
        let trash = std::path::PathBuf::from(std::env::var_os("HOME").unwrap()).join(".Trash");
        std::fs::create_dir_all(&trash).unwrap();
        std::fs::rename(&directory, trash.join(directory.file_name().unwrap())).unwrap();
    }
}
