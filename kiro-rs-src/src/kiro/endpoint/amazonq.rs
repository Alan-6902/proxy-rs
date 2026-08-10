//! Amazon Q 端点
//!
//! Kiro 后端在 IDE 端点之外还暴露了 Amazon Q 系列端点，两者共享同一套
//! CodeWhisperer 协议与凭据，仅 host / amzTarget 不同。IDE 端点被上游限流
//! （429）时，切到这里往往仍可用，因此作为降级目标存在。
//!
//! - `codewhisperer`: `https://codewhisperer.{api_region}.amazonaws.com/generateAssistantResponse`
//! - `amazonq`:       `https://q.{api_region}.amazonaws.com/generateAssistantResponse`
//!
//! 与 [`super::ide::IdeEndpoint`] 的区别仅在 host 与 `x-amz-target`；
//! 请求体加工（注入 profileArn）与 IDE 完全一致，故直接复用其实现。

use reqwest::RequestBuilder;
use uuid::Uuid;

use super::ide::inject_profile_arn;
use super::{KiroEndpoint, RequestContext};

/// CodeWhisperer 端点名称
pub const CODEWHISPERER_ENDPOINT_NAME: &str = "codewhisperer";

/// Amazon Q 端点名称
pub const AMAZONQ_ENDPOINT_NAME: &str = "amazonq";

/// `x-amz-target`：CodeWhisperer 流式服务
const AMZ_TARGET_CODEWHISPERER: &str =
    "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";

/// 端点主机风格
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HostStyle {
    /// `codewhisperer.{region}.amazonaws.com`
    CodeWhisperer,
    /// `q.{region}.amazonaws.com`
    AmazonQ,
}

/// Amazon Q 系列端点
///
/// 通过 [`HostStyle`] 区分 `codewhisperer.` 与 `q.` 两种主机前缀，
/// 其余行为共用。
pub struct AmazonQEndpoint {
    name: &'static str,
    host_style: HostStyle,
}

impl AmazonQEndpoint {
    /// 创建 `codewhisperer` 端点（host 为 `codewhisperer.{region}.amazonaws.com`）
    pub fn codewhisperer() -> Self {
        Self {
            name: CODEWHISPERER_ENDPOINT_NAME,
            host_style: HostStyle::CodeWhisperer,
        }
    }

    /// 创建 `amazonq` 端点（host 为 `q.{region}.amazonaws.com`）
    pub fn amazonq() -> Self {
        Self {
            name: AMAZONQ_ENDPOINT_NAME,
            host_style: HostStyle::AmazonQ,
        }
    }

    fn api_region<'a>(&self, ctx: &'a RequestContext<'_>) -> &'a str {
        ctx.credentials.effective_api_region(ctx.config)
    }

    fn host(&self, ctx: &RequestContext<'_>) -> String {
        let region = self.api_region(ctx);
        match self.host_style {
            HostStyle::CodeWhisperer => format!("codewhisperer.{}.amazonaws.com", region),
            HostStyle::AmazonQ => format!("q.{}.amazonaws.com", region),
        }
    }

    fn x_amz_user_agent(&self, ctx: &RequestContext<'_>) -> String {
        format!(
            "aws-sdk-js/1.0.34 KiroIDE-{}-{}",
            ctx.config.kiro_version, ctx.machine_id
        )
    }

    fn user_agent(&self, ctx: &RequestContext<'_>) -> String {
        format!(
            "aws-sdk-js/1.0.34 ua/2.1 os/{} lang/js md/nodejs#{} api/codewhispererstreaming#1.0.34 m/E KiroIDE-{}-{}",
            ctx.config.system_version,
            ctx.config.node_version,
            ctx.config.kiro_version,
            ctx.machine_id
        )
    }

    /// API / MCP 共用的基础请求头
    fn decorate_common(&self, req: RequestBuilder, ctx: &RequestContext<'_>) -> RequestBuilder {
        req.header("x-amz-user-agent", self.x_amz_user_agent(ctx))
            .header("user-agent", self.user_agent(ctx))
            .header("host", self.host(ctx))
            .header("amz-sdk-invocation-id", Uuid::new_v4().to_string())
            .header("amz-sdk-request", "attempt=1; max=3")
            .header("Authorization", format!("Bearer {}", ctx.token))
    }
}

