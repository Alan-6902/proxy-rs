//! Qoder 账号池：PAT 导入、token 续期、选号、冷却、换号 / 换网关重试、模型目录缓存

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use reqwest::{Client, Response};
use serde::Serialize;
use serde_json::Value;

use super::client::{self, FailureKind, UpstreamError};
use super::consts::{
    API_TIMEOUT_SECS, AUTH_COOLDOWN_SECS, AUTO_MODEL, CATALOG_TTL_SECS, DEFAULT_CONTEXT_WINDOW,
    DEFAULT_MAX_OUTPUT, DEFAULT_QUEUE_RETRY_SECS, GATEWAYS, MAX_ACCOUNT_ATTEMPTS, PAT_PREFIX, QUEUE_WAIT_BUDGET_SECS,
    QUEUE_WAIT_MAX_SECS, QUEUE_WAIT_MIN_SECS, QUOTA_COOLDOWN_SECS, QUOTA_REFRESH_SECS, QUOTA_SETTLE_DELAY_SECS,
    RATE_LIMIT_COOLDOWN_SECS, STREAM_READ_IDLE_SECS, TOKEN_CHECK_SECS, TOKEN_REFRESH_SKEW_MS,
    UNAVAILABLE_COOLDOWN_SECS,
};
use super::converter::ModelMeta;
use super::cosy::{Identity, Session};
use super::store::{ModelOverride, ModelOverrides, NewAccount, QoderAccount, QoderAccountView, QoderStore};
use crate::http_client::{ProxyConfig, build_credential_client, build_credential_streaming_client};
use crate::kiro::account_store::now_ms;

const COUNTS_FLUSH_SECS: u64 = 30;
/// 最近使用时间的落盘间隔（与 Antigravity 同口径）
const LAST_USED_FLUSH_SECS: u64 = 60;
/// 目录拉取失败后，这段时间内不再重试，直接用旧目录或报错
const CATALOG_RETRY_BACKOFF_SECS: u64 = 60;
const NO_ACCOUNT_ERROR: &str = "没有可用的 Qoder 账号（全部禁用、冷却中或未添加）";
/// 思考强度的规范顺序（与官方 CLI 一致）；目录里出现的按这个顺序展示
const EFFORT_ORDER: [&str; 7] = ["none", "low", "medium", "high", "xhigh", "max", "ultracode"];
/// 目录条目里列出思考强度的字段名（官方 CLI 依次查找）
const EFFORT_LIST_KEYS: [&str; 14] = [
    "efforts", "reasoning_efforts", "reasoningEfforts", "reasoning_effort_levels", "reasoningEffortLevels",
    "effort_level", "effortLevel", "effort_levels", "effortLevels", "supported_efforts", "supportedEfforts",
    "supported_effort_levels", "supportedEffortLevels", "levels",
];
const THINKING_CONFIG_KEYS: [&str; 2] = ["thinking_config", "thinkingConfig"];
const THINKING_ENABLED_KEYS: [&str; 2] = ["enabled", "enabledConfig"];
/// 目录没给档位时官方 CLI 的兜底档位（不超过 max_input_tokens）
const FALLBACK_WINDOWS: [i64; 2] = [128_000, 200_000];
const MAX_ALIAS_CHARS: usize = 64;

/// 请求失败时返回给客户端的错误
#[derive(Debug, Clone, PartialEq)]
pub struct QoderError {
    pub status: u16,
    pub message: String,
    /// 来自上游时的失败分类，决定冷却时长；本地错误为 None
    pub kind: Option<FailureKind>,
    pub retry_after_secs: Option<u64>,
}

impl QoderError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self { status, message: message.into(), kind: None, retry_after_secs: None }
    }

    /// 冷却时长：上游错误按分类，本地错误（存储等）按凭证问题处理
    fn cooldown(&self) -> Duration {
        match self.kind {
            Some(kind) => cooldown_for(kind, self.retry_after_secs),
            None => Duration::from_secs(AUTH_COOLDOWN_SECS),
        }
    }
}

/// 排队等待时长：上游给的 retryAfterSeconds 钳在 [QUEUE_WAIT_MIN_SECS, QUEUE_WAIT_MAX_SECS]，没给按默认
pub fn queue_wait(retry_after_secs: Option<u64>) -> Duration {
    Duration::from_secs(retry_after_secs.unwrap_or(DEFAULT_QUEUE_RETRY_SECS).clamp(QUEUE_WAIT_MIN_SECS, QUEUE_WAIT_MAX_SECS))
}

/// 一次请求的排队预算：HTTP 层（[`QoderProvider::open_chat`]）与信封层（首包前）的排队等待共用
pub struct QueueBudget {
    started: Instant,
    deadline: Instant,
}

impl Default for QueueBudget {
    fn default() -> Self {
        Self::new()
    }
}

impl QueueBudget {
    pub fn new() -> Self {
        let started = Instant::now();
        Self { started, deadline: started + Duration::from_secs(QUEUE_WAIT_BUDGET_SECS) }
    }

    /// 按上游建议等待后返回 Ok，调用方同号重发；预算不够时不再等，
    /// 返回 503 + Retry-After 让客户端自己退避（排队不是账号问题，不冷却）
    pub async fn wait(&self, e: &QoderError) -> Result<(), QoderError> {
        let wait = queue_wait(e.retry_after_secs);
        if Instant::now() + wait > self.deadline {
            return Err(QoderError {
                status: 503,
                message: format!("{}；本次已在队列等待约 {}s，不再等待", e.message, self.started.elapsed().as_secs()),
                kind: e.kind,
                retry_after_secs: Some(wait.as_secs()),
            });
        }
        tracing::info!("Qoder 上游排队，{}s 后同号重试：{}", wait.as_secs(), e.message);
        tokio::time::sleep(wait).await;
        Ok(())
    }
}

impl std::fmt::Display for QoderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<UpstreamError> for QoderError {
    fn from(e: UpstreamError) -> Self {
        // 上游凭证失效不能回 401：客户端会误以为是自己的 apiKey 无效；401 只留给本地鉴权
        let status = match e.kind {
            FailureKind::Quota | FailureKind::RateLimit => 429,
            // 排队按过载处理：503 + Retry-After，客户端会退避而不是换 Key
            FailureKind::Queued => 503,
            FailureKind::InvalidRequest => 400,
            FailureKind::Auth | FailureKind::ClientTooOld | FailureKind::Unavailable => 502,
        };
        Self { status, message: e.to_string(), kind: Some(e.kind), retry_after_secs: e.retry_after_secs }
    }
}

/// 管理与公开接口共用的模型规格
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    /// 上游 key
    pub id: String,
    pub display_name: String,
    /// 实际生效的上下文窗口（覆盖值优先，其次上游默认）
    pub context_window: i32,
    pub max_output: i32,
    pub is_reasoning: bool,
    pub enabled: bool,
    /// 对外模型名：配了别名用别名，否则同 id
    pub public_id: String,
    /// 上游支持的上下文档位（升序）
    pub context_windows: Vec<i64>,
    /// 上游默认上下文窗口
    pub default_context_window: Option<i64>,
    /// 上游支持的思考强度（含 none 表示可关闭）
    pub efforts: Vec<String>,
    pub default_effort: Option<String>,
    /// 上游用量倍率；缺失时不猜测价格，0 是有效值
    pub price_factor: Option<f64>,
    pub original_price_factor: Option<f64>,
    pub is_free: bool,
    /// 管理页保存的配置
    #[serde(rename = "override")]
    pub override_: ModelOverride,
}

