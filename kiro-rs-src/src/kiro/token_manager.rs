//! Token 管理模块
//!
//! 负责 Token 过期检测和刷新，支持 Social 和 IdC 认证方式
//! 支持多凭据 (MultiTokenManager) 管理

use anyhow::bail;
use chrono::{DateTime, Duration, Utc};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex as TokioMutex;

use std::collections::HashMap;
use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration as StdDuration, Instant};

use crate::http_client::{ProxyConfig, build_client};
use crate::kiro::account_store::{
    AccountStore, NewAccountMeta, StoredCounters, UsageWrite, ms_to_rfc3339, rfc3339_to_ms,
};
use crate::kiro::machine_id;
use crate::kiro::model::credentials::KiroCredentials;
use crate::kiro::model::token_refresh::{
    IdcRefreshRequest, IdcRefreshResponse, RefreshRequest, RefreshResponse,
};
use crate::kiro::model::usage_limits::UsageLimitsResponse;
use crate::model::config::Config;

/// 检查 Token 是否在指定时间内过期
pub(crate) fn is_token_expiring_within(
    credentials: &KiroCredentials,
    minutes: i64,
) -> Option<bool> {
    credentials
        .expires_at
        .as_ref()
        .and_then(|expires_at| DateTime::parse_from_rfc3339(expires_at).ok())
        .map(|expires| expires <= Utc::now() + Duration::minutes(minutes))
}

/// 检查 Token 是否已过期（提前 5 分钟判断）
pub(crate) fn is_token_expired(credentials: &KiroCredentials) -> bool {
    is_token_expiring_within(credentials, 5).unwrap_or(true)
}

/// 检查 Token 是否即将过期（10分钟内）
pub(crate) fn is_token_expiring_soon(credentials: &KiroCredentials) -> bool {
    is_token_expiring_within(credentials, 10).unwrap_or(false)
}

fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let result = hasher.finalize();
    format!("{:x}", result)
}

/// 生成 API Key 脱敏展示(前 4 + ... + 后 4,长度不足或非 ASCII 回退 ***)
fn mask_api_key(key: &str) -> String {
    if key.is_ascii() && key.len() > 16 {
        format!("{}...{}", &key[..4], &key[key.len() - 4..])
    } else {
        "***".to_string()
    }
}

/// 验证 refreshToken 的基本有效性
pub(crate) fn validate_refresh_token(credentials: &KiroCredentials) -> anyhow::Result<()> {
    let refresh_token = credentials
        .refresh_token
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("缺少 refreshToken"))?;

    if refresh_token.is_empty() {
        bail!("refreshToken 为空");
    }

    if refresh_token.len() < 100 || refresh_token.ends_with("...") || refresh_token.contains("...")
    {
        bail!(
            "refreshToken 已被截断（长度: {} 字符）。\n\
             这通常是 Kiro IDE 为了防止凭证被第三方工具使用而故意截断的。",
            refresh_token.len()
        );
    }

    Ok(())
}

/// Refresh Token 永久失效错误
///
/// 当服务端返回 400 + `invalid_grant` 时，表示 refreshToken 已被撤销或过期，
/// 不应重试，需立即禁用对应凭据。
#[derive(Debug)]
pub(crate) struct RefreshTokenInvalidError {
    pub message: String,
}

impl fmt::Display for RefreshTokenInvalidError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for RefreshTokenInvalidError {}

/// 刷新 Token
pub(crate) async fn refresh_token(
    credentials: &KiroCredentials,
    config: &Config,
    proxy: Option<&ProxyConfig>,
) -> anyhow::Result<KiroCredentials> {
    // API Key 凭据不支持 Token 刷新：底层契约级拦截
    // 其他调用点（try_ensure_token / 活跃路径 / add_credential）在调用前已显式分流 API Key；
    // 仅 force_refresh_token_for 未分流，此处 bail 让错误自然传播为 400 BAD_REQUEST。
    if credentials.is_api_key_credential() {
        bail!("API Key 凭据不支持刷新 Token");
    }

    validate_refresh_token(credentials)?;

    // 根据 auth_method 选择刷新方式
    // 如果未指定 auth_method，根据是否有 clientId/clientSecret 自动判断
    let auth_method = credentials.auth_method.as_deref().unwrap_or_else(|| {
        if credentials.client_id.is_some() && credentials.client_secret.is_some() {
            "idc"
        } else {
            "social"
        }
    });

    if auth_method.eq_ignore_ascii_case("idc")
        || auth_method.eq_ignore_ascii_case("builder-id")
        || auth_method.eq_ignore_ascii_case("iam")
    {
        refresh_idc_token(credentials, config, proxy).await
    } else {
        refresh_social_token(credentials, config, proxy).await
    }
}

/// 刷新 Social Token
async fn refresh_social_token(
    credentials: &KiroCredentials,
    config: &Config,
    proxy: Option<&ProxyConfig>,
) -> anyhow::Result<KiroCredentials> {
    tracing::info!("正在刷新 Social Token...");

    let refresh_token = credentials.refresh_token.as_ref().unwrap();
    // 优先级：凭据.auth_region > 凭据.region > config.auth_region > config.region
    let region = credentials.effective_auth_region(config);

    let refresh_url = format!("https://prod.{}.auth.desktop.kiro.dev/refreshToken", region);
    let refresh_domain = format!("prod.{}.auth.desktop.kiro.dev", region);
    let machine_id = machine_id::generate_from_credentials(credentials, config);
    let kiro_version = &config.kiro_version;

    let client = build_client(proxy, 60, config.tls_backend)?;
    let body = RefreshRequest {
        refresh_token: refresh_token.to_string(),
    };

    let response = client
        .post(&refresh_url)
        .header("Accept", "application/json, text/plain, */*")
        .header("Content-Type", "application/json")
        .header(
            "User-Agent",
            format!("KiroIDE-{}-{}", kiro_version, machine_id),
        )
        .header("Accept-Encoding", "gzip, compress, deflate, br")
        .header("host", &refresh_domain)
        .header("Connection", "close")
        .json(&body)
        .send()
        .await?;

    let status = response.status();
    if !status.is_success() {
        let body_text = response.text().await.unwrap_or_default();

        // 400 + invalid_grant + Invalid refresh token provided → refreshToken 永久失效
        if status.as_u16() == 400
            && body_text.contains("\"invalid_grant\"")
            && body_text.contains("Invalid refresh token provided")
        {
            return Err(RefreshTokenInvalidError {
                message: format!("Social refreshToken 已失效 (invalid_grant): {}", body_text),
            }
            .into());
        }

        let error_msg = match status.as_u16() {
            401 => "OAuth 凭证已过期或无效，需要重新认证",
            403 => "权限不足，无法刷新 Token",
            429 => "请求过于频繁，已被限流",
            500..=599 => "服务器错误，AWS OAuth 服务暂时不可用",
            _ => "Token 刷新失败",
        };
        bail!("{}: {} {}", error_msg, status, body_text);
    }

    let data: RefreshResponse = response.json().await?;

    let mut new_credentials = credentials.clone();
    new_credentials.access_token = Some(data.access_token);

    if let Some(new_refresh_token) = data.refresh_token {
        new_credentials.refresh_token = Some(new_refresh_token);
    }

    if let Some(profile_arn) = data.profile_arn {
        new_credentials.profile_arn = Some(profile_arn);
    }

    if let Some(expires_in) = data.expires_in {
        let expires_at = Utc::now() + Duration::seconds(expires_in);
        new_credentials.expires_at = Some(expires_at.to_rfc3339());
    }

    Ok(new_credentials)
}

/// 刷新 IdC Token (AWS SSO OIDC)
async fn refresh_idc_token(
    credentials: &KiroCredentials,
    config: &Config,
    proxy: Option<&ProxyConfig>,
) -> anyhow::Result<KiroCredentials> {
    tracing::info!("正在刷新 IdC Token...");

    let refresh_token = credentials.refresh_token.as_ref().unwrap();
    let client_id = credentials
        .client_id
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("IdC 刷新需要 clientId"))?;
    let client_secret = credentials
        .client_secret
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("IdC 刷新需要 clientSecret"))?;

    // 优先级：凭据.auth_region > 凭据.region > config.auth_region > config.region
    let region = credentials.effective_auth_region(config);
    let refresh_url = format!("https://oidc.{}.amazonaws.com/token", region);
    let os_name = &config.system_version;
    let node_version = &config.node_version;

    let x_amz_user_agent = "aws-sdk-js/3.980.0 KiroIDE";
    let user_agent = format!(
        "aws-sdk-js/3.980.0 ua/2.1 os/{} lang/js md/nodejs#{} api/sso-oidc#3.980.0 m/E KiroIDE",
        os_name, node_version
    );

    let client = build_client(proxy, 60, config.tls_backend)?;
    let body = IdcRefreshRequest {
        client_id: client_id.to_string(),
        client_secret: client_secret.to_string(),
        refresh_token: refresh_token.to_string(),
        grant_type: "refresh_token".to_string(),
    };

    let response = client
        .post(&refresh_url)
        .header("content-type", "application/json")
        .header("x-amz-user-agent", x_amz_user_agent)
        .header("user-agent", &user_agent)
        .header("host", format!("oidc.{}.amazonaws.com", region))
        .header("amz-sdk-invocation-id", uuid::Uuid::new_v4().to_string())
        .header("amz-sdk-request", "attempt=1; max=4")
        .header("Connection", "close")
        .json(&body)
        .send()
        .await?;

    let status = response.status();
    if !status.is_success() {
        let body_text = response.text().await.unwrap_or_default();

        // 400 + invalid_grant + Invalid refresh token provided → refreshToken 永久失效
        if status.as_u16() == 400
            && body_text.contains("\"invalid_grant\"")
            && body_text.contains("Invalid refresh token provided")
        {
            return Err(RefreshTokenInvalidError {
                message: format!("IdC refreshToken 已失效 (invalid_grant): {}", body_text),
            }
            .into());
        }

        let error_msg = match status.as_u16() {
            401 => "IdC 凭证已过期或无效，需要重新认证",
            403 => "权限不足，无法刷新 Token",
            429 => "请求过于频繁，已被限流",
            500..=599 => "服务器错误，AWS OIDC 服务暂时不可用",
            _ => "IdC Token 刷新失败",
        };
        bail!("{}: {} {}", error_msg, status, body_text);
    }

    let data: IdcRefreshResponse = response.json().await?;

    let mut new_credentials = credentials.clone();
    new_credentials.access_token = Some(data.access_token);

    if let Some(new_refresh_token) = data.refresh_token {
        new_credentials.refresh_token = Some(new_refresh_token);
    }

    if let Some(expires_in) = data.expires_in {
        let expires_at = Utc::now() + Duration::seconds(expires_in);
        new_credentials.expires_at = Some(expires_at.to_rfc3339());
    }

    // 同步更新 profile_arn（如果 IdC 响应中包含）
    if let Some(profile_arn) = data.profile_arn {
        new_credentials.profile_arn = Some(profile_arn);
    }

    Ok(new_credentials)
}

/// 保留额度接口的 HTTP 状态，认证重试不依赖响应正文匹配。
#[derive(Debug)]
pub(crate) struct UsageLimitsHttpError {
    pub status: u16,
    message: String,
}

impl fmt::Display for UsageLimitsHttpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for UsageLimitsHttpError {}

/// 获取使用额度信息
pub(crate) async fn get_usage_limits(
    credentials: &KiroCredentials,
    config: &Config,
    token: &str,
    proxy: Option<&ProxyConfig>,
) -> anyhow::Result<UsageLimitsResponse> {
    tracing::debug!("正在获取使用额度信息...");

    // 优先级：凭据.api_region > config.api_region > config.region
    let region = credentials.effective_api_region(config);
    let host = format!("q.{}.amazonaws.com", region);
    let machine_id = machine_id::generate_from_credentials(credentials, config);
    let kiro_version = &config.kiro_version;
    let os_name = &config.system_version;
    let node_version = &config.node_version;

    // 构建 URL
    let mut url = format!(
        "https://{}/getUsageLimits?origin=AI_EDITOR&resourceType=AGENTIC_REQUEST&isEmailRequired=true",
        host
    );

    // profileArn 是可选的
    if let Some(profile_arn) = &credentials.profile_arn {
        url.push_str(&format!("&profileArn={}", urlencoding::encode(profile_arn)));
    }

    // 构建 User-Agent headers
    let user_agent = format!(
        "aws-sdk-js/1.0.0 ua/2.1 os/{} lang/js md/nodejs#{} api/codewhispererruntime#1.0.0 m/N,E KiroIDE-{}-{}",
        os_name, node_version, kiro_version, machine_id
    );
    let amz_user_agent = format!("aws-sdk-js/1.0.0 KiroIDE-{}-{}", kiro_version, machine_id);

    let client = build_client(proxy, 60, config.tls_backend)?;

    let mut request = client
        .get(&url)
        .header("x-amz-user-agent", &amz_user_agent)
        .header("user-agent", &user_agent)
        .header("host", &host)
        .header("amz-sdk-invocation-id", uuid::Uuid::new_v4().to_string())
        .header("amz-sdk-request", "attempt=1; max=1")
        .header("Authorization", format!("Bearer {}", token))
        .header("Connection", "close");

    if credentials.is_api_key_credential() {
        request = request.header("tokentype", "API_KEY");
    }

    let response = request.send().await?;

    let status = response.status();
    if !status.is_success() {
        let body_text = response.text().await.unwrap_or_default();
        let error_msg = match status.as_u16() {
            401 => "认证失败，Token 无效或已过期",
            403 => "权限不足，无法获取使用额度",
            429 => "请求过于频繁，已被限流",
            500..=599 => "服务器错误，AWS 服务暂时不可用",
            _ => "获取使用额度失败",
        };
        return Err(UsageLimitsHttpError {
            status: status.as_u16(),
            message: format!("{}: {} {}", error_msg, status, body_text),
        }
        .into());
    }

    let raw: serde_json::Value = response.json().await?;
    let mut data: UsageLimitsResponse = serde_json::from_value(raw.clone())?;
    data.raw = raw;
    Ok(data)
}

// ============================================================================
// 多凭据 Token 管理器
// ============================================================================

/// 单个凭据条目的状态
struct CredentialEntry {
    /// 凭据唯一 ID
    id: u64,
    /// 凭据信息
    credentials: KiroCredentials,
    /// 新增条目写盘完成前，快照不得发布其临时身份。
    identity_pending: bool,
    /// API 调用连续失败次数
    failure_count: u32,
    /// Token 刷新连续失败次数
    refresh_failure_count: u32,
    /// 是否已禁用
    disabled: bool,
    /// 禁用原因（用于区分手动禁用 vs 自动禁用，便于自愈）
    disabled_reason: Option<DisabledReason>,
    /// API 调用成功次数
    success_count: u64,
    /// 最后一次 API 调用时间（RFC3339 格式）
    last_used_at: Option<String>,
    /// 经本反代成功调用累计的输入 tokens
    ///
    /// 与账号额度（`/balance` 的 currentUsage）的区别：额度是账号总消耗，
    /// 号被别处共用时会一起涨；这里只累加走本反代的请求，可用于回答
    /// 「我自己消耗了多少」。
    input_tokens: u64,
    /// 经本反代成功调用累计的输出 tokens
    output_tokens: u64,
    /// 是否在反代号池中（共享账号库模式下由 in_pool 决定；JSON 模式恒为 true）
    in_pool: bool,
    /// 账号库中的凭据版本，刷新结果按它做条件写（JSON 模式恒为 0）
    credential_version: i64,
}

impl CredentialEntry {
    /// 可参与反代调度：未禁用且在号池中
    fn schedulable(&self) -> bool {
        !self.disabled && self.in_pool
    }
}

/// 禁用原因
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DisabledReason {
    /// Admin API 手动禁用
    Manual,
    /// 连续失败达到阈值后自动禁用
    TooManyFailures,
    /// Token 刷新连续失败达到阈值后自动禁用
    TooManyRefreshFailures,
    /// 额度已用尽（如 MONTHLY_REQUEST_COUNT）
    QuotaExceeded,
    /// Refresh Token 永久失效（服务端返回 invalid_grant）
    InvalidRefreshToken,
    /// 凭据配置无效（如 authMethod=api_key 但缺少 kiroApiKey）
    InvalidConfig,
}

impl DisabledReason {
    fn as_str(self) -> &'static str {
        match self {
            DisabledReason::Manual => "Manual",
            DisabledReason::TooManyFailures => "TooManyFailures",
            DisabledReason::TooManyRefreshFailures => "TooManyRefreshFailures",
            DisabledReason::QuotaExceeded => "QuotaExceeded",
            DisabledReason::InvalidRefreshToken => "InvalidRefreshToken",
            DisabledReason::InvalidConfig => "InvalidConfig",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "Manual" => DisabledReason::Manual,
            "TooManyFailures" => DisabledReason::TooManyFailures,
            "TooManyRefreshFailures" => DisabledReason::TooManyRefreshFailures,
            "QuotaExceeded" => DisabledReason::QuotaExceeded,
            "InvalidRefreshToken" => DisabledReason::InvalidRefreshToken,
            "InvalidConfig" => DisabledReason::InvalidConfig,
            _ => return None,
        })
    }
}

/// 统计数据持久化条目
///
/// token 字段用 `#[serde(default)]`：老的 kiro_stats.json 没有这两个键，
/// 缺失时按 0 读入，不会让整份统计解析失败。
#[derive(Serialize, Deserialize)]
struct StatsEntry {
    success_count: u64,
    last_used_at: Option<String>,
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
}

// ============================================================================
// Admin API 公开结构
// ============================================================================

