//! 共享账号库（SQLite）
//!
//! kiro-rs 是账号库中 accounts / account_credentials / account_usage / account_counters
//! 的唯一写入方；proxy-rs 只写 account_ui。schema 见 `migrations/0001_init.sql`。
//!
//! 连接参数与 P0 实验一致：WAL + synchronous=FULL + fullfsync（断电不丢已提交的
//! token 轮换）。所有写事务都很短，不在事务里等网络。

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, bail};
use chrono::{DateTime, TimeZone, Utc};
use parking_lot::Mutex;
use rusqlite::{Connection, ErrorCode, OpenFlags, OptionalExtension, Transaction, params};
use sha2::{Digest, Sha256};

use super::model::credentials::KiroCredentials;

/// 当前代码支持的 schema 版本（= 已知 migration 数量）
pub const SCHEMA_VERSION: i64 = 1;
/// 第一条 migration；proxy-rs 迁移器执行同一个文件
pub const MIGRATION_0001: &str = include_str!("../../migrations/0001_init.sql");
/// 写事务遇到另一端持锁时的等待上限
const BUSY_TIMEOUT: Duration = Duration::from_millis(5000);
/// 提交遇到 BUSY 时的应用层重试次数（busy_timeout 之外再兜一层，见方案 §0.8 写者饥饿）
const BUSY_RETRIES: usize = 3;
/// account_changes 保留窗口
pub const CHANGES_RETENTION_MS: i64 = 24 * 60 * 60 * 1000;

/// 禁用原因的库内取值，与 schema 的 CHECK 约束一致
pub const DISABLED_REASONS: [&str; 6] = [
    "Manual",
    "TooManyFailures",
    "TooManyRefreshFailures",
    "QuotaExceeded",
    "InvalidRefreshToken",
    "InvalidConfig",
];

/// 账号状态的库内取值
pub mod status {
    pub const READY: &str = "ready";
    pub const REAUTH_REQUIRED: &str = "reauth_required";
    pub const ERROR: &str = "error";
}

/// 从库里读出的一行账号（未删除）
#[derive(Debug, Clone)]
pub struct StoredAccount {
    pub credentials: KiroCredentials,
    pub account_uuid: String,
    pub in_pool: bool,
    pub disabled_reason: Option<String>,
    pub credential_version: i64,
    /// 上次进程退出时刷新是否仍在途（上游可能已轮换）
    pub refresh_was_running: bool,
    pub counters: StoredCounters,
}

#[derive(Debug, Clone, Default)]
pub struct StoredCounters {
    pub success_count: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub last_used_at_ms: Option<i64>,
}

/// 新增账号时的非凭据属性
#[derive(Debug, Clone, Default)]
pub struct NewAccountMeta {
    /// proxy 侧账号 ID；为空时由库生成 UUID
    pub account_uuid: Option<String>,
    pub in_pool: bool,
    pub provider: Option<String>,
    pub start_url: Option<String>,
    /// proxy 侧非秘密凭据配置（JSON 对象）
    pub extra_json: Option<String>,
    /// 初始 UI 字段（proxy 导入时带入）
    pub nickname: Option<String>,
    pub group_id: Option<String>,
    pub tags_json: Option<String>,
    pub metadata_json: Option<String>,
}

/// 一次额度查询写库的内容
#[derive(Debug, Clone)]
pub struct UsageWrite<'a> {
    pub seq: i64,
    pub raw_json: &'a str,
    pub used_amount: f64,
    pub limit_amount: f64,
    pub reset_at_ms: Option<i64>,
    pub subscription_title: Option<&'a str>,
    pub upstream_identity: Option<&'a str>,
}

pub struct AccountStore {
    conn: Mutex<Connection>,
    path: PathBuf,
}

pub fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// RFC3339 → 毫秒；解析失败返回 None（不猜单位）
pub fn rfc3339_to_ms(value: Option<&str>) -> Option<i64> {
    value
        .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
        .map(|d| d.timestamp_millis())
}

pub fn ms_to_rfc3339(value: Option<i64>) -> Option<String> {
    value
        .and_then(|ms| Utc.timestamp_millis_opt(ms).single())
        .map(|d| d.to_rfc3339())
}

fn migration_checksum(sql: &str) -> String {
    hex::encode(Sha256::digest(sql.as_bytes()))
}

fn is_busy(err: &rusqlite::Error) -> bool {
    matches!(
        err.sqlite_error_code(),
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
    )
}

fn configure(conn: &Connection) -> anyhow::Result<()> {
    conn.busy_timeout(BUSY_TIMEOUT)?;
    let mode: String = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))?;
    if !mode.eq_ignore_ascii_case("wal") {
        bail!("无法启用 WAL（journal_mode={mode}）");
    }
    conn.execute_batch(
        "PRAGMA synchronous=FULL;
         PRAGMA fullfsync=ON;
         PRAGMA checkpoint_fullfsync=ON;
         PRAGMA foreign_keys=ON;",
    )?;
    Ok(())
}

fn auth_kind(cred: &KiroCredentials) -> &'static str {
    if cred.is_api_key_credential() {
        "api_key"
    } else {
        "oauth"
    }
}

