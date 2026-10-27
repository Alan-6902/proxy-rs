//! Antigravity（Google cloudcode-pa v1internal）协议常量

/// Antigravity 桌面端的 OAuth 客户端（installed-app 类型，公开常量）
pub const OAUTH_CLIENT_ID: &str = "";
pub const OAUTH_CLIENT_SECRET: &str = "";

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

/// loadCodeAssist：取 projectId 与订阅档位，按顺序尝试
pub const LOAD_CODE_ASSIST_URLS: &[&str] = &[
    "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist",
];
/// fetchAvailableModels：每个模型的剩余额度，按顺序尝试
pub const FETCH_MODELS_URLS: &[&str] = &[
    "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels",
    "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
    "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
];
/// 生成接口基址：daily 优先，失败再走 prod
pub const GENERATE_BASE_URLS: &[&str] = &[
    "https://daily-cloudcode-pa.googleapis.com/v1internal",
    "https://cloudcode-pa.googleapis.com/v1internal",
];
pub const STREAM_GENERATE_PATH: &str = ":streamGenerateContent?alt=sse";
pub const IDE_TYPE: &str = "ANTIGRAVITY";

/// 本机没装 Antigravity 时上报的客户端版本
pub const FALLBACK_CLIENT_VERSION: &str = "2.0.3";
#[cfg(target_os = "macos")]
pub const LOCAL_APP_PLIST: &str = "/Applications/Antigravity.app/Contents/Info.plist";

pub const API_TIMEOUT_SECS: u64 = 30;
pub const GENERATE_TIMEOUT_SECS: u64 = 720;
/// access token 剩余有效期低于该值时先刷新
pub const TOKEN_REFRESH_SKEW_MS: i64 = 5 * 60 * 1000;
/// 429 没给出重置时间时的冷却
pub const DEFAULT_COOLDOWN_SECS: u64 = 60;
/// 一次请求最多换几个账号
pub const MAX_ACCOUNT_ATTEMPTS: usize = 5;

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
pub const DEFAULT_THINKING_BUDGET: i32 = 24576;
pub const DEFAULT_MAX_OUTPUT_TOKENS: i32 = 65535;

pub const REQUEST_TYPE_AGENT: &str = "agent";
pub const ROLE_MODEL: &str = "model";
pub const ROLE_USER: &str = "user";