/// 凭据条目快照（用于 Admin API 读取）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialEntrySnapshot {
    /// 凭据唯一 ID
    pub id: u64,
    pub credential_identity: Option<String>,
    /// 优先级
    pub priority: u32,
    /// 是否被禁用
    pub disabled: bool,
    /// 连续失败次数
    pub failure_count: u32,
    /// 认证方式
    pub auth_method: Option<String>,
    /// 是否有 Profile ARN
    pub has_profile_arn: bool,
    /// Token 过期时间
    pub expires_at: Option<String>,
    /// refreshToken 的 SHA-256 哈希（仅 OAuth 凭据，用于前端去重）
    pub refresh_token_hash: Option<String>,
    /// kiroApiKey 的 SHA-256 哈希（仅 API Key 凭据，用于前端去重）
    pub api_key_hash: Option<String>,
    /// kiroApiKey 的脱敏展示（仅 API Key 凭据，用于前端显示）
    pub masked_api_key: Option<String>,
    /// 用户邮箱（用于前端显示）
    pub email: Option<String>,
    /// API 调用成功次数
    pub success_count: u64,
    /// 最后一次 API 调用时间（RFC3339 格式）
    pub last_used_at: Option<String>,
    /// 经本反代成功调用累计的输入 tokens（不含别处共用该号的消耗）
    pub input_tokens: u64,
    /// 经本反代成功调用累计的输出 tokens
    pub output_tokens: u64,
    /// 经本反代消耗的账号额度（Kiro 积分）累计值，估算量
    /// 是否配置了凭据级代理
    pub has_proxy: bool,
    /// 代理 URL（用于前端展示）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy_url: Option<String>,
    /// Token 刷新连续失败次数
    pub refresh_failure_count: u32,
    /// 禁用原因
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disabled_reason: Option<String>,
    /// 端点名称（未显式配置时返回 None，由 Admin 层回退到默认值）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    /// 实际生效的 Auth Region（Token 刷新用），已按凭据 → 全局的优先级回退完毕
    pub auth_region: String,
    /// 实际生效的 API Region（API 请求用），已按凭据 → 全局的优先级回退完毕
    pub api_region: String,
    /// 是否在反代号池中
    pub in_pool: bool,
    /// 账号库中的凭据版本（proxy-rs 请求"确保新鲜"时回传）
    pub credential_version: i64,
}

/// 凭据管理器状态快照
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagerSnapshot {
    /// 凭据条目列表
    pub entries: Vec<CredentialEntrySnapshot>,
    /// 当前活跃凭据 ID
    pub current_id: u64,
    /// 总凭据数量
    pub total: usize,
    /// 可用凭据数量
    pub available: usize,
}

/// 多凭据 Token 管理器
///
/// 支持多个凭据的管理，实现固定优先级 + 故障转移策略
/// 故障统计基于 API 调用结果，而非 Token 刷新结果
pub struct MultiTokenManager {
    config: Config,
    proxy: Option<ProxyConfig>,
    /// 凭据条目列表
    entries: Mutex<Vec<CredentialEntry>>,
    /// 当前活动凭据 ID
    current_id: Mutex<u64>,
    /// Token 刷新锁，确保同一时间只有一个刷新操作
    refresh_lock: TokioMutex<()>,
    /// 凭据文件路径（用于回写）
    credentials_path: Option<PathBuf>,
    /// 是否为多凭据格式（数组格式才回写）
    is_multiple_format: bool,
    /// 负载均衡模式（运行时可修改）
    load_balancing_mode: Mutex<String>,
    /// 最近一次统计持久化时间（用于 debounce）
    last_stats_save_at: Mutex<Option<Instant>>,
    /// 统计数据是否有未落盘更新
    stats_dirty: AtomicBool,
    /// 会话粘性映射：session hint → (凭据 id, 最后命中时间)
    ///
    /// 同一会话尽量复用同一凭据，以保留上游 prompt cache 命中。
    /// 仅在 `config.session_affinity_enabled` 为真时写入与读取。
    session_affinity: Mutex<HashMap<String, (u64, Instant)>>,
    /// 共享账号库；Some 时凭据、禁用原因、统计、额度都读写库，不再读写 JSON 文件
    store: Option<Arc<AccountStore>>,
}

/// 每个凭据最大 API 调用失败次数
const MAX_FAILURES_PER_CREDENTIAL: u32 = 3;
/// 统计数据持久化防抖间隔
const STATS_SAVE_DEBOUNCE: StdDuration = StdDuration::from_secs(30);
/// 会话粘性条目的存活时间
///
/// 超过该时长未命中的会话映射视为过期：上游 prompt cache 本身也有生命周期，
/// 长期粘住已失效的会话只会让负载长期倾斜到单一凭据。
const SESSION_AFFINITY_TTL: StdDuration = StdDuration::from_secs(600);
/// 会话粘性映射的最大条目数，超出后按最久未命中顺序淘汰
const SESSION_AFFINITY_MAX_ENTRIES: usize = 1024;

/// 导入凭据的结果
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImportOutcome {
    pub id: u64,
    /// 新建了一行
    pub created: bool,
    /// 按上游身份命中已有账号并替换了凭据（重新登录）
    pub replaced: bool,
}

/// API 调用上下文
///
/// 绑定特定凭据的调用上下文，确保 token、credentials 和 id 的一致性
/// 用于解决并发调用时 current_id 竞态问题
#[derive(Clone)]
pub struct CallContext {
    /// 凭据 ID（用于 report_success/report_failure）
    pub id: u64,
    /// 凭据信息（用于构建请求头）
    pub credentials: KiroCredentials,
    /// 访问 Token
    pub token: String,
}

impl MultiTokenManager {
    /// 创建多凭据 Token 管理器
    ///
    /// # Arguments
    /// * `config` - 应用配置
    /// * `credentials` - 凭据列表
    /// * `proxy` - 可选的代理配置
    /// * `credentials_path` - 凭据文件路径（用于回写）
    /// * `is_multiple_format` - 是否为多凭据格式（数组格式才回写）
    pub fn new(
        config: Config,
        credentials: Vec<KiroCredentials>,
        proxy: Option<ProxyConfig>,
        credentials_path: Option<PathBuf>,
        is_multiple_format: bool,
    ) -> anyhow::Result<Self> {
        // 计算当前最大 ID，为没有 ID 的凭据分配新 ID
        let max_existing_id = credentials.iter().filter_map(|c| c.id).max().unwrap_or(0);
        let mut next_id = max_existing_id + 1;
        let mut has_new_ids = false;
        let mut has_new_machine_ids = false;
        let mut new_identity_ids = Vec::new();
        let config_ref = &config;

        let entries: Vec<CredentialEntry> = credentials
            .into_iter()
            .map(|mut cred| {
                cred.canonicalize_auth_method();
                let id = cred.id.unwrap_or_else(|| {
                    let id = next_id;
                    next_id += 1;
                    cred.id = Some(id);
                    has_new_ids = true;
                    id
                });
                if cred
                    .credential_identity
                    .as_deref()
                    .is_none_or(|value| value.trim().is_empty())
                {
                    cred.credential_identity = Some(uuid::Uuid::new_v4().to_string());
                    new_identity_ids.push(id);
                }
                if cred.machine_id.is_none() {
                    cred.machine_id =
                        Some(machine_id::generate_from_credentials(&cred, config_ref));
                    has_new_machine_ids = true;
                }
                CredentialEntry {
                    id,
                    identity_pending: false,
                    credentials: cred.clone(),
                    failure_count: 0,
                    refresh_failure_count: 0,
                    disabled: cred.disabled, // 从配置文件读取 disabled 状态
                    disabled_reason: if cred.disabled {
                        Some(DisabledReason::Manual)
                    } else {
                        None
                    },
                    success_count: 0,
                    last_used_at: None,
                    input_tokens: 0,
                    output_tokens: 0,
                    in_pool: true,
                    credential_version: 0,
                }
            })
            .collect();

        // 校验 API Key 凭据配置完整性：authMethod=api_key 时必须提供 kiroApiKey
        let mut entries = entries;
        for entry in &mut entries {
            if entry.credentials.kiro_api_key.is_none()
                && entry
                    .credentials
                    .auth_method
                    .as_deref()
                    .map(|m| m.eq_ignore_ascii_case("api_key") || m.eq_ignore_ascii_case("apikey"))
                    .unwrap_or(false)
            {
                tracing::warn!(
                    "凭据 #{} 配置了 authMethod=api_key 但缺少 kiroApiKey 字段，已自动禁用",
                    entry.id
                );
                entry.disabled = true;
                entry.disabled_reason = Some(DisabledReason::InvalidConfig);
            }
        }

        // 检测重复 ID
        let mut seen_ids = std::collections::HashSet::new();
        let mut duplicate_ids = Vec::new();
        for entry in &entries {
            if !seen_ids.insert(entry.id) {
                duplicate_ids.push(entry.id);
            }
        }
        if !duplicate_ids.is_empty() {
            anyhow::bail!("检测到重复的凭据 ID: {:?}", duplicate_ids);
        }

        // 选择初始凭据：优先级最高（priority 最小）的可用凭据，无可用凭据时为 0
        let initial_id = entries
            .iter()
            .filter(|e| e.schedulable())
            .min_by_key(|e| e.credentials.priority)
            .map(|e| e.id)
            .unwrap_or(0);

        let load_balancing_mode = config.load_balancing_mode.clone();
        let manager = Self {
            config,
            proxy,
            entries: Mutex::new(entries),
            current_id: Mutex::new(initial_id),
            refresh_lock: TokioMutex::new(()),
            credentials_path,
            is_multiple_format,
            load_balancing_mode: Mutex::new(load_balancing_mode),
            last_stats_save_at: Mutex::new(None),
            stats_dirty: AtomicBool::new(false),
            session_affinity: Mutex::new(HashMap::new()),
            store: None,
        };

        // 补全的 ID、machineId 和稳定身份必须写回，重启后继续使用同一身份。
        if has_new_ids || has_new_machine_ids || !new_identity_ids.is_empty() {
            let persisted = manager.persist_credentials();
            if !matches!(persisted, Ok(true)) {
                // 未写盘的随机身份不能对外发布，否则重启后会被误判为凭据重建。
                for entry in manager.entries.lock().iter_mut() {
                    if new_identity_ids.contains(&entry.id) {
                        entry.credentials.credential_identity = None;
                    }
                }
            }
            if let Err(e) = persisted {
                tracing::warn!("补全凭据身份持久化失败，新身份暂不发布: {}", e);
            }
        }

        // 加载持久化的统计数据（success_count, last_used_at）
        manager.load_stats();

        Ok(manager)
    }

    /// 从共享账号库创建管理器（凭据、禁用原因、统计、额度都读写库）
    pub fn new_with_store(
        config: Config,
        store: Arc<AccountStore>,
        proxy: Option<ProxyConfig>,
    ) -> anyhow::Result<Self> {
        let stale = store.clear_stale_refresh_marks()?;
        if !stale.is_empty() {
            // 上次退出时刷新仍在途：上游可能已轮换。下一次需要时用库里现有的
            // refresh token 重试；若返回 invalid_grant 会按 InvalidRefreshToken 禁用。
            tracing::warn!("以下凭据上次刷新未完成，将按库中凭据重试: {:?}", stale);
        }

        let mut entries = Vec::new();
        for row in store.load_all()? {
            let mut cred = row.credentials;
            cred.canonicalize_auth_method();
            let id = cred.id.expect("账号库行必有 id");
            if cred.machine_id.is_none() {
                let generated = machine_id::generate_from_credentials(&cred, &config);
                store.set_machine_id(id, &generated)?;
                cred.machine_id = Some(generated);
            }
            let mut disabled_reason = row
                .disabled_reason
                .as_deref()
                .and_then(DisabledReason::parse)
                .or(cred.disabled.then_some(DisabledReason::Manual));
            let mut disabled = cred.disabled;
            if cred.is_api_key_credential() && cred.kiro_api_key.is_none() {
                disabled = true;
                disabled_reason = Some(DisabledReason::InvalidConfig);
            }
            entries.push(CredentialEntry {
                id,
                credentials: cred,
                identity_pending: false,
                failure_count: 0,
                refresh_failure_count: 0,
                disabled,
                disabled_reason,
                success_count: row.counters.success_count,
                last_used_at: ms_to_rfc3339(row.counters.last_used_at_ms),
                input_tokens: row.counters.input_tokens,
                output_tokens: row.counters.output_tokens,
                in_pool: row.in_pool,
                credential_version: row.credential_version,
            });
        }

        let initial_id = entries
            .iter()
            .filter(|e| e.schedulable())
            .min_by_key(|e| e.credentials.priority)
            .map(|e| e.id)
            .unwrap_or(0);
        tracing::info!(
            "已从账号库加载 {} 个账号（号池中 {} 个）: {}",
            entries.len(),
            entries.iter().filter(|e| e.in_pool).count(),
            store.path().display()
        );

        let load_balancing_mode = config.load_balancing_mode.clone();
        Ok(Self {
            config,
            proxy,
            entries: Mutex::new(entries),
            current_id: Mutex::new(initial_id),
            refresh_lock: TokioMutex::new(()),
            credentials_path: None,
            is_multiple_format: true,
            load_balancing_mode: Mutex::new(load_balancing_mode),
            last_stats_save_at: Mutex::new(Some(Instant::now())),
            stats_dirty: AtomicBool::new(false),
            session_affinity: Mutex::new(HashMap::new()),
            store: Some(store),
        })
    }

    /// 共享账号库（仅账号库模式）
    pub fn account_store(&self) -> Option<&Arc<AccountStore>> {
        self.store.as_ref()
    }

    /// 把单个条目的禁用状态写入账号库（JSON 模式为空操作，沿用 persist_credentials）
    fn persist_entry_state(&self, id: u64) {
        let Some(store) = &self.store else { return };
        let state = {
            let entries = self.entries.lock();
            entries.iter().find(|e| e.id == id).map(|e| {
                (
                    e.disabled
                        .then(|| e.disabled_reason.unwrap_or(DisabledReason::Manual).as_str()),
                    e.failure_count,
                    e.refresh_failure_count,
                )
            })
        };
        if let Some((reason, failures, refresh_failures)) = state {
            if let Err(e) = store.set_enabled_state(id, reason, failures, refresh_failures) {
                tracing::warn!("凭据 #{} 禁用状态写入账号库失败: {}", id, e);
            }
        }
    }

    /// Admin 修改禁用状态后的持久化：库模式写库并传播错误，JSON 模式整文件回写
    fn persist_state_or_credentials(&self, id: u64) -> anyhow::Result<()> {
        let Some(store) = &self.store else {
            self.persist_credentials()?;
            return Ok(());
        };
        let (reason, failures, refresh_failures) = {
            let entries = self.entries.lock();
            let e = entries
                .iter()
                .find(|e| e.id == id)
                .ok_or_else(|| anyhow::anyhow!("凭据不存在: {}", id))?;
            (
                e.disabled
                    .then(|| e.disabled_reason.unwrap_or(DisabledReason::Manual).as_str()),
                e.failure_count,
                e.refresh_failure_count,
            )
        };
        store.set_enabled_state(id, reason, failures, refresh_failures)
    }

    /// 执行一次上游刷新并落盘（库模式按版本条件写）。
    ///
    /// 调用方必须已持有 `refresh_lock`。库模式下先写在途标记再发请求，
    /// 事务不跨网络；失败时清掉在途标记。
    async fn refresh_and_store(
        &self,
        id: u64,
        current: &KiroCredentials,
    ) -> anyhow::Result<KiroCredentials> {
        let base_version = match &self.store {
            Some(store) => Some(store.begin_refresh(id)?),
            None => None,
        };
        let effective_proxy = current.effective_proxy(self.proxy.as_ref());
        let refreshed = refresh_token(current, &self.config, effective_proxy.as_ref()).await;
        let new_creds = match refreshed {
            Ok(creds) if !is_token_expired(&creds) => creds,
            other => {
                if let Some(store) = &self.store {
                    if let Err(e) = store.end_refresh(id) {
                        tracing::warn!("凭据 #{} 清除刷新标记失败: {}", id, e);
                    }
                }
                return match other {
                    Err(e) => Err(e),
                    Ok(_) => Err(anyhow::anyhow!("刷新后的 Token 仍然无效或已过期")),
                };
            }
        };

        if let Some(store) = &self.store {
            // 上游已轮换：这一步必须成功，否则新 refresh token 会丢
            let version = store.save_rotated_credentials(id, base_version, &new_creds)?;
            let mut entries = self.entries.lock();
            if let Some(entry) = entries.iter_mut().find(|e| e.id == id) {
                entry.credentials = new_creds.clone();
                entry.credential_version = version;
            }
        } else {
            {
                let mut entries = self.entries.lock();
                if let Some(entry) = entries.iter_mut().find(|e| e.id == id) {
                    entry.credentials = new_creds.clone();
                }
            }
            if let Err(e) = self.persist_credentials() {
                tracing::warn!("Token 刷新后持久化失败（不影响本次请求）: {}", e);
            }
        }
        Ok(new_creds)
    }

    /// 获取配置的引用
    pub fn config(&self) -> &Config {
        &self.config
    }

    /// 获取凭据总数
    pub fn total_count(&self) -> usize {
        self.entries.lock().len()
    }

    /// 获取可用凭据数量
    pub fn available_count(&self) -> usize {
        self.entries
            .lock()
            .iter()
            .filter(|e| e.schedulable())
            .count()
    }

    /// 查询会话粘性映射中该 hint 对应的可用凭据
    ///
    /// 命中要求：映射未过期、凭据存在且未禁用、且支持当前模型。
    /// 任一不满足即返回 `None`，由调用方回退到常规负载均衡选择。
    ///
    /// 命中时会刷新该条目的最后命中时间，使活跃会话不被 TTL 淘汰。
    fn lookup_affinity(&self, hint: &str, model: Option<&str>) -> Option<(u64, KiroCredentials)> {
        if !self.config.session_affinity_enabled {
            return None;
        }

        let id = {
            let mut affinity = self.session_affinity.lock();
            let (id, last_seen) = *affinity.get(hint)?;
            if last_seen.elapsed() > SESSION_AFFINITY_TTL {
                affinity.remove(hint);
                return None;
            }
            // 续期：活跃会话应持续粘住
            affinity.insert(hint.to_string(), (id, Instant::now()));
            id
        };

        let is_opus = model
            .map(|m| m.to_lowercase().contains("opus"))
            .unwrap_or(false);

        let entries = self.entries.lock();
        let entry = entries.iter().find(|e| e.id == id)?;
        if !entry.schedulable() {
            return None;
        }
        if is_opus && !entry.credentials.supports_opus() {
            return None;
        }
        Some((entry.id, entry.credentials.clone()))
    }

