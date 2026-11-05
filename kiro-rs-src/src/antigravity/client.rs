//! Google OAuth 与 cloudcode-pa v1internal 的 HTTP 调用

use std::collections::HashMap;
use std::sync::OnceLock;

use parking_lot::RwLock;
use reqwest::{Client, StatusCode, header};
use serde::Deserialize;
use serde_json::{Value, json};

use super::consts::{
    AICODE_FETCH_CONFIG_URLS, AICODE_FETCH_LICENSES_URLS, AICODE_FETCH_QUOTA_URLS,
    DEFAULT_USER_TIER, FETCH_MODELS_URLS, HUB_MANIFEST_URL, HUB_MANIFEST_USER_AGENT, IDE_TYPE,
    LOAD_CODE_ASSIST_URLS, MIN_CLIENT_VERSION, OAUTH_AUTH_URL, OAUTH_CLIENT_ID,
    OAUTH_CLIENT_SECRET, OAUTH_SCOPES, OAUTH_TOKEN_URL, QUOTA_SUMMARY_URLS, TIER_ID_PRO,
    TIER_ID_ULTRA, USERINFO_URL,
};

const GRANT_AUTHORIZATION_CODE: &str = "authorization_code";
const GRANT_REFRESH_TOKEN: &str = "refresh_token";
const INVALID_GRANT: &str = "invalid_grant";

/// 上游返回的非 2xx 响应
#[derive(Debug)]
pub struct UpstreamError {
    pub status: u16,
    pub body: String,
}

impl std::fmt::Display for UpstreamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "HTTP {}: {}", self.status, truncate(&self.body, 500))
    }
}

impl std::error::Error for UpstreamError {}

impl UpstreamError {
    /// refresh token 已失效，只能重新登录
    pub fn is_invalid_grant(&self) -> bool {
        self.body.contains(INVALID_GRANT)
    }
}

fn truncate(s: &str, max: usize) -> &str {
    match s.char_indices().nth(max) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

async fn into_result(resp: reqwest::Response) -> anyhow::Result<reqwest::Response> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    let body = resp.text().await.unwrap_or_default();
    Err(UpstreamError { status: status.as_u16(), body }.into())
}

/// 当前上报的客户端版本（已套用下限）；`refresh_client_version` 定期更新
fn version_slot() -> &'static RwLock<String> {
    static VERSION: OnceLock<RwLock<String>> = OnceLock::new();
    VERSION.get_or_init(|| {
        RwLock::new(at_least_min(local_app_version().as_deref().unwrap_or(MIN_CLIENT_VERSION)))
    })
}

pub fn client_version() -> String {
    version_slot().read().clone()
}

/// 重新取版本号：本机 App 与官方 Hub 更新清单里取较新者，不低于下限。
/// 只在后台定时调用，不阻塞请求
pub async fn refresh_client_version(client: &Client) {
    let local = local_app_version();
    let online = match fetch_hub_version(client).await {
        Ok(v) => Some(v),
        Err(e) => {
            tracing::debug!("读取 Antigravity Hub 版本清单失败: {e}");
            None
        }
    };
    let best = [local, online]
        .into_iter()
        .flatten()
        .max_by(|a, b| compare_versions(a, b))
        .unwrap_or_else(|| MIN_CLIENT_VERSION.to_string());
    let next = at_least_min(&best);
    let mut slot = version_slot().write();
    if *slot != next {
        tracing::info!("Antigravity 上报版本 {} → {next}", *slot);
        *slot = next;
    }
}

async fn fetch_hub_version(client: &Client) -> anyhow::Result<String> {
    let resp = client
        .get(HUB_MANIFEST_URL)
        .header(header::USER_AGENT, HUB_MANIFEST_USER_AGENT)
        .header(header::CACHE_CONTROL, "no-cache")
        .send()
        .await?;
    let text = into_result(resp).await?.text().await?;
    parse_manifest_version(&text).ok_or_else(|| anyhow::anyhow!("清单里没有有效的 version"))
}

/// 从 electron-builder 的 `latest-*.yml` 里取 `version: x.y.z`
fn parse_manifest_version(yaml: &str) -> Option<String> {
    yaml.lines().find_map(|line| {
        let v = line.trim().strip_prefix("version:")?.trim().trim_matches(['"', '\'']);
        is_semver(v).then(|| v.to_string())
    })
}