/// 选中的账号与为它签好的会话
pub struct Lease {
    pub account: Arc<QoderAccount>,
    pub session: Arc<Session>,
    /// 签这个会话用的 token（上游拒绝时用来判断是否已被别人换过）
    pub token: String,
}

/// 一次成功打开的上游流
pub struct OpenedChat {
    pub response: Response,
    pub account_id: i64,
    pub model: ModelMeta,
}

struct CachedSession {
    token: String,
    session: Arc<Session>,
}

pub struct QoderProvider {
    store: Arc<QoderStore>,
    api_client: Client,
    stream_client: Client,
    cooldowns: Mutex<HashMap<i64, Instant>>,
    last_used_flushed: Mutex<HashMap<i64, Instant>>,
    sessions: Mutex<HashMap<i64, CachedSession>>,
    refresh_locks: Mutex<HashMap<i64, Arc<tokio::sync::Mutex<()>>>>,
    /// (过期时刻, 目录)
    catalog: Mutex<Option<(Instant, Arc<Vec<Value>>)>>,
    catalog_lock: tokio::sync::Mutex<()>,
    /// 上次目录拉取失败的时刻，用于失败退避
    catalog_failed_at: Mutex<Option<Instant>>,
    /// 上一次成功的网关下标，下次从它开始试
    gateway: AtomicUsize,
    cursor: AtomicUsize,
    tasks: Mutex<super::task::TaskTracker>,
    /// 刚结束过请求、等着拉额度的账号；非空表示已有一个延时任务在等
    quota_dirty: Mutex<HashSet<i64>>,
}

fn str_field(v: &Value, keys: &[&str]) -> String {
    keys.iter().find_map(|k| v[*k].as_str().map(str::trim).filter(|s| !s.is_empty()))
        .unwrap_or_default().to_string()
}

/// 目录条目的路由 key
fn entry_key(e: &Value) -> String {
    str_field(e, &["key", "mapped_key", "native_model", "id"])
}

fn entry_usable(e: &Value) -> bool {
    !entry_key(e).is_empty() && e["enable"].as_bool().unwrap_or(true)
}

fn entry_int(e: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter().find_map(|k| e[*k].as_i64().filter(|n| *n > 0))
}

/// 去重、过滤非法值后的思考强度列表，按规范顺序
fn normalize_efforts<'a>(names: impl Iterator<Item = &'a str>) -> Vec<String> {
    let names: Vec<String> = names.map(|n| n.trim().to_ascii_lowercase()).collect();
    EFFORT_ORDER.iter().filter(|e| names.iter().any(|n| n == *e)).map(|e| e.to_string()).collect()
}

/// 一个字段里的强度列表与默认值：数组、逗号/空格分隔字符串、或 `{ "high": { "is_default": true } }`
fn efforts_in(v: &Value) -> Option<(Vec<String>, Option<String>)> {
    let (list, default) = match v {
        Value::Array(items) => (normalize_efforts(items.iter().filter_map(Value::as_str)), None),
        Value::String(s) => (normalize_efforts(s.split([',', ' '])), None),
        Value::Object(map) => {
            let default = map.iter().find(|(_, c)| c["is_default"] == true || c["isDefault"] == true)
                .map(|(k, _)| k.to_ascii_lowercase());
            (normalize_efforts(map.keys().map(String::as_str)), default)
        }
        _ => return None,
    };
    (!list.is_empty()).then_some((list, default))
}

fn efforts_of_object(o: &Value) -> Option<(Vec<String>, Option<String>)> {
    EFFORT_LIST_KEYS.iter().find_map(|k| efforts_in(&o[*k]))
}

/// 模型支持的思考强度与默认强度，解析方式对齐官方 CLI：
/// 顶层列表 → thinking_config 里的列表 → thinking_config.enabled 里的列表；
/// thinking_config.disabled 存在或 supports_disabled 为真表示可关闭（加 none）
fn model_efforts(e: &Value) -> (Vec<String>, Option<String>) {
    let configs = || THINKING_CONFIG_KEYS.iter().map(|k| &e[*k]).filter(|c| c.is_object());
    let can_disable = e["supports_disabled"] == true || e["supportsDisabled"] == true
        || configs().any(|c| !c["disabled"].is_null() && c["disabled"] != false);
    let found = efforts_of_object(e).or_else(|| configs().find_map(|c| efforts_of_object(c)
        .or_else(|| THINKING_ENABLED_KEYS.iter().map(|k| &c[*k]).find_map(efforts_of_object))));
    let (mut list, mut default) = found.unwrap_or_default();
    if can_disable && !list.iter().any(|x| x == "none") {
        list.insert(0, "none".to_string());
    }
    for key in ["default_effort", "defaultEffort"] {
        if let Some(d) = e[key].as_str().map(str::to_ascii_lowercase).filter(|d| list.contains(d)) {
            default = Some(d);
        }
    }
    let default = default.filter(|d| list.contains(d));
    (list, default)
}

/// 模型支持的上下文档位（升序）与默认档位，对齐官方 CLI：
/// context_config 里的 token_count → available_context_windows → 按 max_input_tokens 兜底
fn model_windows(e: &Value) -> (Vec<i64>, Option<i64>) {
    let positive = |v: &Value| v.as_i64().filter(|n| *n > 0);
    let mut windows = Vec::new();
    let mut default = None;
    for config in ["context_config", "contextConfig"].iter().filter_map(|k| e[*k].as_object()) {
        for c in config.values() {
            if let Some(n) = positive(&c["token_count"]) {
                if !windows.contains(&n) { windows.push(n); }
                if c["is_default"] == true || c["is_default"] == 1 || c["is_default"] == "1" { default = Some(n); }
            }
        }
    }
    if windows.is_empty() {
        for key in ["available_context_windows", "availableContextWindows"] {
            for n in e[key].as_array().into_iter().flatten().filter_map(positive) {
                if !windows.contains(&n) { windows.push(n); }
            }
        }
    }
    let max_input = entry_int(e, &["max_input_tokens", "maxInputTokens"]);
    if windows.is_empty() && let Some(max) = max_input {
        windows = FALLBACK_WINDOWS.into_iter().chain([max]).filter(|n| *n <= max).collect();
        windows.dedup();
    }
    windows.sort_unstable();
    windows.dedup();
    let default = default.or_else(|| entry_int(e, &["default_context_window", "defaultContextWindow"]))
        .filter(|d| windows.contains(d))
        .or(max_input.filter(|m| windows.contains(m)))
        .or_else(|| windows.last().copied());
    (windows, default)
}