    /// 记录会话粘性：hint → 凭据 id
    ///
    /// 条目数超过上限时按最久未命中顺序淘汰，避免长期运行下无界增长。
    fn remember_affinity(&self, hint: &str, id: u64) {
        if !self.config.session_affinity_enabled {
            return;
        }

        let mut affinity = self.session_affinity.lock();
        let now = Instant::now();

        // 先清理过期条目，多数情况下这一步就能腾出空间
        affinity.retain(|_, (_, last_seen)| last_seen.elapsed() <= SESSION_AFFINITY_TTL);

        // 仍超上限时淘汰最久未命中的条目
        while affinity.len() >= SESSION_AFFINITY_MAX_ENTRIES {
            let oldest = affinity
                .iter()
                .min_by_key(|(_, (_, last_seen))| *last_seen)
                .map(|(k, _)| k.clone());
            match oldest {
                Some(k) => {
                    affinity.remove(&k);
                }
                None => break,
            }
        }

        affinity.insert(hint.to_string(), (id, now));
    }

    /// 解除某会话的粘性绑定（粘住的凭据失败时调用，避免反复撞同一张）
    fn forget_affinity(&self, hint: &str) {
        if !self.config.session_affinity_enabled {
            return;
        }
        self.session_affinity.lock().remove(hint);
    }

    /// 当前会话粘性映射的条目数（用于测试与可观测性）
    #[cfg(test)]
    pub fn affinity_entry_count(&self) -> usize {
        self.session_affinity.lock().len()
    }

    /// 根据负载均衡模式选择下一个凭据
    ///
    /// - priority 模式：选择优先级最高（priority 最小）的可用凭据
    /// - balanced 模式：均衡选择可用凭据
    ///
    /// # 参数
    /// - `model`: 可选的模型名称，用于过滤支持该模型的凭据（如 opus 模型需要付费订阅）
    fn select_next_credential(&self, model: Option<&str>) -> Option<(u64, KiroCredentials)> {
        let entries = self.entries.lock();

        // 检查是否是 opus 模型
        let is_opus = model
            .map(|m| m.to_lowercase().contains("opus"))
            .unwrap_or(false);

        // 过滤可用凭据
        let available: Vec<_> = entries
            .iter()
            .filter(|e| {
                if !e.schedulable() {
                    return false;
                }
                // 如果是 opus 模型，需要检查订阅等级
                if is_opus && !e.credentials.supports_opus() {
                    return false;
                }
                true
            })
            .collect();

        if available.is_empty() {
            return None;
        }

        let mode = self.load_balancing_mode.lock().clone();
        let mode = mode.as_str();

        match mode {
            "balanced" => {
                // Least-Used 策略：选择成功次数最少的凭据
                // 平局时按优先级排序（数字越小优先级越高）
                let entry = available
                    .iter()
                    .min_by_key(|e| (e.success_count, e.credentials.priority))?;

                Some((entry.id, entry.credentials.clone()))
            }
            _ => {
                // priority 模式（默认）：选择优先级最高的
                let entry = available.iter().min_by_key(|e| e.credentials.priority)?;
                Some((entry.id, entry.credentials.clone()))
            }
        }
    }

    /// 获取 API 调用上下文
    ///
    /// 返回绑定了 id、credentials 和 token 的调用上下文
    /// 确保整个 API 调用过程中使用一致的凭据信息
    ///
    /// 如果 Token 过期或即将过期，会自动刷新
    /// Token 刷新失败会累计到当前凭据，达到阈值后禁用并切换
    ///
    /// # 参数
    /// - `model`: 可选的模型名称，用于过滤支持该模型的凭据（如 opus 模型需要付费订阅）
    pub async fn acquire_context(&self, model: Option<&str>) -> anyhow::Result<CallContext> {
        self.acquire_context_with_affinity(model, None).await
    }

    /// 获取 API 调用上下文，可指定会话粘性 hint
    ///
    /// 与 [`Self::acquire_context`] 的唯一区别：`session_hint` 非空且会话粘性
    /// 已启用时，优先复用该会话上次成功使用的凭据（保留上游 prompt cache）。
    /// 粘住的凭据不可用时无声回退到常规负载均衡选择。
    pub async fn acquire_context_with_affinity(
        &self,
        model: Option<&str>,
        session_hint: Option<&str>,
    ) -> anyhow::Result<CallContext> {
        let total = self.total_count();
        let max_attempts = (total * MAX_FAILURES_PER_CREDENTIAL as usize).max(1);
        let mut attempt_count = 0;

        loop {
            if attempt_count >= max_attempts {
                anyhow::bail!(
                    "所有凭据均无法获取有效 Token（可用: {}/{}）",
                    self.available_count(),
                    total
                );
            }

            let (id, credentials) = {
                // 会话粘性优先：命中则跳过常规选择，保留 prompt cache
                let sticky = session_hint.and_then(|hint| self.lookup_affinity(hint, model));

                if let Some(hit) = sticky {
                    hit
                } else {
                    let is_balanced = self.load_balancing_mode.lock().as_str() == "balanced";

                    // balanced 模式：每次请求都重新均衡选择，不固定 current_id
                    // priority 模式：优先使用 current_id 指向的凭据
                    let current_hit = if is_balanced {
                        None
                    } else {
                        let entries = self.entries.lock();
                        let current_id = *self.current_id.lock();
                        entries
                            .iter()
                            .find(|e| e.id == current_id && e.schedulable())
                            .map(|e| (e.id, e.credentials.clone()))
                    };

                    if let Some(hit) = current_hit {
                        hit
                    } else {
                        // 当前凭据不可用或 balanced 模式，根据负载均衡策略选择
                        let mut best = self.select_next_credential(model);

                        // 没有可用凭据：如果是"自动禁用导致全灭"，做一次类似重启的自愈
                        if best.is_none() {
                            let mut entries = self.entries.lock();
                            if entries.iter().any(|e| {
                                e.disabled
                                    && e.disabled_reason == Some(DisabledReason::TooManyFailures)
                            }) {
                                tracing::warn!(
                                    "所有凭据均已被自动禁用，执行自愈：重置失败计数并重新启用（等价于重启）"
                                );
                                for e in entries.iter_mut() {
                                    if e.disabled_reason == Some(DisabledReason::TooManyFailures) {
                                        e.disabled = false;
                                        e.disabled_reason = None;
                                        e.failure_count = 0;
                                    }
                                }
                                let healed: Vec<u64> = entries
                                    .iter()
                                    .filter(|e| !e.disabled && e.failure_count == 0)
                                    .map(|e| e.id)
                                    .collect();
                                drop(entries);
                                for healed_id in healed {
                                    self.persist_entry_state(healed_id);
                                }
                                best = self.select_next_credential(model);
                            }
                        }

                        if let Some((new_id, new_creds)) = best {
                            // 更新 current_id
                            let mut current_id = self.current_id.lock();
                            *current_id = new_id;
                            (new_id, new_creds)
                        } else {
                            let entries = self.entries.lock();
                            // 注意：必须在 bail! 之前计算 available_count，
                            // 因为 available_count() 会尝试获取 entries 锁，
                            // 而此时我们已经持有该锁，会导致死锁
                            let available = entries.iter().filter(|e| e.schedulable()).count();
                            anyhow::bail!("所有凭据均已禁用（{}/{}）", available, total);
                        }
                    }
                }
            };

            // 尝试获取/刷新 Token
            match self.try_ensure_token(id, &credentials).await {
                Ok(ctx) => {
                    // 记录会话粘性，使该会话后续请求复用同一凭据
                    if let Some(hint) = session_hint {
                        self.remember_affinity(hint, id);
                    }
                    return Ok(ctx);
                }
                Err(e) => {
                    // 粘住的凭据取 token 失败：解绑，避免该会话反复撞同一张
                    if let Some(hint) = session_hint {
                        self.forget_affinity(hint);
                    }
                    // refreshToken 永久失效 → 立即禁用，不累计重试
                    let has_available = if e.downcast_ref::<RefreshTokenInvalidError>().is_some() {
                        tracing::warn!("凭据 #{} refreshToken 永久失效: {}", id, e);
                        self.report_refresh_token_invalid(id)
                    } else {
                        tracing::warn!("凭据 #{} Token 刷新失败: {}", id, e);
                        self.report_refresh_failure(id)
                    };
                    attempt_count += 1;
                    if !has_available {
                        anyhow::bail!("所有凭据均已禁用（0/{}）", total);
                    }
                }
            }
        }
    }

    /// 选择优先级最高的未禁用凭据作为当前凭据（内部方法）
    ///
    /// 纯粹按优先级选择，不排除当前凭据，用于优先级变更后立即生效
    fn select_highest_priority(&self) {
        let entries = self.entries.lock();
        let mut current_id = self.current_id.lock();

        // 选择优先级最高的未禁用凭据（不排除当前凭据）
        if let Some(best) = entries
            .iter()
            .filter(|e| e.schedulable())
            .min_by_key(|e| e.credentials.priority)
        {
            if best.id != *current_id {
                tracing::info!(
                    "优先级变更后切换凭据: #{} -> #{}（优先级 {}）",
                    *current_id,
                    best.id,
                    best.credentials.priority
                );
                *current_id = best.id;
            }
        }
    }

    /// 尝试使用指定凭据获取有效 Token
    ///
    /// 使用双重检查锁定模式，确保同一时间只有一个刷新操作
    ///
    /// # Arguments
    /// * `id` - 凭据 ID，用于更新正确的条目
    /// * `credentials` - 凭据信息
    async fn try_ensure_token(
        &self,
        id: u64,
        credentials: &KiroCredentials,
    ) -> anyhow::Result<CallContext> {
        // API Key 凭据直接使用 kiro_api_key 作为 Bearer Token，无需刷新
        if credentials.is_api_key_credential() {
            let token = credentials
                .kiro_api_key
                .clone()
                .ok_or_else(|| anyhow::anyhow!("API Key 凭据缺少 kiroApiKey"))?;
            return Ok(CallContext {
                id,
                credentials: credentials.clone(),
                token,
            });
        }

        // 第一次检查（无锁）：快速判断是否需要刷新
        let needs_refresh = is_token_expired(credentials) || is_token_expiring_soon(credentials);

        let creds = if needs_refresh {
            // 获取刷新锁，确保同一时间只有一个刷新操作
            let _guard = self.refresh_lock.lock().await;

            // 第二次检查：获取锁后重新读取凭据，因为其他请求可能已经完成刷新
            let current_creds = {
                let entries = self.entries.lock();
                entries
                    .iter()
                    .find(|e| e.id == id)
                    .map(|e| e.credentials.clone())
                    .ok_or_else(|| anyhow::anyhow!("凭据 #{} 不存在", id))?
            };

            if is_token_expired(&current_creds) || is_token_expiring_soon(&current_creds) {
                // 确实需要刷新
                self.refresh_and_store(id, &current_creds).await?
            } else {
                // 其他请求已经完成刷新，直接使用新凭据
                tracing::debug!("Token 已被其他请求刷新，跳过刷新");
                current_creds
            }
        } else {
            credentials.clone()
        };

        let token = creds
            .access_token
            .clone()
            .ok_or_else(|| anyhow::anyhow!("没有可用的 accessToken"))?;

        {
            let mut entries = self.entries.lock();
            if let Some(entry) = entries.iter_mut().find(|e| e.id == id) {
                entry.refresh_failure_count = 0;
            }
        }

        Ok(CallContext {
            id,
            credentials: creds,
            token,
        })
    }

    /// 将凭据列表回写到源文件
    ///
    /// 仅在以下条件满足时回写：
    /// - 保持源文件格式：多凭据写数组，单凭据写对象
    /// - credentials_path 已设置
    ///
    /// # Returns
    /// - `Ok(true)` - 成功写入文件
    /// - `Ok(false)` - 跳过写入（单凭据文件无法表达当前列表或无路径配置）
    /// - `Err(_)` - 写入失败
    fn persist_credentials(&self) -> anyhow::Result<bool> {
        use anyhow::Context;

        // 库模式下各写入点直接定向写库（persist_entry_state / save_rotated_credentials 等）
        if self.store.is_some() {
            return Ok(true);
        }
        let path = match &self.credentials_path {
            Some(p) => p,
            None => return Ok(false),
        };

        // 收集所有凭据
        let credentials: Vec<KiroCredentials> = {
            let entries = self.entries.lock();
            entries
                .iter()
                .map(|e| {
                    let mut cred = e.credentials.clone();
                    cred.canonicalize_auth_method();
                    // 同步 disabled 状态到凭据对象
                    cred.disabled = e.disabled;
                    cred
                })
                .collect()
        };

        // 序列化为 pretty JSON
        let json = if self.is_multiple_format {
            serde_json::to_string_pretty(&credentials)
        } else if let [credential] = credentials.as_slice() {
            serde_json::to_string_pretty(credential)
        } else {
            // 单凭据文件不能表达多个凭据，沿用不回写的行为。
            return Ok(false);
        }
        .context("序列化凭据失败")?;

        // 写入文件（在 Tokio runtime 内使用 block_in_place 避免阻塞 worker）
        if tokio::runtime::Handle::try_current().is_ok() {
            tokio::task::block_in_place(|| std::fs::write(path, &json))
                .with_context(|| format!("回写凭据文件失败: {:?}", path))?;
        } else {
            std::fs::write(path, &json).with_context(|| format!("回写凭据文件失败: {:?}", path))?;
        }

        tracing::debug!("已回写凭据到文件: {:?}", path);
        Ok(true)
    }

    /// 获取缓存目录（凭据文件所在目录）
    pub fn cache_dir(&self) -> Option<PathBuf> {
        self.credentials_path
            .as_ref()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    }

    /// 统计数据文件路径
    fn stats_path(&self) -> Option<PathBuf> {
        self.cache_dir().map(|d| d.join("kiro_stats.json"))
    }

    /// 从磁盘加载统计数据并应用到当前条目
    fn load_stats(&self) {
        let path = match self.stats_path() {
            Some(p) => p,
            None => return,
        };

        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => return, // 首次运行时文件不存在
        };

