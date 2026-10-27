//! Antigravity 账号库：独立 SQLite 文件，与 Kiro 共享账号库互不相干
//!
//! 连接参数沿用 `account_store` 的约定（WAL、FULL 同步、busy_timeout）。
//! 首次指定路径时建库；已存在的库必须是本模块认识的 schema 版本。

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, bail};
use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;

use crate::kiro::account_store::now_ms;

pub const SCHEMA_VERSION: i64 = 1;
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
        }
    }
}

pub struct AgStore {
    conn: Mutex<Connection>,
    path: PathBuf,
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
     project_id, tier, disabled, quota_json, quota_updated_ms, last_error, last_used_ms";

fn row_to_account(row: &Row<'_>) -> rusqlite::Result<AgAccount> {
    let quota: Option<String> = row.get(9)?;
    Ok(AgAccount {
        id: row.get(0)?,
        email: row.get(1)?,
        name: row.get(2)?,
        refresh_token: row.get(3)?,
        access_token: row.get(4)?,
        expires_at_ms: row.get(5)?,
        project_id: row.get(6)?,
        tier: row.get(7)?,
        disabled: row.get::<_, i64>(8)? != 0,
        quota: quota.and_then(|s| serde_json::from_str(&s).ok()),
        quota_updated_ms: row.get(10)?,
        last_error: row.get(11)?,
        last_used_ms: row.get(12)?,
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
        match version {
            0 if !existed || Self::is_empty(&conn)? => {
                let tx = conn.transaction()?;
                tx.execute_batch(MIGRATION_0001)?;
                tx.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))?;
                tx.commit()?;
            }
            SCHEMA_VERSION => {}
            other => bail!("{} 不是可识别的 Antigravity 账号库（user_version={other}）", path.display()),
        }
        Ok(Self {
            conn: Mutex::new(conn),
            path: path.to_path_buf(),
        })
    }

    fn is_empty(conn: &Connection) -> anyhow::Result<bool> {
        let n: i64 = conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get(0))?;
        Ok(n == 0)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn list(&self) -> anyhow::Result<Vec<AgAccount>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(&format!("SELECT {SELECT_COLUMNS} FROM accounts ORDER BY id"))?;
        let rows = stmt.query_map([], row_to_account)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn get(&self, id: i64) -> anyhow::Result<Option<AgAccount>> {
        let conn = self.conn.lock();
        Ok(conn
            .query_row(
                &format!("SELECT {SELECT_COLUMNS} FROM accounts WHERE id = ?1"),
                [id],
                row_to_account,
            )
            .optional()?)
    }

    /// 按邮箱新增或覆盖（重新登录同一账号时替换 token，保留 id 与禁用状态）
    pub fn upsert(&self, a: &NewAccount<'_>) -> anyhow::Result<i64> {
        let conn = self.conn.lock();
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
        self.conn.lock().execute(
            "UPDATE accounts SET access_token = ?2, expires_at_ms = ?3,
                 refresh_token = COALESCE(?4, refresh_token), last_error = NULL, updated_ms = ?5
             WHERE id = ?1",
            params![id, access_token, expires_at_ms, refresh_token, now_ms()],
        )?;
        Ok(())
    }

    pub fn update_project(&self, id: i64, project_id: Option<&str>, tier: Option<&str>) -> anyhow::Result<()> {
        self.conn.lock().execute(
            "UPDATE accounts SET project_id = COALESCE(?2, project_id), tier = COALESCE(?3, tier),
                 updated_ms = ?4 WHERE id = ?1",
            params![id, project_id, tier, now_ms()],
        )?;
        Ok(())
    }

    pub fn update_quota(&self, id: i64, quota: &serde_json::Value) -> anyhow::Result<()> {
        let now = now_ms();
        self.conn.lock().execute(
            "UPDATE accounts SET quota_json = ?2, quota_updated_ms = ?3, updated_ms = ?3 WHERE id = ?1",
            params![id, quota.to_string(), now],
        )?;
        Ok(())
    }

    pub fn set_error(&self, id: i64, error: Option<&str>) -> anyhow::Result<()> {
        self.conn.lock().execute(
            "UPDATE accounts SET last_error = ?2, updated_ms = ?3 WHERE id = ?1",
            params![id, error, now_ms()],
        )?;
        Ok(())
    }

    pub fn set_disabled(&self, id: i64, disabled: bool) -> anyhow::Result<bool> {
        let n = self.conn.lock().execute(
            "UPDATE accounts SET disabled = ?2, updated_ms = ?3 WHERE id = ?1",
            params![id, disabled as i64, now_ms()],
        )?;
        Ok(n > 0)
    }

    pub fn touch_used(&self, id: i64) -> anyhow::Result<()> {
        self.conn.lock().execute(
            "UPDATE accounts SET last_used_ms = ?2 WHERE id = ?1",
            params![id, now_ms()],
        )?;
        Ok(())
    }

    pub fn delete(&self, id: i64) -> anyhow::Result<bool> {
        let n = self
            .conn
            .lock()
            .execute("DELETE FROM accounts WHERE id = ?1", [id])?;
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
}