fn is_semver(v: &str) -> bool {
    let parts: Vec<&str> = v.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

/// 按数字逐段比较 `x.y.z`；解析不了的段当 0
fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let nums = |v: &str| -> Vec<u64> { v.split('.').map(|p| p.parse().unwrap_or(0)).collect() };
    nums(a).cmp(&nums(b))
}

fn at_least_min(v: &str) -> String {
    match compare_versions(v, MIN_CLIENT_VERSION) {
        std::cmp::Ordering::Less => MIN_CLIENT_VERSION.to_string(),
        _ => v.to_string(),
    }
}

#[cfg(target_os = "macos")]
fn local_app_version() -> Option<String> {
    let xml = std::fs::read_to_string(super::consts::LOCAL_APP_PLIST).ok()?;
    plist_string_value(&xml, "CFBundleShortVersionString")
}

#[cfg(not(target_os = "macos"))]
fn local_app_version() -> Option<String> {
    None
}

/// 从 XML plist 里取 `<key>k</key><string>v</string>`（二进制 plist 读不到就返回 None）
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn plist_string_value(xml: &str, key: &str) -> Option<String> {
    let key_tag = format!("<key>{key}</key>");
    let rest = &xml[xml.find(&key_tag)? + key_tag.len()..];
    let start = rest.find("<string>")? + "<string>".len();
    let end = rest[start..].find("</string>")? + start;
    let v = rest[start..end].trim();
    (!v.is_empty() && v.chars().all(|c| c.is_ascii_digit() || c == '.')).then(|| v.to_string())
}

/// 与官方 Hub 同格式：`antigravity/hub/{ver} (aidev_client; os_type=darwin; arch=arm64)`。
/// 官方还会带 `; cl=<构建号>`，但构建号随版本变、无法可靠推出，带错比不带更显眼，所以不带
pub fn user_agent() -> String {
    format!(
        "antigravity/hub/{} (aidev_client; os_type={}; arch={})",
        client_version(),
        platform_tag(),
        arch_tag()
    )
}

fn platform_tag() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "windows",
        _ => "linux",
    }
}

fn arch_tag() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        other => other,
    }
}

// === OAuth ===

#[derive(Debug, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub expires_in: i64,
    #[serde(default)]
    pub refresh_token: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UserInfo {
    pub email: String,
    #[serde(default)]
    pub name: Option<String>,
}

pub fn auth_url(redirect_uri: &str, state: &str) -> String {
    let params = [
        ("access_type", "offline"),
        ("scope", &OAUTH_SCOPES.join(" ")),
        ("prompt", "consent"),
        ("response_type", "code"),
        ("client_id", OAUTH_CLIENT_ID),
        ("redirect_uri", redirect_uri),
        ("include_granted_scopes", "true"),
        ("state", state),
    ];
    let query: Vec<String> = params
        .iter()
        .map(|(k, v)| format!("{k}={}", urlencoding::encode(v)))
        .collect();
    format!("{OAUTH_AUTH_URL}?{}", query.join("&"))
}

pub async fn exchange_code(client: &Client, code: &str, redirect_uri: &str) -> anyhow::Result<TokenResponse> {
    let form = [
        ("client_id", OAUTH_CLIENT_ID),
        ("client_secret", OAUTH_CLIENT_SECRET),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("grant_type", GRANT_AUTHORIZATION_CODE),
    ];
    post_token_form(client, &form).await
}

pub async fn refresh_access_token(client: &Client, refresh_token: &str) -> anyhow::Result<TokenResponse> {
    let form = [
        ("client_id", OAUTH_CLIENT_ID),
        ("client_secret", OAUTH_CLIENT_SECRET),
        ("refresh_token", refresh_token),
        ("grant_type", GRANT_REFRESH_TOKEN),
    ];
    post_token_form(client, &form).await
}

async fn post_token_form(client: &Client, form: &[(&str, &str)]) -> anyhow::Result<TokenResponse> {
    let body: String = form
        .iter()
        .map(|(k, v)| format!("{k}={}", urlencoding::encode(v)))
        .collect::<Vec<_>>()
        .join("&");
    let resp = client
        .post(OAUTH_TOKEN_URL)
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await?;
    Ok(into_result(resp).await?.json().await?)
}