        let stats: HashMap<String, StatsEntry> = match serde_json::from_str(&content) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("解析统计缓存失败，将忽略: {}", e);
                return;
            }
        };

        let mut entries = self.entries.lock();
        for entry in entries.iter_mut() {
            if let Some(s) = stats.get(&entry.id.to_string()) {
                entry.success_count = s.success_count;
                entry.last_used_at = s.last_used_at.clone();
                entry.input_tokens = s.input_tokens;
                entry.output_tokens = s.output_tokens;
            }
        }
        *self.last_stats_save_at.lock() = Some(Instant::now());
        self.stats_dirty.store(false, Ordering::Relaxed);
        tracing::info!("已从缓存加载 {} 条统计数据", stats.len());
    }

    /// 将当前统计数据持久化到磁盘
    fn save_stats(&self) {
        if let Some(store) = &self.store {
            let rows: Vec<(u64, StoredCounters)> = self
                .entries
                .lock()
                .iter()
                .map(|e| {
                    (
                        e.id,
                        StoredCounters {
                            success_count: e.success_count,
                            input_tokens: e.input_tokens,
                            output_tokens: e.output_tokens,
                            last_used_at_ms: rfc3339_to_ms(e.last_used_at.as_deref()),
                        },
                    )
                })
                .collect();
            match store.save_counters(&rows) {
                Ok(()) => {
                    *self.last_stats_save_at.lock() = Some(Instant::now());
                    self.stats_dirty.store(false, Ordering::Relaxed);
                }
                Err(e) => tracing::warn!("统计写入账号库失败: {}", e),
            }
            return;
        }
        let path = match self.stats_path() {
            Some(p) => p,
            None => return,
        };

        let stats: HashMap<String, StatsEntry> = {
            let entries = self.entries.lock();
            entries
                .iter()
                .map(|e| {
                    (
                        e.id.to_string(),
                        StatsEntry {
                            success_count: e.success_count,
                            last_used_at: e.last_used_at.clone(),
                            input_tokens: e.input_tokens,
                            output_tokens: e.output_tokens,
                        },
                    )
                })
                .collect()
        };

        match serde_json::to_string_pretty(&stats) {
            Ok(json) => {
                if let Err(e) = std::fs::write(&path, json) {
                    tracing::warn!("保存统计缓存失败: {}", e);
                } else {
                    *self.last_stats_save_at.lock() = Some(Instant::now());
                    self.stats_dirty.store(false, Ordering::Relaxed);
                }
            }
            Err(e) => tracing::warn!("序列化统计数据失败: {}", e),
        }
    }

    /// 标记统计数据已更新，并按 debounce 策略决定是否立即落盘
    fn save_stats_debounced(&self) {
        self.stats_dirty.store(true, Ordering::Relaxed);

        let should_flush = {
            let last = *self.last_stats_save_at.lock();
            match last {
                Some(last_saved_at) => last_saved_at.elapsed() >= STATS_SAVE_DEBOUNCE,
                None => true,
            }
        };

        if should_flush {
            self.save_stats();
        }
    }

    /// 报告指定凭据 API 调用成功
    ///
    /// 重置该凭据的失败计数
    ///
    /// # Arguments
    /// * `id` - 凭据 ID（来自 CallContext）
    pub fn report_success(&self, id: u64) {
        {
            let mut entries = self.entries.lock();
            if let Some(entry) = entries.iter_mut().find(|e| e.id == id) {
                entry.failure_count = 0;
                entry.refresh_failure_count = 0;
                entry.success_count += 1;
                entry.last_used_at = Some(Utc::now().to_rfc3339());
                tracing::debug!(
                    "凭据 #{} API 调用成功（累计 {} 次）",
                    id,
                    entry.success_count
                );
            }
        }
        self.save_stats_debounced();
    }

    /// 累加指定凭据经本反代消耗的 tokens
    ///
    /// 与 `report_success` 分开调用的原因：`report_success` 在拿到响应头时就触发，
    /// 而 token 数要等整个流读完才知道（input_tokens 依赖上游的 contextUsageEvent）。
    ///
    /// 这里统计的是「走本反代的量」，与 `/balance` 的账号总额度是两个口径：
    /// 抢来的号常被原主或其他反代同时使用，账号额度会涨但这里不会。
    ///
    /// # Arguments
    /// * `id` - 凭据 ID（来自 CallContext）
    /// * `input_tokens` - 本次请求的输入 tokens
    /// * `output_tokens` - 本次请求的输出 tokens
    pub fn record_token_usage(&self, id: u64, input_tokens: u64, output_tokens: u64) {
        if input_tokens == 0 && output_tokens == 0 {
            return;
        }
        {
            let mut entries = self.entries.lock();
            let Some(entry) = entries.iter_mut().find(|e| e.id == id) else {
                return;
            };
            // saturating 防御：累计值是长期递增的，溢出会让统计直接归零
            entry.input_tokens = entry.input_tokens.saturating_add(input_tokens);
            entry.output_tokens = entry.output_tokens.saturating_add(output_tokens);
            tracing::debug!(
                "凭据 #{} 本次消耗 tokens: 输入 {} / 输出 {}（累计 {} / {}）",
                id,
                input_tokens,
                output_tokens,
                entry.input_tokens,
                entry.output_tokens
            );
        }
        self.save_stats_debounced();
    }

    /// 报告指定凭据 API 调用失败
    ///
    /// 增加失败计数，达到阈值时禁用凭据并切换到优先级最高的可用凭据
    /// 返回是否还有可用凭据可以重试
    ///
    /// # Arguments
    /// * `id` - 凭据 ID（来自 CallContext）
    pub fn report_failure(&self, id: u64) -> bool {
        let result = {
            let mut entries = self.entries.lock();
            let mut current_id = self.current_id.lock();

            let entry = match entries.iter_mut().find(|e| e.id == id) {
                Some(e) => e,
                None => return entries.iter().any(|e| e.schedulable()),
            };

            if entry.disabled {
                return entries.iter().any(|e| e.schedulable());
            }

            entry.failure_count += 1;
            entry.last_used_at = Some(Utc::now().to_rfc3339());
            let failure_count = entry.failure_count;

            tracing::warn!(
                "凭据 #{} API 调用失败（{}/{}）",
                id,
                failure_count,
                MAX_FAILURES_PER_CREDENTIAL
            );

            if failure_count >= MAX_FAILURES_PER_CREDENTIAL {
                entry.disabled = true;
                entry.disabled_reason = Some(DisabledReason::TooManyFailures);
                tracing::error!("凭据 #{} 已连续失败 {} 次，已被禁用", id, failure_count);

                // 切换到优先级最高的可用凭据
                if let Some(next) = entries
                    .iter()
                    .filter(|e| e.schedulable())
                    .min_by_key(|e| e.credentials.priority)
                {
                    *current_id = next.id;
                    tracing::info!(
                        "已切换到凭据 #{}（优先级 {}）",
                        next.id,
                        next.credentials.priority
                    );
                } else {
                    tracing::error!("所有凭据均已禁用！");
                }
            }

            entries.iter().any(|e| e.schedulable())
        };
        self.persist_entry_state(id);
        self.save_stats_debounced();
        result
    }

    /// 报告指定凭据额度已用尽
    ///
    /// 用于处理 402 Payment Required 且 reason 为 `MONTHLY_REQUEST_COUNT` 的场景：
    /// - 立即禁用该凭据（不等待连续失败阈值）
    /// - 切换到下一个可用凭据继续重试
    /// - 返回是否还有可用凭据
    pub fn report_quota_exhausted(&self, id: u64) -> bool {
        let result = {
            let mut entries = self.entries.lock();
            let mut current_id = self.current_id.lock();

            let entry = match entries.iter_mut().find(|e| e.id == id) {
                Some(e) => e,
                None => return entries.iter().any(|e| e.schedulable()),
            };

            if entry.disabled {
                return entries.iter().any(|e| e.schedulable());
            }

            entry.disabled = true;
            entry.disabled_reason = Some(DisabledReason::QuotaExceeded);
            entry.last_used_at = Some(Utc::now().to_rfc3339());
            // 设为阈值，便于在管理面板中直观看到该凭据已不可用
            entry.failure_count = MAX_FAILURES_PER_CREDENTIAL;

            tracing::error!("凭据 #{} 额度已用尽（MONTHLY_REQUEST_COUNT），已被禁用", id);

            // 切换到优先级最高的可用凭据
            if let Some(next) = entries
                .iter()
                .filter(|e| e.schedulable())
                .min_by_key(|e| e.credentials.priority)
            {
                *current_id = next.id;
                tracing::info!(
                    "已切换到凭据 #{}（优先级 {}）",
                    next.id,
                    next.credentials.priority
                );
                true
            } else {
                tracing::error!("所有凭据均已禁用！");
                false
            }
        };
        self.persist_entry_state(id);
        self.save_stats_debounced();
        result
    }

    /// 报告指定凭据刷新 Token 失败。
    ///
    /// 连续刷新失败达到阈值后禁用凭据并切换，阈值内保持当前凭据不切换，
    /// 与 API 401/403 的累计失败策略保持一致。
    pub fn report_refresh_failure(&self, id: u64) -> bool {
        let result = {
            let mut entries = self.entries.lock();
            let mut current_id = self.current_id.lock();

            let entry = match entries.iter_mut().find(|e| e.id == id) {
                Some(e) => e,
                None => return entries.iter().any(|e| e.schedulable()),
            };

            if entry.disabled {
                return entries.iter().any(|e| e.schedulable());
            }

            entry.last_used_at = Some(Utc::now().to_rfc3339());
            entry.refresh_failure_count += 1;
            let refresh_failure_count = entry.refresh_failure_count;

            tracing::warn!(
                "凭据 #{} Token 刷新失败（{}/{}）",
                id,
                refresh_failure_count,
                MAX_FAILURES_PER_CREDENTIAL
            );

            if refresh_failure_count < MAX_FAILURES_PER_CREDENTIAL {
                return entries.iter().any(|e| e.schedulable());
            }

            entry.disabled = true;
            entry.disabled_reason = Some(DisabledReason::TooManyRefreshFailures);

            tracing::error!(
                "凭据 #{} Token 已连续刷新失败 {} 次，已被禁用",
                id,
                refresh_failure_count
            );

            if let Some(next) = entries
                .iter()
                .filter(|e| e.schedulable())
                .min_by_key(|e| e.credentials.priority)
            {
                *current_id = next.id;
                tracing::info!(
                    "已切换到凭据 #{}（优先级 {}）",
                    next.id,
                    next.credentials.priority
                );
                true
            } else {
                tracing::error!("所有凭据均已禁用！");
                false
            }
        };
        self.persist_entry_state(id);
        self.save_stats_debounced();
        result
    }

    /// 报告指定凭据的 refreshToken 永久失效（invalid_grant）。
    ///
    /// 立即禁用凭据，不累计、不重试。
    /// 返回是否还有可用凭据。
    pub fn report_refresh_token_invalid(&self, id: u64) -> bool {
        let result = {
            let mut entries = self.entries.lock();
            let mut current_id = self.current_id.lock();

            let entry = match entries.iter_mut().find(|e| e.id == id) {
                Some(e) => e,
                None => return entries.iter().any(|e| e.schedulable()),
            };

            if entry.disabled {
                return entries.iter().any(|e| e.schedulable());
            }

            entry.last_used_at = Some(Utc::now().to_rfc3339());
            entry.disabled = true;
            entry.disabled_reason = Some(DisabledReason::InvalidRefreshToken);

            tracing::error!(
                "凭据 #{} refreshToken 已失效 (invalid_grant)，已立即禁用",
                id
            );

            if let Some(next) = entries
                .iter()
                .filter(|e| e.schedulable())
                .min_by_key(|e| e.credentials.priority)
            {
                *current_id = next.id;
                tracing::info!(
                    "已切换到凭据 #{}（优先级 {}）",
                    next.id,
                    next.credentials.priority
                );
                true
            } else {
                tracing::error!("所有凭据均已禁用！");
                false
            }
        };
        self.persist_entry_state(id);
        self.save_stats_debounced();
        result
    }

    /// 切换到优先级最高的可用凭据
    ///
    /// 返回是否成功切换
    pub fn switch_to_next(&self) -> bool {
        let entries = self.entries.lock();
        let mut current_id = self.current_id.lock();

        // 选择优先级最高的未禁用凭据（排除当前凭据）
        if let Some(next) = entries
            .iter()
            .filter(|e| e.schedulable() && e.id != *current_id)
            .min_by_key(|e| e.credentials.priority)
        {
            *current_id = next.id;
            tracing::info!(
                "已切换到凭据 #{}（优先级 {}）",
                next.id,
                next.credentials.priority
            );
            true
        } else {
            // 没有其他可用凭据，检查当前凭据是否可用
            entries
                .iter()
                .any(|e| e.id == *current_id && e.schedulable())
        }
    }

    // ========================================================================
    // Admin API 方法
    // ========================================================================

    /// 获取管理器状态快照（用于 Admin API）
    pub fn snapshot(&self) -> ManagerSnapshot {
        let entries = self.entries.lock();
        let current_id = *self.current_id.lock();
        let available = entries.iter().filter(|e| e.schedulable()).count();

        ManagerSnapshot {
            entries: entries
                .iter()
                .map(|e| CredentialEntrySnapshot {
                    id: e.id,
                    credential_identity: if e.identity_pending {
                        None
                    } else {
                        e.credentials.credential_identity.clone()
                    },
                    priority: e.credentials.priority,
                    disabled: e.disabled,
                    failure_count: e.failure_count,
                    auth_method: if e.credentials.is_api_key_credential() {
                        Some("api_key".to_string())
                    } else {
                        e.credentials.auth_method.as_deref().map(|m| {
                            if m.eq_ignore_ascii_case("builder-id") || m.eq_ignore_ascii_case("iam")
                            {
                                "idc".to_string()
                            } else {
                                m.to_string()
                            }
                        })
                    },
                    has_profile_arn: e.credentials.profile_arn.is_some(),
                    expires_at: if e.credentials.is_api_key_credential() {
                        None // API Key 凭据本地不维护过期时间（服务端策略未知）
                    } else {
                        e.credentials.expires_at.clone()
                    },
                    refresh_token_hash: if e.credentials.is_api_key_credential() {
                        None
                    } else {
                        e.credentials.refresh_token.as_deref().map(sha256_hex)
                    },
                    api_key_hash: if e.credentials.is_api_key_credential() {
                        e.credentials.kiro_api_key.as_deref().map(sha256_hex)
                    } else {
                        None
                    },
                    masked_api_key: if e.credentials.is_api_key_credential() {
                        e.credentials.kiro_api_key.as_deref().map(mask_api_key)
                    } else {
                        None
                    },
                    email: e.credentials.email.clone(),
                    success_count: e.success_count,
                    last_used_at: e.last_used_at.clone(),
                    input_tokens: e.input_tokens,
                    output_tokens: e.output_tokens,
                    has_proxy: e.credentials.proxy_url.is_some(),
                    proxy_url: e.credentials.proxy_url.clone(),
                    refresh_failure_count: e.refresh_failure_count,
                    disabled_reason: e.disabled_reason.map(|r| r.as_str().to_string()),
                    endpoint: e.credentials.endpoint.clone(),
                    auth_region: e
                        .credentials
                        .effective_auth_region(&self.config)
                        .to_string(),
                    api_region: e.credentials.effective_api_region(&self.config).to_string(),
                    in_pool: e.in_pool,
                    credential_version: e.credential_version,
                })
                .collect(),
            current_id,
            total: entries.len(),
            available,
        }
    }

    /// 设置凭据禁用状态（Admin API）
    pub fn set_disabled(&self, id: u64, disabled: bool) -> anyhow::Result<()> {
        {
            let mut entries = self.entries.lock();
            let entry = entries
                .iter_mut()
                .find(|e| e.id == id)
                .ok_or_else(|| anyhow::anyhow!("凭据不存在: {}", id))?;
            entry.disabled = disabled;
            if !disabled {
                // 启用时重置失败计数
                entry.failure_count = 0;
                entry.refresh_failure_count = 0;
                entry.disabled_reason = None;
            } else {
                entry.disabled_reason = Some(DisabledReason::Manual);
            }
        }
        // 持久化更改
        self.persist_state_or_credentials(id)?;
        Ok(())
    }

    /// 设置凭据优先级（Admin API）
    ///
    /// 修改优先级后会立即按新优先级重新选择当前凭据。
    /// 即使持久化失败，内存中的优先级和当前凭据选择也会生效。
    pub fn set_priority(&self, id: u64, priority: u32) -> anyhow::Result<()> {
        {
            let mut entries = self.entries.lock();
            let entry = entries
                .iter_mut()
                .find(|e| e.id == id)
                .ok_or_else(|| anyhow::anyhow!("凭据不存在: {}", id))?;
            entry.credentials.priority = priority;
        }
        // 立即按新优先级重新选择当前凭据（无论持久化是否成功）
        self.select_highest_priority();
        // 持久化更改
        match &self.store {
            Some(store) => store.set_priority(id, priority)?,
            None => {
                self.persist_credentials()?;
            }
        }
        Ok(())
    }

    /// 重置凭据失败计数并重新启用（Admin API）
    pub fn reset_and_enable(&self, id: u64) -> anyhow::Result<()> {
        {
            let mut entries = self.entries.lock();
            let entry = entries
                .iter_mut()
                .find(|e| e.id == id)
                .ok_or_else(|| anyhow::anyhow!("凭据不存在: {}", id))?;
            if entry.disabled_reason == Some(DisabledReason::InvalidConfig) {
                anyhow::bail!("凭据 #{} 因配置无效被禁用，请修正配置后重启服务", id);
            }
            entry.failure_count = 0;
            entry.refresh_failure_count = 0;
            entry.disabled = false;
            entry.disabled_reason = None;
        }
        // 持久化更改
        self.persist_state_or_credentials(id)?;
        Ok(())
    }

    /// 获取指定凭据的使用额度（Admin API）
    ///
    /// 库模式下结果（含上游原样 JSON）写入 account_usage，proxy-rs 从库里读取展示；
    /// 逆序返回的旧结果按查询序号丢弃。
    pub async fn get_usage_limits_for(&self, id: u64) -> anyhow::Result<UsageLimitsResponse> {
        let Some(store) = self.store.clone() else {
            return self.fetch_usage_limits(id).await;
        };
        let seq = store.begin_usage(id)?;
        match self.fetch_usage_limits(id).await {
            Ok(usage) => {
                let raw = serde_json::to_string(&usage.raw).unwrap_or_else(|_| "{}".into());
                let reset_at_ms = usage
                    .next_date_reset
                    .or_else(|| {
                        usage
                            .usage_breakdown_list
                            .first()
                            .and_then(|b| b.next_date_reset)
                    })
                    // 上游 nextDateReset 为 Unix 秒
                    .map(|secs| (secs * 1000.0) as i64);
                let upstream_identity = usage.user_info.as_ref().and_then(|u| u.user_id.clone());
                let write = UsageWrite {
                    seq,
                    raw_json: &raw,
                    used_amount: usage.current_usage(),
                    limit_amount: usage.usage_limit(),
                    reset_at_ms,
                    subscription_title: usage.subscription_title(),
                    upstream_identity: upstream_identity.as_deref(),
                };
                if let Err(e) = store.finish_usage(id, &write) {
                    tracing::warn!("凭据 #{} 额度写入账号库失败: {}", id, e);
                }
                Ok(usage)
            }
            Err(e) => {
                if let Err(db) = store.fail_usage(id, seq, &e.to_string()) {
                    tracing::warn!("凭据 #{} 额度失败状态写入账号库失败: {}", id, db);
                }
                Err(e)
            }
        }
    }

    async fn fetch_usage_limits(&self, id: u64) -> anyhow::Result<UsageLimitsResponse> {
        let credentials = {
            let entries = self.entries.lock();
            entries
                .iter()
                .find(|e| e.id == id)
                .map(|e| e.credentials.clone())
                .ok_or_else(|| anyhow::anyhow!("凭据不存在: {}", id))?
        };

        // API Key 凭据直接使用 kiro_api_key，无需刷新
        let token = if credentials.is_api_key_credential() {
            credentials
                .kiro_api_key
                .clone()
                .ok_or_else(|| anyhow::anyhow!("API Key 凭据缺少 kiroApiKey"))?
        } else {
            // 检查是否需要刷新 token
            let needs_refresh =
                is_token_expired(&credentials) || is_token_expiring_soon(&credentials);

            if needs_refresh {
                let _guard = self.refresh_lock.lock().await;
                let current_creds = {
                    let entries = self.entries.lock();
                    entries
                        .iter()
                        .find(|e| e.id == id)
                        .map(|e| e.credentials.clone())
                        .ok_or_else(|| anyhow::anyhow!("凭据不存在: {}", id))?
                };

                if is_token_expired(&current_creds) || is_token_expiring_soon(&current_creds) {
                    self.refresh_and_store(id, &current_creds)
                        .await?
                        .access_token
                        .ok_or_else(|| anyhow::anyhow!("刷新后无 access_token"))?
                } else {
                    current_creds
                        .access_token
                        .ok_or_else(|| anyhow::anyhow!("凭据无 access_token"))?
                }
            } else {
                credentials
                    .access_token
                    .ok_or_else(|| anyhow::anyhow!("凭据无 access_token"))?
            }
        };

        let credentials = {
            let entries = self.entries.lock();
            entries
                .iter()
                .find(|e| e.id == id)
                .map(|e| e.credentials.clone())
                .ok_or_else(|| anyhow::anyhow!("凭据不存在: {}", id))?
        };

        let effective_proxy = credentials.effective_proxy(self.proxy.as_ref());
        let usage_limits =
            match get_usage_limits(&credentials, &self.config, &token, effective_proxy.as_ref())
                .await
            {
                Err(error)
                    if !credentials.is_api_key_credential()
                        && error
                            .downcast_ref::<UsageLimitsHttpError>()
                            .is_some_and(|error| error.status == 401) =>
                {
                    self.refresh_token_if_current(id, Some(&token)).await?;
                    let current = {
                        let entries = self.entries.lock();
                        entries
                            .iter()
                            .find(|e| e.id == id)
                            .map(|e| e.credentials.clone())
                            .ok_or_else(|| anyhow::anyhow!("凭据不存在: {}", id))?
                    };
                    let current_token = current
                        .access_token
                        .as_deref()
                        .ok_or_else(|| anyhow::anyhow!("凭据无 access_token"))?;
                    let proxy = current.effective_proxy(self.proxy.as_ref());
                    // 只重试一次；再次 401、403 或限流均交给调用方展示。
                    get_usage_limits(&current, &self.config, current_token, proxy.as_ref()).await?
                }
                result => result?,
            };

        // 更新订阅等级到凭据（仅在发生变化时持久化）
        if let Some(subscription_title) = usage_limits.subscription_title() {
            let changed = {
                let mut entries = self.entries.lock();
                if let Some(entry) = entries.iter_mut().find(|e| e.id == id) {
                    let old_title = entry.credentials.subscription_title.clone();
                    if old_title.as_deref() != Some(subscription_title) {
                        entry.credentials.subscription_title = Some(subscription_title.to_string());
                        tracing::info!(
                            "凭据 #{} 订阅等级已更新: {:?} -> {}",
                            id,
                            old_title,
                            subscription_title
                        );
                        true
                    } else {
                        false
                    }
                } else {
                    false
                }
            };

            if changed && self.store.is_none() {
                if let Err(e) = self.persist_credentials() {
                    tracing::warn!("订阅等级更新后持久化失败（不影响本次请求）: {}", e);
                }
            }
        }

        Ok(usage_limits)
    }

    /// 添加新凭据（Admin API）
    ///
    /// # 流程
    /// 1. 验证凭据基本字段（API Key: kiroApiKey 不为空; OAuth: refreshToken 不为空）
    /// 2. 基于 kiroApiKey 或 refreshToken 的 SHA-256 哈希检测重复
    /// 3. OAuth: 尝试刷新 Token 验证凭据有效性; API Key: 跳过
    /// 4. 分配新 ID（当前最大 ID + 1）
    /// 5. 添加到 entries 列表
    /// 6. 持久化到配置文件
    ///
    /// # 返回
    /// - `Ok(u64)` - 新凭据 ID
    /// - `Err(_)` - 验证失败或添加失败
    pub async fn add_credential(&self, new_cred: KiroCredentials) -> anyhow::Result<u64> {
        // 1. 基本验证
        if new_cred.is_api_key_credential() {
            let api_key = new_cred
                .kiro_api_key
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("API Key 凭据缺少 kiroApiKey"))?;
            if api_key.is_empty() {
                anyhow::bail!("kiroApiKey 为空");
            }
        } else {
            validate_refresh_token(&new_cred)?;
        }

        // 2. 基于哈希检测重复
        if new_cred.is_api_key_credential() {
            let new_api_key = new_cred
                .kiro_api_key
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("缺少 kiroApiKey"))?;
            let new_api_key_hash = sha256_hex(new_api_key);
            let duplicate = {
                let entries = self.entries.lock();
                entries
                    .iter()
                    .find(|entry| {
                        entry
                            .credentials
                            .kiro_api_key
                            .as_deref()
                            .map(sha256_hex)
                            .as_deref()
                            == Some(new_api_key_hash.as_str())
                    })
                    .map(|entry| entry.id)
            };
            if let Some(existing) = duplicate {
                // 库模式：同一凭据已在库中（proxy-rs 管理的号），"添加到反代"即入池
                if self.store.is_some() {
                    self.set_in_pool(existing, true)?;
                    return Ok(existing);
                }
                anyhow::bail!("凭据已存在（kiroApiKey 重复）");
            }
        } else {
            let new_refresh_token = new_cred
                .refresh_token
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("缺少 refreshToken"))?;
            let new_refresh_token_hash = sha256_hex(new_refresh_token);
            let duplicate = {
                let entries = self.entries.lock();
                entries
                    .iter()
                    .find(|entry| {
                        entry
                            .credentials
                            .refresh_token
                            .as_deref()
                            .map(sha256_hex)
                            .as_deref()
                            == Some(new_refresh_token_hash.as_str())
                    })
                    .map(|entry| entry.id)
            };
            if let Some(existing) = duplicate {
                // 库模式：同一凭据已在库中（proxy-rs 管理的号），"添加到反代"即入池
                if self.store.is_some() {
                    self.set_in_pool(existing, true)?;
                    return Ok(existing);
                }
                anyhow::bail!("凭据已存在（refreshToken 重复）");
            }
        }

        // 3. 验证凭据有效性（API Key 无需网络刷新）
        let mut validated_cred = if new_cred.is_api_key_credential() {
            new_cred.clone()
        } else {
            let effective_proxy = new_cred.effective_proxy(self.proxy.as_ref());
            refresh_token(&new_cred, &self.config, effective_proxy.as_ref()).await?
        };

        // 4. 分配新 ID
        let new_id = {
            let entries = self.entries.lock();
            entries.iter().map(|e| e.id).max().unwrap_or(0) + 1
        };

        // 5. 设置 ID 并保留用户输入的元数据
        validated_cred.id = Some(new_id);
        // 不能沿用调用方或已删除凭据的身份，数字 ID 复用时也必须产生新身份。
        validated_cred.credential_identity = Some(uuid::Uuid::new_v4().to_string());
        validated_cred.priority = new_cred.priority;
        validated_cred.auth_method = new_cred.auth_method.map(|m| {
            if m.eq_ignore_ascii_case("builder-id") || m.eq_ignore_ascii_case("iam") {
                "idc".to_string()
            } else {
                m
            }
        });
        validated_cred.client_id = new_cred.client_id;
        validated_cred.client_secret = new_cred.client_secret;
        validated_cred.region = new_cred.region;
        validated_cred.auth_region = new_cred.auth_region;
        validated_cred.api_region = new_cred.api_region;
        validated_cred.machine_id = new_cred.machine_id;
        validated_cred.email = new_cred.email;
        validated_cred.proxy_url = new_cred.proxy_url;
        validated_cred.proxy_username = new_cred.proxy_username;
        validated_cred.proxy_password = new_cred.proxy_password;
        validated_cred.kiro_api_key = new_cred.kiro_api_key;

        // 库模式：由库分配 ID 与身份，写库成功后才进内存（Admin 新增即入号池）
        if let Some(store) = &self.store {
            validated_cred.id = None;
            validated_cred.credential_identity = None;
            let meta = NewAccountMeta {
                in_pool: true,
                ..Default::default()
            };
            let (db_id, identity) = store.insert_account(&validated_cred, &meta)?;
            validated_cred.id = Some(db_id);
            validated_cred.credential_identity = Some(identity);
            self.entries
                .lock()
                .push(Self::fresh_entry(db_id, validated_cred, true));
            tracing::info!("成功添加凭据 #{}（账号库）", db_id);
            return Ok(db_id);
        }

        {
            let mut entries = self.entries.lock();
            entries.push(CredentialEntry {
                id: new_id,
                credentials: validated_cred,
                identity_pending: true,
                failure_count: 0,
                refresh_failure_count: 0,
                disabled: false,
                disabled_reason: None,
                success_count: 0,
                last_used_at: None,
                input_tokens: 0,
                output_tokens: 0,
                in_pool: true,
                credential_version: 0,
            });
        }

        // 6. 只有写盘成功的身份才能对外发布。
        let persisted = self.persist_credentials();
        if let Some(entry) = self
            .entries
            .lock()
            .iter_mut()
            .find(|entry| entry.id == new_id)
        {
            if !matches!(persisted, Ok(true)) {
                entry.credentials.credential_identity = None;
            }
            entry.identity_pending = false;
        }
        persisted?;

        tracing::info!("成功添加凭据 #{}", new_id);
        Ok(new_id)
    }

    /// 删除凭据（Admin API）
    ///
    /// # 前置条件
    /// - 凭据必须已禁用（disabled = true）
    ///
    /// # 行为
    /// 1. 验证凭据存在
    /// 2. 验证凭据已禁用
    /// 3. 从 entries 移除
    /// 4. 如果删除的是当前凭据，切换到优先级最高的可用凭据
    /// 5. 如果删除后没有凭据，将 current_id 重置为 0
    /// 6. 持久化到文件
    ///
    /// # 返回
    /// - `Ok(())` - 删除成功
    /// - `Err(_)` - 凭据不存在、未禁用或持久化失败
    pub fn delete_credential(&self, id: u64) -> anyhow::Result<()> {
        self.remove_credential(id, true)
    }

    /// 从账号库彻底删除（软删除，两端都不再展示）；不要求先禁用。仅库模式。
    pub fn purge_credential(&self, id: u64) -> anyhow::Result<()> {
        self.require_store()?;
        self.remove_credential(id, false)
    }

    fn remove_credential(&self, id: u64, require_disabled: bool) -> anyhow::Result<()> {
        let was_current = {
            let mut entries = self.entries.lock();

            // 查找凭据
            let entry = entries
                .iter()
                .find(|e| e.id == id)
                .ok_or_else(|| anyhow::anyhow!("凭据不存在: {}", id))?;

            // 检查是否已禁用
            if require_disabled && !entry.disabled {
                anyhow::bail!("只能删除已禁用的凭据（请先禁用凭据 #{}）", id);
            }

            // 记录是否是当前凭据
            let current_id = *self.current_id.lock();
            let was_current = current_id == id;

            // 库模式：先软删除，写库成功才从内存移除
            if let Some(store) = &self.store {
                store.soft_delete(id)?;
            }

            // 删除凭据
            entries.retain(|e| e.id != id);

            was_current
        };

        // 如果删除的是当前凭据，切换到优先级最高的可用凭据
        if was_current {
            self.select_highest_priority();
        }

        // 如果删除后没有任何凭据，将 current_id 重置为 0（与初始化行为保持一致）
        {
            let entries = self.entries.lock();
            if entries.is_empty() {
                let mut current_id = self.current_id.lock();
                *current_id = 0;
                tracing::info!("所有凭据已删除，current_id 已重置为 0");
            }
        }

        // 持久化更改
        self.persist_credentials()?;

        // 立即回写统计数据，清除已删除凭据的残留条目
        self.save_stats();

        tracing::info!("已删除凭据 #{}", id);
        Ok(())
    }

    /// 强制刷新指定凭据；排队期间已被其他请求轮换时复用新凭据。
    pub async fn force_refresh_token_for(&self, id: u64) -> anyhow::Result<()> {
        let observed_token = {
            let entries = self.entries.lock();
            entries
                .iter()
                .find(|e| e.id == id)
                .ok_or_else(|| anyhow::anyhow!("凭据不存在: {}", id))?
                .credentials
                .access_token
                .clone()
        };
        self.refresh_token_if_current(id, observed_token.as_deref())
            .await
    }

    /// 所有强刷入口共用刷新锁；401 请求携带失败的 access token，避免重复轮换。
    pub async fn refresh_token_if_current(
        &self,
        id: u64,
        expected_access_token: Option<&str>,
    ) -> anyhow::Result<()> {
        let _guard = self.refresh_lock.lock().await;
        let credentials = {
            let entries = self.entries.lock();
            entries
                .iter()
                .find(|e| e.id == id)
                .map(|e| e.credentials.clone())
                .ok_or_else(|| anyhow::anyhow!("凭据不存在: {}", id))?
        };
        if credentials.access_token.as_deref() != expected_access_token
            && credentials.access_token.is_some()
            && !is_token_expired(&credentials)
            && !is_token_expiring_soon(&credentials)
        {
            return Ok(());
        }
        self.refresh_and_store(id, &credentials).await?;
        {
            let mut entries = self.entries.lock();
            let entry = entries
                .iter_mut()
                .find(|e| e.id == id)
                .ok_or_else(|| anyhow::anyhow!("凭据不存在: {}", id))?;
            entry.refresh_failure_count = 0;
        }
        tracing::info!("凭据 #{} Token 已强制刷新", id);
        Ok(())
    }

    fn fresh_entry(id: u64, credentials: KiroCredentials, in_pool: bool) -> CredentialEntry {
        CredentialEntry {
            id,
            credentials,
            identity_pending: false,
            failure_count: 0,
            refresh_failure_count: 0,
            disabled: false,
            disabled_reason: None,
            success_count: 0,
            last_used_at: None,
            input_tokens: 0,
            output_tokens: 0,
            in_pool,
            credential_version: 0,
        }
    }

    fn require_store(&self) -> anyhow::Result<&Arc<AccountStore>> {
        self.store
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("该操作需要以 --account-db 启动（共享账号库模式）"))
    }

    /// 加入 / 移出反代号池（不刷新、不复制凭据）
    pub fn set_in_pool(&self, id: u64, in_pool: bool) -> anyhow::Result<()> {
        let store = self.require_store()?;
        if !self.entries.lock().iter().any(|e| e.id == id) {
            anyhow::bail!("凭据不存在: {}", id);
        }
        store.set_in_pool(id, in_pool)?;
        if let Some(entry) = self.entries.lock().iter_mut().find(|e| e.id == id) {
            entry.in_pool = in_pool;
        }
        if !in_pool && *self.current_id.lock() == id {
            self.select_highest_priority();
        }
        if in_pool && *self.current_id.lock() == 0 {
            self.select_highest_priority();
        }
        Ok(())
    }

    /// 确保凭据新鲜，返回当前凭据版本。
    ///
    /// - `expected_version` 与当前版本不同：说明调用方用的是旧 token，别处已轮换，直接复用。
    /// - 否则 `force` 或即将过期时刷新一次。
    ///
    /// 供 proxy-rs 在自己调上游前 / 遇到 401 时调用；刷新只在 kiro-rs 发生。
    pub async fn ensure_fresh(
        &self,
        id: u64,
        expected_version: Option<i64>,
        force: bool,
    ) -> anyhow::Result<i64> {
        let _guard = self.refresh_lock.lock().await;
        let (credentials, version) = {
            let entries = self.entries.lock();
            let e = entries
                .iter()
                .find(|e| e.id == id)
                .ok_or_else(|| anyhow::anyhow!("凭据不存在: {}", id))?;
            (e.credentials.clone(), e.credential_version)
        };
        if credentials.is_api_key_credential() {
            return Ok(version);
        }
        if expected_version.is_some_and(|v| v != version) {
            return Ok(version);
        }
        let needs = force
            || credentials.access_token.is_none()
            || is_token_expired(&credentials)
            || is_token_expiring_soon(&credentials);
        if !needs {
            return Ok(version);
        }
        match self.refresh_and_store(id, &credentials).await {
            Ok(_) => {
                if let Some(entry) = self.entries.lock().iter_mut().find(|e| e.id == id) {
                    entry.refresh_failure_count = 0;
                }
            }
            Err(e) => {
                if e.downcast_ref::<RefreshTokenInvalidError>().is_some() {
                    self.report_refresh_token_invalid(id);
                }
                return Err(e);
            }
        }
        Ok(self
            .entries
            .lock()
            .iter()
            .find(|e| e.id == id)
            .map(|e| e.credential_version)
            .unwrap_or(version))
    }

    /// 导入已有凭据（库模式）：不刷新、不查额度，原样写库。
    ///
    /// 用于 proxy-rs 新增账号（登录 / 注册 / 抢号）：它已拿到首份凭据，交给 kiro-rs 接管。
    /// 同一 refresh token / API key 或同一 account_uuid 已存在时返回已有 ID（created=false）。
    pub fn import_credential(
        &self,
        mut cred: KiroCredentials,
        meta: NewAccountMeta,
    ) -> anyhow::Result<ImportOutcome> {
        let store = self.require_store()?;
        cred.canonicalize_auth_method();
        if cred.is_api_key_credential() {
            if cred.kiro_api_key.as_deref().is_none_or(str::is_empty) {
                anyhow::bail!("API Key 凭据缺少 kiroApiKey");
            }
        } else if cred.refresh_token.as_deref().is_none_or(str::is_empty) {
            anyhow::bail!("缺少 refreshToken");
        }
        let existing = |id| ImportOutcome {
            id,
            created: false,
            replaced: false,
        };
        if let Some(uuid) = meta.account_uuid.as_deref() {
            match store.find_by_uuid(uuid)? {
                Some((_, true)) => anyhow::bail!("账号 {uuid} 已被删除，不能重新导入同一 ID"),
                Some((id, false)) => return Ok(existing(id)),
                None => {}
            }
        }
        let secret_rt = (!cred.is_api_key_credential())
            .then(|| cred.refresh_token.clone())
            .flatten();
        if let Some(id) =
            store.find_by_secret(secret_rt.as_deref(), cred.kiro_api_key.as_deref())?
        {
            return Ok(existing(id));
        }
        // 同一上游账号重新登录：替换已有那一行的凭据，不新增账号（验收 A39 / A34）
        if let Some(identity) = meta.upstream_identity.as_deref().filter(|v| !v.is_empty()) {
            if let Some(id) = store.find_by_upstream_identity(identity)? {
                let (version, enabled) = store.replace_credentials(id, &cred)?;
                let mut entries = self.entries.lock();
                if let Some(entry) = entries.iter_mut().find(|e| e.id == id) {
                    let keep = entry.credentials.clone();
                    entry.credentials = KiroCredentials {
                        id: keep.id,
                        credential_identity: keep.credential_identity,
                        email: keep.email.or(cred.email.clone()),
                        priority: keep.priority,
                        subscription_title: keep.subscription_title,
                        machine_id: keep.machine_id,
                        endpoint: keep.endpoint,
                        proxy_url: keep.proxy_url,
                        proxy_username: keep.proxy_username,
                        proxy_password: keep.proxy_password,
                        profile_arn: cred.profile_arn.clone().or(keep.profile_arn),
                        region: cred.region.clone().or(keep.region),
                        auth_region: cred.auth_region.clone().or(keep.auth_region),
                        api_region: cred.api_region.clone().or(keep.api_region),
                        disabled: !enabled,
                        ..cred.clone()
                    };
                    entry.credential_version = version;
                    entry.refresh_failure_count = 0;
                    if enabled {
                        entry.disabled = false;
                        entry.disabled_reason = None;
                    }
                }
                tracing::info!(
                    "凭据 #{} 已按上游身份重新登录，凭据已替换（版本 {}）",
                    id,
                    version
                );
                return Ok(ImportOutcome {
                    id,
                    created: false,
                    replaced: true,
                });
            }
        }
        if cred.machine_id.is_none() {
            cred.machine_id = Some(machine_id::generate_from_credentials(&cred, &self.config));
        }
        cred.id = None;
        cred.credential_identity = None;
        let in_pool = meta.in_pool;
        let (id, identity) = store.insert_account(&cred, &meta)?;
        cred.id = Some(id);
        cred.credential_identity = Some(identity);
        self.entries
            .lock()
            .push(Self::fresh_entry(id, cred, in_pool));
        if in_pool && *self.current_id.lock() == 0 {
            self.select_highest_priority();
        }
        tracing::info!("已导入凭据 #{}（号池: {}）", id, in_pool);
        Ok(ImportOutcome {
            id,
            created: true,
            replaced: false,
        })
    }

    /// 设置凭据级代理（库模式）
    pub fn set_proxy(
        &self,
        id: u64,
        url: Option<String>,
        username: Option<String>,
        password: Option<String>,
    ) -> anyhow::Result<()> {
        let store = self.require_store()?;
        store.set_proxy(id, url.as_deref(), username.as_deref(), password.as_deref())?;
        let mut entries = self.entries.lock();
        let entry = entries
            .iter_mut()
            .find(|e| e.id == id)
            .ok_or_else(|| anyhow::anyhow!("凭据不存在: {}", id))?;
        entry.credentials.proxy_url = url;
        entry.credentials.proxy_username = username;
        entry.credentials.proxy_password = password;
        Ok(())
    }

    /// 库模式后台维护（main 每分钟调用一次）：
    /// - 即将过期或缺 access token 的 OAuth 凭据刷新一次（不论是否在号池，proxy-rs 不再自己刷新）
    /// - 从未查过额度的账号查一次，填充 account_usage 供 proxy-rs 展示
    pub async fn maintain_credentials(&self) {
        let Some(store) = self.store.clone() else {
            return;
        };
        let due: Vec<u64> = {
            let entries = self.entries.lock();
            entries
                .iter()
                .filter(|e| !e.disabled && !e.credentials.is_api_key_credential())
                .filter(|e| {
                    e.credentials.access_token.is_none()
                        || is_token_expired(&e.credentials)
                        || is_token_expiring_soon(&e.credentials)
                })
                .map(|e| e.id)
                .collect()
        };
        for id in due {
            if let Err(e) = self.ensure_fresh(id, None, false).await {
                tracing::warn!("后台刷新凭据 #{} 失败: {}", id, e);
                if e.downcast_ref::<RefreshTokenInvalidError>().is_none() {
                    self.report_refresh_failure(id);
                }
            }
        }
        let never = match store.ids_without_usage() {
            Ok(ids) => ids,
            Err(e) => {
                tracing::warn!("读取未查额度账号失败: {}", e);
                return;
            }
        };
        for id in never {
            let enabled = self
                .entries
                .lock()
                .iter()
                .any(|e| e.id == id && !e.disabled);
            if enabled {
                if let Err(e) = self.get_usage_limits_for(id).await {
                    tracing::warn!("后台查询凭据 #{} 额度失败: {}", id, e);
                }
            }
        }
    }

    /// 立即写出防抖中的统计（进程退出前调用）
    pub fn flush_stats(&self) {
        if self.stats_dirty.load(Ordering::Relaxed) {
            self.save_stats();
        }
    }

    /// 获取负载均衡模式（Admin API）
    pub fn get_load_balancing_mode(&self) -> String {
        self.load_balancing_mode.lock().clone()
    }

    fn persist_load_balancing_mode(&self, mode: &str) -> anyhow::Result<()> {
        use anyhow::Context;

        let config_path = match self.config.config_path() {
            Some(path) => path.to_path_buf(),
            None => {
                tracing::warn!("配置文件路径未知，负载均衡模式仅在当前进程生效: {}", mode);
                return Ok(());
            }
        };

        let mut config = Config::load(&config_path)
            .with_context(|| format!("重新加载配置失败: {}", config_path.display()))?;
        config.load_balancing_mode = mode.to_string();
        config
            .save()
            .with_context(|| format!("持久化负载均衡模式失败: {}", config_path.display()))?;

        Ok(())
    }

    /// 设置负载均衡模式（Admin API）
    pub fn set_load_balancing_mode(&self, mode: String) -> anyhow::Result<()> {
        // 验证模式值
        if mode != "priority" && mode != "balanced" {
            anyhow::bail!("无效的负载均衡模式: {}", mode);
        }

        let previous_mode = self.get_load_balancing_mode();
        if previous_mode == mode {
            return Ok(());
        }

        *self.load_balancing_mode.lock() = mode.clone();

        if let Err(err) = self.persist_load_balancing_mode(&mode) {
            *self.load_balancing_mode.lock() = previous_mode;
            return Err(err);
        }

        tracing::info!("负载均衡模式已设置为: {}", mode);
        Ok(())
    }
}