fn to_meta(e: &Value, o: Option<&ModelOverride>) -> ModelMeta {
    let key = entry_key(e);
    let (windows, default_window) = model_windows(e);
    let (efforts, default_effort) = model_efforts(e);
    let context_window = o.and_then(|o| o.context_window).filter(|w| windows.contains(w));
    ModelMeta {
        display_name: { let d = str_field(e, &["display_name", "name"]); if d.is_empty() { key.clone() } else { d } },
        key,
        is_vl: e["is_vl"].as_bool().unwrap_or(true),
        is_reasoning: e["is_reasoning"].as_bool().unwrap_or(false),
        // 模型能力与本次窗口独立；不得用管理页选择覆盖上游模型配置。
        max_input_tokens: entry_int(e, &["max_input_tokens"]),
        context_window,
        effort: o.and_then(|o| o.effort.clone()).filter(|x| efforts.contains(x)),
        raw_config: e.clone(), context_windows: windows,
        default_context_window: default_window, efforts, default_effort,
    }
}

/// 匹配顺序：别名（忽略大小写）→ 上游 key 精确 → display_name / id 忽略大小写
pub fn find_model(entries: &[Value], overrides: &ModelOverrides, wanted: &str) -> Option<ModelMeta> {
    let wanted = wanted.trim();
    let usable = || entries.iter().filter(|e| entry_usable(e));
    let by_alias = || usable().find(|e| overrides.get(&entry_key(e))
        .and_then(|o| o.alias.as_deref()).is_some_and(|a| a.eq_ignore_ascii_case(wanted)));
    by_alias()
        .or_else(|| usable().find(|e| entry_key(e) == wanted))
        .or_else(|| usable().find(|e| ["display_name", "id", "name", "mapped_key"].iter()
            .any(|k| e[*k].as_str().is_some_and(|s| s.trim().eq_ignore_ascii_case(wanted)))))
        .map(|e| to_meta(e, overrides.get(&entry_key(e))))
}

/// 校验并规整管理页提交的配置：别名不能与其它模型的名字冲突，档位和强度必须是该模型支持的
pub fn validate_overrides(entries: &[Value], input: &ModelOverrides) -> Result<ModelOverrides, String> {
    let usable: Vec<&Value> = entries.iter().filter(|e| entry_usable(e)).collect();
    let mut out = ModelOverrides::new();
    let mut taken: Vec<(String, String)> = Vec::new();
    for (key, o) in input {
        let Some(e) = usable.iter().find(|e| entry_key(e) == *key) else {
            return Err(format!("模型不在当前目录中: {key}"));
        };
        let alias = o.alias.as_deref().map(str::trim).filter(|a| !a.is_empty() && a != key);
        if let Some(a) = alias {
            if a.chars().count() > MAX_ALIAS_CHARS || a.chars().any(|c| c.is_whitespace() || c.is_control()) {
                return Err(format!("{key} 的别名不能含空白，且不超过 {MAX_ALIAS_CHARS} 个字符"));
            }
            let clash = usable.iter().find(|other| entry_key(other) != *key
                && (entry_key(other).eq_ignore_ascii_case(a)
                    || other["display_name"].as_str().is_some_and(|d| d.trim().eq_ignore_ascii_case(a))));
            if let Some(other) = clash {
                return Err(format!("别名 {a} 与模型 {} 重名", entry_key(other)));
            }
            if let Some((owner, _)) = taken.iter().find(|(_, t)| t.eq_ignore_ascii_case(a)) {
                return Err(format!("别名 {a} 已被 {owner} 使用"));
            }
            taken.push((key.clone(), a.to_string()));
        }
        let (windows, _) = model_windows(e);
        if let Some(w) = o.context_window && !windows.contains(&w) {
            return Err(format!("{key} 不支持上下文 {w}，可选 {windows:?}"));
        }
        let (efforts, _) = model_efforts(e);
        let effort = o.effort.as_deref().map(|x| x.trim().to_ascii_lowercase()).filter(|x| !x.is_empty());
        if let Some(x) = &effort && !efforts.contains(x) {
            return Err(format!("{key} 不支持思考强度 {x}，可选 {efforts:?}"));
        }
        let normalized = ModelOverride { alias: alias.map(str::to_string), context_window: o.context_window, effort };
        if !normalized.is_empty() {
            out.insert(key.clone(), normalized);
        }
    }
    Ok(out)
}

/// 倍率支持上游数字和数字字符串，保留零值，拒绝负数和非有限值。
fn price_factor(e: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|key| {
        e[*key].as_f64().or_else(|| e[*key].as_str()?.trim().parse().ok())
            .filter(|n| n.is_finite() && *n >= 0.0)
    })
}

fn catalog_model(e: &Value, enabled: bool, o: Option<&ModelOverride>) -> CatalogModel {
    let meta = to_meta(e, o);
    let (windows, default_window) = model_windows(e);
    let (efforts, default_effort) = model_efforts(e);
    let context = meta.context_window.or(default_window)
        .or_else(|| entry_int(e, &["context_length"]))
        .map(|n| n.min(i32::MAX as i64) as i32).unwrap_or(DEFAULT_CONTEXT_WINDOW);
    let output = entry_int(e, &["max_output_tokens"]).map(|n| n.min(i32::MAX as i64) as i32).unwrap_or(DEFAULT_MAX_OUTPUT);
    let override_ = o.cloned().unwrap_or_default();
    CatalogModel {
        public_id: override_.alias.clone().unwrap_or_else(|| meta.key.clone()),
        id: meta.key, display_name: meta.display_name, context_window: context, max_output: output,
        is_reasoning: meta.is_reasoning || efforts.iter().any(|x| x != "none"), enabled,
        context_windows: windows, default_context_window: default_window, efforts, default_effort, override_,
        price_factor: price_factor(e, &["price_factor", "priceFactor"]),
        original_price_factor: price_factor(e, &["original_price_factor", "originPriceFactor"]),
        is_free: e["is_free"].as_bool().or(e["isFree"].as_bool()).unwrap_or(false),
    }
}

fn identity_of(a: &QoderAccount, token: &str) -> Identity {
    Identity {
        uid: a.uid.clone(),
        name: a.name.clone().unwrap_or_default(),
        access_token: token.to_string(),
    }
}

/// 进程内第一次拉到目录时记一行各模型解析出的档位与强度（只有字段名和数值，不含凭证）
fn log_catalog_shape(entries: &[Value]) {
    static LOGGED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    LOGGED.get_or_init(|| {
        let keys: std::collections::BTreeSet<&str> = entries.iter()
            .filter_map(Value::as_object).flat_map(|o| o.keys().map(String::as_str)).collect();
        let parsed: Vec<String> = entries.iter().filter(|e| entry_usable(e)).map(|e| {
            let ((w, _), (x, _)) = (model_windows(e), model_efforts(e));
            format!("{}={w:?}/{x:?}", entry_key(e))
        }).collect();
        tracing::info!("Qoder 模型目录字段: {keys:?}；档位/强度: {}", parsed.join(" "));
    });
}

fn cooldown_for(kind: FailureKind, retry_after_secs: Option<u64>) -> Duration {
    Duration::from_secs(match kind {
        FailureKind::Quota => QUOTA_COOLDOWN_SECS,
        FailureKind::Auth => AUTH_COOLDOWN_SECS,
        // 排队本不该冷却账号（见 QueueBudget）；真走到这里也只按上游建议的时长
        FailureKind::RateLimit | FailureKind::Queued => retry_after_secs.unwrap_or(RATE_LIMIT_COOLDOWN_SECS),
        _ => UNAVAILABLE_COOLDOWN_SECS,
    })
}

