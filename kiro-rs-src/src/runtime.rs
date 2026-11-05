//! 两个反代进程共用的日志初始化与退出信号。

pub fn init_logging() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .event_format(crate::common::log_format::ProxyLogFormat)
        .init();
}

/// SIGINT / SIGTERM，或（子进程模式下）stdin 关闭时触发优雅退出。
pub async fn shutdown_signal(watch_stdin: bool) {
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
