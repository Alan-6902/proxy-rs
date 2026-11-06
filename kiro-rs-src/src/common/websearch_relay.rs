//! 把 Claude Code 的 WebSearch 子请求转给本机 kiro-rs
//!
//! Claude Code 的 WebSearch 不是主对话的一部分：它单独发一个 `/v1/messages`，`tools` 里有且只有
//! 服务端工具 `web_search`，由 API 侧执行搜索并按 Claude 协议回 `server_tool_use` +
//! `web_search_tool_result`。Antigravity / Qoder 的上游都不执行服务端工具，模型只能凭记忆作答；
//! 而 kiro-rs 已经用 Kiro MCP 的 `web_search` 把这条链路做完了（见 `anthropic/websearch.rs`），
//! 搜索不消耗模型额度。这里识别同样的子请求形状，原样转发给 kiro-rs，再把 SSE 原样流回客户端；
//! kiro-rs 不在跑或出错时返回 None，调用方退回原来的处理（剥掉服务端工具）。

use std::time::Duration;

use axum::{
    body::Body,
    http::{StatusCode, header},
    response::Response,
};
use reqwest::Client;
use serde_json::Value;

use crate::model::config::Config;

/// Claude Code WebSearch 子请求里服务端工具的名字（与 kiro-rs 的 `has_web_search_tool` 同口径）
const WEB_SEARCH_TOOL_NAME: &str = "web_search";
const MESSAGES_PATH: &str = "/v1/messages";
/// 搜索子请求整体时限：kiro-rs 内部对 MCP 有重试，正常 1–3s 返回
const RELAY_TIMEOUT_SECS: u64 = 60;
const LOOPBACK: &str = "127.0.0.1";
/// 透传给客户端的响应头
const PASSTHROUGH_HEADERS: [header::HeaderName; 2] = [header::CONTENT_TYPE, header::CACHE_CONTROL];

/// kiro-rs 的业务地址与鉴权，三个反代读同一份配置，apiKey 相同
pub struct WebSearchRelay {
    client: Client,
    url: String,
    api_key: String,
}

/// kiro-rs 监听 0.0.0.0 / :: / localhost 时都从回环连；明确绑定了别的地址就按它连
fn connect_host(host: &str) -> &str {
    let bare = host.trim().trim_matches(['[', ']']);
    let unspecified = bare.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_unspecified() || ip.is_loopback());
    if bare.is_empty() || unspecified || bare.eq_ignore_ascii_case("localhost") { LOOPBACK } else { host.trim() }
}

impl WebSearchRelay {
    /// 配置里没有 apiKey 时不建转发器（那样 kiro-rs 自己也起不来）
    pub fn from_config(config: &Config) -> Option<Self> {
        let api_key = config.api_key.as_deref().filter(|k| !k.trim().is_empty())?.to_string();
        Self::new(&format!("http://{}:{}", connect_host(&config.host), config.port), api_key).ok()
    }

    pub fn new(base_url: &str, api_key: String) -> anyhow::Result<Self> {
        let client = Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(RELAY_TIMEOUT_SECS))
            .build()?;
        Ok(Self { client, url: format!("{}{MESSAGES_PATH}", base_url.trim_end_matches('/')), api_key })
    }

    /// 是否为纯 WebSearch 子请求：tools 有且只有一个，且名字是 web_search
    pub fn is_web_search_request(raw: &Value) -> bool {
        raw["tools"].as_array().is_some_and(|tools| {
            tools.len() == 1 && tools[0]["name"].as_str() == Some(WEB_SEARCH_TOOL_NAME)
        })
    }

    /// 转发并把 kiro-rs 的响应原样流回；连不上、超时或非 2xx 时返回 None，由调用方兜底
    pub async fn forward(&self, raw: &Value) -> Option<Response> {
        let query = raw["messages"][0]["content"].as_str()
            .or_else(|| raw["messages"][0]["content"][0]["text"].as_str())
            .unwrap_or_default();
        let upstream = match self.client.post(&self.url).header("x-api-key", &self.api_key).json(raw).send().await {
            Ok(resp) if resp.status().is_success() => resp,
            Ok(resp) => {
                tracing::warn!("kiro-rs 处理 WebSearch 子请求返回 {}，退回本地处理", resp.status());
                return None;
            }
            Err(e) => {
                tracing::warn!("转发 WebSearch 子请求给 kiro-rs 失败，退回本地处理: {e}");
                return None;
            }
        };
        tracing::info!("WebSearch 子请求已转给 kiro-rs 真搜（query: {}）", truncate(query, 80));
        let mut builder = Response::builder().status(StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::OK));
        for name in PASSTHROUGH_HEADERS {
            if let Some(value) = upstream.headers().get(name.as_str()) {
                builder = builder.header(name.as_str(), value.as_bytes());
            }
        }
        builder.body(Body::from_stream(upstream.bytes_stream())).ok()
    }
}

