//! Qoder 上游调用：账号面（openapi，纯 Bearer）与推理面（COSY 签名）
//!
//! 一个 openapi token 同时用于额度查询和 COSY 会话身份（security_oauth_token）。

use reqwest::{Client, Response};
use serde_json::{Value, json};

use super::consts::{
    BUSY_CODE, CHAT_PATH, DEFAULT_QUEUE_RETRY_SECS, DEFAULT_TOKEN_TTL_MS, MODEL_LIST_PATH, OPENAPI_BASE,
    OPENAPI_USER_AGENT, PATH_JOB_EXCHANGE, PATH_JOB_REFRESH, PATH_QUOTA, PATH_USERINFO, QUEUE_SUB_CODE, QUOTA_CODES,
    SIGN_IN_REFUSED_CODE, STATUS_CLIENT_TOO_OLD, UPSTREAM_VENDOR_ERROR_TEXT, WEBSITE,
};
use super::cosy::{Session, encode_body};
use crate::kiro::account_store::now_ms;

/// 对应插件 REQUEST_CODES：内容、能力、长度、媒体数量或自定义模型服务拒绝本次请求。
const REQUEST_REJECTION_CODES: [&str; 8] = ["406", "416", "430", "80411", "80412", "100400", "100401", "100403"];
/// 错误体最多保留这么多字符，避免把上游大段 HTML / 用户信息带进日志
const ERROR_BODY_MAX_CHARS: usize = 300;

/// 上游失败的分类，决定冷却与是否换号
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    /// 凭证被拒：先续期，仍失败就冷却
    Auth,
    /// 额度耗尽 / 日上限：长冷却
    Quota,
    /// 限流：短冷却，换号
    RateLimit,
    /// 上游模型排队（10605 / RESOURCE_LIMIT / isQueued）：模型级信号，按 retry_after 等完同号重发，
    /// 不冷却账号、不记失败、不动登录态
    Queued,
    /// 请求本身有问题：不换号，直接返回
    InvalidRequest,
    /// 客户端版本过低：换号没用
    ClientTooOld,
    /// 网络或 5xx：换主机 / 换号
    Unavailable,
}

#[derive(Debug, Clone)]
pub struct UpstreamError {
    pub kind: FailureKind,
    pub status: u16,
    pub message: String,
    pub retry_after_secs: Option<u64>,
}

impl std::fmt::Display for UpstreamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Qoder 上游 {}: {}", self.status, self.message)
    }
}

impl std::error::Error for UpstreamError {}

impl UpstreamError {
    fn network(e: impl std::fmt::Display) -> Self {
        Self { kind: FailureKind::Unavailable, status: 502, message: format!("网络错误: {e}"), retry_after_secs: None }
    }
}

fn truncate(text: &str) -> String {
    let text = text.trim();
    match text.char_indices().nth(ERROR_BODY_MAX_CHARS) {
        Some((i, _)) => format!("{}…", &text[..i]),
        None => text.to_string(),
    }
}

/// 错误体里与分类相关的字段
#[derive(Default)]
struct ErrorFields {
    code: String,
    message: String,
    error_type: String,
    /// 排队信号：`isQueued: true` 或 `subCode: RESOURCE_LIMIT`
    queued: bool,
    /// 排队体里上游建议的等待秒数
    retry_after_secs: Option<u64>,
}

/// 取出错误体里的 JSON 对象。上游的形态不固定：JSON 前可能带 "403 " 前缀或 BOM，
/// 排队体还见过被再编码成一层 JSON 字符串（双层转义）
fn error_json(body: &str) -> Value {
    let text = body.trim_start_matches('\u{feff}').trim();
    let first = |s: &str| {
        serde_json::Deserializer::from_str(s).into_iter::<Value>().next().and_then(Result::ok)
            .filter(|v| v.is_object() || v.is_string())
    };
    let parsed = first(text)
        .or_else(|| text.find('{').and_then(|i| first(&text[i..])))
        .unwrap_or(Value::Null);
    match parsed {
        Value::String(inner) => serde_json::from_str(&inner).unwrap_or(Value::Null),
        v => v,
    }
}

/// 秒数字段：数字或数字字符串
fn secs_field(v: &Value) -> Option<u64> {
    v.as_f64().or_else(|| v.as_str()?.trim().parse().ok()).map(|f: f64| f.max(0.0).round() as u64)
}

