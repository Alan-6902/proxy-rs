use std::sync::Arc;

use anyhow::Context;
use clap::Parser;
use kiro_rs::{
    antigravity::{self, AgStore, AntigravityProvider, OAuthClient},
    common::websearch_relay::WebSearchRelay,
    http_client::ProxyConfig,
    model::{arg::AntigravityArgs, config::Config},
    runtime, token,
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = AntigravityArgs::parse();
    runtime::init_logging();
    let config_path = args.config.as_deref().unwrap_or(Config::default_config_path());
    let config = Config::load(config_path).context("加载 Antigravity 配置失败")?;
    let host = args.host.as_deref().unwrap_or(&config.host);
    let port = args.port.unwrap_or(config.antigravity_port);
    anyhow::ensure!(port != 0, "Antigravity 监听端口不能为 0");
    let api_key = config.api_key.as_deref().filter(|key| !key.trim().is_empty())
        .context("配置文件中未设置 apiKey（或为空）")?;
    let oauth = OAuthClient::from_config(&config)?;
    let proxy = config.proxy_url.as_ref().map(|url| {
        let mut proxy = ProxyConfig::new(url);
        if let (Some(username), Some(password)) = (&config.proxy_username, &config.proxy_password) {
            proxy = proxy.with_auth(username, password);
        }
        proxy
    });
    if let Some(proxy) = &proxy {
        tracing::info!("Antigravity 已配置 HTTP 代理: {}", proxy.redacted_url());
    }
    token::init_config(token::CountTokensConfig {
        api_url: config.count_tokens_api_url.clone(),
        api_key: config.count_tokens_api_key.clone(),
        auth_type: config.count_tokens_auth_type.clone(),
        proxy: proxy.clone(),
        tls_backend: config.tls_backend,
    });

    // 先占用本服务端口，再打开自己的账号库；不初始化 Kiro 的存储或刷新任务。
    let addr = format!("{host}:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await
        .with_context(|| format!("Antigravity 监听 {addr} 失败"))?;
    let store = Arc::new(AgStore::open_or_create(&args.antigravity_db)
        .context("打开 Antigravity 账号库失败")?);
    let provider = Arc::new(AntigravityProvider::new(store, proxy.as_ref(), config.tls_backend, oauth)
        .context("创建 Antigravity Provider 失败")?);
    provider.start_background_tasks();
    // WebSearch 子请求交给本机 kiro-rs（同一份配置里的 host/port/apiKey）真搜
    let websearch = WebSearchRelay::from_config(&config).map(Arc::new);
    let app = antigravity::create_service_router(api_key, config.admin_api_key.as_deref(), provider.clone(), websearch);
    tracing::info!("antigravity-rs 已启动，Antigravity API 端点: {}", addr);
    tracing::info!("WebSearch 子请求转发给 kiro-rs: 127.0.0.1:{}", config.port);
    tracing::info!("Antigravity 账号库: {}", args.antigravity_db.display());
    if config.admin_api_key.as_deref().is_some_and(|key| !key.trim().is_empty()) {
        tracing::info!("Antigravity Admin UI 已启用: {}", kiro_rs::antigravity::ADMIN_UI_PATH);
    }
    axum::serve(listener, app)
        .with_graceful_shutdown(runtime::shutdown_signal(args.exit_on_stdin_eof))
        .await?;
    // 退出前把内存里的计数写掉
    provider.flush_counts();
    tracing::info!("antigravity-rs 已退出");
    Ok(())
}