fn auth_method(cred: &KiroCredentials) -> String {
    if cred.is_api_key_credential() {
        return "api_key".to_string();
    }
    match cred.auth_method.as_deref() {
        Some(m)
            if m.eq_ignore_ascii_case("idc")
                || m.eq_ignore_ascii_case("builder-id")
                || m.eq_ignore_ascii_case("iam") =>
        {
            "idc".to_string()
        }
        Some(m) if !m.trim().is_empty() => m.to_string(),
        // 与 refresh_token() 的推断一致：有 clientId/Secret 视为 IdC
        _ if cred.client_id.is_some() && cred.client_secret.is_some() => "idc".to_string(),
        _ => "social".to_string(),
    }
}

impl AccountStore {
    /// 打开已存在的账号库；文件不存在直接报错，不会静默建空库。
    pub fn open_existing(path: &Path) -> anyhow::Result<Self> {
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .with_context(|| format!("打开账号库失败（不会自动创建）: {}", path.display()))?;
        configure(&conn)?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version != SCHEMA_VERSION {
            bail!("账号库 schema 版本 {version} 与本程序支持的 {SCHEMA_VERSION} 不一致，拒绝写入");
        }
        let checksum: Option<String> = conn
            .query_row(
                "SELECT checksum FROM schema_migrations WHERE version = 1",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if checksum.as_deref() != Some(migration_checksum(MIGRATION_0001).as_str()) {
            bail!("账号库 migration 0001 校验和不一致，可能由不同版本创建");
        }
        Ok(Self {
            conn: Mutex::new(conn),
            path: path.to_path_buf(),
        })
    }

    /// 创建新库并执行 migration。文件已存在时报错（初始化只能做一次）。
    pub fn create_new(path: &Path) -> anyhow::Result<Self> {
        if path.exists() {
            bail!("账号库已存在，拒绝重新初始化: {}", path.display());
        }
        {
            let mut conn = Connection::open(path)?;
            configure(&conn)?;
            let tx = conn.transaction()?;
            tx.execute_batch(MIGRATION_0001)?;
            let now = now_ms();
            tx.execute(
                "INSERT INTO db_meta(singleton, database_id, created_at_ms) VALUES (1, ?1, ?2)",
                params![uuid::Uuid::new_v4().to_string(), now],
            )?;
            tx.execute(
                "INSERT INTO schema_migrations(version, checksum, applied_at_ms) VALUES (1, ?1, ?2)",
                params![migration_checksum(MIGRATION_0001), now],
            )?;
            tx.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))?;
            tx.commit()?;
        }
        Self::open_existing(path)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn database_id(&self) -> anyhow::Result<String> {
        Ok(self.conn.lock().query_row(
            "SELECT database_id FROM db_meta WHERE singleton = 1",
            [],
            |r| r.get(0),
        )?)
    }