fn error_fields(body: &str) -> ErrorFields {
    let parsed = error_json(body);
    let inner = parsed.get("error").filter(|v| v.is_object()).unwrap_or(&parsed);
    let text = |keys: &[&str]| keys.iter().find_map(|k| non_empty(&inner[*k])).unwrap_or_default();
    let sub_code = text(&["subCode", "sub_code"]);
    ErrorFields {
        code: text(&["code", "errorCode"]),
        message: text(&["message", "errorMessage"]),
        error_type: text(&["type"]),
        queued: inner["isQueued"] == true || inner["isQueued"].as_str() == Some("true") || sub_code == QUEUE_SUB_CODE,
        retry_after_secs: secs_field(&inner["retryAfterSeconds"]),
    }
}

/// "please retry after 12 seconds" 这类提示里的秒数
fn retry_hint_secs(message: &str) -> Option<u64> {
    let lower = message.to_ascii_lowercase();
    let after = &lower[lower.find("after")? + "after".len()..];
    let digits: String = after.trim_start().chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok().filter(|n| *n > 0)
}

/// 按 HTTP 状态与错误体分类上游失败
pub fn classify(status: u16, body: &str) -> UpstreamError {
    let ErrorFields { code, message, error_type, queued, retry_after_secs } = error_fields(body);
    // 明确的业务拒绝不可当网络故障换网关/换号重试，也不应刷新凭证。
    if error_type == "intention_rejected" {
        return UpstreamError {
            kind: FailureKind::InvalidRequest, status,
            message: format!("Qoder 拒绝了本次请求（intention_rejected，code={}）；{}",
                if code.is_empty() { "未知" } else { &code },
                if message.trim().is_empty() { "上游未提供具体原因".to_string() } else { truncate(&message) }),
            retry_after_secs: None,
        };
    }
    let lower = body.to_ascii_lowercase();
    let text = truncate(if message.is_empty() { body } else { &message });
    let error = |kind, retry_after_secs| UpstreamError { kind, status, message: text.clone(), retry_after_secs };
    // 排队与状态码无关：HTTP 层是 403 + code 10605，信封层可能只带 isQueued / subCode
    if code == BUSY_CODE || queued {
        let secs = retry_after_secs.or_else(|| retry_hint_secs(&message)).unwrap_or(DEFAULT_QUEUE_RETRY_SECS);
        return UpstreamError {
            kind: FailureKind::Queued, status,
            message: format!("模型排队中（code={}），上游建议 {secs}s 后重试；这是模型级排队，不是账号或 Key 的问题",
                if code.is_empty() { QUEUE_SUB_CODE } else { &code }),
            retry_after_secs: Some(secs),
        };
    }
    if REQUEST_REJECTION_CODES.contains(&code.as_str()) {
        return UpstreamError {
            kind: FailureKind::InvalidRequest, status,
            message: format!("Qoder 拒绝了本次请求（code={code}）；{}",
                if message.trim().is_empty() { "上游未提供具体原因".to_string() } else { truncate(&message) }),
            retry_after_secs: None,
        };
    }
    if status == STATUS_CLIENT_TOO_OLD {
        return UpstreamError {
            kind: FailureKind::ClientTooOld, status,
            message: "Qoder 要求更新的客户端版本（HTTP 430），需要升级 COSY_VERSION".to_string(),
            retry_after_secs: None,
        };
    }
    if code == SIGN_IN_REFUSED_CODE {
        return error(FailureKind::Auth, None);
    }
    // 额度类业务码与状态码无关（403 / 429 / 200 信封都见过），不能落到凭证分支去刷 token
    if QUOTA_CODES.contains(&code.as_str()) {
        return error(FailureKind::Quota, None);
    }
    // 上游把模型供应商自身的故障包装成 400：不是请求的问题，按不可用换网关 / 换号
    if status == 400 && lower.contains(UPSTREAM_VENDOR_ERROR_TEXT) {
        return error(FailureKind::Unavailable, None);
    }
    let quota = lower.contains("pricingurl") || lower.contains("insufficient_quota") || lower.contains("quota");
    match status {
        _ if quota && matches!(status, 403 | 429 | 200) => error(FailureKind::Quota, None),
        401 | 403 => error(FailureKind::Auth, None),
        429 => error(FailureKind::RateLimit, None),
        400 | 404 | 413 | 422 => error(FailureKind::InvalidRequest, None),
        _ => error(FailureKind::Unavailable, None),
    }
}

async fn read_error(resp: Response) -> UpstreamError {
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    classify(status, &body)
}

/// 换证 / 续期得到的 token
#[derive(Debug, Clone)]
pub struct JobToken {
    pub token: String,
    pub refresh_token: Option<String>,
    pub expires_at_ms: i64,
}

