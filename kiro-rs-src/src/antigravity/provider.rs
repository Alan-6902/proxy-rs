//! Antigravity 账号池：选号、刷新 token、限流冷却、上游故障转移，以及 OAuth 登录会话

use std::collections::{HashMap, HashSet};
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

use super::client::{self, ForbiddenKind, OAuthClient, RateLimitKind, UpstreamError};
use super::consts::{
    ACCOUNT_SWITCH_DELAY_MS, ACCOUNT_SWITCH_JITTER_MS, AICODE_GENERATE_BASE_URLS, API_TIMEOUT_SECS,
    CAPACITY_COOLDOWN_SECS, COUNTS_FLUSH_SECS, DEFAULT_COOLDOWN_SECS, ENDPOINT_SWITCH_DELAY_MS,
    ENDPOINT_SWITCH_JITTER_MS, ENVELOPE_USER_AGENT, FAILURE_COUNT_TTL_SECS,
    FORBIDDEN_COOLDOWN_SECS, GENERATE_BASE_URLS, GENERATE_READ_IDLE_SECS, LAST_USED_FLUSH_SECS,
    MAX_ACCOUNT_ATTEMPTS, MIN_COOLDOWN_SECS, MODEL_NOT_FOUND_COOLDOWN_SECS, OAUTH_CALLBACK_PATH,
    OAUTH_SESSION_TIMEOUT_SECS, QUOTA_EXHAUSTED_COOLDOWN_SECS, QUOTA_REFRESH_SECS,
    RATE_LIMIT_COOLDOWN_SECS, RETRY_IN_PLACE_MAX_SECS, STICKY_SESSION_MAX,
    STICKY_SESSION_TTL_SECS, STREAM_GENERATE_PATH, TOKEN_REFRESH_SKEW_MS, VERSION_REFRESH_SECS,
};
use super::converter::{to_aicode_request, upstream_session_id};
use super::models;
use super::store::{AgAccount, AgAccountView, AgCounter, AgStore, NewAccount};
use crate::http_client::{ProxyConfig, build_client, build_streaming_client};
use crate::kiro::account_store::now_ms;
use crate::model::config::TlsBackend;

const REAUTH_REQUIRED: &str = "refresh token 已失效，请重新登录";
const BANNED_PREFIX: &str = "上游判定账号违反条款，已自动停用";
/// 人工验证不会自愈：账号退出选号，等用户在浏览器完成验证后点「刷新」恢复
const VALIDATION_REQUIRED_PREFIX: &str = "上游要求人工验证，已暂停该账号；在浏览器完成验证后点「刷新」恢复";
const FORBIDDEN_PREFIX: &str = "上游拒绝访问（403），账号暂停 30 分钟";

/// 需要用户动手才能恢复的错误状态（重新登录 / 完成人工验证），期间不参与选号
fn needs_manual_action(last_error: Option<&str>) -> bool {
    last_error.is_some_and(|e| e == REAUTH_REQUIRED || e.starts_with(VALIDATION_REQUIRED_PREFIX))
}
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

/// 管理与公开接口共用的模型规格，容量优先采用上游 maxTokens。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    pub id: String,
    pub display_name: String,
    pub context_window: i32,
    pub enabled: bool,
    /// 当前模型列表里有这个模型的启用账号 id（仅管理接口展示用，公开接口不输出）
    pub account_ids: Vec<i64>,
}

/// 一次扫描里单个账号的结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub id: i64,
    pub email: String,
    pub ok: bool,
    pub error: Option<String>,
}

/// 同一 (账号, 模型) 连续 429 的次数，用于阶梯冷却
struct FailureStreak {
    kind: RateLimitKind,
    count: usize,
    last: Instant,
}

pub struct AntigravityProvider {
    store: Arc<AgStore>,
    api_client: Client,
    generate_client: Client,
    /// 登录与刷新 token 用的 OAuth 客户端，来自配置文件
    oauth: OAuthClient,
    /// (账号, 模型) → 冷却到期时刻；额度按模型计，一个模型限流不影响同号的其它模型
    cooldowns: Mutex<HashMap<(i64, String), Instant>>,
    /// 账号 → 冷却到期时刻；403 这类账号级问题，所有模型一起停
    account_cooldowns: Mutex<HashMap<i64, Instant>>,
    failure_streaks: Mutex<HashMap<(i64, String), FailureStreak>>,
    /// 会话指纹 → (账号, 最近使用)；同一会话尽量固定在一个账号上
    sticky_sessions: Mutex<HashMap<String, (i64, Instant)>>,
    /// 账号 → 上次把 last_used_ms 写进库的时刻
    last_used_flushed: Mutex<HashMap<i64, Instant>>,
    /// 同一账号的刷新串行化，避免并发请求各自去刷
    refresh_locks: Mutex<HashMap<i64, Arc<tokio::sync::Mutex<()>>>>,
    cursor: AtomicUsize,
    oauth_sessions: Mutex<HashMap<String, OAuthSessionView>>,
}

/// 等 `base + 随机[0, jitter]` 毫秒，避免多次重试节奏固定
async fn jittered_sleep(base_ms: u64, jitter_ms: u64) {
    tokio::time::sleep(Duration::from_millis(base_ms + fastrand::u64(0..=jitter_ms))).await;
}

