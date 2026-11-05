use clap::Parser;

/// Anthropic <-> Kiro API 客户端
#[derive(Parser, Debug)]
#[command(name = "kiro-rs", version, about, long_about = None)]
pub struct Args {
    /// 配置文件路径
    #[arg(short, long)]
    pub config: Option<String>,

    /// 凭证文件路径（未指定 --account-db 时使用；迁移时作为输入）
    #[arg(long)]
    pub credentials: Option<String>,

    /// 共享账号库路径（SQLite）。指定后凭据、统计、额度都读写该库，不再读写 JSON
    #[arg(long)]
    pub account_db: Option<String>,

    /// 创建一个空的账号库后退出（库已存在时报错）
    #[arg(long, requires = "account_db")]
    pub init_account_db: bool,

    /// 从 --credentials 与同目录 kiro_stats.json 迁移到新账号库后退出（只读旧文件）
    #[arg(long, requires = "account_db", conflicts_with = "init_account_db")]
    pub migrate_from_json: bool,

    /// 覆盖配置文件中的监听地址
    #[arg(long)]
    pub host: Option<String>,

    /// 覆盖配置文件中的 Kiro 监听端口
    #[arg(long)]
    pub port: Option<u16>,

    /// stdin 关闭即退出。由 proxy-rs 作为子进程拉起时使用，避免遗留孤儿进程
    #[arg(long)]
    pub exit_on_stdin_eof: bool,
}

/// Anthropic <-> Antigravity API 反代（不加载 Kiro 凭据池）
#[derive(Parser, Debug)]
#[command(name = "antigravity-rs", version, about, long_about = None)]
pub struct AntigravityArgs {
    /// 配置文件路径（复用 apiKey、adminApiKey、代理及 antigravityPort 配置）
    #[arg(short, long)]
    pub config: Option<String>,

    /// Antigravity 账号库路径（SQLite，不存在时新建）
    #[arg(long)]
    pub antigravity_db: std::path::PathBuf,

    /// 覆盖配置文件中的监听地址
    #[arg(long)]
    pub host: Option<String>,

    /// 覆盖配置文件中的 antigravityPort
    #[arg(long)]
    pub port: Option<u16>,

    /// stdin 关闭即退出，由 App 托管时使用
    #[arg(long)]
    pub exit_on_stdin_eof: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn separate_programs_reject_other_service_arguments() {
        assert!(Args::try_parse_from(["kiro-rs", "--antigravity-db", "ag.sqlite3"]).is_err());
        assert!(Args::try_parse_from(["kiro-rs", "--antigravity-port", "12889"]).is_err());
        assert!(AntigravityArgs::try_parse_from(["antigravity-rs"]).is_err());
        assert!(AntigravityArgs::try_parse_from([
            "antigravity-rs", "--antigravity-db", "ag.sqlite3", "--account-db", "accounts.sqlite3",
        ]).is_err());
        let args = AntigravityArgs::try_parse_from([
            "antigravity-rs", "-c", "config.json", "--antigravity-db", "ag.sqlite3",
            "--host", "127.0.0.1", "--port", "12901", "--exit-on-stdin-eof",
        ]).unwrap();
        assert_eq!(args.config.as_deref(), Some("config.json"));
        assert_eq!(args.port, Some(12901));
        assert!(args.exit_on_stdin_eof);
    }
}