impl KiroEndpoint for AmazonQEndpoint {
    fn name(&self) -> &'static str {
        self.name
    }

    fn api_url(&self, ctx: &RequestContext<'_>) -> String {
        format!("https://{}/generateAssistantResponse", self.host(ctx))
    }

    fn mcp_url(&self, ctx: &RequestContext<'_>) -> String {
        format!("https://{}/mcp", self.host(ctx))
    }

    fn decorate_api(&self, req: RequestBuilder, ctx: &RequestContext<'_>) -> RequestBuilder {
        let mut req = self
            .decorate_common(req, ctx)
            .header("x-amzn-codewhisperer-optout", "true")
            .header("x-amzn-kiro-agent-mode", "vibe")
            .header("x-amz-target", AMZ_TARGET_CODEWHISPERER);

        if ctx.credentials.is_api_key_credential() {
            req = req.header("tokentype", "API_KEY");
        }
        req
    }

    fn decorate_mcp(&self, req: RequestBuilder, ctx: &RequestContext<'_>) -> RequestBuilder {
        let mut req = self.decorate_common(req, ctx);

        if let Some(ref arn) = ctx.credentials.profile_arn {
            req = req.header("x-amzn-kiro-profile-arn", arn);
        }
        if ctx.credentials.is_api_key_credential() {
            req = req.header("tokentype", "API_KEY");
        }
        req
    }

    fn transform_api_body(&self, body: &str, ctx: &RequestContext<'_>) -> String {
        inject_profile_arn(body, &ctx.credentials.profile_arn)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kiro::model::credentials::KiroCredentials;
    use crate::model::config::Config;

    fn ctx_with_region<'a>(
        credentials: &'a KiroCredentials,
        config: &'a Config,
    ) -> RequestContext<'a> {
        RequestContext {
            credentials,
            token: "test-token",
            machine_id: "test-machine-id",
            config,
        }
    }

    #[test]
    fn test_codewhisperer_host_and_url() {
        let creds = KiroCredentials::default();
        let mut config = Config::default();
        config.region = "us-east-1".to_string();
        let ctx = ctx_with_region(&creds, &config);

        let ep = AmazonQEndpoint::codewhisperer();
        assert_eq!(ep.name(), CODEWHISPERER_ENDPOINT_NAME);
        assert_eq!(
            ep.api_url(&ctx),
            "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse"
        );
        assert_eq!(
            ep.mcp_url(&ctx),
            "https://codewhisperer.us-east-1.amazonaws.com/mcp"
        );
    }

    #[test]
    fn test_amazonq_host_and_url() {
        let creds = KiroCredentials::default();
        let mut config = Config::default();
        config.region = "us-east-1".to_string();
        let ctx = ctx_with_region(&creds, &config);

        let ep = AmazonQEndpoint::amazonq();
        assert_eq!(ep.name(), AMAZONQ_ENDPOINT_NAME);
        assert_eq!(
            ep.api_url(&ctx),
            "https://q.us-east-1.amazonaws.com/generateAssistantResponse"
        );
    }

    #[test]
    fn test_endpoint_respects_credential_api_region() {
        let creds = KiroCredentials {
            api_region: Some("eu-central-1".to_string()),
            ..Default::default()
        };
        let config = Config::default();
        let ctx = ctx_with_region(&creds, &config);

        // 凭据级 apiRegion 应覆盖全局 region
        assert_eq!(
            AmazonQEndpoint::amazonq().api_url(&ctx),
            "https://q.eu-central-1.amazonaws.com/generateAssistantResponse"
        );
        assert_eq!(
            AmazonQEndpoint::codewhisperer().api_url(&ctx),
            "https://codewhisperer.eu-central-1.amazonaws.com/generateAssistantResponse"
        );
    }

    #[test]
    fn test_two_styles_differ_only_in_host() {
        let creds = KiroCredentials::default();
        let config = Config::default();
        let ctx = ctx_with_region(&creds, &config);

        let cw = AmazonQEndpoint::codewhisperer().api_url(&ctx);
        let q = AmazonQEndpoint::amazonq().api_url(&ctx);
        assert_ne!(cw, q);
        assert!(cw.ends_with("/generateAssistantResponse"));
        assert!(q.ends_with("/generateAssistantResponse"));
    }
}
