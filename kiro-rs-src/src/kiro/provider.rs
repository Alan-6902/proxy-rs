//! Kiro API Provider
//!
//! 核心组件，负责与 Kiro API 通信
//! 支持流式和非流式请求
//! 支持多凭据故障转移和重试
//! 支持按凭据级 endpoint 切换不同 Kiro API 端点

use reqwest::Client;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tokio::time::sleep;

use crate::http_client::{ProxyConfig, build_client};
use crate::kiro::endpoint::{KiroEndpoint, RequestContext};
use crate::kiro::machine_id;
use crate::kiro::model::credentials::KiroCredentials;
use crate::kiro::token_manager::MultiTokenManager;
use crate::model::config::TlsBackend;
use parking_lot::Mutex;

/// 每个凭据的最大重试次数
const MAX_RETRIES_PER_CREDENTIAL: usize = 3;

/// 总重试次数硬上限（避免无限重试）
const MAX_TOTAL_RETRIES: usize = 9;

/// Kiro API Provider
///
/// 核心组件，负责与 Kiro API 通信
/// 支持多凭据故障转移和重试机制
/// 按凭据 `endpoint` 字段选择 [`KiroEndpoint`] 实现
pub struct KiroProvider {
    token_manager: Arc<MultiTokenManager>,
    /// 全局代理配置（用于凭据无自定义代理时的回退）
    global_proxy: Option<ProxyConfig>,
    /// Client 缓存：key = effective proxy config, value = reqwest::Client
    /// 不同代理配置的凭据使用不同的 Client，共享相同代理的凭据复用 Client
    client_cache: Mutex<HashMap<Option<ProxyConfig>, Client>>,
    /// TLS 后端配置
    tls_backend: TlsBackend,
    /// 端点实现注册表（key: endpoint 名称）
    endpoints: HashMap<String, Arc<dyn KiroEndpoint>>,
    /// 默认端点名称（凭据未指定 endpoint 时使用）
    default_endpoint: String,
}

impl KiroProvider {
    /// 创建带代理配置和端点注册表的 KiroProvider 实例
    ///
    /// # Arguments
    /// * `token_manager` - 多凭据 Token 管理器
    /// * `proxy` - 全局代理配置
    /// * `endpoints` - 端点名 → 实现的注册表（至少包含 `default_endpoint` 对应条目）
    /// * `default_endpoint` - 凭据未显式指定 endpoint 时使用的名称
    pub fn with_proxy(
        token_manager: Arc<MultiTokenManager>,
        proxy: Option<ProxyConfig>,
        endpoints: HashMap<String, Arc<dyn KiroEndpoint>>,
        default_endpoint: String,
    ) -> Self {
        assert!(
            endpoints.contains_key(&default_endpoint),
            "默认端点 {} 未在 endpoints 注册表中",
            default_endpoint
        );
        let tls_backend = token_manager.config().tls_backend;
        // 预热：构建全局代理对应的 Client
        let initial_client =
            build_client(proxy.as_ref(), 720, tls_backend).expect("创建 HTTP 客户端失败");
        let mut cache = HashMap::new();
        cache.insert(proxy.clone(), initial_client);

        Self {
            token_manager,
            global_proxy: proxy,
            client_cache: Mutex::new(cache),
            tls_backend,
            endpoints,
            default_endpoint,
        }
    }

    /// 根据凭据的代理配置获取（或创建并缓存）对应的 reqwest::Client
    fn client_for(&self, credentials: &KiroCredentials) -> anyhow::Result<Client> {
        let effective = credentials.effective_proxy(self.global_proxy.as_ref());
        let mut cache = self.client_cache.lock();
        if let Some(client) = cache.get(&effective) {
            return Ok(client.clone());
        }
        let client = build_client(effective.as_ref(), 720, self.tls_backend)?;
        cache.insert(effective, client.clone());
        Ok(client)
    }

