//! Antigravity 账号库：独立 SQLite 文件，与 Kiro 共享账号库互不相干
//!
//! 连接参数沿用 `account_store` 的约定（WAL、FULL 同步、busy_timeout）。
//! 首次指定路径时建库；已存在的库必须是本模块认识的 schema 版本。
//!
//! 请求路径不碰 SQLite：账号快照与模型分组缓存在内存里，任何写操作都在持有连接锁时让缓存失效；
//! 成功/失败计数先在内存累加，由 [`AgStore::flush_counts`] 批量落盘，读接口会叠加未落盘的增量。
//! 锁顺序固定为 `pending_counts` → `conn` → `cache`，避免死锁，也保证读计数时不会看到落盘中途的倒退。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, bail};
use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;

use crate::kiro::account_store::now_ms;

pub const SCHEMA_VERSION: i64 = 3;
const ENABLED_MODEL_IDS_KEY: &str = "enabled_model_ids";
const MODEL_ACCOUNTS_KEY: &str = "model_accounts";
const BUSY_TIMEOUT: Duration = Duration::from_millis(5000);

const MIGRATION_0001: &str = "
CREATE TABLE accounts (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    email            TEXT NOT NULL UNIQUE,
    name             TEXT,
    refresh_token    TEXT NOT NULL,
    access_token     TEXT,
    expires_at_ms    INTEGER,
    project_id       TEXT,
    tier             TEXT,
    disabled         INTEGER NOT NULL DEFAULT 0,
    quota_json       TEXT,
    quota_updated_ms INTEGER,
    last_error       TEXT,
    last_used_ms     INTEGER,
    created_ms       INTEGER NOT NULL,
    updated_ms       INTEGER NOT NULL
);
";

/// v2：请求成功 / 失败与 token 刷新失败的累计次数
const MIGRATION_0002: &str = "
ALTER TABLE accounts ADD COLUMN success_count         INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN failure_count         INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN refresh_failure_count INTEGER NOT NULL DEFAULT 0;
";

/// v3：模型目录选择，缺少设置与明确的空列表分别表示全选和全不选
const MIGRATION_0003: &str = "
CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
";

/// 累计计数的种类，对应 accounts 表里的一列
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgCounter {
    Success,
    Failure,
    RefreshFailure,
}

/// 未落盘的计数增量
#[derive(Debug, Default, Clone, Copy)]
struct PendingCounts {
    success: i64,
    failure: i64,
    refresh_failure: i64,
}

impl PendingCounts {
    fn add(&mut self, counter: AgCounter, n: i64) {
        match counter {
            AgCounter::Success => self.success += n,
            AgCounter::Failure => self.failure += n,
            AgCounter::RefreshFailure => self.refresh_failure += n,
        }
    }

    fn merge(&mut self, other: PendingCounts) {
        self.success += other.success;
        self.failure += other.failure;
        self.refresh_failure += other.refresh_failure;
    }

    fn apply(&self, account: &mut AgAccount) {
        account.success_count += self.success;
        account.failure_count += self.failure;
        account.refresh_failure_count += self.refresh_failure;
    }
}

/// 模型分组：模型 id → 支持它的账号 id
pub type ModelAccounts = HashMap<String, Vec<i64>>;

/// 账号表与模型分组的内存副本；None 表示失效，下次读取时重建
#[derive(Default)]
struct Cache {
    accounts: Option<Arc<[Arc<AgAccount>]>>,
    model_accounts: Option<Option<Arc<ModelAccounts>>>,
}

/// 库里的一个 Google 账号
#[derive(Debug, Clone)]
pub struct AgAccount {
    pub id: i64,
    pub email: String,
    pub name: Option<String>,
    pub refresh_token: String,
    pub access_token: Option<String>,
    pub expires_at_ms: Option<i64>,
    pub project_id: Option<String>,
    pub tier: Option<String>,
    pub disabled: bool,
    pub quota: Option<serde_json::Value>,
    pub quota_updated_ms: Option<i64>,
    pub last_error: Option<String>,
    pub last_used_ms: Option<i64>,
    pub success_count: i64,
    pub failure_count: i64,
    pub refresh_failure_count: i64,
}

/// 新登录或重新登录得到的账号资料
pub struct NewAccount<'a> {
    pub email: &'a str,
    pub name: Option<&'a str>,
    pub refresh_token: &'a str,
    pub access_token: &'a str,
    pub expires_at_ms: i64,
    pub project_id: Option<&'a str>,
    pub tier: Option<&'a str>,
}