    /// 在一个 IMMEDIATE 写事务里执行 `f`；提交遇 BUSY 时重试同一次写入（不重发网络请求）。
    fn write<T>(
        &self,
        mut f: impl FnMut(&Transaction<'_>) -> anyhow::Result<T>,
    ) -> anyhow::Result<T> {
        let mut conn = self.conn.lock();
        let mut attempt = 0;
        loop {
            let result = (|| -> anyhow::Result<T> {
                let tx =
                    conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
                let value = f(&tx)?;
                tx.commit()?;
                Ok(value)
            })();
            match result {
                Err(e)
                    if attempt < BUSY_RETRIES
                        && e.downcast_ref::<rusqlite::Error>().is_some_and(is_busy) =>
                {
                    attempt += 1;
                    tracing::warn!("账号库写入遇到 BUSY，第 {attempt} 次重试");
                }
                other => return other,
            }
        }
    }

    /// 读取全部未删除账号
    pub fn load_all(&self) -> anyhow::Result<Vec<StoredAccount>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT a.id, a.account_uuid, a.credential_identity, a.email, a.in_pool, a.enabled,
                    a.disabled_reason, a.priority, a.refresh_state, a.subscription_title,
                    c.credential_version, c.auth_method, c.access_token, c.refresh_token,
                    c.expires_at_ms, c.kiro_api_key, c.client_id, c.client_secret, c.profile_arn,
                    c.region, c.auth_region, c.api_region, c.machine_id, c.endpoint,
                    c.proxy_url, c.proxy_username, c.proxy_password,
                    n.success_count, n.input_tokens, n.output_tokens, n.last_used_at_ms
             FROM accounts a
             JOIN account_credentials c ON c.account_id = a.id
             LEFT JOIN account_counters n ON n.account_id = a.id
             WHERE a.deleted_at_ms IS NULL
             ORDER BY a.priority, a.id",
        )?;
        let rows = stmt.query_map([], |r| {
            let id: i64 = r.get(0)?;
            let enabled: bool = r.get(5)?;
            let priority: i64 = r.get(7)?;
            let subscription_title: Option<String> = r.get(9)?;
            let credentials = KiroCredentials {
                id: Some(id as u64),
                credential_identity: Some(r.get(2)?),
                email: r.get(3)?,
                priority: priority.max(0) as u32,
                disabled: !enabled,
                subscription_title,
                auth_method: Some(r.get(11)?),
                access_token: r.get(12)?,
                refresh_token: r.get(13)?,
                expires_at: ms_to_rfc3339(r.get(14)?),
                kiro_api_key: r.get(15)?,
                client_id: r.get(16)?,
                client_secret: r.get(17)?,
                profile_arn: r.get(18)?,
                region: r.get(19)?,
                auth_region: r.get(20)?,
                api_region: r.get(21)?,
                machine_id: r.get(22)?,
                endpoint: r.get(23)?,
                proxy_url: r.get(24)?,
                proxy_username: r.get(25)?,
                proxy_password: r.get(26)?,
            };
            Ok(StoredAccount {
                credentials,
                account_uuid: r.get(1)?,
                in_pool: r.get(4)?,
                disabled_reason: r.get(6)?,
                credential_version: r.get(10)?,
                refresh_was_running: r.get::<_, String>(8)? == "running",
                counters: StoredCounters {
                    success_count: r.get::<_, Option<i64>>(27)?.unwrap_or(0).max(0) as u64,
                    input_tokens: r.get::<_, Option<i64>>(28)?.unwrap_or(0).max(0) as u64,
                    output_tokens: r.get::<_, Option<i64>>(29)?.unwrap_or(0).max(0) as u64,
                    last_used_at_ms: r.get(30)?,
                },
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// 启动时把遗留的 running 标记清回 idle，返回受影响的账号 ID。
    ///
    /// 遗留 running 说明上次进程在刷新途中退出，上游可能已轮换但未落库。
    /// 处理方式见方案 §0.3：下一次需要时用库里现有的 refresh token 重试一次，
    /// 若上游返回 invalid_grant 则按 InvalidRefreshToken 禁用、等待重新登录。
    pub fn clear_stale_refresh_marks(&self) -> anyhow::Result<Vec<u64>> {
        self.write(|tx| {
            let ids: Vec<u64> = tx
                .prepare("SELECT id FROM accounts WHERE refresh_state = 'running'")?
                .query_map([], |r| r.get::<_, i64>(0))?
                .map(|id| id.map(|v| v as u64))
                .collect::<Result<_, _>>()?;
            tx.execute(
                "UPDATE accounts SET refresh_state = 'idle', refresh_started_at_ms = NULL,
                        refresh_base_version = NULL, updated_at_ms = ?1
                 WHERE refresh_state = 'running'",
                params![now_ms()],
            )?;
            Ok(ids)
        })
    }

    /// 新增账号（凭据 + 空的计数/额度/UI 行），返回数字 ID 与记录身份。
    ///
    /// `credentials.id` 为空时由库分配（迁移时传入原 ID 以保持兼容）；
    /// `credential_identity` 为空时生成新 UUID。
    pub fn insert_account(
        &self,
        credentials: &KiroCredentials,
        meta: &NewAccountMeta,
    ) -> anyhow::Result<(u64, String)> {
        self.write(|tx| {
            let now = now_ms();
            let identity = credentials
                .credential_identity
                .clone()
                .filter(|v| !v.trim().is_empty())
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let account_uuid = meta
                .account_uuid
                .clone()
                .filter(|v| !v.trim().is_empty())
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let exists: bool = tx
                .query_row(
                    "SELECT 1 FROM accounts WHERE account_uuid = ?1",
                    params![account_uuid],
                    |_| Ok(true),
                )
                .optional()?
                .unwrap_or(false);
            if exists {
                bail!("账号已存在或已删除（account_uuid={account_uuid}），不会重复创建");
            }
            tx.execute(
                "INSERT INTO accounts(id, account_uuid, credential_identity, email, in_pool,
                                      enabled, disabled_reason, priority, subscription_title,
                                      created_at_ms, updated_at_ms)
                 VALUES (?10, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
                params![
                    account_uuid,
                    identity,
                    credentials.email,
                    meta.in_pool,
                    !credentials.disabled,
                    credentials.disabled.then_some("Manual"),
                    credentials.priority as i64,
                    credentials.subscription_title,
                    now,
                    // 迁移时保留原数字 ID；为空时由 AUTOINCREMENT 分配
                    credentials.id.map(|v| v as i64)
                ],
            )?;
            let id = tx.last_insert_rowid();
            tx.execute(
                "INSERT INTO account_credentials(account_id, credential_version, auth_kind,
                    auth_method, access_token, refresh_token, expires_at_ms, kiro_api_key,
                    client_id, client_secret, profile_arn, region, auth_region, api_region,
                    machine_id, endpoint, proxy_url, proxy_username, proxy_password,
                    provider, start_url, extra_json, updated_at_ms)
                 VALUES (?1, 0, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                         ?16, ?17, ?18, ?19, ?20, ?21, ?22)",
                params![
                    id,
                    auth_kind(credentials),
                    auth_method(credentials),
                    credentials.access_token,
                    credentials.refresh_token,
                    rfc3339_to_ms(credentials.expires_at.as_deref()),
                    credentials.kiro_api_key,
                    credentials.client_id,
                    credentials.client_secret,
                    credentials.profile_arn,
                    credentials.region,
                    credentials.auth_region,
                    credentials.api_region,
                    credentials.machine_id,
                    credentials.endpoint,
                    credentials.proxy_url,
                    credentials.proxy_username,
                    credentials.proxy_password,
                    meta.provider,
                    meta.start_url,
                    meta.extra_json.as_deref().unwrap_or("{}"),
                    now
                ],
            )?;
            tx.execute(
                "INSERT INTO account_counters(account_id, updated_at_ms) VALUES (?1, ?2)",
                params![id, now],
            )?;
            tx.execute(
                "INSERT INTO account_usage(account_id) VALUES (?1)",
                params![id],
            )?;
            tx.execute(
                "INSERT INTO account_ui(account_id, nickname, group_id, tags_json, metadata_json,
                                        updated_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    id,
                    meta.nickname,
                    meta.group_id,
                    meta.tags_json.as_deref().unwrap_or("[]"),
                    meta.metadata_json.as_deref().unwrap_or("{}"),
                    now
                ],
            )?;
            Ok((id as u64, identity.clone()))
        })
    }

    /// 刷新开始：写在途标记，返回当前 credential_version（作为结果写入的条件）。
    pub fn begin_refresh(&self, id: u64) -> anyhow::Result<i64> {
        self.write(|tx| {
            let version: i64 = tx.query_row(
                "SELECT credential_version FROM account_credentials WHERE account_id = ?1",
                params![id as i64],
                |r| r.get(0),
            )?;
            tx.execute(
                "UPDATE accounts SET refresh_state = 'running', refresh_started_at_ms = ?2,
                        refresh_base_version = ?3, updated_at_ms = ?2
                 WHERE id = ?1",
                params![id as i64, now_ms(), version],
            )?;
            Ok(version)
        })
    }

    /// 刷新结束（成功或失败）都要清掉在途标记
    pub fn end_refresh(&self, id: u64) -> anyhow::Result<()> {
        self.write(|tx| {
            tx.execute(
                "UPDATE accounts SET refresh_state = 'idle', refresh_started_at_ms = NULL,
                        refresh_base_version = NULL, updated_at_ms = ?2
                 WHERE id = ?1 AND refresh_state = 'running'",
                params![id as i64, now_ms()],
            )?;
            Ok(())
        })
    }

    /// 写入轮换后的凭据。`base_version` 不为空时做条件写：版本已变说明有别的写入者，拒绝覆盖。
    /// 同时清掉刷新在途标记。返回新版本号。
    pub fn save_rotated_credentials(
        &self,
        id: u64,
        base_version: Option<i64>,
        credentials: &KiroCredentials,
    ) -> anyhow::Result<i64> {
        self.write(|tx| {
            let now = now_ms();
            let changed = tx.execute(
                "UPDATE account_credentials
                 SET access_token = ?2, refresh_token = COALESCE(?3, refresh_token),
                     expires_at_ms = ?4, profile_arn = COALESCE(?5, profile_arn),
                     credential_version = credential_version + 1, updated_at_ms = ?6
                 WHERE account_id = ?1 AND (?7 IS NULL OR credential_version = ?7)",
                params![
                    id as i64,
                    credentials.access_token,
                    // 上游没返回新 refresh token 时保留旧值，绝不用空值覆盖
                    credentials
                        .refresh_token
                        .as_deref()
                        .filter(|v| !v.is_empty()),
                    rfc3339_to_ms(credentials.expires_at.as_deref()),
                    credentials.profile_arn,
                    now,
                    base_version
                ],
            )?;
            if changed == 0 {
                bail!("凭据 #{id} 版本已变化，拒绝用旧刷新结果覆盖");
            }
            tx.execute(
                "UPDATE accounts SET refresh_state = 'idle', refresh_started_at_ms = NULL,
                        refresh_base_version = NULL, status = 'ready', last_error = NULL,
                        updated_at_ms = ?2
                 WHERE id = ?1",
                params![id as i64, now],
            )?;
            Ok(tx.query_row(
                "SELECT credential_version FROM account_credentials WHERE account_id = ?1",
                params![id as i64],
                |r| r.get(0),
            )?)
        })
    }

    /// 写入禁用状态与原因（自动禁用也落库，重启后原因不丢）
    pub fn set_enabled_state(
        &self,
        id: u64,
        disabled_reason: Option<&str>,
        consecutive_failures: u32,
        consecutive_refresh_failures: u32,
    ) -> anyhow::Result<()> {
        if let Some(reason) = disabled_reason {
            if !DISABLED_REASONS.contains(&reason) {
                bail!("未知禁用原因: {reason}");
            }
        }
        let status = match disabled_reason {
            Some("InvalidRefreshToken") => status::REAUTH_REQUIRED,
            Some("InvalidConfig") => status::ERROR,
            _ => status::READY,
        };
        self.write(|tx| {
            tx.execute(
                "UPDATE accounts SET enabled = ?2, disabled_reason = ?3, status = ?4,
                        consecutive_failures = ?5, consecutive_refresh_failures = ?6,
                        updated_at_ms = ?7
                 WHERE id = ?1",
                params![
                    id as i64,
                    disabled_reason.is_none(),
                    disabled_reason,
                    status,
                    consecutive_failures,
                    consecutive_refresh_failures,
                    now_ms()
                ],
            )?;
            Ok(())
        })
    }

    pub fn set_priority(&self, id: u64, priority: u32) -> anyhow::Result<()> {
        self.write(|tx| {
            tx.execute(
                "UPDATE accounts SET priority = ?2, updated_at_ms = ?3 WHERE id = ?1",
                params![id as i64, priority as i64, now_ms()],
            )?;
            Ok(())
        })
    }

    pub fn set_in_pool(&self, id: u64, in_pool: bool) -> anyhow::Result<()> {
        self.write(|tx| {
            let n = tx.execute(
                "UPDATE accounts SET in_pool = ?2, updated_at_ms = ?3
                 WHERE id = ?1 AND deleted_at_ms IS NULL",
                params![id as i64, in_pool, now_ms()],
            )?;
            if n == 0 {
                bail!("凭据不存在: {id}");
            }
            Ok(())
        })
    }

    pub fn set_proxy(
        &self,
        id: u64,
        url: Option<&str>,
        username: Option<&str>,
        password: Option<&str>,
    ) -> anyhow::Result<()> {
        self.write(|tx| {
            tx.execute(
                "UPDATE account_credentials SET proxy_url = ?2, proxy_username = ?3,
                        proxy_password = ?4, updated_at_ms = ?5
                 WHERE account_id = ?1",
                params![id as i64, url, username, password, now_ms()],
            )?;
            Ok(())
        })
    }

    /// 补全 machineId（旧数据缺失时由 kiro-rs 派生后回写）
    pub fn set_machine_id(&self, id: u64, machine_id: &str) -> anyhow::Result<()> {
        self.write(|tx| {
            tx.execute(
                "UPDATE account_credentials SET machine_id = ?2, updated_at_ms = ?3
                 WHERE account_id = ?1 AND machine_id IS NULL",
                params![id as i64, machine_id, now_ms()],
            )?;
            Ok(())
        })
    }

    /// 软删除：行保留（account_uuid 继续占位，防止旧快照复活），两端都不再展示
    pub fn soft_delete(&self, id: u64) -> anyhow::Result<()> {
        self.write(|tx| {
            let n = tx.execute(
                "UPDATE accounts SET deleted_at_ms = ?2, in_pool = 0, updated_at_ms = ?2
                 WHERE id = ?1 AND deleted_at_ms IS NULL",
                params![id as i64, now_ms()],
            )?;
            if n == 0 {
                bail!("凭据不存在: {id}");
            }
            Ok(())
        })
    }

    /// 批量写入计数器绝对值（kiro-rs 是唯一写入方，内存值即权威值）
    pub fn save_counters(&self, rows: &[(u64, StoredCounters)]) -> anyhow::Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        self.write(|tx| {
            let now = now_ms();
            let mut stmt = tx.prepare(
                "UPDATE account_counters SET success_count = ?2, input_tokens = ?3,
                        output_tokens = ?4, last_used_at_ms = ?5, updated_at_ms = ?6
                 WHERE account_id = ?1
                   AND (success_count, input_tokens, output_tokens, last_used_at_ms)
                       IS NOT (?2, ?3, ?4, ?5)",
            )?;
            for (id, c) in rows {
                stmt.execute(params![
                    *id as i64,
                    c.success_count as i64,
                    c.input_tokens as i64,
                    c.output_tokens as i64,
                    c.last_used_at_ms,
                    now
                ])?;
            }
            // 顺带清理超出保留窗口的变更记录
            tx.execute(
                "DELETE FROM account_changes WHERE occurred_at_ms < ?1",
                params![now - CHANGES_RETENTION_MS],
            )?;
            Ok(())
        })
    }

    /// 额度查询开始：推进 requested_seq，返回本次序号
    pub fn begin_usage(&self, id: u64) -> anyhow::Result<i64> {
        self.write(|tx| {
            tx.execute(
                "UPDATE account_usage SET requested_seq = requested_seq + 1, sync_state = 'running',
                        attempted_at_ms = ?2
                 WHERE account_id = ?1",
                params![id as i64, now_ms()],
            )?;
            Ok(tx.query_row(
                "SELECT requested_seq FROM account_usage WHERE account_id = ?1",
                params![id as i64],
                |r| r.get(0),
            )?)
        })
    }

    /// 发布额度结果：只有序号仍是最新的一次才写入，逆序返回的旧结果被丢弃。
    /// 返回是否写入。上游身份与已有账号冲突时不写身份，由调用方提示人工确认。
    pub fn finish_usage(&self, id: u64, w: &UsageWrite<'_>) -> anyhow::Result<bool> {
        self.write(|tx| {
            let now = now_ms();
            let n = tx.execute(
                "UPDATE account_usage SET completed_seq = ?2, raw_json = ?3, used_amount = ?4,
                        limit_amount = ?5, reset_at_ms = ?6, observed_at_ms = ?7,
                        sync_state = 'ok', error_message = NULL
                 WHERE account_id = ?1 AND requested_seq = ?2",
                params![
                    id as i64,
                    w.seq,
                    w.raw_json,
                    w.used_amount,
                    w.limit_amount,
                    w.reset_at_ms,
                    now
                ],
            )?;
            if n == 0 {
                return Ok(false);
            }
            if let Some(title) = w.subscription_title {
                tx.execute(
                    "UPDATE accounts SET subscription_title = ?2, updated_at_ms = ?3
                     WHERE id = ?1 AND subscription_title IS NOT ?2",
                    params![id as i64, title, now],
                )?;
            }
            if let Some(identity) = w.upstream_identity.filter(|v| !v.is_empty()) {
                let taken: Option<i64> = tx
                    .query_row(
                        "SELECT id FROM accounts WHERE upstream_identity = ?1
                           AND deleted_at_ms IS NULL AND id <> ?2",
                        params![identity, id as i64],
                        |r| r.get(0),
                    )
                    .optional()?;
                match taken {
                    None => {
                        tx.execute(
                            "UPDATE accounts SET upstream_identity = ?2, updated_at_ms = ?3
                             WHERE id = ?1 AND upstream_identity IS NOT ?2",
                            params![id as i64, identity, now],
                        )?;
                    }
                    Some(other) => {
                        tracing::warn!(
                            "凭据 #{id} 与 #{other} 是同一个上游账号，未写入上游身份，请人工确认"
                        );
                        tx.execute(
                            "UPDATE accounts SET status = 'needs_review', last_error = ?2,
                                    updated_at_ms = ?3
                             WHERE id = ?1",
                            params![id as i64, format!("与凭据 #{other} 为同一上游账号"), now],
                        )?;
                    }
                }
            }
            Ok(true)
        })
    }

    /// 额度查询失败：同样按序号拦截，保留最后成功的快照
    pub fn fail_usage(&self, id: u64, seq: i64, message: &str) -> anyhow::Result<()> {
        self.write(|tx| {
            tx.execute(
                "UPDATE account_usage SET completed_seq = ?2, sync_state = 'error',
                        error_message = ?3
                 WHERE account_id = ?1 AND requested_seq = ?2",
                params![id as i64, seq, message],
            )?;
            Ok(())
        })
    }

    /// 按 refresh token / API key 查已有账号（导入去重）
    pub fn find_by_secret(
        &self,
        refresh_token: Option<&str>,
        api_key: Option<&str>,
    ) -> anyhow::Result<Option<u64>> {
        let conn = self.conn.lock();
        let id: Option<i64> = conn
            .query_row(
                "SELECT a.id FROM accounts a JOIN account_credentials c ON c.account_id = a.id
                 WHERE a.deleted_at_ms IS NULL
                   AND ((?1 IS NOT NULL AND c.refresh_token = ?1)
                        OR (?2 IS NOT NULL AND c.kiro_api_key = ?2))
                 LIMIT 1",
                params![refresh_token, api_key],
                |r| r.get(0),
            )
            .optional()?;
        Ok(id.map(|v| v as u64))
    }

    /// 账号 UUID 查数字 ID（含已删除行，调用方据此区分"已删除"）
    pub fn find_by_uuid(&self, account_uuid: &str) -> anyhow::Result<Option<(u64, bool)>> {
        let conn = self.conn.lock();
        let row: Option<(i64, Option<i64>)> = conn
            .query_row(
                "SELECT id, deleted_at_ms FROM accounts WHERE account_uuid = ?1",
                params![account_uuid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        Ok(row.map(|(id, deleted)| (id as u64, deleted.is_some())))
    }
}

/// 从旧 JSON（credentials.json + 同目录 kiro_stats.json）建新库：保留数字 ID 与记录身份，
/// 全部放入号池（旧版本里它们都在反代中）。目标库文件必须不存在。
///
/// 只读旧文件，不修改、不删除；返回导入的账号数。
pub fn migrate_from_json(
    db_path: &Path,
    credentials: Vec<KiroCredentials>,
    stats_path: Option<&Path>,
) -> anyhow::Result<usize> {
    let store = AccountStore::create_new(db_path)?;
    let stats: std::collections::HashMap<String, serde_json::Value> = stats_path
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default();
    let mut seen = std::collections::HashSet::new();
    let mut count = 0;
    for mut cred in credentials {
        cred.canonicalize_auth_method();
        if let Some(id) = cred.id {
            if !seen.insert(id) {
                bail!("credentials.json 中存在重复 ID: {id}");
            }
        }
        let meta = NewAccountMeta {
            in_pool: true,
            ..Default::default()
        };
        let (id, _) = store.insert_account(&cred, &meta)?;
        if cred.disabled {
            store.set_enabled_state(id, Some("Manual"), 0, 0)?;
        }
        if let Some(entry) = stats.get(&id.to_string()) {
            let get = |k: &str| entry.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
            let counters = StoredCounters {
                success_count: get("success_count"),
                input_tokens: get("input_tokens"),
                output_tokens: get("output_tokens"),
                last_used_at_ms: rfc3339_to_ms(entry.get("last_used_at").and_then(|v| v.as_str())),
            };
            store.save_counters(&[(id, counters)])?;
        }
        count += 1;
    }
    Ok(count)
}

#[cfg(test)]
pub(crate) fn test_store() -> (AccountStore, PathBuf) {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join(format!("account-store-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("accounts.sqlite3");
    (AccountStore::create_new(&path).unwrap(), path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn oauth(rt: &str) -> KiroCredentials {
        KiroCredentials {
            refresh_token: Some(rt.into()),
            access_token: Some("at".into()),
            expires_at: Some("2030-01-01T00:00:00+00:00".into()),
            auth_method: Some("social".into()),
            email: Some("a@example.com".into()),
            ..Default::default()
        }
    }

    #[test]
    fn open_existing_refuses_missing_file_and_does_not_create_it() {
        let path = std::env::temp_dir().join(format!("missing-{}.sqlite3", uuid::Uuid::new_v4()));
        assert!(AccountStore::open_existing(&path).is_err());
        assert!(!path.exists());
    }

    #[test]
    fn create_new_refuses_existing_file() {
        let (_store, path) = test_store();
        assert!(AccountStore::create_new(&path).is_err());
    }

    #[test]
    fn open_existing_rejects_unknown_schema_version() {
        let (store, path) = test_store();
        store
            .conn
            .lock()
            .execute_batch("PRAGMA user_version = 99;")
            .unwrap();
        drop(store);
        let err = AccountStore::open_existing(&path)
            .err()
            .unwrap()
            .to_string();
        assert!(err.contains("schema"), "{err}");
    }

    #[test]
    fn insert_then_load_roundtrip() {
        let (store, path) = test_store();
        let meta = NewAccountMeta {
            account_uuid: Some("proxy-1".into()),
            in_pool: true,
            ..Default::default()
        };
        let (id, identity) = store.insert_account(&oauth("rt-1"), &meta).unwrap();
        drop(store);
        let reopened = AccountStore::open_existing(&path).unwrap();
        let all = reopened.load_all().unwrap();
        assert_eq!(all.len(), 1);
        let a = &all[0];
        assert_eq!(a.credentials.id, Some(id));
        assert_eq!(
            a.credentials.credential_identity.as_deref(),
            Some(identity.as_str())
        );
        assert_eq!(a.credentials.refresh_token.as_deref(), Some("rt-1"));
        assert_eq!(
            rfc3339_to_ms(a.credentials.expires_at.as_deref()),
            rfc3339_to_ms(Some("2030-01-01T00:00:00+00:00"))
        );
        assert!(a.in_pool);
        assert_eq!(a.account_uuid, "proxy-1");
    }

    #[test]
    fn deleted_uuid_cannot_be_reinserted() {
        let (store, _) = test_store();
        let meta = NewAccountMeta {
            account_uuid: Some("proxy-1".into()),
            ..Default::default()
        };
        let (id, _) = store.insert_account(&oauth("rt-1"), &meta).unwrap();
        store.soft_delete(id).unwrap();
        assert!(store.load_all().unwrap().is_empty());
        assert!(store.insert_account(&oauth("rt-2"), &meta).is_err());
        assert_eq!(store.find_by_uuid("proxy-1").unwrap(), Some((id, true)));
    }

    #[test]
    fn rotated_credentials_require_matching_version_and_keep_old_refresh_token() {
        let (store, _) = test_store();
        let (id, _) = store
            .insert_account(&oauth("rt-1"), &NewAccountMeta::default())
            .unwrap();
        let base = store.begin_refresh(id).unwrap();
        let mut next = oauth("");
        next.refresh_token = None;
        next.access_token = Some("at-2".into());
        let v = store
            .save_rotated_credentials(id, Some(base), &next)
            .unwrap();
        assert_eq!(v, base + 1);
        // 旧版本的迟到结果被拒绝
        assert!(
            store
                .save_rotated_credentials(id, Some(base), &next)
                .is_err()
        );
        let a = &store.load_all().unwrap()[0];
        assert_eq!(a.credentials.refresh_token.as_deref(), Some("rt-1"));
        assert_eq!(a.credentials.access_token.as_deref(), Some("at-2"));
        assert!(!a.refresh_was_running);
    }

    #[test]
    fn stale_refresh_mark_is_reported_and_cleared() {
        let (store, _) = test_store();
        let (id, _) = store
            .insert_account(&oauth("rt-1"), &NewAccountMeta::default())
            .unwrap();
        store.begin_refresh(id).unwrap();
        assert!(store.load_all().unwrap()[0].refresh_was_running);
        assert_eq!(store.clear_stale_refresh_marks().unwrap(), vec![id]);
        assert!(!store.load_all().unwrap()[0].refresh_was_running);
    }

    #[test]
    fn disabled_reason_persists() {
        let (store, path) = test_store();
        let (id, _) = store
            .insert_account(&oauth("rt-1"), &NewAccountMeta::default())
            .unwrap();
        store
            .set_enabled_state(id, Some("TooManyFailures"), 3, 0)
            .unwrap();
        drop(store);
        let a = &AccountStore::open_existing(&path)
            .unwrap()
            .load_all()
            .unwrap()[0];
        assert!(a.credentials.disabled);
        assert_eq!(a.disabled_reason.as_deref(), Some("TooManyFailures"));
    }

    #[test]
    fn stale_usage_result_is_dropped() {
        let (store, _) = test_store();
        let (id, _) = store
            .insert_account(&oauth("rt-1"), &NewAccountMeta::default())
            .unwrap();
        let old = store.begin_usage(id).unwrap();
        let new = store.begin_usage(id).unwrap();
        let write = |seq, used| UsageWrite {
            seq,
            raw_json: "{}",
            used_amount: used,
            limit_amount: 100.0,
            reset_at_ms: None,
            subscription_title: Some("KIRO PRO"),
            upstream_identity: Some("user-1"),
        };
        assert!(store.finish_usage(id, &write(new, 5.0)).unwrap());
        assert!(!store.finish_usage(id, &write(old, 1.0)).unwrap());
        store.fail_usage(id, old, "late failure").unwrap();
        let a = &store.load_all().unwrap()[0];
        let (used, state): (f64, String) = store
            .conn
            .lock()
            .query_row(
                "SELECT used_amount, sync_state FROM account_usage WHERE account_id = ?1",
                [id as i64],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((used, state.as_str()), (5.0, "ok"));
        assert_eq!(
            a.credentials.subscription_title.as_deref(),
            Some("KIRO PRO")
        );
    }

    #[test]
    fn duplicate_upstream_identity_is_flagged_not_merged() {
        let (store, _) = test_store();
        let (a, _) = store
            .insert_account(&oauth("rt-a"), &NewAccountMeta::default())
            .unwrap();
        let (b, _) = store
            .insert_account(&oauth("rt-b"), &NewAccountMeta::default())
            .unwrap();
        for id in [a, b] {
            let seq = store.begin_usage(id).unwrap();
            store
                .finish_usage(
                    id,
                    &UsageWrite {
                        seq,
                        raw_json: "{}",
                        used_amount: 0.0,
                        limit_amount: 0.0,
                        reset_at_ms: None,
                        subscription_title: None,
                        upstream_identity: Some("same-user"),
                    },
                )
                .unwrap();
        }
        let status: String = store
            .conn
            .lock()
            .query_row(
                "SELECT status FROM accounts WHERE id = ?1",
                [b as i64],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(status, "needs_review");
    }

    #[test]
    fn writes_are_recorded_in_changes() {
        let (store, _) = test_store();
        let (id, _) = store
            .insert_account(&oauth("rt-1"), &NewAccountMeta::default())
            .unwrap();
        store.set_in_pool(id, true).unwrap();
        let kinds: Vec<String> = store
            .conn
            .lock()
            .prepare("SELECT DISTINCT kind FROM account_changes ORDER BY kind")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(kinds.contains(&"accounts".to_string()));
        assert!(kinds.contains(&"account_ui".to_string()));
    }

    #[test]
    fn migrate_from_json_keeps_ids_identity_disabled_and_stats() {
        let dir = std::env::temp_dir().join(format!("migrate-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let stats = dir.join("kiro_stats.json");
        std::fs::write(
            &stats,
            r#"{"7":{"success_count":3,"last_used_at":"2026-01-01T00:00:00+00:00","input_tokens":10,"output_tokens":20}}"#,
        )
        .unwrap();
        let mut a = oauth("rt-7");
        a.id = Some(7);
        a.credential_identity = Some("ident-7".into());
        let mut b = oauth("rt-9");
        b.id = Some(9);
        b.disabled = true;
        let db = dir.join("accounts.sqlite3");
        assert_eq!(migrate_from_json(&db, vec![a, b], Some(&stats)).unwrap(), 2);
        let all = AccountStore::open_existing(&db)
            .unwrap()
            .load_all()
            .unwrap();
        let seven = all.iter().find(|x| x.credentials.id == Some(7)).unwrap();
        assert_eq!(
            seven.credentials.credential_identity.as_deref(),
            Some("ident-7")
        );
        assert_eq!(seven.counters.success_count, 3);
        assert_eq!(seven.counters.output_tokens, 20);
        assert!(seven.in_pool);
        let nine = all.iter().find(|x| x.credentials.id == Some(9)).unwrap();
        assert_eq!(nine.disabled_reason.as_deref(), Some("Manual"));
        // 后续新增的 ID 接在最大值之后
        let store = AccountStore::open_existing(&db).unwrap();
        let (next, _) = store
            .insert_account(&oauth("rt-new"), &NewAccountMeta::default())
            .unwrap();
        assert_eq!(next, 10);
        // 目标库已存在时拒绝重复迁移
        assert!(migrate_from_json(&db, vec![], None).is_err());
    }
}