/// 阶梯冷却：第 n 次（从 0 起）取第 n 档，超出取末档
fn ladder_secs(ladder: &[u64], step: usize) -> f64 {
    ladder.get(step).or(ladder.last()).copied().unwrap_or(DEFAULT_COOLDOWN_SECS) as f64
}

impl AntigravityProvider {
    pub fn new(
        store: Arc<AgStore>,
        proxy: Option<&ProxyConfig>,
        tls_backend: TlsBackend,
        oauth: OAuthClient,
    ) -> anyhow::Result<Self> {
        Ok(Self {
            store,
            api_client: build_client(proxy, API_TIMEOUT_SECS, tls_backend)?,
            generate_client: build_streaming_client(proxy, GENERATE_READ_IDLE_SECS, tls_backend)?,
            oauth,
            cooldowns: Mutex::new(HashMap::new()),
            account_cooldowns: Mutex::new(HashMap::new()),
            failure_streaks: Mutex::new(HashMap::new()),
            sticky_sessions: Mutex::new(HashMap::new()),
            last_used_flushed: Mutex::new(HashMap::new()),
            refresh_locks: Mutex::new(HashMap::new()),
            cursor: AtomicUsize::new(0),
            oauth_sessions: Mutex::new(HashMap::new()),
        })
    }

