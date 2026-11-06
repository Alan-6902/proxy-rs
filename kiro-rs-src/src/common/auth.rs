//! 公共认证工具函数

use axum::{
    body::Body,
    http::{Request, header},
    middleware::Next,
    response::Response,
};
use subtle::ConstantTimeEq;

/// API Key 门禁：请求携带的 key 与 `expected` 常量时间相等才放行，
/// 否则返回 `unauthorized()` 构造的 401 响应（各 API 的错误体格式不同，由调用方提供）。
///
/// 六处鉴权中间件（Kiro / Qoder / Antigravity 的业务与 Admin 各一）都只是本函数的薄封装，
/// 比对逻辑只在这里出现一次。
pub async fn require_api_key(
    expected: &str,
    request: Request<Body>,
    next: Next,
    unauthorized: impl FnOnce() -> Response,
) -> Response {
    match extract_api_key(&request) {
        Some(key) if constant_time_eq(&key, expected) => next.run(request).await,
        _ => unauthorized(),
    }
}

/// 从请求中提取 API Key
///
/// 支持两种认证方式：
/// - `x-api-key` header
/// - `Authorization: Bearer <token>` header
pub fn extract_api_key(request: &Request<Body>) -> Option<String> {
    // 优先检查 x-api-key
    if let Some(key) = request
        .headers()
        .get("x-api-key")
        .and_then(|v| v.to_str().ok())
    {
        return Some(key.to_string());
    }

    // 其次检查 Authorization: Bearer
    request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|s| s.to_string())
}

/// 常量时间字符串比较，防止时序攻击
///
/// 无论字符串内容如何，比较所需的时间都是恒定的，
/// 这可以防止攻击者通过测量响应时间来猜测 API Key。
///
/// 使用经过安全审计的 `subtle` crate 实现
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    a.as_bytes().ct_eq(b.as_bytes()).into()
}