/// 对外展示的账号摘要（不含 token）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgAccountView {
    pub id: i64,
    pub email: String,
    pub name: Option<String>,
    pub project_id: Option<String>,
    pub tier: Option<String>,
    pub disabled: bool,
    pub expires_at_ms: Option<i64>,
    pub quota: Option<serde_json::Value>,
    pub quota_updated_ms: Option<i64>,
    pub last_error: Option<String>,
    pub last_used_ms: Option<i64>,
    pub success_count: i64,
    pub failure_count: i64,
    pub refresh_failure_count: i64,
}

impl From<&AgAccount> for AgAccountView {
    fn from(a: &AgAccount) -> Self {
        Self {
            id: a.id,
            email: a.email.clone(),
            name: a.name.clone(),
            project_id: a.project_id.clone(),
            tier: a.tier.clone(),
            disabled: a.disabled,
            expires_at_ms: a.expires_at_ms,
            quota: a.quota.clone(),
            quota_updated_ms: a.quota_updated_ms,
            last_error: a.last_error.clone(),
            last_used_ms: a.last_used_ms,
            success_count: a.success_count,
            failure_count: a.failure_count,
            refresh_failure_count: a.refresh_failure_count,
        }
    }
}

pub struct AgStore {
    conn: Mutex<Connection>,
    path: PathBuf,
    cache: Mutex<Cache>,
    pending_counts: Mutex<HashMap<i64, PendingCounts>>,
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
         PRAGMA checkpoint_fullfsync=ON;",
    )?;
    Ok(())
}

const SELECT_COLUMNS: &str = "id, email, name, refresh_token, access_token, expires_at_ms, \
     project_id, tier, disabled, quota_json, quota_updated_ms, last_error, last_used_ms, \
     success_count, failure_count, refresh_failure_count";

fn row_to_account(row: &Row<'_>) -> rusqlite::Result<AgAccount> {
    let id: i64 = row.get(0)?;
    let quota: Option<String> = row.get(9)?;
    let quota = quota.and_then(|s| {
        serde_json::from_str(&s)
            .inspect_err(|e| tracing::warn!("Antigravity 账号 #{id} 的额度 JSON 解析失败，按无额度处理: {e}"))
            .ok()
    });
    Ok(AgAccount {
        id,
        email: row.get(1)?,
        name: row.get(2)?,
        refresh_token: row.get(3)?,
        access_token: row.get(4)?,
        expires_at_ms: row.get(5)?,
        project_id: row.get(6)?,
        tier: row.get(7)?,
        disabled: row.get::<_, i64>(8)? != 0,
        quota,
        quota_updated_ms: row.get(10)?,
        last_error: row.get(11)?,
        last_used_ms: row.get(12)?,
        success_count: row.get(13)?,
        failure_count: row.get(14)?,
        refresh_failure_count: row.get(15)?,
    })
}

impl AgStore {
    /// 打开账号库；文件不存在时新建并初始化 schema
    pub fn open_or_create(path: &Path) -> anyhow::Result<Self> {
        let existed = path.exists();
        let mut conn =
            Connection::open(path).with_context(|| format!("打开 {}", path.display()))?;
        configure(&conn)?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        // 按版本逐级迁移，每级一个事务
        let migrations: [(i64, &str); 3] = [(0, MIGRATION_0001), (1, MIGRATION_0002), (2, MIGRATION_0003)];
        let fresh = version == 0 && (!existed || Self::is_empty(&conn)?);
        if version == 0 && !fresh {
            bail!("{} 不是可识别的 Antigravity 账号库（user_version=0 且非空）", path.display());
        }
        if version > SCHEMA_VERSION {
            bail!("{} 不是可识别的 Antigravity 账号库（user_version={version}）", path.display());
        }
        for (from, sql) in migrations.iter().filter(|(from, _)| *from >= version) {
            let tx = conn.transaction()?;
            tx.execute_batch(sql)?;
            tx.execute_batch(&format!("PRAGMA user_version = {};", from + 1))?;
            tx.commit()?;
        }
        Ok(Self {
            conn: Mutex::new(conn),
            path: path.to_path_buf(),
            cache: Mutex::new(Cache::default()),
            pending_counts: Mutex::new(HashMap::new()),
        })
    }