pub async fn user_info(client: &Client, access_token: &str) -> anyhow::Result<UserInfo> {
    let resp = client.get(USERINFO_URL).bearer_auth(access_token).send().await?;
    Ok(into_result(resp).await?.json().await?)
}

// === v1internal & aicode v1alpha ===

fn internal_post(client: &Client, url: &str, access_token: &str) -> reqwest::RequestBuilder {
    client
        .post(url)
        .bearer_auth(access_token)
        .header(header::USER_AGENT, user_agent())
        .header(header::CONTENT_TYPE, "application/json")
}

/// aicode.googleapis.com GET 请求：不带 X-Goog-User-Project（带 aicode-consumers 会被 403 拒绝）
fn internal_get(client: &Client, url: &str, access_token: &str) -> reqwest::RequestBuilder {
    client
        .get(url)
        .bearer_auth(access_token)
        .header(header::USER_AGENT, user_agent())
}

/// loadCodeAssist 的结果
pub struct ProjectInfo {
    pub project_id: Option<String>,
    pub tier: Option<String>,
}

/// 将存储中的展示名或原始档位统一规整为 aicode.googleapis.com 要求的 userTier id
pub fn normalize_user_tier(tier: Option<&str>) -> String {
    let Some(raw) = tier.map(str::trim).filter(|s| !s.is_empty()) else {
        return DEFAULT_USER_TIER.to_string();
    };
    let lower = raw.to_ascii_lowercase();
    if lower.contains("ultra") {
        TIER_ID_ULTRA.to_string()
    } else if lower.contains("pro") {
        TIER_ID_PRO.to_string()
    } else if matches!(lower.as_str(), "free" | "antigravity" | "free-tier") {
        DEFAULT_USER_TIER.to_string()
    } else {
        raw.to_string()
    }
}

fn tier_label(tier: &Value) -> Option<String> {
    ["id", "name"]
        .iter()
        .filter_map(|k| tier.get(*k).and_then(Value::as_str))
        .map(str::trim)
        .find(|s| !s.is_empty())
        .map(str::to_string)
}

fn parse_project_info(v: &Value) -> ProjectInfo {
    let project_id = match v.get("cloudaicompanionProject") {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        Some(Value::Object(o)) => o.get("id").and_then(Value::as_str).map(str::to_string),
        _ => None,
    };
    let ineligible = v
        .get("ineligibleTiers")
        .and_then(Value::as_array)
        .is_some_and(|a| !a.is_empty());
    let tier = v
        .get("paidTier")
        .and_then(tier_label)
        .or_else(|| (!ineligible).then(|| v.get("currentTier").and_then(tier_label)).flatten())
        .or_else(|| {
            let allowed = v.get("allowedTiers").and_then(Value::as_array)?;
            allowed
                .iter()
                .find(|t| t.get("isDefault").and_then(Value::as_bool).unwrap_or(false))
                .or_else(|| allowed.first())
                .and_then(tier_label)
        });
    ProjectInfo { project_id, tier }
}

/// 从 `aicode.googleapis.com/v1alpha:fetchLicenses` 获取准确的 `userTier`（如 `g1-ultra-tier`）
pub async fn fetch_licenses_tier(client: &Client, access_token: &str) -> Option<String> {
    for url in AICODE_FETCH_LICENSES_URLS {
        let Ok(resp) = internal_get(client, url, access_token).send().await else {
            continue;
        };
        let Ok(resp) = into_result(resp).await else {
            continue;
        };
        let Ok(v) = resp.json::<Value>().await else {
            continue;
        };
        if let Some(tier) = v["licenses"]
            .as_array()
            .and_then(|arr| arr.first())
            .and_then(|l| l.get("userTier"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return Some(tier.to_string());
        }
    }
    None
}

pub async fn load_code_assist(client: &Client, access_token: &str) -> anyhow::Result<ProjectInfo> {
    let license_tier = fetch_licenses_tier(client, access_token).await;
    let body = json!({ "metadata": { "ideType": IDE_TYPE } });
    let mut last_err = None;
    for url in LOAD_CODE_ASSIST_URLS {
        match internal_post(client, url, access_token).json(&body).send().await {
            Ok(resp) => match into_result(resp).await {
                Ok(resp) => {
                    let mut info = parse_project_info(&resp.json::<Value>().await?);
                    if license_tier.is_some() {
                        info.tier = license_tier;
                    }
                    return Ok(info);
                }
                Err(e) => last_err = Some(e),
            },
            Err(e) => last_err = Some(e.into()),
        }
    }
    if let Some(tier) = license_tier {
        return Ok(ProjectInfo { project_id: None, tier: Some(tier) });
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("loadCodeAssist 无可用端点")))
}

