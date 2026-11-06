//! Antigravity（Google cloudcode-pa v1internal）协议常量
//!
//! OAuth 客户端 ID / Secret 不放在这里：由配置文件提供，见 `client::OAuthClient`。

pub const OAUTH_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
pub const OAUTH_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
pub const USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v2/userinfo";
pub const OAUTH_CALLBACK_PATH: &str = "/oauth-callback";
pub const OAUTH_SCOPES: &[&str] = &[
    "openid",
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
    "https://www.googleapis.com/auth/aicode",
];
/// 授权码一次性：用户在浏览器里完成登录的最长等待时间
pub const OAUTH_SESSION_TIMEOUT_SECS: u64 = 600;

/// loadCodeAssist：取 projectId 与订阅档位，按顺序尝试（与官方客户端一样 daily 优先）
pub const LOAD_CODE_ASSIST_URLS: &[&str] = &[
    "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist",
    "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
];
/// fetchAvailableModels：每个模型的剩余额度，按顺序尝试
pub const FETCH_MODELS_URLS: &[&str] = &[
    "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels",
    "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
    "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
];
/// retrieveUserQuotaSummary：按模型组给出 5h 与 weekly 两个窗口的额度，按顺序尝试
pub const QUOTA_SUMMARY_URLS: &[&str] = &[
    "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
    "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary",
    "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
];
/// 生成接口基址：官方客户端只走 daily；daily 失败回退 sandbox。
/// prod 对生成请求几乎总是 429（AntigravityManager 已剔除），不再使用
pub const GENERATE_BASE_URLS: &[&str] = &[
    "https://daily-cloudcode-pa.googleapis.com/v1internal",
    "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal",
];
/// AICode v1alpha 端点：许可证档位、模型配置、额度状态与流式生成
pub const AICODE_FETCH_LICENSES_URLS: &[&str] = &[
    "https://aicode.googleapis.com/v1alpha:fetchLicenses",
];
pub const AICODE_FETCH_CONFIG_URLS: &[&str] = &[
    "https://aicode.googleapis.com/v1alpha:fetchConfig",
];
pub const AICODE_FETCH_QUOTA_URLS: &[&str] = &[
    "https://aicode.googleapis.com/v1alpha:fetchQuotaStatus",
];
pub const AICODE_GENERATE_BASE_URLS: &[&str] = &[
    "https://aicode.googleapis.com/v1alpha",
];
pub const DEFAULT_USER_TIER: &str = "free-tier";
pub const TIER_ID_PRO: &str = "g1-pro-tier";
pub const TIER_ID_ULTRA: &str = "g1-ultra-tier";
pub const STREAM_GENERATE_PATH: &str = ":streamGenerateContent?alt=sse";
pub const IDE_TYPE: &str = "ANTIGRAVITY";
/// 信封里的 `userAgent` 字段：官方客户端固定填这个值，不是 HTTP 头里的完整 UA
pub const ENVELOPE_USER_AGENT: &str = "antigravity";

/// 上报版本的下限：上游对低于此版本的客户端不开放新模型（CLIProxyAPI 实测过的保底版本）
pub const MIN_CLIENT_VERSION: &str = "2.24.0";
#[cfg(target_os = "macos")]
pub const LOCAL_APP_PLIST: &str = "/Applications/Antigravity.app/Contents/Info.plist";
/// 官方 Hub 自动更新清单，`version:` 即当前发布版本
pub const HUB_MANIFEST_URL: &str =
    "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml";
/// 拉清单时用官方更新器的 UA
pub const HUB_MANIFEST_USER_AGENT: &str = "electron-builder";
/// 多久重新取一次版本号（本机 App 与在线清单）
pub const VERSION_REFRESH_SECS: u64 = 6 * 60 * 60;
/// 后台多久拉一次所有启用账号的额度
pub const QUOTA_REFRESH_SECS: u64 = 10 * 60;

