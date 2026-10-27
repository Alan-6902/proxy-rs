//! Antigravity 账号池：选号、刷新 token、限流冷却、上游故障转移，以及 OAuth 登录会话

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use parking_lot::Mutex;
use reqwest::{Client, header};
use serde::Serialize;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::client::{self, UpstreamError};
use super::consts::{
    API_TIMEOUT_SECS, DEFAULT_COOLDOWN_SECS, GENERATE_BASE_URLS, GENERATE_TIMEOUT_SECS,
    MAX_ACCOUNT_ATTEMPTS, OAUTH_CALLBACK_PATH, OAUTH_SESSION_TIMEOUT_SECS, STREAM_GENERATE_PATH,
    TOKEN_REFRESH_SKEW_MS,
};
use super::store::{AgAccount, AgAccountView, AgStore, NewAccount};
use crate::http_client::{ProxyConfig, build_client};
use crate::kiro::account_store::now_ms;
use crate::model::config::TlsBackend;

const REAUTH_REQUIRED: &str = "refresh token 已失效，请重新登录";
const OAUTH_SUCCESS_HTML: &str = "<!doctype html><meta charset=utf-8><title>Antigravity</title>\
<p style=\"font:16px system-ui;margin:3em\">登录成功，可以关闭此页面。</p>";
const OAUTH_FAILURE_HTML: &str = "<!doctype html><meta charset=utf-8><title>Antigravity</title>\
<p style=\"font:16px system-ui;margin:3em\">登录失败，请回到管理页面查看原因。</p>";
/// 回调请求头最多读这么多字节
const CALLBACK_MAX_REQUEST_BYTES: usize = 16 * 1024;

/// 请求失败时返回给客户端的错误
#[derive(Debug)]
pub struct AgError {
    pub status: StatusCode,
    pub message: String,
}

