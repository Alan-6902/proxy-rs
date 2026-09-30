mod admin;
mod admin_ui;
mod anthropic;
mod common;
mod http_client;
mod kiro;
mod model;
pub mod token;

use std::collections::HashMap;
use std::sync::Arc;

use clap::Parser;
use kiro::account_store::{self, AccountStore};
use kiro::endpoint::{AmazonQEndpoint, IdeEndpoint, KiroEndpoint};
use kiro::model::credentials::{CredentialsConfig, KiroCredentials};
use kiro::provider::KiroProvider;
use kiro::token_manager::MultiTokenManager;
use model::arg::Args;
use model::config::Config;

#[tokio::main]
async fn main() {
    // 解析命令行参数
    let args = Args::parse();

    // 初始化日志
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .event_format(common::log_format::ProxyLogFormat)
        .init();

    // 加载配置
    let config_path = args
        .config
        .unwrap_or_else(|| Config::default_config_path().to_string());
    let mut config = Config::load(&config_path).unwrap_or_else(|e| {
        tracing::error!("加载配置失败: {}", e);
        std::process::exit(1);
    });
    if let Some(host) = args.host.clone() {
        config.host = host;
    }
    if let Some(port) = args.port {
        config.port = port;
    }

    // 账号库一次性子命令：初始化 / 从 JSON 迁移，完成即退出
    if let Some(db) = args.account_db.as_deref() {
        let db_path = std::path::Path::new(db);
        if args.init_account_db {
            match AccountStore::create_new(db_path) {
                Ok(store) => {
                    tracing::info!(
                        "已创建账号库 {}（database_id={}）",
                        db,
                        store.database_id().unwrap_or_default()
                    );
                    return;
                }
                Err(e) => {
                    tracing::error!("创建账号库失败: {}", e);
                    std::process::exit(1);
                }
            }
        }
        if args.migrate_from_json {
            let credentials_path = args
                .credentials
                .clone()
                .unwrap_or_else(|| KiroCredentials::default_credentials_path().to_string());
            let list = CredentialsConfig::load(&credentials_path)
                .map(|c| c.into_sorted_credentials())
                .unwrap_or_else(|e| {
                    tracing::error!("加载凭证失败: {}", e);
                    std::process::exit(1);
                });
            let stats = std::path::Path::new(&credentials_path)
                .parent()
                .map(|d| d.join("kiro_stats.json"));
            match account_store::migrate_from_json(db_path, list, stats.as_deref()) {
                Ok(n) => {
                    tracing::info!("已从 {} 迁移 {} 个凭据到 {}", credentials_path, n, db);
                    return;
                }
                Err(e) => {
                    tracing::error!("迁移失败: {}", e);
                    std::process::exit(1);
                }
            }
        }
    }

    // 账号库模式：只打开已存在的库，不会因路径写错静默建空库
    let account_store = args.account_db.as_deref().map(|db| {
        Arc::new(
            AccountStore::open_existing(std::path::Path::new(db)).unwrap_or_else(|e| {
                tracing::error!("打开账号库失败: {}", e);
                std::process::exit(1);
            }),
        )
    });

    // 加载凭证（支持单对象或数组格式）；账号库模式下不读 JSON
    let credentials_path = args
        .credentials
        .unwrap_or_else(|| KiroCredentials::default_credentials_path().to_string());
    let credentials_config = if account_store.is_some() {
        CredentialsConfig::Multiple(vec![])
    } else {
        CredentialsConfig::load(&credentials_path).unwrap_or_else(|e| {
            tracing::error!("加载凭证失败: {}", e);
            std::process::exit(1);
        })
    };

    // 判断是否为多凭据格式（用于刷新后回写）
    let is_multiple_format = credentials_config.is_multiple();

    // 转换为按优先级排序的凭据列表
    let mut credentials_list = credentials_config.into_sorted_credentials();

    // 检查 KIRO_API_KEY 环境变量，自动创建 API Key 凭据
    if account_store.is_some() && std::env::var("KIRO_API_KEY").is_ok_and(|v| !v.is_empty()) {
        tracing::warn!("账号库模式下忽略 KIRO_API_KEY 环境变量；请通过 Admin API 导入该 API Key");
    } else if let Ok(kiro_api_key) = std::env::var("KIRO_API_KEY") {
        if kiro_api_key.is_empty() {
            tracing::warn!("KIRO_API_KEY 环境变量已设置但为空，视为未配置");
        } else {
            tracing::info!("检测到 KIRO_API_KEY 环境变量，添加 API Key 凭据（最高优先级）");
            let api_key_cred = KiroCredentials {
                kiro_api_key: Some(kiro_api_key),
                auth_method: Some("api_key".to_string()),
                priority: 0,
                ..Default::default()
            };
            credentials_list.insert(0, api_key_cred);
        }
    }

    tracing::info!("已加载 {} 个凭据配置", credentials_list.len());

    // 获取第一个凭据用于日志显示
    let first_credentials = credentials_list.first().cloned().unwrap_or_default();
    tracing::debug!("主凭证: {:?}", first_credentials);

    // 获取 API Key
    let api_key = config.api_key.clone().unwrap_or_else(|| {
        tracing::error!("配置文件中未设置 apiKey");
        std::process::exit(1);
    });

    // 构建代理配置
    let proxy_config = config.proxy_url.as_ref().map(|url| {
        let mut proxy = http_client::ProxyConfig::new(url);
        if let (Some(username), Some(password)) = (&config.proxy_username, &config.proxy_password) {
            proxy = proxy.with_auth(username, password);
        }
        proxy
    });

    if proxy_config.is_some() {
        tracing::info!("已配置 HTTP 代理: {}", config.proxy_url.as_ref().unwrap());
    }

    // 构建端点注册表
    let mut endpoints: HashMap<String, Arc<dyn KiroEndpoint>> = HashMap::new();
    {
        let ide = IdeEndpoint::new();
        endpoints.insert(ide.name().to_string(), Arc::new(ide));

        // Amazon Q 系列端点：与 IDE 共享协议和凭据，仅 host / x-amz-target 不同。
        // IDE 端点被上游限流时作为降级目标（见 config.endpointFallbackOrder）。
        let cw = AmazonQEndpoint::codewhisperer();
        endpoints.insert(cw.name().to_string(), Arc::new(cw));
        let q = AmazonQEndpoint::amazonq();
        endpoints.insert(q.name().to_string(), Arc::new(q));
    }

    // 校验默认端点存在
    if !endpoints.contains_key(&config.default_endpoint) {
        tracing::error!("默认端点 \"{}\" 未注册", config.default_endpoint);
        std::process::exit(1);
    }

    // 校验降级链中的端点都已注册（配错端点名应在启动时暴露，而非运行时静默跳过）
    for name in &config.endpoint_fallback_order {
        if !endpoints.contains_key(name) {
            tracing::error!(
                "endpointFallbackOrder 中的端点 \"{}\" 未注册（已注册: {:?}）",
                name,
                endpoints.keys().collect::<Vec<_>>()
            );
            std::process::exit(1);
        }
    }

    if !config.endpoint_fallback_order.is_empty() {
        tracing::info!(
            "端点降级已启用: {:?}（连续失败 {} 次后切换）",
            config.endpoint_fallback_order,
            config.endpoint_fallback_after_failures
        );
    }

    // 校验所有凭据声明的端点都已注册
    for cred in &credentials_list {
        let name = cred.endpoint.as_deref().unwrap_or(&config.default_endpoint);
        if !endpoints.contains_key(name) {
            tracing::error!(
                "凭据 id={:?} 指定了未知端点 \"{}\"（已注册: {:?}）",
                cred.id,
                name,
                endpoints.keys().collect::<Vec<_>>()
            );
            std::process::exit(1);
        }
    }

    let endpoint_names: Vec<String> = endpoints.keys().cloned().collect();

    // 创建 MultiTokenManager 和 KiroProvider
    let token_manager = match &account_store {
        Some(store) => {
            MultiTokenManager::new_with_store(config.clone(), store.clone(), proxy_config.clone())
        }
        None => MultiTokenManager::new(
            config.clone(),
            credentials_list,
            proxy_config.clone(),
            Some(credentials_path.into()),
            is_multiple_format,
        ),
    }
    .unwrap_or_else(|e| {
        tracing::error!("创建 Token 管理器失败: {}", e);
        std::process::exit(1);
    });
    // 库中凭据声明的端点同样必须已注册
    for entry in token_manager.snapshot().entries {
        if let Some(name) = entry.endpoint.as_deref() {
            if !endpoints.contains_key(name) {
                tracing::error!("凭据 #{} 指定了未知端点 \"{}\"", entry.id, name);
                std::process::exit(1);
            }
        }
    }
    let token_manager = Arc::new(token_manager);
    // 账号库模式：kiro-rs 是唯一刷新方，后台维护所有账号的 token 与首份额度
    if account_store.is_some() {
        let tm = token_manager.clone();
        tokio::spawn(async move {
            // 首轮推迟：kiro-cli 可能在本进程没运行时自己刷新过 token，库里那份已被轮换作废。
            // 留时间给 proxy-rs 先把 CLI 的新凭据收编进来（POST /accounts/adopt），
            // 否则一启动就拿作废的 refresh token 去刷新。
            let period = std::time::Duration::from_secs(60);
            let first_run = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
            let mut ticker = tokio::time::interval_at(first_run, period);
            loop {
                ticker.tick().await;
                tm.maintain_credentials().await;
            }
        });
    }
    let kiro_provider = KiroProvider::with_proxy(
        token_manager.clone(),
        proxy_config.clone(),
        endpoints,
        config.default_endpoint.clone(),
    );

    // 初始化 count_tokens 配置
    token::init_config(token::CountTokensConfig {
        api_url: config.count_tokens_api_url.clone(),
        api_key: config.count_tokens_api_key.clone(),
        auth_type: config.count_tokens_auth_type.clone(),
        proxy: proxy_config,
        tls_backend: config.tls_backend,
    });

    // 构建 Anthropic API 路由（profile_arn 由 provider 层根据实际凭据动态注入）
    let anthropic_app = anthropic::create_router_with_provider(
        &api_key,
        Some(kiro_provider),
        config.extract_thinking,
    );

    // 构建 Admin API 路由（如果配置了非空的 admin_api_key）
    // 安全检查：空字符串被视为未配置，防止空 key 绕过认证
    let admin_key_valid = config
        .admin_api_key
        .as_ref()
        .map(|k| !k.trim().is_empty())
        .unwrap_or(false);

    let app = if let Some(admin_key) = &config.admin_api_key {
        if admin_key.trim().is_empty() {
            tracing::warn!("admin_api_key 配置为空，Admin API 未启用");
            anthropic_app
        } else {
            let admin_service =
                admin::AdminService::new(token_manager.clone(), endpoint_names.clone());
            let admin_state = admin::AdminState::new(admin_key, admin_service);
            let admin_app = admin::create_admin_router(admin_state);

            // 创建 Admin UI 路由
            let admin_ui_app = admin_ui::create_admin_ui_router();

            tracing::info!("Admin API 已启用");
            tracing::info!("Admin UI 已启用: /admin");
            anthropic_app
                .nest("/api/admin", admin_app)
                .nest("/admin", admin_ui_app)
        }
    } else {
        anthropic_app
    };

    // 启动服务器
    let addr = format!("{}:{}", config.host, config.port);
    tracing::info!("启动 Anthropic API 端点: {}", addr);
    tracing::info!("API Key: {}***", &api_key[..(api_key.len() / 2)]);
    tracing::info!("可用 API:");
    tracing::info!("  GET  /v1/models");
    tracing::info!("  POST /v1/messages");
    tracing::info!("  POST /v1/messages/count_tokens");
    if admin_key_valid {
        tracing::info!("Admin API:");
        tracing::info!("  GET  /api/admin/credentials");
        tracing::info!("  POST /api/admin/credentials/:index/disabled");
        tracing::info!("  POST /api/admin/credentials/:index/priority");
        tracing::info!("  POST /api/admin/credentials/:index/reset");
        tracing::info!("  GET  /api/admin/credentials/:index/balance");
        tracing::info!("Admin UI:");
        tracing::info!("  GET  /admin");
    }

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| {
            tracing::error!("监听 {} 失败: {}", addr, e);
            std::process::exit(1);
        });
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(args.exit_on_stdin_eof))
        .await
        .unwrap();
    // 退出前把防抖中的统计写掉
    token_manager.flush_stats();
    tracing::info!("已退出");
}

/// SIGINT / SIGTERM，或（子进程模式下）stdin 关闭时触发优雅退出
async fn shutdown_signal(watch_stdin: bool) {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    let terminate = async {
        #[cfg(unix)]
        {
            if let Ok(mut s) =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            {
                s.recv().await;
                return;
            }
        }
        std::future::pending::<()>().await
    };
    let stdin_eof = async {
        if !watch_stdin {
            return std::future::pending::<()>().await;
        }
        use tokio::io::AsyncReadExt;
        let mut stdin = tokio::io::stdin();
        let mut buf = [0u8; 256];
        loop {
            match stdin.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
        tracing::info!("stdin 已关闭（父进程退出），开始退出");
    };
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
        _ = stdin_eof => {},
    }
}
