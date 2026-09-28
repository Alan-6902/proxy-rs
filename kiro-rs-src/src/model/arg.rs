use clap::Parser;

/// Anthropic <-> Kiro API 客户端
#[derive(Parser, Debug)]
#[command(version, about, long_about = None)]
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

    /// 覆盖配置文件中的监听端口
    #[arg(long)]
    pub port: Option<u16>,

    /// stdin 关闭即退出。由 proxy-rs 作为子进程拉起时使用：父进程无论怎么结束，
    /// 管道都会关闭，保证不留孤儿进程
    #[arg(long)]
    pub exit_on_stdin_eof: bool,
}