    /// 后台定时刷新上报的客户端版本（本机 App / 官方更新清单），在运行时里调用一次即可
    pub fn start_background_tasks(self: &Arc<Self>) {
        let this = self.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(VERSION_REFRESH_SECS));
            loop {
                tick.tick().await;
                client::refresh_client_version(&this.api_client).await;
            }
        });
        // 定时拉额度：首个 tick 立即触发，启动后马上有一份新数据
        let this = self.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(QUOTA_REFRESH_SECS));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                this.refresh_all_quotas().await;
            }
        });
        // 定时把内存里的计数增量落盘；首个 tick 立即触发，此时没有增量，直接跳过
        let this = self.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(COUNTS_FLUSH_SECS));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                let store = this.store.clone();
                match tokio::task::spawn_blocking(move || store.flush_counts()).await {
                    Ok(Ok(_)) => {}
                    Ok(Err(e)) => tracing::warn!("Antigravity 计数落盘失败，下次重试: {e}"),
                    Err(e) => tracing::warn!("Antigravity 计数落盘任务异常: {e}"),
                }
            }
        });
    }

    /// 退出前把未落盘的计数写掉
    pub fn flush_counts(&self) {
        if let Err(e) = self.store.flush_counts() {
            tracing::warn!("Antigravity 退出前计数落盘失败: {e}");
        }
    }

    /// 逐个拉启用账号的额度；单号失败只记日志，不影响其它账号，也不改账号错误状态
    async fn refresh_all_quotas(&self) {
        let accounts = match self.store.list() {
            Ok(list) => list,
            Err(e) => {
                tracing::warn!("定时刷新 Antigravity 额度：读取账号失败: {e}");
                return;
            }
        };
        for account in accounts.iter().filter(|a| !a.disabled) {
            if let Err(e) = self.refresh_quota(account).await {
                tracing::warn!("定时刷新 Antigravity 额度失败 #{}: {e}", account.id);
            }
        }
    }

    async fn refresh_quota(&self, account: &AgAccount) -> anyhow::Result<()> {
        let token = self.ensure_token(account, false).await?;
        let (project, _) = self.ensure_project(account, &token).await;
        let quota = client::fetch_quota(&self.api_client, &token, project.as_deref()).await?;
        self.store.update_quota(account.id, &quota)?;
        Ok(())
    }

    pub fn store(&self) -> &AgStore {
        &self.store
    }

    pub fn accounts(&self) -> anyhow::Result<Vec<AgAccountView>> {
        Ok(self.store.list()?.iter().map(AgAccountView::from).collect())
    }

    /// 所有启用账号的公开模型并集；无目录时兜底，再标记用户的目录选择。
    pub fn model_catalog(&self) -> anyhow::Result<Vec<CatalogModel>> {
        let accounts = self.store.snapshot()?;
        let enabled = self.store.enabled_model_ids()?.map(|ids| ids.into_iter().collect::<HashSet<_>>());
        let mut entries: HashMap<String, (Option<i64>, Option<String>, Vec<i64>)> = HashMap::new();
        for account in accounts.iter().filter(|a| !a.disabled) {
            let Some(list) = account.quota.as_ref().and_then(|q| q.get("models")).and_then(Value::as_array) else {
                continue;
            };
            for info in list {
                let Some(id) = info.get("id").and_then(Value::as_str) else { continue };
                if !models::is_public(id) {
                    continue;
                }
                let context = info.get("maxTokens").and_then(Value::as_i64).filter(|c| *c > 0);
                let display_name = info.get("displayName").and_then(Value::as_str)
                    .filter(|name| !name.trim().is_empty()).map(str::to_string);
                let entry = entries.entry(id.to_string()).or_default();
                // 多账号规格不一致时采用较小容量，避免夸大当前池的可用上下文。
                entry.0 = match (entry.0, context) {
                    (Some(a), Some(b)) => Some(a.min(b)),
                    (a, b) => a.or(b),
                };
                entry.1 = entry.1.take().or(display_name);
                if !entry.2.contains(&account.id) {
                    entry.2.push(account.id);
                }
            }
        }
        if entries.is_empty() {
            entries.extend(models::PUBLIC_MODELS.iter().map(|(id, _)| (id.to_string(), (None, None, Vec::new()))));
        }
        let mut catalog: Vec<_> = entries.into_iter().map(|(id, (context, display_name, account_ids))| CatalogModel {
            display_name: display_name.unwrap_or_else(|| models::display_name(&id)),
            context_window: context.map_or_else(|| models::context_window(&id), |c| c.min(i32::MAX as i64) as i32),
            enabled: enabled.as_ref().is_none_or(|ids| ids.contains(&id)),
            account_ids,
            id,
        }).collect();
        catalog.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(catalog)
    }

    /// 手动扫描：逐个刷新启用账号的模型列表，返回每个号的结果。只在用户点「扫描账号」时调用。
    pub async fn scan_accounts(&self) -> anyhow::Result<Vec<ScanResult>> {
        let mut results = Vec::new();
        for account in self.store.list()?.iter().filter(|a| !a.disabled) {
            let outcome = self.refresh_quota(account).await;
            if let Err(e) = &outcome {
                tracing::warn!("扫描 Antigravity 账号 #{} 失败: {e}", account.id);
            }
            results.push(ScanResult {
                id: account.id,
                email: account.email.clone(),
                ok: outcome.is_ok(),
                error: outcome.err().map(|e| e.to_string()),
            });
        }
        Ok(results)
    }

    /// 保存勾选，并按当前目录把勾选的模型分组到支持它的账号上。
    /// 之后选账号只看这份分组，账号或订阅变了需要重新扫描并保存。
    pub fn save_model_selection(&self, ids: &[String]) -> anyhow::Result<()> {
        let catalog = self.model_catalog()?;
        if let Some(id) = ids.iter().find(|id| !catalog.iter().any(|m| &m.id == *id)) {
            anyhow::bail!("模型不在当前目录中: {id}");
        }
        let groups: HashMap<String, Vec<i64>> = catalog
            .into_iter()
            .filter(|m| ids.contains(&m.id) && !m.account_ids.is_empty())
            .map(|m| (m.id, m.account_ids))
            .collect();
        self.store.save_model_selection(ids, &groups)
    }

    /// 仅返回已勾选的模型，明确空选择不会重新启用兜底目录。
    pub fn available_models(&self) -> anyhow::Result<Vec<CatalogModel>> {
        Ok(self.model_catalog()?.into_iter().filter(|model| model.enabled).collect())
    }

    fn is_cooling(&self, id: i64, model: &str) -> bool {
        let now = Instant::now();
        {
            let mut accounts = self.account_cooldowns.lock();
            match accounts.get(&id) {
                Some(until) if *until > now => return true,
                Some(_) => {
                    accounts.remove(&id);
                }
                None => {}
            }
        }
        let mut map = self.cooldowns.lock();
        let key = (id, model.to_string());
        match map.get(&key) {
            Some(until) if *until > now => true,
            Some(_) => {
                map.remove(&key);
                false
            }
            None => false,
        }
    }

    fn cool_down(&self, id: i64, model: &str, secs: f64) {
        let until = Instant::now() + Duration::from_secs_f64(secs.max(MIN_COOLDOWN_SECS));
        self.cooldowns.lock().insert((id, model.to_string()), until);
    }

    fn cool_down_account(&self, id: i64, secs: f64) {
        let until = Instant::now() + Duration::from_secs_f64(secs.max(MIN_COOLDOWN_SECS));
        self.account_cooldowns.lock().insert(id, until);
    }

    /// 429 的冷却秒数：上游给了等待时间就用它，否则按原因与连续次数阶梯递增
    fn rate_limit_cooldown(&self, id: i64, model: &str, kind: RateLimitKind, hinted: Option<f64>) -> f64 {
        let now = Instant::now();
        let mut streaks = self.failure_streaks.lock();
        let streak = streaks
            .entry((id, model.to_string()))
            .or_insert(FailureStreak { kind, count: 0, last: now });
        if streak.kind != kind || now.duration_since(streak.last) > Duration::from_secs(FAILURE_COUNT_TTL_SECS) {
            streak.kind = kind;
            streak.count = 0;
        }
        let step = streak.count;
        streak.count += 1;
        streak.last = now;
        hinted.unwrap_or_else(|| match kind {
            RateLimitKind::QuotaExhausted => ladder_secs(QUOTA_EXHAUSTED_COOLDOWN_SECS, step),
            RateLimitKind::RateLimited => ladder_secs(RATE_LIMIT_COOLDOWN_SECS, step),
            RateLimitKind::Capacity => ladder_secs(CAPACITY_COOLDOWN_SECS, step),
            RateLimitKind::Unknown => DEFAULT_COOLDOWN_SECS as f64,
        })
    }

    fn clear_failures(&self, id: i64, model: &str) {
        self.failure_streaks.lock().remove(&(id, model.to_string()));
    }

    /// 403：封号直接停用；要求人工验证的账号退出选号并把验证地址写进错误（不会自愈，冷却没有意义）；
    /// 其它原因整个账号冷却一段时间
    fn handle_forbidden(&self, account: &AgAccount, detail: &UpstreamError) {
        let reason = client::classify_forbidden(&detail.body);
        let message = match reason {
            ForbiddenKind::Banned => {
                if let Err(e) = self.store.set_disabled(account.id, true) {
                    tracing::warn!("停用 Antigravity 账号 #{} 失败: {e}", account.id);
                }
                format!("{BANNED_PREFIX}：{detail}")
            }
            ForbiddenKind::ValidationRequired => match client::validation_url(&detail.body) {
                Some(url) => format!("{VALIDATION_REQUIRED_PREFIX}；验证地址：{url}"),
                None => format!("{VALIDATION_REQUIRED_PREFIX}：{detail}"),
            },
            ForbiddenKind::Other => {
                self.cool_down_account(account.id, FORBIDDEN_COOLDOWN_SECS);
                format!("{FORBIDDEN_PREFIX}：{detail}")
            }
        };
        tracing::warn!("Antigravity 账号 #{}（{}）{message}", account.id, account.email);
        if let Err(e) = self.store.set_error(account.id, Some(&message)) {
            tracing::warn!("记录 Antigravity 账号 #{} 错误状态失败: {e}", account.id);
        }
    }

    /// 会话当前粘着的账号（过期的顺手清掉）
    fn sticky_account(&self, session_key: &str) -> Option<i64> {
        let mut map = self.sticky_sessions.lock();
        match map.get(session_key) {
            Some((id, last)) if last.elapsed() < Duration::from_secs(STICKY_SESSION_TTL_SECS) => Some(*id),
            Some(_) => {
                map.remove(session_key);
                None
            }
            None => None,
        }
    }

    fn bind_session(&self, session_key: &str, id: i64) {
        let mut map = self.sticky_sessions.lock();
        if map.len() >= STICKY_SESSION_MAX && !map.contains_key(session_key) {
            let ttl = Duration::from_secs(STICKY_SESSION_TTL_SECS);
            map.retain(|_, (_, last)| last.elapsed() < ttl);
            if map.len() >= STICKY_SESSION_MAX {
                // 仍满：丢掉最久没用的一条
                if let Some(oldest) = map.iter().min_by_key(|(_, (_, last))| *last).map(|(k, _)| k.clone()) {
                    map.remove(&oldest);
                }
            }
        }
        map.insert(session_key.to_string(), (id, Instant::now()));
    }

    /// 成功后记录使用时间：同一账号一分钟内只落一次盘，避免每个请求都 fsync
    fn record_used(&self, id: i64) {
        let due = {
            let mut flushed = self.last_used_flushed.lock();
            let due = flushed
                .get(&id)
                .is_none_or(|t| t.elapsed() >= Duration::from_secs(LAST_USED_FLUSH_SECS));
            if due {
                flushed.insert(id, Instant::now());
            }
            due
        };
        if due
            && let Err(e) = self.store.touch_used(id)
        {
            tracing::warn!("记录 Antigravity 账号 #{id} 使用时间失败: {e}");
        }
    }

    /// 累计计数 +1：只在内存累加，后台定时批量落盘，请求路径不写库
    fn count(&self, id: i64, counter: AgCounter) {
        self.store.increment(id, counter);
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
        match client::refresh_access_token(&self.api_client, &self.oauth, &current.refresh_token).await {
            Ok(t) => {
                let expires_at = now_ms() + t.expires_in * 1000;
                self.store
                    .update_tokens(current.id, &t.access_token, expires_at, t.refresh_token.as_deref())?;
                Ok(t.access_token)
            }
            Err(e) => {
                let reauth = e.downcast_ref::<UpstreamError>().is_some_and(UpstreamError::is_invalid_grant);
                let msg = if reauth { REAUTH_REQUIRED.to_string() } else { format!("刷新 token 失败: {e}") };
                self.count(current.id, AgCounter::RefreshFailure);
                self.store.set_error(current.id, Some(&msg))?;
                Err(anyhow::anyhow!(msg))
            }
        }
    }

    async fn ensure_project(&self, account: &AgAccount, token: &str) -> (Option<String>, String) {
        if account.project_id.is_some() && account.tier.is_some() {
            return (
                account.project_id.clone(),
                client::normalize_user_tier(account.tier.as_deref()),
            );
        }
        match client::load_code_assist(&self.api_client, token).await {
            Ok(info) => {
                if let Err(e) = self.store.update_project(account.id, info.project_id.as_deref(), info.tier.as_deref()) {
                    tracing::warn!("保存 Antigravity projectId 失败: {e}");
                }
                let project = info.project_id.or_else(|| account.project_id.clone());
                let tier = client::normalize_user_tier(info.tier.as_deref().or(account.tier.as_deref()));
                (project, tier)
            }
            Err(e) => {
                tracing::warn!("Antigravity 账号 #{} loadCodeAssist 失败: {e}", account.id);
                (
                    account.project_id.clone(),
                    client::normalize_user_tier(account.tier.as_deref()),
                )
            }
        }
    }

    /// 本轮候选账号：启用、未在该模型上冷却。
    /// 会话已粘着某个可用账号时把它排第一；新会话按轮询游标挑起点
    /// 账号与模型分组都读内存快照，不碰 SQLite
    fn candidates(&self, model: &str, session_key: Option<&str>) -> Result<Vec<Arc<AgAccount>>, AgError> {
        let all = self
            .store
            .snapshot()
            .map_err(|e| AgError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        let enabled: Vec<Arc<AgAccount>> = all
            .iter()
            .filter(|a| !a.disabled && !needs_manual_action(a.last_error.as_deref()))
            .cloned()
            .collect();
        if enabled.is_empty() {
            return Err(AgError::new(StatusCode::SERVICE_UNAVAILABLE, "没有可用的 Antigravity 账号"));
        }
        // 模型分组：用户在模型目录扫描并保存勾选时固定下来，之后不自动变。
        // 分组里有这个模型时只用组内账号；没有（未保存过、别名、隐藏模型）时照常全部试。
        let groups = self
            .store
            .model_accounts()
            .map_err(|e| AgError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        let pool = match groups.as_ref().and_then(|groups| groups.get(model)) {
            Some(ids) => {
                let pool: Vec<Arc<AgAccount>> = enabled.into_iter().filter(|a| ids.contains(&a.id)).collect();
                if pool.is_empty() {
                    return Err(AgError::new(
                        StatusCode::SERVICE_UNAVAILABLE,
                        format!("模型分组里支持 {model} 的账号都已停用；账号有变动时请在模型目录重新扫描并保存"),
                    ));
                }
                pool
            }
            None => enabled,
        };
        let mut ready: Vec<Arc<AgAccount>> = pool.into_iter().filter(|a| !self.is_cooling(a.id, model)).collect();
        if ready.is_empty() {
            return Err(AgError::new(
                StatusCode::TOO_MANY_REQUESTS,
                format!("所有 Antigravity 账号在 {model} 上都已限流，请稍后再试"),
            ));
        }
        let sticky = session_key
            .and_then(|k| self.sticky_account(k))
            .and_then(|id| ready.iter().position(|a| a.id == id));
        match sticky {
            Some(pos) => ready.rotate_left(pos),
            None => {
                let start = self.cursor.fetch_add(1, Ordering::Relaxed) % ready.len();
                ready.rotate_left(start);
            }
        }
        Ok(ready)
    }

    /// 发送流式生成请求，返回上游响应（已确认 2xx）
    ///
    /// 同一账号内：daily 连不上或 5xx 时稍等后改走 sandbox；上游建议的等待很短的 429 在原号等完重试一次。
    /// 账号间：429 / 401 / 403 / 404 换下一个号，换号前随机退避，避免短时间多号连发。
    /// 400 是请求本身的问题，换号无意义，直接返回。
    /// `session_key` 相同的请求尽量落在同一账号上，并带稳定的 `sessionId`，上游前缀缓存才能命中。
    pub async fn stream_generate(
        &self,
        envelope: &Value,
        model: &str,
        session_key: Option<&str>,
    ) -> Result<reqwest::Response, AgError> {
        let candidates = self.candidates(model, session_key)?;
        let mut last_error = AgError::new(StatusCode::BAD_GATEWAY, "Antigravity 上游调用失败");
        let mut all_rate_limited = true;
        let user_agent = client::user_agent();

        for (attempt, account) in candidates.iter().take(MAX_ACCOUNT_ATTEMPTS).enumerate() {
            if attempt > 0 {
                jittered_sleep(ACCOUNT_SWITCH_DELAY_MS, ACCOUNT_SWITCH_JITTER_MS).await;
            }
            let mut token = match self.ensure_token(account, false).await {
                Ok(t) => t,
                Err(e) => {
                    all_rate_limited = false;
                    last_error = AgError::new(StatusCode::BAD_GATEWAY, format!("{}: {e}", account.email));
                    continue;
                }
            };
            let (project, user_tier) = self.ensure_project(account, &token).await;
            let session_id = upstream_session_id(account.id, session_key);
            let mut ccpa_body = envelope.clone();
            if let Some(p) = &project {
                ccpa_body["project"] = Value::String(p.clone());
            }
            ccpa_body["userAgent"] = Value::String(ENVELOPE_USER_AGENT.to_string());
            ccpa_body["request"]["sessionId"] = Value::String(session_id.clone());
            let aicode_body = to_aicode_request(envelope, model, &user_tier, &session_id);

            let endpoints: Vec<(&str, &Value)> = if models::prefers_aicode_endpoint(model) {
                AICODE_GENERATE_BASE_URLS.iter().map(|u| (*u, &aicode_body)).collect()
            } else {
                GENERATE_BASE_URLS
                    .iter()
                    .map(|u| (*u, &ccpa_body))
                    .chain(AICODE_GENERATE_BASE_URLS.iter().map(|u| (*u, &aicode_body)))
                    .collect()
            };

            let mut retried_auth = false;
            let mut retried_in_place = false;
            let mut not_found_everywhere = true;
            'endpoints: for (endpoint_index, (base, req_body)) in endpoints.iter().enumerate() {
                if endpoint_index > 0 {
                    jittered_sleep(ENDPOINT_SWITCH_DELAY_MS, ENDPOINT_SWITCH_JITTER_MS).await;
                }
                loop {
                    let url = format!("{base}{STREAM_GENERATE_PATH}");
                    let sent = self
                        .generate_client
                        .post(&url)
                        .bearer_auth(&token)
                        .header(header::USER_AGENT, &user_agent)
                        .json(*req_body)
                        .send()
                        .await;
                    let resp = match sent {
                        Ok(r) => r,
                        Err(e) => {
                            tracing::warn!("Antigravity {base} 请求失败: {e}");
                            if !e.is_connect() {
                                // 请求可能已送达上游：不换端点重发，避免重复扣额度
                                self.count(account.id, AgCounter::Failure);
                                return Err(AgError::new(StatusCode::BAD_GATEWAY, e.to_string()));
                            }
                            all_rate_limited = false;
                            not_found_everywhere = false;
                            last_error = AgError::new(StatusCode::BAD_GATEWAY, e.to_string());
                            continue 'endpoints;
                        }
                    };
                    let status = resp.status();
                    if status.is_success() {
                        self.count(account.id, AgCounter::Success);
                        self.record_used(account.id);
                        self.clear_failures(account.id, model);
                        if let Some(key) = session_key {
                            self.bind_session(key, account.id);
                        }
                        if account.last_error.is_some()
                            && let Err(e) = self.store.set_error(account.id, None)
                        {
                            tracing::warn!("清除 Antigravity 账号 #{} 错误状态失败: {e}", account.id);
                        }
                        tracing::info!("Antigravity 账号 #{}（{}）处理 {model}", account.id, account.email);
                        return Ok(resp);
                    }
                    let text = resp.text().await.unwrap_or_default();
                    let detail = UpstreamError { status: status.as_u16(), body: text };
                    tracing::warn!("Antigravity 账号 #{} {model} 失败: {detail}", account.id);
                    if status != StatusCode::NOT_FOUND {
                        not_found_everywhere = false;
                    }
                    match status {
                        StatusCode::TOO_MANY_REQUESTS => {
                            let hinted = client::parse_retry_delay_secs(&detail.body);
                            // 很快就能恢复：原号等一下再试，比换号更像真人，也保住前缀缓存
                            if let Some(wait) = hinted.filter(|s| !retried_in_place && *s <= RETRY_IN_PLACE_MAX_SECS) {
                                retried_in_place = true;
                                tokio::time::sleep(Duration::from_secs_f64(wait.max(0.5))).await;
                                continue;
                            }
                            let kind = client::classify_rate_limit(&detail.body);
                            let secs = self.rate_limit_cooldown(account.id, model, kind, hinted);
                            tracing::info!("Antigravity 账号 #{} {model} 限流（{kind:?}），冷却 {secs:.0}s", account.id);
                            self.cool_down(account.id, model, secs);
                            last_error = AgError::new(StatusCode::TOO_MANY_REQUESTS, detail.to_string());
                            break 'endpoints;
                        }
                        StatusCode::FORBIDDEN => {
                            all_rate_limited = false;
                            self.handle_forbidden(account, &detail);
                            last_error = AgError::new(StatusCode::BAD_GATEWAY, detail.to_string());
                            break 'endpoints;
                        }
                        StatusCode::NOT_FOUND => {
                            // 可能只是该端点没有这个模型，先试下一个端点
                            all_rate_limited = false;
                            last_error = AgError::new(StatusCode::BAD_GATEWAY, detail.to_string());
                            continue 'endpoints;
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
                            if let Err(e) = self.store.set_error(account.id, Some(&detail.to_string())) {
                                tracing::warn!("记录 Antigravity 账号 #{} 错误状态失败: {e}", account.id);
                            }
                            last_error = AgError::new(StatusCode::BAD_GATEWAY, detail.to_string());
                            break 'endpoints;
                        }
                    }
                }
            }
            // 走到这里说明这个号本轮没成功（400 已提前返回，属于请求本身的问题，不计）
            self.count(account.id, AgCounter::Failure);
            if not_found_everywhere {
                // 每个端点都说没有这个模型：只停这个号的这个模型，不连坐其它模型
                self.cool_down(account.id, model, MODEL_NOT_FOUND_COOLDOWN_SECS);
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
        self.forget_account_state(id);
        Ok(self.store.get(id)?.as_ref().map(AgAccountView::from))
    }

    pub fn set_disabled(&self, id: i64, disabled: bool) -> anyhow::Result<bool> {
        self.store.set_disabled(id, disabled)
    }

    /// 失败计数清零，同时清掉该号的限流冷却，下次请求可以立即用它
    pub fn reset_failures(&self, id: i64) -> anyhow::Result<bool> {
        let found = self.store.reset_failures(id)?;
        if found {
            self.forget_account_state(id);
        }
        Ok(found)
    }

    pub fn delete(&self, id: i64) -> anyhow::Result<bool> {
        self.forget_account_state(id);
        self.sticky_sessions.lock().retain(|_, (aid, _)| *aid != id);
        self.last_used_flushed.lock().remove(&id);
        self.store.delete(id)
    }

    /// 清掉某账号在内存里的冷却与失败计数
    fn forget_account_state(&self, id: i64) {
        self.cooldowns.lock().retain(|(aid, _), _| *aid != id);
        self.account_cooldowns.lock().remove(&id);
        self.failure_streaks.lock().retain(|(aid, _), _| *aid != id);
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
        let auth_url = client::auth_url(&self.oauth, &redirect_uri, &state);
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
        let tokens = client::exchange_code(&self.api_client, &self.oauth, code, redirect_uri).await?;
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 临时账号库，测试结束后移到废纸篓
    struct TempDb(std::path::PathBuf);

    impl Drop for TempDb {
        fn drop(&mut self) {
            let trash = std::path::PathBuf::from(std::env::var_os("HOME").unwrap()).join(".Trash");
            let _ = std::fs::create_dir_all(&trash);
            let _ = std::fs::rename(&self.0, trash.join(self.0.file_name().unwrap()));
        }
    }

    fn provider_with_accounts(emails: &[&str]) -> (TempDb, AntigravityProvider, Vec<i64>) {
        let dir = std::env::temp_dir().join(format!("ag-provider-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let store = Arc::new(AgStore::open_or_create(&dir.join("ag.sqlite3")).unwrap());
        let ids = emails
            .iter()
            .map(|email| {
                store
                    .upsert(&NewAccount {
                        email,
                        name: None,
                        refresh_token: "r",
                        access_token: "a",
                        expires_at_ms: i64::MAX,
                        project_id: Some("p"),
                        tier: None,
                    })
                    .unwrap()
            })
            .collect();
        let provider = AntigravityProvider::new(store, None, TlsBackend::Rustls, OAuthClient::for_tests()).unwrap();
        (TempDb(dir), provider, ids)
    }

    fn first_candidate(p: &AntigravityProvider, session: Option<&str>) -> i64 {
        p.candidates("m", session).unwrap()[0].id
    }

    #[test]
    fn saved_model_groups_limit_candidates_until_next_save() {
        // pro 没有 argon、ultra 有
        let (_db, p, ids) = provider_with_accounts(&["pro@x", "ultra@x"]);
        let argon = "gemini-4-argon-high";
        p.store.update_quota(ids[0], &serde_json::json!({ "models": [{ "id": "gemini-3-flash" }] })).unwrap();
        p.store.update_quota(ids[1], &serde_json::json!({ "models": [
            { "id": "gemini-3-flash" }, { "id": argon }
        ] })).unwrap();
        let ids_for = |model: &str| -> Vec<i64> {
            let mut v: Vec<i64> = p.candidates(model, None).unwrap().iter().map(|a| a.id).collect();
            v.sort();
            v
        };
        // 没保存过分组：照常全部试
        assert_eq!(ids_for(argon), vec![ids[0], ids[1]]);
        let catalog = p.model_catalog().unwrap();
        assert_eq!(catalog.iter().find(|m| m.id == argon).unwrap().account_ids, vec![ids[1]]);

        p.save_model_selection(&[argon.to_string(), "gemini-3-flash".to_string()]).unwrap();
        assert_eq!(ids_for(argon), vec![ids[1]]);
        assert_eq!(ids_for("gemini-3-flash"), vec![ids[0], ids[1]]);
        // 分组外的模型（别名、未勾选）不受限制
        assert_eq!(ids_for("gemini-pro-agent"), vec![ids[0], ids[1]]);

        // 分组固定：之后 pro 的模型列表变了也不自动生效，要重新保存
        p.store.update_quota(ids[0], &serde_json::json!({ "models": [{ "id": argon }] })).unwrap();
        assert_eq!(ids_for(argon), vec![ids[1]]);
        p.save_model_selection(&[argon.to_string()]).unwrap();
        assert_eq!(ids_for(argon), vec![ids[0], ids[1]]);

        // 组内账号都停用：明确报错，不回落到组外账号
        p.save_model_selection(&["gemini-3-flash".to_string()]).unwrap();
        p.store.update_quota(ids[0], &serde_json::json!({ "models": [{ "id": argon }] })).unwrap();
        p.store.update_quota(ids[1], &serde_json::json!({ "models": [{ "id": "gemini-3-flash" }] })).unwrap();
        p.save_model_selection(&["gemini-3-flash".to_string(), argon.to_string()]).unwrap();
        p.store.set_disabled(ids[0], true).unwrap();
        assert_eq!(p.candidates(argon, None).unwrap_err().status, StatusCode::SERVICE_UNAVAILABLE);
        // 保存时校验目录
        assert!(p.save_model_selection(&["not-in-catalog".to_string()]).is_err());
    }

    #[test]
    fn model_catalog_shares_fallback_and_preserves_empty_selection() {
        let (_db, p, _) = provider_with_accounts(&[]);
        let catalog = p.model_catalog().unwrap();
        assert_eq!(catalog.len(), models::PUBLIC_MODELS.len());
        assert!(catalog.iter().all(|m| m.enabled));
        assert_eq!(p.available_models().unwrap().len(), catalog.len());
        let opus = catalog.iter().find(|m| m.id == models::CLAUDE_OPUS).unwrap();
        assert_eq!(opus.context_window, models::CLAUDE_CONTEXT_WINDOW);
        p.store.set_enabled_model_ids(&[]).unwrap();
        assert!(p.available_models().unwrap().is_empty());
        assert!(p.model_catalog().unwrap().iter().all(|m| !m.enabled));
    }

    #[test]
    fn model_catalog_uses_quota_metadata_and_new_models_stay_disabled() {
        let (_db, p, ids) = provider_with_accounts(&["a@x", "b@x", "disabled@x"]);
        p.store.update_quota(ids[0], &serde_json::json!({ "models": [
            { "id": models::CLAUDE_OPUS, "maxTokens": 250_000, "displayName": "Upstream Opus" },
            { "id": "custom-model", "maxTokens": 0 },
            { "id": "no-capacity", "maxTokens": -1 },
            { "id": "tab_internal", "maxTokens": 999_999 }
        ] })).unwrap();
        p.store.update_quota(ids[1], &serde_json::json!({ "models": [
            { "id": models::CLAUDE_OPUS, "maxTokens": 300_000 },
            { "id": "custom-model", "maxTokens": 777_777 },
            { "id": "huge-model", "maxTokens": i64::MAX }
        ] })).unwrap();
        p.store.update_quota(ids[2], &serde_json::json!({ "models": [
            { "id": "disabled-only", "maxTokens": 100 }
        ] })).unwrap();
        p.store.set_disabled(ids[2], true).unwrap();
        let catalog = p.model_catalog().unwrap();
        assert_eq!(catalog.len(), 4);
        assert_eq!(catalog.iter().find(|m| m.id == "custom-model").unwrap().context_window, 777_777);
        assert_eq!(catalog.iter().find(|m| m.id == "no-capacity").unwrap().context_window, 0);
        assert_eq!(catalog.iter().find(|m| m.id == "huge-model").unwrap().context_window, i32::MAX);
        let opus = catalog.iter().find(|m| m.id == models::CLAUDE_OPUS).unwrap();
        assert_eq!(opus.context_window, 250_000);
        assert_eq!(opus.display_name, "Upstream Opus");
        p.store.set_enabled_model_ids(&[models::CLAUDE_OPUS.to_string()]).unwrap();
        p.store.update_quota(ids[1], &serde_json::json!({ "models": [
            { "id": "new-model", "maxTokens": 123_456 }
        ] })).unwrap();
        let catalog = p.model_catalog().unwrap();
        assert!(!catalog.iter().find(|m| m.id == "new-model").unwrap().enabled);
        assert_eq!(p.available_models().unwrap().iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec![models::CLAUDE_OPUS]);
    }

    #[test]
    fn sticky_session_keeps_the_same_account() {
        let (_db, p, ids) = provider_with_accounts(&["a@x", "b@x", "c@x"]);
        p.bind_session("s1", ids[2]);
        for _ in 0..5 {
            assert_eq!(first_candidate(&p, Some("s1")), ids[2]);
        }
        // 绑定的号冷却了就让给别的号，而不是硬等
        p.cool_down(ids[2], "m", 60.0);
        assert_ne!(first_candidate(&p, Some("s1")), ids[2]);
        // 没有会话指纹时照常轮询
        let a = first_candidate(&p, None);
        let b = first_candidate(&p, None);
        assert_ne!(a, b);
    }

    #[test]
    fn rate_limit_cooldown_escalates_by_reason() {
        let (_db, p, ids) = provider_with_accounts(&["a@x"]);
        let id = ids[0];
        let quota: Vec<f64> = (0..5)
            .map(|_| p.rate_limit_cooldown(id, "m", RateLimitKind::QuotaExhausted, None))
            .collect();
        assert_eq!(quota, vec![60.0, 300.0, 1800.0, 7200.0, 7200.0]);
        // 原因变了重新从第一档算
        assert_eq!(p.rate_limit_cooldown(id, "m", RateLimitKind::Capacity, None), 5.0);
        // 上游给了等待时间就以它为准
        assert_eq!(p.rate_limit_cooldown(id, "m", RateLimitKind::Capacity, Some(42.0)), 42.0);
        p.clear_failures(id, "m");
        assert_eq!(p.rate_limit_cooldown(id, "m", RateLimitKind::RateLimited, None), 5.0);
    }

    #[test]
    fn forbidden_cools_account_or_disables_when_banned() {
        let (_db, p, ids) = provider_with_accounts(&["a@x", "b@x"]);
        let accounts = p.store.list().unwrap();
        let url = "https://accounts.google.com/signin/continue?sarp=1&continue=x";
        let validation = UpstreamError {
            status: 403,
            body: format!(r#"{{"error":{{"details":[{{"reason":"VALIDATION_REQUIRED","metadata":{{"validationUrl":"{url}"}}}}]}}}}"#),
        };
        p.handle_forbidden(&accounts[0], &validation);
        // 人工验证不会自愈：不停用、不用冷却，而是退出选号，错误里带上验证地址
        let a = p.store.get(ids[0]).unwrap().unwrap();
        assert!(!a.disabled);
        assert!(a.last_error.as_deref().unwrap().contains(url));
        assert!(!p.is_cooling(ids[0], "m"));
        assert!(p.candidates("m", None).unwrap().iter().all(|c| c.id != ids[0]));

        let banned = UpstreamError {
            status: 403,
            body: "account has been disabled for violation of terms of service".into(),
        };
        p.handle_forbidden(&accounts[1], &banned);
        assert!(p.store.get(ids[1]).unwrap().unwrap().disabled);
        assert!(p.candidates("m", None).is_err());

        // 用户验证完点「刷新」会清掉错误，账号回到候选
        p.store.set_error(ids[0], None).unwrap();
        assert_eq!(p.candidates("m", None).unwrap()[0].id, ids[0]);
        // 其它 403 仍按账号级冷却
        p.handle_forbidden(&accounts[0], &UpstreamError { status: 403, body: "permission denied".into() });
        assert!(p.is_cooling(ids[0], "m"));
        assert!(p.is_cooling(ids[0], "other-model"));
    }

    #[test]
    fn last_used_is_throttled() {
        let (_db, p, ids) = provider_with_accounts(&["a@x"]);
        p.record_used(ids[0]);
        let first = p.store.get(ids[0]).unwrap().unwrap().last_used_ms;
        assert!(first.is_some());
        std::thread::sleep(Duration::from_millis(5));
        p.record_used(ids[0]);
        assert_eq!(p.store.get(ids[0]).unwrap().unwrap().last_used_ms, first);
    }
}