async fn fetch_aicode_json(client: &Client, urls: &[&str], access_token: &str) -> anyhow::Result<Value> {
    let mut last_err = None;
    for url in urls {
        match internal_get(client, url, access_token).send().await {
            Ok(resp) => match into_result(resp).await {
                Ok(resp) => return Ok(resp.json::<Value>().await?),
                Err(e) => last_err = Some(e),
            },
            Err(e) => last_err = Some(e.into()),
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("AICode 接口无可用端点")))
}

async fn fetch_ccpa_models(client: &Client, access_token: &str, project_id: Option<&str>) -> anyhow::Result<Value> {
    let mut last_err = None;
    for url in FETCH_MODELS_URLS {
        let with_project = project_id.map(|p| json!({ "project": p }));
        // 带 project 被 403 时不带再试一次
        let bodies = [with_project, Some(json!({}))];
        for body in bodies.iter().flatten() {
            let resp = match internal_post(client, url, access_token).json(body).send().await {
                Ok(r) => r,
                Err(e) => {
                    last_err = Some(e.into());
                    break;
                }
            };
            let status = resp.status();
            match into_result(resp).await {
                Ok(resp) => return Ok(summarize_quota(&resp.json::<Value>().await?)),
                Err(e) => {
                    last_err = Some(e);
                    if status != StatusCode::FORBIDDEN {
                        break;
                    }
                }
            }
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("fetchAvailableModels 无可用端点")))
}

/// 合并 AICode (`fetchConfig` + `fetchQuotaStatus`) 与 CCPA (`fetchAvailableModels`) 模型目录及额度
pub async fn fetch_quota(client: &Client, access_token: &str, project_id: Option<&str>) -> anyhow::Result<Value> {
    let aicode_config = fetch_aicode_json(client, AICODE_FETCH_CONFIG_URLS, access_token).await;
    let aicode_status = fetch_aicode_json(client, AICODE_FETCH_QUOTA_URLS, access_token).await.ok();
    let ccpa = fetch_ccpa_models(client, access_token, project_id).await;

    let aicode = aicode_config
        .as_ref()
        .ok()
        .map(|cfg| summarize_aicode_quota(cfg, aicode_status.as_ref()));

    if aicode.is_none() && ccpa.is_err() {
        return Err(ccpa.err().or_else(|| aicode_config.err()).unwrap());
    }

    let mut quota = merge_quota_models(aicode, ccpa.ok());
    let aicode_groups = aicode_status
        .as_ref()
        .and_then(|s| s.get("quotaSummary"))
        .map(summarize_quota_groups)
        .filter(|g| g.as_array().is_some_and(|a| !a.is_empty()));
    if let Some(groups) = aicode_groups {
        quota["groups"] = groups;
    } else if let Some(groups) = fetch_quota_groups(client, access_token, project_id).await {
        quota["groups"] = groups;
    }
    Ok(quota)
}