fn truncate(s: &str, max: usize) -> &str {
    match s.char_indices().nth(max) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

/// `fake_kiro` 供 antigravity / qoder 的路由测试复用
#[cfg(test)]
pub mod tests {
    use super::*;
    use axum::{Router, routing::post};
    use serde_json::json;

    const FAKE_SSE: &str = "event: message_start\ndata: {\"type\":\"message_start\"}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";

    /// 假 kiro-rs：校验 apiKey，原样回一段 SSE，并把收到的 query 记进响应头
    pub async fn fake_kiro() -> (String, tokio::task::JoinHandle<()>) {
        let app = Router::new().route(MESSAGES_PATH, post(|headers: axum::http::HeaderMap, axum::Json(body): axum::Json<Value>| async move {
            if headers.get("x-api-key").and_then(|v| v.to_str().ok()) != Some("test-api-key") {
                return (StatusCode::UNAUTHORIZED, [(header::CONTENT_TYPE, "application/json")], "{}".to_string());
            }
            let query = body["messages"][0]["content"].as_str().unwrap_or("").to_string();
            (StatusCode::OK, [(header::CONTENT_TYPE, "text/event-stream")], format!("{FAKE_SSE}: query={query}\n"))
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (url, task)
    }

    #[test]
    fn recognizes_only_the_single_server_tool_shape() {
        let search = json!({"tools":[{"type":"web_search_20250305","name":"web_search","max_uses":8}],"messages":[]});
        assert!(WebSearchRelay::is_web_search_request(&search));
        let mixed = json!({"tools":[{"name":"web_search"},{"name":"Read","input_schema":{}}]});
        assert!(!WebSearchRelay::is_web_search_request(&mixed));
        assert!(!WebSearchRelay::is_web_search_request(&json!({"tools":[{"name":"Read"}]})));
        assert!(!WebSearchRelay::is_web_search_request(&json!({"messages":[]})));
        assert_eq!(connect_host("0.0.0.0"), LOOPBACK);
        assert_eq!(connect_host("[::]"), LOOPBACK);
        assert_eq!(connect_host("localhost"), LOOPBACK);
        assert_eq!(connect_host("192.168.1.9"), "192.168.1.9");
    }

    #[tokio::test]
    async fn forwards_verbatim_and_falls_back_when_kiro_is_unreachable() {
        let (url, task) = fake_kiro().await;
        let body = json!({"model":"m","max_tokens":10,"stream":true,
            "tools":[{"type":"web_search_20250305","name":"web_search"}],
            "messages":[{"role":"user","content":"Perform a web search for the query: rust"}]});
        let relay = WebSearchRelay::new(&url, "test-api-key".into()).unwrap();
        let response = relay.forward(&body).await.expect("应当转发成功");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "text/event-stream");
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(text.starts_with(FAKE_SSE) && text.contains("query=Perform a web search for the query: rust"));
        // apiKey 不对 → kiro-rs 回 401 → 兜底
        assert!(WebSearchRelay::new(&url, "wrong".into()).unwrap().forward(&body).await.is_none());
        task.abort();
        // kiro-rs 没在跑 → 兜底
        let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let dead = format!("http://{}", closed.local_addr().unwrap());
        drop(closed);
        assert!(WebSearchRelay::new(&dead, "test-api-key".into()).unwrap().forward(&body).await.is_none());
    }
}
