//! Admin API 类型定义

use serde::{Deserialize, Serialize};

// ============ 凭据状态 ============

/// 所有凭据状态响应
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialsStatusResponse {
    /// 凭据总数
    pub total: usize,
    /// 可用凭据数量（未禁用）
    pub available: usize,
    /// 当前活跃凭据 ID
    pub current_id: u64,
    /// 各凭据状态列表
    pub credentials: Vec<CredentialStatusItem>,
}

/// 单个凭据的状态信息
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatusItem {
    /// 凭据唯一 ID
    pub id: u64,
    /// 不随 token 轮换变化的凭据身份
    pub credential_identity: Option<String>,
    /// 优先级（数字越小优先级越高）
    pub priority: u32,
    /// 是否被禁用
    pub disabled: bool,
    /// 连续失败次数
    pub failure_count: u32,
    /// 是否为当前活跃凭据
    pub is_current: bool,
    /// Token 过期时间（RFC3339 格式）
    pub expires_at: Option<String>,
    /// 认证方式
    pub auth_method: Option<String>,
    /// 是否有 Profile ARN
    pub has_profile_arn: bool,
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
    /// 经本反代成功调用累计的输入 tokens
    ///
    /// 与 `/balance` 的 currentUsage 口径不同：那是账号总额度消耗（号被别处
    /// 共用时会一起涨），这里只统计走本反代的请求。
    pub input_tokens: u64,
    /// 经本反代成功调用累计的输出 tokens
    pub output_tokens: u64,
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
    /// 端点名称（决定该凭据走哪套 Kiro API，已回退到默认端点）
    pub endpoint: String,
    /// 实际生效的 Auth Region（Token 刷新用），已回退到全局配置
    pub auth_region: String,
    /// 实际生效的 API Region（API 请求用），已回退到全局配置
    pub api_region: String,
    /// 是否在反代号池中（账号库模式下可能为 false）
    pub in_pool: bool,
    /// 账号库凭据版本，调用 ensure-fresh 时回传
    pub credential_version: i64,
    /// 由 kiro-cli 刷新（kiro-cli 当前登录的账号，kiro-rs 不刷新它）
    pub external_refresh: bool,
}

// ============ 操作请求 ============

/// 启用/禁用凭据请求
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetDisabledRequest {
    /// 是否禁用
    pub disabled: bool,
}

/// 修改优先级请求
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetPriorityRequest {
    /// 新优先级值
    pub priority: u32,
}

/// 添加凭据请求
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddCredentialRequest {
    /// 刷新令牌（OAuth 凭据必填，API Key 凭据不需要）
    pub refresh_token: Option<String>,

    /// 认证方式（可选，默认 social）
    #[serde(default = "default_auth_method")]
    pub auth_method: String,

    /// OIDC Client ID（IdC 认证需要）
    pub client_id: Option<String>,

    /// OIDC Client Secret（IdC 认证需要）
    pub client_secret: Option<String>,

    /// 优先级（可选，默认 0）
    #[serde(default)]
    pub priority: u32,

    /// 凭据级 Region 配置（用于 OIDC token 刷新）
    /// 未配置时回退到 config.json 的全局 region
    pub region: Option<String>,

    /// 凭据级 Auth Region（用于 Token 刷新）
    pub auth_region: Option<String>,

    /// 凭据级 API Region（用于 API 请求）
    pub api_region: Option<String>,

    /// 凭据级 Machine ID（可选，64 位字符串）
    /// 未配置时回退到 config.json 的 machineId
    pub machine_id: Option<String>,

    /// 用户邮箱（可选，用于前端显示）
    pub email: Option<String>,

    /// 凭据级代理 URL（可选，特殊值 "direct" 表示不使用代理）
    pub proxy_url: Option<String>,

    /// 凭据级代理认证用户名（可选）
    pub proxy_username: Option<String>,

    /// 凭据级代理认证密码（可选）
    pub proxy_password: Option<String>,

    /// Kiro API Key（API Key 凭据必填，格式: ksk_xxxxxxxx）
    /// 设置后直接作为 Bearer Token 使用，无需 refreshToken
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kiro_api_key: Option<String>,

    /// 端点名称（可选，未配置时使用 config.defaultEndpoint）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
}

fn default_auth_method() -> String {
    "social".to_string()
}

/// 添加凭据成功响应
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddCredentialResponse {
    pub success: bool,
    pub message: String,
    /// 新添加的凭据 ID
    pub credential_id: u64,
    pub credential_identity: Option<String>,
    /// 用户邮箱（如果获取成功）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

// ============ 余额查询 ============

/// 人工查询/验活绕过余额缓存；周期同步保留默认缓存。
#[derive(Debug, Default, Deserialize)]
pub struct BalanceQuery {
    #[serde(default)]
    pub fresh: bool,
}

/// 余额查询响应
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceResponse {
    /// 凭据 ID
    pub id: u64,
    /// 订阅类型
    pub subscription_title: Option<String>,
    /// 当前使用量
    pub current_usage: f64,
    /// 使用限额
    pub usage_limit: f64,
    /// 剩余额度
    pub remaining: f64,
    /// 使用百分比
    pub usage_percentage: f64,
    /// 下次重置时间（Unix 时间戳）
    pub next_reset_at: Option<f64>,
}

// ============ 负载均衡配置 ============

/// 负载均衡模式响应
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadBalancingModeResponse {
    /// 当前模式（"priority" 或 "balanced"）
    pub mode: String,
}

/// 设置负载均衡模式请求
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetLoadBalancingModeRequest {
    /// 模式（"priority" 或 "balanced"）
    pub mode: String,
}

// ============ 通用响应 ============

/// 操作成功响应
#[derive(Debug, Serialize)]
pub struct SuccessResponse {
    pub success: bool,
    pub message: String,
}

impl SuccessResponse {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            success: true,
            message: message.into(),
        }
    }
}

