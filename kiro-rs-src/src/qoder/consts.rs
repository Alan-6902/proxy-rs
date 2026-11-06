//! Qoder 国际版的上游地址、客户端身份与超时常量

/// 桌面端 worker 协议版本，与 Magpie Qoder 插件 0.2.61 一致；不能混用 CLI 版本
pub const COSY_VERSION: &str = "1.1.69";
/// 插件使用 fetch 的默认 UA
pub const COSY_USER_AGENT: &str = "undici";
/// 桌面端客户端身份；业务场景与请求体也必须使用 app
pub const COSY_CLIENT_TYPE: &str = "10";
pub const COSY_PRODUCT: &str = "app";
/// 非推理请求沿用桌面端 prepareRequest 的设备类型
pub const COSY_LIST_MACHINE_TYPE: &str = "5";

/// 推理网关候选，按官方顺序：api3 主、api2/api1 备。签名只覆盖 path，换主机不影响签名
pub const GATEWAYS: [&str; 3] = ["https://api3.qoder.sh", "https://api2.qoder.sh", "https://api1.qoder.sh"];
pub const CHAT_PATH: &str =
    "/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
pub const MODEL_LIST_PATH: &str = "/algo/api/v2/model/list?Encode=1";

/// 账号面接口（纯 Bearer，无 COSY 签名）
pub const OPENAPI_BASE: &str = "https://openapi.qoder.sh";
pub const PATH_JOB_EXCHANGE: &str = "/api/v1/jobToken/exchange";
pub const PATH_JOB_REFRESH: &str = "/api/v1/jobToken/refresh";
pub const PATH_USERINFO: &str = "/api/v1/userinfo";
pub const PATH_QUOTA: &str = "/api/v2/quota/usage";
pub const OPENAPI_USER_AGENT: &str = "Qoder/1.1.75";
pub const WEBSITE: &str = "https://qoder.com";

/// PAT 前缀
pub const PAT_PREFIX: &str = "pt-";
/// 上游未报过期时间时按 24 小时算
pub const DEFAULT_TOKEN_TTL_MS: i64 = 24 * 3600 * 1000;
/// 提前这么久续期
pub const TOKEN_REFRESH_SKEW_MS: i64 = 2 * 3600 * 1000;

/// 上游排队拒绝码：模型级排队，不是账号问题
pub const BUSY_CODE: &str = "10605";
/// 排队信号的子码；信封层的排队体可能只带它和 isQueued、不带 code
pub const QUEUE_SUB_CODE: &str = "RESOURCE_LIMIT";
/// 登录态被拒的业务码（官方插件：无 code 或 105 → 401）
pub const SIGN_IN_REFUSED_CODE: &str = "105";
/// 额度类业务码（官方插件：110、112–119、122 → 429），与凭证 403 同状态码不同因
pub const QUOTA_CODES: [&str; 10] = ["110", "112", "113", "114", "115", "116", "117", "118", "119", "122"];
/// 上游把模型供应商自身的故障包装成 400 时的文案；官方插件按 502 换号重试
pub const UPSTREAM_VENDOR_ERROR_TEXT: &str = "error in upstream response";
/// 客户端版本过低的硬门槛
pub const STATUS_CLIENT_TOO_OLD: u16 = 430;

pub const API_TIMEOUT_SECS: u64 = 30;
/// 推理流两次数据之间最多等这么久
pub const STREAM_READ_IDLE_SECS: u64 = 300;
pub const CATALOG_TTL_SECS: u64 = 600;
pub const QUOTA_REFRESH_SECS: u64 = 1800;
/// 请求结束后等这么久再拉一次额度；窗口内结束的请求合并成一次拉取
pub const QUOTA_SETTLE_DELAY_SECS: u64 = 5;
pub const TOKEN_CHECK_SECS: u64 = 600;
pub const MAX_ACCOUNT_ATTEMPTS: usize = 3;
pub const RATE_LIMIT_COOLDOWN_SECS: u64 = 60;
pub const AUTH_COOLDOWN_SECS: u64 = 600;
pub const QUOTA_COOLDOWN_SECS: u64 = 1800;
pub const UNAVAILABLE_COOLDOWN_SECS: u64 = 30;
/// 排队等待：上游没给 retryAfterSeconds 时按 30s；给了也钳在 [MIN, MAX]（官方插件口径）
pub const DEFAULT_QUEUE_RETRY_SECS: u64 = 30;
pub const QUEUE_WAIT_MIN_SECS: u64 = 1;
pub const QUEUE_WAIT_MAX_SECS: u64 = 30;
/// 单次请求在队列里最多等这么久，超过就把排队状态交还客户端（官方插件 4 分钟）
pub const QUEUE_WAIT_BUDGET_SECS: u64 = 240;
/// 信封层瞬时错误（418 / 5xx）在吐出首包前最多重开几次上游（qoder2api-hub 同口径）
pub const ENVELOPE_REOPEN_MAX: usize = 2;

/// 请求体默认值（与参考客户端一致）
pub const DEFAULT_MAX_TOKENS: i64 = 32000;
pub const DEFAULT_MAX_INPUT_TOKENS: i64 = 180_000;
pub const DEFAULT_CONTEXT_WINDOW: i32 = 200_000;
pub const DEFAULT_MAX_OUTPUT: i32 = 32_000;
pub const AUTO_MODEL: &str = "auto";

/// `{arch}_{platform}`，与官方 cosy-machineos 同形
pub fn machine_os() -> String {
    let arch = if cfg!(target_arch = "aarch64") { "aarch64" } else { "x86_64" };
    let platform = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    };
    format!("{arch}_{platform}")
}