    /// 根据凭据选择 endpoint 实现
    fn endpoint_for(&self, credentials: &KiroCredentials) -> anyhow::Result<Arc<dyn KiroEndpoint>> {
        let name = self.primary_endpoint_name(credentials);
        self.endpoints
            .get(name)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("未知端点: {}", name))
    }

    /// 多凭据 Token 管理器
    ///
    /// 供上层在流结束后调用 [`MultiTokenManager::record_token_usage`] 记账。
    pub fn token_manager(&self) -> &Arc<MultiTokenManager> {
        &self.token_manager
    }

    /// 凭据的首选端点名（凭据级 > 全局默认）
    fn primary_endpoint_name<'a>(&'a self, credentials: &'a KiroCredentials) -> &'a str {
        credentials
            .endpoint
            .as_deref()
            .unwrap_or(&self.default_endpoint)
    }

    /// 构建某凭据的端点尝试链：首选端点 + 配置的降级顺序（去重、跳过未注册项）
    ///
    /// 返回的第一项始终是首选端点，因此降级链为空时行为与单端点完全一致。
    fn endpoint_chain_for(&self, credentials: &KiroCredentials) -> Vec<Arc<dyn KiroEndpoint>> {
        let primary = self.primary_endpoint_name(credentials);
        let mut names: Vec<&str> = vec![primary];

        for name in &self.token_manager.config().endpoint_fallback_order {
            let name = name.as_str();
            // 去重：首选端点也可能出现在降级列表里
            if names.contains(&name) {
                continue;
            }
            names.push(name);
        }

        names
            .into_iter()
            .filter_map(|name| self.endpoints.get(name).cloned())
            .collect()
    }

    /// 发送流式 API 请求，并返回实际服务本次请求的凭据 ID
    ///
    /// 支持多凭据故障转移（见 [`Self::call_api_with_retry`]）。
    /// 调用方拿到 id 后，可在流读完、token 数确定时调用
    /// [`MultiTokenManager::record_token_usage`] 把消耗归到这张凭据上。
    /// 故障转移后返回的是**最终成功**那张凭据的 id。
    pub async fn call_api_stream_tracked(
        &self,
        request_body: &str,
    ) -> anyhow::Result<(reqwest::Response, u64)> {
        self.call_api_with_retry(request_body, true).await
    }

    /// 发送非流式 API 请求，并返回实际服务本次请求的凭据 ID
    pub async fn call_api_tracked(
        &self,
        request_body: &str,
    ) -> anyhow::Result<(reqwest::Response, u64)> {
        self.call_api_with_retry(request_body, false).await
    }

    /// 发送 MCP API 请求（WebSearch 等工具调用）
    pub async fn call_mcp(&self, request_body: &str) -> anyhow::Result<reqwest::Response> {
        self.call_mcp_with_retry(request_body).await
    }

    /// 内部方法：带重试逻辑的 MCP API 调用
    async fn call_mcp_with_retry(&self, request_body: &str) -> anyhow::Result<reqwest::Response> {
        let total_credentials = self.token_manager.total_count();
        let max_retries = (total_credentials * MAX_RETRIES_PER_CREDENTIAL).min(MAX_TOTAL_RETRIES);
        let mut last_error: Option<anyhow::Error> = None;
        let mut force_refreshed: HashSet<u64> = HashSet::new();

        for attempt in 0..max_retries {
            // MCP 调用（WebSearch 等工具）不涉及模型选择，无需按模型过滤凭据
            let ctx = match self.token_manager.acquire_context(None).await {
                Ok(c) => c,
                Err(e) => {
                    last_error = Some(e);
                    continue;
                }
            };

            let config = self.token_manager.config();
            let machine_id = machine_id::generate_from_credentials(&ctx.credentials, config);

            let endpoint = match self.endpoint_for(&ctx.credentials) {
                Ok(e) => e,
                Err(e) => {
                    last_error = Some(e);
                    // endpoint 解析失败：记为失败，换下一张凭据
                    self.token_manager.report_failure(ctx.id);
                    continue;
                }
            };

            let rctx = RequestContext {
                credentials: &ctx.credentials,
                token: &ctx.token,
                machine_id: &machine_id,
                config,
            };

            let url = endpoint.mcp_url(&rctx);
            let body = endpoint.transform_mcp_body(request_body, &rctx);

            let base = self
                .client_for(&ctx.credentials)?
                .post(&url)
                .body(body)
                .header("content-type", "application/json")
                .header("Connection", "close");
            let request = endpoint.decorate_mcp(base, &rctx);

            let response = match request.send().await {
                Ok(resp) => resp,
                Err(e) => {
                    tracing::warn!(
                        "MCP 请求发送失败（尝试 {}/{}）: {}",
                        attempt + 1,
                        max_retries,
                        e
                    );
                    last_error = Some(e.into());
                    if attempt + 1 < max_retries {
                        sleep(Self::retry_delay(attempt)).await;
                    }
                    continue;
                }
            };

            let status = response.status();

            // 成功响应
            if status.is_success() {
                self.token_manager.report_success(ctx.id);
                return Ok(response);
            }

            // 失败响应
            let body = response.text().await.unwrap_or_default();

            // 402 额度用尽
            if status.as_u16() == 402 && endpoint.is_monthly_request_limit(&body) {
                let has_available = self.token_manager.report_quota_exhausted(ctx.id);
                if !has_available {
                    anyhow::bail!("MCP 请求失败（所有凭据已用尽）: {} {}", status, body);
                }
                last_error = Some(anyhow::anyhow!("MCP 请求失败: {} {}", status, body));
                continue;
            }

            // 400 Bad Request
            if status.as_u16() == 400 {
                anyhow::bail!("MCP 请求失败: {} {}", status, body);
            }

            // 401/403 凭据问题
            if matches!(status.as_u16(), 401 | 403) {
                // token 被上游失效：先尝试 force-refresh，每凭据仅一次机会
                if endpoint.is_bearer_token_invalid(&body) && !force_refreshed.contains(&ctx.id) {
                    force_refreshed.insert(ctx.id);
                    tracing::info!("凭据 #{} token 疑似被上游失效，尝试强制刷新", ctx.id);
                    if self
                        .token_manager
                        .force_refresh_token_for(ctx.id)
                        .await
                        .is_ok()
                    {
                        tracing::info!("凭据 #{} token 强制刷新成功，重试请求", ctx.id);
                        continue;
                    }
                    tracing::warn!("凭据 #{} token 强制刷新失败，计入失败", ctx.id);
                }

                let has_available = self.token_manager.report_failure(ctx.id);
                if !has_available {
                    anyhow::bail!("MCP 请求失败（所有凭据已用尽）: {} {}", status, body);
                }
                last_error = Some(anyhow::anyhow!("MCP 请求失败: {} {}", status, body));
                continue;
            }

            // 瞬态错误
            if matches!(status.as_u16(), 408 | 429) || status.is_server_error() {
                tracing::warn!(
                    "MCP 请求失败（上游瞬态错误，尝试 {}/{}）: {} {}",
                    attempt + 1,
                    max_retries,
                    status,
                    body
                );
                last_error = Some(anyhow::anyhow!("MCP 请求失败: {} {}", status, body));
                if attempt + 1 < max_retries {
                    sleep(Self::retry_delay(attempt)).await;
                }
                continue;
            }

            // 其他 4xx
            if status.is_client_error() {
                anyhow::bail!("MCP 请求失败: {} {}", status, body);
            }

            // 兜底
            last_error = Some(anyhow::anyhow!("MCP 请求失败: {} {}", status, body));
            if attempt + 1 < max_retries {
                sleep(Self::retry_delay(attempt)).await;
            }
        }

        Err(last_error.unwrap_or_else(|| {
            anyhow::anyhow!("MCP 请求失败：已达到最大重试次数（{}次）", max_retries)
        }))
    }

    /// 内部方法：带重试逻辑的 API 调用
    ///
    /// 重试策略：
    /// - 每个凭据最多重试 MAX_RETRIES_PER_CREDENTIAL 次
    /// - 总重试次数 = min(凭据数量 × 每凭据重试次数, MAX_TOTAL_RETRIES)
    /// - 硬上限 9 次，避免无限重试
    ///
    /// 端点降级：当前端点连续遇到瞬态错误（429/408/5xx）达到
    /// `config.endpointFallbackAfterFailures` 次后，切到
    /// `config.endpointFallbackOrder` 的下一个端点重试。降级链为空时
    /// 行为与单端点完全一致。
    /// 返回 `(响应, 凭据 ID)`：id 用于把 token 消耗归因到具体凭据。
    async fn call_api_with_retry(
        &self,
        request_body: &str,
        is_stream: bool,
    ) -> anyhow::Result<(reqwest::Response, u64)> {
        let total_credentials = self.token_manager.total_count();
        let max_retries = (total_credentials * MAX_RETRIES_PER_CREDENTIAL).min(MAX_TOTAL_RETRIES);
        let mut last_error: Option<anyhow::Error> = None;
        let mut force_refreshed: HashSet<u64> = HashSet::new();
        let api_type = if is_stream { "流式" } else { "非流式" };

        // 端点降级状态：链中当前下标 + 该端点上的连续瞬态失败次数
        let mut endpoint_idx: usize = 0;
        let mut endpoint_failures: usize = 0;
        let fallback_threshold = self
            .token_manager
            .config()
            .endpoint_fallback_after_failures
            .max(1);

        // 尝试从请求体中提取模型信息
        let model = Self::extract_model_from_request(request_body);
        // 会话标识：启用会话粘性时用于复用同一凭据
        let session_hint = Self::extract_session_hint_from_request(request_body);

        for attempt in 0..max_retries {
            // 获取调用上下文（绑定 index、credentials、token）
            let ctx = match self
                .token_manager
                .acquire_context_with_affinity(model.as_deref(), session_hint.as_deref())
                .await
            {
                Ok(c) => c,
                Err(e) => {
                    last_error = Some(e);
                    continue;
                }
            };

            let config = self.token_manager.config();
            let machine_id = machine_id::generate_from_credentials(&ctx.credentials, config);

            let chain = self.endpoint_chain_for(&ctx.credentials);
            let endpoint = match chain.get(endpoint_idx.min(chain.len().saturating_sub(1))) {
                Some(e) => e.clone(),
                None => {
                    let name = self.primary_endpoint_name(&ctx.credentials).to_string();
                    last_error = Some(anyhow::anyhow!("未知端点: {}", name));
                    self.token_manager.report_failure(ctx.id);
                    continue;
                }
            };

            let rctx = RequestContext {
                credentials: &ctx.credentials,
                token: &ctx.token,
                machine_id: &machine_id,
                config,
            };

            let url = endpoint.api_url(&rctx);
            let body = endpoint.transform_api_body(request_body, &rctx);

            let base = self
                .client_for(&ctx.credentials)?
                .post(&url)
                .body(body)
                .header("content-type", "application/json")
                .header("Connection", "close");
            let request = endpoint.decorate_api(base, &rctx);

            let response = match request.send().await {
                Ok(resp) => resp,
                Err(e) => {
                    tracing::warn!(
                        "API 请求发送失败（端点 {}，尝试 {}/{}）: {}",
                        endpoint.name(),
                        attempt + 1,
                        max_retries,
                        e
                    );
                    // 网络错误通常是上游/链路瞬态问题，不应导致"禁用凭据"或"切换凭据"
                    // （否则一段时间网络抖动会把所有凭据都误禁用，需要重启才能恢复）
                    // 但计入端点失败：连接不通时换主机有可能恢复
                    endpoint_failures += 1;
                    let switched = if endpoint_failures >= fallback_threshold
                        && endpoint_idx + 1 < chain.len()
                    {
                        endpoint_idx += 1;
                        endpoint_failures = 0;
                        tracing::warn!(
                            "端点 {} 连续 {} 次发送失败，降级到 {}",
                            endpoint.name(),
                            fallback_threshold,
                            chain[endpoint_idx].name()
                        );
                        true
                    } else {
                        false
                    };
                    last_error = Some(e.into());
                    if attempt + 1 < max_retries && !switched {
                        sleep(Self::retry_delay(attempt)).await;
                    }
                    continue;
                }
            };

            let status = response.status();

            // 成功响应
            if status.is_success() {
                self.token_manager.report_success(ctx.id);
                return Ok((response, ctx.id));
            }

            // 失败响应：读取 body 用于日志/错误信息
            let body = response.text().await.unwrap_or_default();

            // 402 Payment Required 且额度用尽：禁用凭据并故障转移
            if status.as_u16() == 402 && endpoint.is_monthly_request_limit(&body) {
                tracing::warn!(
                    "API 请求失败（额度已用尽，禁用凭据并切换，尝试 {}/{}）: {} {}",
                    attempt + 1,
                    max_retries,
                    status,
                    body
                );

                let has_available = self.token_manager.report_quota_exhausted(ctx.id);
                if !has_available {
                    anyhow::bail!(
                        "{} API 请求失败（所有凭据已用尽）: {} {}",
                        api_type,
                        status,
                        body
                    );
                }

                last_error = Some(anyhow::anyhow!(
                    "{} API 请求失败: {} {}",
                    api_type,
                    status,
                    body
                ));
                continue;
            }

            // 400 Bad Request - 请求问题，重试/切换凭据无意义
            if status.as_u16() == 400 {
                anyhow::bail!("{} API 请求失败: {} {}", api_type, status, body);
            }

            // 401/403 - 更可能是凭据/权限问题：计入失败并允许故障转移
            if matches!(status.as_u16(), 401 | 403) {
                tracing::warn!(
                    "API 请求失败（可能为凭据错误，尝试 {}/{}）: {} {}",
                    attempt + 1,
                    max_retries,
                    status,
                    body
                );

                // token 被上游失效：先尝试 force-refresh，每凭据仅一次机会
                if endpoint.is_bearer_token_invalid(&body) && !force_refreshed.contains(&ctx.id) {
                    force_refreshed.insert(ctx.id);
                    tracing::info!("凭据 #{} token 疑似被上游失效，尝试强制刷新", ctx.id);
                    if self
                        .token_manager
                        .force_refresh_token_for(ctx.id)
                        .await
                        .is_ok()
                    {
                        tracing::info!("凭据 #{} token 强制刷新成功，重试请求", ctx.id);
                        continue;
                    }
                    tracing::warn!("凭据 #{} token 强制刷新失败，计入失败", ctx.id);
                }

                let has_available = self.token_manager.report_failure(ctx.id);
                if !has_available {
                    anyhow::bail!(
                        "{} API 请求失败（所有凭据已用尽）: {} {}",
                        api_type,
                        status,
                        body
                    );
                }

                last_error = Some(anyhow::anyhow!(
                    "{} API 请求失败: {} {}",
                    api_type,
                    status,
                    body
                ));
                continue;
            }

            // 429/408/5xx - 瞬态上游错误：重试但不禁用或切换凭据
            // （避免 429 high traffic / 502 high load 等瞬态错误把所有凭据锁死）
            if matches!(status.as_u16(), 408 | 429) || status.is_server_error() {
                endpoint_failures += 1;

                // 当前端点连续失败达到阈值：降级到链中下一个端点
                // 先退避重试同端点、多次失败才切换，避免瞬时限流引发全端点扫描
                let switched =
                    if endpoint_failures >= fallback_threshold && endpoint_idx + 1 < chain.len() {
                        endpoint_idx += 1;
                        endpoint_failures = 0;
                        tracing::warn!(
                            "端点 {} 连续 {} 次瞬态失败，降级到 {}",
                            endpoint.name(),
                            fallback_threshold,
                            chain[endpoint_idx].name()
                        );
                        true
                    } else {
                        false
                    };

                tracing::warn!(
                    "API 请求失败（上游瞬态错误，端点 {}，尝试 {}/{}）: {} {}",
                    endpoint.name(),
                    attempt + 1,
                    max_retries,
                    status,
                    body
                );
                last_error = Some(anyhow::anyhow!(
                    "{} API 请求失败: {} {}",
                    api_type,
                    status,
                    body
                ));
                // 刚切换端点时无需退避：换主机后立即重试才是降级的意义
                if attempt + 1 < max_retries && !switched {
                    sleep(Self::retry_delay(attempt)).await;
                }
                continue;
            }

            // 其他 4xx - 通常为请求/配置问题：直接返回，不计入凭据失败
            if status.is_client_error() {
                anyhow::bail!("{} API 请求失败: {} {}", api_type, status, body);
            }

            // 兜底：当作可重试的瞬态错误处理（不切换凭据）
            tracing::warn!(
                "API 请求失败（未知错误，尝试 {}/{}）: {} {}",
                attempt + 1,
                max_retries,
                status,
                body
            );
            last_error = Some(anyhow::anyhow!(
                "{} API 请求失败: {} {}",
                api_type,
                status,
                body
            ));
            if attempt + 1 < max_retries {
                sleep(Self::retry_delay(attempt)).await;
            }
        }

        // 所有重试都失败
        Err(last_error.unwrap_or_else(|| {
            anyhow::anyhow!(
                "{} API 请求失败：已达到最大重试次数（{}次）",
                api_type,
                max_retries
            )
        }))
    }

    /// 从请求体中提取模型信息
    ///
    /// 尝试解析 JSON 请求体，提取 conversationState.currentMessage.userInputMessage.modelId
    fn extract_model_from_request(request_body: &str) -> Option<String> {
        use serde_json::Value;

        let json: Value = serde_json::from_str(request_body).ok()?;

        json.get("conversationState")?
            .get("currentMessage")?
            .get("userInputMessage")?
            .get("modelId")?
            .as_str()
            .map(|s| s.to_string())
    }

    /// 从请求体中提取会话标识，作为会话粘性的 hint
    ///
    /// 取 `conversationState.conversationId`——它由 converter 从 Claude Code 的
    /// `metadata.user_id` 提取的 session UUID 生成，同一会话内保持稳定；
    /// 无 metadata 的请求每次是新 UUID，自然不会粘住。
    fn extract_session_hint_from_request(request_body: &str) -> Option<String> {
        use serde_json::Value;

        let json: Value = serde_json::from_str(request_body).ok()?;

        json.get("conversationState")?
            .get("conversationId")?
            .as_str()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    }

    fn retry_delay(attempt: usize) -> Duration {
        // 指数退避 + 少量抖动，避免上游抖动时放大故障
        const BASE_MS: u64 = 200;
        const MAX_MS: u64 = 2_000;
        let exp = BASE_MS.saturating_mul(2u64.saturating_pow(attempt.min(6) as u32));
        let backoff = exp.min(MAX_MS);
        let jitter_max = (backoff / 4).max(1);
        let jitter = fastrand::u64(0..=jitter_max);
        Duration::from_millis(backoff.saturating_add(jitter))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kiro::endpoint::ide::IDE_ENDPOINT_NAME;
    use crate::kiro::endpoint::{AmazonQEndpoint, IdeEndpoint};
    use crate::model::config::Config;

    /// 构造一个只做端点链解析用的 provider（不发起任何网络请求）
    fn provider_with(fallback_order: Vec<&str>, default_endpoint: &str) -> KiroProvider {
        let mut config = Config::default();
        config.api_key = Some("test-key".to_string());
        config.default_endpoint = default_endpoint.to_string();
        config.endpoint_fallback_order =
            fallback_order.into_iter().map(|s| s.to_string()).collect();

        let token_manager =
            MultiTokenManager::new(config, vec![KiroCredentials::default()], None, None, false)
                .expect("构造 token manager 失败");

        let mut endpoints: HashMap<String, Arc<dyn KiroEndpoint>> = HashMap::new();
        let ide = IdeEndpoint::new();
        endpoints.insert(ide.name().to_string(), Arc::new(ide));
        let cw = AmazonQEndpoint::codewhisperer();
        endpoints.insert(cw.name().to_string(), Arc::new(cw));
        let q = AmazonQEndpoint::amazonq();
        endpoints.insert(q.name().to_string(), Arc::new(q));

        KiroProvider::with_proxy(
            Arc::new(token_manager),
            None,
            endpoints,
            default_endpoint.to_string(),
        )
    }

    fn chain_names(provider: &KiroProvider, creds: &KiroCredentials) -> Vec<String> {
        provider
            .endpoint_chain_for(creds)
            .into_iter()
            .map(|e| e.name().to_string())
            .collect()
    }

    #[test]
    fn test_chain_without_fallback_is_single_endpoint() {
        let provider = provider_with(vec![], IDE_ENDPOINT_NAME);
        let creds = KiroCredentials::default();
        // 未配置降级顺序时行为与单端点完全一致
        assert_eq!(chain_names(&provider, &creds), vec![IDE_ENDPOINT_NAME]);
    }

    #[test]
    fn test_chain_follows_configured_order() {
        let provider = provider_with(vec!["amazonq", "codewhisperer"], IDE_ENDPOINT_NAME);
        let creds = KiroCredentials::default();
        assert_eq!(
            chain_names(&provider, &creds),
            vec![IDE_ENDPOINT_NAME, "amazonq", "codewhisperer"]
        );
    }

    #[test]
    fn test_chain_dedups_primary_appearing_in_fallback() {
        // 首选端点重复出现在降级列表里时不应被重复尝试
        let provider = provider_with(vec![IDE_ENDPOINT_NAME, "amazonq"], IDE_ENDPOINT_NAME);
        let creds = KiroCredentials::default();
        assert_eq!(
            chain_names(&provider, &creds),
            vec![IDE_ENDPOINT_NAME, "amazonq"]
        );
    }

    #[test]
    fn test_chain_skips_unregistered_endpoint() {
        let provider = provider_with(vec!["nonexistent", "amazonq"], IDE_ENDPOINT_NAME);
        let creds = KiroCredentials::default();
        // 未注册的端点被跳过而非导致整链失效（启动时另有校验会提前报错）
        assert_eq!(
            chain_names(&provider, &creds),
            vec![IDE_ENDPOINT_NAME, "amazonq"]
        );
    }

    #[test]
    fn test_chain_respects_credential_level_endpoint() {
        let provider = provider_with(vec![IDE_ENDPOINT_NAME], IDE_ENDPOINT_NAME);
        let creds = KiroCredentials {
            endpoint: Some("amazonq".to_string()),
            ..Default::default()
        };
        // 凭据级 endpoint 作为首选，全局默认退为降级项
        assert_eq!(
            chain_names(&provider, &creds),
            vec!["amazonq", IDE_ENDPOINT_NAME]
        );
    }

    #[test]
    fn test_chain_first_item_is_always_primary() {
        let provider = provider_with(vec!["codewhisperer"], "amazonq");
        let creds = KiroCredentials::default();
        let names = chain_names(&provider, &creds);
        assert_eq!(names.first().map(String::as_str), Some("amazonq"));
    }

    #[test]
    fn test_extract_session_hint() {
        let body = r#"{"conversationState":{"conversationId":"sess-123","currentMessage":{}}}"#;
        assert_eq!(
            KiroProvider::extract_session_hint_from_request(body),
            Some("sess-123".to_string())
        );
    }

    #[test]
    fn test_extract_session_hint_missing_or_empty() {
        // 无 conversationState
        assert!(KiroProvider::extract_session_hint_from_request(r#"{"foo":1}"#).is_none());
        // 无 conversationId
        assert!(
            KiroProvider::extract_session_hint_from_request(r#"{"conversationState":{}}"#)
                .is_none()
        );
        // 空串不应作为有效 hint（否则所有空会话会粘到同一凭据）
        assert!(
            KiroProvider::extract_session_hint_from_request(
                r#"{"conversationState":{"conversationId":""}}"#
            )
            .is_none()
        );
        // 非法 JSON
        assert!(KiroProvider::extract_session_hint_from_request("not-json").is_none());
    }
}
