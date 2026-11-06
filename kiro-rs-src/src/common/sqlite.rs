//! 三个账号库（Kiro / Qoder / Antigravity）共用的 SQLite 连接参数。
//!
//! 三个库都可能被 proxy-rs 与本进程同时读写，所以统一用 WAL + 全同步 + fullfsync，
//! 并给 BUSY 一个应用层等待窗口；各库在此基础上再按需开 `foreign_keys` 等。

use std::time::Duration;

use anyhow::bail;
use rusqlite::Connection;

/// 遇到 SQLITE_BUSY 时的等待上限
pub const BUSY_TIMEOUT: Duration = Duration::from_millis(5000);

/// 为连接设置账号库约定的 PRAGMA：WAL、synchronous=FULL、fullfsync、checkpoint_fullfsync。
/// WAL 开不起来视为致命错误（多半是文件系统不支持或库文件被只读挂载）。
pub fn configure(conn: &Connection) -> anyhow::Result<()> {
    conn.busy_timeout(BUSY_TIMEOUT)?;
    let mode: String = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))?;
    if !mode.eq_ignore_ascii_case("wal") {
        bail!("无法启用 WAL（journal_mode={mode}）");
    }
    conn.execute_batch(
        "PRAGMA synchronous=FULL;
         PRAGMA fullfsync=ON;
         PRAGMA checkpoint_fullfsync=ON;",
    )?;
    Ok(())
}