    /// 执行一次写操作，并在释放连接锁前让内存缓存失效（失败也失效，宁可多读一次库）
    fn write<T>(&self, f: impl FnOnce(&mut Connection) -> anyhow::Result<T>) -> anyhow::Result<T> {
        let mut conn = self.conn.lock();
        let result = f(&mut conn);
        *self.cache.lock() = Cache::default();
        result
    }

    /// 账号表的内存快照（计数不含未落盘增量）；只在缓存失效后读一次库
    pub fn snapshot(&self) -> anyhow::Result<Arc<[Arc<AgAccount>]>> {
        if let Some(accounts) = &self.cache.lock().accounts {
            return Ok(accounts.clone());
        }
        let conn = self.conn.lock();
        // 等连接锁期间可能已被别的线程重建
        if let Some(accounts) = &self.cache.lock().accounts {
            return Ok(accounts.clone());
        }
        let mut stmt = conn.prepare_cached(&format!("SELECT {SELECT_COLUMNS} FROM accounts ORDER BY id"))?;
        let accounts: Arc<[Arc<AgAccount>]> = stmt
            .query_map([], row_to_account)?
            .map(|r| r.map(Arc::new))
            .collect::<rusqlite::Result<_>>()?;
        self.cache.lock().accounts = Some(accounts.clone());
        Ok(accounts)
    }