impl AgError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self { status, message: message.into() }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OAuthStatus {
    Pending,
    Success,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthSessionView {
    pub status: OAuthStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthStart {
    pub session_id: String,
    pub auth_url: String,
}

pub struct AntigravityProvider {
    store: Arc<AgStore>,
    api_client: Client,
    generate_client: Client,
    /// (账号, 模型) → 冷却到期时刻；额度按模型计，一个模型限流不影响同号的其它模型
    cooldowns: Mutex<HashMap<(i64, String), Instant>>,
    /// 同一账号的刷新串行化，避免并发请求各自去刷
    refresh_locks: Mutex<HashMap<i64, Arc<tokio::sync::Mutex<()>>>>,
    cursor: AtomicUsize,
    oauth_sessions: Mutex<HashMap<String, OAuthSessionView>>,
}

impl AntigravityProvider {
    pub fn new(store: Arc<AgStore>, proxy: Option<&ProxyConfig>, tls_backend: TlsBackend) -> anyhow::Result<Self> {
        Ok(Self {
            store,
            api_client: build_client(proxy, API_TIMEOUT_SECS, tls_backend)?,
            generate_client: build_client(proxy, GENERATE_TIMEOUT_SECS, tls_backend)?,
            cooldowns: Mutex::new(HashMap::new()),
            refresh_locks: Mutex::new(HashMap::new()),
            cursor: AtomicUsize::new(0),
            oauth_sessions: Mutex::new(HashMap::new()),
        })
    }

    pub fn store(&self) -> &AgStore {
        &self.store
    }

    pub fn accounts(&self) -> anyhow::Result<Vec<AgAccountView>> {
        Ok(self.store.list()?.iter().map(AgAccountView::from).collect())
    }

    fn is_cooling(&self, id: i64, model: &str) -> bool {
        let mut map = self.cooldowns.lock();
        let key = (id, model.to_string());
        match map.get(&key) {
            Some(until) if *until > Instant::now() => true,
            Some(_) => {
                map.remove(&key);
                false
            }
            None => false,
        }
    }

    fn cool_down(&self, id: i64, model: &str, secs: f64) {
        let until = Instant::now() + Duration::from_secs_f64(secs.max(1.0));
        self.cooldowns.lock().insert((id, model.to_string()), until);
    }

    fn refresh_lock(&self, id: i64) -> Arc<tokio::sync::Mutex<()>> {
        self.refresh_locks.lock().entry(id).or_default().clone()
    }

    /// 拿到可用的 access token；临近过期或 `force` 时先刷新
    async fn ensure_token(&self, account: &AgAccount, force: bool) -> anyhow::Result<String> {
        let fresh = |a: &AgAccount| {
            a.access_token.clone().filter(|_| {
                a.expires_at_ms.is_some_and(|exp| exp - TOKEN_REFRESH_SKEW_MS > now_ms())
            })
        };
        if !force {
            if let Some(token) = fresh(account) {
                return Ok(token);
            }
        }
        let lock = self.refresh_lock(account.id);
        let _guard = lock.lock().await;
        // 等锁期间可能已被别的请求刷新
        let current = self.store.get(account.id)?.unwrap_or_else(|| account.clone());
        if !force || current.access_token != account.access_token {
            if let Some(token) = fresh(&current) {
                return Ok(token);
            }
        }
        match client::refresh_access_token(&self.api_client, &current.refresh_token).await {
            Ok(t) => {
                let expires_at = now_ms() + t.expires_in * 1000;
                self.store
                    .update_tokens(current.id, &t.access_token, expires_at, t.refresh_token.as_deref())?;
                Ok(t.access_token)
            }
            Err(e) => {
                let reauth = e.downcast_ref::<UpstreamError>().is_some_and(UpstreamError::is_invalid_grant);
                let msg = if reauth { REAUTH_REQUIRED.to_string() } else { format!("刷新 token 失败: {e}") };
                self.store.set_error(current.id, Some(&msg))?;
                Err(anyhow::anyhow!(msg))
            }
        }
    }

    async fn ensure_project(&self, account: &AgAccount, token: &str) -> Option<String> {
        if account.project_id.is_some() {
            return account.project_id.clone();
        }
        match client::load_code_assist(&self.api_client, token).await {
            Ok(info) => {
                if let Err(e) = self.store.update_project(account.id, info.project_id.as_deref(), info.tier.as_deref()) {
                    tracing::warn!("保存 Antigravity projectId 失败: {e}");
                }
                info.project_id
            }
            Err(e) => {
                tracing::warn!("Antigravity 账号 #{} loadCodeAssist 失败: {e}", account.id);
                None
            }
        }
    }

    /// 本轮候选账号：启用、未在该模型上冷却，按轮询游标旋转
    fn candidates(&self, model: &str) -> Result<Vec<AgAccount>, AgError> {
        let all = self
            .store
            .list()
            .map_err(|e| AgError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        let enabled: Vec<AgAccount> = all
            .into_iter()
            .filter(|a| !a.disabled && a.last_error.as_deref() != Some(REAUTH_REQUIRED))
            .collect();
        if enabled.is_empty() {
            return Err(AgError::new(StatusCode::SERVICE_UNAVAILABLE, "没有可用的 Antigravity 账号"));
        }
        let mut ready: Vec<AgAccount> = enabled.into_iter().filter(|a| !self.is_cooling(a.id, model)).collect();
        if ready.is_empty() {
            return Err(AgError::new(
                StatusCode::TOO_MANY_REQUESTS,
                format!("所有 Antigravity 账号在 {model} 上都已限流，请稍后再试"),
            ));
        }
        let start = self.cursor.fetch_add(1, Ordering::Relaxed) % ready.len();
        ready.rotate_left(start);
        Ok(ready)
    }

    /// 发送流式生成请求，返回上游响应（已确认 2xx）
    ///
    /// 同一账号内：daily 端点网络错误或 5xx 时改走 prod；账号间：429 / 401 / 403 换下一个号。
    /// 400 是请求本身的问题，换号无意义，直接返回。
    pub async fn stream_generate(&self, envelope: &Value, model: &str) -> Result<reqwest::Response, AgError> {
        let candidates = self.candidates(model)?;
        let mut last_error = AgError::new(StatusCode::BAD_GATEWAY, "Antigravity 上游调用失败");
        let mut all_rate_limited = true;

        for account in candidates.iter().take(MAX_ACCOUNT_ATTEMPTS) {
            let mut token = match self.ensure_token(account, false).await {
                Ok(t) => t,
                Err(e) => {
                    all_rate_limited = false;
                    last_error = AgError::new(StatusCode::BAD_GATEWAY, format!("{}: {e}", account.email));
                    continue;
                }
            };
            let project = self.ensure_project(account, &token).await;
            let mut body = envelope.clone();
            if let Some(p) = &project {
                body["project"] = Value::String(p.clone());
            }
            body["userAgent"] = Value::String(client::user_agent());

            let mut retried_auth = false;
            'endpoints: for base in GENERATE_BASE_URLS {
                loop {
                    let url = format!("{base}{STREAM_GENERATE_PATH}");
                    let sent = self
                        .generate_client
                        .post(&url)
                        .bearer_auth(&token)
                        .header(header::USER_AGENT, client::user_agent())
                        .json(&body)
                        .send()
                        .await;
                    let resp = match sent {
                        Ok(r) => r,
                        Err(e) => {
                            tracing::warn!("Antigravity {base} 请求失败: {e}");
                            all_rate_limited = false;
                            last_error = AgError::new(StatusCode::BAD_GATEWAY, e.to_string());
                            continue 'endpoints;
                        }
                    };
                    let status = resp.status();
                    if status.is_success() {
                        let _ = self.store.touch_used(account.id);
                        if account.last_error.is_some() {
                            let _ = self.store.set_error(account.id, None);
                        }
                        tracing::info!("Antigravity 账号 #{}（{}）处理 {model}", account.id, account.email);
                        return Ok(resp);
                    }
                    let text = resp.text().await.unwrap_or_default();
                    let detail = UpstreamError { status: status.as_u16(), body: text };
                    tracing::warn!("Antigravity 账号 #{} {model} 失败: {detail}", account.id);
                    match status {
                        StatusCode::TOO_MANY_REQUESTS => {
                            let secs = client::parse_retry_delay_secs(&detail.body)
                                .unwrap_or(DEFAULT_COOLDOWN_SECS as f64);
                            self.cool_down(account.id, model, secs);
                            last_error = AgError::new(StatusCode::TOO_MANY_REQUESTS, detail.to_string());
                            break 'endpoints;
                        }
                        StatusCode::UNAUTHORIZED if !retried_auth => {
                            retried_auth = true;
                            all_rate_limited = false;
                            match self.ensure_token(account, true).await {
                                Ok(t) => {
                                    token = t;
                                    continue;
                                }
                                Err(e) => {
                                    last_error = AgError::new(StatusCode::BAD_GATEWAY, e.to_string());
                                    break 'endpoints;
                                }
                            }
                        }
                        StatusCode::BAD_REQUEST => {
                            return Err(AgError::new(StatusCode::BAD_REQUEST, detail.to_string()));
                        }
                        s if s.is_server_error() => {
                            all_rate_limited = false;
                            last_error = AgError::new(StatusCode::BAD_GATEWAY, detail.to_string());
                            continue 'endpoints;
                        }
                        _ => {
                            all_rate_limited = false;
                            let _ = self.store.set_error(account.id, Some(&detail.to_string()));
                            last_error = AgError::new(StatusCode::BAD_GATEWAY, detail.to_string());
                            break 'endpoints;
                        }
                    }
                }
            }
        }
        if all_rate_limited {
            last_error.status = StatusCode::TOO_MANY_REQUESTS;
        }
        Err(last_error)
    }

    // === 管理操作 ===

    /// 强制刷新 token，并重新拉 projectId 与额度
    pub async fn refresh_account(&self, id: i64) -> anyhow::Result<Option<AgAccountView>> {
        let Some(account) = self.store.get(id)? else {
            return Ok(None);
        };
        let token = self.ensure_token(&account, true).await?;
        let info = client::load_code_assist(&self.api_client, &token).await?;
        self.store.update_project(id, info.project_id.as_deref(), info.tier.as_deref())?;
        let project = info.project_id.or(account.project_id);
        let quota = client::fetch_quota(&self.api_client, &token, project.as_deref()).await?;
        self.store.update_quota(id, &quota)?;
        self.store.set_error(id, None)?;
        // 手动刷新说明用户想立即重试，清掉该号的限流冷却
        self.cooldowns.lock().retain(|(aid, _), _| *aid != id);
        Ok(self.store.get(id)?.as_ref().map(AgAccountView::from))
    }

    pub fn set_disabled(&self, id: i64, disabled: bool) -> anyhow::Result<bool> {
        self.store.set_disabled(id, disabled)
    }

    pub fn delete(&self, id: i64) -> anyhow::Result<bool> {
        self.cooldowns.lock().retain(|(aid, _), _| *aid != id);
        self.store.delete(id)
    }

    pub fn oauth_status(&self, session_id: &str) -> Option<OAuthSessionView> {
        self.oauth_sessions.lock().get(session_id).cloned()
    }

    fn set_oauth_status(&self, session_id: &str, view: OAuthSessionView) {
        self.oauth_sessions.lock().insert(session_id.to_string(), view);
    }

    /// 开始一次 OAuth 登录：在本机回环地址上监听回调，返回需要在浏览器里打开的授权地址
    pub async fn start_oauth(self: &Arc<Self>) -> anyhow::Result<OAuthStart> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let redirect_uri = format!("http://127.0.0.1:{port}{OAUTH_CALLBACK_PATH}");
        let session_id = uuid::Uuid::new_v4().simple().to_string();
        let state = uuid::Uuid::new_v4().simple().to_string();
        let auth_url = client::auth_url(&redirect_uri, &state);
        self.set_oauth_status(
            &session_id,
            OAuthSessionView { status: OAuthStatus::Pending, email: None, error: None },
        );

        let this = self.clone();
        let sid = session_id.clone();
        tokio::spawn(async move {
            let timeout = Duration::from_secs(OAUTH_SESSION_TIMEOUT_SECS);
            let result = match tokio::time::timeout(timeout, this.await_callback(listener, &state, &redirect_uri)).await {
                Ok(r) => r,
                Err(_) => Err(anyhow::anyhow!("等待登录超时")),
            };
            let view = match result {
                Ok(email) => OAuthSessionView { status: OAuthStatus::Success, email: Some(email), error: None },
                Err(e) => {
                    tracing::warn!("Antigravity OAuth 登录失败: {e}");
                    OAuthSessionView { status: OAuthStatus::Error, email: None, error: Some(e.to_string()) }
                }
            };
            this.set_oauth_status(&sid, view);
        });
        Ok(OAuthStart { session_id, auth_url })
    }

    /// 等浏览器带着授权码回调；与回调路径无关的请求（如 favicon）直接 404 后继续等
    async fn await_callback(&self, listener: TcpListener, state: &str, redirect_uri: &str) -> anyhow::Result<String> {
        loop {
            let (mut sock, _) = listener.accept().await?;
            let mut buf = vec![0u8; CALLBACK_MAX_REQUEST_BYTES];
            let n = sock.read(&mut buf).await?;
            let request = String::from_utf8_lossy(&buf[..n]);
            let target = request.split_whitespace().nth(1).unwrap_or_default().to_string();
            let Some(query) = target.strip_prefix(OAUTH_CALLBACK_PATH).and_then(|r| r.strip_prefix('?')) else {
                let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                continue;
            };
            let params: HashMap<String, String> = query
                .split('&')
                .filter_map(|kv| kv.split_once('='))
                .map(|(k, v)| (k.to_string(), urlencoding::decode(&v.replace('+', " ")).map(|s| s.into_owned()).unwrap_or_default()))
                .collect();
            // state 不匹配的请求不是本次登录的回调，拒绝后继续等，避免被无关请求打断登录
            if params.get("state").map(String::as_str) != Some(state) {
                let _ = sock.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                continue;
            }
            let result = self.finish_oauth(&params, redirect_uri).await;
            let html = if result.is_ok() { OAUTH_SUCCESS_HTML } else { OAUTH_FAILURE_HTML };
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
                html.len()
            );
            let _ = sock.write_all(response.as_bytes()).await;
            return result;
        }
    }