fn summarize_aicode_quota(config: &Value, quota_status: Option<&Value>) -> Value {
    let mut bucket_map: HashMap<String, (f64, Value)> = HashMap::new();
    if let Some(buckets) = quota_status.and_then(|s| s.get("buckets")).and_then(Value::as_array) {
        for b in buckets {
            if let Some(mid) = b["model"]["modelId"].as_str().filter(|s| !s.is_empty()) {
                let rem = b.get("remainingFraction").and_then(Value::as_f64).unwrap_or(0.0);
                let reset = b.get("resetTime").cloned().unwrap_or(Value::Null);
                bucket_map.insert(mid.to_string(), (rem, reset));
            }
        }
    }
    let mut models: Vec<Value> = config
        .get("availableExperiences")
        .and_then(Value::as_array)
        .map(|exps| {
            exps.iter()
                .filter_map(|exp| {
                    if exp["surfaceConfig"]["disabled"].as_bool() == Some(true) {
                        return None;
                    }
                    let id = exp.get("name").and_then(Value::as_str)?.trim();
                    if id.is_empty() {
                        return None;
                    }
                    let model = &exp["model"];
                    let model_id = model.get("modelId").and_then(Value::as_str).unwrap_or(id);
                    let (rem, reset) = bucket_map
                        .get(model_id)
                        .or_else(|| bucket_map.get(id))
                        .cloned()
                        .unwrap_or((1.0, Value::Null));
                    Some(json!({
                        "id": id,
                        "displayName": model.get("displayName").cloned().unwrap_or(Value::Null),
                        "maxTokens": model.get("inputTokenLimit").cloned().unwrap_or(Value::Null),
                        "remainingFraction": rem,
                        "resetTime": reset,
                    }))
                })
                .collect()
        })
        .unwrap_or_default();
    models.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    json!({ "models": models })
}

fn merge_quota_models(aicode: Option<Value>, ccpa: Option<Value>) -> Value {
    let mut by_id: HashMap<String, Value> = HashMap::new();
    if let Some(ccpa_models) = ccpa.as_ref().and_then(|v| v["models"].as_array()) {
        for m in ccpa_models {
            if let Some(id) = m["id"].as_str() {
                by_id.insert(id.to_string(), m.clone());
            }
        }
    }
    if let Some(aicode_models) = aicode.as_ref().and_then(|v| v["models"].as_array()) {
        for m in aicode_models {
            let Some(id) = m["id"].as_str() else { continue };
            let mut merged = m.clone();
            if let Some(prev) = by_id.get(id) {
                if merged["resetTime"].is_null() && !prev["resetTime"].is_null() {
                    merged["remainingFraction"] = prev["remainingFraction"].clone();
                    merged["resetTime"] = prev["resetTime"].clone();
                }
                if merged["displayName"].is_null() && !prev["displayName"].is_null() {
                    merged["displayName"] = prev["displayName"].clone();
                }
            }
            by_id.insert(id.to_string(), merged);
        }
    }
    let mut models: Vec<Value> = by_id.into_values().collect();
    models.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    json!({ "models": models })
}

fn summarize_quota(v: &Value) -> Value {
    let mut models: Vec<Value> = v
        .get("models")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(id, info)| {
                    let q = info.get("quotaInfo")?;
                    Some(json!({
                        "id": id,
                        "displayName": info.get("displayName").cloned().unwrap_or(Value::Null),
                        "maxTokens": info.get("maxTokens").cloned().unwrap_or(Value::Null),
                        "remainingFraction": q.get("remainingFraction").and_then(Value::as_f64).unwrap_or(0.0),
                        "resetTime": q.get("resetTime").cloned().unwrap_or(Value::Null),
                    }))
                })
                .collect()
        })
        .unwrap_or_default();
    models.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    json!({ "models": models })
}

/// retrieveUserQuotaSummary → 规整后的 `groups`；任何失败都返回 None
async fn fetch_quota_groups(client: &Client, access_token: &str, project_id: Option<&str>) -> Option<Value> {
    let body = project_id.map_or_else(|| json!({}), |p| json!({ "project": p }));
    for url in QUOTA_SUMMARY_URLS {
        let resp = match internal_post(client, url, access_token).json(&body).send().await {
            Ok(r) => r,
            Err(e) => {
                tracing::debug!("retrieveUserQuotaSummary 请求失败 {url}: {e}");
                continue;
            }
        };
        match into_result(resp).await {
            Ok(resp) => match resp.json::<Value>().await {
                Ok(v) => return Some(summarize_quota_groups(&v)),
                Err(e) => {
                    tracing::warn!("retrieveUserQuotaSummary 响应解析失败: {e}");
                    return None;
                }
            },
            Err(e) => tracing::debug!("retrieveUserQuotaSummary 返回错误 {url}: {e}"),
        }
    }
    None
}