pub const API_TIMEOUT_SECS: u64 = 30;
/// 生成请求的读空闲超时（不设总超时，长时间生成的流不会被截断）
pub const GENERATE_READ_IDLE_SECS: u64 = 300;
/// access token 剩余有效期低于该值时先刷新
pub const TOKEN_REFRESH_SKEW_MS: i64 = 5 * 60 * 1000;
/// 429 原因无法识别、也没给重置时间时的冷却
pub const DEFAULT_COOLDOWN_SECS: u64 = 60;
/// 冷却下限：上游给的极短延迟也至少歇这么久
pub const MIN_COOLDOWN_SECS: f64 = 2.0;
/// 没给重置时间时按连续失败次数阶梯冷却（秒），超出末档沿用末档
pub const QUOTA_EXHAUSTED_COOLDOWN_SECS: &[u64] = &[60, 300, 1800, 7200];
pub const RATE_LIMIT_COOLDOWN_SECS: &[u64] = &[5, 15, 30];
pub const CAPACITY_COOLDOWN_SECS: &[u64] = &[5, 10, 15];
/// 连续失败计数多久没有新失败就清零
pub const FAILURE_COUNT_TTL_SECS: u64 = 60 * 60;
/// 上游建议的等待不超过这么久时，在原账号等完再试一次（保住前缀缓存，不换号）
pub const RETRY_IN_PLACE_MAX_SECS: f64 = 3.0;
/// 其它 403 时整个账号冷却（VALIDATION_REQUIRED 不冷却：需要用户完成验证，见 provider）
pub const FORBIDDEN_COOLDOWN_SECS: f64 = 30.0 * 60.0;
/// 所有端点都 404（该账号没有这个模型）时，只冷却这个账号的这个模型
pub const MODEL_NOT_FOUND_COOLDOWN_SECS: f64 = 15.0 * 60.0;
/// 一次请求最多换几个账号（太多会在短时间内多号连发，触发风控）
pub const MAX_ACCOUNT_ATTEMPTS: usize = 3;
/// 换号前等待：基础值 + 随机抖动（毫秒）
pub const ACCOUNT_SWITCH_DELAY_MS: u64 = 200;
pub const ACCOUNT_SWITCH_JITTER_MS: u64 = 300;
/// 换端点前等待：基础值 + 随机抖动（毫秒）
pub const ENDPOINT_SWITCH_DELAY_MS: u64 = 500;
pub const ENDPOINT_SWITCH_JITTER_MS: u64 = 500;
/// 会话粘性：同一会话固定在上次成功的账号上，闲置超过该时长解绑
pub const STICKY_SESSION_TTL_SECS: u64 = 60 * 60;
/// 会话绑定表最多保留多少条
pub const STICKY_SESSION_MAX: usize = 4096;
/// `last_used_ms` 每个账号最多隔这么久落一次盘
pub const LAST_USED_FLUSH_SECS: u64 = 60;
/// 成功 / 失败计数在内存累加，隔这么久批量落一次盘
pub const COUNTS_FLUSH_SECS: u64 = 30;

/// 客户端没给身份时补的系统提示
pub const DEFAULT_IDENTITY: &str = "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.\n\
You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.\n\
**Absolute paths only**\n\
**Proactiveness**";
pub const IDENTITY_MARKERS: &[&str] = &["You are Antigravity", "You are Codex"];

pub const STOP_SEQUENCES: &[&str] = &[
    "<|user|>",
    "<|endoftext|>",
    "<|end_of_turn|>",
    "[DONE]",
    "\n\nHuman:",
];
pub const SAFETY_CATEGORIES: &[&str] = &[
    "HARM_CATEGORY_HARASSMENT",
    "HARM_CATEGORY_HATE_SPEECH",
    "HARM_CATEGORY_SEXUALLY_EXPLICIT",
    "HARM_CATEGORY_DANGEROUS_CONTENT",
];
pub const SAFETY_THRESHOLD_OFF: &str = "OFF";

/// 上游接受的“跳过签名校验”占位签名
pub const PLACEHOLDER_THOUGHT_SIGNATURE: &str = "skip_thought_signature_validator";
/// 短于此长度的签名视为无效
pub const MIN_SIGNATURE_LENGTH: usize = 10;
/// flash 模型 thinking 预算上限
pub const FLASH_THINKING_BUDGET_CAP: i32 = 24576;
/// Claude 上游要求的最小 thinking 预算，低于此值会报参数错误
pub const MIN_CLAUDE_THINKING_BUDGET: i32 = 1024;
pub const DEFAULT_THINKING_BUDGET: i32 = 24576;
pub const DEFAULT_MAX_OUTPUT_TOKENS: i32 = 65535;

pub const REQUEST_TYPE_AGENT: &str = "agent";
pub const ROLE_MODEL: &str = "model";
pub const ROLE_USER: &str = "user";