    fn is_empty(conn: &Connection) -> anyhow::Result<bool> {
        let n: i64 = conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get(0))?;
        Ok(n == 0)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 未设置时为 None；Some([]) 表示明确不输出任何模型。
    pub fn enabled_model_ids(&self) -> anyhow::Result<Option<Vec<String>>> {
        let value: Option<String> = self.conn.lock().query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [ENABLED_MODEL_IDS_KEY],
            |row| row.get(0),
        ).optional()?;
        value.map(|json| serde_json::from_str(&json).context("读取模型目录选择")).transpose()
    }

    pub fn set_enabled_model_ids(&self, ids: &[String]) -> anyhow::Result<()> {
        self.write(|conn| {
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![ENABLED_MODEL_IDS_KEY, serde_json::to_string(ids)?],
            )?;
            Ok(())
        })
    }

    /// 模型分组：模型 id → 支持它的账号 id。未保存过为 None。走内存缓存，保存勾选后失效。
    pub fn model_accounts(&self) -> anyhow::Result<Option<Arc<ModelAccounts>>> {
        if let Some(groups) = &self.cache.lock().model_accounts {
            return Ok(groups.clone());
        }
        let conn = self.conn.lock();
        if let Some(groups) = &self.cache.lock().model_accounts {
            return Ok(groups.clone());
        }
        let value: Option<String> = conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [MODEL_ACCOUNTS_KEY],
            |row| row.get(0),
        ).optional()?;
        let groups = value
            .map(|json| serde_json::from_str::<ModelAccounts>(&json).context("读取模型分组"))
            .transpose()?
            .map(Arc::new);
        self.cache.lock().model_accounts = Some(groups.clone());
        Ok(groups)
    }

    /// 同一事务里保存勾选与分组，避免两者不一致
    pub fn save_model_selection(&self, ids: &[String], groups: &ModelAccounts) -> anyhow::Result<()> {
        self.write(|conn| {
            let tx = conn.transaction()?;
            for (key, value) in [(ENABLED_MODEL_IDS_KEY, serde_json::to_string(ids)?), (MODEL_ACCOUNTS_KEY, serde_json::to_string(groups)?)] {
                tx.execute(
                    "INSERT INTO settings (key, value) VALUES (?1, ?2) \
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    params![key, value],
                )?;
            }
            tx.commit()?;
            Ok(())
        })
    }

    /// 全部账号，计数含未落盘增量（管理接口用）
    pub fn list(&self) -> anyhow::Result<Vec<AgAccount>> {
        // 持有 pending 锁读快照：落盘也要先拿这把锁，读到的库值与增量不会错位
        let pending = self.pending_counts.lock();
        let accounts = self.snapshot()?;
        Ok(accounts
            .iter()
            .map(|a| {
                let mut account = AgAccount::clone(a);
                if let Some(p) = pending.get(&a.id) {
                    p.apply(&mut account);
                }
                account
            })
            .collect())
    }

    /// 单个账号，读库拿最新值，计数含未落盘增量
    pub fn get(&self, id: i64) -> anyhow::Result<Option<AgAccount>> {
        let pending = self.pending_counts.lock();
        let conn = self.conn.lock();
        let mut account = conn
            .query_row(
                &format!("SELECT {SELECT_COLUMNS} FROM accounts WHERE id = ?1"),
                [id],
                row_to_account,
            )
            .optional()?;
        if let (Some(a), Some(p)) = (account.as_mut(), pending.get(&id)) {
            p.apply(a);
        }
        Ok(account)
    }

    /// 按邮箱新增或覆盖（重新登录同一账号时替换 token，保留 id 与禁用状态）
    pub fn upsert(&self, a: &NewAccount<'_>) -> anyhow::Result<i64> {
        self.write(|conn| Self::upsert_with(conn, a))
    }

    fn upsert_with(conn: &Connection, a: &NewAccount<'_>) -> anyhow::Result<i64> {
        let now = now_ms();
        let id = conn.query_row(
            "INSERT INTO accounts (email, name, refresh_token, access_token, expires_at_ms,
                                   project_id, tier, created_ms, updated_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
             ON CONFLICT(email) DO UPDATE SET
                 name = excluded.name,
                 refresh_token = excluded.refresh_token,
                 access_token = excluded.access_token,
                 expires_at_ms = excluded.expires_at_ms,
                 project_id = COALESCE(excluded.project_id, accounts.project_id),
                 tier = COALESCE(excluded.tier, accounts.tier),
                 last_error = NULL,
                 updated_ms = excluded.updated_ms
             RETURNING id",
            params![
                a.email,
                a.name,
                a.refresh_token,
                a.access_token,
                a.expires_at_ms,
                a.project_id,
                a.tier,
                now
            ],
            |r| r.get(0),
        )?;
        Ok(id)
    }

    /// 刷新 token 后回写；Google 一般不轮换 refresh token，返回了新的才覆盖
    pub fn update_tokens(
        &self,
        id: i64,
        access_token: &str,
        expires_at_ms: i64,
        refresh_token: Option<&str>,
    ) -> anyhow::Result<()> {
        self.write(|conn| {
            conn.execute(
            "UPDATE accounts SET access_token = ?2, expires_at_ms = ?3,
                 refresh_token = COALESCE(?4, refresh_token), last_error = NULL, updated_ms = ?5
             WHERE id = ?1",
            params![id, access_token, expires_at_ms, refresh_token, now_ms()],
        )?;
            Ok(())
        })
    }

    pub fn update_project(&self, id: i64, project_id: Option<&str>, tier: Option<&str>) -> anyhow::Result<()> {
        self.write(|conn| {
            conn.execute(
            "UPDATE accounts SET project_id = COALESCE(?2, project_id), tier = COALESCE(?3, tier),
                 updated_ms = ?4 WHERE id = ?1",
            params![id, project_id, tier, now_ms()],
        )?;
            Ok(())
        })
    }

    pub fn update_quota(&self, id: i64, quota: &serde_json::Value) -> anyhow::Result<()> {
        let now = now_ms();
        self.write(|conn| {
            conn.execute(
            "UPDATE accounts SET quota_json = ?2, quota_updated_ms = ?3, updated_ms = ?3 WHERE id = ?1",
            params![id, quota.to_string(), now],
        )?;
            Ok(())
        })
    }

    pub fn set_error(&self, id: i64, error: Option<&str>) -> anyhow::Result<()> {
        self.write(|conn| {
            conn.execute(
            "UPDATE accounts SET last_error = ?2, updated_ms = ?3 WHERE id = ?1",
            params![id, error, now_ms()],
        )?;
            Ok(())
        })
    }

    pub fn set_disabled(&self, id: i64, disabled: bool) -> anyhow::Result<bool> {
        self.write(|conn| {
            let n = conn.execute(
                "UPDATE accounts SET disabled = ?2, updated_ms = ?3 WHERE id = ?1",
                params![id, disabled as i64, now_ms()],
            )?;
            Ok(n > 0)
        })
    }

    pub fn touch_used(&self, id: i64) -> anyhow::Result<()> {
        self.write(|conn| {
            conn.execute(
            "UPDATE accounts SET last_used_ms = ?2 WHERE id = ?1",
            params![id, now_ms()],
        )?;
            Ok(())
        })
    }

    /// 某项计数 +1：只在内存累加，由 [`Self::flush_counts`] 批量落盘
    pub fn increment(&self, id: i64, counter: AgCounter) {
        self.pending_counts.lock().entry(id).or_default().add(counter, 1);
    }

    /// 把内存里的计数增量一个事务写进库；失败时增量放回，下次再试。返回落盘的账号数
    pub fn flush_counts(&self) -> anyhow::Result<usize> {
        let mut pending = self.pending_counts.lock();
        if pending.is_empty() {
            return Ok(0);
        }
        let batch = std::mem::take(&mut *pending);
        let result = self.write(|conn| {
            let tx = conn.transaction()?;
            {
                let mut stmt = tx.prepare_cached(
                    "UPDATE accounts SET success_count = success_count + ?2,
                         failure_count = failure_count + ?3,
                         refresh_failure_count = refresh_failure_count + ?4
                     WHERE id = ?1",
                )?;
                for (id, c) in &batch {
                    stmt.execute(params![id, c.success, c.failure, c.refresh_failure])?;
                }
            }
            tx.commit()?;
            Ok(batch.len())
        });
        if result.is_err() {
            for (id, c) in batch {
                pending.entry(id).or_default().merge(c);
            }
        }
        result
    }

    /// 失败与刷新失败清零，成功次数保留
    pub fn reset_failures(&self, id: i64) -> anyhow::Result<bool> {
        let mut pending = self.pending_counts.lock();
        let n = self.write(|conn| {
            Ok(conn.execute(
                "UPDATE accounts SET failure_count = 0, refresh_failure_count = 0, updated_ms = ?2 WHERE id = ?1",
                params![id, now_ms()],
            )?)
        })?;
        if let Some(p) = pending.get_mut(&id) {
            p.failure = 0;
            p.refresh_failure = 0;
        }
        Ok(n > 0)
    }

    pub fn delete(&self, id: i64) -> anyhow::Result<bool> {
        let mut pending = self.pending_counts.lock();
        let n = self.write(|conn| Ok(conn.execute("DELETE FROM accounts WHERE id = ?1", [id])?))?;
        pending.remove(&id);
        Ok(n > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> (PathBuf, AgStore) {
        let path = std::env::temp_dir().join(format!("ag-store-{}.sqlite3", uuid::Uuid::new_v4()));
        let store = AgStore::open_or_create(&path).unwrap();
        (path, store)
    }

    fn sample<'a>(email: &'a str, refresh: &'a str) -> NewAccount<'a> {
        NewAccount {
            email,
            name: Some("n"),
            refresh_token: refresh,
            access_token: "at",
            expires_at_ms: 1,
            project_id: Some("p-1"),
            tier: None,
        }
    }

    #[test]
    fn migrates_v2_and_persists_model_selection_without_touching_accounts() {
        let dir = std::env::temp_dir().join(format!("ag-settings-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("test.sqlite3");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(MIGRATION_0001).unwrap();
            conn.execute_batch(MIGRATION_0002).unwrap();
            conn.execute_batch("PRAGMA user_version = 2;").unwrap();
        }
        let store = AgStore::open_or_create(&path).unwrap();
        let id = store.upsert(&sample("settings@x", "test-token")).unwrap();
        assert_eq!(store.enabled_model_ids().unwrap(), None);
        store.set_enabled_model_ids(&[]).unwrap();
        drop(store);
        let store = AgStore::open_or_create(&path).unwrap();
        assert_eq!(store.enabled_model_ids().unwrap(), Some(vec![]));
        let selected = vec!["selected-model".to_string()];
        store.set_enabled_model_ids(&selected).unwrap();
        drop(store);
        let store = AgStore::open_or_create(&path).unwrap();
        assert_eq!(store.enabled_model_ids().unwrap(), Some(selected));
        assert_eq!(store.get(id).unwrap().unwrap().refresh_token, "test-token");
        let version: i64 = store.conn.lock().query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        drop(store);
        let trash = PathBuf::from(std::env::var_os("HOME").unwrap()).join(".Trash");
        std::fs::create_dir_all(&trash).unwrap();
        std::fs::rename(&dir, trash.join(dir.file_name().unwrap())).unwrap();
    }

    #[test]
    fn upsert_same_email_keeps_id_and_replaces_tokens() {
        let (_path, store) = temp_db();
        let id1 = store.upsert(&sample("a@x.com", "r1")).unwrap();
        store.set_disabled(id1, true).unwrap();
        let id2 = store
            .upsert(&NewAccount { project_id: None, ..sample("a@x.com", "r2") })
            .unwrap();
        assert_eq!(id1, id2);
        let a = store.get(id1).unwrap().unwrap();
        assert_eq!(a.refresh_token, "r2");
        assert_eq!(a.project_id.as_deref(), Some("p-1"));
        assert!(a.disabled);
    }

    #[test]
    fn reopen_existing_db_and_reject_foreign_schema() {
        let (path, store) = temp_db();
        store.upsert(&sample("b@x.com", "r")).unwrap();
        drop(store);
        assert_eq!(AgStore::open_or_create(&path).unwrap().list().unwrap().len(), 1);

        let foreign = std::env::temp_dir().join(format!("ag-foreign-{}.sqlite3", uuid::Uuid::new_v4()));
        Connection::open(&foreign)
            .unwrap()
            .execute_batch("CREATE TABLE t(x); PRAGMA user_version = 7;")
            .unwrap();
        assert!(AgStore::open_or_create(&foreign).is_err());
    }

    #[test]
    fn migrates_v1_db_and_counts() {
        let path = std::env::temp_dir().join(format!("ag-v1-{}.sqlite3", uuid::Uuid::new_v4()));
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(MIGRATION_0001).unwrap();
            conn.execute_batch("PRAGMA user_version = 1;").unwrap();
            conn.execute(
                "INSERT INTO accounts (email, refresh_token, created_ms, updated_ms) VALUES ('v1@x.com', 'r', 1, 1)",
                [],
            )
            .unwrap();
        }
        let store = AgStore::open_or_create(&path).unwrap();
        let version: i64 = store.conn.lock().query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let id = store.list().unwrap()[0].id;
        assert_eq!(store.get(id).unwrap().unwrap().success_count, 0);

        store.increment(id, AgCounter::Success);
        store.increment(id, AgCounter::Success);
        store.increment(id, AgCounter::Failure);
        store.increment(id, AgCounter::RefreshFailure);
        let a = store.get(id).unwrap().unwrap();
        assert_eq!((a.success_count, a.failure_count, a.refresh_failure_count), (2, 1, 1));

        assert!(store.reset_failures(id).unwrap());
        let a = store.get(id).unwrap().unwrap();
        assert_eq!((a.success_count, a.failure_count, a.refresh_failure_count), (2, 0, 0));
    }

    #[test]
    fn counts_stay_in_memory_until_flush_and_never_go_backwards() {
        let (path, store) = temp_db();
        let id = store.upsert(&sample("c@x.com", "r")).unwrap();
        store.increment(id, AgCounter::Success);
        store.increment(id, AgCounter::Failure);
        // 未落盘：库里还是 0，读接口已经叠加增量
        let raw = store.snapshot().unwrap()[0].success_count;
        assert_eq!(raw, 0);
        assert_eq!(store.list().unwrap()[0].success_count, 1);
        assert_eq!(store.get(id).unwrap().unwrap().failure_count, 1);

        assert_eq!(store.flush_counts().unwrap(), 1);
        assert_eq!(store.flush_counts().unwrap(), 0);
        store.increment(id, AgCounter::Success);
        let a = store.list().unwrap().remove(0);
        assert_eq!((a.success_count, a.failure_count), (2, 1));

        // 清零失败计数也清掉未落盘的失败增量，成功增量保留
        store.increment(id, AgCounter::Failure);
        assert!(store.reset_failures(id).unwrap());
        store.flush_counts().unwrap();
        drop(store);
        let a = AgStore::open_or_create(&path).unwrap().get(id).unwrap().unwrap();
        assert_eq!((a.success_count, a.failure_count), (2, 0));
    }

    #[test]
    fn writes_invalidate_snapshot_and_model_groups() {
        let (_path, store) = temp_db();
        assert!(store.snapshot().unwrap().is_empty());
        assert!(store.model_accounts().unwrap().is_none());
        let id = store.upsert(&sample("d@x.com", "r")).unwrap();
        assert_eq!(store.snapshot().unwrap().len(), 1);
        store.set_disabled(id, true).unwrap();
        assert!(store.snapshot().unwrap()[0].disabled);
        store
            .save_model_selection(&["m".to_string()], &HashMap::from([("m".to_string(), vec![id])]))
            .unwrap();
        assert_eq!(store.model_accounts().unwrap().unwrap().get("m"), Some(&vec![id]));
        store.delete(id).unwrap();
        assert!(store.snapshot().unwrap().is_empty());
    }
}