/// 错误响应
#[derive(Debug, Serialize)]
pub struct AdminErrorResponse {
    pub error: AdminError,
}

#[derive(Debug, Serialize)]
pub struct AdminError {
    #[serde(rename = "type")]
    pub error_type: String,
    pub message: String,
}

impl AdminErrorResponse {
    pub fn new(error_type: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            error: AdminError {
                error_type: error_type.into(),
                message: message.into(),
            },
        }
    }

    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new("invalid_request", message)
    }

    pub fn authentication_error() -> Self {
        Self::new("authentication_error", "Invalid or missing admin API key")
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new("not_found", message)
    }

    pub fn api_error(message: impl Into<String>) -> Self {
        Self::new("api_error", message)
    }

    pub fn internal_error(message: impl Into<String>) -> Self {
        Self::new("internal_error", message)
    }
}

// ============ 共享账号库（proxy-rs 接入） ============

/// POST /credentials/:id/pool
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetInPoolRequest {
    pub in_pool: bool,
}

/// POST /credentials/:id/ensure-fresh
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureFreshRequest {
    /// 调用方所用 token 的版本；与当前版本不同说明已被轮换，直接复用
    #[serde(default)]
    pub expected_credential_version: Option<i64>,
    /// 为 true 时即使未过期也刷新（仅当版本仍是 expected 时生效）
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureFreshResponse {
    pub credential_version: i64,
}

/// POST /credentials/:id/proxy
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetProxyRequest {
    pub proxy_url: Option<String>,
    pub proxy_username: Option<String>,
    pub proxy_password: Option<String>,
}

/// POST /accounts/import：导入已有凭据，不刷新、不查额度
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportAccountRequest {
    /// proxy 侧账号 ID
    pub account_uuid: Option<String>,
    #[serde(default)]
    pub in_pool: bool,
    #[serde(default = "default_auth_method")]
    pub auth_method: String,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    /// 过期时间，Unix 毫秒
    pub expires_at_ms: Option<i64>,
    pub kiro_api_key: Option<String>,
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub profile_arn: Option<String>,
    pub region: Option<String>,
    pub auth_region: Option<String>,
    pub api_region: Option<String>,
    pub machine_id: Option<String>,
    pub email: Option<String>,
    pub proxy_url: Option<String>,
    pub proxy_username: Option<String>,
    pub proxy_password: Option<String>,
    pub endpoint: Option<String>,
    #[serde(default)]
    pub priority: u32,
    /// proxy 侧登录来源（BuilderId / Enterprise / Github / Google）
    pub provider: Option<String>,
    pub start_url: Option<String>,
    /// proxy 侧其余非秘密凭据配置
    pub extra: Option<serde_json::Value>,
    pub nickname: Option<String>,
    pub group_id: Option<String>,
    pub tags: Option<Vec<String>>,
    pub metadata: Option<serde_json::Value>,
    /// 旧额度展示数据（{usage, subscription}），kiro-rs 首次查询前 proxy-rs 用它展示
    pub legacy_usage: Option<serde_json::Value>,
    /// 上游账号身份（userInfo.userId）：命中库中已有账号时视为重新登录，替换其凭据
    pub upstream_identity: Option<String>,
}

/// POST /accounts/adopt：收编外部（kiro-cli）自行刷新得到的凭据
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptCredentialRequest {
    /// 调用方认为的账号（proxy 侧账号 ID）；只用于查询身份时沿用其机器码与代理
    pub account_uuid: Option<String>,
    #[serde(default = "default_auth_method")]
    pub auth_method: String,
    pub access_token: String,
    pub refresh_token: String,
    /// 过期时间，Unix 毫秒
    pub expires_at_ms: Option<i64>,
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub profile_arn: Option<String>,
    pub region: Option<String>,
}

/// PUT /accounts/external-refresh：指定由 kiro-cli 刷新的账号（null 取消）
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetExternalRefreshRequest {
    pub account_uuid: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetExternalRefreshResponse {
    /// 生效的凭据 ID；未指定时为 null
    pub credential_id: Option<u64>,
}

/// POST /accounts/adopt 的结果
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptCredentialResponse {
    /// adopted：已换成外部这份；current：库里已是这份；stale：外部这份更旧，未替换；
    /// not_found：上游身份不在账号库中
    pub outcome: &'static str,
    pub credential_id: Option<u64>,
    pub credential_version: Option<i64>,
}

/// GET /credentials 查询参数
#[derive(Debug, Default, Deserialize)]
pub struct ListCredentialsQuery {
    /// 账号库模式下默认只列号池中的账号；all=true 列出全部
    #[serde(default)]
    pub all: bool,
}

/// DELETE /credentials/:id 查询参数
#[derive(Debug, Default, Deserialize)]
pub struct DeleteCredentialQuery {
    /// 账号库模式：false（默认）= 移出号池、保留账号；true = 从账号库删除
    #[serde(default)]
    pub purge: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportAccountResponse {
    pub credential_id: u64,
    /// false 表示命中已有账号，未新建
    pub created: bool,
    /// true 表示按上游身份命中已有账号并替换了凭据（重新登录）
    pub replaced: bool,
}

/// GET /store/info
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreInfoResponse {
    pub enabled: bool,
    pub database_id: Option<String>,
    pub path: Option<String>,
    /// 由 kiro-cli 刷新的账号（kiro-rs 不刷新它）
    pub external_refresh_credential_id: Option<u64>,
}