impl QoderProvider {
    /// 上游客户端固定 rustls + 内置根证书 + 仅 https + 不跟随重定向，不受 tlsBackend 配置影响
    pub fn new(store: Arc<QoderStore>, proxy: Option<&ProxyConfig>) -> anyhow::Result<Self> {
        Ok(Self {
            store,
            api_client: build_credential_client(proxy, API_TIMEOUT_SECS)?,
            stream_client: build_credential_streaming_client(proxy, STREAM_READ_IDLE_SECS)?,
            cooldowns: Mutex::new(HashMap::new()),
            last_used_flushed: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            refresh_locks: Mutex::new(HashMap::new()),
            catalog: Mutex::new(None),
            catalog_lock: tokio::sync::Mutex::new(()),
            catalog_failed_at: Mutex::new(None),
            gateway: AtomicUsize::new(0),
            cursor: AtomicUsize::new(0),
            tasks: Mutex::new(super::task::TaskTracker::default()),
            quota_dirty: Mutex::new(HashSet::new()),
        })
    }

pub fn task_for(&self, session: &str, chat: &Value) -> super::converter::TaskContext {
        self.tasks.lock().get(session, chat)
    }

    pub fn task_answered(&self, task_id: &str) {
        self.tasks.lock().mark_answered(task_id);
    }

    pub fn store(&self) -> &QoderStore {
        &self.store
    }

