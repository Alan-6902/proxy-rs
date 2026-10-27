//! Google OAuth 与 cloudcode-pa v1internal 的 HTTP 调用

use std::sync::OnceLock;

use reqwest::{Client, StatusCode, header};
use serde::Deserialize;
use serde_json::{Value, json};

use super::consts::{
    FALLBACK_CLIENT_VERSION, FETCH_MODELS_URLS, IDE_TYPE, LOAD_CODE_ASSIST_URLS, OAUTH_AUTH_URL,
    OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_SCOPES, OAUTH_TOKEN_URL, USERINFO_URL,
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

/// 报给上游的客户端版本：优先读本机已装 Antigravity 的版本号
pub fn client_version() -> &'static str {
    static VERSION: OnceLock<String> = OnceLock::new();
    VERSION.get_or_init(|| local_app_version().unwrap_or_else(|| FALLBACK_CLIENT_VERSION.to_string()))
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

pub fn user_agent() -> String {
    format!("antigravity/{} {}/{}", client_version(), platform_tag(), arch_tag())
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

// === v1internal ===

fn internal_post(client: &Client, url: &str, access_token: &str) -> reqwest::RequestBuilder {
    client
        .post(url)
        .bearer_auth(access_token)
        .header(header::USER_AGENT, user_agent())
        .header(header::CONTENT_TYPE, "application/json")
}

/// loadCodeAssist 的结果
pub struct ProjectInfo {
    pub project_id: Option<String>,
    pub tier: Option<String>,
}

fn tier_label(tier: &Value) -> Option<String> {
    ["name", "id"]
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

pub async fn load_code_assist(client: &Client, access_token: &str) -> anyhow::Result<ProjectInfo> {
    let body = json!({ "metadata": { "ideType": IDE_TYPE } });
    let mut last_err = None;
    for url in LOAD_CODE_ASSIST_URLS {
        match internal_post(client, url, access_token).json(&body).send().await {
            Ok(resp) => match into_result(resp).await {
                Ok(resp) => return Ok(parse_project_info(&resp.json::<Value>().await?)),
                Err(e) => last_err = Some(e),
            },
            Err(e) => last_err = Some(e.into()),
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("loadCodeAssist 无可用端点")))
}

/// fetchAvailableModels → `{ models: [{ id, displayName, remainingFraction, resetTime }] }`
pub async fn fetch_quota(client: &Client, access_token: &str, project_id: Option<&str>) -> anyhow::Result<Value> {
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
}