    async fn finish_oauth(&self, params: &HashMap<String, String>, redirect_uri: &str) -> anyhow::Result<String> {
        if let Some(err) = params.get("error") {
            anyhow::bail!("Google 拒绝授权: {err}");
        }
        let code = params.get("code").filter(|c| !c.is_empty()).ok_or_else(|| anyhow::anyhow!("回调缺少授权码"))?;
        let tokens = client::exchange_code(&self.api_client, code, redirect_uri).await?;
        let refresh_token = tokens
            .refresh_token
            .clone()
            .ok_or_else(|| anyhow::anyhow!("Google 未返回 refresh token"))?;
        let user = client::user_info(&self.api_client, &tokens.access_token).await?;
        let project = match client::load_code_assist(&self.api_client, &tokens.access_token).await {
            Ok(info) => Some(info),
            Err(e) => {
                tracing::warn!("登录后 loadCodeAssist 失败（可稍后刷新）: {e}");
                None
            }
        };
        let id = self.store.upsert(&NewAccount {
            email: &user.email,
            name: user.name.as_deref(),
            refresh_token: &refresh_token,
            access_token: &tokens.access_token,
            expires_at_ms: now_ms() + tokens.expires_in * 1000,
            project_id: project.as_ref().and_then(|p| p.project_id.as_deref()),
            tier: project.as_ref().and_then(|p| p.tier.as_deref()),
        })?;
        let project_id = project.and_then(|p| p.project_id);
        match client::fetch_quota(&self.api_client, &tokens.access_token, project_id.as_deref()).await {
            Ok(q) => self.store.update_quota(id, &q)?,
            Err(e) => tracing::warn!("登录后拉取额度失败: {e}"),
        }
        tracing::info!("Antigravity 账号已登录: #{id} {}", user.email);
        Ok(user.email)
    }
}