/// openapi userinfo 里用得到的字段
#[derive(Debug, Clone, Default)]
pub struct UserInfo {
    pub uid: String,
    pub name: Option<String>,
    pub email: Option<String>,
    pub user_type: Option<String>,
    pub org_id: Option<String>,
    pub org_name: Option<String>,
}

fn non_empty(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// expires_at（RFC3339 或毫秒）优先，其次 expires_in（毫秒），都没有按 24 小时
fn expiry_ms(v: &Value) -> i64 {
    match &v["expires_at"] {
        Value::String(s) => {
            if let Ok(t) = chrono::DateTime::parse_from_rfc3339(s) {
                return t.timestamp_millis();
            }
        }
        Value::Number(n) => {
            if let Some(ms) = n.as_i64().filter(|ms| *ms > 0) {
                return ms;
            }
        }
        _ => {}
    }
    match v["expires_in"].as_i64().filter(|ms| *ms > 0) {
        Some(ms) => now_ms() + ms,
        None => now_ms() + DEFAULT_TOKEN_TTL_MS,
    }
}

fn parse_job_token(v: &Value) -> Result<JobToken, UpstreamError> {
    let token = ["token", "access_token", "device_token"].iter().find_map(|k| non_empty(&v[*k]))
        .ok_or_else(|| UpstreamError {
            kind: FailureKind::Auth, status: 502,
            message: "换证响应里没有 token".to_string(), retry_after_secs: None,
        })?;
    Ok(JobToken { token, refresh_token: non_empty(&v["refresh_token"]), expires_at_ms: expiry_ms(v) })
}

fn openapi(client: &Client, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
    client.request(method, format!("{OPENAPI_BASE}{path}"))
        .header("accept", "application/json, text/plain, */*")
        .header("user-agent", OPENAPI_USER_AGENT)
        .header("origin", WEBSITE)
        .header("referer", format!("{WEBSITE}/"))
}

async fn post_token(client: &Client, path: &str, body: Value) -> Result<JobToken, UpstreamError> {
    let resp = openapi(client, reqwest::Method::POST, path).json(&body).send().await
        .map_err(UpstreamError::network)?;
    if !resp.status().is_success() {
        return Err(read_error(resp).await);
    }
    let v: Value = resp.json().await.map_err(UpstreamError::network)?;
    parse_job_token(&v)
}

/// PAT 换 token
pub async fn exchange_pat(client: &Client, pat: &str) -> Result<JobToken, UpstreamError> {
    post_token(client, PATH_JOB_EXCHANGE, json!({ "personal_token": pat })).await
}

/// refresh token 续期
pub async fn refresh_token(client: &Client, refresh_token: &str) -> Result<JobToken, UpstreamError> {
    post_token(client, PATH_JOB_REFRESH, json!({ "refresh_token": refresh_token })).await
}

/// 账号身份；uid 是账号库的唯一键，必须拿到
pub async fn fetch_userinfo(client: &Client, token: &str) -> Result<UserInfo, UpstreamError> {
    let resp = openapi(client, reqwest::Method::GET, PATH_USERINFO).bearer_auth(token).send().await
        .map_err(UpstreamError::network)?;
    if !resp.status().is_success() {
        return Err(read_error(resp).await);
    }
    let v: Value = resp.json().await.map_err(UpstreamError::network)?;
    let uid = non_empty(&v["id"]).or_else(|| non_empty(&v["uid"])).or_else(|| non_empty(&v["userId"]))
        .ok_or_else(|| UpstreamError {
            kind: FailureKind::Auth, status: 502,
            message: "userinfo 响应里没有用户 id".to_string(), retry_after_secs: None,
        })?;
    Ok(UserInfo {
        uid,
        name: non_empty(&v["name"]).or_else(|| non_empty(&v["nickname"])),
        email: non_empty(&v["email"]),
        user_type: non_empty(&v["user_type"]).or_else(|| non_empty(&v["userType"])),
        org_id: non_empty(&v["organization_id"]).or_else(|| non_empty(&v["organizationId"])),
        org_name: non_empty(&v["organization_name"]).or_else(|| non_empty(&v["organizationName"])),
    })
}

/// 当前周期额度，原样保存上游 JSON 供页面展示
pub async fn fetch_quota(client: &Client, token: &str) -> Result<Value, UpstreamError> {
    let resp = openapi(client, reqwest::Method::GET, PATH_QUOTA).bearer_auth(token).send().await
        .map_err(UpstreamError::network)?;
    if !resp.status().is_success() {
        return Err(read_error(resp).await);
    }
    resp.json().await.map_err(UpstreamError::network)
}

/// 桌面端优先 app 场景；chat 只补 app 未列出的旧模型，并按插件顺序插入。
fn scene_models(v: &Value) -> Vec<Value> {
    let mut out = v["app"].as_array().cloned().unwrap_or_default();
    let mut after = None;
    for model in v["chat"].as_array().into_iter().flatten() {
        let key = model["key"].as_str().filter(|key| !key.trim().is_empty());
        if let Some(i) = key.and_then(|key| out.iter().position(|m| m["key"].as_str() == Some(key))) {
            after = Some(i);
            continue;
        }
        let at = after.map_or(0, |i| i + 1).min(out.len());
        out.insert(at, model.clone());
        after = Some(at);
    }
    out
}

/// 模型目录 GET 无请求体，签名也覆盖空 body。
fn models_request(client: &Client, session: &Session, gateway: &str) -> reqwest::RequestBuilder {
    let url = format!("{gateway}{MODEL_LIST_PATH}");
    let mut req = client.get(&url);
    for (name, value) in session.headers("", &url, "application/json", false) {
        req = req.header(name, value);
    }
    req
}

pub async fn fetch_models(client: &Client, session: &Session, gateway: &str) -> Result<Vec<Value>, UpstreamError> {
    let resp = models_request(client, session, gateway).send().await.map_err(UpstreamError::network)?;
    if !resp.status().is_success() {
        return Err(read_error(resp).await);
    }
    let v: Value = resp.json().await.map_err(UpstreamError::network)?;
    Ok(scene_models(&v))
}

/// 发起推理；返回 2xx 的流式响应，非 2xx 已读完错误体并分类
pub async fn open_chat(client: &Client, session: &Session, gateway: &str, plain: &Value, model_key: &str)
    -> Result<Response, UpstreamError> {
    let url = format!("{gateway}{CHAT_PATH}");
    let body = encode_body(&serde_json::to_vec(plain).map_err(UpstreamError::network)?);
    let mut req = client.post(&url).body(body.clone());
    for (name, value) in session.headers(&body, &url, "text/event-stream", true) {
        req = req.header(name, value);
    }
    if !model_key.is_empty() {
        let source = plain["model_config"]["source"].as_str().filter(|s| !s.is_empty()).unwrap_or("system");
        req = req.header("x-model-key", model_key).header("x-model-source", source);
    }
    let resp = req.send().await.map_err(UpstreamError::network)?;
    if resp.status().is_success() {
        return Ok(resp);
    }
    Err(read_error(resp).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_busy_quota_auth_and_version() {
        let busy = classify(403, r#"403 {"code":"10605","message":"queue full, retry after 12 seconds"}"#);
        assert_eq!((busy.kind, busy.retry_after_secs), (FailureKind::Queued, Some(12)));
        assert_eq!(classify(429, r#"{"code":10605}"#).retry_after_secs, Some(DEFAULT_QUEUE_RETRY_SECS));
        assert_eq!(classify(403, r#"{"code":"112","message":"x"}"#).kind, FailureKind::Quota);
        assert_eq!(classify(403, r#"{"message":"TOKEN_EXPIRE"}"#).kind, FailureKind::Auth);
        assert_eq!(classify(430, "").kind, FailureKind::ClientTooOld);
        assert_eq!(classify(400, "bad").kind, FailureKind::InvalidRequest);
        assert_eq!(classify(400, r#"{"errorCode":"BadRequest","errorMessage":"Bad request"}"#).message, "Bad request");
        assert_eq!(classify(503, "<html>").kind, FailureKind::Unavailable);
        assert!(classify(500, &"x".repeat(1000)).message.chars().count() <= ERROR_BODY_MAX_CHARS + 1);
    }

    /// 排队是模型级信号：各种形态都要认出来、读到 retryAfterSeconds，绝不能落到凭证分支
    #[test]
    fn queue_signals_are_recognized_in_every_shape() {
        let http = classify(403, r#"{"code":"10605","isQueued":true,"retryAfterSeconds":30}"#);
        assert_eq!((http.kind, http.retry_after_secs), (FailureKind::Queued, Some(30)));
        // 信封层：没有 code，只有 isQueued / subCode；秒数是字符串
        let envelope = classify(403, r#"{"isQueued":true,"retryAfterSeconds":"7","subCode":"RESOURCE_LIMIT"}"#);
        assert_eq!((envelope.kind, envelope.retry_after_secs), (FailureKind::Queued, Some(7)));
        assert!(envelope.message.contains("RESOURCE_LIMIT"));
        let sub_only = classify(403, r#"{"subCode":"RESOURCE_LIMIT"}"#);
        assert_eq!((sub_only.kind, sub_only.retry_after_secs), (FailureKind::Queued, Some(DEFAULT_QUEUE_RETRY_SECS)));
        // 双层转义与 BOM 前缀
        let escaped = serde_json::to_string(r#"{"code":"10605","retryAfterSeconds":3}"#).unwrap();
        assert_eq!((classify(403, &escaped).kind, classify(403, &escaped).retry_after_secs), (FailureKind::Queued, Some(3)));
        assert_eq!(classify(403, "\u{feff}{\"code\":\"10605\"}").kind, FailureKind::Queued);
        // 嵌在 error 对象里
        assert_eq!(classify(200, r#"{"error":{"code":10605,"isQueued":true}}"#).kind, FailureKind::Queued);
    }

    /// 额度码与登录拒绝码按业务码分类，不看状态码；供应商故障包装的 400 按不可用换号
    #[test]
    fn quota_and_sign_in_codes_do_not_look_like_credentials() {
        for code in QUOTA_CODES {
            assert_eq!(classify(403, &format!(r#"{{"code":"{code}","message":"x"}}"#)).kind, FailureKind::Quota, "{code}");
        }
        assert_eq!(classify(200, r#"{"code":115}"#).kind, FailureKind::Quota);
        assert_eq!(classify(403, r#"{"code":"105","message":"refused"}"#).kind, FailureKind::Auth);
        assert_eq!(classify(400, r#"{"code":"InternalError","message":"Error in upstream response"}"#).kind,
            FailureKind::Unavailable);
        assert_eq!(classify(400, r#"{"message":"invalid parameter"}"#).kind, FailureKind::InvalidRequest);
    }

#[test]
    fn rejected_requests_are_not_network_or_auth_failures() {
        let body = r#"{"error":{"code":406,"message":"","type":"intention_rejected"}}"#;
        for status in [200, 403, 406, 416, 502] {
            let e = classify(status, body);
            assert_eq!(e.kind, FailureKind::InvalidRequest);
            assert!(e.message.contains("intention_rejected，code=406"));
            assert!(e.message.contains("上游未提供具体原因"));
        }
    }

#[test]
    fn request_rejection_codes_are_final_and_app_models_lead() {
        for code in REQUEST_REJECTION_CODES {
            let error = classify(403, &format!(r#"{{"code":"{code}","message":""}}"#));
            assert_eq!(error.kind, FailureKind::InvalidRequest);
            assert!(error.message.contains(code));
        }
        let listing = json!({
            "app":[{"key":"fast","display_name":"Fast app"},{"key":"cmodel"}],
            "chat":[{"key":"legacy0"},{"key":"fast","display_name":"Fast chat"},{"key":"legacy"},{"key":"cmodel"},{"key":"tail"}]
        });
        let models = scene_models(&listing);
        let keys: Vec<_> = models.iter().map(|m| m["key"].as_str().unwrap()).collect();
        assert_eq!(keys, ["legacy0", "fast", "legacy", "cmodel", "tail"]);
        assert_eq!(models[1]["display_name"], "Fast app");
    }

#[test]
    fn desktop_listing_get_has_no_body_and_signs_empty_payload() {
        use md5::{Digest, Md5};
        let session = Session::new(&super::super::cosy::Identity {
            uid: "test-user".into(), access_token: "fake-access".into(), ..Default::default()
        }).unwrap();
        let request = models_request(&Client::new(), &session, "https://api3.qoder.sh").build().unwrap();
        assert_eq!(request.method(), reqwest::Method::GET);
        assert!(request.body().is_none());
        let headers = request.headers();
        let auth = headers["authorization"].to_str().unwrap().strip_prefix("Bearer COSY.").unwrap();
        let (payload, signature) = auth.split_once('.').unwrap();
        let signed = format!("{payload}\n{}\n{}\n\n/api/v2/model/list",
            headers["cosy-key"].to_str().unwrap(), headers["cosy-date"].to_str().unwrap());
        assert_eq!(signature, hex::encode(Md5::digest(signed.as_bytes())));
        assert_eq!(headers["cosy-scene"], "app");
    }

    #[test]
    fn parse_token_shapes() {
        let t = parse_job_token(&json!({"token":"jt-1","refresh_token":"jrt-1","expires_at":"2030-01-01T00:00:00Z"})).unwrap();
        assert_eq!((t.token.as_str(), t.refresh_token.as_deref()), ("jt-1", Some("jrt-1")));
        assert_eq!(t.expires_at_ms, 1_893_456_000_000);
        let t = parse_job_token(&json!({"access_token":"a","expires_in":1000})).unwrap();
        assert!(t.expires_at_ms > now_ms() && t.refresh_token.is_none());
        assert!(parse_job_token(&json!({"token":""})).is_err());
    }
}