/// `{ groups: [{ displayName, buckets: [{ bucketId, window, remainingFraction, resetTime }] }] }`
/// → 只保留展示需要的字段；缺 remainingFraction 的桶保留为 null，前端显示「—」
fn summarize_quota_groups(v: &Value) -> Value {
    let pick = |obj: &Value, key: &str| obj.get(key).cloned().unwrap_or(Value::Null);
    let groups: Vec<Value> = v
        .get("groups")
        .and_then(Value::as_array)
        .map(|groups| {
            groups
                .iter()
                .map(|g| {
                    let buckets: Vec<Value> = g
                        .get("buckets")
                        .and_then(Value::as_array)
                        .map(|bs| {
                            bs.iter()
                                .map(|b| {
                                    json!({
                                        "bucketId": pick(b, "bucketId"),
                                        "window": pick(b, "window"),
                                        "displayName": pick(b, "displayName"),
                                        "remainingFraction": b.get("remainingFraction").and_then(Value::as_f64),
                                        "resetTime": pick(b, "resetTime"),
                                    })
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    json!({ "displayName": pick(g, "displayName"), "buckets": buckets })
                })
                .collect()
        })
        .unwrap_or_default();
    Value::Array(groups)
}

/// 429 的具体原因，决定冷却时长
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RateLimitKind {
    /// 额度用完，要等到重置
    QuotaExhausted,
    /// 短时请求过多
    RateLimited,
    /// 上游模型容量不足，与账号无关
    Capacity,
    Unknown,
}

/// 403 的具体原因
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForbiddenKind {
    /// 需要人工验证（风控），过一阵会恢复
    ValidationRequired,
    /// 账号因违反条款被停用，只能人工处理
    Banned,
    Other,
}

const REASON_QUOTA_EXHAUSTED: &str = "QUOTA_EXHAUSTED";
const REASON_RATE_LIMIT: &str = "RATE_LIMIT_EXCEEDED";
const REASON_CAPACITY: &str = "MODEL_CAPACITY_EXHAUSTED";
const REASON_VALIDATION_REQUIRED: &str = "VALIDATION_REQUIRED";
const QUOTA_FAILURE_TYPE: &str = "google.rpc.QuotaFailure";

/// 错误体里 `details[].reason` 与 `@type`，统一大写，方便匹配
fn error_markers(body: &str) -> (Vec<String>, String) {
    let lower_text = body.to_lowercase();
    let Ok(v) = serde_json::from_str::<Value>(body) else {
        return (Vec::new(), lower_text);
    };
    let markers = v["error"]["details"]
        .as_array()
        .map(|details| {
            details
                .iter()
                .flat_map(|d| [d.get("reason"), d.get("@type")])
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_uppercase)
                .collect()
        })
        .unwrap_or_default();
    (markers, lower_text)
}

pub fn classify_rate_limit(body: &str) -> RateLimitKind {
    let (markers, text) = error_markers(body);
    let has = |m: &str| markers.iter().any(|x| x.contains(m));
    if has(REASON_CAPACITY) || text.contains("no capacity available") {
        RateLimitKind::Capacity
    } else if has(REASON_QUOTA_EXHAUSTED) || has(&QUOTA_FAILURE_TYPE.to_uppercase()) {
        RateLimitKind::QuotaExhausted
    } else if has(REASON_RATE_LIMIT) {
        RateLimitKind::RateLimited
    } else {
        RateLimitKind::Unknown
    }
}

pub fn classify_forbidden(body: &str) -> ForbiddenKind {
    let (markers, text) = error_markers(body);
    if markers.iter().any(|m| m.contains(REASON_VALIDATION_REQUIRED)) {
        ForbiddenKind::ValidationRequired
    } else if text.contains("terms of service") || text.contains("has been disabled") {
        ForbiddenKind::Banned
    } else {
        ForbiddenKind::Other
    }
}

/// 从 429 响应里解析上游建议的等待秒数
pub fn parse_retry_delay_secs(body: &str) -> Option<f64> {
    if let Ok(v) = serde_json::from_str::<Value>(body) {
        let details = v["error"]["details"].as_array().cloned().unwrap_or_default();
        for d in &details {
            for s in [&d["retryDelay"], &d["metadata"]["retryDelay"], &d["metadata"]["quotaResetDelay"]] {
                if let Some(secs) = s.as_str().and_then(parse_duration_secs) {
                    return Some(secs);
                }
            }
        }
    }
    // 文本形式："... quota will reset after 1h2m3s."
    let lower = body.to_lowercase();
    let idx = lower.find("reset after ")? + "reset after ".len();
    let token: String = lower[idx..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '.')
        .collect();
    // 句末的句号不属于时长
    parse_duration_secs(token.trim_end_matches('.'))
}

/// 解析 `1h2m3.5s` / `850ms` / `12s` 这类时长
pub fn parse_duration_secs(s: &str) -> Option<f64> {
    let s = s.trim();
    let mut total = 0.0;
    let mut num = String::new();
    let mut matched = false;
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c.is_ascii_digit() || c == '.' {
            num.push(c);
            continue;
        }
        let value: f64 = num.parse().ok()?;
        num.clear();
        let factor = match c {
            'h' => 3600.0,
            'm' if chars.peek() == Some(&'s') => {
                chars.next();
                0.001
            }
            'm' => 60.0,
            's' => 1.0,
            _ => return None,
        };
        total += value * factor;
        matched = true;
    }
    (matched && num.is_empty()).then_some(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_durations_and_retry_delays() {
        assert_eq!(parse_duration_secs("1h2m3s"), Some(3723.0));
        assert_eq!(parse_duration_secs("850ms"), Some(0.85));
        assert_eq!(parse_duration_secs("12.5s"), Some(12.5));
        assert_eq!(parse_duration_secs("12"), None);
        let body = r#"{"error":{"code":429,"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"30s"}]}}"#;
        assert_eq!(parse_retry_delay_secs(body), Some(30.0));
        assert_eq!(parse_retry_delay_secs("Your quota will reset after 2m5s."), Some(125.0));
        assert_eq!(parse_retry_delay_secs("nope"), None);
    }

    #[test]
    fn summarizes_quota_groups() {
        let groups = summarize_quota_groups(&json!({
            "groups": [{
                "displayName": "Claude and GPT models",
                "description": "ignored",
                "buckets": [
                    { "bucketId": "3p-5h", "window": "5h", "remainingFraction": 0.94, "resetTime": "2026-11-03T15:04:00Z" },
                    { "bucketId": "3p-weekly", "window": "weekly" }
                ]
            }]
        }));
        assert_eq!(groups[0]["displayName"], "Claude and GPT models");
        assert!(groups[0].get("description").is_none());
        assert_eq!(groups[0]["buckets"][0]["remainingFraction"], 0.94);
        assert_eq!(groups[0]["buckets"][1]["remainingFraction"], Value::Null);
        assert_eq!(summarize_quota_groups(&json!({})), json!([]));
    }

    #[test]
    fn parses_project_and_tier() {
        let info = parse_project_info(&json!({
            "cloudaicompanionProject": "proj-1",
            "currentTier": { "id": "free-tier", "name": "Free" },
            "paidTier": { "id": "g1-pro-tier" }
        }));
        assert_eq!(info.project_id.as_deref(), Some("proj-1"));
        assert_eq!(info.tier.as_deref(), Some("g1-pro-tier"));
    }

    #[test]
    fn classifies_rate_limit_reasons() {
        let with_reason = |r: &str| {
            format!(r#"{{"error":{{"code":429,"details":[{{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"{r}"}}]}}}}"#)
        };
        assert_eq!(classify_rate_limit(&with_reason("QUOTA_EXHAUSTED")), RateLimitKind::QuotaExhausted);
        assert_eq!(classify_rate_limit(&with_reason("RATE_LIMIT_EXCEEDED")), RateLimitKind::RateLimited);
        assert_eq!(classify_rate_limit(&with_reason("MODEL_CAPACITY_EXHAUSTED")), RateLimitKind::Capacity);
        let quota_failure = r#"{"error":{"details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure"}]}}"#;
        assert_eq!(classify_rate_limit(quota_failure), RateLimitKind::QuotaExhausted);
        assert_eq!(classify_rate_limit("No capacity available for model"), RateLimitKind::Capacity);
        assert_eq!(classify_rate_limit("Resource has been exhausted"), RateLimitKind::Unknown);
    }

    #[test]
    fn classifies_forbidden_reasons() {
        let validation = r#"{"error":{"code":403,"details":[{"reason":"VALIDATION_REQUIRED"}]}}"#;
        assert_eq!(classify_forbidden(validation), ForbiddenKind::ValidationRequired);
        let banned = r#"{"error":{"message":"This account has been disabled for violation of Terms of Service"}}"#;
        assert_eq!(classify_forbidden(banned), ForbiddenKind::Banned);
        assert_eq!(classify_forbidden("permission denied"), ForbiddenKind::Other);
    }

    #[test]
    fn user_agent_uses_hub_format() {
        let ua = user_agent();
        assert!(ua.starts_with("antigravity/hub/"), "{ua}");
        assert!(ua.contains("(aidev_client; os_type="), "{ua}");
        assert!(ua.ends_with(')'), "{ua}");
    }

    #[test]
    fn version_floor_and_manifest_parsing() {
        assert_eq!(at_least_min("2.0.3"), MIN_CLIENT_VERSION);
        assert_eq!(at_least_min("2.28.2"), "2.28.2");
        assert_eq!(compare_versions("2.10.0", "2.9.9"), std::cmp::Ordering::Greater);
        assert_eq!(
            parse_manifest_version("version: 2.29.0\npath: Antigravity-arm64-mac.zip\n").as_deref(),
            Some("2.29.0")
        );
        assert_eq!(parse_manifest_version("version: 'beta'\n"), None);
    }

    #[test]
    fn reads_version_from_plist_xml() {
        let xml = "<dict><key>CFBundleShortVersionString</key>\n<string>2.26.0</string></dict>";
        assert_eq!(plist_string_value(xml, "CFBundleShortVersionString").as_deref(), Some("2.26.0"));
    }

    #[test]
    fn auth_url_encodes_scopes_and_redirect() {
        let url = auth_url("http://127.0.0.1:5000/oauth-callback", "st");
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A5000%2Foauth-callback"));
        assert!(url.contains("access_type=offline"));
        assert!(url.contains("state=st"));
    }

    #[test]
    fn quota_summary_preserves_upstream_context_capacity() {
        let summary = summarize_quota(&json!({ "models": {
            "claude-opus-4-6-thinking": {
                "displayName": "Upstream Opus",
                "maxTokens": 250_000,
                "quotaInfo": { "remainingFraction": 0.5 }
            },
            "model-without-capacity": { "quotaInfo": {} }
        } }));
        let models = summary["models"].as_array().unwrap();
        assert_eq!(models[0]["id"], "claude-opus-4-6-thinking");
        assert_eq!(models[0]["maxTokens"], 250_000);
        assert_eq!(models[0]["displayName"], "Upstream Opus");
        assert!(models[1]["maxTokens"].is_null());
    }

    #[test]
    fn summarizes_and_merges_aicode_and_ccpa_quotas() {
        let cfg = json!({
            "availableExperiences": [
                {
                    "name": "claude-opus-5-5-high",
                    "model": {
                        "modelId": "claude-opus-5-5",
                        "displayName": "Claude Opus 5.5 (High)",
                        "inputTokenLimit": 1_000_000
                    }
                },
                {
                    "name": "disabled-exp",
                    "surfaceConfig": { "disabled": true },
                    "model": { "modelId": "disabled" }
                }
            ]
        });
        let status = json!({
            "buckets": [{
                "remainingFraction": 0.88,
                "resetTime": "2026-11-04T20:00:00Z",
                "model": { "modelId": "claude-opus-5-5" }
            }]
        });
        let aicode = summarize_aicode_quota(&cfg, Some(&status));
        let ccpa = summarize_quota(&json!({
            "models": {
                "gemini-4-argon-high": {
                    "displayName": "Gemini 4 Argon (High)",
                    "maxTokens": 1_048_576,
                    "quotaInfo": { "remainingFraction": 0.95, "resetTime": "2026-11-04T18:00:00Z" }
                }
            }
        }));
        let merged = merge_quota_models(Some(aicode), Some(ccpa));
        let models = merged["models"].as_array().unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0]["id"], "claude-opus-5-5-high");
        assert_eq!(models[0]["maxTokens"], 1_000_000);
        assert_eq!(models[0]["remainingFraction"], 0.88);
        assert_eq!(models[1]["id"], "gemini-4-argon-high");
        assert_eq!(normalize_user_tier(Some("Google AI Ultra")), "g1-ultra-tier");
        assert_eq!(normalize_user_tier(Some("Google AI Pro")), "g1-pro-tier");
        assert_eq!(normalize_user_tier(None), "free-tier");
    }
}