    pub fn start_background_tasks(self: &Arc<Self>) {
        let this = self.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(QUOTA_REFRESH_SECS));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                this.refresh_all_quotas().await;
            }
        });
        // 定时续期快过期的 token：长时间不用的账号也不会因 refresh token 过期而失效
        let this = self.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(TOKEN_CHECK_SECS));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                let Ok(accounts) = this.store.snapshot() else { continue };
                for a in accounts.iter().filter(|a| !a.disabled) {
                    if let Err(e) = this.ensure_token(a, false).await {
                        tracing::warn!("Qoder 账号 #{} 定时续期失败: {e}", a.id);
                    }
                }
            }
        });
        let this = self.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(COUNTS_FLUSH_SECS));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                let store = this.store.clone();
                match tokio::task::spawn_blocking(move || store.flush_counts()).await {
                    Ok(Err(e)) => tracing::warn!("Qoder 计数落盘失败，下次重试: {e}"),
                    Err(e) => tracing::warn!("Qoder 计数落盘任务异常: {e}"),
                    _ => {}
                }
            }
        });
    }

    pub fn flush_counts(&self) {
        if let Err(e) = self.store.flush_counts() {
            tracing::warn!("Qoder 退出前计数落盘失败: {e}");
        }
    }

    pub fn accounts(&self) -> anyhow::Result<Vec<QoderAccountView>> {
        Ok(self.store.list()?.iter().map(QoderAccountView::from).collect())
    }

    /// 粘贴 PAT 添加账号：换证 → 拉身份 → 入库 → 顺手拉一次额度
    pub async fn add_pat(&self, pat: &str) -> Result<QoderAccountView, QoderError> {
        let pat = pat.trim();
        if !pat.starts_with(PAT_PREFIX) {
            return Err(QoderError::new(400, format!("PAT 必须以 {PAT_PREFIX} 开头")));
        }
        let job = client::exchange_pat(&self.api_client, pat).await?;
        let info = client::fetch_userinfo(&self.api_client, &job.token).await?;
        let id = self.store.upsert(&NewAccount {
            uid: &info.uid,
            name: info.name.as_deref(),
            email: info.email.as_deref(),
            pat,
            access_token: &job.token,
            refresh_token: job.refresh_token.as_deref(),
            expires_at_ms: job.expires_at_ms,
            user_type: info.user_type.as_deref(),
            org_id: info.org_id.as_deref(),
            org_name: info.org_name.as_deref(),
        }).map_err(|e| QoderError::new(500, e.to_string()))?;
        self.sessions.lock().remove(&id);
        self.cooldowns.lock().remove(&id);
        if let Ok(quota) = client::fetch_quota(&self.api_client, &job.token).await {
            let _ = self.store.update_quota(id, &quota);
        }
        self.invalidate_catalog();
        tracing::info!("Qoder 账号已添加 #{id}");
        self.view(id)
    }

    fn view(&self, id: i64) -> Result<QoderAccountView, QoderError> {
        match self.store.get(id) {
            Ok(Some(a)) => Ok(QoderAccountView::from(&a)),
            Ok(None) => Err(QoderError::new(404, format!("账号不存在: {id}"))),
            Err(e) => Err(QoderError::new(500, e.to_string())),
        }
    }

    /// 管理页「刷新」：强制续期并拉额度
    pub async fn refresh_account(&self, id: i64) -> Result<QoderAccountView, QoderError> {
        let account = self.view_account(id)?;
        let token = self.ensure_token(&account, true).await?;
        let quota = client::fetch_quota(&self.api_client, &token).await?;
        self.store.update_quota(id, &quota).map_err(|e| QoderError::new(500, e.to_string()))?;
        self.cooldowns.lock().remove(&id);
        self.view(id)
    }

    fn view_account(&self, id: i64) -> Result<QoderAccount, QoderError> {
        match self.store.get(id) {
            Ok(Some(a)) => Ok(a),
            Ok(None) => Err(QoderError::new(404, format!("账号不存在: {id}"))),
            Err(e) => Err(QoderError::new(500, e.to_string())),
        }
    }

    pub fn set_disabled(&self, id: i64, disabled: bool) -> anyhow::Result<bool> {
        let changed = self.store.set_disabled(id, disabled)?;
        if !disabled {
            self.cooldowns.lock().remove(&id);
        }
        self.invalidate_catalog();
        Ok(changed)
    }

    pub fn delete(&self, id: i64) -> anyhow::Result<bool> {
        self.sessions.lock().remove(&id);
        self.cooldowns.lock().remove(&id);
        self.invalidate_catalog();
        self.store.delete(id)
    }

    async fn refresh_all_quotas(&self) {
        let Ok(accounts) = self.store.snapshot() else { return };
        for a in accounts.iter().filter(|a| !a.disabled) {
            if let Err(e) = self.refresh_quota(a).await {
                tracing::warn!("定时刷新 Qoder 额度失败 #{}: {}", a.id, e.message);
            }
        }
    }

    /// 用现有 token 拉一次额度并入库（累计消耗在 store 里顺带更新）
    async fn refresh_quota(&self, account: &QoderAccount) -> Result<(), QoderError> {
        let token = self.ensure_token(account, false).await?;
        let quota = client::fetch_quota(&self.api_client, &token).await?;
        self.store.update_quota(account.id, &quota).map_err(|e| QoderError::new(500, e.to_string()))
    }

    /// 请求结束后延时拉额度，让累计消耗跟上实际用量；延时窗口内结束的请求只拉一次。
    /// 可能从 Drop 里被调到，所以不在运行时里（如同步测试）时静默跳过，不 panic
    fn schedule_quota_refresh(self: &Arc<Self>, account_id: i64) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else { return };
        let mut dirty = self.quota_dirty.lock();
        let waiting = !dirty.is_empty();
        dirty.insert(account_id);
        drop(dirty);
        if waiting {
            return;
        }
        let this = self.clone();
        runtime.spawn(async move {
            tokio::time::sleep(Duration::from_secs(QUOTA_SETTLE_DELAY_SECS)).await;
            let ids = std::mem::take(&mut *this.quota_dirty.lock());
            let Ok(accounts) = this.store.snapshot() else { return };
            for a in accounts.iter().filter(|a| ids.contains(&a.id)) {
                if let Err(e) = this.refresh_quota(a).await {
                    tracing::warn!("请求后刷新 Qoder 额度失败 #{}: {}", a.id, e.message);
                }
            }
        });
    }

    fn refresh_lock(&self, id: i64) -> Arc<tokio::sync::Mutex<()>> {
        self.refresh_locks.lock().entry(id).or_default().clone()
    }

    /// 拿可用 token：未过期直接用；否则 refresh token 续期，失败再用 PAT 重新换证
    async fn ensure_token(&self, account: &QoderAccount, force: bool) -> Result<String, QoderError> {
        self.ensure_token_inner(account, force, None).await
    }

    /// `rejected`：刚被上游拒绝的 token。强制续期拿到锁后，库里已换成别的未过期 token
    /// 就直接用，避免并发 401 时对同一账号重复续期
    async fn ensure_token_inner(&self, account: &QoderAccount, force: bool, rejected: Option<&str>)
        -> Result<String, QoderError> {
        let fresh = |a: &QoderAccount| a.access_token.clone().filter(|_| {
            a.expires_at_ms.is_some_and(|exp| exp - TOKEN_REFRESH_SKEW_MS > now_ms())
        });
        if !force && let Some(token) = fresh(account) {
            return Ok(token);
        }
        let lock = self.refresh_lock(account.id);
        let _guard = lock.lock().await;
        // 等锁期间别的请求可能已经刷新过
        let latest = self.store.get(account.id).ok().flatten().unwrap_or_else(|| account.clone());
        if let Some(token) = fresh(&latest).filter(|t| !force || rejected.is_some_and(|r| r != t)) {
            return Ok(token);
        }
        let mut result = match latest.refresh_token.as_deref().filter(|t| !t.is_empty()) {
            Some(rt) => client::refresh_token(&self.api_client, rt).await,
            None => Err(UpstreamError { kind: FailureKind::Auth, status: 401, message: "没有 refresh token".into(), retry_after_secs: None }),
        };
        if let Err(e) = &result {
            tracing::info!("Qoder 账号 #{} refresh 失败（{}），改用 PAT 重新换证", account.id, e.message);
            result = client::exchange_pat(&self.api_client, &latest.pat).await;
        }
        match result {
            Ok(job) => {
                self.store.update_tokens(account.id, &job.token, job.refresh_token.as_deref(), job.expires_at_ms)
                    .map_err(|e| QoderError::new(500, e.to_string()))?;
                self.sessions.lock().remove(&account.id);
                Ok(job.token)
            }
            Err(e) => {
                let _ = self.store.set_error(account.id, Some(&format!("续期失败: {}", e.message)));
                Err(e.into())
            }
        }
    }

    /// 账号的签名会话；token 变了就重建
    async fn lease(&self, account: Arc<QoderAccount>, force: bool) -> Result<Lease, QoderError> {
        let token = self.ensure_token(&account, force).await?;
        self.lease_with_token(account, token)
    }

    /// 上游拒绝 `rejected` 后强制续期（别的请求已换过就复用）
    async fn lease_after_auth_failure(&self, account: Arc<QoderAccount>, rejected: &str) -> Result<Lease, QoderError> {
        let token = self.ensure_token_inner(&account, true, Some(rejected)).await?;
        self.lease_with_token(account, token)
    }

    fn lease_with_token(&self, account: Arc<QoderAccount>, token: String) -> Result<Lease, QoderError> {
        if let Some(cached) = self.sessions.lock().get(&account.id).filter(|c| c.token == token) {
            return Ok(Lease { account, session: cached.session.clone(), token });
        }
        let session = Arc::new(Session::new(&identity_of(&account, &token)).map_err(|e| QoderError::new(500, e.to_string()))?);
        self.sessions.lock().insert(account.id, CachedSession { token: token.clone(), session: session.clone() });
        Ok(Lease { account, session, token })
    }

    /// 可用账号，按轮询顺序；排除冷却中和本次已试过的
    fn candidates(&self, tried: &[i64]) -> Result<Vec<Arc<QoderAccount>>, QoderError> {
        let accounts = self.store.snapshot().map_err(|e| QoderError::new(500, e.to_string()))?;
        let now = Instant::now();
        let cooldowns = self.cooldowns.lock();
        let mut list: Vec<Arc<QoderAccount>> = accounts.iter()
            .filter(|a| !a.disabled && !tried.contains(&a.id))
            .filter(|a| cooldowns.get(&a.id).is_none_or(|until| *until <= now))
            .cloned()
            .collect();
        if !list.is_empty() {
            let start = self.cursor.fetch_add(1, Ordering::Relaxed) % list.len();
            list.rotate_left(start);
        }
        Ok(list)
    }

    /// last_used_ms 每个账号最多每 LAST_USED_FLUSH_SECS 写一次库：写库会 fsync 并让快照失效，
    /// 不能每个请求都做
    fn touch_used_throttled(&self, id: i64) {
        let due = {
            let mut flushed = self.last_used_flushed.lock();
            let due = flushed.get(&id).is_none_or(|t| t.elapsed() >= Duration::from_secs(LAST_USED_FLUSH_SECS));
            if due {
                flushed.insert(id, Instant::now());
            }
            due
        };
        if due && let Err(e) = self.store.touch_used(id) {
            tracing::warn!("Qoder 账号 #{id} 最近使用时间写入失败: {e}");
        }
    }

    fn cool_down(&self, id: i64, e: &QoderError) {
        let secs = e.cooldown();
        self.cooldowns.lock().insert(id, Instant::now() + secs);
        let _ = self.store.set_error(id, Some(&e.message));
        tracing::warn!("Qoder 账号 #{id} 冷却 {}s: {}", secs.as_secs(), e.message);
    }

    /// 账号变动后让目录尽快重拉：只标记过期、保留旧数据，并清掉失败退避
    fn invalidate_catalog(&self) {
        if let Some((expires, _)) = self.catalog.lock().as_mut() {
            *expires = Instant::now();
        }
        *self.catalog_failed_at.lock() = None;
    }

    /// 网关候选，从上次成功的那个开始
    fn gateways(&self) -> Vec<&'static str> {
        let start = self.gateway.load(Ordering::Relaxed) % GATEWAYS.len();
        GATEWAYS.iter().cycle().skip(start).take(GATEWAYS.len()).copied().collect()
    }

    /// 模型目录（缓存 10 分钟）；用第一个能用的账号拉取
    ///
    /// 过期但有旧目录时：已有刷新在进行就直接用旧的，不排队等网络。
    /// 拉取失败后 CATALOG_RETRY_BACKOFF_SECS 内不再重试。
    pub async fn catalog_entries(&self) -> Result<Arc<Vec<Value>>, QoderError> {
        let (fresh, stale) = {
            let c = self.catalog.lock();
            let fresh = c.as_ref().filter(|(expires, _)| Instant::now() < *expires).map(|(_, v)| v.clone());
            (fresh, c.as_ref().map(|(_, v)| v.clone()))
        };
        if let Some(v) = fresh {
            return Ok(v);
        }
        let backing_off = self.catalog_failed_at.lock()
            .is_some_and(|at| at.elapsed() < Duration::from_secs(CATALOG_RETRY_BACKOFF_SECS));
        if backing_off {
            return stale.ok_or_else(|| QoderError::new(503, "Qoder 模型目录暂不可用，稍后自动重试"));
        }
        let _guard = match (self.catalog_lock.try_lock(), &stale) {
            (Ok(guard), _) => guard,
            // 别人正在刷新：有旧目录就先用
            (Err(_), Some(v)) => return Ok(v.clone()),
            (Err(_), None) => self.catalog_lock.lock().await,
        };
        if let Some(v) = self.catalog.lock().as_ref()
            .filter(|(expires, _)| Instant::now() < *expires).map(|(_, v)| v.clone()) {
            return Ok(v);
        }
        let mut last = QoderError::new(503, NO_ACCOUNT_ERROR);
        for account in self.candidates(&[])?.into_iter().take(MAX_ACCOUNT_ATTEMPTS) {
            let lease = match self.lease(account, false).await {
                Ok(l) => l,
                Err(e) => { last = e; continue; }
            };
            for (i, gw) in self.gateways().into_iter().enumerate() {
                match client::fetch_models(&self.api_client, &lease.session, gw).await {
                    Ok(entries) if !entries.is_empty() => {
                        self.note_gateway(gw, i);
                        log_catalog_shape(&entries);
                        let entries = Arc::new(entries);
                        *self.catalog.lock() = Some((Instant::now() + Duration::from_secs(CATALOG_TTL_SECS), entries.clone()));
                        *self.catalog_failed_at.lock() = None;
                        return Ok(entries);
                    }
                    Ok(_) => last = QoderError::new(502, "上游模型目录为空"),
                    Err(e) if e.kind == FailureKind::Unavailable => { last = e.into(); continue; }
                    Err(e) => { last = e.into(); break; }
                }
            }
        }
        *self.catalog_failed_at.lock() = Some(Instant::now());
        // 拉不到新目录时沿用过期的旧目录
        if let Some((_, v)) = self.catalog.lock().as_ref() {
            return Ok(v.clone());
        }
        Err(last)
    }

    fn note_gateway(&self, gw: &str, offset: usize) {
        if offset > 0 && let Some(i) = GATEWAYS.iter().position(|g| *g == gw) {
            self.gateway.store(i, Ordering::Relaxed);
            tracing::info!("Qoder 推理网关切换到 {gw}");
        }
    }

    /// 管理页目录：全部可用模型并标出勾选状态
    pub async fn model_catalog(&self) -> Result<Vec<CatalogModel>, QoderError> {
        let entries = self.catalog_entries().await?;
        let enabled = self.store.enabled_model_ids().map_err(|e| QoderError::new(500, e.to_string()))?;
        let overrides = self.store.model_overrides().map_err(|e| QoderError::new(500, e.to_string()))?;
        Ok(entries.iter().filter(|e| entry_usable(e))
            .map(|e| {
                let key = entry_key(e);
                catalog_model(e, enabled.as_ref().is_none_or(|ids| ids.contains(&key)), overrides.get(&key))
            })
            .collect())
    }

    /// 公开 /v1/models：只输出勾选的模型；上游拉不到目录时至少给出 auto
    pub async fn public_models(&self) -> Vec<CatalogModel> {
        match self.model_catalog().await {
            Ok(models) => models.into_iter().filter(|m| m.enabled).collect(),
            Err(e) => {
                tracing::warn!("Qoder 模型目录不可用: {}", e.message);
                vec![CatalogModel {
                    id: AUTO_MODEL.to_string(), display_name: "Auto".to_string(),
                    context_window: DEFAULT_CONTEXT_WINDOW, max_output: DEFAULT_MAX_OUTPUT,
                    is_reasoning: false, enabled: true, public_id: AUTO_MODEL.to_string(),
                    context_windows: Vec::new(), default_context_window: None, efforts: Vec::new(),
                    default_effort: None, override_: ModelOverride::default(),
                    price_factor: None, original_price_factor: None, is_free: false,
                }]
            }
        }
    }

    pub async fn save_model_selection(&self, ids: &[String]) -> Result<(), QoderError> {
        let entries = self.catalog_entries().await?;
        if let Some(bad) = ids.iter().find(|id| !entries.iter().any(|e| entry_usable(e) && entry_key(e) == **id)) {
            return Err(QoderError::new(400, format!("模型不在当前目录中: {bad}")));
        }
        self.store.set_enabled_model_ids(ids).map_err(|e| QoderError::new(500, e.to_string()))
    }

    /// 保存别名 / 上下文 / 思考强度配置（整体覆盖）
    pub async fn save_model_overrides(&self, input: &ModelOverrides) -> Result<(), QoderError> {
        let entries = self.catalog_entries().await?;
        let overrides = validate_overrides(&entries, input).map_err(|e| QoderError::new(400, e))?;
        self.store.set_model_overrides(&overrides).map_err(|e| QoderError::new(500, e.to_string()))
    }

    /// 把请求的模型名解析成目录条目；目录拉不到时按原名发送
    pub async fn resolve_model(&self, wanted: &str) -> Result<ModelMeta, QoderError> {
        let fallback = ModelMeta {
            key: wanted.to_string(), display_name: wanted.to_string(), is_vl: true, ..Default::default()
        };
        let entries = match self.catalog_entries().await {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!("Qoder 模型目录不可用，按原名 {wanted} 发送: {}", e.message);
                return Ok(fallback);
            }
        };
        let overrides = self.store.model_overrides().map_err(|e| QoderError::new(500, e.to_string()))?;
        if let Some(meta) = find_model(&entries, &overrides, wanted) {
            return Ok(meta);
        }
        if wanted.eq_ignore_ascii_case(AUTO_MODEL) {
            return Ok(fallback);
        }
        Err(QoderError::new(400, format!("Qoder 模型目录里没有 {wanted}")))
    }

    /// 选号发起推理：认证失败先强制续期重试同号，限流 / 额度 / 网络换号，网络错误先换网关；
    /// 上游排队在 `budget` 内等完同号同网关重发，不算账号失败
    pub async fn open_chat(&self, model: ModelMeta, build: impl Fn(&QoderAccount) -> Value, budget: &QueueBudget)
        -> Result<OpenedChat, QoderError> {
        let mut tried = Vec::new();
        let mut last = QoderError::new(503, NO_ACCOUNT_ERROR);
        while tried.len() < MAX_ACCOUNT_ATTEMPTS {
            let Some(account) = self.candidates(&tried)?.into_iter().next() else { break };
            tried.push(account.id);
            let mut forced = false;
            let mut lease = match self.lease(account.clone(), false).await {
                Ok(l) => l,
                Err(e) => {
                    self.cooldowns.lock().insert(account.id, Instant::now() + e.cooldown());
                    last = e;
                    continue;
                }
            };
            'gateways: for (i, gw) in self.gateways().into_iter().enumerate() {
                loop {
                    let body = build(&lease.account);
                    match client::open_chat(&self.stream_client, &lease.session, gw, &body, &model.key).await {
                        Ok(response) => {
                            self.note_gateway(gw, i);
                            self.touch_used_throttled(account.id);
                            return Ok(OpenedChat { response, account_id: account.id, model });
                        }
                        Err(e) if e.kind == FailureKind::Auth && !forced => {
                            forced = true;
                            match self.lease_after_auth_failure(account.clone(), &lease.token).await {
                                Ok(l) => { lease = l; continue; }
                                Err(err) => { last = err; break 'gateways; }
                            }
                        }
                        // 模型级排队：换号换网关都没用，等完在原号原网关重发；预算用尽直接交还客户端
                        Err(e) if e.kind == FailureKind::Queued => {
                            budget.wait(&QoderError::from(e)).await?;
                            continue;
                        }
                        Err(e) if e.kind == FailureKind::Unavailable => {
                            last = e.into();
                            continue 'gateways;
                        }
                        Err(e) if matches!(e.kind, FailureKind::InvalidRequest | FailureKind::ClientTooOld) => {
                            self.store.record(account.id, false);
                            return Err(e.into());
                        }
                        Err(e) => {
                            let e = QoderError::from(e);
                            self.store.record(account.id, false);
                            self.cool_down(account.id, &e);
                            last = e;
                            break 'gateways;
                        }
                    }
                }
            }
        }
        Err(last)
    }

    /// 生成结束后记账；空响应或流内错误按失败计，额度 / 限流类错误顺带冷却；随后延时拉一次额度。
    /// 排队是模型级信号：既不算这个账号失败，也不冷却，额度也没动
    pub fn finish(self: &Arc<Self>, account_id: i64, error: Option<&QoderError>) {
        let kind = error.and_then(|e| e.kind);
        if kind == Some(FailureKind::Queued) {
            return;
        }
        self.store.record(account_id, error.is_none());
        if let Some(e) = error && matches!(kind, Some(FailureKind::Quota | FailureKind::RateLimit)) {
            self.cool_down(account_id, e);
        }
        self.schedule_quota_refresh(account_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn find_model_by_key_then_name() {
        let entries = vec![
            json!({"key":"k-off","display_name":"Off","enable":false}),
            json!({"key":"qwen3-coder","display_name":"Qwen3 Coder","is_reasoning":true,"max_input_tokens":100}),
            json!({"key":"auto","display_name":"Auto"}),
        ];
        let none = ModelOverrides::new();
        assert_eq!(find_model(&entries, &none, "qwen3-coder").unwrap().max_input_tokens, Some(100));
        assert_eq!(find_model(&entries, &none, "qwen3 CODER").unwrap().key, "qwen3-coder");
        assert!(find_model(&entries, &none, "k-off").is_none());
        let m = catalog_model(&entries[1], true, None);
        assert_eq!((m.context_window, m.max_output, m.is_reasoning), (100, DEFAULT_MAX_OUTPUT, true));
        assert_eq!(m.public_id, "qwen3-coder");
    }

#[test]
    fn catalog_prices_keep_zero_and_unknown_distinct() {
        let free = catalog_model(&serde_json::json!({
            "key":"free", "price_factor":0, "original_price_factor":"0.3", "is_free":true
        }), true, None);
        assert_eq!(free.price_factor, Some(0.0));
        assert_eq!(free.original_price_factor, Some(0.3));
        assert!(free.is_free);
        let paid = catalog_model(&serde_json::json!({"key":"paid", "priceFactor":"8"}), true, None);
        assert_eq!(paid.price_factor, Some(8.0));
        for value in [serde_json::Value::Null, serde_json::json!(-1), serde_json::json!("NaN"), serde_json::json!("unknown")] {
            let model = catalog_model(&serde_json::json!({"key":"unknown", "price_factor":value}), true, None);
            assert_eq!(model.price_factor, None);
            assert!(!model.is_free);
        }
    }

#[test]
    fn desktop_body_matches_plugin_fixture() {
        let fixture: Value = serde_json::from_str(include_str!("plugin-parity.json")).unwrap();
        let model = to_meta(&fixture["raw"], None);
        let task = super::super::converter::TaskContext { id: "fixture-task".into(), begin_at_ms: 123, answered: true };
        let mut body = super::super::converter::build_qoder_body(&fixture["chat"], &model, "fixture-session", &task);
        body["request_id"] = serde_json::json!("<request>");
        body["chat_record_id"] = serde_json::json!("<request>");
        body["session_id"] = serde_json::json!("<session>");
        assert_eq!(body, fixture["expected"]);
    }

    #[test]
    fn capabilities_parse_like_official_cli() {
        // context_config + thinking_config.enabled 里的强度表、disabled 表示可关闭
        let e = json!({"key":"cmodel","max_input_tokens":180000,
            "context_config":{"a":{"token_count":1000000},"b":{"token_count":180000,"is_default":true}},
            "thinking_config":{"disabled":{},"enabled":{"efforts":{"high":{"is_default":true},"low":{},"max":{},"bogus":{}}}}});
        assert_eq!(model_windows(&e), (vec![180000, 1000000], Some(180000)));
        assert_eq!(model_efforts(&e), (vec!["none".into(), "low".into(), "high".into(), "max".into()], Some("high".into())));
        // available_context_windows + 顶层字符串强度
        let e = json!({"key":"k","available_context_windows":[200000,128000,200000],"efforts":"low, high","default_effort":"low"});
        assert_eq!(model_windows(&e), (vec![128000, 200000], Some(200000)));
        assert_eq!(model_efforts(&e), (vec!["low".into(), "high".into()], Some("low".into())));
        // 只有 max_input_tokens：官方兜底档位
        assert_eq!(model_windows(&json!({"key":"k","max_input_tokens":180000})), (vec![128000, 180000], Some(180000)));
        assert_eq!(model_efforts(&json!({"key":"k"})), (vec![], None));
    }

    #[test]
    fn overrides_alias_window_and_effort() {
        let entries = vec![
            json!({"key":"cmodel","display_name":"Cantus","available_context_windows":[180000,1000000],"efforts":["low","high"]}),
            json!({"key":"fast","display_name":"Fast","max_input_tokens":200000}),
        ];
        let mut input = ModelOverrides::new();
        input.insert("cmodel".into(), ModelOverride { alias: Some(" claude-x ".into()), context_window: Some(1000000), effort: Some("HIGH".into()) });
        input.insert("fast".into(), ModelOverride { alias: Some("fast".into()), ..Default::default() });
        let saved = validate_overrides(&entries, &input).unwrap();
        // 与原名相同的别名、全空配置都被丢掉
        assert_eq!(saved.len(), 1);
        assert_eq!(saved["cmodel"], ModelOverride { alias: Some("claude-x".into()), context_window: Some(1000000), effort: Some("high".into()) });
        let m = find_model(&entries, &saved, "Claude-X").unwrap();
        assert_eq!((m.key.as_str(), m.context_window, m.max_input_tokens, m.effort.as_deref()), ("cmodel", Some(1000000), None, Some("high")));
        // 原名仍然可用
        assert_eq!(find_model(&entries, &saved, "cmodel").unwrap().key, "cmodel");
        assert_eq!(catalog_model(&entries[0], true, saved.get("cmodel")).public_id, "claude-x");

        let bad = |o: ModelOverride| { let mut m = ModelOverrides::new(); m.insert("cmodel".into(), o); validate_overrides(&entries, &m) };
        assert!(bad(ModelOverride { alias: Some("Fast".into()), ..Default::default() }).is_err());
        assert!(bad(ModelOverride { alias: Some("a b".into()), ..Default::default() }).is_err());
        assert!(bad(ModelOverride { context_window: Some(7), ..Default::default() }).is_err());
        assert!(bad(ModelOverride { effort: Some("max".into()), ..Default::default() }).is_err());
        let mut dup = ModelOverrides::new();
        dup.insert("cmodel".into(), ModelOverride { alias: Some("x".into()), ..Default::default() });
        dup.insert("fast".into(), ModelOverride { alias: Some("X".into()), ..Default::default() });
        assert!(validate_overrides(&entries, &dup).is_err());
    }

    fn temp_provider() -> (std::path::PathBuf, QoderProvider) {
        let dir = std::env::temp_dir().join(format!("qoder-provider-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let store = Arc::new(QoderStore::open_or_create(&dir.join("q.sqlite3"), Arc::new(crate::qoder::vault::MemoryVault::default())).unwrap());
        (dir, QoderProvider::new(store, None).unwrap())
    }

    fn trash(dir: &std::path::Path) {
        let trash = std::path::PathBuf::from(std::env::var_os("HOME").unwrap()).join(".Trash");
        std::fs::create_dir_all(&trash).unwrap();
        std::fs::rename(dir, trash.join(dir.file_name().unwrap())).unwrap();
    }

    #[tokio::test]
    async fn catalog_serves_stale_and_backs_off_after_failure() {
        let (dir, p) = temp_provider();
        // 没有账号、没有旧目录：失败后进入退避，退避期内不再尝试
        assert_eq!(p.catalog_entries().await.unwrap_err().status, 503);
        assert!(p.catalog_failed_at.lock().is_some());
        assert!(p.catalog_entries().await.unwrap_err().message.contains("稍后自动重试"));
        // 有过期旧目录：退避期内直接返回旧目录
        let stale = Arc::new(vec![json!({"key":"k1"})]);
        *p.catalog.lock() = Some((Instant::now(), stale.clone()));
        assert_eq!(p.catalog_entries().await.unwrap().len(), 1);
        // 账号变动只标记过期并清退避，不丢旧数据
        p.invalidate_catalog();
        assert!(p.catalog_failed_at.lock().is_none());
        assert!(p.catalog.lock().is_some());
        drop(p);
        trash(&dir);
    }

    #[tokio::test]
    async fn forced_refresh_reuses_token_already_rotated_by_another_request() {
        let (dir, p) = temp_provider();
        let id = p.store.upsert(&NewAccount {
            uid: "u1", name: None, email: None, pat: "pt-x", access_token: "new-token",
            refresh_token: None, expires_at_ms: now_ms() + 24 * 3600 * 1000,
            user_type: None, org_id: None, org_name: None,
        }).unwrap();
        let account = p.store.get(id).unwrap().unwrap();
        // 被拒的是旧 token，库里已是新的未过期 token：不发任何上游请求，直接复用
        assert_eq!(p.ensure_token_inner(&account, true, Some("old-token")).await.unwrap(), "new-token");
        // 未强制时同样直接用库里未过期的 token
        assert_eq!(p.ensure_token(&account, false).await.unwrap(), "new-token");
        drop(p);
        trash(&dir);
    }

    #[test]
    fn cooldown_by_kind() {
        let e = |kind, retry| UpstreamError { kind, status: 0, message: String::new(), retry_after_secs: retry };
        assert_eq!(cooldown_for(FailureKind::Quota, None).as_secs(), QUOTA_COOLDOWN_SECS);
        assert_eq!(cooldown_for(FailureKind::RateLimit, Some(7)).as_secs(), 7);
        // 上游凭证失效不回 401，避免客户端误判自己的 apiKey
        assert_eq!(QoderError::from(e(FailureKind::Auth, None)).status, 502);
        // 排队按过载：503，带上游建议的等待
        let queued = QoderError::from(e(FailureKind::Queued, Some(30)));
        assert_eq!((queued.status, queued.retry_after_secs), (503, Some(30)));
        let net = QoderError::from(e(FailureKind::Unavailable, None));
        assert_eq!(net.cooldown().as_secs(), UNAVAILABLE_COOLDOWN_SECS);
        assert_eq!(QoderError::from(e(FailureKind::Auth, None)).cooldown().as_secs(), AUTH_COOLDOWN_SECS);
        assert_eq!(QoderError::new(500, "db").cooldown().as_secs(), AUTH_COOLDOWN_SECS);
    }

    #[tokio::test]
    async fn queue_wait_is_clamped_and_budget_hands_back_a_503() {
        assert_eq!(queue_wait(None).as_secs(), DEFAULT_QUEUE_RETRY_SECS);
        assert_eq!(queue_wait(Some(0)).as_secs(), QUEUE_WAIT_MIN_SECS);
        assert_eq!(queue_wait(Some(600)).as_secs(), QUEUE_WAIT_MAX_SECS);
        let queued = QoderError { status: 503, message: "排队".into(), kind: Some(FailureKind::Queued), retry_after_secs: Some(5) };
        // 预算已尽：不睡、直接把排队状态交还客户端，并带上 Retry-After
        let now = Instant::now();
        let spent = QueueBudget { started: now, deadline: now };
        let e = spent.wait(&queued).await.unwrap_err();
        assert_eq!((e.status, e.kind, e.retry_after_secs), (503, Some(FailureKind::Queued), Some(5)));
        assert!(e.message.contains("不再等待"));
        assert!(now.elapsed() < Duration::from_secs(1));
        // 预算充足：按上游建议睡完返回 Ok
        let fresh = QueueBudget::new();
        let short = QoderError { retry_after_secs: Some(1), ..queued.clone() };
        let started = Instant::now();
        fresh.wait(&short).await.unwrap();
        assert!(started.elapsed() >= Duration::from_secs(1));
    }

    /// 排队既不记失败也不冷却；额度错误两者都做
    #[test]
    fn finish_ignores_queue_but_cools_quota() {
        let (dir, p) = temp_provider();
        let p = Arc::new(p);
        let id = p.store.upsert(&NewAccount {
            uid: "u1", name: None, email: None, pat: "pt-x", access_token: "t", refresh_token: None,
            expires_at_ms: 1, user_type: None, org_id: None, org_name: None,
        }).unwrap();
        p.finish(id, Some(&QoderError { status: 503, message: "q".into(), kind: Some(FailureKind::Queued), retry_after_secs: Some(30) }));
        let a = p.store.get(id).unwrap().unwrap();
        assert_eq!((a.success_count, a.failure_count), (0, 0));
        assert!(!p.cooldowns.lock().contains_key(&id));
        p.finish(id, Some(&QoderError { status: 429, message: "quota".into(), kind: Some(FailureKind::Quota), retry_after_secs: None }));
        let a = p.store.get(id).unwrap().unwrap();
        assert_eq!(a.failure_count, 1);
        assert!(p.cooldowns.lock().contains_key(&id));
        drop(p);
        trash(&dir);
    }
}
