use std::sync::Arc;

use anyhow::Context;
use clap::Parser;
use kiro_rs::{
    common::websearch_relay::WebSearchRelay,
    http_client::ProxyConfig,
    model::{arg::QoderArgs, config::Config},
    qoder::{self, QoderProvider, QoderStore},
    runtime, token,
};

const LOOPBACK_HOST: &str = "127.0.0.1";

fn is_loopback(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host.trim_matches(['[', ']']).parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = QoderArgs::parse();
    runtime::init_logging();
    let config_path = args.config.as_deref().unwrap_or(Config::default_config_path());
    let config = Config::load(config_path).context("加载 Qoder 配置失败")?;
    // 不跟随配置里的 host（可能是 0.0.0.0）：Qoder 默认只听本机，要对外必须显式传 --host
    let host = args.host.as_deref().unwrap_or(LOOPBACK_HOST);
    if !is_loopback(host) {
        tracing::warn!("Qoder 监听非本机地址 {host}：局域网内拿到 apiKey 的人可以使用这些账号");
    }
    let port = args.port.unwrap_or(config.qoder_port);
    config.validate_qoder_port(port)?;
    let api_key = config.api_key.as_deref().filter(|key| !key.trim().is_empty())
        .context("配置文件中未设置 apiKey（或为空）")?;
    let proxy = config.proxy_url.as_ref().map(|url| {
        let mut proxy = ProxyConfig::new(url);
        if let (Some(username), Some(password)) = (&config.proxy_username, &config.proxy_password) {
            proxy = proxy.with_auth(username, password);
        }
        proxy
    });
    if let Some(proxy) = &proxy {
        tracing::info!("Qoder 已配置 HTTP 代理: {}", proxy.redacted_url());
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
        .with_context(|| format!("Qoder 监听 {addr} 失败"))?;
    // 凭证保险箱按账号库的绝对路径区分；读取被拒绝时直接退出，不退回明文
    let db_path = std::path::absolute(&args.qoder_db).context("解析 Qoder 账号库路径失败")?;
    let vault = qoder::vault::system_vault(&db_path.display().to_string())?;
    let store = Arc::new(QoderStore::open_or_create(&args.qoder_db, Arc::from(vault))
        .context("打开 Qoder 账号库失败")?);
    let provider = Arc::new(QoderProvider::new(store, proxy.as_ref())
        .context("创建 Qoder Provider 失败")?);
    provider.start_background_tasks();
    // WebSearch 子请求交给本机 kiro-rs（同一份配置里的 host/port/apiKey）真搜
    let websearch = WebSearchRelay::from_config(&config).map(Arc::new);
    let app = qoder::create_service_router(api_key, config.admin_api_key.as_deref(), provider.clone(), websearch);
    tracing::info!("qoder-rs 已启动，Qoder API 端点: {}", addr);
    tracing::info!("WebSearch 子请求转发给 kiro-rs: 127.0.0.1:{}", config.port);
    tracing::info!("Qoder 账号库: {}", args.qoder_db.display());
    if config.admin_api_key.as_deref().is_some_and(|key| !key.trim().is_empty()) {
        tracing::info!("Qoder Admin UI 已启用: /admin/qoder");
    }
    axum::serve(listener, app)
        .with_graceful_shutdown(runtime::shutdown_signal(args.exit_on_stdin_eof))
        .await?;
    // 退出前把内存里的计数写掉
    provider.flush_counts();
    tracing::info!("qoder-rs 已退出");
    Ok(())
}