impl Drop for MultiTokenManager {
    fn drop(&mut self) {
        if self.stats_dirty.load(Ordering::Relaxed) {
            self.save_stats();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn credential_identity_test_path() -> PathBuf {
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("credential-identity-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        directory.join("credentials.json")
    }

    #[test]
    fn test_credential_identity_survives_rotation_and_reload() {
        let path = credential_identity_test_path();
        let manager = MultiTokenManager::new(
            Config::default(),
            vec![KiroCredentials {
                id: Some(7),
                refresh_token: Some("before".into()),
                ..Default::default()
            }],
            None,
            Some(path.clone()),
            true,
        )
        .unwrap();
        let before = serde_json::to_value(&manager.snapshot().entries[0]).unwrap();
        let identity = before["credentialIdentity"]
            .as_str()
            .expect("stable identity")
            .to_owned();
        {
            let mut entries = manager.entries.lock();
            entries[0].credentials.refresh_token = Some("after".into());
        }
        assert!(manager.persist_credentials().unwrap());
        let reloaded = MultiTokenManager::new(
            Config::default(),
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap(),
            None,
            Some(path),
            true,
        )
        .unwrap();
        let after = serde_json::to_value(&reloaded.snapshot().entries[0]).unwrap();
        assert_eq!(after["credentialIdentity"], identity);
        assert_ne!(before["refreshTokenHash"], after["refreshTokenHash"]);
        let recreated = MultiTokenManager::new(
            Config::default(),
            vec![KiroCredentials {
                id: Some(7),
                refresh_token: Some("after".into()),
                ..Default::default()
            }],
            None,
            Some(credential_identity_test_path()),
            true,
        )
        .unwrap();
        assert_ne!(
            serde_json::to_value(&recreated.snapshot().entries[0]).unwrap()["credentialIdentity"],
            identity
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_credential_identity_changes_when_numeric_id_is_reused() {
        let manager = MultiTokenManager::new(
            Config::default(),
            vec![],
            None,
            Some(credential_identity_test_path()),
            true,
        )
        .unwrap();
        let credential = KiroCredentials {
            auth_method: Some("api_key".into()),
            kiro_api_key: Some("ksk_test_identity".into()),
            ..Default::default()
        };
        let id = manager.add_credential(credential.clone()).await.unwrap();
        let identity = manager.snapshot().entries[0]
            .credential_identity
            .clone()
            .unwrap();
        manager.set_disabled(id, true).unwrap();
        manager.delete_credential(id).unwrap();
        let reused_id = manager.add_credential(credential).await.unwrap();
        assert_eq!(id, reused_id);
        assert_ne!(
            manager.snapshot().entries[0].credential_identity.as_deref(),
            Some(identity.as_str())
        );
    }

    #[test]
    fn test_credential_identity_persisted_for_single_and_array_formats() {
        for multiple in [false, true] {
            let path = credential_identity_test_path();
            let manager = MultiTokenManager::new(
                Config::default(),
                vec![KiroCredentials {
                    id: Some(7),
                    refresh_token: Some("test-only".into()),
                    ..Default::default()
                }],
                None,
                Some(path.clone()),
                multiple,
            )
            .unwrap();
            let identity = manager.snapshot().entries[0]
                .credential_identity
                .clone()
                .unwrap();
            let value: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            assert_eq!(value.is_array(), multiple);
            let credentials = if multiple {
                serde_json::from_value(value).unwrap()
            } else {
                vec![serde_json::from_value(value).unwrap()]
            };
            let reloaded =
                MultiTokenManager::new(Config::default(), credentials, None, Some(path), multiple)
                    .unwrap();
            assert_eq!(
                reloaded.snapshot().entries[0]
                    .credential_identity
                    .as_deref(),
                Some(identity.as_str())
            );
        }
    }

    #[test]
    fn test_credential_identity_not_published_when_persistence_fails_or_is_skipped() {
        let directory = credential_identity_test_path()
            .parent()
            .unwrap()
            .to_path_buf();
        for path in [None, Some(directory)] {
            let manager = MultiTokenManager::new(
                Config::default(),
                vec![
                    KiroCredentials {
                        id: Some(1),
                        ..Default::default()
                    },
                    KiroCredentials {
                        id: Some(2),
                        credential_identity: Some("persisted-identity".into()),
                        ..Default::default()
                    },
                ],
                None,
                path,
                true,
            )
            .unwrap();
            let entries = manager.snapshot().entries;
            assert_eq!(entries[0].credential_identity, None);
            assert_eq!(
                entries[1].credential_identity.as_deref(),
                Some("persisted-identity")
            );
        }
    }

    #[test]
    fn test_snapshot_hides_identity_until_new_entry_persistence_finishes() {
        let manager = MultiTokenManager::new(
            Config::default(),
            vec![KiroCredentials {
                id: Some(1),
                credential_identity: Some("pending-identity".into()),
                ..Default::default()
            }],
            None,
            None,
            true,
        )
        .unwrap();
        manager.entries.lock()[0].identity_pending = true;
        assert_eq!(manager.snapshot().entries[0].credential_identity, None);
        manager.entries.lock()[0].identity_pending = false;
        assert_eq!(
            manager.snapshot().entries[0].credential_identity.as_deref(),
            Some("pending-identity")
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_added_credential_identity_not_published_without_persistence() {
        let directory = credential_identity_test_path()
            .parent()
            .unwrap()
            .to_path_buf();
        for path in [None, Some(directory)] {
            let should_fail = path.is_some();
            let manager =
                MultiTokenManager::new(Config::default(), vec![], None, path, true).unwrap();
            let result = manager
                .add_credential(KiroCredentials {
                    auth_method: Some("api_key".into()),
                    kiro_api_key: Some("ksk_test_identity".into()),
                    ..Default::default()
                })
                .await;
            assert_eq!(result.is_err(), should_fail);
            assert_eq!(manager.snapshot().entries[0].credential_identity, None);
        }
    }

    #[test]
    fn test_is_token_expired_with_expired_token() {
        let mut credentials = KiroCredentials::default();
        credentials.expires_at = Some("2020-01-01T00:00:00Z".to_string());
        assert!(is_token_expired(&credentials));
    }

    #[test]
    fn test_is_token_expired_with_valid_token() {
        let mut credentials = KiroCredentials::default();
        let future = Utc::now() + Duration::hours(1);
        credentials.expires_at = Some(future.to_rfc3339());
        assert!(!is_token_expired(&credentials));
    }

    #[test]
    fn test_is_token_expired_within_5_minutes() {
        let mut credentials = KiroCredentials::default();
        let expires = Utc::now() + Duration::minutes(3);
        credentials.expires_at = Some(expires.to_rfc3339());
        assert!(is_token_expired(&credentials));
    }

    #[test]
    fn test_is_token_expired_no_expires_at() {
        let credentials = KiroCredentials::default();
        assert!(is_token_expired(&credentials));
    }

    #[test]
    fn test_is_token_expiring_soon_within_10_minutes() {
        let mut credentials = KiroCredentials::default();
        let expires = Utc::now() + Duration::minutes(8);
        credentials.expires_at = Some(expires.to_rfc3339());
        assert!(is_token_expiring_soon(&credentials));
    }

    #[test]
    fn test_is_token_expiring_soon_beyond_10_minutes() {
        let mut credentials = KiroCredentials::default();
        let expires = Utc::now() + Duration::minutes(15);
        credentials.expires_at = Some(expires.to_rfc3339());
        assert!(!is_token_expiring_soon(&credentials));
    }

    #[test]
    fn test_validate_refresh_token_missing() {
        let credentials = KiroCredentials::default();
        let result = validate_refresh_token(&credentials);
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_refresh_token_valid() {
        let mut credentials = KiroCredentials::default();
        credentials.refresh_token = Some("a".repeat(150));
        let result = validate_refresh_token(&credentials);
        assert!(result.is_ok());
    }

    #[test]
    fn test_sha256_hex() {
        let result = sha256_hex("test");
        assert_eq!(
            result,
            "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
        );
    }

    #[tokio::test]
    async fn test_refresh_token_rejects_api_key_credential() {
        let config = Config::default();
        let mut credentials = KiroCredentials::default();
        credentials.kiro_api_key = Some("ksk_test_key_123".to_string());
        credentials.auth_method = Some("api_key".to_string());

        let result = refresh_token(&credentials, &config, None).await;

        assert!(result.is_err(), "API Key 凭据应被 refresh_token 拒绝");
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("API Key 凭据不支持刷新"),
            "期望错误消息包含 'API Key 凭据不支持刷新'，实际: {}",
            err_msg
        );
    }

    #[tokio::test]
    async fn test_add_credential_reject_duplicate_refresh_token() {
        let config = Config::default();

        let mut existing = KiroCredentials::default();
        existing.refresh_token = Some("a".repeat(150));

        let manager = MultiTokenManager::new(config, vec![existing], None, None, false).unwrap();

        let mut duplicate = KiroCredentials::default();
        duplicate.refresh_token = Some("a".repeat(150));

        let result = manager.add_credential(duplicate).await;
        assert!(result.is_err());
        assert!(result.err().unwrap().to_string().contains("凭据已存在"));
    }

    #[tokio::test]
    async fn test_add_credential_api_key_success() {
        let config = Config::default();
        let manager = MultiTokenManager::new(config, vec![], None, None, false).unwrap();

        let mut api_key_cred = KiroCredentials::default();
        api_key_cred.kiro_api_key = Some("ksk_test_key_123".to_string());
        api_key_cred.auth_method = Some("api_key".to_string());

        let result = manager.add_credential(api_key_cred).await;
        assert!(result.is_ok());
        let id = result.unwrap();
        assert!(id > 0);
        assert_eq!(manager.total_count(), 1);
        assert_eq!(manager.available_count(), 1);
    }

    #[tokio::test]
    async fn test_add_credential_reject_duplicate_api_key() {
        let config = Config::default();

        let mut existing = KiroCredentials::default();
        existing.kiro_api_key = Some("ksk_existing_key".to_string());
        existing.auth_method = Some("api_key".to_string());

        let manager = MultiTokenManager::new(config, vec![existing], None, None, false).unwrap();

        let mut duplicate = KiroCredentials::default();
        duplicate.kiro_api_key = Some("ksk_existing_key".to_string());
        duplicate.auth_method = Some("api_key".to_string());

        let result = manager.add_credential(duplicate).await;
        assert!(result.is_err());
        assert!(
            result
                .err()
                .unwrap()
                .to_string()
                .contains("kiroApiKey 重复")
        );
    }

    #[tokio::test]
    async fn test_add_credential_api_key_empty_rejected() {
        let config = Config::default();
        let manager = MultiTokenManager::new(config, vec![], None, None, false).unwrap();

        let mut cred = KiroCredentials::default();
        cred.kiro_api_key = Some(String::new());
        cred.auth_method = Some("api_key".to_string());

        let result = manager.add_credential(cred).await;
        assert!(result.is_err());
        assert!(
            result
                .err()
                .unwrap()
                .to_string()
                .contains("kiroApiKey 为空")
        );
    }

    #[tokio::test]
    async fn test_add_credential_api_key_missing_key_rejected() {
        let config = Config::default();
        let manager = MultiTokenManager::new(config, vec![], None, None, false).unwrap();

        let mut cred = KiroCredentials::default();
        cred.auth_method = Some("api_key".to_string());
        // kiro_api_key is None

        let result = manager.add_credential(cred).await;
        assert!(result.is_err());
        assert!(
            result
                .err()
                .unwrap()
                .to_string()
                .contains("缺少 kiroApiKey")
        );
    }

    #[tokio::test]
    async fn test_add_credential_api_key_and_oauth_coexist() {
        let config = Config::default();

        let mut oauth_cred = KiroCredentials::default();
        oauth_cred.refresh_token = Some("a".repeat(150));

        let manager = MultiTokenManager::new(config, vec![oauth_cred], None, None, false).unwrap();

        let mut api_key_cred = KiroCredentials::default();
        api_key_cred.kiro_api_key = Some("ksk_new_key".to_string());
        api_key_cred.auth_method = Some("api_key".to_string());

        let result = manager.add_credential(api_key_cred).await;
        assert!(result.is_ok());
        assert_eq!(manager.total_count(), 2);
        assert_eq!(manager.available_count(), 2);
    }

    // MultiTokenManager 测试

    #[test]
    fn test_multi_token_manager_new() {
        let config = Config::default();
        let mut cred1 = KiroCredentials::default();
        cred1.priority = 0;
        let mut cred2 = KiroCredentials::default();
        cred2.priority = 1;

        let manager =
            MultiTokenManager::new(config, vec![cred1, cred2], None, None, false).unwrap();
        assert_eq!(manager.total_count(), 2);
        assert_eq!(manager.available_count(), 2);
    }

    #[test]
    fn test_multi_token_manager_empty_credentials() {
        let config = Config::default();
        let result = MultiTokenManager::new(config, vec![], None, None, false);
        // 支持 0 个凭据启动（可通过管理面板添加）
        assert!(result.is_ok());
        let manager = result.unwrap();
        assert_eq!(manager.total_count(), 0);
        assert_eq!(manager.available_count(), 0);
    }

    #[test]
    fn test_multi_token_manager_duplicate_ids() {
        let config = Config::default();
        let mut cred1 = KiroCredentials::default();
        cred1.id = Some(1);
        let mut cred2 = KiroCredentials::default();
        cred2.id = Some(1); // 重复 ID

        let result = MultiTokenManager::new(config, vec![cred1, cred2], None, None, false);
        assert!(result.is_err());
        let err_msg = result.err().unwrap().to_string();
        assert!(
            err_msg.contains("重复的凭据 ID"),
            "错误消息应包含 '重复的凭据 ID'，实际: {}",
            err_msg
        );
    }

    #[test]
    fn test_multi_token_manager_api_key_missing_kiro_api_key_auto_disabled() {
        let config = Config::default();

        // auth_method=api_key 但缺少 kiro_api_key → 应被自动禁用
        let mut bad_cred = KiroCredentials::default();
        bad_cred.auth_method = Some("api_key".to_string());
        // kiro_api_key 保持 None

        let mut good_cred = KiroCredentials::default();
        good_cred.refresh_token = Some("valid_token".to_string());

        let manager =
            MultiTokenManager::new(config, vec![bad_cred, good_cred], None, None, false).unwrap();
        assert_eq!(manager.total_count(), 2);
        assert_eq!(manager.available_count(), 1); // bad_cred 被禁用，只剩 1 个可用
    }

    #[test]
    fn test_multi_token_manager_api_key_with_kiro_api_key_not_disabled() {
        let config = Config::default();

        // auth_method=api_key 且有 kiro_api_key → 不应被禁用
        let mut cred = KiroCredentials::default();
        cred.auth_method = Some("api_key".to_string());
        cred.kiro_api_key = Some("ksk_test123".to_string());

        let manager = MultiTokenManager::new(config, vec![cred], None, None, false).unwrap();
        assert_eq!(manager.total_count(), 1);
        assert_eq!(manager.available_count(), 1);
    }

    #[test]
    fn test_multi_token_manager_report_failure() {
        let config = Config::default();
        let cred1 = KiroCredentials::default();
        let cred2 = KiroCredentials::default();

        let manager =
            MultiTokenManager::new(config, vec![cred1, cred2], None, None, false).unwrap();

        // 凭据会自动分配 ID（从 1 开始）
        // 前两次失败不会禁用（使用 ID 1）
        assert!(manager.report_failure(1));
        assert!(manager.report_failure(1));
        assert_eq!(manager.available_count(), 2);

        // 第三次失败会禁用第一个凭据
        assert!(manager.report_failure(1));
        assert_eq!(manager.available_count(), 1);

        // 继续失败第二个凭据（使用 ID 2）
        assert!(manager.report_failure(2));
        assert!(manager.report_failure(2));
        assert!(!manager.report_failure(2)); // 所有凭据都禁用了
        assert_eq!(manager.available_count(), 0);
    }

    #[test]
    fn test_multi_token_manager_report_success() {
        let config = Config::default();
        let cred = KiroCredentials::default();

        let manager = MultiTokenManager::new(config, vec![cred], None, None, false).unwrap();

        // 失败两次（使用 ID 1）
        manager.report_failure(1);
        manager.report_failure(1);

        // 成功后重置计数（使用 ID 1）
        manager.report_success(1);

        // 再失败两次不会禁用
        manager.report_failure(1);
        manager.report_failure(1);
        assert_eq!(manager.available_count(), 1);
    }

    #[test]
    fn test_multi_token_manager_switch_to_next() {
        let config = Config::default();
        let mut cred1 = KiroCredentials::default();
        cred1.refresh_token = Some("token1".to_string());
        let mut cred2 = KiroCredentials::default();
        cred2.refresh_token = Some("token2".to_string());

        let manager =
            MultiTokenManager::new(config, vec![cred1, cred2], None, None, false).unwrap();

        let initial_id = manager.snapshot().current_id;

        // 切换到下一个
        assert!(manager.switch_to_next());
        assert_ne!(manager.snapshot().current_id, initial_id);
    }

    #[test]
    fn test_set_load_balancing_mode_persists_to_config_file() {
        let config_path =
            std::env::temp_dir().join(format!("kiro-load-balancing-{}.json", uuid::Uuid::new_v4()));
        std::fs::write(&config_path, r#"{"loadBalancingMode":"priority"}"#).unwrap();

        let config = Config::load(&config_path).unwrap();
        let manager =
            MultiTokenManager::new(config, vec![KiroCredentials::default()], None, None, false)
                .unwrap();

        manager
            .set_load_balancing_mode("balanced".to_string())
            .unwrap();

        let persisted = Config::load(&config_path).unwrap();
        assert_eq!(persisted.load_balancing_mode, "balanced");
        assert_eq!(manager.get_load_balancing_mode(), "balanced");

        std::fs::remove_file(&config_path).unwrap();
    }

    #[tokio::test]
    async fn test_multi_token_manager_acquire_context_auto_recovers_all_disabled() {
        let config = Config::default();
        let mut cred1 = KiroCredentials::default();
        cred1.access_token = Some("t1".to_string());
        cred1.expires_at = Some((Utc::now() + Duration::hours(1)).to_rfc3339());
        let mut cred2 = KiroCredentials::default();
        cred2.access_token = Some("t2".to_string());
        cred2.expires_at = Some((Utc::now() + Duration::hours(1)).to_rfc3339());

        let manager =
            MultiTokenManager::new(config, vec![cred1, cred2], None, None, false).unwrap();

        // 凭据会自动分配 ID（从 1 开始）
        for _ in 0..MAX_FAILURES_PER_CREDENTIAL {
            manager.report_failure(1);
        }
        for _ in 0..MAX_FAILURES_PER_CREDENTIAL {
            manager.report_failure(2);
        }

        assert_eq!(manager.available_count(), 0);

        // 应触发自愈：重置失败计数并重新启用，避免必须重启进程
        let ctx = manager.acquire_context(None).await.unwrap();
        assert!(ctx.token == "t1" || ctx.token == "t2");
        assert_eq!(manager.available_count(), 2);
    }

    #[tokio::test]
    async fn test_multi_token_manager_acquire_context_balanced_retries_until_bad_credential_disabled()
     {
        let mut config = Config::default();
        config.load_balancing_mode = "balanced".to_string();

        let mut bad_cred = KiroCredentials::default();
        bad_cred.priority = 0;
        bad_cred.refresh_token = Some("bad".to_string());

        let mut good_cred = KiroCredentials::default();
        good_cred.priority = 1;
        good_cred.access_token = Some("good-token".to_string());
        good_cred.expires_at = Some((Utc::now() + Duration::hours(1)).to_rfc3339());

        let manager =
            MultiTokenManager::new(config, vec![bad_cred, good_cred], None, None, false).unwrap();

        let ctx = manager.acquire_context(None).await.unwrap();
        assert_eq!(ctx.id, 2);
        assert_eq!(ctx.token, "good-token");
    }

    /// 构造两张均可用（token 未过期）的凭据 + 指定粘性开关
    fn manager_with_two_live_creds(session_affinity_enabled: bool) -> MultiTokenManager {
        let mut config = Config::default();
        config.session_affinity_enabled = session_affinity_enabled;
        // balanced 模式下每次都会重新均衡选择，最能暴露粘性是否真的生效
        config.load_balancing_mode = "balanced".to_string();

        let expires = (Utc::now() + Duration::hours(1)).to_rfc3339();

        let mut c1 = KiroCredentials::default();
        c1.priority = 0;
        c1.access_token = Some("token-1".to_string());
        c1.expires_at = Some(expires.clone());

        let mut c2 = KiroCredentials::default();
        c2.priority = 1;
        c2.access_token = Some("token-2".to_string());
        c2.expires_at = Some(expires);

        MultiTokenManager::new(config, vec![c1, c2], None, None, false).unwrap()
    }

    #[tokio::test]
    async fn test_forced_refresh_reuses_rotation_while_waiting_for_lock() {
        let manager = manager_with_two_live_creds(false);
        let id = manager.entries.lock()[0].id;
        let guard = manager.refresh_lock.lock().await;
        let refresh = manager.force_refresh_token_for(id);
        tokio::pin!(refresh);
        assert!(futures::poll!(refresh.as_mut()).is_pending());

        // 模拟持锁的反代请求已经完成轮换；旧凭据没有 refreshToken，
        // 若排队请求继续使用旧快照，就会报错。
        manager.entries.lock()[0].credentials.access_token = Some("rotated-token".into());
        drop(guard);

        refresh.await.expect("排队期间已经轮换，应复用新凭据");
        assert_eq!(
            manager.entries.lock()[0]
                .credentials
                .access_token
                .as_deref(),
            Some("rotated-token")
        );
    }

    #[tokio::test]
    async fn test_stale_unauthorized_requests_reuse_current_token() {
        let manager = manager_with_two_live_creds(false);
        let id = manager.entries.lock()[0].id;
        let (first, second) = tokio::join!(
            manager.refresh_token_if_current(id, Some("old-rejected-token")),
            manager.refresh_token_if_current(id, Some("old-rejected-token")),
        );
        first.unwrap();
        second.unwrap();
        assert_eq!(
            manager.entries.lock()[0]
                .credentials
                .access_token
                .as_deref(),
            Some("token-1")
        );
    }

    #[tokio::test]
    async fn test_forced_refresh_rechecks_deleted_credential_after_lock() {
        let manager = manager_with_two_live_creds(false);
        let id = manager.entries.lock()[0].id;
        let guard = manager.refresh_lock.lock().await;
        let refresh = manager.force_refresh_token_for(id);
        tokio::pin!(refresh);
        assert!(futures::poll!(refresh.as_mut()).is_pending());
        manager.entries.lock().retain(|entry| entry.id != id);
        drop(guard);
        assert!(
            refresh
                .await
                .unwrap_err()
                .to_string()
                .contains("凭据不存在")
        );
    }

    #[tokio::test]
    async fn test_affinity_reuses_same_credential_for_same_hint() {
        let manager = manager_with_two_live_creds(true);

        let first = manager
            .acquire_context_with_affinity(None, Some("session-a"))
            .await
            .unwrap();
        // 首次调用后应记录粘性
        assert_eq!(manager.affinity_entry_count(), 1);

        // 同一 hint 的后续调用应复用同一凭据，即使 balanced 模式本会换人
        for _ in 0..3 {
            let next = manager
                .acquire_context_with_affinity(None, Some("session-a"))
                .await
                .unwrap();
            assert_eq!(next.id, first.id);
        }
    }

    #[tokio::test]
    async fn test_affinity_disabled_does_not_record() {
        let manager = manager_with_two_live_creds(false);

        manager
            .acquire_context_with_affinity(None, Some("session-a"))
            .await
            .unwrap();

        // 开关关闭时不应写入任何粘性映射
        assert_eq!(manager.affinity_entry_count(), 0);
    }

    #[tokio::test]
    async fn test_affinity_distinct_hints_tracked_separately() {
        let manager = manager_with_two_live_creds(true);

        manager
            .acquire_context_with_affinity(None, Some("session-a"))
            .await
            .unwrap();
        manager
            .acquire_context_with_affinity(None, Some("session-b"))
            .await
            .unwrap();

        assert_eq!(manager.affinity_entry_count(), 2);
    }

    #[tokio::test]
    async fn test_affinity_without_hint_records_nothing() {
        let manager = manager_with_two_live_creds(true);

        // 无 metadata 的请求（hint 为 None）不应产生粘性条目
        manager
            .acquire_context_with_affinity(None, None)
            .await
            .unwrap();
        assert_eq!(manager.affinity_entry_count(), 0);
    }

    #[tokio::test]
    async fn test_affinity_falls_back_when_stuck_credential_disabled() {
        let manager = manager_with_two_live_creds(true);

        let first = manager
            .acquire_context_with_affinity(None, Some("session-a"))
            .await
            .unwrap();

        // 禁用粘住的那张凭据，粘性应无声失效并回退到另一张
        manager.set_disabled(first.id, true).unwrap();

        let next = manager
            .acquire_context_with_affinity(None, Some("session-a"))
            .await
            .unwrap();
        assert_ne!(next.id, first.id);
    }

    #[tokio::test]
    async fn test_affinity_plain_acquire_context_stays_unaffected() {
        let manager = manager_with_two_live_creds(true);

        // 不带 hint 的旧入口行为不变，也不写粘性
        manager.acquire_context(None).await.unwrap();
        assert_eq!(manager.affinity_entry_count(), 0);
    }

    #[test]
    fn test_multi_token_manager_report_refresh_failure() {
        let config = Config::default();
        let cred1 = KiroCredentials::default();
        let cred2 = KiroCredentials::default();

        let manager =
            MultiTokenManager::new(config, vec![cred1, cred2], None, None, false).unwrap();

        assert_eq!(manager.available_count(), 2);
        for _ in 0..(MAX_FAILURES_PER_CREDENTIAL - 1) {
            assert!(manager.report_refresh_failure(1));
        }
        assert_eq!(manager.available_count(), 2);

        assert!(manager.report_refresh_failure(1));
        assert_eq!(manager.available_count(), 1);

        let snapshot = manager.snapshot();
        let first = snapshot.entries.iter().find(|e| e.id == 1).unwrap();
        assert!(first.disabled);
        assert_eq!(first.refresh_failure_count, MAX_FAILURES_PER_CREDENTIAL);
        assert_eq!(snapshot.current_id, 2);
    }

    #[tokio::test]
    async fn test_multi_token_manager_refresh_failure_disabled_is_not_auto_recovered() {
        let config = Config::default();
        let cred1 = KiroCredentials::default();
        let cred2 = KiroCredentials::default();

        let manager =
            MultiTokenManager::new(config, vec![cred1, cred2], None, None, false).unwrap();

        for _ in 0..MAX_FAILURES_PER_CREDENTIAL {
            manager.report_refresh_failure(1);
            manager.report_refresh_failure(2);
        }
        assert_eq!(manager.available_count(), 0);

        let err = manager
            .acquire_context(None)
            .await
            .err()
            .unwrap()
            .to_string();
        assert!(
            err.contains("所有凭据均已禁用"),
            "错误应提示所有凭据禁用，实际: {}",
            err
        );
    }

    #[test]
    fn test_multi_token_manager_report_quota_exhausted() {
        let config = Config::default();
        let cred1 = KiroCredentials::default();
        let cred2 = KiroCredentials::default();

        let manager =
            MultiTokenManager::new(config, vec![cred1, cred2], None, None, false).unwrap();

        // 凭据会自动分配 ID（从 1 开始）
        assert_eq!(manager.available_count(), 2);
        assert!(manager.report_quota_exhausted(1));
        assert_eq!(manager.available_count(), 1);

        // 再禁用第二个后，无可用凭据
        assert!(!manager.report_quota_exhausted(2));
        assert_eq!(manager.available_count(), 0);
    }

    #[tokio::test]
    async fn test_multi_token_manager_quota_disabled_is_not_auto_recovered() {
        let config = Config::default();
        let cred1 = KiroCredentials::default();
        let cred2 = KiroCredentials::default();

        let manager =
            MultiTokenManager::new(config, vec![cred1, cred2], None, None, false).unwrap();

        manager.report_quota_exhausted(1);
        manager.report_quota_exhausted(2);
        assert_eq!(manager.available_count(), 0);

        let err = manager
            .acquire_context(None)
            .await
            .err()
            .unwrap()
            .to_string();
        assert!(
            err.contains("所有凭据均已禁用"),
            "错误应提示所有凭据禁用，实际: {}",
            err
        );
        assert_eq!(manager.available_count(), 0);
    }

    // ============ 凭据级 Region 优先级测试 ============

    #[test]
    fn test_credential_region_priority_uses_credential_auth_region() {
        // 凭据配置了 auth_region 时，应使用凭据的 auth_region
        let mut config = Config::default();
        config.region = "us-west-2".to_string();

        let mut credentials = KiroCredentials::default();
        credentials.auth_region = Some("eu-west-1".to_string());

        let region = credentials.effective_auth_region(&config);
        assert_eq!(region, "eu-west-1");
    }

    #[test]
    fn test_credential_region_priority_fallback_to_credential_region() {
        // 凭据未配置 auth_region 但配置了 region 时，应回退到凭据.region
        let mut config = Config::default();
        config.region = "us-west-2".to_string();

        let mut credentials = KiroCredentials::default();
        credentials.region = Some("eu-central-1".to_string());

        let region = credentials.effective_auth_region(&config);
        assert_eq!(region, "eu-central-1");
    }

    #[test]
    fn test_credential_region_priority_fallback_to_config() {
        // 凭据未配置 auth_region 和 region 时，应回退到 config
        let mut config = Config::default();
        config.region = "us-west-2".to_string();

        let credentials = KiroCredentials::default();
        assert!(credentials.auth_region.is_none());
        assert!(credentials.region.is_none());

        let region = credentials.effective_auth_region(&config);
        assert_eq!(region, "us-west-2");
    }

    #[test]
    fn test_multiple_credentials_use_respective_regions() {
        // 多凭据场景下，不同凭据使用各自的 auth_region
        let mut config = Config::default();
        config.region = "ap-northeast-1".to_string();

        let mut cred1 = KiroCredentials::default();
        cred1.auth_region = Some("us-east-1".to_string());

        let mut cred2 = KiroCredentials::default();
        cred2.region = Some("eu-west-1".to_string());

        let cred3 = KiroCredentials::default(); // 无 region，使用 config

        assert_eq!(cred1.effective_auth_region(&config), "us-east-1");
        assert_eq!(cred2.effective_auth_region(&config), "eu-west-1");
        assert_eq!(cred3.effective_auth_region(&config), "ap-northeast-1");
    }

    #[test]
    fn test_idc_oidc_endpoint_uses_credential_auth_region() {
        // 验证 IdC OIDC endpoint URL 使用凭据 auth_region
        let mut config = Config::default();
        config.region = "us-west-2".to_string();

        let mut credentials = KiroCredentials::default();
        credentials.auth_region = Some("eu-central-1".to_string());

        let region = credentials.effective_auth_region(&config);
        let refresh_url = format!("https://oidc.{}.amazonaws.com/token", region);

        assert_eq!(refresh_url, "https://oidc.eu-central-1.amazonaws.com/token");
    }

    #[test]
    fn test_social_refresh_endpoint_uses_credential_auth_region() {
        // 验证 Social refresh endpoint URL 使用凭据 auth_region
        let mut config = Config::default();
        config.region = "us-west-2".to_string();

        let mut credentials = KiroCredentials::default();
        credentials.auth_region = Some("ap-southeast-1".to_string());

        let region = credentials.effective_auth_region(&config);
        let refresh_url = format!("https://prod.{}.auth.desktop.kiro.dev/refreshToken", region);

        assert_eq!(
            refresh_url,
            "https://prod.ap-southeast-1.auth.desktop.kiro.dev/refreshToken"
        );
    }

    #[test]
    fn test_api_call_uses_effective_api_region() {
        // 验证 API 调用使用 effective_api_region
        let mut config = Config::default();
        config.region = "us-west-2".to_string();

        let mut credentials = KiroCredentials::default();
        credentials.region = Some("eu-west-1".to_string());

        // 凭据.region 不参与 api_region 回退链
        let api_region = credentials.effective_api_region(&config);
        let api_host = format!("q.{}.amazonaws.com", api_region);

        assert_eq!(api_host, "q.us-west-2.amazonaws.com");
    }

    #[test]
    fn test_api_call_uses_credential_api_region() {
        // 凭据配置了 api_region 时，API 调用应使用凭据的 api_region
        let mut config = Config::default();
        config.region = "us-west-2".to_string();

        let mut credentials = KiroCredentials::default();
        credentials.api_region = Some("eu-central-1".to_string());

        let api_region = credentials.effective_api_region(&config);
        let api_host = format!("q.{}.amazonaws.com", api_region);

        assert_eq!(api_host, "q.eu-central-1.amazonaws.com");
    }

    #[test]
    fn test_credential_region_empty_string_treated_as_set() {
        // 空字符串 auth_region 被视为已设置（虽然不推荐，但行为应一致）
        let mut config = Config::default();
        config.region = "us-west-2".to_string();

        let mut credentials = KiroCredentials::default();
        credentials.auth_region = Some("".to_string());

        let region = credentials.effective_auth_region(&config);
        // 空字符串被视为已设置，不会回退到 config
        assert_eq!(region, "");
    }

    #[test]
    fn test_auth_and_api_region_independent() {
        // auth_region 和 api_region 互不影响
        let mut config = Config::default();
        config.region = "default".to_string();

        let mut credentials = KiroCredentials::default();
        credentials.auth_region = Some("auth-only".to_string());
        credentials.api_region = Some("api-only".to_string());

        assert_eq!(credentials.effective_auth_region(&config), "auth-only");
        assert_eq!(credentials.effective_api_region(&config), "api-only");
    }

    #[test]
    fn test_stats_entry_reads_legacy_file_without_token_fields() {
        // 老版本 kiro_stats.json 没有 input_tokens / output_tokens 两个键。
        // 必须按 0 读入而不是让整份统计解析失败，否则升级后成功次数会全部归零。
        let legacy = r#"{"success_count":128,"last_used_at":"2026-08-08T13:18:31Z"}"#;
        let entry: StatsEntry = serde_json::from_str(legacy).expect("旧格式应能解析");
        assert_eq!(entry.success_count, 128);
        assert_eq!(entry.input_tokens, 0);
        assert_eq!(entry.output_tokens, 0);
    }

    #[test]
    fn test_stats_entry_roundtrip_with_token_fields() {
        let entry = StatsEntry {
            success_count: 7,
            last_used_at: None,
            input_tokens: 12_345,
            output_tokens: 678,
        };
        let json = serde_json::to_string(&entry).expect("序列化应成功");
        let parsed: StatsEntry = serde_json::from_str(&json).expect("反序列化应成功");
        assert_eq!(parsed.success_count, 7);
        assert_eq!(parsed.input_tokens, 12_345);
        assert_eq!(parsed.output_tokens, 678);
    }

    #[tokio::test]
    async fn test_record_token_usage_accumulates_per_credential() {
        let config = Config::default();
        let mut cred = KiroCredentials::default();
        cred.refresh_token = Some("rt-1".to_string());
        let manager = MultiTokenManager::new(config, vec![cred], None, None, false).unwrap();

        let id = manager.snapshot().entries[0].id;
        manager.record_token_usage(id, 100, 20);
        manager.record_token_usage(id, 5, 3);

        let snapshot = manager.snapshot();
        let entry = snapshot.entries.iter().find(|e| e.id == id).unwrap();
        assert_eq!(entry.input_tokens, 105);
        assert_eq!(entry.output_tokens, 23);
        // 记 token 不应影响成功计数：两者由不同事件驱动
        assert_eq!(entry.success_count, 0);
    }

    #[tokio::test]
    async fn test_record_token_usage_ignores_zero_and_unknown_id() {
        let config = Config::default();
        let mut cred = KiroCredentials::default();
        cred.refresh_token = Some("rt-1".to_string());
        let manager = MultiTokenManager::new(config, vec![cred], None, None, false).unwrap();
        let id = manager.snapshot().entries[0].id;

        // 全 0 直接返回，不产生无意义的落盘
        manager.record_token_usage(id, 0, 0);
        // 未知 id（凭据已被删除）不应 panic
        manager.record_token_usage(id + 9999, 50, 50);

        let snapshot = manager.snapshot();
        let entry = snapshot.entries.iter().find(|e| e.id == id).unwrap();
        assert_eq!(entry.input_tokens, 0);
        assert_eq!(entry.output_tokens, 0);
    }

    // ============ 共享账号库模式 ============

    fn db_manager() -> (MultiTokenManager, Arc<AccountStore>, std::path::PathBuf) {
        let (store, path) = crate::kiro::account_store::test_store();
        let store = Arc::new(store);
        let m = MultiTokenManager::new_with_store(Config::default(), store.clone(), None).unwrap();
        (m, store, path)
    }

    fn live_oauth(rt: &str) -> KiroCredentials {
        KiroCredentials {
            refresh_token: Some(rt.into()),
            access_token: Some(format!("at-{rt}")),
            expires_at: Some((Utc::now() + Duration::hours(1)).to_rfc3339()),
            auth_method: Some("social".into()),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn db_import_dedups_and_only_pool_members_are_scheduled() {
        let (m, _, _) = db_manager();
        let meta = |uuid: &str, in_pool| NewAccountMeta {
            account_uuid: Some(uuid.into()),
            in_pool,
            ..Default::default()
        };
        let first = m
            .import_credential(live_oauth("rt-a"), meta("p-a", false))
            .unwrap();
        assert!(first.created);
        let a = first.id;
        // 同一 refresh token / 同一 account_uuid 不会重复创建
        assert_eq!(
            m.import_credential(live_oauth("rt-a"), meta("p-x", false))
                .unwrap()
                .id,
            a
        );
        assert_eq!(
            m.import_credential(live_oauth("rt-z"), meta("p-a", false))
                .unwrap()
                .id,
            a
        );
        // 不在号池的账号不参与调度
        assert!(m.acquire_context(None).await.is_err());
        m.set_in_pool(a, true).unwrap();
        assert_eq!(m.acquire_context(None).await.unwrap().id, a);
        m.set_in_pool(a, false).unwrap();
        assert!(m.acquire_context(None).await.is_err());
        assert_eq!(m.snapshot().available, 0);
    }

    #[tokio::test]
    async fn db_auto_disable_reason_survives_restart() {
        let (m, store, _) = db_manager();
        let id = m
            .import_credential(
                live_oauth("rt-a"),
                NewAccountMeta {
                    in_pool: true,
                    ..Default::default()
                },
            )
            .unwrap()
            .id;
        m.report_quota_exhausted(id);
        drop(m);
        let reloaded = MultiTokenManager::new_with_store(Config::default(), store, None).unwrap();
        let entry = &reloaded.snapshot().entries[0];
        assert!(entry.disabled);
        assert_eq!(entry.disabled_reason.as_deref(), Some("QuotaExceeded"));
    }

    #[tokio::test]
    async fn db_counters_are_flushed_and_reloaded() {
        let (m, store, _) = db_manager();
        let id = m
            .import_credential(
                live_oauth("rt-a"),
                NewAccountMeta {
                    in_pool: true,
                    ..Default::default()
                },
            )
            .unwrap()
            .id;
        m.report_success(id);
        m.record_token_usage(id, 11, 22);
        m.flush_stats();
        drop(m);
        let reloaded = MultiTokenManager::new_with_store(Config::default(), store, None).unwrap();
        let entry = &reloaded.snapshot().entries[0];
        assert_eq!(entry.success_count, 1);
        assert_eq!((entry.input_tokens, entry.output_tokens), (11, 22));
        assert!(entry.last_used_at.is_some());
    }

    #[tokio::test]
    async fn db_ensure_fresh_reuses_when_version_moved_or_token_valid() {
        let (m, _, _) = db_manager();
        let id = m
            .import_credential(live_oauth("rt-a"), NewAccountMeta::default())
            .unwrap()
            .id;
        // token 有效、未强制：不刷新
        assert_eq!(m.ensure_fresh(id, None, false).await.unwrap(), 0);
        // 调用方持有的版本已落后：即使 force 也直接复用，不再轮换
        assert_eq!(m.ensure_fresh(id, Some(-1), true).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn db_delete_is_soft_and_blocks_reimport_of_same_uuid() {
        let (m, store, _) = db_manager();
        let meta = NewAccountMeta {
            account_uuid: Some("p-a".into()),
            ..Default::default()
        };
        let id = m
            .import_credential(live_oauth("rt-a"), meta.clone())
            .unwrap()
            .id;
        m.set_disabled(id, true).unwrap();
        m.delete_credential(id).unwrap();
        assert!(m.snapshot().entries.is_empty());
        assert!(m.import_credential(live_oauth("rt-b"), meta).is_err());
        let reloaded = MultiTokenManager::new_with_store(Config::default(), store, None).unwrap();
        assert!(reloaded.snapshot().entries.is_empty());
    }

    #[test]
    fn db_json_only_operations_are_rejected_without_store() {
        let m = MultiTokenManager::new(Config::default(), vec![], None, None, false).unwrap();
        assert!(m.set_in_pool(1, true).is_err());
        assert!(
            m.import_credential(live_oauth("rt"), NewAccountMeta::default())
                .is_err()
        );
    }

    #[tokio::test]
    async fn db_add_existing_credential_puts_it_into_pool() {
        let (m, _, _) = db_manager();
        let api = KiroCredentials {
            auth_method: Some("api_key".into()),
            kiro_api_key: Some("ksk_existing_key".into()),
            ..Default::default()
        };
        let id = m
            .import_credential(api.clone(), NewAccountMeta::default())
            .unwrap()
            .id;
        assert!(!m.snapshot().entries[0].in_pool);
        // Admin "添加凭据"遇到库中已有的同一凭据：不报错，改为入池并返回已有 ID
        assert_eq!(m.add_credential(api).await.unwrap(), id);
        assert!(m.snapshot().entries[0].in_pool);
        m.purge_credential(id).unwrap();
        assert!(m.snapshot().entries.is_empty());
    }

    #[tokio::test]
    async fn db_relogin_by_upstream_identity_replaces_credentials_in_place() {
        let (m, store, _) = db_manager();
        let meta = |uuid: &str| NewAccountMeta {
            account_uuid: Some(uuid.into()),
            upstream_identity: Some("user-1".into()),
            in_pool: true,
            ..Default::default()
        };
        let first = m
            .import_credential(live_oauth("rt-old"), meta("p-old"))
            .unwrap();
        assert!(first.created);
        // 旧 token 失效被禁用
        m.report_refresh_token_invalid(first.id);
        assert!(m.snapshot().entries[0].disabled);
        // 旧凭据发起的额度查询还没回来
        let stale_seq = store.begin_usage(first.id).unwrap();
        // 在途刷新拿到的基准版本
        let base = store.begin_refresh(first.id).unwrap();

        // 用户重新登录同一个上游账号（proxy 里是一个新账号 ID）
        let relogin = m
            .import_credential(live_oauth("rt-new"), meta("p-new"))
            .unwrap();
        assert_eq!(
            relogin,
            ImportOutcome {
                id: first.id,
                created: false,
                replaced: true
            }
        );
        let entry = &m.snapshot().entries[0];
        assert_eq!(m.snapshot().entries.len(), 1, "不新增行");
        assert!(!entry.disabled, "失效禁用被解除");
        assert_eq!(entry.credential_version, base + 1);
        let row = &store.load_all().unwrap()[0];
        assert_eq!(row.credentials.refresh_token.as_deref(), Some("rt-new"));
        assert!(!row.credentials.disabled);

        // 迟到的旧刷新结果写不进去（版本已变）
        assert!(
            store
                .save_rotated_credentials(first.id, Some(base), &live_oauth("rt-from-old-refresh"))
                .is_err()
        );
        // 旧额度查询的结果被丢弃
        let write = UsageWrite {
            seq: stale_seq,
            raw_json: "{}",
            used_amount: 1.0,
            limit_amount: 1.0,
            reset_at_ms: None,
            subscription_title: None,
            upstream_identity: None,
        };
        assert!(!store.finish_usage(first.id, &write).unwrap());
        assert_eq!(
            store.load_all().unwrap()[0]
                .credentials
                .refresh_token
                .as_deref(),
            Some("rt-new")
        );
    }

    #[tokio::test]
    async fn db_manual_disable_survives_relogin() {
        let (m, _, _) = db_manager();
        let meta = NewAccountMeta {
            upstream_identity: Some("user-2".into()),
            ..Default::default()
        };
        let id = m
            .import_credential(live_oauth("rt-a"), meta.clone())
            .unwrap()
            .id;
        m.set_disabled(id, true).unwrap();
        let again = m.import_credential(live_oauth("rt-b"), meta).unwrap();
        assert!(again.replaced);
        // 手动禁用不是凭据问题，重新登录不应自动解除
        assert!(m.snapshot().entries[0].disabled);
    }

    #[tokio::test]
    async fn a03_a14_pool_toggle_never_touches_credentials() {
        let (m, store, _) = db_manager();
        let id = m
            .import_credential(live_oauth("rt-a"), NewAccountMeta::default())
            .unwrap()
            .id;
        let before = store.load_all().unwrap()[0].credentials.clone();
        m.set_in_pool(id, true).unwrap();
        m.set_in_pool(id, false).unwrap();
        m.set_in_pool(id, true).unwrap();
        let after = &store.load_all().unwrap()[0];
        assert_eq!(after.credential_version, 0, "入池出池不刷新、不轮换");
        assert_eq!(after.credentials.refresh_token, before.refresh_token);
        assert_eq!(after.credentials.access_token, before.access_token);
        assert_eq!(after.credentials.expires_at, before.expires_at);
        // 出池不删除账号
        m.set_in_pool(id, false).unwrap();
        assert_eq!(m.snapshot().entries.len(), 1);
    }

    #[tokio::test]
    async fn a15_late_refresh_result_cannot_revive_deleted_account() {
        let (m, store, _) = db_manager();
        let id = m
            .import_credential(live_oauth("rt-a"), NewAccountMeta::default())
            .unwrap()
            .id;
        let base = store.begin_refresh(id).unwrap();
        m.purge_credential(id).unwrap();
        // 在途刷新回来了：写入账号凭据表不会让账号重新出现
        let _ = store.save_rotated_credentials(id, Some(base), &live_oauth("rt-late"));
        assert!(store.load_all().unwrap().is_empty());
        let reloaded = MultiTokenManager::new_with_store(Config::default(), store, None).unwrap();
        assert!(reloaded.snapshot().entries.is_empty());
    }

    #[tokio::test]
    async fn a08_api_key_account_is_never_refreshed() {
        let (m, store, _) = db_manager();
        let key = KiroCredentials {
            auth_method: Some("api_key".into()),
            kiro_api_key: Some("ksk_no_refresh".into()),
            ..Default::default()
        };
        let id = m
            .import_credential(key, NewAccountMeta::default())
            .unwrap()
            .id;
        // 强制刷新也直接返回当前版本，不进入 OAuth 刷新
        assert_eq!(m.ensure_fresh(id, None, true).await.unwrap(), 0);
        assert_eq!(store.load_all().unwrap()[0].credential_version, 0);
    }

    #[tokio::test]
    async fn a05_concurrent_ensure_fresh_on_valid_token_does_not_refresh() {
        let (m, store, _) = db_manager();
        let m = Arc::new(m);
        let id = m
            .import_credential(live_oauth("rt-a"), NewAccountMeta::default())
            .unwrap()
            .id;
        let tasks: Vec<_> = (0..16)
            .map(|_| {
                let m = m.clone();
                tokio::spawn(async move { m.ensure_fresh(id, None, false).await.unwrap() })
            })
            .collect();
        for task in tasks {
            assert_eq!(task.await.unwrap(), 0);
        }
        assert_eq!(store.load_all().unwrap()[0].credential_version, 0);
    }

    #[tokio::test]
    async fn a40_reimport_after_delete_creates_new_row_without_old_stats() {
        let (m, store, _) = db_manager();
        let meta = |uuid: &str| NewAccountMeta {
            account_uuid: Some(uuid.into()),
            upstream_identity: Some("user-del".into()),
            in_pool: true,
            ..Default::default()
        };
        let old = m
            .import_credential(live_oauth("rt-1"), meta("p-1"))
            .unwrap()
            .id;
        m.report_success(old);
        m.flush_stats();
        m.purge_credential(old).unwrap();
        // 同一上游账号删除后重新导入：已删除行不参与身份匹配，新建一行，唯一索引不冲突
        let again = m
            .import_credential(live_oauth("rt-2"), meta("p-2"))
            .unwrap();
        assert!(again.created && !again.replaced);
        assert_ne!(again.id, old);
        let rows = store.load_all().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].counters.success_count, 0, "旧行统计不被复用");
    }
}
